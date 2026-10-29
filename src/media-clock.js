export function getVideoIntervalMs(frame, previousIntervalMs) {
  for (const interval of [frame.lastFrameIntervalMs, previousIntervalMs, 40]) {
    if (Number.isFinite(interval) && interval >= 5 && interval <= 1000) {
      return interval;
    }
  }
}

export function advanceMediaClock({
  previousDueAt, previousTimestamp, timestamp, intervalMs,
  initialDueAt, arrivalDueAt, scaleMsPerUnit = 1,
}) {
  if (previousDueAt === null) {
    return { dueAt: initialDueAt, corrected: false };
  }
  const delta = previousTimestamp === null || timestamp === null
    ? null : (timestamp - previousTimestamp) * scaleMsPerUnit;
  if (delta !== null && Number.isFinite(delta) && delta > 0 && delta <= 10_000) {
    return { dueAt: previousDueAt + delta, corrected: false };
  }
  return {
    dueAt: Math.max(previousDueAt + intervalMs, arrivalDueAt),
    corrected: true,
  };
}
