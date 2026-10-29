const MEDIA_STALE_MS = 5_000;
const BLOCKED_MS = 3_000;
const QUEUE_DELAY_MS = 1_000;
const RECOVERY_TIMEOUT_MS = 30_000;
const COOLDOWN_MS = 30_000;
const STARTUP_GRACE_MS = 20_000;
const FAILURE_PERSISTENCE_MS = 3_000;
const MAX_AUTOMATIC_RETRY_MS = 300_000;

export function createVideoRecovery({
  getChannelState,
  trimQueue,
  restartPublisher,
  requestMedia,
  onChange,
  now = Date.now,
  schedule = (callback) => {
    const timer = setTimeout(callback, 500);
    timer.unref();
  },
}) {
  const sessions = new Map();
  const monitors = new Map();

  function notify(key) {
    onChange(key, getStatus(key));
  }

  function getStatus(key) {
    const session = sessions.get(key);
    if (!session) {
      return null;
    }
    return {
      status: session.status,
      source: session.source,
      startedAtMs: session.startedAtMs,
      cooldownUntilMs: session.startedAtMs + COOLDOWN_MS,
      channels: session.channels.map((channel) => ({ ...channel })),
    };
  }

  function isFresh(state, timestamp) {
    return state.lastVideoReceivedAtMs !== null &&
      timestamp - state.lastVideoReceivedAtMs < MEDIA_STALE_MS;
  }

  function queueDelayed(state) {
    return Math.max(state.videoQueueAgeMs, state.audioQueueAgeMs) >= QUEUE_DELAY_MS;
  }

  function publisherBlocked(state) {
    return Math.max(state.videoBlockedMs, state.audioBlockedMs) >= BLOCKED_MS;
  }

  function strictSyncHolding(state) {
    return ["strict-arrival", "bounded-sync"].includes(
      state.syncStatus?.mode,
    ) &&
      state.syncStatus.state === "holding";
  }

  function startingWithinGrace(state, timestamp) {
    const publisherAgeMs = timestamp - state.publisherStartedAtMs;
    return Number.isFinite(state.publisherStartedAtMs) &&
      publisherAgeMs >= 0 &&
      publisherAgeMs < STARTUP_GRACE_MS &&
      (state.status === "starting" ||
        (state.status === "publishing" &&
          state.outputProgress?.lastVideoAdvanceAtMs == null));
  }

  function outputStalled(state, timestamp) {
    return state.status === "publishing" && (
      state.outputProgress?.lastVideoAdvanceAtMs == null ||
      timestamp - state.outputProgress.lastVideoAdvanceAtMs >= BLOCKED_MS
    );
  }

  function failureReason(state, timestamp) {
    if (!isFresh(state, timestamp)) {
      return "Sem quadros de vídeo por pelo menos 5 segundos";
    }
    if (startingWithinGrace(state, timestamp)) {
      return null;
    }
    if (publisherBlocked(state)) {
      return "Escrita no FFmpeg bloqueada por pelo menos 3 segundos";
    }
    if (queueDelayed(state)) {
      return "Fila de escrita com pelo menos 1 segundo de atraso";
    }
    if (
      strictSyncHolding(state) &&
      !["error", "stopped", "not-started"].includes(state.status)
    ) {
      return null;
    }
    if (outputStalled(state, timestamp)) {
      return "Saida real de video do FFmpeg sem avanco";
    }
    if (["error", "stopped", "not-started", "waiting"].includes(state.status) ||
      (state.status === "starting" &&
        timestamp - state.publisherStartedAtMs >= STARTUP_GRACE_MS)) {
      return "Publicador indisponível ou demorando para iniciar";
    }
    return null;
  }

  async function monitor(key, channelNos) {
    let observation = monitors.get(key);
    if (!observation) {
      observation = { channels: new Map(), failures: 0, nextAttemptAtMs: 0 };
      monitors.set(key, observation);
    }
    const timestamp = now();
    const affected = [];
    const reasons = new Map();
    for (const channelNo of channelNos) {
      const state = getChannelState(key, channelNo);
      if (!state.enabled || !state.connected) {
        observation.channels.delete(channelNo);
        continue;
      }
      let channel = observation.channels.get(channelNo);
      if (!channel) {
        channel = { observedAtMs: timestamp, problemSinceMs: null, publisherStartedAtMs: state.publisherStartedAtMs };
        observation.channels.set(channelNo, channel);
      }
      if (channel.publisherStartedAtMs !== state.publisherStartedAtMs) {
        channel.publisherStartedAtMs = state.publisherStartedAtMs;
        channel.observedAtMs = timestamp;
        channel.problemSinceMs = null;
      }
      // Leave camera command acknowledgements and their existing retry timers alone.
      if (state.commandPending || state.cameraRetryPending ||
        timestamp - channel.observedAtMs < STARTUP_GRACE_MS) {
        channel.problemSinceMs = null;
        continue;
      }
      const reason = failureReason(state, timestamp);
      if (reason === null) {
        channel.problemSinceMs = null;
        continue;
      }
      channel.problemSinceMs ??= timestamp;
      if (timestamp - channel.problemSinceMs >= FAILURE_PERSISTENCE_MS) {
        affected.push(channelNo);
        reasons.set(channelNo, reason);
      }
    }
    const previous = sessions.get(key);
    if (affected.length === 0 || previous?.status === "recovering" ||
      timestamp < observation.nextAttemptAtMs ||
      (previous && timestamp < previous.startedAtMs + COOLDOWN_MS)) {
      return null;
    }
    return start(key, affected, { source: "automatic", reasons });
  }

  async function act(key, channel, state, timestamp) {
    channel.healthySinceMs = null;
    channel.actionAtMs = timestamp;
    if (state.commandPending || state.cameraRetryPending) {
      channel.action = "waiting-command";
      channel.message = "Aguardando o comando ou a tentativa de retomada ja em andamento";
      return;
    }
    if (!isFresh(state, timestamp)) {
      channel.action = "request-media";
      channel.message = "Solicitando novamente mídia à câmera, sem mudar qualidade ou áudio";
      channel.cameraRequested = true;
      await requestMedia(key, channel.channelNo);
    } else if (
      state.status === "error" ||
      state.status === "stopped" ||
      state.status === "not-started" ||
      (publisherBlocked(state) && !startingWithinGrace(state, timestamp)) ||
      (outputStalled(state, timestamp) && !strictSyncHolding(state) &&
        !startingWithinGrace(state, timestamp)) ||
      (state.status === "starting" &&
        timestamp - state.publisherStartedAtMs >= STARTUP_GRACE_MS &&
        !strictSyncHolding(state))
    ) {
      restart(key, channel, timestamp);
    } else if (queueDelayed(state) && !startingWithinGrace(state, timestamp)) {
      const droppedFrames = trimQueue(key, channel.channelNo);
      channel.action = "trim-queue";
      channel.message = droppedFrames > 0
        ? `Descartados ${droppedFrames} quadros antigos até um quadro-chave`
        : "Aguardando quadro-chave para aliviar a fila de vídeo";
    } else if (strictSyncHolding(state)) {
      channel.action = "waiting-sync";
      channel.message =
        "Aguardando alinhamento estrito; publicador RTSP preservado";
    } else {
      channel.action = "check";
      channel.message = "Verificando chegada de mídia e avanço da publicação RTSP";
    }
  }

  function restart(key, channel, timestamp) {
    channel.action = "restart-publisher";
    channel.actionAtMs = timestamp;
    channel.publisherRestarted = true;
    channel.message = "Reiniciando apenas o publicador local; aguardando mídia e quadro-chave";
    restartPublisher(key, channel.channelNo);
  }

  function fail(channel, error) {
    channel.status = "failed";
    channel.message = error instanceof Error ? error.message : String(error);
  }

  async function start(key, channelNos, { source = "manual", reasons = new Map() } = {}) {
    const previous = sessions.get(key);
    const timestamp = now();
    if (previous?.status === "recovering") {
      throw httpError(409, "Já existe uma recuperação em andamento");
    }
    if (previous && timestamp < previous.startedAtMs + COOLDOWN_MS) {
      throw httpError(429, "Aguarde 30 segundos entre pedidos de recuperação");
    }
    const eligible = channelNos.filter((channelNo) => getChannelState(key, channelNo).enabled);
    if (eligible.length === 0) {
      throw httpError(409, "Nenhum canal habilitado para recuperar");
    }
    const session = {
      status: "recovering",
      source,
      startedAtMs: timestamp,
      channels: eligible.map((channelNo) => ({
        channelNo,
        status: "recovering",
        action: "check",
        message: "Analisando canal",
        reason: reasons.get(channelNo) ?? null,
        healthySinceMs: null,
        publisherRestarted: false,
        cameraRequested: false,
      })),
    };
    sessions.set(key, session);
    notify(key);
    await Promise.all(session.channels.map(async (channel) => {
      try {
        await act(key, channel, getChannelState(key, channel.channelNo), timestamp);
      } catch (error) {
        fail(channel, error);
      }
    }));
    notify(key);
    schedule(() => tick(key));
    return getStatus(key);
  }

  async function tick(key) {
    const session = sessions.get(key);
    if (!session || session.status !== "recovering") {
      return;
    }
    const timestamp = now();
    let changed = false;
    for (const channel of session.channels) {
      if (channel.status !== "recovering") {
        continue;
      }
      try {
        const state = getChannelState(key, channel.channelNo);
        if (!state.enabled) {
          throw new Error("Recuperação cancelada: canal parado pelo operador");
        }
        if (timestamp - session.startedAtMs >= RECOVERY_TIMEOUT_MS) {
          throw new Error("Canal não recuperou mídia e publicação RTSP estável em 30 segundos");
        }
        if (
          strictSyncHolding(state) &&
          isFresh(state, timestamp) &&
          !publisherBlocked(state) &&
          !queueDelayed(state) &&
          !["error", "stopped", "not-started"].includes(state.status)
        ) {
          channel.healthySinceMs = null;
          if (channel.action !== "waiting-sync") {
            channel.action = "waiting-sync";
            channel.actionAtMs = timestamp;
            channel.message =
              "Aguardando alinhamento estrito; publicador RTSP preservado";
            changed = true;
          }
          continue;
        }
        if (channel.action === "waiting-sync") {
          channel.action = "check";
          channel.actionAtMs = timestamp;
          channel.message =
            "Sincronização retomada; aguardando avanço da saída RTSP";
          channel.healthySinceMs = null;
          changed = true;
          continue;
        }
        const audioUnavailable = state.audioRequested &&
          ["waiting", "restoring", "stalled"].includes(state.audioState);
        const healthy = isFresh(state, timestamp) &&
          state.status === "publishing" &&
          state.outputProgress?.frames > 0 &&
          state.outputProgress.lastVideoAdvanceAtMs > session.startedAtMs &&
          timestamp - state.outputProgress.lastVideoAdvanceAtMs < BLOCKED_MS &&
          (audioUnavailable || !state.audioEnabled ||
            (state.audioFrames > 0 &&
              state.lastAudioWriteAtMs !== null &&
              state.lastAudioWriteAtMs > session.startedAtMs &&
              timestamp - state.lastAudioWriteAtMs < MEDIA_STALE_MS)) &&
          !queueDelayed(state) &&
          !publisherBlocked(state);
        if (healthy) {
          if (channel.healthySinceMs === null) {
            channel.healthySinceMs = timestamp;
            channel.healthyOutputFrames = state.outputProgress.frames;
          }
          if (timestamp - channel.healthySinceMs >= 2_000 &&
              state.outputProgress.frames > channel.healthyOutputFrames) {
            channel.status = "recovered";
            channel.message = audioUnavailable
              ? "Video recuperado; aguardando audio da camera"
              : state.audioEnabled
                ? "Saida de video do FFmpeg avancando e entrada de audio ativa"
                : "Saida de video do FFmpeg avancando";
            changed = true;
          }
        } else {
          channel.healthySinceMs = null;
          if (timestamp - channel.actionAtMs >= BLOCKED_MS) {
            if (state.commandPending || state.cameraRetryPending) {
              if (channel.action !== "waiting-command") {
                await act(key, channel, state, timestamp);
                changed = true;
              }
            } else if (channel.action === "waiting-command" ||
                (!isFresh(state, timestamp) && !channel.cameraRequested)) {
              await act(key, channel, state, timestamp);
              changed = true;
            } else if (
              isFresh(state, timestamp) &&
              !startingWithinGrace(state, timestamp) &&
              !channel.publisherRestarted &&
              !strictSyncHolding(state) &&
              (publisherBlocked(state) || queueDelayed(state) ||
                state.status === "error" ||
                outputStalled(state, timestamp) ||
                (state.status !== "publishing" &&
                  timestamp - state.publisherStartedAtMs >= STARTUP_GRACE_MS))
            ) {
              restart(key, channel, timestamp);
              changed = true;
            }
          }
        }
      } catch (error) {
        fail(channel, error);
        changed = true;
      }
    }
    if (session.channels.every((channel) => channel.status !== "recovering")) {
      session.status = session.channels.every((channel) => channel.status === "recovered")
        ? "recovered"
        : "failed";
      if (session.source === "automatic") {
        const observation = monitors.get(key);
        observation.failures = session.status === "failed"
          ? observation.failures + 1
          : 0;
        observation.nextAttemptAtMs = timestamp + Math.min(
          COOLDOWN_MS * 2 ** Math.min(observation.failures, 4),
          MAX_AUTOMATIC_RETRY_MS,
        );
        for (const channel of observation.channels.values()) {
          channel.problemSinceMs = null;
        }
      }
      changed = true;
    }
    if (changed) {
      notify(key);
    }
    if (session.status === "recovering") {
      schedule(() => tick(key));
    }
  }

  return { start, getStatus, tick, monitor };
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
