import { spawn } from "node:child_process";
import { createMpegTsWriter } from "./mpeg-ts.js";
import { advanceMediaClock, getVideoIntervalMs } from "./media-clock.js";

const AAC_SAMPLE_RATE = new Map([
  [0, 8000],
  [1, 22050],
  [2, 44100],
  [3, 48000],
]);
const AAC_FREQUENCY_INDEX = new Map([
  [8000, 11],
  [22050, 7],
  [44100, 4],
  [48000, 3],
]);
const ADTS_SAMPLE_RATES = [
  96000,
  88200,
  64000,
  48000,
  44100,
  32000,
  24000,
  22050,
  16000,
  12000,
  11025,
  8000,
  7350,
];
const AAC_PROFILE_NAMES = ["AAC Main", "AAC LC", "AAC SSR", "AAC LTP"];
const MAX_PUBLISHERS = 8;
const DEFAULT_JITTER_BUFFER_MS = 500;
const MAX_JITTER_BUFFER_MS = 8_000;
const MAX_SOURCE_CLOCK_STEP_MS = 10_000;
const MAX_STRICT_VIDEO_LATENESS_MS = 250;
const STRICT_SOURCE_CLOCK_RATE_WINDOW_MS = 5_000;
const STRICT_SOURCE_CLOCK_RATE_MAX_AGE_MS = 15_000;
const STRICT_SOURCE_CLOCK_RATE_MAX_SPREAD = 0.08;
const STRICT_SOURCE_CLOCK_RATE_STABLE_WINDOWS = 2;
// Validate advancing source timestamps, never estimate units from network arrival.
const DEFAULT_SOURCE_CLOCK_CALIBRATION_TIMEOUT_MS = 1_500;
const DEFAULT_SOURCE_CLOCK_CALIBRATION_SPAN_MS = 80;
// Quando áudio (até ~50 quadros/s) e vídeo (até ~30 quadros/s) chegam juntos
// no mesmo canal, o total combinado pode ultrapassar 100 quadros em 1.5s;
// um limite baixo encerrava a calibração (arrival-fallback) antes mesmo de
// o timeout acima ser atingido. Mantido com folga para a janela padrão.
const MAX_STARTUP_FRAMES = 300;
const TIMESTAMP_MONITOR_SAMPLE_INTERVAL_MS = 5_000;
const TIMESTAMP_MONITOR_LOG_INTERVAL_MS = 60_000;
const MAX_TIMESTAMP_MONITOR_SAMPLES = 720;
const TIMESTAMP_MONITOR_LANES = [
  "channel1Video",
  "channel2Video",
  "channel1Audio",
];
const DEFAULT_GOP_DROP_QUEUE_BYTES = 256 * 1024;
const MAX_PIPE_QUEUE_BYTES = 1024 * 1024;
const INITIAL_PUBLISHER_RETRY_MS = 1_000;
const MAX_PUBLISHER_RETRY_MS = 30_000;
const AUDIO_ARRIVAL_TIMEOUT_MS = 8_000;
// Por quanto tempo a memória de "áudio indisponível" (ver audioUnavailableKeys
// abaixo) permanece válida após um watchdog disparar. Passado esse prazo, a
// próxima reconexão tenta áudio novamente automaticamente. Evita que uma
// única falha transitória (ex.: câmera lenta para retomar áudio logo após um
// restart) desative o áudio até o processo/container reiniciar.
const AUDIO_RETRY_COOLDOWN_MS = 120_000;
const DEFAULT_SYNC_HOLD_TIMEOUT_MS = 250;
const DEFAULT_SYNC_SCHEDULE_AHEAD_LIMIT_MS = 750;
const SYNC_HOLD_TIMER_SAFETY_MARGIN_MS = 20;
const MAX_FFMPEG_DIAGNOSTIC_LINES = 40;
const MAX_FFMPEG_DIAGNOSTIC_LINE_LENGTH = 320;
const VIDEO_FORMAT_BY_ENCODING = new Map([
  [98, "h264"],
  [99, "hevc"],
]);

export function createRtspMediaPipeline({
  rtspBaseUrl,
  ffmpegPath = "ffmpeg",
  enabled = true,
  timestampMode = "transport",
  timestampScaleMsPerUnit = 1,
  syncMode = "best-effort",
  syncToleranceMs = 250,
  syncHoldTimeoutMs = DEFAULT_SYNC_HOLD_TIMEOUT_MS,
  syncScheduleAheadLimitMs = DEFAULT_SYNC_SCHEDULE_AHEAD_LIMIT_MS,
  jitterBufferMs = DEFAULT_JITTER_BUFFER_MS,
  gopDropQueueBytes = DEFAULT_GOP_DROP_QUEUE_BYTES,
  separateAudio = false,
  audioArrivalTimeoutMs = AUDIO_ARRIVAL_TIMEOUT_MS,
  audioRetryCooldownMs = AUDIO_RETRY_COOLDOWN_MS,
  sourceClockCalibrationTimeoutMs = DEFAULT_SOURCE_CLOCK_CALIBRATION_TIMEOUT_MS,
  sourceClockCalibrationSpanMs = DEFAULT_SOURCE_CLOCK_CALIBRATION_SPAN_MS,
  getCapabilities,
  getAudioEnabled = () => true,
  isAudioWatchdogArmed = () => false,
  onEvent,
  spawnProcess = spawn,
}) {
  if (!Number.isFinite(timestampScaleMsPerUnit) ||
      timestampScaleMsPerUnit < 0.000001 || timestampScaleMsPerUnit > 1000) {
    throw new RangeError("timestampScaleMsPerUnit must be from 0.000001 to 1000");
  }
  if (!["transport", "wallclock"].includes(timestampMode)) {
    throw new RangeError("timestampMode must be transport or wallclock");
  }
  if (!["best-effort", "strict-arrival", "bounded-sync"].includes(syncMode)) {
    throw new RangeError(
      "syncMode must be best-effort, strict-arrival, or bounded-sync",
    );
  }
  const usesSharedSourceTimeline = syncMode !== "best-effort";
  if (usesSharedSourceTimeline && timestampMode !== "transport") {
    throw new RangeError(
      syncMode === "strict-arrival"
        ? "strict-arrival sync requires transport timestamps"
        : "synchronized playback requires transport timestamps",
    );
  }
  if (
    !Number.isInteger(syncToleranceMs) ||
    syncToleranceMs < 50 ||
    syncToleranceMs > 2500
  ) {
    throw new RangeError("syncToleranceMs must be an integer from 50 to 2500");
  }
  if (
    !Number.isInteger(syncHoldTimeoutMs) ||
    syncHoldTimeoutMs < 50 ||
    syncHoldTimeoutMs > 2500
  ) {
    throw new RangeError("syncHoldTimeoutMs must be an integer from 50 to 2500");
  }
  if (
    !Number.isInteger(syncScheduleAheadLimitMs) ||
    syncScheduleAheadLimitMs < 50 ||
    syncScheduleAheadLimitMs > 5000
  ) {
    throw new RangeError(
      "syncScheduleAheadLimitMs must be an integer from 50 to 5000",
    );
  }
  const maxSyncScheduleAheadMs = Math.max(
    syncToleranceMs,
    syncScheduleAheadLimitMs,
  );
  if (
    typeof getCapabilities !== "function" ||
    typeof getAudioEnabled !== "function" ||
    typeof isAudioWatchdogArmed !== "function" ||
    typeof onEvent !== "function"
  ) {
    throw new TypeError("RTSP media pipeline callbacks are required");
  }
  if (
    !Number.isInteger(jitterBufferMs) ||
    jitterBufferMs < 0 ||
    jitterBufferMs > MAX_JITTER_BUFFER_MS
  ) {
    throw new RangeError(
      `jitterBufferMs must be an integer from 0 to ${MAX_JITTER_BUFFER_MS}`,
    );
  }
  if (
    !Number.isInteger(gopDropQueueBytes) ||
    gopDropQueueBytes < 64 * 1024 ||
    gopDropQueueBytes > MAX_PIPE_QUEUE_BYTES
  ) {
    throw new RangeError(
      `gopDropQueueBytes must be an integer from ${64 * 1024} to ${MAX_PIPE_QUEUE_BYTES}`,
    );
  }
  if (
    !Number.isInteger(audioArrivalTimeoutMs) ||
    audioArrivalTimeoutMs < 50 ||
    audioArrivalTimeoutMs > 60_000
  ) {
    throw new RangeError(
      "audioArrivalTimeoutMs must be an integer from 50 to 60000",
    );
  }
  if (
    !Number.isInteger(audioRetryCooldownMs) ||
    audioRetryCooldownMs < 0 ||
    audioRetryCooldownMs > 3_600_000
  ) {
    throw new RangeError(
      "audioRetryCooldownMs must be an integer from 0 to 3600000",
    );
  }
  if (
    !Number.isInteger(sourceClockCalibrationTimeoutMs) ||
    sourceClockCalibrationTimeoutMs < 100 ||
    sourceClockCalibrationTimeoutMs > 10_000
  ) {
    throw new RangeError(
      "sourceClockCalibrationTimeoutMs must be an integer from 100 to 10000",
    );
  }
  if (
    !Number.isInteger(sourceClockCalibrationSpanMs) ||
    sourceClockCalibrationSpanMs < 10 ||
    sourceClockCalibrationSpanMs > sourceClockCalibrationTimeoutMs
  ) {
    throw new RangeError(
      "sourceClockCalibrationSpanMs must be an integer from 10 to sourceClockCalibrationTimeoutMs",
    );
  }

  const sharedAudioChannel = 1;
  const streams = new Map();
  const terminalClockOrigins = new Map();
  const terminalSyncStates = new Map();
  // Synchronized playback considers both videos and shared channel-1 audio.
  const strictSyncLanes = ["video-1", "video-2", "audio"];
  const reorderedVideoKeys = new Set();
  const strictSyncBlockedKeys = new Set();
  const temporaryVideoOnlyKeys = new Set();
  const timestampMonitors = new Map();
  // Chaves de fluxos (terminal+canal) cujo áudio foi solicitado, mas confirmado
  // ausente (nenhum pacote de áudio chegou dentro de AUDIO_ARRIVAL_TIMEOUT_MS),
  // mapeadas para o instante (ms) em que isso foi detectado. Usado para não
  // repetir a tentativa com áudio a cada reconexão imediata. Só é
  // consultado/alimentado quando isAudioWatchdogArmed(...) retorna true para o
  // fluxo, ou seja, apenas em cenários experimentais (ex.: forçar áudio em um
  // subfluxo que normalmente não o carrega). Fluxos principais mantêm vídeo
  // temporário até receber áudio, sem novas tentativas cegas após o cooldown.
  // Passado audioRetryCooldownMs, a entrada expira e uma nova tentativa de
  // áudio é feita automaticamente na próxima reconexão — evita que uma única
  // falha transitória (ex.: restart manual via botão de ressincronização)
  // desative o áudio até o processo/container reiniciar.
  const audioUnavailableKeys = new Map();

  function getTimestampMonitorLane(frame) {
    if (frame.kind === "video" && frame.channelNo === 1) {
      return "channel1Video";
    }
    if (frame.kind === "video" && frame.channelNo === 2) {
      return "channel2Video";
    }
    if (frame.kind === "audio" && frame.channelNo === sharedAudioChannel) {
      return "channel1Audio";
    }
    return null;
  }

  function createTimestampMonitorState() {
    return {
      startedAtMs: Date.now(),
      lastSampleAtMs: null,
      lastLoggedAtMs: null,
      hasCompleteSample: false,
      sampleCount: 0,
      lanes: Object.fromEntries(TIMESTAMP_MONITOR_LANES.map((lane) => [
        lane,
        {
          packetCount: 0,
          rawTimestamp: null,
          timestampNumberSafe: null,
          arrivalAtMs: null,
          firstRawTimestamp: null,
          firstArrivalAtMs: null,
          rawDelta: null,
          arrivalDeltaMs: null,
          rawUnitsPerSecond: null,
        },
      ])),
      samples: [],
    };
  }

  function getRawTimestampOffset(fromLane, toLane) {
    if (fromLane.rawTimestamp === null || toLane.rawTimestamp === null) {
      return null;
    }
    return (
      BigInt(toLane.rawTimestamp) - BigInt(fromLane.rawTimestamp)
    ).toString();
  }

  function createTimestampMonitorSample(state, sampledAtMs) {
    const lanes = getTimestampMonitorLaneStatuses(state, sampledAtMs);
    const channel1Video = state.lanes.channel1Video;
    return {
      sequence: state.sampleCount,
      sampledAt: new Date(sampledAtMs).toISOString(),
      complete: TIMESTAMP_MONITOR_LANES.every(
        (lane) => state.lanes[lane].rawTimestamp !== null,
      ),
      lanes,
      rawOffsetsFromChannel1Video: {
        channel2Video: getRawTimestampOffset(
          channel1Video,
          state.lanes.channel2Video,
        ),
        channel1Audio: getRawTimestampOffset(
          channel1Video,
          state.lanes.channel1Audio,
        ),
      },
    };
  }

  function getTimestampMonitorLaneStatuses(state, nowMs) {
    return Object.fromEntries(TIMESTAMP_MONITOR_LANES.map((name) => {
      const lane = state.lanes[name];
      const elapsedMs = lane.firstArrivalAtMs === null
        ? null : lane.arrivalAtMs - lane.firstArrivalAtMs;
      return [name, {
        packetCount: lane.packetCount,
        rawTimestamp: lane.rawTimestamp,
        timestampNumberSafe: lane.timestampNumberSafe,
        arrivalAt: lane.arrivalAtMs === null
          ? null : new Date(lane.arrivalAtMs).toISOString(),
        ageMs: lane.arrivalAtMs === null
          ? null : Math.max(0, nowMs - lane.arrivalAtMs),
        firstRawTimestamp: lane.firstRawTimestamp,
        rawDelta: lane.rawDelta,
        arrivalDeltaMs: lane.arrivalDeltaMs,
        elapsedMs,
        rawUnitsPerSecond: lane.rawUnitsPerSecond,
      }];
    }));
  }

  function recordTimestampMonitorFrame(frame, arrivalMs) {
    const laneName = getTimestampMonitorLane(frame);
    if (!laneName) {
      return;
    }
    const terminalKey = frame.terminalPhoneHex.toLowerCase();
    let monitor = timestampMonitors.get(terminalKey);
    if (!monitor) {
      monitor = createTimestampMonitorState();
      timestampMonitors.set(terminalKey, monitor);
    }

    const lane = monitor.lanes[laneName];
    const previousRawTimestamp = lane.rawTimestamp;
    const previousArrivalAtMs = lane.arrivalAtMs;
    const rawTimestamp = typeof frame.timestampRaw === "string"
      ? frame.timestampRaw
      : isValidTimestamp(frame.timestampMs)
        ? String(frame.timestampMs) : null;
    lane.packetCount += 1;
    lane.rawTimestamp = rawTimestamp;
    lane.timestampNumberSafe = isValidTimestamp(frame.timestampMs)
      ? Number.isSafeInteger(frame.timestampMs) : null;
    lane.arrivalAtMs = arrivalMs;
    lane.rawDelta = rawTimestamp === null || previousRawTimestamp === null
      ? null
      : (BigInt(rawTimestamp) - BigInt(previousRawTimestamp)).toString();
    lane.arrivalDeltaMs = previousArrivalAtMs === null
      ? null : arrivalMs - previousArrivalAtMs;
    if (rawTimestamp !== null) {
      lane.firstRawTimestamp ??= rawTimestamp;
      lane.firstArrivalAtMs ??= arrivalMs;
    }
    const elapsedMs = lane.firstArrivalAtMs === null
      ? 0 : arrivalMs - lane.firstArrivalAtMs;
    lane.rawUnitsPerSecond = elapsedMs > 0 &&
      lane.firstRawTimestamp !== null && rawTimestamp !== null
      ? Number(BigInt(rawTimestamp) - BigInt(lane.firstRawTimestamp)) *
        1000 / elapsedMs
      : null;
    if (!Number.isFinite(lane.rawUnitsPerSecond)) {
      lane.rawUnitsPerSecond = null;
    }

    const complete = TIMESTAMP_MONITOR_LANES.every(
      (name) => monitor.lanes[name].rawTimestamp !== null,
    );
    if (
      monitor.lastSampleAtMs !== null &&
      arrivalMs - monitor.lastSampleAtMs <
        TIMESTAMP_MONITOR_SAMPLE_INTERVAL_MS &&
      (!complete || monitor.hasCompleteSample)
    ) {
      return;
    }

    monitor.lastSampleAtMs = arrivalMs;
    monitor.sampleCount += 1;
    const sample = createTimestampMonitorSample(monitor, arrivalMs);
    monitor.samples.push(sample);
    if (monitor.samples.length > MAX_TIMESTAMP_MONITOR_SAMPLES) {
      monitor.samples.shift();
    }
    monitor.hasCompleteSample ||= complete;

    if (
      complete &&
      (monitor.lastLoggedAtMs === null ||
        arrivalMs - monitor.lastLoggedAtMs >= TIMESTAMP_MONITOR_LOG_INTERVAL_MS)
    ) {
      monitor.lastLoggedAtMs = arrivalMs;
      onEvent(
        "info",
        "rtsp-media-source-timestamp-monitor",
        "Amostra dos timestamps brutos JT1078 dos canais 1 e 2 e do áudio",
        getRtspStreamPath(frame.terminalPhoneHex, 1),
        {
          timestampSampleIntervalMs: TIMESTAMP_MONITOR_SAMPLE_INTERVAL_MS,
          timestampSampleRetention: MAX_TIMESTAMP_MONITOR_SAMPLES,
          timestampSample: sample,
        },
      );
    }
  }

  function getTimestampMonitorStatus(terminalPhoneHex) {
    const monitor = timestampMonitors.get(terminalPhoneHex.toLowerCase());
    if (!monitor) {
      return {
        sampleIntervalMs: TIMESTAMP_MONITOR_SAMPLE_INTERVAL_MS,
        sampleRetention: MAX_TIMESTAMP_MONITOR_SAMPLES,
        sampleCount: 0,
        startedAt: null,
        lastSampleAt: null,
        lanes: null,
        samples: [],
      };
    }
    const nowMs = Date.now();
    const latestSample = monitor.samples.at(-1);
    return {
      sampleIntervalMs: TIMESTAMP_MONITOR_SAMPLE_INTERVAL_MS,
      sampleRetention: MAX_TIMESTAMP_MONITOR_SAMPLES,
      sampleCount: monitor.sampleCount,
      startedAt: new Date(monitor.startedAtMs).toISOString(),
      lastSampleAt: latestSample?.sampledAt ?? null,
      lanes: getTimestampMonitorLaneStatuses(monitor, nowMs),
      rawOffsetsFromChannel1Video: {
        channel2Video: getRawTimestampOffset(
          monitor.lanes.channel1Video,
          monitor.lanes.channel2Video,
        ),
        channel1Audio: getRawTimestampOffset(
          monitor.lanes.channel1Video,
          monitor.lanes.channel1Audio,
        ),
      },
      samples: [...monitor.samples],
    };
  }

  function getStrictSyncLane(frame) {
    if (frame.kind === "audio" && frame.channelNo === sharedAudioChannel) {
      return "audio";
    }
    if (frame.kind === "video" && frame.channelNo === 1) {
      return "video-1";
    }
    if (frame.kind === "video" && frame.channelNo === 2) {
      return "video-2";
    }
    return null;
  }

  function getTerminalSyncState(terminalPhoneHex) {
    const key = terminalPhoneHex.toLowerCase();
    let state = terminalSyncStates.get(key);
    if (!state) {
      state = {
        status: "waiting",
        startedAtMs: Date.now(),
        holdStartedAtMs: null,
        holdTimer: null,
        fallbackCount: 0,
        lastFallbackDurationMs: null,
        arrivalFallbackBaseAtMs: null,
        arrivalFallbackMediaBaseMs: null,
        sourceTimestampBaseRaw: null,
        sourceWallBaseAtMs: null,
        sourceClockScaleMsPerUnit: timestampScaleMsPerUnit,
        sourceClockRateAnchorByLane: Object.fromEntries(
          strictSyncLanes.map((lane) => [lane, null]),
        ),
        sourceClockRateByLane: Object.fromEntries(
          strictSyncLanes.map((lane) => [lane, null]),
        ),
        sourceClockRateStabilityCountByLane: Object.fromEntries(
          strictSyncLanes.map((lane) => [lane, 0]),
        ),
        sourceClockRateSampleAtByLane: Object.fromEntries(
          strictSyncLanes.map((lane) => [lane, null]),
        ),
        sourceClockScaleUpdateCount: 0,
        lastArrivalAtByLane: Object.fromEntries(
          strictSyncLanes.map((lane) => [lane, null]),
        ),
        lastScheduledAtByLane: Object.fromEntries(
          strictSyncLanes.map((lane) => [lane, null]),
        ),
        lastRawTimestampByLane: Object.fromEntries(
          strictSyncLanes.map((lane) => [lane, null]),
        ),
        lastMediaTimestampMsByLane: Object.fromEntries(
          strictSyncLanes.map((lane) => [lane, null]),
        ),
        timestampOffsetMsByLane: Object.fromEntries(
          strictSyncLanes.map((lane) => [lane, 0]),
        ),
        timestampResetCountByLane: Object.fromEntries(
          strictSyncLanes.map((lane) => [lane, 0]),
        ),
        timestampAlignmentCountByLane: Object.fromEntries(
          strictSyncLanes.map((lane) => [lane, 0]),
        ),
        sourceTimelineShiftMs: 0,
        sourceTimelineRebaseCount: 0,
        lastSourceTimelineRebaseEventAtMs: null,
        lastSourceTimelineShiftDirection: null,
        lastSourceAlignmentEventAtByLane: Object.fromEntries(
          strictSyncLanes.map((lane) => [lane, null]),
        ),
        lastInvalidTimestampWarningAtByLane: Object.fromEntries(
          strictSyncLanes.map((lane) => [lane, null]),
        ),
        lastBacklogWarningAtByLane: Object.fromEntries(
          strictSyncLanes.map((lane) => [lane, null]),
        ),
      };
      terminalSyncStates.set(key, state);
    }
    return state;
  }

  function getRawSourceTimestamp(frame) {
    if (
      typeof frame.timestampRaw === "string" &&
      /^\d+$/.test(frame.timestampRaw)
    ) {
      return frame.timestampRaw;
    }
    return Number.isSafeInteger(frame.timestampMs) && frame.timestampMs >= 0
      ? String(frame.timestampMs)
      : null;
  }

  function getProjectedSourceTime(state, lane, arrivalMs) {
    const activeWindowMs = Math.max(
      audioArrivalTimeoutMs,
      jitterBufferMs + syncToleranceMs * 2,
    );
    const projectedTimes = strictSyncLanes
      .filter((candidate) => candidate !== lane)
      .flatMap((candidate) => {
        const mediaTimeMs = state.lastMediaTimestampMsByLane[candidate];
        const lastArrivalMs = state.lastArrivalAtByLane[candidate];
        if (
          mediaTimeMs === null ||
          lastArrivalMs === null ||
          arrivalMs - lastArrivalMs > activeWindowMs
        ) {
          return [];
        }
        return [mediaTimeMs + Math.max(0, arrivalMs - lastArrivalMs)];
      })
      .sort((left, right) => left - right);
    if (projectedTimes.length === 0) {
      return null;
    }
    const middleIndex = Math.floor(projectedTimes.length / 2);
    return projectedTimes.length % 2 === 0
      ? (projectedTimes[middleIndex - 1] + projectedTimes[middleIndex]) / 2
      : projectedTimes[middleIndex];
  }

  function updateStrictSourceClockScale(
    state,
    terminalPhoneHex,
    lane,
    rawTimestamp,
    arrivalMs,
  ) {
    let anchor = state.sourceClockRateAnchorByLane[lane];
    if (anchor === null) {
      state.sourceClockRateAnchorByLane[lane] = {
        rawTimestamp,
        arrivalMs,
      };
      return;
    }

    const elapsedMs = arrivalMs - anchor.arrivalMs;
    if (elapsedMs < STRICT_SOURCE_CLOCK_RATE_WINDOW_MS) {
      return;
    }

    const rawDelta = Number(
      BigInt(rawTimestamp) - BigInt(anchor.rawTimestamp),
    );
    state.sourceClockRateAnchorByLane[lane] = {
      rawTimestamp,
      arrivalMs,
    };
    if (!Number.isFinite(rawDelta) || rawDelta <= 0) {
      return;
    }

    const rate = rawDelta * 1000 / elapsedMs;
    const configuredRate = 1000 / timestampScaleMsPerUnit;
    if (
      !Number.isFinite(rate) ||
      rate < configuredRate * 0.5 ||
      rate > configuredRate * 1.5
    ) {
      return;
    }

    const previousRate = state.sourceClockRateByLane[lane];
    const previousSampleAtMs = state.sourceClockRateSampleAtByLane[lane];
    const stableWithPrevious =
      previousRate !== null &&
      previousSampleAtMs !== null &&
      arrivalMs - previousSampleAtMs <= STRICT_SOURCE_CLOCK_RATE_MAX_AGE_MS &&
      Math.abs(rate - previousRate) /
        ((rate + previousRate) / 2) <= STRICT_SOURCE_CLOCK_RATE_MAX_SPREAD;
    state.sourceClockRateStabilityCountByLane[lane] = stableWithPrevious
      ? state.sourceClockRateStabilityCountByLane[lane] + 1
      : 1;
    state.sourceClockRateByLane[lane] = rate;
    state.sourceClockRateSampleAtByLane[lane] = arrivalMs;
    const activeRates = strictSyncLanes.flatMap((candidate) => {
      const sampledAtMs = state.sourceClockRateSampleAtByLane[candidate];
      const candidateRate = state.sourceClockRateByLane[candidate];
      return sampledAtMs !== null &&
          arrivalMs - sampledAtMs <= STRICT_SOURCE_CLOCK_RATE_MAX_AGE_MS &&
          state.sourceClockRateStabilityCountByLane[candidate] >=
            STRICT_SOURCE_CLOCK_RATE_STABLE_WINDOWS &&
          Number.isFinite(candidateRate)
        ? [candidateRate]
        : [];
    }).sort((left, right) => left - right);
    if (activeRates.length < 2) {
      return;
    }

    const middleIndex = Math.floor(activeRates.length / 2);
    const medianRate = activeRates.length % 2 === 0
      ? (activeRates[middleIndex - 1] + activeRates[middleIndex]) / 2
      : activeRates[middleIndex];
    if ((activeRates.at(-1) - activeRates[0]) / medianRate >
        STRICT_SOURCE_CLOCK_RATE_MAX_SPREAD) {
      return;
    }

    const nextScaleMsPerUnit = 1000 / medianRate;
    const previousScaleMsPerUnit = state.sourceClockScaleMsPerUnit;
    if (
      Math.abs(nextScaleMsPerUnit - previousScaleMsPerUnit) /
        previousScaleMsPerUnit < 0.005
    ) {
      return;
    }

    const baseRaw = state.sourceTimestampBaseRaw;
    for (const candidate of strictSyncLanes) {
      const lastRawTimestamp = state.lastRawTimestampByLane[candidate];
      if (lastRawTimestamp === null || baseRaw === null) {
        continue;
      }
      const rawFromBase = Number(
        BigInt(lastRawTimestamp) - BigInt(baseRaw),
      );
      const previousMediaTimeMs =
        rawFromBase * previousScaleMsPerUnit +
        state.timestampOffsetMsByLane[candidate];
      state.timestampOffsetMsByLane[candidate] =
        previousMediaTimeMs - rawFromBase * nextScaleMsPerUnit;
    }
    state.sourceClockScaleMsPerUnit = nextScaleMsPerUnit;
    state.sourceClockScaleUpdateCount += 1;
    const terminalKey = terminalPhoneHex.toLowerCase();
    for (const stream of streams.values()) {
      if (stream.terminalPhoneHex === terminalKey) {
        stream.timing.timestampScaleMsPerUnit = nextScaleMsPerUnit;
      }
    }
    onEvent(
      "info",
      "rtsp-media-source-clock-rate-adjusted",
      "Escala do relógio JT1078 ajustada com a taxa estável compartilhada entre os canais",
      null,
      {
        timestampScaleMsPerUnit: nextScaleMsPerUnit,
        rawUnitsPerSecond: medianRate,
        laneRates: Object.fromEntries(
          strictSyncLanes.map((candidate) => [
            candidate,
            state.sourceClockRateByLane[candidate],
          ]),
        ),
        updateCount: state.sourceClockScaleUpdateCount,
      },
    );
  }

  function mapStrictSourceTimestamp(state, lane, frame, arrivalMs, stream) {
    const rawTimestamp = getRawSourceTimestamp(frame);
    if (syncMode === "bounded-sync" && state.status === "degraded") {
      if (rawTimestamp === null) {
        const lastWarningAtMs = state.lastInvalidTimestampWarningAtByLane[lane];
        if (
          lastWarningAtMs === null ||
          arrivalMs - lastWarningAtMs >= TIMESTAMP_MONITOR_SAMPLE_INTERVAL_MS
        ) {
          state.lastInvalidTimestampWarningAtByLane[lane] = arrivalMs;
          stream.timing.invalidTimestampFrames += 1;
          onEvent(
            "warn",
            "rtsp-media-source-timestamp-invalid",
            `Timestamp JT1078 ausente ou inválido; usando chegada local para ${lane}`,
            stream.path,
            { lane, timestampMs: frame.timestampMs ?? null },
          );
        }
      }
      state.arrivalFallbackBaseAtMs ??= arrivalMs;
      state.arrivalFallbackMediaBaseMs ??= Math.max(
        0,
        ...Object.values(state.lastMediaTimestampMsByLane)
          .filter(Number.isFinite),
      );
      const elapsedMs = Math.max(
        0,
        arrivalMs - state.arrivalFallbackBaseAtMs,
      );
      const mediaTimeMs = Math.max(
        state.lastMediaTimestampMsByLane[lane] ?? 0,
        state.arrivalFallbackMediaBaseMs + elapsedMs,
      );
      if (rawTimestamp !== null) {
        state.sourceTimestampBaseRaw ??= rawTimestamp;
        const rawFromBaseMs = Number(
          BigInt(rawTimestamp) - BigInt(state.sourceTimestampBaseRaw),
        ) * state.sourceClockScaleMsPerUnit;
        if (Number.isFinite(rawFromBaseMs)) {
          state.timestampOffsetMsByLane[lane] = mediaTimeMs - rawFromBaseMs;
        }
      }
      state.lastRawTimestampByLane[lane] = rawTimestamp;
      state.lastMediaTimestampMsByLane[lane] = mediaTimeMs;
      state.lastArrivalAtByLane[lane] = arrivalMs;
      state.lastScheduledAtByLane[lane] =
        state.sourceWallBaseAtMs + mediaTimeMs;
      return {
        mediaTimeMs,
        dueAt: state.sourceWallBaseAtMs + mediaTimeMs,
        arrivalFallback: true,
      };
    }
    if (rawTimestamp === null) {
      const lastWarningAtMs = state.lastInvalidTimestampWarningAtByLane[lane];
      if (
        lastWarningAtMs === null ||
        arrivalMs - lastWarningAtMs >= TIMESTAMP_MONITOR_SAMPLE_INTERVAL_MS
      ) {
        state.lastInvalidTimestampWarningAtByLane[lane] = arrivalMs;
        stream.timing.invalidTimestampFrames += 1;
        onEvent(
          "warn",
          "rtsp-media-source-timestamp-invalid",
          syncMode === "bounded-sync"
            ? `Timestamp JT1078 ausente ou inválido; usando chegada local para ${lane}`
            : `Timestamp JT1078 ausente ou inválido; aguardando uma amostra válida para ${lane}`,
          stream.path,
          { lane, timestampMs: frame.timestampMs ?? null },
        );
      }
      if (syncMode === "bounded-sync") {
        state.sourceWallBaseAtMs ??= arrivalMs + jitterBufferMs;
        state.arrivalFallbackBaseAtMs ??=
          state.sourceWallBaseAtMs - jitterBufferMs;
        const arrivalTimeMs = Math.max(
          0,
          arrivalMs - state.arrivalFallbackBaseAtMs,
        );
        const mediaTimeMs = Math.max(
          state.lastMediaTimestampMsByLane[lane] ?? 0,
          arrivalTimeMs,
        );
        state.lastArrivalAtByLane[lane] = arrivalMs;
        state.lastScheduledAtByLane[lane] =
          state.sourceWallBaseAtMs + mediaTimeMs;
        state.lastMediaTimestampMsByLane[lane] = mediaTimeMs;
        state.lastRawTimestampByLane[lane] = null;
        return {
          mediaTimeMs,
          dueAt: state.sourceWallBaseAtMs + mediaTimeMs,
          arrivalFallback: true,
        };
      }
      return null;
    }

    state.sourceTimestampBaseRaw ??= rawTimestamp;
    state.sourceWallBaseAtMs ??= arrivalMs + jitterBufferMs;
    updateStrictSourceClockScale(
      state,
      stream.terminalPhoneHex,
      lane,
      rawTimestamp,
      arrivalMs,
    );
    const rawFromBaseMs =
      Number(BigInt(rawTimestamp) - BigInt(state.sourceTimestampBaseRaw)) *
      state.sourceClockScaleMsPerUnit;
    if (!Number.isFinite(rawFromBaseMs)) {
      return null;
    }

    const previousRawTimestamp = state.lastRawTimestampByLane[lane];
    const previousMediaTimeMs = state.lastMediaTimestampMsByLane[lane];
    const previousArrivalAtMs = state.lastArrivalAtByLane[lane];
    let offsetMs = state.timestampOffsetMsByLane[lane];
    if (previousRawTimestamp !== null) {
      const rawDeltaMs =
        Number(BigInt(rawTimestamp) - BigInt(previousRawTimestamp)) *
        state.sourceClockScaleMsPerUnit;
      if (
        rawDeltaMs < -syncToleranceMs ||
        rawDeltaMs > MAX_SOURCE_CLOCK_STEP_MS
      ) {
        const projectedTimeMs = getProjectedSourceTime(
          state,
          lane,
          arrivalMs,
        );
        const targetTimeMs = projectedTimeMs ??
          (previousMediaTimeMs === null
            ? null
            : previousMediaTimeMs +
              Math.max(0, arrivalMs - (previousArrivalAtMs ?? arrivalMs)));
        if (targetTimeMs !== null) {
          offsetMs = targetTimeMs - rawFromBaseMs;
        }
        state.timestampOffsetMsByLane[lane] = offsetMs;
        state.timestampResetCountByLane[lane] += 1;
        onEvent(
          "warn",
          "rtsp-media-source-clock-reset",
          `Descontinuidade no timestamp JT1078 de ${lane}; relógio local rebaseado na linha do tempo compartilhada`,
          stream.path,
          {
            lane,
            previousRawTimestamp,
            rawTimestamp,
            rawDeltaMs,
            offsetMs,
            resetCount: state.timestampResetCountByLane[lane],
          },
        );
      }
    }

    const unalignedMediaTimeMs = rawFromBaseMs + offsetMs;
    let mediaTimeMs = unalignedMediaTimeMs;
    const projectedTimeMs = getProjectedSourceTime(state, lane, arrivalMs);
    if (
      projectedTimeMs !== null &&
      Math.abs(mediaTimeMs - projectedTimeMs) > syncToleranceMs
    ) {
      offsetMs = projectedTimeMs - rawFromBaseMs;
      state.timestampOffsetMsByLane[lane] = offsetMs;
      mediaTimeMs = projectedTimeMs;
      state.timestampAlignmentCountByLane[lane] += 1;
      const lastEventAtMs = state.lastSourceAlignmentEventAtByLane[lane];
      if (
        lastEventAtMs === null ||
        arrivalMs - lastEventAtMs >= TIMESTAMP_MONITOR_LOG_INTERVAL_MS
      ) {
        state.lastSourceAlignmentEventAtByLane[lane] = arrivalMs;
        onEvent(
          "warn",
          "rtsp-media-source-lane-realigned",
          `Desvio de timestamp acima da tolerância em ${lane}; alinhando a faixa às outras fontes ativas`,
          stream.path,
          {
            lane,
            rawTimestamp,
            previousMediaTimeMs: unalignedMediaTimeMs,
            projectedTimeMs,
            offsetMs,
            alignmentCount: state.timestampAlignmentCountByLane[lane],
          },
        );
      }
    }
    if (previousMediaTimeMs !== null && mediaTimeMs < previousMediaTimeMs) {
      mediaTimeMs = previousMediaTimeMs;
    }
    state.lastRawTimestampByLane[lane] = rawTimestamp;
    state.lastMediaTimestampMsByLane[lane] = mediaTimeMs;
    state.lastArrivalAtByLane[lane] = arrivalMs;
    return {
      mediaTimeMs,
      dueAt: state.sourceWallBaseAtMs + mediaTimeMs,
    };
  }

  function getStrictSyncReadiness(terminalPhoneHex, nowMs = Date.now()) {
    const state = terminalSyncStates.get(terminalPhoneHex.toLowerCase());
    if (!state) {
      return {
        ready: false,
        videoReady: false,
        audioUnavailable: false,
        missingLanes: [...strictSyncLanes],
        staleLanes: [],
        arrivalSkewMs: null,
        sourceTimestampSkewMs: null,
        sourceTimestampOffsetsMs: null,
        timestampResetCountByLane: null,
        timestampAlignmentCountByLane: null,
        sourceClockScaleMsPerUnit: null,
        sourceClockRateByLane: null,
        sourceClockScaleUpdateCount: null,
        sourceTimelineShiftMs: null,
        sourceTimelineRebaseCount: null,
        scheduledSkewMs: null,
        scheduleAheadMs: null,
        scheduleAheadLimitMs: null,
        clockAheadMs: null,
        videoArrivalSkewMs: null,
        videoSourceTimestampSkewMs: null,
        videoClockAheadMs: null,
      };
    }

    const getLaneMetrics = (lanes) => {
      const missingLanes = lanes.filter(
        (lane) => state.lastMediaTimestampMsByLane[lane] === null,
      );
      const staleLanes = lanes.filter((lane) => {
        const arrivalAtMs = state.lastArrivalAtByLane[lane];
        return arrivalAtMs !== null &&
          nowMs - arrivalAtMs > jitterBufferMs + syncToleranceMs;
      });
      const arrivalTimes = lanes.map(
        (lane) => state.lastArrivalAtByLane[lane],
      );
      const scheduledTimes = lanes.map(
        (lane) => state.lastScheduledAtByLane[lane],
      );
      const sourceTimes = lanes.map(
        (lane) => state.lastMediaTimestampMsByLane[lane],
      );
      const arrivalSkewMs = arrivalTimes.every(Number.isFinite)
        ? Math.max(...arrivalTimes) - Math.min(...arrivalTimes)
        : null;
      const sourceTimestampSkewMs = sourceTimes.every(Number.isFinite)
        ? Math.max(...sourceTimes) - Math.min(...sourceTimes)
        : null;
      const scheduledSkewMs = scheduledTimes.every(Number.isFinite)
        ? Math.max(...scheduledTimes) - Math.min(...scheduledTimes)
        : null;
      const scheduleAheadMs = Math.max(0, ...lanes.map((lane) => {
        const arrivalAtMs = state.lastArrivalAtByLane[lane];
        const scheduledAtMs = state.lastScheduledAtByLane[lane];
        return arrivalAtMs === null || scheduledAtMs === null
          ? 0
          : scheduledAtMs - arrivalAtMs - jitterBufferMs;
      }));
      return {
        missingLanes,
        staleLanes,
        arrivalSkewMs,
        sourceTimestampSkewMs,
        scheduledSkewMs,
        scheduleAheadMs,
      };
    };
    const getClockAheadMs = (includeAudio) => Math.max(0, ...streams.values()
      .filter((stream) =>
        stream.terminalPhoneHex === terminalPhoneHex.toLowerCase())
      .flatMap((stream) => {
        if (stream.mediaClock.originAtMs === null) {
          return [];
        }
        const timestamps = stream.channelNo === 1 || stream.channelNo === 2
          ? [stream.mediaClock.lastVideo90k]
          : [];
        if (includeAudio && stream.channelNo === sharedAudioChannel) {
          timestamps.push(
            stream.mediaClock.nextAudio90k ??
              stream.mediaClock.lastAudio90k,
          );
        }
        return timestamps
          .filter(Number.isFinite)
          .map((timestamp90k) =>
            stream.mediaClock.originAtMs +
              (timestamp90k - 90_000) / 90 - nowMs);
      }));
    const fullMetrics = getLaneMetrics(strictSyncLanes);
    const videoMetrics = getLaneMetrics(["video-1", "video-2"]);
    const clockAheadMs = getClockAheadMs(true);
    const videoClockAheadMs = getClockAheadMs(false);
    const audioArrivalAtMs = state.lastArrivalAtByLane.audio ??
      state.startedAtMs;
    const audioUnavailable =
      nowMs - audioArrivalAtMs >= audioArrivalTimeoutMs;

    return {
      ready: fullMetrics.missingLanes.length === 0 &&
        fullMetrics.staleLanes.length === 0 &&
        fullMetrics.sourceTimestampSkewMs <= syncToleranceMs,
      videoReady: videoMetrics.missingLanes.length === 0 &&
        videoMetrics.staleLanes.length === 0 &&
        videoMetrics.sourceTimestampSkewMs <= syncToleranceMs,
      audioUnavailable,
      missingLanes: fullMetrics.missingLanes,
      staleLanes: fullMetrics.staleLanes,
      arrivalSkewMs: fullMetrics.arrivalSkewMs,
      sourceTimestampSkewMs: fullMetrics.sourceTimestampSkewMs,
      sourceTimestampOffsetsMs: { ...state.timestampOffsetMsByLane },
      timestampResetCountByLane: { ...state.timestampResetCountByLane },
      timestampAlignmentCountByLane: {
        ...state.timestampAlignmentCountByLane,
      },
      sourceClockScaleMsPerUnit: state.sourceClockScaleMsPerUnit,
      sourceClockRateByLane: { ...state.sourceClockRateByLane },
      sourceClockScaleUpdateCount: state.sourceClockScaleUpdateCount,
      sourceTimelineShiftMs: state.sourceTimelineShiftMs,
      sourceTimelineRebaseCount: state.sourceTimelineRebaseCount,
      scheduledSkewMs: fullMetrics.scheduledSkewMs,
      scheduleAheadMs: fullMetrics.scheduleAheadMs,
      scheduleAheadLimitMs: maxSyncScheduleAheadMs,
      clockAheadMs,
      videoArrivalSkewMs: videoMetrics.arrivalSkewMs,
      videoSourceTimestampSkewMs: videoMetrics.sourceTimestampSkewMs,
      videoClockAheadMs,
    };
  }

  function clearTerminalScheduleQueues(terminalPhoneHex) {
    let discardedFrames = 0;
    const terminalKey = terminalPhoneHex.toLowerCase();
    for (const candidate of streams.values()) {
      if (candidate.terminalPhoneHex !== terminalKey) {
        continue;
      }
      const timing = candidate.timing;
      clearTimeout(timing.timer);
      timing.timer = null;
      timing.timerDueAt = null;
      discardedFrames += timing.queue.length;
      timing.lateFrames += timing.queue.length;
      timing.queue = [];
      timing.lastScheduledAtByKind = { audio: null, video: null };
      if (candidate.channelNo === 1 || candidate.channelNo === 2) {
        candidate.syncDropUntilKeyFrame = true;
      }
    }
    const state = terminalSyncStates.get(terminalKey);
    if (state) {
      state.lastScheduledAtByLane = Object.fromEntries(
        strictSyncLanes.map((lane) => [lane, null]),
      );
    }
    return discardedFrames;
  }

  function resumeTerminalScheduleQueues(terminalPhoneHex) {
    const terminalKey = terminalPhoneHex.toLowerCase();
    for (const candidate of streams.values()) {
      if (candidate.terminalPhoneHex === terminalKey) {
        scheduleNextSourceTimestampFrame(candidate);
      }
    }
  }

  function markSyncAligned(stream, state, readiness) {
    const previousStatus = state.status;
    if (previousStatus === "aligned") {
      return;
    }
    clearTimeout(state.holdTimer);
    state.holdTimer = null;
    state.status = "aligned";
    state.holdStartedAtMs = null;
    onEvent(
      "info",
      "rtsp-media-sync-resumed",
      "Vídeo dos canais 1 e 2 e áudio alinhados pelos timestamps JT1078",
      stream.path,
      { ...readiness, toleranceMs: syncToleranceMs },
    );
    resumeTerminalScheduleQueues(stream.terminalPhoneHex);
  }

  function enterBoundedSyncFallback(stream, state, readiness, nowMs) {
    if (state.status === "degraded") {
      return;
    }
    const holdDurationMs = state.holdStartedAtMs === null
      ? 0
      : Math.max(0, nowMs - state.holdStartedAtMs);
    clearTimeout(state.holdTimer);
    state.holdTimer = null;
    state.status = "degraded";
    state.fallbackCount += 1;
    state.lastFallbackDurationMs = holdDurationMs;
    state.arrivalFallbackBaseAtMs = nowMs;
    state.arrivalFallbackMediaBaseMs = Math.max(
      0,
      ...Object.values(state.lastMediaTimestampMsByLane).filter(Number.isFinite),
    );
    state.sourceWallBaseAtMs = nowMs + jitterBufferMs -
      state.arrivalFallbackMediaBaseMs;
    const discardedFrames = clearTerminalScheduleQueues(
      stream.terminalPhoneHex,
    );
    onEvent(
      "warn",
      "rtsp-media-sync-fallback",
      "Tolerância de espera atingida; liberando as três saídas até a sincronização voltar",
      stream.path,
      {
        holdDurationMs,
        holdTimeoutMs: syncHoldTimeoutMs,
        fallbackCount: state.fallbackCount,
        discardedFrames,
        ...readiness,
      },
    );
  }

  function startSyncHold(stream, state, readiness, nowMs) {
    if (state.status === "holding" || state.status === "degraded") {
      return;
    }
    const previousStatus = state.status;
    state.status = "holding";
    state.holdStartedAtMs = nowMs;
    if (syncMode === "bounded-sync") {
      state.holdTimer = setTimeout(() => {
        state.holdTimer = null;
        if (state.status !== "holding") {
          return;
        }
        const currentTimeMs = Date.now();
        const currentReadiness = getStrictSyncReadiness(
          stream.terminalPhoneHex,
          currentTimeMs,
        );
        if (
          currentReadiness.ready &&
          currentReadiness.scheduleAheadMs <= maxSyncScheduleAheadMs
        ) {
          markSyncAligned(
            stream,
            state,
            currentReadiness,
          );
          return;
        }
        enterBoundedSyncFallback(
          stream,
          state,
          currentReadiness,
          currentTimeMs,
        );
      }, Math.max(
        0,
        syncHoldTimeoutMs -
          Math.min(
            SYNC_HOLD_TIMER_SAFETY_MARGIN_MS,
            syncHoldTimeoutMs * 0.1,
          ),
      ));
      state.holdTimer.unref?.();
    }
    onEvent(
      previousStatus === "aligned" ? "warn" : "info",
      "rtsp-media-sync-hold",
      "Aguardando vídeo dos canais 1 e 2 e áudio compartilhado dentro da tolerância; saídas mantidas em espera",
      stream.path,
      { ...readiness, toleranceMs: syncToleranceMs, jitterBufferMs },
    );
  }

  function updateSyncStateOnInput(stream, dueAt, arrivalMs) {
    const state = getTerminalSyncState(stream.terminalPhoneHex);
    const readiness = getStrictSyncReadiness(
      stream.terminalPhoneHex,
      arrivalMs,
    );
    if (!readiness.ready) {
      startSyncHold(stream, state, readiness, arrivalMs);
    } else if (state.status === "holding" && syncMode === "bounded-sync") {
      const inputScheduleAheadMs = Math.max(
        0,
        dueAt - arrivalMs - jitterBufferMs,
      );
      if (
        Math.max(readiness.scheduleAheadMs ?? 0, inputScheduleAheadMs) <=
          maxSyncScheduleAheadMs
      ) {
        markSyncAligned(stream, state, readiness);
      }
    }
    return dueAt;
  }

  function allowStrictSyncFrame(stream, frame, nowMs) {
    if (getStrictSyncLane(frame) === null) {
      return true;
    }
    const state = getTerminalSyncState(stream.terminalPhoneHex);
    const readiness = getStrictSyncReadiness(stream.terminalPhoneHex, nowMs);
    if (!readiness.ready) {
      if (state.status !== "holding" && state.status !== "degraded") {
        startSyncHold(stream, state, readiness, nowMs);
      }
      if (
        frame.kind === "video" &&
        state.status !== "degraded" &&
        syncMode !== "bounded-sync"
      ) {
        stream.syncDropUntilKeyFrame = true;
      }
      const holdDurationMs = state.holdStartedAtMs === null
        ? 0
        : nowMs - state.holdStartedAtMs;
      if (
        syncMode !== "bounded-sync" ||
        holdDurationMs < syncHoldTimeoutMs
      ) {
        return false;
      }
      enterBoundedSyncFallback(
        stream,
        state,
        readiness,
        nowMs,
      );
    } else {
      markSyncAligned(stream, state, readiness);
    }

    if (frame.kind === "video" && stream.syncDropUntilKeyFrame) {
      const isKeyFrame = frame.dataType === undefined || frame.dataType === 0;
      if (!isKeyFrame) {
        return false;
      }
      stream.syncDropUntilKeyFrame = false;
    }
    return true;
  }

  function getSyncStatus(terminalPhoneHex) {
    if (!usesSharedSourceTimeline) {
      return {
        mode: syncMode,
        state: "not-enforced",
        toleranceMs: syncToleranceMs,
        arrivalSkewMs: null,
        sourceTimestampSkewMs: null,
        sourceTimestampOffsetsMs: null,
        timestampResetCountByLane: null,
        timestampAlignmentCountByLane: null,
        sourceClockScaleMsPerUnit: null,
        sourceClockRateByLane: null,
        sourceClockScaleUpdateCount: null,
        sourceTimelineShiftMs: null,
        sourceTimelineRebaseCount: null,
        scheduledSkewMs: null,
        scheduleAheadMs: null,
        scheduleAheadLimitMs: null,
        clockAheadMs: null,
        audioUnavailable: false,
        holdDurationMs: null,
        holdTimeoutMs: null,
        fallbackCount: 0,
        lastFallbackDurationMs: null,
        videoArrivalSkewMs: null,
        videoSourceTimestampSkewMs: null,
        videoClockAheadMs: null,
        missingLanes: [],
        staleLanes: [],
      };
    }
    const readiness = getStrictSyncReadiness(terminalPhoneHex);
    const terminalState =
      terminalSyncStates.get(terminalPhoneHex.toLowerCase());
    return {
      mode: syncMode,
      state: readiness.ready && terminalState?.status === "aligned"
        ? "aligned"
        : terminalState?.status === "degraded"
          ? "degraded"
          : "holding",
      toleranceMs: syncToleranceMs,
      holdDurationMs: terminalState?.status !== "holding" ||
          terminalState.holdStartedAtMs === null
        ? null
        : Math.max(0, Date.now() - terminalState.holdStartedAtMs),
      holdTimeoutMs: syncMode === "bounded-sync" ? syncHoldTimeoutMs : null,
      fallbackCount: terminalState?.fallbackCount ?? 0,
      lastFallbackDurationMs: terminalState?.lastFallbackDurationMs ?? null,
      arrivalSkewMs: readiness.arrivalSkewMs,
      sourceTimestampSkewMs: readiness.sourceTimestampSkewMs,
      sourceTimestampOffsetsMs: readiness.sourceTimestampOffsetsMs,
      timestampResetCountByLane: readiness.timestampResetCountByLane,
      timestampAlignmentCountByLane:
        readiness.timestampAlignmentCountByLane,
      sourceClockScaleMsPerUnit: readiness.sourceClockScaleMsPerUnit,
      sourceClockRateByLane: readiness.sourceClockRateByLane,
      sourceClockScaleUpdateCount: readiness.sourceClockScaleUpdateCount,
      sourceTimelineShiftMs: readiness.sourceTimelineShiftMs,
      sourceTimelineRebaseCount: readiness.sourceTimelineRebaseCount,
      scheduledSkewMs: readiness.scheduledSkewMs,
      scheduleAheadMs: readiness.scheduleAheadMs,
      scheduleAheadLimitMs: maxSyncScheduleAheadMs,
      clockAheadMs: readiness.clockAheadMs,
      audioUnavailable: readiness.audioUnavailable,
      videoArrivalSkewMs: readiness.videoArrivalSkewMs,
      videoSourceTimestampSkewMs: readiness.videoSourceTimestampSkewMs,
      videoClockAheadMs: readiness.videoClockAheadMs,
      missingLanes: readiness.missingLanes,
      staleLanes: readiness.staleLanes,
    };
  }

  function isAudioBlocked(key) {
    const disabledAtMs = audioUnavailableKeys.get(key);
    if (disabledAtMs === undefined) {
      return false;
    }
    if (Date.now() - disabledAtMs >= audioRetryCooldownMs) {
      audioUnavailableKeys.delete(key);
      return false;
    }
    return true;
  }

  function isAudioRequested(terminalPhoneHex, channelNo) {
    return (!separateAudio || channelNo === sharedAudioChannel) &&
      getAudioEnabled(terminalPhoneHex, channelNo);
  }

  function pushFrame(frame, replay = false) {
    if (!enabled) {
      return;
    }
    if (separateAudio && frame.kind === "audio" &&
        frame.channelNo !== sharedAudioChannel) {
      return;
    }
    const key = getStreamKey(frame.terminalPhoneHex, frame.channelNo);
    let stream = streams.get(key);
    if (usesSharedSourceTimeline && strictSyncBlockedKeys.has(key)) {
      return;
    }
    if (
      usesSharedSourceTimeline &&
      frame.kind === "video" &&
      frame.dataType === 2
    ) {
      strictSyncBlockedKeys.add(key);
      const syncState = getTerminalSyncState(frame.terminalPhoneHex);
      const lane = getStrictSyncLane(frame);
      if (lane) {
        syncState.lastArrivalAtByLane[lane] = null;
        syncState.lastScheduledAtByLane[lane] = null;
        syncState.lastRawTimestampByLane[lane] = null;
        syncState.lastMediaTimestampMsByLane[lane] = null;
      }
      if (stream && !["stopped", "error"].includes(stream.status)) {
        failStream(
          stream,
          "Quadros B detectados; a sincronização estrita exige timestamps de transporte sem reordenação",
        );
      }
      onEvent(
        "error",
        "rtsp-media-sync-unsupported-bframes",
        "Sincronização estrita suspensa: quadros B exigem suporte de timestamps de decodificação",
        stream?.path ?? getRtspStreamPath(frame.terminalPhoneHex, frame.channelNo),
        { channelNo: frame.channelNo },
      );
      return;
    }
    if ((!separateAudio || frame.channelNo !== sharedAudioChannel) &&
        stream && frame.kind === "video" &&
        (frame.dataType === undefined || frame.dataType === 0) &&
        stream.audioRequested && !stream.audioEnabled && stream.pendingAudioFrame &&
        Date.now() - stream.pendingAudioReceivedAtMs < 5_000 &&
        !["stopped", "error"].includes(stream.status)) {
      const audioFrame = stream.pendingAudioFrame;
      stream.status = "stopped";
      stopChild(stream);
      streams.delete(key);
      temporaryVideoOnlyKeys.delete(key);
      audioUnavailableKeys.delete(key);
      onEvent(
        "info", "rtsp-media-audio-restoring",
        "Audio recebido; incorporando-o no proximo quadro-chave deste canal",
        stream.path,
      );
      pushFrame(audioFrame);
      pushFrame(frame);
      return;
    }
    if (timestampMode === "transport" && frame.kind === "video" && frame.dataType === 2) {
      reorderedVideoKeys.add(key);
      if (stream?.timestampMode === "transport" && stream.child &&
          !["error", "stopped"].includes(stream.status)) {
        failStream(stream, "Video com B-frames detectado; reiniciando este canal no modo wallclock para preservar a reordenacao");
        return;
      }
    }
    let consecutiveFailures = stream?.consecutiveFailures ?? 0;
    if (stream?.status === "stopped") {
      streams.delete(key);
      stream = undefined;
    }
    if (stream?.status === "error") {
      if (Date.now() < stream.retryAtMs) {
        return;
      }
      consecutiveFailures = stream.consecutiveFailures;
      onEvent(
        "warn",
        "rtsp-media-auto-restart",
        `Reiniciando publicação ${stream.path} após falha: ${stream.error}`,
        stream.path,
      );
      streams.delete(key);
      stream = undefined;
    }
    if (!stream) {
      const audioRequested = isAudioRequested(
        frame.terminalPhoneHex,
        frame.channelNo,
      );
      const audioWatchdogArmed = Boolean(
        isAudioWatchdogArmed(frame.terminalPhoneHex, frame.channelNo),
      );
      const timing = createTimingState(jitterBufferMs);
      if (usesSharedSourceTimeline) {
        timing.mode = "source-timestamp";
        timing.syncClockScope = "terminal-strict-source-timestamp";
        timing.timestampScaleMsPerUnit = timestampScaleMsPerUnit;
      }
      stream = {
        key,
        terminalPhoneHex: frame.terminalPhoneHex.toLowerCase(),
        channelNo: frame.channelNo,
        path: getRtspStreamPath(frame.terminalPhoneHex, frame.channelNo),
        status: "waiting",
        timestampMode: reorderedVideoKeys.has(key) ? "wallclock" : timestampMode,
        audioRequested,
        audioEnabled:
          audioRequested &&
          (audioWatchdogArmed || frame.kind === "audio") &&
          !temporaryVideoOnlyKeys.has(key) &&
          !(audioWatchdogArmed && isAudioBlocked(key)),
        audioWatchdogArmed,
        audioConfirmed: false,
        pendingAudioFrame: null,
        pendingAudioReceivedAtMs: null,
        audioArrivalTimer: null,
        terminationRequested: false,
        childClosed: false,
        child: null,
        audioChild: null,
        audioPublisherStatus: "waiting",
        audioPublisherError: null,
        audioPublisherRetryAtMs: 0,
        audioPublisherFailures: 0,
        videoInput: null,
        audioInput: null,
        videoFrames: 0,
        audioFrames: 0,
        transportWriters: null,
        mediaClock: {
          syncClockScope: syncMode === "bounded-sync"
            ? "terminal-bounded-source-timestamp"
            : syncMode === "strict-arrival"
              ? "terminal-strict-source-timestamp" : null,
          originAtMs: null,
          lastVideo90k: null,
          nextAudio90k: null,
          lastAudio90k: null,
          corrections: 0,
        },
        videoDiagnostics: createVideoDiagnostics(),
        audioDiagnostics: createAudioDiagnostics(),
        ffmpegDiagnostics: createFfmpegDiagnostics(),
        outputProgress: {
          frames: 0,
          outTimeUs: null,
          speed: null,
          lastReportAtMs: null,
          lastVideoAdvanceAtMs: null,
          lastTimeAdvanceAtMs: null,
          reports: 0,
        },
        progressRemainder: "",
        progressValues: {},
        diagnosticsTimer: null,
        pipeQueues: { audio: [], video: [] },
        pipeQueueBytes: 0,
        trimVideoOnKeyFrame: false,
        syncDropUntilKeyFrame: false,
        pipeBlocked: { audio: false, video: false },
        pipeDiagnostics: {
          audio: createPipeDiagnostics(),
          video: createPipeDiagnostics(),
        },
        stderrRemainder: "",
        error: null,
        consecutiveFailures,
        retryAtMs: 0,
        timing,
      };
      streams.set(key, stream);
    }
    stream.lastFrameIntervalMs = frame.lastFrameIntervalMs;
    if (stream.status === "error") {
      return;
    }
    if (frame.kind === "audio") {
      if (!replay) {
        recordAudioPayloadDiagnostics(stream.audioDiagnostics, frame.body);
      }
      if (!stream.audioConfirmed) {
        stream.audioConfirmed = true;
        if (stream.audioArrivalTimer) {
          clearTimeout(stream.audioArrivalTimer);
          stream.audioArrivalTimer = null;
        }
      }
      if (!stream.audioEnabled) {
        if (stream.audioRequested) {
          try {
            if (stream.capabilities) {
              addAacAdtsHeader(frame.body, stream.audioSampleRate, stream.capabilities.audioChannels);
            } else if (inspectAacAdtsHeader(frame.body)?.valid === false) {
              throw new Error("AAC payload contains an invalid ADTS header");
            }
          } catch (error) {
            onEvent("error", "rtsp-media-invalid-audio", `Audio recebido invalido: ${error.message}`, stream.path);
            return;
          }
          const separateAudioPublisher =
            separateAudio && stream.channelNo === sharedAudioChannel &&
            stream.child;
          if (separateAudioPublisher &&
              Date.now() >= stream.audioPublisherRetryAtMs) {
            stream.audioEnabled = true;
            stream.audioConfirmed = true;
            stream.pendingAudioFrame = null;
            temporaryVideoOnlyKeys.delete(stream.key);
            audioUnavailableKeys.delete(stream.key);
            if (stream.timestampMode === "transport") {
              stream.transportWriters.audio ??= createMpegTsWriter("aac");
            }
            startAudioPublisher(stream, stream.capabilities);
          } else {
            stream.pendingAudioFrame = frame;
            stream.pendingAudioReceivedAtMs = Date.now();
            if (!stream.child && !stream.audioWatchdogArmed) {
              stream.audioEnabled = true;
            }
          }
          if (!stream.audioEnabled) {
            return;
          }
        }
        if (!stream.audioEnabled) {
          return;
        }
      }
    } else {
      recordVideoPayloadDiagnostics(
        stream.videoDiagnostics,
        frame.body,
        frame.dataType,
      );
    }
    const arrivalMs = Date.now();
    recordTimestampMonitorFrame(frame, arrivalMs);
    const terminalKey = frame.terminalPhoneHex.toLowerCase();
    if (!terminalClockOrigins.has(terminalKey)) {
      terminalClockOrigins.set(terminalKey, arrivalMs);
    }
    const scheduledFrame = { frame, arrivalMs, sequence: ++stream.timing.sequence };
    recordFrameTiming(
      stream.timing,
      frame,
      arrivalMs,
      sourceClockCalibrationSpanMs,
      timestampScaleMsPerUnit,
    );
    if (frame.kind === "audio" && stream.child && stream.audioEnabled) {
      armAudioArrivalTimer(stream);
    }
    const isVideoKeyFrame =
      frame.kind === "video" &&
      (frame.dataType === undefined || frame.dataType === 0);
    if (!stream.child && !isVideoKeyFrame) {
      if (frame.kind === "audio") {
        stream.pendingAudioFrame = frame;
        stream.pendingAudioReceivedAtMs = arrivalMs;
      }
      return;
    }

    let capabilities = stream.capabilities;
    if (!stream.child) {
      if (stream.pendingAudioFrame &&
          arrivalMs - stream.pendingAudioReceivedAtMs >= 5_000) {
        stream.pendingAudioFrame = null;
        stream.audioConfirmed = false;
      }
      if (!capabilities) {
        capabilities = getCapabilities(frame.terminalPhoneHex);
      }
      // Fallback: se as capacidades ainda não estão disponíveis, usa valores padrão
      // H.264 + AAC 48kHz para garantir compatibilidade com a maioria dos terminais
      const hasCapabilities = capabilities && capabilities.videoEncoding != null;
      if (!hasCapabilities) {
        capabilities = {
          videoEncoding: 99, // H.264 (padrão mais comum)
          videoProfile: 0,
          audioEncoding: 19, // AAC (padrão mais comum)
          audioChannels: 1,
          audioSampleRate: 3, // 48000 Hz
          maxVideoChannels: 2,
        };
        onEvent(
          "info",
          "rtsp-media-default-capabilities",
          `Capacidades padrão assumidas para ${frame.terminalPhoneHex} (H.264/AAC 48kHz)`,
          getStreamKey(frame.terminalPhoneHex, frame.channelNo),
        );
      }
      const videoFormat = VIDEO_FORMAT_BY_ENCODING.get(
        capabilities.videoEncoding,
      );
      if (!videoFormat) {
        failStream(
          stream,
          `Codec de vídeo ${capabilities.videoEncoding} não suportado pelo conversor`,
        );
        return;
      }
      if (capabilities.audioEncoding !== 19 && capabilities.audioEncoding !== 24) {
        failStream(
          stream,
          `Codec de áudio ${capabilities.audioEncoding} não suportado pelo conversor`,
        );
        return;
      }
      const sampleRate = AAC_SAMPLE_RATE.get(capabilities.audioSampleRate);
      if (!sampleRate) {
        failStream(
          stream,
          `Taxa de amostragem AAC ${capabilities.audioSampleRate} não suportada`,
        );
        return;
      }
      stream.capabilities = capabilities;
      stream.audioSampleRate = sampleRate;
      stream.audioDiagnostics.audioEncoding = capabilities.audioEncoding;
      stream.audioDiagnostics.audioChannels = capabilities.audioChannels;
      stream.audioDiagnostics.audioSampleRateHz = sampleRate;
      startPublisher(stream, capabilities, videoFormat);
      if (stream.status === "error") {
        return;
      }
      if (stream.pendingAudioFrame) {
        const audioFrame = stream.pendingAudioFrame;
        stream.pendingAudioFrame = null;
        pushFrame(audioFrame, true);
      }
    }

    if (usesSharedSourceTimeline) {
      scheduleStrictSourceTimestampFrame(stream, scheduledFrame);
      return;
    }

    if (stream.timing.mode === "source-timestamp") {
      scheduleSourceTimestampFrame(stream, scheduledFrame);
      return;
    }

    if (stream.timing.mode === "arrival-fallback") {
      if (usesSharedSourceTimeline) {
        const lane = getStrictSyncLane(frame);
        if (lane) {
          getTerminalSyncState(terminalKey).lastArrivalAtByLane[lane] = arrivalMs;
        }
      }
      scheduleArrivalClockFrame(stream, scheduledFrame);
      return;
    }

    stream.timing.startupFrames.push(scheduledFrame);
    if (!stream.timing.calibrationTimer) {
      stream.timing.calibrationTimer = setTimeout(() => {
        useArrivalClockFallback(stream);
      }, sourceClockCalibrationTimeoutMs);
      stream.timing.calibrationTimer.unref?.();
    }
    const timestampScale = stream.timing.scaleSamples.length >= 2
      ? timestampScaleMsPerUnit : null;
    if (timestampScale !== null && stream.timing.startupFrames.length > 0) {
      startSourceTimestampClock(stream, timestampScale);
      return;
    }

    if (
      arrivalMs - stream.timing.startedAtMs >=
        sourceClockCalibrationTimeoutMs ||
      stream.timing.startupFrames.length >= MAX_STARTUP_FRAMES
    ) {
      useArrivalClockFallback(stream);
      return;
    }
  }

  function writeFrame(stream, frame, dueAt) {
    const isKeyFrame = frame.kind === "video" &&
      (frame.dataType === undefined || frame.dataType === 0);
    if (
      usesSharedSourceTimeline &&
      !allowStrictSyncFrame(stream, frame, Date.now())
    ) {
      return;
    }
    let payload;
    let timestamp90k = null;
    try {
      payload =
        frame.kind === "video"
          ? toAnnexB(frame.body)
          : addAacAdtsHeader(
              frame.body,
              stream.audioSampleRate,
              stream.capabilities.audioChannels,
            );
      if (stream.timestampMode === "transport") {
        const clock = stream.mediaClock;
        clock.originAtMs ??=
          terminalClockOrigins.get(stream.terminalPhoneHex) ?? dueAt;
        clock.syncClockScope = syncMode === "bounded-sync"
          ? "terminal-bounded-source-transport"
          : syncMode === "strict-arrival"
            ? "terminal-strict-source-transport"
            : "terminal-shared-transport";
        const proposed90k = 90_000 + Math.round((dueAt - clock.originAtMs) * 90);
        if (frame.kind === "audio") {
          const header = inspectAacAdtsHeader(payload);
          if (!header?.valid) {
            throw new Error("AAC transport requires a valid ADTS frame");
          }
          // Sample duration, not pipe-read time, defines the continuous AAC clock.
          timestamp90k = clock.nextAudio90k ?? Math.max(90_000, proposed90k);
          if (proposed90k - timestamp90k > 22_500) {
            timestamp90k = proposed90k;
            clock.corrections += 1;
            onEvent(
              "warn", "rtsp-media-timestamp-correction",
              "Lacuna de audio superior a 250 ms preservada no transporte",
              stream.path, { proposed90k, nextAudio90k: clock.nextAudio90k },
            );
          }
          clock.lastAudio90k = Math.round(timestamp90k);
          clock.nextAudio90k =
            timestamp90k + header.rawDataBlocks * 1024 * 90_000 / header.sampleRateHz;
          timestamp90k = clock.lastAudio90k;
        } else {
          timestamp90k = Math.max(90_000, proposed90k);
          if (clock.lastVideo90k !== null && timestamp90k <= clock.lastVideo90k) {
            timestamp90k = clock.lastVideo90k +
              Math.max(1, Math.round(getFallbackFrameIntervalMs(stream, frame) * 90));
            clock.corrections += 1;
            onEvent(
              "warn", "rtsp-media-timestamp-correction",
              "Timestamp de vídeo repetido/regressivo corrigido antes do FFmpeg",
              stream.path, { proposed90k, timestamp90k },
            );
          }
          clock.lastVideo90k = timestamp90k;
        }
      }
    } catch (error) {
      failStream(stream, `Quadro ${frame.kind} inválido: ${error.message}`);
      return;
    }
    const input = frame.kind === "video" ? stream.videoInput : stream.audioInput;
    if (!input || input.destroyed || !input.writable) {
      return;
    }

    if (stream.pipeBlocked[frame.kind]) {
      enqueuePipePayload(
        stream,
        frame.kind,
        payload,
        isKeyFrame,
        timestamp90k,
      );
      return;
    }

    writePipePayload(stream, frame.kind, payload, timestamp90k, isKeyFrame);
  }

  function writePipePayload(stream, kind, payload, timestamp90k, isKeyFrame) {
    const input = kind === "video" ? stream.videoInput : stream.audioInput;
    if (
      !input ||
      input.destroyed ||
      !input.writable ||
      stream.status === "stopped" ||
      stream.status === "error"
    ) {
      return;
    }

    let encodedPayload = payload;
    if (stream.timestampMode === "transport") {
      try {
        encodedPayload = stream.transportWriters[kind].write(payload, timestamp90k, {
          keyFrame: isKeyFrame,
        });
      } catch (error) {
        failStream(stream, `Erro no transporte MPEG-TS: ${error.message}`);
        return;
      }
    }
    const accepted = input.write(encodedPayload);
    if (kind === "video") {
      stream.videoFrames += 1;
      stream.lastVideoWriteAtMs = Date.now();
    } else {
      stream.audioFrames += 1;
      stream.lastAudioWriteAtMs = Date.now();
    }
    if (!accepted) {
      stream.timing.writeBackpressureEvents += 1;
      stream.pipeBlocked[kind] = true;
      stream.pipeDiagnostics[kind].blockedSinceMs = Date.now();
      input.once("drain", () => {
        if (stream.status === "stopped" || stream.status === "error") {
          return;
        }
        const diagnostics = stream.pipeDiagnostics[kind];
        const drainedAtMs = Date.now();
        diagnostics.drainEvents += 1;
        diagnostics.lastDrainAt = new Date(drainedAtMs).toISOString();
        finishPipeBlock(diagnostics, drainedAtMs);
        stream.pipeBlocked[kind] = false;
        flushPipeQueue(stream, kind);
      });
      updateQueuedByteMetrics(stream);
      return;
    }
    updateQueuedByteMetrics(stream);
  }

  function enqueuePipePayload(stream, kind, payload, isVideoKeyFrame = false, timestamp90k = null) {
    if (stream.pipeQueueBytes + payload.length > MAX_PIPE_QUEUE_BYTES) {
      failStream(
        stream,
        `Fila de escrita RTSP excedeu ${MAX_PIPE_QUEUE_BYTES} bytes em ${kind}`,
      );
      return;
    }
    stream.pipeQueues[kind].push({
      payload,
      queuedAtMs: Date.now(),
      isKeyFrame: isVideoKeyFrame,
      timestamp90k,
    });
    stream.pipeQueueBytes += payload.length;
    if (
      kind === "video" &&
      isVideoKeyFrame &&
      (stream.pipeQueueBytes >= gopDropQueueBytes || stream.trimVideoOnKeyFrame)
    ) {
      dropQueuedVideoUntilLatestKeyFrame(stream);
      stream.trimVideoOnKeyFrame = false;
    }
    updateQueuedByteMetrics(stream);
  }

  function dropQueuedVideoUntilLatestKeyFrame(stream) {
    const queue = stream.pipeQueues.video;
    const dropped = dropQueuedVideoBeforeLatestKeyFrame(queue);
    if (dropped.frames.length === 0) {
      return 0;
    }

    stream.pipeQueueBytes -= dropped.bytes;
    stream.videoDiagnostics.framesDroppedForBackpressure +=
      dropped.frames.length;
    stream.videoDiagnostics.bytesDroppedForBackpressure += dropped.bytes;
    onEvent(
      "warn",
      "rtsp-media-gop-dropped",
      `Descartados ${dropped.frames.length} quadros de vídeo (${dropped.bytes} bytes) até o quadro-chave seguinte para recuperar o atraso de ${stream.path}`,
      stream.path,
    );
    return dropped.frames.length;
  }

  function flushPipeQueue(stream, kind) {
    const queue = stream.pipeQueues[kind];
    while (
      queue.length > 0 &&
      !stream.pipeBlocked[kind] &&
      stream.status !== "stopped" &&
      stream.status !== "error"
    ) {
      const entry = queue.shift();
      stream.pipeQueueBytes -= entry.payload.length;
      writePipePayload(stream, kind, entry.payload, entry.timestamp90k, entry.isKeyFrame);
    }
    updateQueuedByteMetrics(stream);
  }

  function updateQueuedByteMetrics(stream) {
    const queuedBytes =
      (stream.videoInput?.writableLength ?? 0) +
      (stream.audioInput?.writableLength ?? 0) +
      stream.pipeQueueBytes;
    stream.timing.maxQueuedBytes = Math.max(
      stream.timing.maxQueuedBytes,
      queuedBytes,
    );
  }

  // Canais irmãos (mesmo terminal, canal diferente) ainda publicando. Usado
  // para alinhar o modo de relógio (source-timestamp vs arrival-fallback)
  // entre canal 1 e 2: deixá-los em modos diferentes é a causa mais provável
  // da dessincronização visual observada em redes 4G/5G instáveis, já que
  // cada modo usa uma estratégia de pacing distinta e sem referência
  // compartilhada entre os canais.
  function getSiblingStreams(stream) {
    const siblings = [];
    for (const candidate of streams.values()) {
      if (
        candidate !== stream &&
        candidate.terminalPhoneHex === stream.terminalPhoneHex &&
        candidate.channelNo !== stream.channelNo &&
        candidate.status !== "stopped" &&
        candidate.status !== "error"
      ) {
        siblings.push(candidate);
      }
    }
    return siblings;
  }

  // Força os canais irmãos que já calibraram (source-timestamp) a também
  // caírem para o relógio de chegada local, igualando o modo usado pelo
  // canal que acabou de cair em arrival-fallback. Forçar o sentido inverso
  // (fazer um canal em fallback "subir" para source-timestamp) não é viável
  // de forma confiável, pois exigiria dados de calibração que esse canal não
  // conseguiu coletar; por isso o alinhamento sempre converge para o modo
  // mais simples (arrival-fallback) quando há divergência entre os canais.
  function alignSiblingsToArrivalFallback(stream) {
    for (const sibling of getSiblingStreams(stream)) {
      if (sibling.timing.mode === "source-timestamp") {
        useArrivalClockFallback(
          sibling,
          `Canal irmão ${stream.path} está em modo de chegada local; alinhando relógios entre canais para evitar dessincronização`,
        );
      }
    }
  }

  function startSourceTimestampClock(stream, scaleMsPerUnit) {
    const timing = stream.timing;
    const timestampedFrames = timing.startupFrames.filter((entry) =>
      isValidTimestamp(entry.frame.timestampMs),
    );
    if (timestampedFrames.length !== timing.startupFrames.length) {
      useArrivalClockFallback(
        stream,
        "Pacote sem timestamp JT1078 válido durante a calibração",
      );
      return;
    }

    const siblingInArrivalFallback = getSiblingStreams(stream).find(
      (sibling) => sibling.timing.mode === "arrival-fallback",
    );
    if (siblingInArrivalFallback) {
      useArrivalClockFallback(
        stream,
        `Canal irmão ${siblingInArrivalFallback.path} está em modo de chegada local; alinhando relógios entre canais para evitar dessincronização`,
      );
      return;
    }

    clearTimeout(timing.calibrationTimer);
    timing.calibrationTimer = null;
    timing.mode = "source-timestamp";
    timing.syncClockScope = "stream-source-timestamp";
    timing.timestampScaleMsPerUnit = scaleMsPerUnit;
    timing.sourceClockArrivalBaseMs = Math.min(
      ...timestampedFrames.map((entry) => entry.arrivalMs),
    );
    timing.wallBaseMs = Date.now() + timing.jitterBufferMs;
    const pending = timing.startupFrames;
    timing.startupFrames = [];

    onEvent(
      "info",
      "rtsp-media-source-clock",
      `Relógio JT1078 ativado para ${stream.path} (escala ${scaleMsPerUnit.toPrecision(8)} ms/unidade)`,
      stream.path,
    );
    for (const entry of pending) {
      scheduleSourceTimestampFrame(stream, entry);
    }
  }

  function scheduleStrictSourceTimestampFrame(stream, entry) {
    const { frame, arrivalMs } = entry;
    const lane = getStrictSyncLane(frame);
    if (lane === null) {
      return;
    }
    const state = getTerminalSyncState(stream.terminalPhoneHex);
    const sourceTime = mapStrictSourceTimestamp(
      state,
      lane,
      frame,
      arrivalMs,
      stream,
    );
    if (sourceTime === null) {
      return;
    }

    const timing = stream.timing;
    const previousDueAt = timing.lastScheduledAtByKind[frame.kind];
    let dueAt = sourceTime.arrivalFallback
      ? arrivalMs + jitterBufferMs
      : previousDueAt === null
        ? sourceTime.dueAt
        : Math.max(
          sourceTime.dueAt,
          previousDueAt + getFallbackFrameIntervalMs(stream, frame),
        );
    dueAt = updateSyncStateOnInput(stream, dueAt, arrivalMs);
    const scheduledAheadMs = dueAt - arrivalMs - jitterBufferMs;
    if (
      !sourceTime.arrivalFallback &&
      scheduledAheadMs > maxSyncScheduleAheadMs
    ) {
      const isKeyFrame = frame.kind === "video" &&
        (frame.dataType === undefined || frame.dataType === 0);
      if (isKeyFrame) {
        const appliedShiftMs = shiftStrictSourceTimeline(
          stream,
          { ...entry, dueAt },
          arrivalMs,
          -scheduledAheadMs,
        );
        if (appliedShiftMs !== null) {
          const rebasedDueAt = dueAt + appliedShiftMs;
          if (
            rebasedDueAt - arrivalMs - jitterBufferMs <=
              maxSyncScheduleAheadMs
          ) {
            timing.lastScheduledAtByKind[frame.kind] = rebasedDueAt;
            state.lastScheduledAtByLane[lane] = rebasedDueAt;
            timing.queue.push({ ...entry, dueAt: rebasedDueAt });
            timing.queue.sort(
              (left, right) =>
                left.dueAt - right.dueAt || left.sequence - right.sequence,
            );
            scheduleNextSourceTimestampFrame(stream);
            return;
          }
        }
      }
      timing.lateFrames += 1;
      if (frame.kind === "video") {
        stream.syncDropUntilKeyFrame = true;
      }
      const lastWarningAtMs = state.lastBacklogWarningAtByLane[lane];
      if (
        lastWarningAtMs === null ||
        arrivalMs - lastWarningAtMs >= TIMESTAMP_MONITOR_SAMPLE_INTERVAL_MS
      ) {
        state.lastBacklogWarningAtByLane[lane] = arrivalMs;
        onEvent(
          "warn",
          "rtsp-media-source-backlog-dropped",
          `Quadro ${frame.kind} descartado em ${lane}: o timestamp de origem excede a janela de agendamento`,
          stream.path,
          {
            lane,
            scheduledAheadMs,
            toleranceMs: syncToleranceMs,
            scheduleAheadLimitMs: maxSyncScheduleAheadMs,
          },
        );
      }
      return;
    }
    timing.lastScheduledAtByKind[frame.kind] = dueAt;
    state.lastScheduledAtByLane[lane] = dueAt;
    timing.queue.push({ ...entry, dueAt });
    timing.queue.sort(
      (left, right) =>
        left.dueAt - right.dueAt || left.sequence - right.sequence,
    );
    scheduleNextSourceTimestampFrame(stream);
  }

  function scheduleSourceTimestampFrame(stream, entry) {
    const timing = stream.timing;
    const { frame } = entry;
    const arrivalDueAt = timing.wallBaseMs +
      (entry.arrivalMs - timing.sourceClockArrivalBaseMs);
    const result = advanceMediaClock({
      previousDueAt: timing.lastScheduledAtByKind[frame.kind],
      previousTimestamp: timing.lastScheduledSourceTimestampByKind[frame.kind],
      timestamp: isValidTimestamp(frame.timestampMs) ? frame.timestampMs : null,
      intervalMs: getFallbackFrameIntervalMs(stream, frame),
      initialDueAt: arrivalDueAt,
      arrivalDueAt,
      scaleMsPerUnit: timing.timestampScaleMsPerUnit,
    });
    const dueAt = result.dueAt;
    if (result.corrected) {
      timing.invalidTimestampFrames += 1;
      onEvent("warn", "rtsp-media-source-timestamp-invalid",
        "Timestamp de origem ausente, repetido, regressivo ou salto acima de 10s; usando intervalo de midia",
        stream.path, { kind: frame.kind, timestampMs: frame.timestampMs });
    }
    timing.lastScheduledSourceTimestampByKind[frame.kind] =
      isValidTimestamp(frame.timestampMs) ? frame.timestampMs : null;
    timing.lastScheduledAtByKind[frame.kind] = dueAt;
    timing.queue.push({ ...entry, dueAt });
    timing.queue.sort(
      (left, right) =>
        left.dueAt - right.dueAt || left.sequence - right.sequence,
    );
    scheduleNextSourceTimestampFrame(stream);
  }

  function getFallbackFrameIntervalMs(stream, frame) {
    const timing = stream.timing;
    if (frame.kind === "video") {
      const sourceInterval = timing.lastSourceIntervalMs.video *
        (timing.timestampScaleMsPerUnit ?? timestampScaleMsPerUnit);
      timing.videoFallbackIntervalMs = getVideoIntervalMs(frame,
        sourceInterval >= 5 && sourceInterval <= 1000
          ? sourceInterval : timing.videoFallbackIntervalMs);
      return timing.videoFallbackIntervalMs;
    }
    const header = inspectAacAdtsHeader(frame.body);
    return 1024 * (header?.valid ? header.rawDataBlocks : 1) * 1000 /
      (header?.valid ? header.sampleRateHz : stream.audioSampleRate);
  }

  function scheduleArrivalClockFrame(stream, entry) {
    const timing = stream.timing;
    const arrivalDueAt = usesSharedSourceTimeline
      ? entry.arrivalMs + timing.jitterBufferMs
      : timing.arrivalWallBaseMs + (entry.arrivalMs - timing.arrivalBaseMs);
    const previous = timing.lastScheduledAtByKind[entry.frame.kind];
    const dueAt = previous === null ? arrivalDueAt :
      Math.max(arrivalDueAt, previous + getFallbackFrameIntervalMs(stream, entry.frame));
    if (
      usesSharedSourceTimeline &&
      dueAt - arrivalDueAt > syncToleranceMs
    ) {
      if (entry.frame.kind === "video") {
        stream.syncDropUntilKeyFrame = true;
      }
      return;
    }
    timing.lastScheduledAtByKind[entry.frame.kind] = dueAt;
    if (usesSharedSourceTimeline) {
      const lane = getStrictSyncLane(entry.frame);
      if (lane) {
        getTerminalSyncState(stream.terminalPhoneHex)
          .lastScheduledAtByLane[lane] = dueAt;
      }
    }
    timing.queue.push({ ...entry, dueAt });
    timing.queue.sort(
      (left, right) =>
        left.dueAt - right.dueAt || left.sequence - right.sequence,
    );
    scheduleNextSourceTimestampFrame(stream);
  }

  function shiftStrictSourceTimeline(stream, entry, nowMs, requestedShiftMs) {
    const state = getTerminalSyncState(stream.terminalPhoneHex);
    if (state.sourceWallBaseAtMs === null) {
      return null;
    }

    let shiftMs = requestedShiftMs;
    if (shiftMs < 0) {
      let latestOutputAtMs = null;
      const terminalKey = stream.terminalPhoneHex.toLowerCase();
      for (const candidate of streams.values()) {
        if (
          candidate.terminalPhoneHex !== terminalKey ||
          candidate.mediaClock.originAtMs === null
        ) {
          continue;
        }
        const writtenTimestamps = [
          candidate.mediaClock.lastVideo90k,
          candidate.mediaClock.lastAudio90k,
        ].filter(Number.isFinite);
        for (const timestamp90k of writtenTimestamps) {
          const writtenAtMs = candidate.mediaClock.originAtMs +
            (timestamp90k - 90_000) / 90;
          latestOutputAtMs = latestOutputAtMs === null
            ? writtenAtMs
            : Math.max(latestOutputAtMs, writtenAtMs);
        }
      }
      if (latestOutputAtMs !== null) {
        shiftMs = Math.max(
          shiftMs,
          latestOutputAtMs + 1 / 90 - entry.dueAt,
        );
      }
    }

    state.sourceWallBaseAtMs += shiftMs;
    state.sourceTimelineShiftMs += shiftMs;
    state.sourceTimelineRebaseCount += 1;
    for (const lane of strictSyncLanes) {
      if (state.lastScheduledAtByLane[lane] !== null) {
        state.lastScheduledAtByLane[lane] += shiftMs;
      }
    }

    const terminalKey = stream.terminalPhoneHex.toLowerCase();
    for (const candidate of streams.values()) {
      if (candidate.terminalPhoneHex !== terminalKey) {
        continue;
      }
      const timing = candidate.timing;
      for (const queuedEntry of timing.queue) {
        queuedEntry.dueAt += shiftMs;
      }
      for (const kind of ["audio", "video"]) {
        if (timing.lastScheduledAtByKind[kind] !== null) {
          timing.lastScheduledAtByKind[kind] += shiftMs;
        }
      }
      clearTimeout(timing.timer);
      timing.timer = null;
      timing.timerDueAt = null;
      scheduleNextSourceTimestampFrame(candidate);
    }

    entry.dueAt += shiftMs;
    const lastEventAtMs = state.lastSourceTimelineRebaseEventAtMs;
    const direction = shiftMs < 0 ? "backward" : "forward";
    if (
      lastEventAtMs === null ||
      state.lastSourceTimelineShiftDirection !== direction ||
      nowMs - lastEventAtMs >= TIMESTAMP_MONITOR_LOG_INTERVAL_MS
    ) {
      state.lastSourceTimelineRebaseEventAtMs = nowMs;
      state.lastSourceTimelineShiftDirection = direction;
      onEvent(
        "warn",
        "rtsp-media-source-timeline-rebased",
        "Quadro-chave fora da janela de reprodução: linha do tempo JT1078 comum recentrada para retomar a publicação",
        stream.path,
        {
          channelNo: stream.channelNo,
          rawTimestamp: getRawSourceTimestamp(entry.frame),
          requestedShiftMs,
          appliedShiftMs: shiftMs,
          direction,
          shiftMs,
          totalShiftMs: state.sourceTimelineShiftMs,
          rebaseCount: state.sourceTimelineRebaseCount,
        },
      );
    }
    return shiftMs;
  }

  function scheduleNextSourceTimestampFrame(stream) {
    const timing = stream.timing;
    if (
      timing.queue.length === 0 ||
      stream.status === "stopped" ||
      stream.status === "error"
    ) {
      return;
    }

    const nowMs = Date.now();
    const nextEntry = timing.queue[0];
    const nextDueAt = nextEntry.dueAt;
    if (timing.timer && nextDueAt >= timing.timerDueAt) {
      return;
    }
    clearTimeout(timing.timer);
    const delay = Math.max(0, nextDueAt - nowMs);
    timing.timerDueAt = nextDueAt;
    timing.timer = setTimeout(() => {
      timing.timer = null;
      timing.timerDueAt = null;
      const now = Date.now();
      if (
        syncMode === "bounded-sync" &&
        terminalSyncStates.get(stream.terminalPhoneHex)?.status === "holding"
      ) {
        const readiness = getStrictSyncReadiness(
          stream.terminalPhoneHex,
          now,
        );
        if (
          !readiness.ready ||
          readiness.scheduleAheadMs > maxSyncScheduleAheadMs
        ) {
          return;
        }
      }
      let drained = 0;
      while (timing.queue.length > 0 && timing.queue[0].dueAt <= now &&
          drained < 32 && !["stopped", "error"].includes(stream.status)) {
        const entry = timing.queue.shift();
        const lateByMs = now - entry.dueAt;
        if (lateByMs > timing.jitterBufferMs) {
          timing.lateFrames += 1;
        }
        if (
          usesSharedSourceTimeline &&
          entry.frame.kind === "video" &&
          lateByMs > MAX_STRICT_VIDEO_LATENESS_MS
        ) {
          const isKeyFrame = entry.frame.dataType === undefined ||
            entry.frame.dataType === 0;
          if (isKeyFrame) {
            shiftStrictSourceTimeline(
              stream,
              entry,
              now,
              lateByMs + jitterBufferMs,
            );
            timing.queue.push(entry);
            timing.queue.sort(
              (left, right) =>
                left.dueAt - right.dueAt || left.sequence - right.sequence,
            );
          } else {
            stream.syncDropUntilKeyFrame = true;
          }
          drained += 1;
          if (isKeyFrame) {
            break;
          }
          continue;
        }
        writeFrame(stream, entry.frame, entry.dueAt);
        drained += 1;
      }
      scheduleNextSourceTimestampFrame(stream);
    }, delay);
  }

  function useArrivalClockFallback(stream, reason = "Timestamps JT1078 insuficientes") {
    const timing = stream.timing;
    if (timing.mode === "arrival-fallback") {
      return;
    }

    clearTimeout(timing.timer);
    clearTimeout(timing.calibrationTimer);
    timing.timer = null;
    timing.timerDueAt = null;
    timing.calibrationTimer = null;
    const pending = [
      ...timing.startupFrames,
      ...timing.queue,
    ].sort((left, right) => left.sequence - right.sequence);
    timing.startupFrames = [];
    timing.queue = [];
    timing.mode = "arrival-fallback";
    timing.syncClockScope = "stream-arrival-fallback";
    onEvent(
      "warn",
      "rtsp-media-arrival-clock-fallback",
      `${reason}; usando chegada local para ${stream.path}`,
      stream.path,
    );
    alignSiblingsToArrivalFallback(stream);
    if (pending.length === 0) {
      return;
    }

    timing.arrivalBaseMs = pending[0].arrivalMs;
    timing.arrivalWallBaseMs = Date.now() + timing.jitterBufferMs;
    timing.lastScheduledAtByKind = { audio: null, video: null };
    for (const entry of pending) {
      scheduleArrivalClockFrame(stream, entry);
    }
  }

  function armAudioArrivalTimer(stream) {
    if (
      !stream.audioEnabled ||
      stream.status === "stopped" ||
      stream.status === "error"
    ) {
      return;
    }
    if (stream.audioArrivalTimer) {
      clearTimeout(stream.audioArrivalTimer);
    }
    const lastAudioAtMs = stream.timing.lastArrivalAtMs.audio;
    const delayMs = lastAudioAtMs === null
      ? audioArrivalTimeoutMs
      : Math.max(0, audioArrivalTimeoutMs - (Date.now() - lastAudioAtMs));
    stream.audioArrivalTimer = setTimeout(() => {
      stream.audioArrivalTimer = null;
      if (
        stream.status === "stopped" ||
        stream.status === "error" ||
        !stream.audioEnabled
      ) {
        return;
      }
      const lastAudioAt = stream.timing.lastArrivalAtMs.audio;
      if (
        lastAudioAt !== null &&
        Date.now() - lastAudioAt < audioArrivalTimeoutMs
      ) {
        armAudioArrivalTimer(stream);
        return;
      }
      if (stream.audioConfirmed) {
        onEvent(
          "warn",
          "rtsp-media-audio-stalled",
          `Nenhum pacote de áudio recebido em ${Math.round(
            audioArrivalTimeoutMs / 1000,
          )}s para ${stream.path}; ${
            separateAudio && stream.channelNo === sharedAudioChannel
              ? "mantendo os publicadores independentes para aguardar novos pacotes"
              : "retomando vídeo sem áudio"
          }`,
          stream.path,
        );
        if (!separateAudio || stream.channelNo !== sharedAudioChannel) {
          if (stream.audioWatchdogArmed) {
            audioUnavailableKeys.set(stream.key, Date.now());
          } else {
            temporaryVideoOnlyKeys.add(stream.key);
          }
          stream.audioEnabled = false;
          stream.status = "stopped";
          stopChild(stream);
        }
        return;
      }
      onEvent(
        "warn",
        "rtsp-media-audio-unavailable",
        `Nenhum pacote de áudio recebido em ${Math.round(
          audioArrivalTimeoutMs / 1000,
        )}s para ${stream.path}; ${
          separateAudio && stream.channelNo === sharedAudioChannel
            ? "publicadores independentes mantidos enquanto o gateway aguarda áudio"
            : "vídeo temporário até a chegada de áudio"
        }`,
        stream.path,
      );
      if (!separateAudio || stream.channelNo !== sharedAudioChannel) {
        if (stream.audioWatchdogArmed) {
          audioUnavailableKeys.set(stream.key, Date.now());
        } else {
          temporaryVideoOnlyKeys.add(stream.key);
        }
        failStream(
          stream,
          "Áudio ausente; retomando vídeo temporariamente e aguardando áudio real",
        );
      }
    }, delayMs);
    stream.audioArrivalTimer.unref?.();
  }

  function countActivePublishers() {
    return [...streams.values()].reduce(
      (count, candidate) =>
        count +
        Number(Boolean(candidate.child) &&
          candidate.status !== "stopped" &&
          candidate.status !== "error") +
        Number(Boolean(candidate.audioChild) &&
          candidate.status !== "stopped" &&
          candidate.status !== "error"),
      0,
    );
  }

  function startAudioPublisher(stream, capabilities) {
    if (
      !separateAudio ||
      stream.channelNo !== sharedAudioChannel ||
      !stream.audioEnabled ||
      stream.audioChild ||
      stream.status === "stopped" ||
      stream.status === "error"
    ) {
      return;
    }
    if (Date.now() < stream.audioPublisherRetryAtMs) {
      stream.audioPublisherStatus = "error";
      stream.audioEnabled = false;
      return;
    }
    if (countActivePublishers() >= MAX_PUBLISHERS) {
      stream.audioPublisherStatus = "error";
      stream.audioPublisherError =
        `Limite de ${MAX_PUBLISHERS} publicadores simultâneos atingido`;
      stream.audioEnabled = false;
      stream.audioPublisherFailures += 1;
      stream.audioPublisherRetryAtMs =
        Date.now() +
        Math.min(
          INITIAL_PUBLISHER_RETRY_MS *
            2 ** Math.min(stream.audioPublisherFailures - 1, 5),
          MAX_PUBLISHER_RETRY_MS,
        );
      onEvent(
        "error",
        "rtsp-media-audio-publisher-error",
        stream.audioPublisherError,
        getRtspAudioPath(stream.terminalPhoneHex),
      );
      return;
    }

    const publisherTimestampMode = stream.timestampMode;
    const url = `${rtspBaseUrl.replace(/\/+$/, "")}/${getRtspAudioPath(
      stream.terminalPhoneHex,
    )}`;
    const args = [
      "-hide_banner",
      "-loglevel",
      "info",
      "-nostdin",
      "-copyts",
      "-thread_queue_size",
      "16",
      "-probesize",
      "32768",
      "-analyzeduration",
      "100000",
    ];
    if (publisherTimestampMode === "wallclock") {
      args.push("-start_at_zero", "-use_wallclock_as_timestamps", "1");
    }
    args.push(
      "-f",
      publisherTimestampMode === "transport" ? "mpegts" : "aac",
      "-i",
      "pipe:3",
      "-map",
      "0:a:0",
      "-vn",
      "-c:a",
      "aac",
      "-b:a",
      "32k",
      "-ac",
      String(Math.max(1, Math.min(2, capabilities.audioChannels))),
      "-flags",
      "+global_header",
      "-f",
      "rtsp",
      "-rtsp_transport",
      "tcp",
      url,
    );

    try {
      const child = spawnProcess(ffmpegPath, args, {
        stdio: ["ignore", "ignore", "pipe", "pipe"],
      });
      stream.audioChild = child;
      stream.audioInput = child.stdio[3];
      stream.audioPublisherStatus = "starting";
      stream.audioPublisherError = null;
      stream.audioInput.on("error", (error) => {
        if (stream.audioChild === child) {
          failAudioPublisher(
            stream,
            child,
            `Erro no pipe de áudio do FFmpeg: ${error.message}`,
          );
        }
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (data) => {
        const lines = `${stream.audioStderrRemainder ?? ""}${data}`.split(/[\r\n]+/);
        stream.audioStderrRemainder = lines.pop()?.slice(-640) ?? "";
        for (const line of lines) {
          processFfmpegStderrLine(stream, line, onEvent, "audio");
        }
      });
      child.on("error", (error) => {
        failAudioPublisher(
          stream,
          child,
          `Não foi possível iniciar o publicador de áudio FFmpeg: ${error.message}`,
        );
      });
      child.on("close", (code, signal) => {
        const wasCurrentChild = stream.audioChild === child;
        if (wasCurrentChild) {
          stream.audioChild = null;
          stream.audioInput = null;
        }
        const terminationRequested = child.audioTerminationRequested === true;
        if (!wasCurrentChild || terminationRequested ||
            stream.status === "stopped" || stream.status === "error") {
          return;
        }
        failAudioPublisher(
          stream,
          child,
          `Publicador de áudio encerrou inesperadamente (código ${
            code ?? "n/a"
          }, sinal ${signal ?? "n/a"})`,
        );
      });
      onEvent(
        "info",
        "rtsp-media-audio-publisher-starting",
        `Iniciando publicação de áudio no caminho ${getRtspAudioPath(
          stream.terminalPhoneHex,
        )}`,
        getRtspAudioPath(stream.terminalPhoneHex),
      );
    } catch (error) {
      stream.audioPublisherStatus = "error";
      stream.audioEnabled = false;
      stream.audioPublisherError =
        `Não foi possível criar o publicador de áudio FFmpeg: ${error.message}`;
      stream.audioPublisherFailures += 1;
      stream.audioPublisherRetryAtMs =
        Date.now() +
        Math.min(
          INITIAL_PUBLISHER_RETRY_MS *
            2 ** Math.min(stream.audioPublisherFailures - 1, 5),
          MAX_PUBLISHER_RETRY_MS,
        );
      onEvent(
        "error",
        "rtsp-media-audio-publisher-error",
        stream.audioPublisherError,
        getRtspAudioPath(stream.terminalPhoneHex),
      );
    }
  }

  function failAudioPublisher(stream, child, message) {
    if (stream.audioChild === child) {
      stream.audioChild = null;
      stream.audioInput = null;
    }
    stream.audioPublisherStatus = "error";
    stream.audioPublisherError = message;
    stream.audioPublisherFailures += 1;
    stream.audioPublisherRetryAtMs =
      Date.now() +
      Math.min(
        INITIAL_PUBLISHER_RETRY_MS *
          2 ** Math.min(stream.audioPublisherFailures - 1, 5),
        MAX_PUBLISHER_RETRY_MS,
      );
    stream.audioEnabled = false;
    child.audioTerminationRequested = true;
    child.stdio[3]?.destroy();
    if (!child.killed) {
      child.kill("SIGTERM");
    }
    onEvent(
      "error",
      "rtsp-media-audio-publisher-error",
      message,
      getRtspAudioPath(stream.terminalPhoneHex),
    );
  }

  function stopAudioPublisher(stream) {
    const child = stream.audioChild;
    if (!child) {
      if (stream.audioPublisherStatus !== "error") {
        stream.audioPublisherStatus = "stopped";
      }
      return;
    }
    child.audioTerminationRequested = true;
    stream.audioChild = null;
    stream.audioInput = null;
    child.stdio[3]?.destroy();
    if (!child.killed) {
      child.kill("SIGTERM");
    }
    if (stream.audioPublisherStatus !== "error") {
      stream.audioPublisherStatus = "stopped";
    }
  }

  function startPublisher(stream, capabilities, videoFormat) {
    const publisherTimestampMode = stream.timestampMode;
    const activePublishers = countActivePublishers();
    if (activePublishers >= MAX_PUBLISHERS) {
      failStream(stream, `Limite de ${MAX_PUBLISHERS} publicadores simultâneos atingido`);
      return;
    }
    const baseUrl = rtspBaseUrl.replace(/\/+$/, "");
    const url = `${baseUrl}/${stream.path}`;
    const args = [
      "-hide_banner",
      "-loglevel",
      "info",
      "-nostdin",
      "-progress",
      "pipe:5",
      "-stats_period",
      "1",
      "-copyts",
      "-thread_queue_size",
      "16",
      "-probesize",
      "32768",
      "-analyzeduration",
      "100000",
      "-f",
      publisherTimestampMode === "transport" ? "mpegts" : videoFormat,
      "-i",
      "pipe:3",
    ];
    if (stream.audioEnabled && !separateAudio) {
      args.push(
        "-thread_queue_size",
        "16",
        "-probesize",
        "32768",
        "-analyzeduration",
        "100000",
        "-f",
        publisherTimestampMode === "transport" ? "mpegts" : "aac",
        "-i",
        "pipe:4",
      );
    }
    if (publisherTimestampMode === "wallclock") {
      args.splice(args.indexOf("-thread_queue_size"), 0, "-start_at_zero");
      for (let index = args.length - 1; index >= 0; index -= 1) {
        if (args[index] === "-probesize") {
          args.splice(index, 0, "-use_wallclock_as_timestamps", "1");
        }
      }
    } else {
      stream.transportWriters = {
        video: createMpegTsWriter(videoFormat),
        audio: stream.audioEnabled ? createMpegTsWriter("aac") : null,
      };
    }
    args.push("-map", "0:v:0", "-c:v", "copy");
    if (stream.audioEnabled && !separateAudio) {
      args.push(
        "-map", "1:a:0",
        "-c:a", "aac", "-b:a", "32k",
        "-ac", String(Math.max(1, Math.min(2, capabilities.audioChannels))),
      );
    }
    args.push("-flags", "+global_header", "-f", "rtsp", "-rtsp_transport", "tcp", url);

    try {
      const child = spawnProcess(ffmpegPath, args, {
        stdio: [
          "ignore",
          "ignore",
          "pipe",
          "pipe",
          stream.audioEnabled && !separateAudio ? "pipe" : "ignore",
          "pipe",
        ],
      });
      stream.child = child;
      stream.publisherStartedAtMs = Date.now();
      stream.videoInput = child.stdio[3];
      stream.audioInput = stream.audioEnabled && !separateAudio
        ? child.stdio[4]
        : null;
      if (stream.audioEnabled && separateAudio &&
          stream.channelNo === sharedAudioChannel) {
        startAudioPublisher(stream, capabilities);
      }
      stream.status = "starting";
      const progressPipe = child.stdio[5];
      if (!progressPipe) {
        throw new Error("Pipe de progresso do FFmpeg indisponível");
      }
      progressPipe.setEncoding("utf8");
      progressPipe.on("error", (error) => {
        onEvent(
          "error",
          "rtsp-media-progress-error",
          `Erro no pipe de progresso do FFmpeg: ${error.message}`,
          stream.path,
        );
      });
      progressPipe.on("data", (data) => {
        const lines = `${stream.progressRemainder}${data}`.split(/\r?\n/);
        stream.progressRemainder = lines.pop()?.slice(-1024) ?? "";
        for (const line of lines) {
          const separator = line.indexOf("=");
          if (separator < 0) {
            continue;
          }
          const key = line.slice(0, separator);
          const value = line.slice(separator + 1).trim();
          if (["frame", "out_time_us", "speed"].includes(key)) {
            stream.progressValues[key] = value;
          } else if (key === "progress") {
            const values = stream.progressValues;
            const progress = stream.outputProgress;
            const reportedAtMs = Date.now();
            const frames = /^\d+$/.test(values.frame ?? "") ? Number(values.frame) : null;
            const outTimeUs = /^-?\d+$/.test(values.out_time_us ?? "")
              ? Number(values.out_time_us)
              : null;
            if (
              (values.frame !== undefined && values.frame !== "N/A" &&
                (!Number.isSafeInteger(frames) || frames < progress.frames)) ||
              (values.out_time_us !== undefined && values.out_time_us !== "N/A" &&
                !Number.isSafeInteger(outTimeUs))
            ) {
              onEvent(
                "warn",
                "rtsp-media-progress-invalid",
                "Contadores inválidos no relatório de progresso do FFmpeg",
                stream.path,
                { frame: values.frame, outTimeUs: values.out_time_us },
              );
            }
            if (Number.isSafeInteger(frames) && frames >= progress.frames) {
              if (frames > progress.frames) {
                progress.lastVideoAdvanceAtMs = reportedAtMs;
              }
              progress.frames = frames;
            }
            if (Number.isSafeInteger(outTimeUs)) {
              if (outTimeUs > (progress.outTimeUs ?? 0)) {
                progress.lastTimeAdvanceAtMs = reportedAtMs;
              }
              progress.outTimeUs = outTimeUs;
            }
            progress.speed = /^\d+(?:\.\d+)?x$/.test(values.speed ?? "")
              ? Number(values.speed.slice(0, -1))
              : null;
            progress.lastReportAtMs = reportedAtMs;
            progress.reports += 1;
            stream.progressValues = {};
          }
        }
      });
      stream.diagnosticsTimer = setInterval(() => {
        onEvent(
          "info",
          "rtsp-media-flow-sample",
          `Diagnóstico de entrada/escrita/saída do FFmpeg para ${stream.path}`,
          stream.path,
          {
            status: stream.status,
            received: {
              video: stream.videoDiagnostics.framesReceived,
              audio: stream.audioDiagnostics.framesReceived,
            },
            written: { video: stream.videoFrames, audio: stream.audioFrames },
            output: { ...stream.outputProgress },
            timestampMode: publisherTimestampMode,
            mediaClock: { ...stream.mediaClock },
            timing: getTimingStatus(stream),
          },
        );
      }, 5000);
      stream.diagnosticsTimer.unref?.();
      if (stream.audioEnabled) {
        armAudioArrivalTimer(stream);
      }
      stream.videoInput.on("error", (error) => {
        failStream(stream, `Erro no pipe de vídeo do FFmpeg: ${error.message}`);
      });
      stream.audioInput?.on("error", (error) => {
        failStream(stream, `Erro no pipe de áudio do FFmpeg: ${error.message}`);
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (data) => {
        const lines = `${stream.stderrRemainder}${data}`.split(/[\r\n]+/);
        stream.stderrRemainder = lines.pop()?.slice(-640) ?? "";
        for (const line of lines) {
          processFfmpegStderrLine(stream, line, onEvent);
        }
      });
      child.on("error", (error) => {
        failStream(stream, `Não foi possível iniciar FFmpeg: ${error.message}`);
      });
      child.on("close", (code, signal) => {
        if (stream.diagnosticsTimer) {
          clearInterval(stream.diagnosticsTimer);
          stream.diagnosticsTimer = null;
        }
        if (stream.childClosed) {
          return;
        }
        stream.childClosed = true;
        if (stream.stderrRemainder) {
          processFfmpegStderrLine(stream, stream.stderrRemainder, onEvent);
          stream.stderrRemainder = "";
        }
        if (stream.status !== "stopped") {
          const terminationRequestedByGateway =
            stream.terminationRequested || stream.status === "error";
          const exitDetails = {
            exitCode: code,
            signal,
            statusAtExit: stream.status,
            terminationRequestedByGateway,
            precedingFailure: stream.error,
            lastStderrLines: stream.ffmpegDiagnostics.lines.slice(-5),
          };
          onEvent(
            terminationRequestedByGateway || code === 0 ? "warn" : "error",
            "rtsp-media-ffmpeg-exit",
            terminationRequestedByGateway
              ? `FFmpeg encerrou após solicitação do gateway (código ${code ?? "n/a"}, sinal ${signal ?? "n/a"})`
              : `FFmpeg encerrou inesperadamente (código ${code ?? "n/a"}, sinal ${signal ?? "n/a"})`,
            stream.path,
            exitDetails,
          );
        }
        if (stream.status !== "stopped" && stream.status !== "error") {
          failStream(
            stream,
            `FFmpeg encerrou inesperadamente (código ${code ?? "n/a"}, sinal ${signal ?? "n/a"})`,
          );
        }
      });
      onEvent(
        "info",
        "rtsp-media-publisher-starting",
        `Iniciando publicação RTSP com ${
          stream.audioEnabled && !separateAudio
            ? "cópia de vídeo e áudio AAC recodificado"
            : stream.audioEnabled && separateAudio &&
              stream.channelNo === sharedAudioChannel
              ? "vídeo e áudio em publicadores separados"
            : "vídeo sem áudio"
        } para ${stream.path}`,
        stream.path,
      );
    } catch (error) {
      failStream(stream, `Não foi possível criar o publicador FFmpeg: ${error.message}`);
    }
  }

  function failStream(stream, message) {
    if (stream.status === "stopped" || stream.status === "error") {
      return;
    }
    stream.status = "error";
    stream.error = message;
    stream.consecutiveFailures += 1;
    stream.retryAtMs =
      Date.now() +
      Math.min(
        INITIAL_PUBLISHER_RETRY_MS * 2 ** Math.min(stream.consecutiveFailures - 1, 5),
        MAX_PUBLISHER_RETRY_MS,
      );
    onEvent(
      "error",
      "rtsp-media-pipeline-error",
      message,
      stream.path,
    );
    stopChild(stream);
  }

  function stopChild(stream) {
    if (stream.diagnosticsTimer) {
      clearInterval(stream.diagnosticsTimer);
      stream.diagnosticsTimer = null;
    }
    if (stream.audioArrivalTimer) {
      clearTimeout(stream.audioArrivalTimer);
      stream.audioArrivalTimer = null;
    }
    clearTimingState(stream.timing);
    const blockedAtMs = Date.now();
    for (const kind of ["audio", "video"]) {
      finishPipeBlock(stream.pipeDiagnostics[kind], blockedAtMs);
    }
    stream.pipeQueues.audio = [];
    stream.pipeQueues.video = [];
    stream.pipeQueueBytes = 0;
    stream.trimVideoOnKeyFrame = false;
    stream.pipeBlocked.audio = false;
    stream.pipeBlocked.video = false;
    stopAudioPublisher(stream);
    if (!stream.child) {
      return;
    }
    stream.terminationRequested = true;
    stream.videoInput?.destroy();
    stream.audioInput?.destroy();
    if (!stream.child.killed) {
      stream.child.kill("SIGTERM");
    }
  }

  return {
    pushFrame,
    trimVideoQueueFor(terminalPhoneHex, channelNo) {
      const stream = streams.get(getStreamKey(terminalPhoneHex, channelNo));
      if (!stream || ["stopped", "error"].includes(stream.status)) {
        throw new Error("Publicador indisponível para aliviar a fila de vídeo");
      }
      const droppedFrames = dropQueuedVideoUntilLatestKeyFrame(stream);
      stream.trimVideoOnKeyFrame = droppedFrames === 0;
      updateQueuedByteMetrics(stream);
      return droppedFrames;
    },
    // Limpa imediatamente a memória de "áudio indisponível" de um fluxo,
    // ignorando o cooldown padrão. Usado por ações explícitas do operador
    // (ex.: botão de ressincronização) que merecem uma nova chance imediata
    // de capturar áudio, em vez de esperar audioRetryCooldownMs expirar.
    resetAudioWatchdog(terminalPhoneHex, channelNo) {
      audioUnavailableKeys.delete(getStreamKey(terminalPhoneHex, channelNo));
    },
    stopStreamFor(terminalPhoneHex, channelNo) {
      const stream = streams.get(getStreamKey(terminalPhoneHex, channelNo));
      if (!stream || stream.status === "stopped") {
        return;
      }
      stream.status = "stopped";
      stopChild(stream);
      onEvent(
        "info",
        "rtsp-media-publisher-stopped",
        `Publicação RTSP encerrada para ${stream.path}`,
        stream.path,
      );
    },
    allowStreamFor(terminalPhoneHex, channelNo) {
      const key = getStreamKey(terminalPhoneHex, channelNo);
      const stream = streams.get(key);
      if (stream) {
        if (stream.status !== "stopped") {
          stream.status = "stopped";
          stopChild(stream);
        }
        streams.delete(key);
      }
      strictSyncBlockedKeys.delete(key);
    },
    getTimestampMonitorStatus,
    getStatus(terminalPhoneHex, channelNo) {
      const stream = streams.get(getStreamKey(terminalPhoneHex, channelNo));
      return {
        path: getRtspStreamPath(terminalPhoneHex, channelNo),
        enabled,
        status: stream?.status ?? "not-started",
        audioEnabled: stream?.audioEnabled ??
          isAudioRequested(terminalPhoneHex, channelNo),
        audioRequested: stream?.audioRequested ??
          isAudioRequested(terminalPhoneHex, channelNo),
        audioState: !stream
          ? "not-started"
          : !stream.audioRequested
            ? "disabled"
            : !stream.audioEnabled
              ? stream.pendingAudioFrame && Date.now() - stream.pendingAudioReceivedAtMs < 5_000
                ? "restoring" : "waiting"
              : !stream.audioConfirmed ? "starting"
                : stream.timing.lastArrivalAtMs.audio !== null &&
                Date.now() - stream.timing.lastArrivalAtMs.audio >= audioArrivalTimeoutMs
                  ? "stalled" : "active",
        videoFrames: stream?.videoFrames ?? 0,
        audioFrames: stream?.audioFrames ?? 0,
        lastVideoReceivedAtMs: stream?.timing.lastArrivalAtMs.video ?? null,
        lastVideoWriteAtMs: stream?.lastVideoWriteAtMs ?? null,
        lastAudioWriteAtMs: stream?.lastAudioWriteAtMs ?? null,
        publisherStartedAtMs: stream?.publisherStartedAtMs ?? null,
        audioPublisherStatus: stream?.audioPublisherStatus ?? "not-started",
        audioPublisherError: stream?.audioPublisherError ?? null,
        outputProgress: stream ? { ...stream.outputProgress } : null,
        timestampMode: stream?.timestampMode ?? timestampMode,
        mediaClock: stream ? { ...stream.mediaClock } : null,
        syncStatus: getSyncStatus(terminalPhoneHex),
        error: stream?.error ?? null,
        ffmpegDiagnostics: stream
          ? {
              lines: [...stream.ffmpegDiagnostics.lines],
              droppedLines: stream.ffmpegDiagnostics.droppedLines,
              lastLineAt: stream.ffmpegDiagnostics.lastLineAt,
            }
          : createFfmpegDiagnostics(),
        videoDiagnostics: stream
          ? {
              ...stream.videoDiagnostics,
              dataTypeCounts: { ...stream.videoDiagnostics.dataTypeCounts },
              framingCounts: { ...stream.videoDiagnostics.framingCounts },
              h264NalTypes: { ...stream.videoDiagnostics.h264NalTypes },
              hevcNalTypes: { ...stream.videoDiagnostics.hevcNalTypes },
            }
          : createVideoDiagnostics(),
        audioDiagnostics: stream
          ? {
              ...stream.audioDiagnostics,
              lastAdtsHeader: stream.audioDiagnostics.lastAdtsHeader
                ? { ...stream.audioDiagnostics.lastAdtsHeader }
                : null,
            }
          : createAudioDiagnostics(),
        timing: getTimingStatus(stream),
      };
    },
    getAudioStatus(terminalPhoneHex) {
      const stream = streams.get(getStreamKey(terminalPhoneHex, sharedAudioChannel));
      const audioState = !stream
        ? "not-started"
        : !stream.audioRequested
          ? "disabled"
          : !stream.audioEnabled
            ? stream.pendingAudioFrame && Date.now() - stream.pendingAudioReceivedAtMs < 5_000
              ? "restoring" : "waiting"
            : !stream.audioConfirmed ? "starting"
              : stream.timing.lastArrivalAtMs.audio !== null &&
                  Date.now() - stream.timing.lastArrivalAtMs.audio >= audioArrivalTimeoutMs
                ? "stalled" : "active";
      return {
        path: getRtspAudioPath(terminalPhoneHex),
        enabled,
        status: !enabled ? "disabled" : stream?.error ? "error" :
          separateAudio && stream?.channelNo === sharedAudioChannel
            ? stream.audioPublisherStatus
            : stream?.audioEnabled ? stream.status :
            stream?.status === "stopped" ? "stopped" : "waiting",
        error: separateAudio && stream?.channelNo === sharedAudioChannel
          ? stream.audioPublisherError ?? null
          : stream?.error ?? null,
        audioEnabled: Boolean(stream?.audioEnabled),
        audioRequested: stream?.audioRequested ??
          isAudioRequested(terminalPhoneHex, sharedAudioChannel),
        audioState,
        audioFrames: stream?.audioFrames ?? 0,
        outputProgress: stream ? { ...stream.outputProgress } : null,
        timestampMode: stream?.timestampMode ?? timestampMode,
        mediaClock: stream ? { ...stream.mediaClock } : null,
        syncStatus: getSyncStatus(terminalPhoneHex),
        ffmpegDiagnostics: stream
          ? {
              lines: [...stream.ffmpegDiagnostics.lines],
              droppedLines: stream.ffmpegDiagnostics.droppedLines,
              lastLineAt: stream.ffmpegDiagnostics.lastLineAt,
            }
          : null,
        audioDiagnostics: stream
          ? { ...stream.audioDiagnostics, lastAdtsHeader: stream.audioDiagnostics.lastAdtsHeader
            ? { ...stream.audioDiagnostics.lastAdtsHeader } : null }
          : createAudioDiagnostics(),
        timing: getTimingStatus(stream),
      };
    },
    close() {
      for (const stream of streams.values()) {
        if (stream.status !== "stopped") {
          stream.status = "stopped";
          stopChild(stream);
        }
      }
      for (const state of terminalSyncStates.values()) {
        clearTimeout(state.holdTimer);
      }
      terminalClockOrigins.clear();
      terminalSyncStates.clear();
      strictSyncBlockedKeys.clear();
    },
  };
}

export function dropQueuedVideoBeforeLatestKeyFrame(queue) {
  let latestKeyFrameIndex = -1;
  for (let index = queue.length - 1; index > 0; index -= 1) {
    if (queue[index].isKeyFrame) {
      latestKeyFrameIndex = index;
      break;
    }
  }
  if (latestKeyFrameIndex < 1) {
    return { frames: [], bytes: 0 };
  }

  const frames = queue.splice(0, latestKeyFrameIndex);
  return {
    frames,
    bytes: frames.reduce((total, entry) => total + entry.payload.length, 0),
  };
}

function createTimingState(jitterBufferMs) {
  return {
    mode: "calibrating",
    syncClockScope: "uncalibrated",
    jitterBufferMs,
    startedAtMs: Date.now(),
    sequence: 0,
    startupFrames: [],
    scaleSamples: [],
    scaleAnchorByKind: { audio: null, video: null },
    lastSourceTimestampMs: { audio: null, video: null },
    lastSourceIntervalMs: { audio: null, video: null },
    lastArrivalAtMs: { audio: null, video: null },
    lastArrivalIntervalMs: { audio: null, video: null },
    timestampScaleMsPerUnit: null,
    sourceClockArrivalBaseMs: null,
    wallBaseMs: null,
    lastScheduledAtByKind: { audio: null, video: null },
    lastScheduledSourceTimestampByKind: { audio: null, video: null },
    videoFallbackIntervalMs: 40,
    queue: [],
    timer: null,
    timerDueAt: null,
    calibrationTimer: null,
    arrivalBaseMs: null,
    arrivalWallBaseMs: null,
    lateFrames: 0,
    invalidTimestampFrames: 0,
    writeBackpressureEvents: 0,
    maxQueuedBytes: 0,
  };
}

function createPipeDiagnostics() {
  return {
    drainEvents: 0,
    lastDrainAt: null,
    lastBlockedDurationMs: null,
    totalBlockedMs: 0,
    maxBlockedMs: 0,
    blockedSinceMs: null,
  };
}

function createFfmpegDiagnostics() {
  return {
    lines: [],
    droppedLines: 0,
    lastLineAt: null,
  };
}

function createAudioDiagnostics() {
  return {
    audioEncoding: null,
    audioChannels: null,
    audioSampleRateHz: null,
    framesReceived: 0,
    framesWithAdts: 0,
    framesWithoutAdts: 0,
    malformedAdtsFrames: 0,
    totalPayloadBytes: 0,
    minimumFrameBytes: null,
    maximumFrameBytes: 0,
    lastFrameBytes: null,
    lastAdtsHeader: null,
    synthesizedHeaderProfile: "AAC LC",
  };
}

function createVideoDiagnostics() {
  return {
    framesReceived: 0,
    totalPayloadBytes: 0,
    framesDroppedForBackpressure: 0,
    bytesDroppedForBackpressure: 0,
    dataTypeCounts: {},
    framingCounts: { annexB: 0, lengthPrefixed: 0, raw: 0, empty: 0 },
    validH264NalHeaders: 0,
    invalidH264NalHeaders: 0,
    h264NalTypes: {},
    validHevcNalHeaders: 0,
    invalidHevcNalHeaders: 0,
    hevcNalTypes: {},
    lastFrameBytes: null,
    lastFraming: null,
    lastH264NalType: null,
    lastHevcNalType: null,
  };
}

function recordVideoPayloadDiagnostics(diagnostics, body, dataType) {
  diagnostics.framesReceived += 1;
  diagnostics.totalPayloadBytes += body.length;
  if (Number.isInteger(dataType)) {
    incrementCount(diagnostics.dataTypeCounts, dataType);
  }
  diagnostics.lastFrameBytes = body.length;

  if (body.length === 0) {
    diagnostics.framingCounts.empty += 1;
    diagnostics.lastFraming = "empty";
    return;
  }

  let nalUnit;
  if (hasAnnexBStartCode(body)) {
    diagnostics.framingCounts.annexB += 1;
    diagnostics.lastFraming = "annexB";
    const offset = body[2] === 1 ? 3 : 4;
    nalUnit = body.subarray(offset);
  } else {
    const lengthPrefixedNalUnits = splitLengthPrefixedNalUnits(body);
    if (lengthPrefixedNalUnits) {
      diagnostics.framingCounts.lengthPrefixed += 1;
      diagnostics.lastFraming = "lengthPrefixed";
      nalUnit = lengthPrefixedNalUnits[0];
    } else {
      diagnostics.framingCounts.raw += 1;
      diagnostics.lastFraming = "raw";
      nalUnit = body;
    }
  }

  if (nalUnit.length === 0) {
    diagnostics.invalidH264NalHeaders += 1;
    diagnostics.invalidHevcNalHeaders += 1;
    return;
  }

  const h264NalType = nalUnit[0] & 0x1f;
  diagnostics.lastH264NalType = h264NalType;
  if ((nalUnit[0] & 0x80) === 0 && h264NalType > 0 && h264NalType < 24) {
    diagnostics.validH264NalHeaders += 1;
    incrementCount(diagnostics.h264NalTypes, h264NalType);
  } else {
    diagnostics.invalidH264NalHeaders += 1;
  }

  if (nalUnit.length < 2) {
    diagnostics.invalidHevcNalHeaders += 1;
    diagnostics.lastHevcNalType = null;
    return;
  }
  const hevcNalType = (nalUnit[0] >> 1) & 0x3f;
  diagnostics.lastHevcNalType = hevcNalType;
  if ((nalUnit[0] & 0x80) === 0 && (nalUnit[1] & 0x07) !== 0) {
    diagnostics.validHevcNalHeaders += 1;
    incrementCount(diagnostics.hevcNalTypes, hevcNalType);
  } else {
    diagnostics.invalidHevcNalHeaders += 1;
  }
}

function incrementCount(counts, key) {
  counts[key] = (counts[key] ?? 0) + 1;
}

function recordAudioPayloadDiagnostics(diagnostics, body) {
  diagnostics.framesReceived += 1;
  diagnostics.totalPayloadBytes += body.length;
  diagnostics.minimumFrameBytes =
    diagnostics.minimumFrameBytes === null
      ? body.length
      : Math.min(diagnostics.minimumFrameBytes, body.length);
  diagnostics.maximumFrameBytes = Math.max(
    diagnostics.maximumFrameBytes,
    body.length,
  );
  diagnostics.lastFrameBytes = body.length;

  const header = inspectAacAdtsHeader(body);
  if (header) {
    diagnostics.framesWithAdts += 1;
    if (!header.valid) {
      diagnostics.malformedAdtsFrames += 1;
    }
    diagnostics.lastAdtsHeader = header;
  } else {
    diagnostics.framesWithoutAdts += 1;
    diagnostics.lastAdtsHeader = null;
  }
}

function recordFrameTiming(timing, frame, arrivalMs, calibrationSpanMs, configuredScale) {
  const { kind, timestampMs } = frame;
  const previousArrival = timing.lastArrivalAtMs[kind];
  if (previousArrival !== null) {
    timing.lastArrivalIntervalMs[kind] = arrivalMs - previousArrival;
  }
  timing.lastArrivalAtMs[kind] = arrivalMs;

  if (!isValidTimestamp(timestampMs)) {
    return;
  }

  const previousTimestamp = timing.lastSourceTimestampMs[kind];
  if (previousTimestamp !== null) {
    const delta = timestampMs - previousTimestamp;
    if (delta > 0 && delta * configuredScale <= 10_000) {
      timing.lastSourceIntervalMs[kind] = delta;
    }
  }

  const anchor = timing.scaleAnchorByKind[kind];
  const reliableAdvance = previousTimestamp !== null &&
    timestampMs > previousTimestamp &&
    (timestampMs - previousTimestamp) * configuredScale <= 10_000;
  if (anchor === null || timestampMs <= anchor.timestampMs ||
      (previousTimestamp !== null && !reliableAdvance)) {
    timing.scaleAnchorByKind[kind] = { timestampMs, arrivalMs };
  } else {
    const sourceSpan = timestampMs - anchor.timestampMs;
    if (reliableAdvance && sourceSpan * configuredScale >= calibrationSpanMs) {
      timing.scaleSamples.push(configuredScale);
    }
  }
  if (timing.scaleSamples.length > 9) {
    timing.scaleSamples.splice(0, timing.scaleSamples.length - 9);
  }
  timing.lastSourceTimestampMs[kind] = timestampMs;
}

function getTimingStatus(stream) {
  if (!stream) {
    return {
      mode: "not-started",
      syncClockScope: "uncalibrated",
      jitterBufferMs: null,
      timestampScaleMsPerUnit: null,
      sourceTimestampMs: { audio: null, video: null },
      sourceIntervalMs: { audio: null, video: null },
      arrivalIntervalMs: { audio: null, video: null },
      sourceAudioVideoOffsetMs: null,
      queuedFrames: 0,
      lateFrames: 0,
      invalidTimestampFrames: 0,
      writeBackpressureEvents: 0,
      maxQueuedBytes: 0,
      pipeQueuedFrames: 0,
      pipeQueuedBytes: 0,
      writableBytes: 0,
      pipeQueuedFramesByKind: { audio: 0, video: 0 },
      pipeQueuedBytesByKind: { audio: 0, video: 0 },
      pipeBlockedByKind: { audio: false, video: false },
      writableBytesByKind: { audio: 0, video: 0 },
      pipeDiagnosticsByKind: {
        audio: createPipeDiagnosticsStatus(),
        video: createPipeDiagnosticsStatus(),
      },
    };
  }

  const timing = stream.timing;
  const scale = timing.timestampScaleMsPerUnit;
  const audioTimestamp = timing.lastSourceTimestampMs.audio;
  const videoTimestamp = timing.lastSourceTimestampMs.video;
  return {
    mode: timing.mode,
    syncClockScope: timing.syncClockScope,
    jitterBufferMs: timing.jitterBufferMs,
    timestampScaleMsPerUnit: scale,
    sourceTimestampMs: { ...timing.lastSourceTimestampMs },
    sourceIntervalMs: {
      audio:
        scale === null || timing.lastSourceIntervalMs.audio === null
          ? null
          : timing.lastSourceIntervalMs.audio * scale,
      video:
        scale === null || timing.lastSourceIntervalMs.video === null
          ? null
          : timing.lastSourceIntervalMs.video * scale,
    },
    arrivalIntervalMs: { ...timing.lastArrivalIntervalMs },
    sourceAudioVideoOffsetMs:
      scale === null || audioTimestamp === null || videoTimestamp === null
        ? null
        : (audioTimestamp - videoTimestamp) * scale,
    queuedFrames:
      timing.startupFrames.length +
      timing.queue.length +
      stream.pipeQueues.audio.length +
      stream.pipeQueues.video.length,
    lateFrames: timing.lateFrames,
    invalidTimestampFrames: timing.invalidTimestampFrames,
    writeBackpressureEvents: timing.writeBackpressureEvents,
    maxQueuedBytes: timing.maxQueuedBytes,
    pipeQueuedFrames: stream.pipeQueues.audio.length + stream.pipeQueues.video.length,
    pipeQueuedBytes: stream.pipeQueueBytes,
    writableBytes:
      (stream.videoInput?.writableLength ?? 0) +
      (stream.audioInput?.writableLength ?? 0),
    pipeQueuedFramesByKind: {
      audio: stream.pipeQueues.audio.length,
      video: stream.pipeQueues.video.length,
    },
    pipeQueuedBytesByKind: {
      audio: getQueueBytes(stream.pipeQueues.audio),
      video: getQueueBytes(stream.pipeQueues.video),
    },
    pipeBlockedByKind: { ...stream.pipeBlocked },
    writableBytesByKind: {
      audio: stream.audioInput?.writableLength ?? 0,
      video: stream.videoInput?.writableLength ?? 0,
    },
    pipeDiagnosticsByKind: {
      audio: getPipeDiagnosticsStatus(stream, "audio"),
      video: getPipeDiagnosticsStatus(stream, "video"),
    },
  };
}

function getQueueBytes(queue) {
  return queue.reduce((total, entry) => total + entry.payload.length, 0);
}

function processFfmpegStderrLine(stream, rawLine, onEvent, publisherKind = "video") {
  const line = rawLine.trim();
  if (!line) {
    return;
  }
  appendFfmpegDiagnostic(stream, line);

  const eventPath = publisherKind === "audio"
    ? getRtspAudioPath(stream.terminalPhoneHex)
    : stream.path;
  if (line.includes("Output #0, rtsp")) {
    if (publisherKind === "audio") {
      if (stream.audioPublisherStatus !== "publishing") {
        stream.audioPublisherStatus = "publishing";
        stream.audioPublisherFailures = 0;
        stream.audioPublisherRetryAtMs = 0;
        stream.audioPublisherError = null;
        onEvent(
          "info",
          "rtsp-media-audio-published",
          `Áudio publicado no RTSP no caminho ${eventPath}`,
          eventPath,
        );
      }
    } else if (stream.status !== "publishing") {
      stream.status = "publishing";
      stream.consecutiveFailures = 0;
      onEvent(
        "info",
        "rtsp-media-published",
        `Vídeo publicado no RTSP no caminho ${stream.path}`,
        stream.path,
      );
    }
  }
  if (/(\berror\b|\bfailed\b)/i.test(line)) {
    if (publisherKind === "audio") {
      stream.audioPublisherError = line.slice(-500);
    } else {
      stream.error = line.slice(-500);
    }
    onEvent(
      "warn",
      "rtsp-media-ffmpeg-message",
      publisherKind === "audio"
        ? stream.audioPublisherError
        : stream.error,
      eventPath,
    );
  }
}

function appendFfmpegDiagnostic(stream, line) {
  if (
    !/^(?:Input #\d+|Output #\d+|Stream mapping:|Stream #\d+:\d+|frame=|bench:|\[.*(?:error|failed|invalid|warning)|.*(?:error|failed|invalid data|non-monoton|dropping frame).*)/i.test(
      line,
    )
  ) {
    return;
  }

  const sanitizedLine = line
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s'"]+/gi, "<url>")
    .replaceAll(stream.path, "<stream>")
    .slice(0, MAX_FFMPEG_DIAGNOSTIC_LINE_LENGTH);
  const diagnostics = stream.ffmpegDiagnostics;
  diagnostics.lines.push(sanitizedLine);
  diagnostics.lastLineAt = new Date().toISOString();
  if (diagnostics.lines.length > MAX_FFMPEG_DIAGNOSTIC_LINES) {
    diagnostics.lines.shift();
    diagnostics.droppedLines += 1;
  }
}

function getPipeDiagnosticsStatus(stream, kind) {
  const diagnostics = stream.pipeDiagnostics[kind];
  const queue = stream.pipeQueues[kind];
  const now = Date.now();
  return {
    drainEvents: diagnostics.drainEvents,
    lastDrainAt: diagnostics.lastDrainAt,
    blockedForMs:
      diagnostics.blockedSinceMs === null
        ? 0
        : Math.max(0, now - diagnostics.blockedSinceMs),
    lastBlockedDurationMs: diagnostics.lastBlockedDurationMs,
    totalBlockedMs: diagnostics.totalBlockedMs,
    maxBlockedMs: diagnostics.maxBlockedMs,
    oldestQueuedForMs:
      queue.length === 0 ? 0 : Math.max(0, now - queue[0].queuedAtMs),
  };
}

function createPipeDiagnosticsStatus() {
  return {
    drainEvents: 0,
    lastDrainAt: null,
    blockedForMs: 0,
    lastBlockedDurationMs: null,
    totalBlockedMs: 0,
    maxBlockedMs: 0,
    oldestQueuedForMs: 0,
  };
}

function finishPipeBlock(diagnostics, endedAtMs) {
  if (diagnostics.blockedSinceMs === null) {
    return;
  }
  const durationMs = Math.max(0, endedAtMs - diagnostics.blockedSinceMs);
  diagnostics.lastBlockedDurationMs = durationMs;
  diagnostics.totalBlockedMs += durationMs;
  diagnostics.maxBlockedMs = Math.max(diagnostics.maxBlockedMs, durationMs);
  diagnostics.blockedSinceMs = null;
}

function clearTimingState(timing) {
  clearTimeout(timing.timer);
  clearTimeout(timing.calibrationTimer);
  timing.timer = null;
  timing.timerDueAt = null;
  timing.calibrationTimer = null;
  timing.startupFrames = [];
  timing.queue = [];
}

function isValidTimestamp(value) {
  return Number.isFinite(value) && value >= 0;
}

export function inferTimestampScaleMsPerUnit(samples) {
  if (!Array.isArray(samples) || samples.length < 2) {
    return null;
  }

  const valid = samples.filter(
    (sample) =>
      Number.isFinite(sample) &&
      sample > 1e-9 &&
      sample < 1e3,
  );
  if (valid.length < 2) {
    return null;
  }

  const sorted = [...valid].sort((left, right) => left - right);
  const median = getMedian(sorted);
  const inliers = valid.filter(
    (sample) => Math.abs(sample - median) <= Math.abs(median) * 0.25,
  );
  if (inliers.length < 2) {
    return null;
  }
  const inlierValues = [...inliers].sort((left, right) => left - right);
  return getMedian(inlierValues);
}

function getMedian(sortedValues) {
  const middle = Math.floor(sortedValues.length / 2);
  return sortedValues.length % 2 === 0
    ? (sortedValues[middle - 1] + sortedValues[middle]) / 2
    : sortedValues[middle];
}

export function getRtspStreamPath(terminalPhoneHex, channelNo) {
  if (!/^[0-9a-f]{12}$/i.test(terminalPhoneHex)) {
    throw new Error("Terminal JT1078 address must be 6-byte hexadecimal");
  }
  if (!Number.isInteger(channelNo) || channelNo < 1 || channelNo > 255) {
    throw new Error("JT1078 channel must be an integer from 1 to 255");
  }
  return `terminal-${terminalPhoneHex.toLowerCase()}-channel-${channelNo}`;
}

export function getRtspAudioPath(terminalPhoneHex) {
  if (!/^[0-9a-f]{12}$/i.test(terminalPhoneHex)) {
    throw new Error("Terminal JT1078 address must be 6-byte hexadecimal");
  }
  return `terminal-${terminalPhoneHex.toLowerCase()}-audio`;
}

export function toAnnexB(body) {
  if (hasAnnexBStartCode(body)) {
    return body;
  }
  const nalUnits = splitLengthPrefixedNalUnits(body);
  if (nalUnits) {
    return Buffer.concat(
      nalUnits.flatMap((nal) => [Buffer.from([0, 0, 0, 1]), nal]),
    );
  }
  return Buffer.concat([Buffer.from([0, 0, 0, 1]), body]);
}

export function addAacAdtsHeader(body, sampleRate, channels) {
  const existingHeader = inspectAacAdtsHeader(body);
  if (existingHeader) {
    if (!existingHeader.valid) {
      throw new Error("AAC payload contains an invalid ADTS header");
    }
    return body;
  }
  const frequencyIndex = AAC_FREQUENCY_INDEX.get(sampleRate);
  if (!frequencyIndex) {
    throw new Error(`AAC sample rate ${sampleRate} is not supported by ADTS`);
  }
  if (body.length + 7 > 0x1fff) {
    throw new Error("AAC frame exceeds the ADTS frame-length limit");
  }

  const channelCount = Math.max(1, Math.min(2, channels));
  const frameLength = body.length + 7;
  const header = Buffer.alloc(7);
  header[0] = 0xff;
  header[1] = 0xf1;
  header[2] = (1 << 6) | (frequencyIndex << 2) | (channelCount >> 2);
  header[3] = ((channelCount & 3) << 6) | ((frameLength >> 11) & 3);
  header[4] = (frameLength >> 3) & 0xff;
  header[5] = ((frameLength & 7) << 5) | 0x1f;
  header[6] = 0xfc;
  return Buffer.concat([header, body]);
}

function hasAnnexBStartCode(body) {
  return (
    body.length >= 4 &&
    body[0] === 0 &&
    body[1] === 0 &&
    (body[2] === 1 || (body[2] === 0 && body[3] === 1))
  );
}

function hasAdtsHeader(body) {
  return body.length >= 2 && body[0] === 0xff && (body[1] & 0xf6) === 0xf0;
}

export function inspectAacAdtsHeader(body) {
  if (!hasAdtsHeader(body)) {
    return null;
  }
  if (body.length < 7) {
    return {
      valid: false,
      headerLength: null,
      profile: null,
      sampleRateIndex: null,
      sampleRateHz: null,
      channelConfiguration: null,
      frameLength: null,
      rawDataBlocks: null,
    };
  }

  const headerLength = body[1] & 1 ? 7 : 9;
  const profileIndex = (body[2] >> 6) & 3;
  const sampleRateIndex = (body[2] >> 2) & 0x0f;
  const channelConfiguration = ((body[2] & 1) << 2) | (body[3] >> 6);
  const frameLength =
    ((body[3] & 3) << 11) | (body[4] << 3) | (body[5] >> 5);
  const sampleRateHz = ADTS_SAMPLE_RATES[sampleRateIndex] ?? null;

  return {
    valid:
      sampleRateHz !== null &&
      frameLength === body.length &&
      frameLength >= headerLength,
    headerLength,
    profile: AAC_PROFILE_NAMES[profileIndex],
    sampleRateIndex,
    sampleRateHz,
    channelConfiguration,
    frameLength,
    rawDataBlocks: (body[6] & 3) + 1,
  };
}

function splitLengthPrefixedNalUnits(body) {
  if (body.length < 5) {
    return null;
  }
  const units = [];
  let offset = 0;
  while (offset + 4 <= body.length) {
    const length = body.readUInt32BE(offset);
    offset += 4;
    if (length === 0 || offset + length > body.length) {
      return null;
    }
    units.push(body.subarray(offset, offset + length));
    offset += length;
  }
  return offset === body.length && units.length > 0 ? units : null;
}

function getStreamKey(terminalPhoneHex, channelNo) {
  return `${terminalPhoneHex.toLowerCase()}:${channelNo}`;
}
