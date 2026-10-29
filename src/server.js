import net from "node:net";
import {
  decodeFrame,
  encodeGeneralResponse,
  encodeMessage,
  encodeRealtimeAvRequestBody,
  encodeRegistrationResponse,
  encodeStreamControlBody,
  maskTerminalPhone,
  parseAvAttributes,
  parseRegistration,
  parseTerminalGeneralResponse,
} from "./jt808.js";
import { createDashboardServer } from "./dashboard.js";
import { createMediaReceiver } from "./media.js";
import { createRtspMediaPipeline } from "./rtsp-media.js";
import { createObsController } from "./obs.js";
import { createVideoRecovery } from "./video-recovery.js";

const port = Number(process.env.JT808_PORT ?? 7611);
const dashboardPort = Number(process.env.DASHBOARD_PORT ?? 8080);
const mediaPort = Number(process.env.JT1078_PORT ?? 1078);
const mediaPublicPort = Number(process.env.JT1078_PUBLIC_PORT ?? 1078);
const authCode = process.env.JT808_AUTH_CODE ?? "local-test-auth";
const publishedPort = Number(process.env.JT808_HOST_PORT ?? 6608);
const mediaPublicIp = process.env.JT1078_PUBLIC_IP ?? "201.66.73.13";
const mediaRtspBaseUrl =
  process.env.JT1078_RTSP_BASE_URL ?? "rtsp://mediamtx:8554";
const rtspMediaEnabled = process.env.RTSP_MEDIA_ENABLED !== "false";
const videoAutoRecoverySetting = process.env.VIDEO_AUTO_RECOVERY_ENABLED ?? "true";
if (!["true", "false"].includes(videoAutoRecoverySetting)) {
  throw new Error("VIDEO_AUTO_RECOVERY_ENABLED must be true or false");
}
const videoAutoRecoveryEnabled = videoAutoRecoverySetting === "true";
const rtspJitterBufferMs = Number(process.env.RTSP_JITTER_BUFFER_MS ?? 250);
const jt1078IdleTimeoutMs = Number(
  process.env.JT1078_SOCKET_IDLE_TIMEOUT_MS ?? 20_000,
);
const jt1078ReconnectGraceMs = Number(
  process.env.JT1078_RECONNECT_GRACE_MS ?? 30_000,
);
const rtspGopDropQueueBytes = Number(
  process.env.RTSP_GOP_DROP_QUEUE_BYTES ?? 256 * 1024,
);
const rtspAudioArrivalTimeoutMs = Number(
  process.env.RTSP_AUDIO_ARRIVAL_TIMEOUT_MS ?? 8_000,
);
// Por quanto tempo o vigia de áudio "lembra" que um fluxo não trouxe áudio
// antes de dar uma nova chance automaticamente na próxima reconexão. Evita
// que uma única falha transitória (ex.: câmera lenta para retomar áudio logo
// após um restart manual via botão de ressincronização) desative o áudio até
// o container reiniciar.
const rtspAudioRetryCooldownMs = Number(
  process.env.RTSP_AUDIO_RETRY_COOLDOWN_MS ?? 120_000,
);
const rtspSourceClockCalibrationTimeoutMs = Number(
  process.env.RTSP_CLOCK_CALIBRATION_TIMEOUT_MS ?? 1_500,
);
const rtspSourceClockCalibrationSpanMs = Number(
  process.env.RTSP_CLOCK_CALIBRATION_SPAN_MS ?? 80,
);
const rtspSyncMode = process.env.RTSP_SYNC_MODE ?? "bounded-sync";
const rtspSyncToleranceMs = Number(
  process.env.RTSP_SYNC_TOLERANCE_MS ?? 250,
);
const rtspSyncHoldTimeoutMs = Number(
  process.env.RTSP_SYNC_HOLD_TIMEOUT_MS ?? 250,
);
const rtspSyncMaxScheduleAheadMs = Number(
  process.env.RTSP_SYNC_MAX_SCHEDULE_AHEAD_MS ?? 750,
);
const MAX_FRAME_BYTES = 8192;
const MAX_EVENTS = 100;
const COMMAND_TIMEOUT_MS = 15_000;
const MEDIA_START_TIMEOUT_MS = 20_000;
const MEDIA_RESTART_BASE_MS = 1_000;
const MEDIA_RESTART_MAX_MS = 30_000;
const VIDEO_STABLE_MS = 5_000;
const RTSP_CHANNELS = Object.freeze([1, 2]);
const channel1StreamType = Number(
  process.env.JT1078_CHANNEL_1_STREAM_TYPE ?? 0,
);
const channel2StreamType = Number(
  process.env.JT1078_CHANNEL_2_STREAM_TYPE ?? 0,
);
const channel1ForceAudio = process.env.JT1078_CHANNEL_1_FORCE_AUDIO === "true";
const obsWebSocketUrl = process.env.OBS_WEBSOCKET_URL ?? "";
const obsWebSocketPassword = process.env.OBS_WEBSOCKET_PASSWORD ?? "";

for (const [name, value] of [
  ["JT808_PORT", port],
  ["DASHBOARD_PORT", dashboardPort],
  ["JT1078_PORT", mediaPort],
  ["JT1078_PUBLIC_PORT", mediaPublicPort],
  ["JT808_HOST_PORT", publishedPort],
]) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${name} must be an integer from 1 to 65535`);
  }
}
if (Buffer.byteLength(authCode, "utf8") > 128) {
  throw new Error("JT808_AUTH_CODE must not exceed 128 bytes");
}
if (!isIpv4Address(mediaPublicIp)) {
  throw new Error("JT1078_PUBLIC_IP must be a valid IPv4 address");
}
if (
  !Number.isInteger(rtspJitterBufferMs) ||
  rtspJitterBufferMs < 0 ||
  rtspJitterBufferMs > 8000
) {
  throw new Error("RTSP_JITTER_BUFFER_MS must be an integer from 0 to 8000");
}
if (channel1StreamType !== 0 && channel1StreamType !== 1) {
  throw new Error("JT1078_CHANNEL_1_STREAM_TYPE must be 0 or 1");
}
if (channel2StreamType !== 0 && channel2StreamType !== 1) {
  throw new Error("JT1078_CHANNEL_2_STREAM_TYPE must be 0 or 1");
}
if (
  !Number.isInteger(jt1078IdleTimeoutMs) ||
  jt1078IdleTimeoutMs < 1000 ||
  jt1078IdleTimeoutMs > 120_000
) {
  throw new Error(
    "JT1078_SOCKET_IDLE_TIMEOUT_MS must be an integer from 1000 to 120000",
  );
}
if (
  !Number.isInteger(jt1078ReconnectGraceMs) ||
  jt1078ReconnectGraceMs < 0 ||
  jt1078ReconnectGraceMs > 55_000
) {
  throw new Error(
    "JT1078_RECONNECT_GRACE_MS must be an integer from 0 to 55000",
  );
}
if (
  !Number.isInteger(rtspGopDropQueueBytes) ||
  rtspGopDropQueueBytes < 64 * 1024 ||
  rtspGopDropQueueBytes > 1024 * 1024
) {
  throw new Error(
    "RTSP_GOP_DROP_QUEUE_BYTES must be an integer from 65536 to 1048576",
  );
}
if (
  !Number.isInteger(rtspAudioArrivalTimeoutMs) ||
  rtspAudioArrivalTimeoutMs < 1000 ||
  rtspAudioArrivalTimeoutMs > 60_000
) {
  throw new Error(
    "RTSP_AUDIO_ARRIVAL_TIMEOUT_MS must be an integer from 1000 to 60000",
  );
}
if (
  !Number.isInteger(rtspAudioRetryCooldownMs) ||
  rtspAudioRetryCooldownMs < 0 ||
  rtspAudioRetryCooldownMs > 3_600_000
) {
  throw new Error(
    "RTSP_AUDIO_RETRY_COOLDOWN_MS must be an integer from 0 to 3600000",
  );
}
if (
  !Number.isInteger(rtspSourceClockCalibrationTimeoutMs) ||
  rtspSourceClockCalibrationTimeoutMs < 100 ||
  rtspSourceClockCalibrationTimeoutMs > 10_000
) {
  throw new Error(
    "RTSP_CLOCK_CALIBRATION_TIMEOUT_MS must be an integer from 100 to 10000",
  );
}
if (
  !Number.isInteger(rtspSourceClockCalibrationSpanMs) ||
  rtspSourceClockCalibrationSpanMs < 10 ||
  rtspSourceClockCalibrationSpanMs > rtspSourceClockCalibrationTimeoutMs
) {
  throw new Error(
    "RTSP_CLOCK_CALIBRATION_SPAN_MS must be an integer from 10 to RTSP_CLOCK_CALIBRATION_TIMEOUT_MS",
  );
}
if (!["best-effort", "strict-arrival", "bounded-sync"].includes(rtspSyncMode)) {
  throw new Error(
    "RTSP_SYNC_MODE must be best-effort, strict-arrival, or bounded-sync",
  );
}
if (
  !Number.isInteger(rtspSyncToleranceMs) ||
  rtspSyncToleranceMs < 50 ||
  rtspSyncToleranceMs > 2500
) {
  throw new Error("RTSP_SYNC_TOLERANCE_MS must be an integer from 50 to 2500");
}
if (
  !Number.isInteger(rtspSyncHoldTimeoutMs) ||
  rtspSyncHoldTimeoutMs < 50 ||
  rtspSyncHoldTimeoutMs > 2500
) {
  throw new Error("RTSP_SYNC_HOLD_TIMEOUT_MS must be an integer from 50 to 2500");
}
if (
  !Number.isInteger(rtspSyncMaxScheduleAheadMs) ||
  rtspSyncMaxScheduleAheadMs < 50 ||
  rtspSyncMaxScheduleAheadMs > 5000
) {
  throw new Error(
    "RTSP_SYNC_MAX_SCHEDULE_AHEAD_MS must be an integer from 50 to 5000",
  );
}

function getVideoStreamType(channelNo) {
  if (channelNo === 1) {
    return channel1StreamType;
  }
  return channelNo === 2 ? channel2StreamType : 0;
}

let responseSerial = 0;
let eventId = 0;
let mediaReceiver;
const rtspMedia = createRtspMediaPipeline({
  rtspBaseUrl: mediaRtspBaseUrl,
  ffmpegPath: process.env.FFMPEG_PATH ?? "ffmpeg",
  enabled: rtspMediaEnabled,
  separateAudio: true,
  timestampMode: process.env.RTSP_TIMESTAMP_MODE ?? "transport",
  timestampScaleMsPerUnit: Number(process.env.RTSP_TIMESTAMP_SCALE_MS_PER_UNIT ?? 1),
  syncMode: rtspSyncMode,
  syncToleranceMs: rtspSyncToleranceMs,
  syncHoldTimeoutMs: rtspSyncHoldTimeoutMs,
  syncScheduleAheadLimitMs: rtspSyncMaxScheduleAheadMs,
  jitterBufferMs: rtspJitterBufferMs,
  gopDropQueueBytes: rtspGopDropQueueBytes,
  audioArrivalTimeoutMs: rtspAudioArrivalTimeoutMs,
  audioRetryCooldownMs: rtspAudioRetryCooldownMs,
  sourceClockCalibrationTimeoutMs: rtspSourceClockCalibrationTimeoutMs,
  sourceClockCalibrationSpanMs: rtspSourceClockCalibrationSpanMs,
  getCapabilities: (terminalPhoneHex) =>
    terminals.get(terminalPhoneHex)?.avCapabilities,
  getAudioEnabled: (_terminalPhoneHex, channelNo) =>
    getVideoStreamType(channelNo) === 0 ||
    (channelNo === 1 && channel1ForceAudio),
  // Subfluxos experimentais permitem nova tentativa após cooldown;
  // no fluxo principal, vídeo temporário espera áudio real para restaurá-lo.
  isAudioWatchdogArmed: (_terminalPhoneHex, channelNo) =>
    channelNo === 1 && channel1ForceAudio && getVideoStreamType(1) !== 0,
  onEvent: (level, type, message, path, details) => {
    const pathMatch = path?.match(
      /^terminal-([0-9a-f]{12})-channel-(\d+)$/i,
    );
    const terminalPhoneHex = pathMatch?.[1];
    const channelNo = pathMatch ? Number(pathMatch[2]) : undefined;
    recordEvent(
      level,
      type,
      message,
      terminalPhoneHex ? terminals.get(terminalPhoneHex) : undefined,
      channelNo === undefined ? details : { channelNo, ...details },
    );
  },
});
const terminals = new Map();
const events = [];
const pendingCommands = new Map();

const obsController = createObsController({
  url: obsWebSocketUrl,
  password: obsWebSocketPassword,
  log,
});
obsController.onStateChange(() => dashboard.publish());

const videoRecovery = createVideoRecovery({
  getChannelState: (key, channelNo) => {
    const terminal = terminals.get(key);
    const publisher = rtspMedia.getStatus(key, channelNo);
    const pipes = publisher.timing.pipeDiagnosticsByKind;
    return {
      ...publisher,
      lastVideoReceivedAtMs: terminal?.videoLastFrameAtMs.get(channelNo) ??
        publisher.lastVideoReceivedAtMs,
      enabled: publisher.enabled && terminal?.videoChannelIntents.get(channelNo) === true,
      connected: Boolean(terminal?.loginReceivedAt && terminal.socket &&
        !terminal.socket.destroyed && terminal.socket.writable),
      cameraRetryPending: terminal?.videoRestartTimers.has(channelNo) ||
        terminal?.videoStartTimers.has(channelNo) ||
        Boolean(
          terminal &&
          mediaReceiver.hasPendingReconnectFor(terminal.phoneBytes, channelNo),
        ),
      commandPending: hasPendingCommand(key, "start", channelNo) ||
        hasPendingCommand(key, "stop", channelNo),
      videoQueueAgeMs: pipes.video.oldestQueuedForMs,
      audioQueueAgeMs: pipes.audio.oldestQueuedForMs,
      videoBlockedMs: pipes.video.blockedForMs,
      audioBlockedMs: pipes.audio.blockedForMs,
    };
  },
  trimQueue: (key, channelNo) => rtspMedia.trimVideoQueueFor(key, channelNo),
  restartPublisher: (key, channelNo) => {
    rtspMedia.resetAudioWatchdog(key, channelNo);
    rtspMedia.stopStreamFor(key, channelNo);
  },
  requestMedia: (key, channelNo) => handleVideoCommand({
    terminalId: terminals.get(key).terminalId,
    action: "start",
    parameters: { channelNo },
    recoveryRequest: true,
  }),
  onChange: (key, recovery) => recordEvent(
    recovery.channels.some(({ status }) => status === "failed") ? "error" : "info",
    "video-recovery-progress",
    `${recovery.source === "automatic" ? "Recuperação automática" : "Recuperação manual"}: ` +
      recovery.channels.map(({ channelNo, message, reason }) =>
        `Canal ${channelNo}: ${message}${reason ? ` (${reason})` : ""}`).join("; "),
    terminals.get(key),
  ),
});

const dashboard = createDashboardServer({
  getSnapshot: () => ({
    updatedAt: new Date().toISOString(),
    listener: {
      protocol: "JT808",
      transport: "TCP",
      containerPort: port,
      publishedPort,
    },
    media: {
      publicIp: mediaPublicIp,
      publicPort: mediaPublicPort,
      rtspMediaEnabled,
      ...mediaReceiver.getStatus(),
    },
    obs: obsController.getStatus(),
    terminals: [...terminals.values()].map((terminal) => {
      const mediaStreams = mediaReceiver.getActiveStreamsFor(terminal.phoneBytes);
      const videoChannelNo =
        terminal.videoChannelNo ?? mediaStreams[0]?.channelNo ?? null;
      const videoMediaActive = mediaStreams.some(
        (stream) => stream.channelNo === videoChannelNo,
      );
      const videoStatus =
        terminal.videoStatus === "stop-accepted" && videoMediaActive
          ? "stop-accepted-streaming"
          : terminal.videoStatus;

      return {
        terminalId: terminal.terminalId,
        phone: terminal.phone,
        manufacturer: terminal.manufacturer,
        model: terminal.model,
        provinceId: terminal.provinceId,
        cityId: terminal.cityId,
        connected: Boolean(terminal.socket && !terminal.socket.destroyed),
        registeredAt: terminal.registeredAt,
        loginReceivedAt: terminal.loginReceivedAt,
        lastHeartbeatAt: terminal.lastHeartbeatAt,
        lastSeenAt: terminal.lastSeenAt,
        lastMessage: terminal.lastMessage,
        avCapabilities: terminal.avCapabilities,
        capabilitiesStatus: terminal.capabilitiesStatus,
        videoStatus,
        videoChannelNo,
        videoMediaActive,
        recovery: videoRecovery.getStatus(terminal.key),
        autoRecoveryEnabled: videoAutoRecoveryEnabled && rtspMediaEnabled,
        videoChannels: [...terminal.videoChannels].map(([channelNo, status]) => ({
          channelNo,
          status,
          autoStart: terminal.videoChannelIntents.get(channelNo) ?? false,
          streamType: getVideoStreamType(channelNo),
          cameraRetryAttempts: terminal.videoRestartAttempts.get(channelNo) ?? 0,
          cameraRetryPending: terminal.videoRestartTimers.has(channelNo) ||
            terminal.videoStartTimers.has(channelNo),
        })),
        rtspStreams: RTSP_CHANNELS.map((channelNo) => {
          const publisher = rtspMedia.getStatus(terminal.key, channelNo);
          return {
            channelNo,
            path: publisher.path,
            status: publisher.status,
            error: publisher.error,
            audioEnabled: publisher.audioEnabled,
            audioRequested: publisher.audioRequested,
            audioState: publisher.audioState,
            videoFrames: publisher.videoFrames,
            audioFrames: publisher.audioFrames,
            outputProgress: publisher.outputProgress,
            timestampMode: publisher.timestampMode,
            mediaClock: publisher.mediaClock,
            syncStatus: publisher.syncStatus,
            ffmpegDiagnostics: publisher.ffmpegDiagnostics,
            videoDiagnostics: publisher.videoDiagnostics,
            audioDiagnostics: publisher.audioDiagnostics,
            timing: publisher.timing,
          };
        }),
        rtspAudioStream: rtspMedia.getAudioStatus(terminal.key),
        timestampMonitor: rtspMedia.getTimestampMonitorStatus(terminal.key),
        activeMediaStreams: mediaStreams.map(({ channelNo, bytesReceived, lastDataAt }) => ({
          channelNo,
          bytesReceived,
          lastDataAt,
        })),
      };
    }),
    events: [...events].reverse(),
  }),
  onVideoCommand: handleVideoCommand,
  onObsSceneCommand: handleObsSceneCommand,
});

if (videoAutoRecoveryEnabled && rtspMediaEnabled) {
  let scanning = false;
  const timer = setInterval(async () => {
    if (scanning) {
      return;
    }
    scanning = true;
    try {
      for (const terminal of terminals.values()) {
        try {
          await videoRecovery.monitor(terminal.key, RTSP_CHANNELS);
        } catch (error) {
          recordEvent(
            "error",
            "video-auto-recovery-error",
            `Falha no monitor de recuperação: ${error.message}`,
            terminal,
          );
        }
      }
    } finally {
      scanning = false;
    }
  }, 1000);
  timer.unref();
}

function recordEvent(level, type, message, terminal, details) {
  const { terminalPhoneHex, ...eventDetails } = details ?? {};
  const associatedTerminal =
    terminal ??
    (terminalPhoneHex ? terminals.get(terminalPhoneHex) : undefined);
  const event = {
    id: ++eventId,
    timestamp: new Date().toISOString(),
    level,
    type,
    message,
    terminalId: associatedTerminal?.terminalId ?? null,
    model: associatedTerminal?.model ?? null,
    ...eventDetails,
  };

  events.push(event);
  if (events.length > MAX_EVENTS) {
    events.shift();
  }

  log(level, type, {
    message,
    terminalId: event.terminalId,
    ...(associatedTerminal?.model ? { model: associatedTerminal.model } : {}),
    ...eventDetails,
  });
  dashboard.publish();
}

function handleMediaStreamDisconnected(terminalPhoneHex, channelNo) {
  const terminal = terminals.get(terminalPhoneHex);
  if (
    !terminal ||
    terminal.videoChannelIntents.get(channelNo) !== true ||
    !terminal.loginReceivedAt
  ) {
    return;
  }

  terminal.videoChannels.set(channelNo, "reconnecting");
  if (terminal.videoChannelNo === channelNo) {
    terminal.videoStatus = "reconnecting";
  }
}

function handleMediaStreamClosed(terminalPhoneHex, channelNo) {
  rtspMedia.stopStreamFor(terminalPhoneHex, channelNo);
  const terminal = terminals.get(terminalPhoneHex);
  if (
    !terminal ||
    terminal.videoChannelIntents.get(channelNo) !== true ||
    !terminal.loginReceivedAt
  ) {
    return;
  }

  terminal.videoChannels.set(channelNo, "reconnecting");
  if (terminal.videoChannelNo === channelNo) {
    terminal.videoStatus = "reconnecting";
  }
  scheduleVideoStreamRestart(
    terminal,
    channelNo,
    "A conexão JT1078 foi encerrada enquanto o canal continuava habilitado",
  );
}

function hasFreshCameraVideo(terminal, channelNo, sinceMs = 0) {
  const lastFrameAtMs = terminal.videoLastFrameAtMs.get(channelNo);
  return lastFrameAtMs !== undefined && lastFrameAtMs >= sinceMs &&
    Date.now() - lastFrameAtMs < VIDEO_STABLE_MS &&
    mediaReceiver.hasActiveStreamFor(terminal.phoneBytes, channelNo);
}

function scheduleVideoStreamRestart(terminal, channelNo, reason) {
  if (
    terminal.videoChannelIntents.get(channelNo) !== true ||
    !terminal.loginReceivedAt ||
    hasPendingCommand(terminal.key, "start", channelNo) ||
    hasPendingCommand(terminal.key, "stop", channelNo) ||
    terminal.videoStartTimers.has(channelNo) ||
    terminal.videoRestartTimers.has(channelNo)
  ) {
    return;
  }

  const attempt = (terminal.videoRestartAttempts.get(channelNo) ?? 0) + 1;
  terminal.videoStableSinceMs.delete(channelNo);
  terminal.videoRestartAttempts.set(channelNo, attempt);
  const delayMs = Math.min(
    MEDIA_RESTART_BASE_MS * 2 ** Math.min(attempt - 1, 5),
    MEDIA_RESTART_MAX_MS,
  );
  recordEvent(
    "warn",
    "video-stream-auto-restart-scheduled",
    `${reason}; novo pedido para o canal ${channelNo} em ${delayMs} ms (tentativa ${attempt})`,
    terminal,
  );
  const timer = setTimeout(() => {
    terminal.videoRestartTimers.delete(channelNo);
    if (
      terminal.videoChannelIntents.get(channelNo) === true &&
      terminal.loginReceivedAt &&
      !hasFreshCameraVideo(terminal, channelNo)
    ) {
      terminal.videoChannels.set(channelNo, "reconnecting");
      requestVideoAutoStart(terminal, channelNo, { retry: true });
    }
  }, delayMs);
  timer.unref();
  terminal.videoRestartTimers.set(channelNo, timer);
}

function scheduleVideoMediaStartTimeout(terminal, channelNo) {
  clearVideoMediaStartTimer(terminal, channelNo);
  clearVideoRestartTimer(terminal, channelNo);
  if (hasFreshCameraVideo(terminal, channelNo)) {
    return;
  }

  const timer = setTimeout(() => {
    terminal.videoStartTimers.delete(channelNo);
    if (
      terminal.videoChannelIntents.get(channelNo) === true &&
      terminal.loginReceivedAt &&
      !hasFreshCameraVideo(terminal, channelNo)
    ) {
      terminal.videoChannels.set(channelNo, "reconnecting");
      scheduleVideoStreamRestart(
        terminal,
        channelNo,
        `Nenhum video JT1078 recente ${MEDIA_START_TIMEOUT_MS / 1000} segundos após o aceite`,
      );
    }
  }, MEDIA_START_TIMEOUT_MS);
  timer.unref();
  terminal.videoStartTimers.set(channelNo, timer);
}

function clearVideoMediaStartTimer(terminal, channelNo) {
  const timer = terminal.videoStartTimers.get(channelNo);
  if (timer) {
    clearTimeout(timer);
    terminal.videoStartTimers.delete(channelNo);
  }
}

function clearVideoRestartTimer(terminal, channelNo) {
  const timer = terminal.videoRestartTimers.get(channelNo);
  if (timer) {
    clearTimeout(timer);
    terminal.videoRestartTimers.delete(channelNo);
  }
}

function clearVideoTimers(terminal) {
  for (const channelNo of terminal.videoStartTimers.keys()) {
    clearVideoMediaStartTimer(terminal, channelNo);
  }
  for (const channelNo of terminal.videoRestartTimers.keys()) {
    clearVideoRestartTimer(terminal, channelNo);
  }
}

mediaReceiver = createMediaReceiver({
  port: mediaPort,
  idleTimeoutMs: jt1078IdleTimeoutMs,
  reconnectGraceMs: jt1078ReconnectGraceMs,
  onEvent: (level, type, message, details) =>
    recordEvent(level, type, message, undefined, details),
  onFrame: (frame) => {
    const terminal = terminals.get(frame.terminalPhoneHex);
    if (terminal && frame.kind === "video") {
      const timestamp = Date.now();
      const previous = terminal.videoLastFrameAtMs.get(frame.channelNo);
      if (previous === undefined || timestamp - previous >= VIDEO_STABLE_MS ||
          !terminal.videoStableSinceMs.has(frame.channelNo)) {
        terminal.videoStableSinceMs.set(frame.channelNo, timestamp);
      }
      terminal.videoLastFrameAtMs.set(frame.channelNo, timestamp);
      clearVideoMediaStartTimer(terminal, frame.channelNo);
      clearVideoRestartTimer(terminal, frame.channelNo);
      if (terminal.videoChannels.get(frame.channelNo) === "reconnecting") {
        terminal.videoChannels.set(frame.channelNo, "accepted");
        if (terminal.videoChannelNo === frame.channelNo) {
          terminal.videoStatus = "accepted";
        }
      }
      if (timestamp - terminal.videoStableSinceMs.get(frame.channelNo) >= VIDEO_STABLE_MS) {
        terminal.videoRestartAttempts.delete(frame.channelNo);
      }
    }
    if (RTSP_CHANNELS.includes(frame.channelNo)) {
      rtspMedia.pushFrame(frame);
    }
  },
  onStreamDisconnected: handleMediaStreamDisconnected,
  onStreamClosed: handleMediaStreamClosed,
});

const server = net.createServer((socket) => {
  socket.setNoDelay(true);
  let pending = Buffer.alloc(0);
  let associatedTerminalKey;

  recordEvent("info", "connection-open", "Nova conexão TCP JT808");

  socket.on("data", (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    const { frames, remainder } = extractFrames(pending);
    pending = remainder;

    if (pending.length > MAX_FRAME_BYTES) {
      recordEvent(
        "warn",
        "incomplete-frame-too-large",
        "Quadro JT808 incompleto excedeu o limite",
      );
      socket.destroy();
      return;
    }

    for (const wireFrame of frames) {
      associatedTerminalKey = handleFrame(socket, wireFrame, associatedTerminalKey);
    }
  });

  socket.on("close", () => {
    if (associatedTerminalKey) {
      const terminal = terminals.get(associatedTerminalKey);
      if (terminal) {
        terminal.sockets.delete(socket);
        if (terminal.socket === socket) {
          terminal.socket = [...terminal.sockets].at(-1);
        }
        if (terminal.videoControlSocket === socket) {
          terminal.videoControlSocket = undefined;
        }
        if (terminal.sockets.size === 0) {
          terminal.loginReceivedAt = null;
          terminal.capabilitiesStatus = "not-queried";
          clearPendingCommandsForTerminal(terminal.key);
          clearVideoTimers(terminal);
          for (const stream of mediaReceiver.getActiveStreamsFor(terminal.phoneBytes)) {
            const channelNo = stream.channelNo;
            mediaReceiver.stopStreamFor(terminal.phoneBytes, channelNo);
          }
          for (const [channelNo, autoStart] of terminal.videoChannelIntents) {
            if (autoStart) {
              terminal.videoChannels.set(channelNo, "reconnecting");
            }
          }
          if ([...terminal.videoChannelIntents.values()].some(Boolean)) {
            terminal.videoStatus = "reconnecting";
          }
        }
        recordEvent(
          "info",
          "connection-closed",
          terminal.sockets.size > 0
            ? "Uma conexão JT808 do terminal foi encerrada"
            : "Terminal desconectado",
          terminal,
        );
        return;
      }
    }

    recordEvent("info", "connection-closed", "Conexão TCP encerrada");
  });

  socket.on("error", (error) => {
    recordEvent("warn", "connection-error", `Erro na conexão TCP: ${error.message}`);
  });
});

server.on("error", (error) => {
  log("error", "listener-error", { error: error.message });
  process.exitCode = 1;
});

server.listen(port, "0.0.0.0", () => {
  recordEvent("info", "listener-ready", `Listener JT808 ativo na porta TCP ${port}`);
});

mediaReceiver.server.on("error", (error) => {
  log("error", "media-listener-error", { error: error.message });
  process.exitCode = 1;
});

mediaReceiver.server.listen(mediaPort, "0.0.0.0", () => {
  recordEvent(
    "info",
    "media-listener-ready",
    `Receptor JT1078 TCP ativo na porta ${mediaPort}`,
  );
});

dashboard.server.on("error", (error) => {
  log("error", "dashboard-listener-error", { error: error.message });
  process.exitCode = 1;
});

dashboard.server.listen(dashboardPort, "0.0.0.0", () => {
  log("info", "dashboard-ready", {
    address: "0.0.0.0",
    port: dashboardPort,
    hostBinding: "127.0.0.1",
  });
});

function handleFrame(socket, wireFrame, associatedTerminalKey) {
  let message;
  try {
    message = decodeFrame(wireFrame);
  } catch (error) {
    recordEvent("warn", "invalid-frame", `Quadro inválido: ${error.message}`);
    return associatedTerminalKey;
  }

  const terminalKey = message.terminalPhone.toString("hex");
  const terminal = getOrCreateTerminal(terminalKey, message.terminalPhone);
  terminal.sockets.add(socket);
  terminal.socket = socket;
  terminal.lastSeenAt = new Date().toISOString();
  terminal.lastMessage = formatMessageId(message.messageId);
  let resumeActionAfterAck = null;

  if (message.encrypted) {
    recordEvent(
      "warn",
      "encrypted-message",
      `Mensagem criptografada ${terminal.lastMessage}; conteúdo não interpretado`,
      terminal,
    );
  } else if (message.messageId === 0x0100) {
    const registration = parseRegistration(message.body);
    if (registration) {
      terminal.terminalId = registration.terminalId || terminal.terminalId;
      terminal.manufacturer = registration.manufacturer || terminal.manufacturer;
      terminal.model = registration.model || terminal.model;
      terminal.provinceId = registration.provinceId;
      terminal.cityId = registration.cityId;
    }
    terminal.registeredAt = terminal.lastSeenAt;
    recordEvent(
      "info",
      "terminal-registration",
      registration
        ? `Registro recebido (${registration.manufacturer || "fabricante desconhecido"} ${registration.model || ""})`.trim()
        : "Registro JT808 recebido; corpo fora do formato esperado",
      terminal,
    );
  } else if (message.messageId === 0x0102) {
    terminal.loginReceivedAt = terminal.lastSeenAt;
    if (
      !hasPendingCommand(terminal.key, "capabilities") &&
      (!terminal.avCapabilities ||
        [...terminal.videoChannels.values()].includes("reconnecting"))
    ) {
      resumeActionAfterAck = "capabilities";
    }
    recordEvent(
      "info",
      "terminal-login",
      "Mensagem de login JT808 recebida; credenciais não são validadas neste protótipo",
      terminal,
    );
  } else if (message.messageId === 0x0002) {
    terminal.lastHeartbeatAt = terminal.lastSeenAt;
    recordEvent("info", "terminal-heartbeat", "Heartbeat JT808 recebido", terminal);
  } else if (message.messageId === 0x0001) {
    handleTerminalGeneralResponse(terminalKey, terminal, message.body, socket);
  } else if (message.messageId === 0x1003) {
    if (handleAvCapabilitiesResponse(terminalKey, terminal, message.body)) {
      resumeActionAfterAck = "start-available-channels";
    }
  } else {
    recordEvent(
      "info",
      "message-received",
      `Mensagem JT808 ${terminal.lastMessage} recebida`,
      terminal,
    );
  }

  if (message.encrypted || message.messageId === 0x0001) {
    return terminalKey;
  }

  const serial = nextResponseSerial();
  const response =
    message.messageId === 0x0100
      ? encodeRegistrationResponse(message, serial, authCode)
      : encodeGeneralResponse(message, serial);

  socket.write(response, (error) => {
    if (error) {
      recordEvent(
        "warn",
        "response-write-error",
        `Falha ao responder ${terminal.lastMessage}: ${error.message}`,
        terminal,
      );
      return;
    }

    recordEvent(
      "info",
      "message-acknowledged",
      `Confirmação enviada (${message.messageId === 0x0100 ? "0x8100" : "0x8001"})`,
      terminal,
    );
    if (resumeActionAfterAck === "capabilities") {
      requestVideoAutoResumeCapabilities(terminal);
    } else if (resumeActionAfterAck === "start-available-channels") {
      requestVideoAutoStartAvailableChannels(terminal);
    }
  });

  return terminalKey;
}

function handleTerminalGeneralResponse(terminalKey, terminal, body, socket) {
  const response = parseTerminalGeneralResponse(body);
  if (!response) {
    recordEvent("warn", "invalid-terminal-response", "Resposta JT808 do terminal inválida", terminal);
    return;
  }

  const pendingKey = getPendingCommandKey(terminalKey, response.responseSerial);
  const command = pendingCommands.get(pendingKey);
  const resultText = response.result === 0 ? "aceito" : `recusado (código ${response.result})`;

  if (!command || command.messageId !== response.responseMessageId) {
    recordEvent(
      "info",
      "terminal-general-response",
      `Confirmação do terminal para ${formatMessageId(response.responseMessageId)}: ${resultText}`,
      terminal,
    );
    return;
  }

  clearTimeout(command.timer);
  if (command.action === "capabilities" && response.result === 0) {
    command.status = "awaiting-capabilities";
    command.timer = setTimeout(() => timeoutPendingCommand(pendingKey), COMMAND_TIMEOUT_MS);
    command.timer.unref();
  } else {
    pendingCommands.delete(pendingKey);
  }

  if (command.action === "start") {
    if (terminal.videoChannelIntents.get(command.channelNo) !== true) {
      recordEvent("info", "video-start-response-after-stop",
        "Confirmacao de inicio recebida apos parada manual; mantendo o canal parado",
        terminal, { channelNo: command.channelNo });
      return;
    }
    const status = response.result === 0 ? "accepted" : "rejected";
    terminal.videoChannels.set(command.channelNo, status);
    if (terminal.videoChannelNo === command.channelNo) {
      terminal.videoStatus = status;
    }
    if (response.result === 0) {
      terminal.videoControlSocket = socket;
      scheduleVideoMediaStartTimeout(terminal, command.channelNo);
    } else {
      clearVideoMediaStartTimer(terminal, command.channelNo);
      if (!hasFreshCameraVideo(terminal, command.channelNo, command.sentAtMs)) {
        scheduleVideoStreamRestart(terminal, command.channelNo,
          `Pedido de inicio recusado (codigo ${response.result}) sem video recente`);
      }
    }
  } else if (command.action === "stop") {
    const status = response.result === 0 ? "stop-accepted" : "stop-rejected";
    terminal.videoChannels.set(command.channelNo, status);
    if (terminal.videoChannelNo === command.channelNo) {
      terminal.videoStatus = status;
    }
    if (response.result === 0) {
      terminal.videoControlSocket = socket;
      const closedMediaConnections = mediaReceiver.stopStreamFor(
        terminal.phoneBytes,
        command.channelNo,
      );
      if (closedMediaConnections > 0) {
        recordEvent(
          "warn",
          "media-connection-forced-close",
          "Terminal aceitou a parada, mas o fluxo JT1078 continuou; o servidor encerrou a conexão de mídia",
          terminal,
        );
      }
    }
  } else if (command.action === "capabilities") {
    terminal.capabilitiesStatus = response.result === 0 ? "awaiting-response" : "rejected";
  }

  recordEvent(
    response.result === 0 ? "info" : "warn",
    "terminal-command-response",
    `Terminal ${resultText} comando ${formatMessageId(response.responseMessageId)}`,
    terminal,
  );
}

function handleAvCapabilitiesResponse(terminalKey, terminal, body) {
  const capabilities = parseAvAttributes(body);
  if (!capabilities) {
    terminal.capabilitiesStatus = "invalid-response";
    recordEvent(
      "warn",
      "invalid-av-capabilities",
      "Resposta 0x1003 curta demais para decodificar",
      terminal,
    );
    return;
  }

  terminal.avCapabilities = capabilities;
  terminal.capabilitiesStatus = "ready";
  for (const [key, command] of pendingCommands) {
    if (command.terminalKey === terminalKey && command.action === "capabilities") {
      clearTimeout(command.timer);
      pendingCommands.delete(key);
    }
  }
  recordEvent(
    "info",
    "av-capabilities",
    `Capacidades AV recebidas: ${capabilities.maxVideoChannels} canal(is) de vídeo`,
    terminal,
  );

  return true;
}

function requestVideoAutoStartAvailableChannels(terminal) {
  const requestedChannels = RTSP_CHANNELS;
  for (const channelNo of requestedChannels) {
    if (!terminal.videoChannelIntents.has(channelNo)) {
      terminal.videoChannelIntents.set(channelNo, true);
    }
  }
  const channelsToStart = [...terminal.videoChannelIntents]
    .filter(
      ([channelNo, autoStart]) =>
        autoStart &&
        (requestedChannels.includes(channelNo) ||
          channelNo <= terminal.avCapabilities.maxVideoChannels),
    )
    .map(([channelNo]) => channelNo)
    .sort((left, right) => left - right);
  for (const channelNo of channelsToStart) {
    requestVideoAutoStart(terminal, channelNo);
  }
  if (channelsToStart.length > 0) {
    recordEvent(
      "info",
      "av-capabilities-auto-start",
      `Início automático solicitado para ${channelsToStart.length} canal(is) após receber capacidades`,
      terminal,
    );
  }
}

function requestVideoAutoStart(terminal, channelNo, { retry = false } = {}) {
  if (
    ["request-sent", "accepted"].includes(terminal.videoChannels.get(channelNo)) ||
    hasPendingCommand(terminal.key, "start", channelNo) ||
    hasPendingCommand(terminal.key, "stop", channelNo) ||
    terminal.videoRestartTimers.has(channelNo) ||
    terminal.videoStartTimers.has(channelNo) ||
    hasFreshCameraVideo(terminal, channelNo)
  ) {
    return;
  }

  terminal.videoChannelIntents.set(channelNo, true);
  terminal.videoChannels.set(channelNo, "request-sent");
  terminal.videoStatus = "request-sent";
  terminal.videoChannelNo = channelNo;
  recordEvent(
    "info",
    "video-auto-start",
    `Início automático de vídeo solicitado para o canal ${channelNo}`,
    terminal,
  );
  void handleVideoCommand({
    terminalId: terminal.terminalId,
    action: "start",
    parameters: { channelNo },
    recoveryRequest: retry,
  }).catch((error) => {
    if (terminal.videoChannels.get(channelNo) === "request-sent") {
      terminal.videoChannels.set(channelNo, "error");
    }
    if (terminal.videoChannelNo === channelNo) {
      terminal.videoStatus = "reconnecting";
    }
    scheduleVideoStreamRestart(
      terminal,
      channelNo,
      `Não foi possível enviar o pedido automático: ${error.message}`,
    );
    recordEvent(
      "warn",
      "video-auto-start-failed",
      `Não foi possível iniciar o vídeo no canal ${channelNo}: ${error.message}`,
      terminal,
    );
  });
}

function requestVideoAutoResumeCapabilities(terminal) {
  if (
    hasPendingCommand(terminal.key, "capabilities")
  ) {
    return;
  }

  recordEvent(
    "info",
    "video-auto-resume-capabilities",
    "Consultando capacidades da câmera para iniciar ou retomar os canais de vídeo",
    terminal,
  );
  void handleVideoCommand({
    terminalId: terminal.terminalId,
    action: "capabilities",
    parameters: {},
  }).catch((error) => {
    if (terminal.capabilitiesStatus === "query-sent") {
      terminal.capabilitiesStatus = "not-queried";
    }
    recordEvent(
      "warn",
      "video-auto-resume-capabilities-failed",
      `Não foi possível consultar canais para retomar o vídeo: ${error.message}`,
      terminal,
    );
  });
}

async function handleObsSceneCommand(parameters) {
  const sceneName = parameters?.sceneName;
  await obsController.setCurrentScene(sceneName);
  recordEvent(
    "info",
    "obs-scene-switched",
    `Cena do OBS trocada para "${sceneName}"`,
  );
  return obsController.getStatus();
}

async function handleVideoCommand({
  terminalId,
  action,
  parameters,
  recoveryRequest = false,
}) {
  const terminal = [...terminals.values()].find(
    (candidate) => candidate.terminalId === terminalId,
  );
  if (!terminal) {
    throw httpError(404, "Terminal não encontrado; aguarde o registro JT808");
  }
  if (action === "resync") {
    return handleVideoResync(terminal);
  }
  const commandSocket =
    action === "stop" && terminal.videoControlSocket?.writable
      ? terminal.videoControlSocket
      : terminal.socket;
  if (!commandSocket || commandSocket.destroyed || !commandSocket.writable) {
    throw httpError(409, "Terminal desconectado");
  }
  if (!terminal.loginReceivedAt) {
    throw httpError(409, "O terminal ainda não enviou login JT808");
  }

  let messageId;
  let body = Buffer.alloc(0);
  let channelNo;
  if (action === "capabilities") {
    if (hasPendingCommand(terminal.key, "capabilities")) {
      throw httpError(409, "Já existe uma consulta de capacidades aguardando resposta");
    }
    messageId = 0x9003;
    terminal.capabilitiesStatus = "query-sent";
  } else {
    channelNo = parameters.channelNo;
    if (action === "start") {
      if (!terminal.avCapabilities) {
        throw httpError(409, "Consulte primeiro as capacidades AV da câmera");
      }
      if (!RTSP_CHANNELS.includes(channelNo)) {
        throw httpError(400, "Os canais RTSP disponíveis são 1 e 2");
      }
      if (
        (!recoveryRequest && mediaReceiver.hasActiveStreamFor(terminal.phoneBytes, channelNo)) ||
        hasPendingCommand(terminal.key, "start", channelNo) ||
        hasPendingCommand(terminal.key, "stop", channelNo)
      ) {
        throw httpError(409, "Já existe um fluxo de vídeo ativo ou em andamento");
      }
      messageId = 0x9101;
      body = encodeRealtimeAvRequestBody({
        serverIp: mediaPublicIp,
        tcpPort: mediaPublicPort,
        udpPort: 0,
        channelNo,
        dataType: 0,
        streamType: getVideoStreamType(channelNo),
      });
      terminal.videoChannelIntents.set(channelNo, true);
      clearVideoRestartTimer(terminal, channelNo);
      clearVideoMediaStartTimer(terminal, channelNo);
      terminal.videoChannels.set(channelNo, "request-sent");
      terminal.videoStatus = "request-sent";
      terminal.videoChannelNo = channelNo;
    } else if (action === "stop") {
      if (!RTSP_CHANNELS.includes(channelNo)) {
        throw httpError(400, "Os canais RTSP disponíveis são 1 e 2");
      }
      const mediaActive = mediaReceiver.hasActiveStreamFor(
        terminal.phoneBytes,
        channelNo,
      );
      const channelStatus = terminal.videoChannels.get(channelNo);
      if (
        hasPendingCommand(terminal.key, "stop", channelNo) ||
        (!mediaActive &&
          !hasPendingCommand(terminal.key, "start", channelNo) &&
          ![
            "request-sent",
            "accepted",
            "timeout",
            "stop-accepted",
            "stop-rejected",
            "stop-timeout",
            "reconnecting",
            "error",
          ].includes(channelStatus))
      ) {
        throw httpError(409, "Não há fluxo de vídeo ativo ou em andamento para parar");
      }
      messageId = 0x9102;
      body = encodeStreamControlBody({
        channelNo,
        controlCommand: 0,
        closeAvData: 0,
        streamType: getVideoStreamType(channelNo),
      });
      terminal.videoChannelIntents.set(channelNo, false);
      terminal.videoStableSinceMs.delete(channelNo);
      clearVideoRestartTimer(terminal, channelNo);
      clearVideoMediaStartTimer(terminal, channelNo);
      terminal.videoChannels.set(channelNo, "stop-sent");
      terminal.videoStatus = "stop-sent";
      terminal.videoChannelNo = channelNo;
    } else {
      throw httpError(404, "Comando de vídeo desconhecido");
    }
  }

  const targetSockets =
    action === "stop"
      ? [...terminal.sockets].filter((socket) => !socket.destroyed && socket.writable)
      : [commandSocket];
  if (targetSockets.length === 0) {
    throw httpError(409, "Não há conexão JT808 ativa para enviar o comando");
  }
  if (action === "start") {
    if (recoveryRequest) {
      rtspMedia.resetAudioWatchdog(terminal.key, channelNo);
    }
    mediaReceiver.allowStreamFor(terminal.phoneBytes, channelNo);
    rtspMedia.allowStreamFor(terminal.key, channelNo);
  }
  const outboundCommands = targetSockets.map((socket) => {
    const serial = nextResponseSerial();
    const frame = encodeMessage({
      messageId,
      terminalPhone: terminal.phoneBytes,
      serial,
      body,
    });
    const pendingKey = getPendingCommandKey(terminal.key, serial);
    const pendingCommand = {
      terminalKey: terminal.key,
      terminalId,
      serial,
      messageId,
      action,
      channelNo,
      socket,
      status: "awaiting-ack",
      timer: undefined,
      sentAtMs: Date.now(),
    };
    pendingCommand.timer = setTimeout(
      () => timeoutPendingCommand(pendingKey),
      COMMAND_TIMEOUT_MS,
    );
    pendingCommand.timer.unref();
    pendingCommands.set(pendingKey, pendingCommand);
    return { socket, frame, serial, pendingKey, pendingCommand };
  });

  const writeResults = await Promise.all(
    outboundCommands.map(
      ({ socket, frame }) =>
        new Promise((resolve) => {
          socket.write(frame, (error) => resolve(error ?? null));
        }),
    ),
  );
  const successfulWrites = writeResults.filter((error) => error === null).length;
  if (successfulWrites === 0) {
    for (const command of outboundCommands) {
      clearTimeout(command.pendingCommand.timer);
      pendingCommands.delete(command.pendingKey);
    }
    if (action === "start") {
      terminal.videoChannels.set(channelNo, "error");
      scheduleVideoStreamRestart(terminal, channelNo,
        "Falha TCP ao enviar o pedido de inicio");
    }
    const errorMessage = writeResults.find((error) => error instanceof Error)?.message;
    throw httpError(502, `Não foi possível enviar o comando: ${errorMessage ?? "falha TCP"}`);
  }
  for (let index = 0; index < outboundCommands.length; index += 1) {
    if (writeResults[index] !== null) {
      const command = outboundCommands[index];
      clearTimeout(command.pendingCommand.timer);
      pendingCommands.delete(command.pendingKey);
    }
  }
  if (successfulWrites < targetSockets.length) {
    recordEvent(
      "warn",
      "platform-command-partial-send",
      `Comando ${formatMessageId(messageId)} enviado em ${successfulWrites} de ${targetSockets.length} conexões`,
      terminal,
    );
  }
  if (action === "start" || action === "stop") {
    terminal.videoControlSocket = commandSocket;
  }
  const serials = outboundCommands
    .filter((_, index) => writeResults[index] === null)
    .map((command) => command.serial);
  const serial = serials[0];

  const message = action === "capabilities"
    ? "Consulta JT808 0x9003 enviada"
    : action === "start"
      ? `Pedido de vídeo 0x9101 enviado para o canal ${channelNo}`
      : `Comando para encerrar o fluxo 0x9102 enviado ao canal ${channelNo} por ${successfulWrites} sessão(ões)`;
  recordEvent("info", "platform-command-sent", message, terminal);

  return {
    status: "sent",
    messageId: formatMessageId(messageId),
    serial,
    serials,
    channelNo: channelNo ?? null,
    sessions: successfulWrites,
    message,
  };
}

function handleVideoResync(terminal) {
  return videoRecovery.start(terminal.key, RTSP_CHANNELS);
}

function timeoutPendingCommand(pendingKey) {
  const command = pendingCommands.get(pendingKey);
  if (!command) {
    return;
  }

  pendingCommands.delete(pendingKey);
  const terminal = terminals.get(command.terminalKey);
  if (terminal) {
    if (command.action === "capabilities") {
      terminal.capabilitiesStatus = "timeout";
    } else if (command.action === "start") {
      if (terminal.videoChannelIntents.get(command.channelNo) !== true) {
        recordEvent("warn", "platform-command-timeout",
          "Pedido de inicio expirou apos parada manual; mantendo o canal parado", terminal,
          { channelNo: command.channelNo });
        return;
      }
      if (hasFreshCameraVideo(terminal, command.channelNo, command.sentAtMs)) {
        terminal.videoChannels.set(command.channelNo, "timeout");
        if (terminal.videoChannelNo === command.channelNo) {
          terminal.videoStatus = "timeout";
        }
        recordEvent("warn", "video-start-ack-missing",
          "Sem confirmacao JT808 em 15 segundos, mas video recente recebido; mantendo a transmissao",
          terminal, { channelNo: command.channelNo });
        return;
      }
      terminal.videoChannels.set(command.channelNo, "timeout");
      if (terminal.videoChannelNo === command.channelNo) {
        terminal.videoStatus = "timeout";
      }
      scheduleVideoStreamRestart(terminal, command.channelNo,
        "Pedido de inicio expirou sem video recente");
    } else if (command.action === "stop") {
      terminal.videoChannels.set(command.channelNo, "stop-timeout");
      if (terminal.videoChannelNo === command.channelNo) {
        terminal.videoStatus = "stop-timeout";
      }
    }
    recordEvent(
      "warn",
      "platform-command-timeout",
      `Sem resposta ao comando ${formatMessageId(command.messageId)} em 15 segundos`,
      terminal,
    );
    return;
  }

  recordEvent(
    "warn",
    "platform-command-timeout",
    `Sem resposta ao comando ${formatMessageId(command.messageId)} em 15 segundos`,
  );
}

function getOrCreateTerminal(key, phoneBytes) {
  let terminal = terminals.get(key);
  if (!terminal) {
    terminal = {
      key,
      phoneBytes: Buffer.from(phoneBytes),
      terminalId: null,
      phone: maskTerminalPhone(phoneBytes),
      manufacturer: null,
      model: null,
      provinceId: null,
      cityId: null,
      socket: undefined,
      sockets: new Set(),
      videoControlSocket: undefined,
      registeredAt: null,
      loginReceivedAt: null,
      lastHeartbeatAt: null,
      lastSeenAt: null,
      lastMessage: null,
      avCapabilities: null,
      capabilitiesStatus: "not-queried",
      videoStatus: "idle",
      videoChannelNo: null,
      videoChannels: new Map(),
      videoChannelIntents: new Map(),
      videoRestartTimers: new Map(),
      videoStartTimers: new Map(),
      videoRestartAttempts: new Map(),
      videoLastFrameAtMs: new Map(),
      videoStableSinceMs: new Map(),
    };
    terminals.set(key, terminal);
  }
  return terminal;
}

function extractFrames(buffer) {
  const frames = [];
  let cursor = 0;

  while (cursor < buffer.length) {
    const start = buffer.indexOf(0x7e, cursor);
    if (start === -1) {
      return { frames, remainder: Buffer.alloc(0) };
    }

    const end = buffer.indexOf(0x7e, start + 1);
    if (end === -1) {
      return {
        frames,
        remainder: Buffer.from(buffer.subarray(start)),
      };
    }

    if (end > start + 1) {
      frames.push(buffer.subarray(start, end + 1));
    }
    cursor = end + 1;
  }

  return { frames, remainder: Buffer.alloc(0) };
}

function nextResponseSerial() {
  responseSerial = (responseSerial + 1) & 0xffff;
  return responseSerial;
}

function formatMessageId(messageId) {
  return `0x${messageId.toString(16).padStart(4, "0")}`;
}

function getPendingCommandKey(terminalKey, serial) {
  return `${terminalKey}:${serial}`;
}

function hasPendingCommand(terminalKey, action, channelNo) {
  return [...pendingCommands.values()].some(
    (command) =>
      command.terminalKey === terminalKey &&
      command.action === action &&
      (channelNo === undefined || command.channelNo === channelNo),
  );
}

function clearPendingCommandsForTerminal(terminalKey, action) {
  for (const [key, command] of pendingCommands) {
    if (
      command.terminalKey === terminalKey &&
      (action === undefined || command.action === action)
    ) {
      clearTimeout(command.timer);
      pendingCommands.delete(key);
    }
  }
}

function isIpv4Address(value) {
  const parts = value.split(".");
  return (
    parts.length === 4 &&
    parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255)
  );
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function log(level, event, details) {
  console.log(
    JSON.stringify({
      timestamp: new Date().toISOString(),
      level,
      event,
      ...details,
    }),
  );
}
