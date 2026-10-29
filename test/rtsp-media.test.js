import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";
import {
  addAacAdtsHeader,
  createRtspMediaPipeline,
  dropQueuedVideoBeforeLatestKeyFrame,
  getRtspAudioPath,
  getRtspStreamPath,
  inspectAacAdtsHeader,
  inferTimestampScaleMsPerUnit,
  toAnnexB,
} from "../src/rtsp-media.js";

test("normalizes H.265 NAL payloads to Annex B", () => {
  assert.deepEqual(
    toAnnexB(Buffer.from([0x26, 0x01, 0xaa])),
    Buffer.from([0, 0, 0, 1, 0x26, 0x01, 0xaa]),
  );
  assert.deepEqual(
    toAnnexB(Buffer.from([0, 0, 0, 2, 0x26, 0x01])),
    Buffer.from([0, 0, 0, 1, 0x26, 0x01]),
  );
});

test("adds an AAC-LC ADTS header using JT808 audio attributes", () => {
  const frame = addAacAdtsHeader(Buffer.from([0x21, 0x10]), 8000, 1);

  assert.equal(frame.length, 9);
  assert.equal(frame[0], 0xff);
  assert.equal(frame[1], 0xf1);
  assert.equal((frame[2] >> 2) & 0x0f, 11);
  assert.deepEqual(inspectAacAdtsHeader(frame), {
    valid: true,
    headerLength: 7,
    profile: "AAC LC",
    sampleRateIndex: 11,
    sampleRateHz: 8000,
    channelConfiguration: 1,
    frameLength: 9,
    rawDataBlocks: 1,
  });
});

test("infers a stable JT1078 timestamp scale", () => {
  assert.equal(inferTimestampScaleMsPerUnit([1, 1, 1]), 1);
  assert.equal(inferTimestampScaleMsPerUnit([0.001, 0.00101, 0.00099]), 0.001);
  assert.equal(inferTimestampScaleMsPerUnit([1]), null);
});

test("validates the configured jitter buffer range", () => {
  assert.throws(
    () =>
      createRtspMediaPipeline({
        rtspBaseUrl: "rtsp://mediamtx:8554",
        jitterBufferMs: 8001,
        getCapabilities: () => null,
        onEvent: () => {},
      }),
    /jitterBufferMs must be an integer from 0 to 8000/,
  );
});

test("validates strict synchronization mode and tolerance", () => {
  const options = {
    rtspBaseUrl: "rtsp://mediamtx:8554",
    getCapabilities: () => null,
    onEvent: () => {},
  };
  assert.throws(
    () => createRtspMediaPipeline({ ...options, syncToleranceMs: 49 }),
    /syncToleranceMs must be an integer from 50 to 2500/,
  );
  assert.doesNotThrow(() =>
    createRtspMediaPipeline({ ...options, syncToleranceMs: 2500 }),
  );
  assert.throws(
    () =>
      createRtspMediaPipeline({ ...options, syncHoldTimeoutMs: 49 }),
    /syncHoldTimeoutMs must be an integer from 50 to 2500/,
  );
  assert.doesNotThrow(() =>
    createRtspMediaPipeline({
      ...options,
      syncMode: "bounded-sync",
      syncHoldTimeoutMs: 250,
      syncScheduleAheadLimitMs: 750,
    }),
  );
  assert.throws(
    () =>
      createRtspMediaPipeline({
        ...options,
        syncScheduleAheadLimitMs: 49,
      }),
    /syncScheduleAheadLimitMs must be an integer from 50 to 5000/,
  );
  assert.throws(
    () =>
      createRtspMediaPipeline({
        ...options,
        syncScheduleAheadLimitMs: 5001,
      }),
    /syncScheduleAheadLimitMs must be an integer from 50 to 5000/,
  );
  assert.throws(
    () => createRtspMediaPipeline({ ...options, syncToleranceMs: 2501 }),
    /syncToleranceMs must be an integer from 50 to 2500/,
  );
  assert.throws(
    () => createRtspMediaPipeline({
      ...options,
      syncMode: "strict-arrival",
      timestampMode: "wallclock",
    }),
    /strict-arrival sync requires transport timestamps/,
  );
});

test("records raw timestamps from both videos and channel-1 audio", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100_000 });
  const terminalPhoneHex = "001200053180";
  const events = [];
  const pipeline = createRtspMediaPipeline({
    rtspBaseUrl: "rtsp://mediamtx:8554",
    syncMode: "strict-arrival",
    jitterBufferMs: 0,
    separateAudio: true,
    getCapabilities: () => ({
      audioEncoding: 19,
      audioChannels: 1,
      audioSampleRate: 0,
      videoEncoding: 99,
    }),
    onEvent: (...event) => events.push(event),
    spawnProcess: () => new FakeChild(),
  });
  t.after(() => pipeline.close());

  const push = (channelNo, kind, timestampRaw) => pipeline.pushFrame({
    terminalPhoneHex,
    channelNo,
    kind,
    dataType: kind === "video" ? 0 : 3,
    timestampRaw,
    timestampMs: Number(timestampRaw),
    lastFrameIntervalMs: kind === "video" ? 40 : undefined,
    body: Buffer.from(kind === "video" ? [0x26, 1, 0xaa] : [0x21, 0x10]),
  });

  push(1, "video", "184467");
  push(2, "video", "184468");
  push(1, "audio", "184469");

  const status = pipeline.getTimestampMonitorStatus(terminalPhoneHex);
  assert.equal(status.sampleCount, 2);
  assert.equal(status.lanes.channel1Video.rawTimestamp, "184467");
  assert.equal(status.lanes.channel2Video.rawTimestamp, "184468");
  assert.equal(status.lanes.channel1Audio.rawTimestamp, "184469");
  assert.equal(status.lanes.channel1Video.timestampNumberSafe, true);
  assert.deepEqual(status.rawOffsetsFromChannel1Video, {
    channel2Video: "1",
    channel1Audio: "2",
  });
  const monitorEvent = events.find(([, type]) =>
    type === "rtsp-media-source-timestamp-monitor");
  assert.ok(monitorEvent);
  assert.equal(monitorEvent[4].timestampSample.complete, true);
  assert.equal(
    monitorEvent[4].timestampSample.lanes.channel1Audio.rawTimestamp,
    "184469",
  );
});

test("uses JT1078 milliseconds rather than inferring scale from network delays", async () => {
  const terminalPhoneHex = "001200053180";
  const child = new FakeChild();
  const pipeline = createRtspMediaPipeline({
    rtspBaseUrl: "rtsp://mediamtx:8554",
    getCapabilities: () => ({
      audioEncoding: 19,
      audioChannels: 1,
      audioSampleRate: 0,
      videoEncoding: 99,
    }),
    getAudioEnabled: () => false,
    onEvent: () => {},
    spawnProcess: () => child,
  });

  for (let index = 0; index < 4; index += 1) {
    pipeline.pushFrame({
      terminalPhoneHex,
      channelNo: 1,
      kind: "video",
      dataType: index === 0 ? 0 : 1,
      timestampMs: 1000 + index * 40,
      body: Buffer.from([0x02, 0x01, 0x84]),
    });
    if (index < 3) {
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
  }

  const timing = pipeline.getStatus(terminalPhoneHex, 1).timing;
  assert.equal(timing.mode, "source-timestamp");
  assert.equal(timing.timestampScaleMsPerUnit, 1);
  pipeline.stopStreamFor(terminalPhoneHex, 1);
});

test("burst pacing keeps exact media timestamps even when the scheduler runs late", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100_000 });
  const child = new FakeChild();
  const pipeline = createRtspMediaPipeline({
    rtspBaseUrl: "rtsp://mediamtx:8554",
    jitterBufferMs: 100,
    sourceClockCalibrationSpanMs: 10,
    getAudioEnabled: () => false,
    getCapabilities: () => ({
      audioEncoding: 19, audioChannels: 1, audioSampleRate: 0, videoEncoding: 99,
    }),
    onEvent: () => {},
    spawnProcess: () => child,
  });
  t.after(() => pipeline.close());
  const frame = {
    terminalPhoneHex: "001200053180", channelNo: 1, kind: "video",
    lastFrameIntervalMs: 40, body: Buffer.from([0x26, 1, 0xaa]),
  };
  for (let index = 0; index < 4; index += 1) {
    pipeline.pushFrame({ ...frame, dataType: index === 0 ? 0 : 1, timestampMs: 1000 + 40 * index });
  }
  assert.equal(pipeline.getStatus(frame.terminalPhoneHex, 1).timing.timestampScaleMsPerUnit, 1);
  // Simulate a blocked event loop without moving the media deadlines.
  t.mock.timers.setTime(103_000);
  t.mock.timers.tick(1);
  assert.deepEqual(readTransportPts(child.stdio[3].read()), [99000, 102600, 106200, 109800]);
  pipeline.pushFrame({ ...frame, dataType: 1, timestampMs: 1160 });
  t.mock.timers.tick(1);
  assert.deepEqual(readTransportPts(child.stdio[3].read()), [113400]);
  assert.equal(pipeline.getStatus(frame.terminalPhoneHex, 1).mediaClock.corrections, 0);
});

test("explicit timestamp units and invalid source values are corrected before transport", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100_000 });
  const child = new FakeChild();
  const events = [];
  const pipeline = createRtspMediaPipeline({
    rtspBaseUrl: "rtsp://mediamtx:8554",
    timestampScaleMsPerUnit: 0.001,
    jitterBufferMs: 0,
    sourceClockCalibrationSpanMs: 10,
    getAudioEnabled: () => false,
    getCapabilities: () => ({
      audioEncoding: 19, audioChannels: 1, audioSampleRate: 0, videoEncoding: 99,
    }),
    onEvent: (_level, type) => events.push(type),
    spawnProcess: () => child,
  });
  t.after(() => pipeline.close());
  const frame = {
    terminalPhoneHex: "001200053180", channelNo: 1, kind: "video",
    lastFrameIntervalMs: 40, body: Buffer.from([0x26, 1, 0xaa]),
  };
  for (const [index, timestampMs] of [1000000, 1040000, 1080000, 1080000, 1070000, undefined, 30000000].entries()) {
    pipeline.pushFrame({ ...frame, dataType: index === 0 ? 0 : 1, timestampMs });
  }
  t.mock.timers.tick(300);
  assert.deepEqual(readTransportPts(child.stdio[3].read()), [90000, 93600, 97200, 100800, 104400, 108000, 111600]);
  const status = pipeline.getStatus(frame.terminalPhoneHex, 1);
  assert.equal(status.timing.timestampScaleMsPerUnit, 0.001);
  assert.equal(status.timing.invalidTimestampFrames, 4);
  assert.equal(status.mediaClock.corrections, 0);
  assert.equal(events.filter(type => type === "rtsp-media-source-timestamp-invalid").length, 4);
});

test("rejects invalid explicit timestamp unit settings", () => {
  for (const timestampScaleMsPerUnit of [NaN, Infinity, 0, -1, 0.0000001, 1001]) {
    assert.throws(() => createRtspMediaPipeline({
      rtspBaseUrl: "rtsp://mediamtx:8554", timestampScaleMsPerUnit,
      getCapabilities: () => null, onEvent: () => {},
    }), /timestampScaleMsPerUnit/);
  }
});

test("holds calibrated source frames for the configured jitter buffer", async () => {
  const terminalPhoneHex = "001200053180";
  const child = new FakeChild();
  let clockStartedAt;
  let firstVideoWriteAt;
  const pipeline = createRtspMediaPipeline({
    rtspBaseUrl: "rtsp://mediamtx:8554",
    jitterBufferMs: 250,
    // Valores explícitos para preservar o timing assumido por este teste,
    // independentemente dos defaults de produção (ver testes de calibração
    // dedicados mais abaixo).
    sourceClockCalibrationTimeoutMs: 500,
    sourceClockCalibrationSpanMs: 150,
    getCapabilities: () => ({
      audioEncoding: 19,
      audioChannels: 1,
      audioSampleRate: 0,
      videoEncoding: 99,
    }),
    onEvent: (_level, type) => {
      if (type === "rtsp-media-source-clock") {
        clockStartedAt = Date.now();
      }
    },
    spawnProcess: () => {
      const write = child.stdio[3].write.bind(child.stdio[3]);
      child.stdio[3].write = (...args) => {
        firstVideoWriteAt ??= Date.now();
        return write(...args);
      };
      return child;
    },
  });

  for (let index = 0; index <= 4; index += 1) {
    pipeline.pushFrame({
      terminalPhoneHex,
      channelNo: 1,
      kind: "video",
      dataType: index === 0 ? 0 : 1,
      timestampMs: 1000 + index * 50,
      body: Buffer.from([0x02, 0x01, 0x84]),
    });
    pipeline.pushFrame({
      terminalPhoneHex,
      channelNo: 1,
      kind: "audio",
      timestampMs: 21_000 + index * 50,
      body: Buffer.from([0x21, 0x10]),
    });
    if (index < 4) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  assert.ok(clockStartedAt);
  assert.equal(firstVideoWriteAt, undefined);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(firstVideoWriteAt, undefined);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.ok(firstVideoWriteAt);
  assert.ok(firstVideoWriteAt - clockStartedAt >= 220);
  assert.equal(
    pipeline.getStatus(terminalPhoneHex, 1).timing.jitterBufferMs,
    250,
  );
  pipeline.close();
});

test("rejects out-of-range source clock calibration options", () => {
  assert.throws(
    () =>
      createRtspMediaPipeline({
        rtspBaseUrl: "rtsp://mediamtx:8554",
        sourceClockCalibrationTimeoutMs: 50,
        getCapabilities: () => ({}),
        onEvent: () => {},
      }),
    RangeError,
  );
  assert.throws(
    () =>
      createRtspMediaPipeline({
        rtspBaseUrl: "rtsp://mediamtx:8554",
        sourceClockCalibrationSpanMs: 5,
        getCapabilities: () => ({}),
        onEvent: () => {},
      }),
    RangeError,
  );
  assert.throws(
    () =>
      createRtspMediaPipeline({
        rtspBaseUrl: "rtsp://mediamtx:8554",
        sourceClockCalibrationTimeoutMs: 500,
        sourceClockCalibrationSpanMs: 600,
        getCapabilities: () => ({}),
        onEvent: () => {},
      }),
    RangeError,
  );
});

test("calibrates with a shorter configured span when frames arrive close together", async () => {
  const terminalPhoneHex = "001200053180";
  const child = new FakeChild();
  let clockStartedAt;
  const startedAt = Date.now();
  const pipeline = createRtspMediaPipeline({
    rtspBaseUrl: "rtsp://mediamtx:8554",
    jitterBufferMs: 0,
    // Janela de calibração mais tolerante (como no default de produção),
    // permitindo calibrar com apenas ~80ms de amostras em vez de 150ms.
    sourceClockCalibrationTimeoutMs: 1_500,
    sourceClockCalibrationSpanMs: 80,
    getCapabilities: () => ({
      audioEncoding: 19,
      audioChannels: 1,
      audioSampleRate: 0,
      videoEncoding: 99,
    }),
    onEvent: (_level, type) => {
      if (type === "rtsp-media-source-clock") {
        clockStartedAt = Date.now();
      }
    },
    spawnProcess: () => child,
  });

  for (let index = 0; index <= 3; index += 1) {
    pipeline.pushFrame({
      terminalPhoneHex,
      channelNo: 1,
      kind: "video",
      dataType: index === 0 ? 0 : 1,
      timestampMs: 1000 + index * 50,
      body: Buffer.from([0x02, 0x01, 0x84]),
    });
    if (index < 3) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  assert.ok(clockStartedAt);
  assert.ok(clockStartedAt - startedAt < 500);
  pipeline.close();
});

test("anchors restarted channels to their own JT1078 timestamp origin", async () => {
  const terminalPhoneHex = "001200053180";
  const firstWriteAt = new Map();
  const pipeline = createRtspMediaPipeline({
    rtspBaseUrl: "rtsp://mediamtx:8554",
    jitterBufferMs: 0,
    getCapabilities: () => ({
      audioEncoding: 19,
      audioChannels: 1,
      audioSampleRate: 0,
      videoEncoding: 99,
    }),
    onEvent: () => {},
    spawnProcess: (_command, args) => {
      const channelNo = Number(args.at(-1).match(/channel-(\d+)$/)[1]);
      const child = new FakeChild();
      const write = child.stdio[3].write.bind(child.stdio[3]);
      child.stdio[3].write = (...writeArgs) => {
        firstWriteAt.set(channelNo, firstWriteAt.get(channelNo) ?? Date.now());
        return write(...writeArgs);
      };
      return child;
    },
  });

  for (let index = 0; index <= 4; index += 1) {
    for (const [channelNo, timestampOffset] of [[1, 0], [2, 500_000]]) {
      pipeline.pushFrame({
        terminalPhoneHex,
        channelNo,
        kind: "video",
        dataType: index === 0 ? 0 : 1,
        timestampMs: timestampOffset + 1000 + index * 50,
        body: Buffer.from([0x02, 0x01, 0x84]),
      });
    }
    if (index < 4) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(firstWriteAt.size, 2);
  assert.ok(Math.abs(firstWriteAt.get(1) - firstWriteAt.get(2)) < 100);
  assert.equal(
    pipeline.getStatus(terminalPhoneHex, 1).timing.syncClockScope,
    "stream-source-timestamp",
  );
  assert.equal(
    pipeline.getStatus(terminalPhoneHex, 2).timing.syncClockScope,
    "stream-source-timestamp",
  );
  pipeline.close();
});

test("aligns audio and video by arrival time when their source clocks are offset", async () => {
  const terminalPhoneHex = "001200053180";
  const firstWriteAt = new Map();
  const pipeline = createRtspMediaPipeline({
    rtspBaseUrl: "rtsp://mediamtx:8554",
    jitterBufferMs: 0,
    getCapabilities: () => ({
      audioEncoding: 19,
      audioChannels: 1,
      audioSampleRate: 0,
      videoEncoding: 99,
    }),
    onEvent: () => {},
    spawnProcess: () => {
      const child = new FakeChild();
      for (const [kind, index] of [["video", 3], ["audio", 4]]) {
        const input = child.stdio[index];
        const write = input.write.bind(input);
        input.write = (...args) => {
          firstWriteAt.set(kind, firstWriteAt.get(kind) ?? Date.now());
          return write(...args);
        };
      }
      return child;
    },
  });

  for (let index = 0; index <= 4; index += 1) {
    pipeline.pushFrame({
      terminalPhoneHex,
      channelNo: 1,
      kind: "audio",
      timestampMs: 21_000 + index * 50,
      body: Buffer.from([0x21, 0x10]),
    });
    pipeline.pushFrame({
      terminalPhoneHex,
      channelNo: 1,
      kind: "video",
      dataType: index === 0 ? 0 : 1,
      timestampMs: 1000 + index * 50,
      body: Buffer.from([0x02, 0x01, 0x84]),
    });
    if (index < 4) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(firstWriteAt.size, 2);
  assert.ok(Math.abs(firstWriteAt.get("video") - firstWriteAt.get("audio")) < 50);
  assert.ok(
    Math.abs(
      pipeline.getStatus(terminalPhoneHex, 1).timing.sourceAudioVideoOffsetMs,
    ) > 10_000,
  );
  pipeline.close();
});

test("keeps concurrent channel startup frames closely paced", async () => {
  const terminalPhoneHex = "001200053180";
  const writesByChannel = new Map();
  const childrenByChannel = new Map();
  const pipeline = createRtspMediaPipeline({
    rtspBaseUrl: "rtsp://mediamtx:8554",
    jitterBufferMs: 0,
    getCapabilities: () => ({
      audioEncoding: 19,
      audioChannels: 1,
      audioSampleRate: 0,
      videoEncoding: 99,
    }),
    onEvent: () => {},
    spawnProcess: (_command, args) => {
      const channelNo = Number(args.at(-1).match(/channel-(\d+)$/)[1]);
      const child = new FakeChild();
      const videoInput = child.stdio[3];
      const write = videoInput.write.bind(videoInput);
      videoInput.write = (...argsToWrite) => {
        const writes = writesByChannel.get(channelNo) ?? [];
        writes.push(Date.now());
        writesByChannel.set(channelNo, writes);
        return write(...argsToWrite);
      };
      childrenByChannel.set(channelNo, child);
      return child;
    },
  });

  for (const channelNo of [1, 2]) {
    pipeline.pushFrame({
      terminalPhoneHex,
      channelNo,
      kind: "video",
      dataType: 0,
      timestampMs: 1000,
      body: Buffer.from([0x26, 0x01, 0xaa]),
    });
  }
  for (let index = 1; index <= 4; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    for (const channelNo of [1, 2]) {
      pipeline.pushFrame({
        terminalPhoneHex,
        channelNo,
        kind: "video",
        dataType: 1,
        timestampMs: 1000 + index * 50,
        body: Buffer.from([0x02, 0x01, 0x84]),
      });
    }
      if (index < 4) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
  }
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.equal(writesByChannel.size, 2);
  assert.ok(
    Math.abs(
      writesByChannel.get(1)[0] - writesByChannel.get(2)[0],
    ) < 40,
  );
  const channelOneTiming = pipeline.getStatus(terminalPhoneHex, 1).timing;
  const channelTwoTiming = pipeline.getStatus(terminalPhoneHex, 2).timing;
  assert.equal(channelOneTiming.syncClockScope, "stream-source-timestamp");
  assert.equal(channelTwoTiming.syncClockScope, "stream-source-timestamp");
  assert.ok(
    Math.abs(
      channelOneTiming.timestampScaleMsPerUnit -
        channelTwoTiming.timestampScaleMsPerUnit,
    ) < 0.01,
  );
  assert.equal(
    channelOneTiming.sourceTimestampMs.video,
    channelTwoTiming.sourceTimestampMs.video,
  );
  pipeline.close();
  assert.equal(childrenByChannel.size, 2);
});

test("uses one transport PTS origin for separate channel video and audio publishers", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100_000 });
  const childrenByPath = new Map();
  const pipeline = createRtspMediaPipeline({
    rtspBaseUrl: "rtsp://mediamtx:8554",
    jitterBufferMs: 0,
    sourceClockCalibrationTimeoutMs: 500,
    separateAudio: true,
    getAudioEnabled: () => true,
    getCapabilities: () => ({
      audioEncoding: 19,
      audioChannels: 1,
      audioSampleRate: 0,
      videoEncoding: 99,
    }),
    onEvent: () => {},
    spawnProcess: (_command, args) => {
      const path = args.at(-1).match(/(audio|channel-(\d+))$/);
      const key = path[1] === "audio" ? "audio" : Number(path[2]);
      const child = new FakeChild();
      childrenByPath.set(key, child);
      return child;
    },
  });
  t.after(() => pipeline.close());

  const frame = {
    terminalPhoneHex: "001200053180",
    kind: "video",
    dataType: 0,
    timestampMs: null,
    body: Buffer.from([0x26, 0x01, 0xaa]),
  };
  pipeline.pushFrame({ ...frame, channelNo: 1 });
  pipeline.pushFrame({
    terminalPhoneHex: frame.terminalPhoneHex,
    channelNo: 1,
    kind: "audio",
    timestampMs: null,
    body: Buffer.from([0x21, 0x10]),
  });
  t.mock.timers.tick(500);
  const channelOnePts = readTransportPts(childrenByPath.get(1).stdio[3].read());
  const channelOneClock = pipeline.getStatus(frame.terminalPhoneHex, 1).mediaClock;

  t.mock.timers.setTime(100_600);
  pipeline.pushFrame({ ...frame, channelNo: 2 });
  t.mock.timers.tick(500);
  const channelTwoPts = readTransportPts(childrenByPath.get(2).stdio[3].read());
  const audioPts = readTransportPts(childrenByPath.get("audio").stdio[3].read());
  const channelTwoClock = pipeline.getStatus(frame.terminalPhoneHex, 2).mediaClock;

  assert.equal(channelOneClock.syncClockScope, "terminal-shared-transport");
  assert.equal(channelTwoClock.syncClockScope, "terminal-shared-transport");
  assert.equal(channelOneClock.originAtMs, 100_000);
  assert.equal(channelTwoClock.originAtMs, channelOneClock.originAtMs);
  assert.equal(channelOnePts[0], 135_000);
  assert.equal(audioPts[0], channelOnePts[0]);
  assert.equal(channelTwoPts[0], 189_000);
});

test("forces a calibrated channel back to arrival-fallback when its sibling channel gives up", async () => {
  const terminalPhoneHex = "001200053180";
  const childrenByChannel = new Map();
  const pipeline = createRtspMediaPipeline({
    rtspBaseUrl: "rtsp://mediamtx:8554",
    jitterBufferMs: 0,
    sourceClockCalibrationTimeoutMs: 150,
    sourceClockCalibrationSpanMs: 10,
    getCapabilities: () => ({
      audioEncoding: 19,
      audioChannels: 1,
      audioSampleRate: 0,
      videoEncoding: 99,
    }),
    onEvent: () => {},
    spawnProcess: (_command, args) => {
      const channelNo = Number(args.at(-1).match(/channel-(\d+)$/)[1]);
      const child = new FakeChild();
      childrenByChannel.set(channelNo, child);
      return child;
    },
  });

  // Canal 1: frames bem espaçados e com timestamps crescentes; calibra para
  // source-timestamp bem dentro da janela de 150ms configurada acima.
  for (let index = 0; index <= 3; index += 1) {
    pipeline.pushFrame({
      terminalPhoneHex,
      channelNo: 1,
      kind: "video",
      dataType: index === 0 ? 0 : 1,
      timestampMs: 1000 + index * 20,
      body: Buffer.from([0x02, 0x01, 0x84]),
    });
    if (index < 3) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  assert.equal(
    pipeline.getStatus(terminalPhoneHex, 1).timing.mode,
    "source-timestamp",
  );

  // Canal 2: apenas um quadro-chave; sem mais quadros chegando, o timer de
  // calibração expira e o canal cai para arrival-fallback.
  pipeline.pushFrame({
    terminalPhoneHex,
    channelNo: 2,
    kind: "video",
    dataType: 0,
    timestampMs: 1000,
    body: Buffer.from([0x26, 0x01, 0xaa]),
  });
  assert.equal(
    pipeline.getStatus(terminalPhoneHex, 2).timing.mode,
    "calibrating",
  );

  await new Promise((resolve) => setTimeout(resolve, 250));

  assert.equal(
    pipeline.getStatus(terminalPhoneHex, 2).timing.mode,
    "arrival-fallback",
  );
  // O canal 1, mesmo já calibrado, deve ser forçado de volta a
  // arrival-fallback para não ficar em um modo de relógio diferente do
  // canal irmão, evitando a dessincronização entre canais 1 e 2.
  assert.equal(
    pipeline.getStatus(terminalPhoneHex, 1).timing.mode,
    "arrival-fallback",
  );

  pipeline.close();
  assert.equal(childrenByChannel.size, 2);
});

test("strict arrival holds all three media lanes until both videos and audio align", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100_000 });
  const terminalPhoneHex = "001200053180";
  const childrenByPath = new Map();
  const events = [];
  const pipeline = createRtspMediaPipeline({
    rtspBaseUrl: "rtsp://mediamtx:8554",
    syncMode: "strict-arrival",
    syncToleranceMs: 250,
    jitterBufferMs: 0,
    separateAudio: true,
    getAudioEnabled: () => true,
    getCapabilities: () => ({
      audioEncoding: 19,
      audioChannels: 1,
      audioSampleRate: 0,
      videoEncoding: 99,
    }),
    onEvent: (...event) => events.push(event),
    spawnProcess: (_command, args) => {
      const path = args.at(-1).split("/").at(-1);
      const child = new FakeChild();
      childrenByPath.set(path, child);
      return child;
    },
  });
  t.after(() => pipeline.close());

  const videoFrame = (channelNo, dataType = 0) => ({
    terminalPhoneHex,
    channelNo,
    kind: "video",
    dataType,
    timestampMs: Date.now(),
    timestampRaw: String(Date.now()),
    lastFrameIntervalMs: 40,
    body: Buffer.from([0x26, 0x01, 0xaa]),
  });
  const audioFrame = () => ({
    terminalPhoneHex,
    channelNo: 1,
    kind: "audio",
    timestampMs: Date.now(),
    timestampRaw: String(Date.now()),
    body: Buffer.from([0x21, 0x10]),
  });
  const readInputBytes = (path) =>
    childrenByPath.get(path)?.stdio[3].read()?.length ?? 0;
  const channelOnePath = getRtspStreamPath(terminalPhoneHex, 1);
  const channelTwoPath = getRtspStreamPath(terminalPhoneHex, 2);
  const audioPath = getRtspAudioPath(terminalPhoneHex);

  pipeline.pushFrame(videoFrame(1));
  pipeline.pushFrame(audioFrame());
  t.mock.timers.tick(1);
  assert.equal(readInputBytes(channelOnePath), 0);
  assert.equal(readInputBytes(audioPath), 0);
  assert.equal(
    pipeline.getStatus(terminalPhoneHex, 1).syncStatus.state,
    "holding",
  );

  t.mock.timers.tick(300);
  pipeline.pushFrame(videoFrame(2));
  pipeline.pushFrame(videoFrame(1));
  pipeline.pushFrame(audioFrame());
  pipeline.pushFrame(videoFrame(2, 1));
  assert.equal(
    pipeline.getStatus(terminalPhoneHex, 1).syncStatus.state,
    "holding",
  );
  t.mock.timers.tick(130);
  assert.ok(readInputBytes(channelOnePath) > 0);
  assert.ok(readInputBytes(channelTwoPath) > 0);
  assert.ok(readInputBytes(audioPath) > 0);
  assert.equal(
    pipeline.getStatus(terminalPhoneHex, 1).syncStatus.state,
    "aligned",
  );
  assert.equal(
    pipeline.getStatus(terminalPhoneHex, 1).mediaClock.syncClockScope,
    "terminal-strict-source-transport",
  );

  for (const path of [channelOnePath, channelTwoPath, audioPath]) {
    childrenByPath.get(path)?.stdio[3].read();
  }
  t.mock.timers.tick(300);
  pipeline.pushFrame(videoFrame(1, 1));
  pipeline.pushFrame(audioFrame());
  t.mock.timers.tick(50);
  assert.equal(readInputBytes(channelOnePath), 0);
  assert.equal(readInputBytes(audioPath), 0);
  assert.equal(readInputBytes(channelTwoPath), 0);
  assert.equal(
    pipeline.getStatus(terminalPhoneHex, 1).syncStatus.state,
    "holding",
  );

  t.mock.timers.tick(20);
  pipeline.pushFrame(videoFrame(1));
  pipeline.pushFrame(audioFrame());
  pipeline.pushFrame(videoFrame(2));
  t.mock.timers.tick(1);
  assert.ok(readInputBytes(channelOnePath) > 0);
  assert.ok(readInputBytes(channelTwoPath) > 0);
  t.mock.timers.tick(60);
  assert.ok(readInputBytes(audioPath) > 0);
  assert.ok(events.some(([, event]) => event === "rtsp-media-sync-hold"));
  assert.ok(events.some(([, event]) => event === "rtsp-media-sync-resumed"));
});

test("bounded sync releases all outputs after the hold limit and realigns", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100_000 });
  const terminalPhoneHex = "001200053180";
  const childrenByPath = new Map();
  const events = [];
  const pipeline = createRtspMediaPipeline({
    rtspBaseUrl: "rtsp://mediamtx:8554",
    syncMode: "bounded-sync",
    syncToleranceMs: 250,
    syncHoldTimeoutMs: 250,
    jitterBufferMs: 0,
    separateAudio: true,
    getAudioEnabled: () => true,
    getCapabilities: () => ({
      audioEncoding: 19,
      audioChannels: 1,
      audioSampleRate: 3,
      videoEncoding: 99,
    }),
    onEvent: (...event) => events.push(event),
    spawnProcess: (_command, args) => {
      const path = args.at(-1).split("/").at(-1);
      const child = new FakeChild();
      childrenByPath.set(path, child);
      return child;
    },
  });
  t.after(() => pipeline.close());

  const videoFrame = (channelNo) => ({
    terminalPhoneHex,
    channelNo,
    kind: "video",
    dataType: 0,
    timestampMs: Date.now(),
    timestampRaw: String(Date.now()),
    body: Buffer.from([0x26, 0x01, 0xaa]),
  });
  const audioFrame = () => ({
    terminalPhoneHex,
    channelNo: 1,
    kind: "audio",
    timestampMs: Date.now(),
    timestampRaw: String(Date.now()),
    body: Buffer.from([0x21, 0x10]),
  });
  const channelOnePath = getRtspStreamPath(terminalPhoneHex, 1);
  const channelTwoPath = getRtspStreamPath(terminalPhoneHex, 2);
  const audioPath = getRtspAudioPath(terminalPhoneHex);
  const readInputBytes = (path) =>
    childrenByPath.get(path)?.stdio[3].read()?.length ?? 0;

  pipeline.pushFrame(videoFrame(1));
  pipeline.pushFrame(videoFrame(2));
  pipeline.pushFrame(audioFrame());
  t.mock.timers.tick(1);
  for (const path of [channelOnePath, channelTwoPath, audioPath]) {
    assert.ok(readInputBytes(path) > 0);
  }

  t.mock.timers.tick(301);
  pipeline.pushFrame(videoFrame(1));
  pipeline.pushFrame(videoFrame(2));
  t.mock.timers.tick(1);
  assert.equal(
    pipeline.getStatus(terminalPhoneHex, 1).syncStatus.state,
    "holding",
  );
  assert.equal(readInputBytes(channelOnePath), 0);
  assert.equal(readInputBytes(channelTwoPath), 0);
  assert.ok(
    pipeline.getStatus(terminalPhoneHex, 1).timing.queuedFrames > 0,
  );
  assert.ok(
    pipeline.getStatus(terminalPhoneHex, 2).timing.queuedFrames > 0,
  );

  t.mock.timers.tick(50);
  pipeline.pushFrame(audioFrame());
  t.mock.timers.tick(1);
  assert.equal(
    pipeline.getStatus(terminalPhoneHex, 1).syncStatus.state,
    "aligned",
  );
  for (const path of [channelOnePath, channelTwoPath, audioPath]) {
    assert.ok(readInputBytes(path) > 0);
  }

  t.mock.timers.tick(301);
  pipeline.pushFrame(videoFrame(1));
  pipeline.pushFrame(videoFrame(2));
  t.mock.timers.tick(1);
  assert.equal(
    pipeline.getStatus(terminalPhoneHex, 1).syncStatus.state,
    "holding",
  );
  assert.equal(readInputBytes(channelOnePath), 0);
  assert.equal(readInputBytes(channelTwoPath), 0);
  t.mock.timers.tick(250);
  assert.equal(
    pipeline.getStatus(terminalPhoneHex, 1).syncStatus.state,
    "degraded",
  );
  pipeline.pushFrame(videoFrame(1));
  pipeline.pushFrame(videoFrame(2));
  t.mock.timers.tick(1);
  assert.equal(
    pipeline.getStatus(terminalPhoneHex, 1).syncStatus.state,
    "degraded",
  );
  assert.ok(readInputBytes(channelOnePath) > 0);
  assert.ok(readInputBytes(channelTwoPath) > 0);
  const degradedStatus = pipeline.getStatus(terminalPhoneHex, 1).syncStatus;
  assert.equal(degradedStatus.fallbackCount, 1);
  assert.equal(degradedStatus.holdDurationMs, null);
  assert.ok(events.some(([, event]) => event === "rtsp-media-sync-fallback"));

  pipeline.pushFrame({
    ...videoFrame(1),
    dataType: 1,
    timestampMs: null,
    timestampRaw: null,
  });
  t.mock.timers.tick(50);
  assert.ok(
    readInputBytes(channelOnePath) > 0,
    JSON.stringify(pipeline.getStatus(terminalPhoneHex, 1)),
  );
  assert.ok(
    pipeline.getStatus(terminalPhoneHex, 1).timing.invalidTimestampFrames > 0,
  );

  const preRecoveryClocks = {
    channelOne: pipeline.getStatus(terminalPhoneHex, 1).mediaClock,
    channelTwo: pipeline.getStatus(terminalPhoneHex, 2).mediaClock,
  };
  pipeline.pushFrame(videoFrame(1));
  pipeline.pushFrame(videoFrame(2));
  pipeline.pushFrame(audioFrame());
  t.mock.timers.tick(1);
  assert.equal(
    pipeline.getStatus(terminalPhoneHex, 1).syncStatus.state,
    "aligned",
  );
  const recoveredSyncStatus = pipeline.getStatus(
    terminalPhoneHex,
    1,
  ).syncStatus;
  assert.ok(
    recoveredSyncStatus.lastFallbackDurationMs <=
      recoveredSyncStatus.holdTimeoutMs + 1,
    JSON.stringify(recoveredSyncStatus),
  );
  assert.ok(readInputBytes(channelOnePath) > 0);
  assert.ok(readInputBytes(channelTwoPath) > 0);
  assert.ok(readInputBytes(audioPath) > 0);
  const postRecoveryClocks = {
    channelOne: pipeline.getStatus(terminalPhoneHex, 1).mediaClock,
    channelTwo: pipeline.getStatus(terminalPhoneHex, 2).mediaClock,
  };
  assert.ok(
    postRecoveryClocks.channelOne.lastVideo90k >
      preRecoveryClocks.channelOne.lastVideo90k,
  );
  assert.ok(
    postRecoveryClocks.channelTwo.lastVideo90k >
      preRecoveryClocks.channelTwo.lastVideo90k,
  );
  assert.ok(
    postRecoveryClocks.channelOne.lastAudio90k >
      preRecoveryClocks.channelOne.lastAudio90k,
  );
  assert.ok(events.some(([, event]) => event === "rtsp-media-sync-resumed"));
});

test("strict sync uses shared raw timestamps when channel arrivals are offset", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100_000 });
  const terminalPhoneHex = "001200053180";
  const childrenByPath = new Map();
  const pipeline = createRtspMediaPipeline({
    rtspBaseUrl: "rtsp://mediamtx:8554",
    syncMode: "strict-arrival",
    syncToleranceMs: 250,
    jitterBufferMs: 150,
    separateAudio: true,
    getAudioEnabled: () => true,
    getCapabilities: () => ({
      audioEncoding: 19,
      audioChannels: 1,
      audioSampleRate: 3,
      videoEncoding: 99,
    }),
    onEvent: () => {},
    spawnProcess: (_command, args) => {
      const path = args.at(-1).split("/").at(-1);
      const child = new FakeChild();
      childrenByPath.set(path, child);
      return child;
    },
  });
  t.after(() => pipeline.close());

  const videoFrame = (channelNo) => ({
    terminalPhoneHex,
    channelNo,
    kind: "video",
    dataType: 0,
    timestampMs: 500_000,
    timestampRaw: "500000",
    body: Buffer.from([0x26, 0x01, 0xaa]),
  });
  const audioFrame = () => ({
    terminalPhoneHex,
    channelNo: 1,
    kind: "audio",
    timestampMs: 500_000,
    timestampRaw: "500000",
    body: Buffer.from([0x21, 0x10]),
  });
  const paths = [
    getRtspStreamPath(terminalPhoneHex, 1),
    getRtspStreamPath(terminalPhoneHex, 2),
    getRtspAudioPath(terminalPhoneHex),
  ];

  pipeline.pushFrame(videoFrame(1));
  pipeline.pushFrame(audioFrame());
  t.mock.timers.tick(100);
  pipeline.pushFrame(videoFrame(2));
  const syncStatus = pipeline.getStatus(terminalPhoneHex, 1).syncStatus;
  assert.equal(syncStatus.arrivalSkewMs, 100);
  assert.equal(syncStatus.sourceTimestampSkewMs, 0);
  t.mock.timers.tick(50);

  for (const path of paths) {
    assert.ok(childrenByPath.get(path)?.stdio[3].read()?.length > 0, path);
  }
  const channelOneClock = pipeline.getStatus(terminalPhoneHex, 1).mediaClock;
  const channelTwoClock = pipeline.getStatus(terminalPhoneHex, 2).mediaClock;
  assert.equal(channelOneClock.lastVideo90k, channelTwoClock.lastVideo90k);
  assert.equal(channelOneClock.lastVideo90k, channelOneClock.lastAudio90k);
  assert.equal(
    pipeline.getStatus(terminalPhoneHex, 1).mediaClock.syncClockScope,
    "terminal-strict-source-transport",
  );
});

test("strict sync rebases a late keyframe and resumes all three publishers", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100_000 });
  const terminalPhoneHex = "001200053180";
  const childrenByPath = new Map();
  const events = [];
  const pipeline = createRtspMediaPipeline({
    rtspBaseUrl: "rtsp://mediamtx:8554",
    syncMode: "strict-arrival",
    syncToleranceMs: 1_000,
    jitterBufferMs: 100,
    separateAudio: true,
    getAudioEnabled: () => true,
    getCapabilities: () => ({
      audioEncoding: 19,
      audioChannels: 1,
      audioSampleRate: 3,
      videoEncoding: 99,
    }),
    onEvent: (...event) => events.push(event),
    spawnProcess: (_command, args) => {
      const path = args.at(-1).split("/").at(-1);
      const child = new FakeChild();
      childrenByPath.set(path, child);
      return child;
    },
  });
  t.after(() => pipeline.close());

  const videoFrame = (channelNo) => ({
    terminalPhoneHex,
    channelNo,
    kind: "video",
    dataType: 0,
    timestampMs: 1_000_000,
    timestampRaw: "1000000",
    body: Buffer.from([0x26, 0x01, 0xaa]),
  });
  const audioFrame = () => ({
    terminalPhoneHex,
    channelNo: 1,
    kind: "audio",
    timestampMs: 1_000_000,
    timestampRaw: "1000000",
    body: Buffer.from([0x21, 0x10]),
  });
  const channelOnePath = getRtspStreamPath(terminalPhoneHex, 1);
  const channelTwoPath = getRtspStreamPath(terminalPhoneHex, 2);
  const audioPath = getRtspAudioPath(terminalPhoneHex);

  pipeline.pushFrame(videoFrame(1));
  pipeline.pushFrame(videoFrame(2));
  pipeline.pushFrame(audioFrame());
  t.mock.timers.setTime(100_900);
  t.mock.timers.tick(1);
  assert.ok(events.some(([, event]) =>
    event === "rtsp-media-source-timeline-rebased"));
  assert.equal(
    pipeline.getStatus(terminalPhoneHex, 1).syncStatus.sourceTimelineRebaseCount,
    1,
  );
  t.mock.timers.tick(100);

  for (const path of [channelOnePath, channelTwoPath, audioPath]) {
    const bytes = childrenByPath.get(path)?.stdio[3].read();
    assert.ok(bytes?.length > 0, path);
    assert.ok(readTransportPts(bytes).length > 0, path);
  }
  const channelOneClock = pipeline.getStatus(terminalPhoneHex, 1).mediaClock;
  const channelTwoClock = pipeline.getStatus(terminalPhoneHex, 2).mediaClock;
  const audioClock = pipeline.getAudioStatus(terminalPhoneHex).mediaClock;
  assert.equal(channelOneClock.lastVideo90k, channelTwoClock.lastVideo90k);
  assert.equal(channelOneClock.lastVideo90k, audioClock.lastAudio90k);
});

test("strict sync recenters an ahead-of-live source timeline at a keyframe", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100_000 });
  const terminalPhoneHex = "001200053180";
  const childrenByPath = new Map();
  const events = [];
  const pipeline = createRtspMediaPipeline({
    rtspBaseUrl: "rtsp://mediamtx:8554",
    syncMode: "strict-arrival",
    syncToleranceMs: 1_000,
    jitterBufferMs: 100,
    separateAudio: true,
    getAudioEnabled: () => true,
    getCapabilities: () => ({
      audioEncoding: 19,
      audioChannels: 1,
      audioSampleRate: 3,
      videoEncoding: 99,
    }),
    onEvent: (...event) => events.push(event),
    spawnProcess: (_command, args) => {
      const path = args.at(-1).split("/").at(-1);
      const child = new FakeChild();
      childrenByPath.set(path, child);
      return child;
    },
  });
  t.after(() => pipeline.close());

  const videoFrame = (channelNo, timestamp, dataType = 0) => ({
    terminalPhoneHex,
    channelNo,
    kind: "video",
    dataType,
    timestampMs: Number(timestamp),
    timestampRaw: timestamp,
    body: Buffer.from([0x26, 0x01, 0xaa]),
  });
  const audioFrame = (timestamp) => ({
    terminalPhoneHex,
    channelNo: 1,
    kind: "audio",
    timestampMs: Number(timestamp),
    timestampRaw: timestamp,
    body: Buffer.from([0x21, 0x10]),
  });
  const paths = [
    getRtspStreamPath(terminalPhoneHex, 1),
    getRtspStreamPath(terminalPhoneHex, 2),
    getRtspAudioPath(terminalPhoneHex),
  ];

  pipeline.pushFrame(videoFrame(1, "1000000"));
  pipeline.pushFrame(videoFrame(2, "1000000"));
  pipeline.pushFrame(audioFrame("1000000"));
  t.mock.timers.setTime(100_900);
  t.mock.timers.tick(1);
  t.mock.timers.tick(100);
  for (const path of paths) {
    assert.ok(childrenByPath.get(path)?.stdio[3].read()?.length > 0, path);
  }

  pipeline.pushFrame(videoFrame(1, "1001500"));
  pipeline.pushFrame(videoFrame(2, "1001500"));
  pipeline.pushFrame(audioFrame("1001500"));
  assert.equal(
    pipeline.getStatus(terminalPhoneHex, 1).syncStatus.sourceTimestampSkewMs,
    0,
  );
  t.mock.timers.tick(100);

  const ptsByPath = paths.map((path) => {
    const bytes = childrenByPath.get(path)?.stdio[3].read();
    assert.ok(
      bytes?.length > 0,
      JSON.stringify({
        path,
        syncStatus: pipeline.getStatus(terminalPhoneHex, 1).syncStatus,
        channelOneTiming: pipeline.getStatus(terminalPhoneHex, 1).timing,
        channelTwoTiming: pipeline.getStatus(terminalPhoneHex, 2).timing,
        audioTiming: pipeline.getAudioStatus(terminalPhoneHex).timing,
        events: events.map(([, event]) => event),
      }),
    );
    return readTransportPts(bytes)[0];
  });
  assert.ok(Math.max(...ptsByPath) - Math.min(...ptsByPath) <= 22_500);
  const syncStatus = pipeline.getStatus(terminalPhoneHex, 1).syncStatus;
  assert.equal(syncStatus.state, "aligned");
  assert.equal(syncStatus.sourceTimelineRebaseCount, 2);
  assert.ok(events.some(([, event, , , details]) =>
    event === "rtsp-media-source-timeline-rebased" &&
    details.direction === "backward"));
});

test("strict sync realigns a lane with an offset source timestamp", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100_000 });
  const terminalPhoneHex = "001200053180";
  const pipeline = createRtspMediaPipeline({
    rtspBaseUrl: "rtsp://mediamtx:8554",
    syncMode: "strict-arrival",
    syncToleranceMs: 250,
    jitterBufferMs: 0,
    separateAudio: true,
    getAudioEnabled: () => true,
    getCapabilities: () => ({
      audioEncoding: 19,
      audioChannels: 1,
      audioSampleRate: 3,
      videoEncoding: 99,
    }),
    onEvent: () => {},
    spawnProcess: () => new FakeChild(),
  });
  t.after(() => pipeline.close());

  const videoFrame = (channelNo, timestamp) => ({
    terminalPhoneHex,
    channelNo,
    kind: "video",
    dataType: 0,
    timestampMs: Number(timestamp),
    timestampRaw: timestamp,
    body: Buffer.from([0x26, 0x01, 0xaa]),
  });
  const audioFrame = (timestamp) => ({
    terminalPhoneHex,
    channelNo: 1,
    kind: "audio",
    timestampMs: Number(timestamp),
    timestampRaw: timestamp,
    body: Buffer.from([0x21, 0x10]),
  });

  pipeline.pushFrame(videoFrame(1, "1000000"));
  pipeline.pushFrame(videoFrame(2, "1000000"));
  pipeline.pushFrame(audioFrame("1000000"));
  pipeline.pushFrame(videoFrame(1, "1000100"));
  pipeline.pushFrame(videoFrame(2, "1000100"));
  pipeline.pushFrame(audioFrame("1000700"));

  const syncStatus = pipeline.getStatus(terminalPhoneHex, 1).syncStatus;
  assert.equal(syncStatus.sourceTimestampSkewMs, 0);
  assert.equal(syncStatus.timestampAlignmentCountByLane.audio, 1);
  assert.equal(syncStatus.sourceTimestampOffsetsMs.audio, -600);
});

test("strict sync ignores a transient shared clock-rate change", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100_000 });
  const terminalPhoneHex = "001200053180";
  const pipeline = createRtspMediaPipeline({
    rtspBaseUrl: "rtsp://mediamtx:8554",
    syncMode: "strict-arrival",
    syncToleranceMs: 250,
    jitterBufferMs: 100,
    separateAudio: true,
    getAudioEnabled: () => true,
    getCapabilities: () => ({
      audioEncoding: 19,
      audioChannels: 1,
      audioSampleRate: 3,
      videoEncoding: 99,
    }),
    onEvent: () => {},
    spawnProcess: () => new FakeChild(),
  });
  t.after(() => pipeline.close());

  const pushSample = (timestamp) => {
    for (const channelNo of [1, 2]) {
      pipeline.pushFrame({
        terminalPhoneHex,
        channelNo,
        kind: "video",
        dataType: 0,
        timestampMs: timestamp,
        timestampRaw: String(timestamp),
        body: Buffer.from([0x26, 0x01, 0xaa]),
      });
    }
    pipeline.pushFrame({
      terminalPhoneHex,
      channelNo: 1,
      kind: "audio",
      timestampMs: timestamp,
      timestampRaw: String(timestamp),
      body: Buffer.from([0x21, 0x10]),
    });
  };

  pushSample(1_000_000);
  t.mock.timers.tick(5_000);
  pushSample(1_003_500);
  assert.equal(
    pipeline.getStatus(terminalPhoneHex, 1).syncStatus.sourceClockScaleUpdateCount,
    0,
  );
  assert.equal(
    pipeline.getStatus(terminalPhoneHex, 1).syncStatus.sourceClockScaleMsPerUnit,
    1,
  );

  t.mock.timers.tick(5_000);
  pushSample(1_008_500);
  t.mock.timers.tick(5_000);
  pushSample(1_013_500);
  assert.equal(
    pipeline.getStatus(terminalPhoneHex, 1).syncStatus.sourceClockScaleUpdateCount,
    0,
  );
  assert.equal(
    pipeline.getStatus(terminalPhoneHex, 1).syncStatus.sourceClockScaleMsPerUnit,
    1,
  );
});

test("strict sync corrects a stable shared source clock rate that runs ahead of arrival", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100_000 });
  const terminalPhoneHex = "001200053180";
  const otherTerminalPhoneHex = "001200053181";
  const childrenByPath = new Map();
  const pipeline = createRtspMediaPipeline({
    rtspBaseUrl: "rtsp://mediamtx:8554",
    syncMode: "strict-arrival",
    syncToleranceMs: 250,
    jitterBufferMs: 100,
    separateAudio: true,
    getAudioEnabled: () => true,
    getCapabilities: () => ({
      audioEncoding: 19,
      audioChannels: 1,
      audioSampleRate: 3,
      videoEncoding: 99,
    }),
    onEvent: () => {},
    spawnProcess: (_command, args) => {
      const path = args.at(-1).split("/").at(-1);
      const child = new FakeChild();
      childrenByPath.set(path, child);
      return child;
    },
  });
  t.after(() => pipeline.close());

  pipeline.pushFrame({
    terminalPhoneHex: otherTerminalPhoneHex,
    channelNo: 1,
    kind: "video",
    dataType: 0,
    timestampMs: 1_000_000,
    timestampRaw: "1000000",
    body: Buffer.from([0x26, 0x01, 0xaa]),
  });

  for (let tick = 0; tick <= 110; tick += 1) {
    const timestamp = String(1_000_000 + tick * 108);
    for (const channelNo of [1, 2]) {
      pipeline.pushFrame({
        terminalPhoneHex,
        channelNo,
        kind: "video",
        dataType: 0,
        timestampMs: Number(timestamp),
        timestampRaw: timestamp,
        body: Buffer.from([0x26, 0x01, 0xaa]),
      });
    }
    pipeline.pushFrame({
      terminalPhoneHex,
      channelNo: 1,
      kind: "audio",
      timestampMs: Number(timestamp),
      timestampRaw: timestamp,
      body: Buffer.from([0x21, 0x10]),
    });
    t.mock.timers.tick(100);
  }

  const syncStatus = pipeline.getStatus(terminalPhoneHex, 1).syncStatus;
  assert.equal(syncStatus.sourceClockScaleUpdateCount, 1);
  assert.ok(Math.abs(syncStatus.sourceClockScaleMsPerUnit - 1000 / 1080) < 0.01);
  assert.equal(
    pipeline.getStatus(otherTerminalPhoneHex, 1).timing.timestampScaleMsPerUnit,
    1,
  );
  for (const lane of ["video-1", "video-2", "audio"]) {
    assert.ok(Math.abs(syncStatus.sourceClockRateByLane[lane] - 1080) < 1);
  }
  assert.ok(syncStatus.sourceTimestampSkewMs <= 250);
  for (const channelNo of [1, 2]) {
    assert.ok(pipeline.getStatus(terminalPhoneHex, channelNo).videoFrames > 0);
  }
  assert.ok(pipeline.getAudioStatus(terminalPhoneHex).audioFrames > 0);
});

test("strict sync rebases a lane after a raw timestamp reset", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100_000 });
  const terminalPhoneHex = "001200053180";
  const childrenByPath = new Map();
  const events = [];
  const pipeline = createRtspMediaPipeline({
    rtspBaseUrl: "rtsp://mediamtx:8554",
    syncMode: "strict-arrival",
    syncToleranceMs: 250,
    jitterBufferMs: 0,
    separateAudio: true,
    getAudioEnabled: () => true,
    getCapabilities: () => ({
      audioEncoding: 19,
      audioChannels: 1,
      audioSampleRate: 3,
      videoEncoding: 99,
    }),
    onEvent: (...event) => events.push(event),
    spawnProcess: (_command, args) => {
      const path = args.at(-1).split("/").at(-1);
      const child = new FakeChild();
      childrenByPath.set(path, child);
      return child;
    },
  });
  t.after(() => pipeline.close());

  const videoFrame = (channelNo, timestamp) => ({
    terminalPhoneHex,
    channelNo,
    kind: "video",
    dataType: 0,
    timestampMs: Number(timestamp),
    timestampRaw: timestamp,
    body: Buffer.from([0x26, 0x01, 0xaa]),
  });
  const audioFrame = (timestamp) => ({
    terminalPhoneHex,
    channelNo: 1,
    kind: "audio",
    timestampMs: Number(timestamp),
    timestampRaw: timestamp,
    body: Buffer.from([0x21, 0x10]),
  });

  pipeline.pushFrame(videoFrame(1, "1000000"));
  pipeline.pushFrame(videoFrame(2, "1000000"));
  pipeline.pushFrame(audioFrame("1000000"));
  t.mock.timers.tick(1);
  t.mock.timers.tick(100);
  pipeline.pushFrame(videoFrame(1, "1000100"));
  pipeline.pushFrame(audioFrame("1000100"));
  pipeline.pushFrame(videoFrame(2, "5"));
  t.mock.timers.tick(1);

  const syncStatus = pipeline.getStatus(terminalPhoneHex, 1).syncStatus;
  assert.equal(syncStatus.state, "aligned");
  assert.equal(syncStatus.sourceTimestampSkewMs, 0);
  assert.ok(events.some(([, event, , , details]) =>
    event === "rtsp-media-source-clock-reset" &&
    details.lane === "video-2" &&
    details.resetCount === 1));
  assert.equal(
    pipeline.getStatus(terminalPhoneHex, 1).mediaClock.lastVideo90k,
    pipeline.getStatus(terminalPhoneHex, 2).mediaClock.lastVideo90k,
  );
});

test("strict arrival holds both videos during a prolonged audio dropout", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100_000 });
  const terminalPhoneHex = "001200053180";
  const childrenByPath = new Map();
  const events = [];
  const pipeline = createRtspMediaPipeline({
    rtspBaseUrl: "rtsp://mediamtx:8554",
    syncMode: "strict-arrival",
    syncToleranceMs: 250,
    jitterBufferMs: 0,
    audioArrivalTimeoutMs: 100,
    separateAudio: true,
    getAudioEnabled: () => true,
    getCapabilities: () => ({
      audioEncoding: 19,
      audioChannels: 1,
      audioSampleRate: 0,
      videoEncoding: 99,
    }),
    onEvent: (...event) => events.push(event),
    spawnProcess: (_command, args) => {
      const path = args.at(-1).split("/").at(-1);
      const child = new FakeChild();
      childrenByPath.set(path, child);
      return child;
    },
  });
  t.after(() => pipeline.close());

  const videoFrame = (channelNo) => ({
    terminalPhoneHex,
    channelNo,
    kind: "video",
    dataType: 0,
    timestampMs: Date.now(),
    timestampRaw: String(Date.now()),
    lastFrameIntervalMs: 40,
    body: Buffer.from([0x26, 0x01, 0xaa]),
  });
  const audioFrame = () => ({
    terminalPhoneHex,
    channelNo: 1,
    kind: "audio",
    timestampMs: Date.now(),
    timestampRaw: String(Date.now()),
    body: Buffer.from([0x21, 0x10]),
  });
  const channelOnePath = getRtspStreamPath(terminalPhoneHex, 1);
  const channelTwoPath = getRtspStreamPath(terminalPhoneHex, 2);
  const audioPath = getRtspAudioPath(terminalPhoneHex);
  const readInputBytes = (path) =>
    childrenByPath.get(path)?.stdio[3].read()?.length ?? 0;

  pipeline.pushFrame(videoFrame(1));
  pipeline.pushFrame(videoFrame(2));
  pipeline.pushFrame(audioFrame());
  t.mock.timers.tick(1);
  assert.equal(
    pipeline.getStatus(terminalPhoneHex, 1).syncStatus.state,
    "aligned",
  );
  for (const path of [channelOnePath, channelTwoPath, audioPath]) {
    readInputBytes(path);
  }

  t.mock.timers.tick(301);
  pipeline.pushFrame(videoFrame(1));
  pipeline.pushFrame(videoFrame(2));
  t.mock.timers.tick(40);
  const heldStatus = pipeline.getStatus(terminalPhoneHex, 1).syncStatus;
  assert.equal(
    heldStatus.state,
    "holding",
    JSON.stringify(heldStatus),
  );
  assert.equal(
    heldStatus.audioUnavailable,
    true,
  );
  assert.equal(readInputBytes(channelOnePath), 0);
  assert.equal(readInputBytes(channelTwoPath), 0);
  assert.equal(readInputBytes(audioPath), 0);
  assert.ok(events.some(([, event]) =>
    event === "rtsp-media-sync-hold"));

  pipeline.pushFrame(videoFrame(1));
  pipeline.pushFrame(videoFrame(2));
  t.mock.timers.tick(1);
  assert.equal(readInputBytes(channelOnePath), 0);
  assert.equal(readInputBytes(channelTwoPath), 0);

  pipeline.pushFrame(videoFrame(1));
  pipeline.pushFrame(videoFrame(2));
  pipeline.pushFrame(audioFrame());
  t.mock.timers.tick(1);
  assert.equal(
    pipeline.getStatus(terminalPhoneHex, 1).syncStatus.state,
    "aligned",
  );
  assert.equal(
    pipeline.getStatus(terminalPhoneHex, 1).syncStatus.audioUnavailable,
    false,
  );
  assert.ok(readInputBytes(audioPath) > 0);
});

test("strict arrival synchronization drops media that schedules beyond its tolerance", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100_000 });
  const terminalPhoneHex = "001200053180";
  const childrenByPath = new Map();
  const pipeline = createRtspMediaPipeline({
    rtspBaseUrl: "rtsp://mediamtx:8554",
    syncMode: "strict-arrival",
    syncToleranceMs: 250,
    jitterBufferMs: 0,
    separateAudio: true,
    getAudioEnabled: () => true,
    getCapabilities: () => ({
      audioEncoding: 19,
      audioChannels: 1,
      audioSampleRate: 3,
      videoEncoding: 99,
    }),
    onEvent: () => {},
    spawnProcess: (_command, args) => {
      const path = args.at(-1).split("/").at(-1);
      const child = new FakeChild();
      childrenByPath.set(path, child);
      return child;
    },
  });
  t.after(() => pipeline.close());

  for (const channelNo of [1, 2]) {
    pipeline.pushFrame({
      terminalPhoneHex,
      channelNo,
      kind: "video",
      dataType: 0,
      timestampMs: Date.now(),
      timestampRaw: String(Date.now()),
      body: Buffer.from([0x26, 0x01, 0xaa]),
    });
  }
  for (let frameNo = 0; frameNo < 40; frameNo += 1) {
    pipeline.pushFrame({
      terminalPhoneHex,
      channelNo: 1,
      kind: "audio",
      timestampMs: Date.now(),
      timestampRaw: String(Date.now()),
      body: Buffer.from([0x21, 0x10]),
    });
  }

  const audioStatus = pipeline.getAudioStatus(terminalPhoneHex);
  assert.ok(audioStatus.timing.queuedFrames < 42);
  assert.equal(audioStatus.syncStatus.toleranceMs, 250);
  assert.ok(audioStatus.syncStatus.scheduleAheadMs <= 750);
  assert.equal(audioStatus.syncStatus.scheduleAheadLimitMs, 750);
  assert.equal(
    audioStatus.syncStatus.state,
    "holding",
    JSON.stringify(audioStatus.syncStatus),
  );
});

test("strict arrival delays all three lanes by the configured 8 second buffer", (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"], now: 100_000 });
  const terminalPhoneHex = "001200053180";
  const childrenByPath = new Map();
  const pipeline = createRtspMediaPipeline({
    rtspBaseUrl: "rtsp://mediamtx:8554",
    syncMode: "strict-arrival",
    syncToleranceMs: 250,
    jitterBufferMs: 8000,
    separateAudio: true,
    getAudioEnabled: () => true,
    getCapabilities: () => ({
      audioEncoding: 19,
      audioChannels: 1,
      audioSampleRate: 3,
      videoEncoding: 99,
    }),
    onEvent: () => {},
    spawnProcess: (_command, args) => {
      const path = args.at(-1).split("/").at(-1);
      const child = new FakeChild();
      childrenByPath.set(path, child);
      return child;
    },
  });
  t.after(() => pipeline.close());

  for (const channelNo of [1, 2]) {
    pipeline.pushFrame({
      terminalPhoneHex,
      channelNo,
      kind: "video",
      dataType: 0,
      timestampMs: Date.now(),
      timestampRaw: String(Date.now()),
      body: Buffer.from([0x26, 0x01, 0xaa]),
    });
  }
  pipeline.pushFrame({
    terminalPhoneHex,
    channelNo: 1,
    kind: "audio",
    timestampMs: Date.now(),
    timestampRaw: String(Date.now()),
    body: Buffer.from([0x21, 0x10]),
  });
  t.mock.timers.tick(7999);

  for (const path of [
    getRtspStreamPath(terminalPhoneHex, 1),
    getRtspStreamPath(terminalPhoneHex, 2),
    getRtspAudioPath(terminalPhoneHex),
  ]) {
    assert.equal(childrenByPath.get(path)?.stdio[3].read()?.length ?? 0, 0);
  }

  t.mock.timers.tick(1);
  assert.ok(
    childrenByPath.get(getRtspStreamPath(terminalPhoneHex, 1))
      ?.stdio[3].read()?.length > 0,
  );
  assert.ok(
    childrenByPath.get(getRtspStreamPath(terminalPhoneHex, 2))
      ?.stdio[3].read()?.length > 0,
  );
  assert.ok(
    childrenByPath.get(getRtspAudioPath(terminalPhoneHex))
      ?.stdio[3].read()?.length > 0,
  );
});

test("publishes copied H.265 video and recoded AAC to the OBS RTSP path", async () => {
  let spawnArgs;
  let child;
  const events = [];
  const pipeline = createRtspMediaPipeline({
    rtspBaseUrl: "rtsp://mediamtx:8554",
    jitterBufferMs: 0,
    sourceClockCalibrationTimeoutMs: 500,
    sourceClockCalibrationSpanMs: 150,
    getCapabilities: () => ({
      audioEncoding: 19,
      audioChannels: 1,
      audioSampleRate: 0,
      videoEncoding: 99,
    }),
    onEvent: (...event) => events.push(event),
    spawnProcess: (_command, args) => {
      spawnArgs = args;
      child = new FakeChild();
      return child;
    },
  });
  const frame = {
    terminalPhoneHex: "001200053180",
    channelNo: 1,
    lastFrameIntervalMs: 40,
    kind: "video",
    body: Buffer.from([0x26, 0x01, 0xaa]),
  };

  pipeline.pushFrame({
    ...frame,
    kind: "audio",
    timestampMs: 1000,
    body: Buffer.from([0x21, 0x10]),
  });
  pipeline.pushFrame({ ...frame, timestampMs: 1000 });
  await new Promise((resolve) => setTimeout(resolve, 650));

  assert.equal(spawnArgs[spawnArgs.indexOf("-f") + 1], "mpegts");
  assert.equal(spawnArgs.includes("-use_wallclock_as_timestamps"), false);
  assert.equal(spawnArgs.includes("-start_at_zero"), false);
  assert.ok(spawnArgs.includes("-copyts"));
  assert.equal(spawnArgs[spawnArgs.indexOf("-probesize") + 1], "32768");
  assert.equal(spawnArgs[spawnArgs.indexOf("-analyzeduration") + 1], "100000");
  assert.equal(spawnArgs[spawnArgs.indexOf("-c:v") + 1], "copy");
  assert.equal(spawnArgs[spawnArgs.indexOf("-c:a") + 1], "aac");
  assert.ok(spawnArgs.includes("+global_header"));
  assert.ok(spawnArgs.includes("32k"));
  assert.equal(spawnArgs.includes("-ar"), false);
  assert.equal(
    spawnArgs.at(-1),
    "rtsp://mediamtx:8554/terminal-001200053180-channel-1",
  );
  assert.equal(
    spawnArgs.filter((arg) => arg === "rtsp://mediamtx:8554/terminal-001200053180-channel-1").length,
    1,
  );
  assert.equal(spawnArgs.includes(getRtspAudioPath(frame.terminalPhoneHex)), false);
  assert.ok(child.stdio[3].read().includes(Buffer.from([0, 0, 0, 1, 0x26, 0x01, 0xaa])));
  assert.ok(child.stdio[4].read().includes(Buffer.from([0xff, 0xf1])));
  const clock = pipeline.getStatus(frame.terminalPhoneHex, 1).mediaClock;
  // Arrival fallback preserves the small arrival offset, not separate input epochs.
  assert.ok(clock.lastAudio90k >= clock.lastVideo90k);
  assert.ok(clock.lastAudio90k - clock.lastVideo90k < 40 * 90);

  child.stderr.write("Output #0, rtsp, to '<url>':\n");
  assert.equal(
    pipeline.getStatus(frame.terminalPhoneHex, 1).status,
    "publishing",
  );
  assert.ok(events.some(([, type]) => type === "rtsp-media-published"));
  pipeline.stopStreamFor(frame.terminalPhoneHex, 1);
});

test("publishes both videos separately and shared audio from channel 1", async () => {
  const terminalPhoneHex = "001200053180";
  const children = [];
  const pipeline = createRtspMediaPipeline({
    rtspBaseUrl: "rtsp://mediamtx:8554",
    separateAudio: true,
    jitterBufferMs: 0,
    sourceClockCalibrationTimeoutMs: 100,
    sourceClockCalibrationSpanMs: 10,
    getCapabilities: () => ({
      audioEncoding: 19,
      audioChannels: 1,
      audioSampleRate: 0,
      videoEncoding: 99,
    }),
    getAudioEnabled: () => true,
    onEvent: () => {},
    spawnProcess: (_command, args, options) => {
      const child = new FakeChild();
      children.push({ args, options, child });
      return child;
    },
  });
  const videoFrame = {
    terminalPhoneHex,
    kind: "video",
    dataType: 0,
    timestampMs: 1000,
    body: Buffer.from([0x26, 0x01, 0xaa]),
  };

  pipeline.pushFrame({ ...videoFrame, channelNo: 1 });
  pipeline.pushFrame({ ...videoFrame, channelNo: 1, timestampMs: 1040 });
  pipeline.pushFrame({ ...videoFrame, channelNo: 2 });
  pipeline.pushFrame({
    terminalPhoneHex,
    channelNo: 1,
    kind: "audio",
    timestampMs: 1040,
    body: Buffer.from([0x21, 0x10]),
  });
  await new Promise((resolve) => setTimeout(resolve, 150));

  assert.equal(children.length, 3);
  const channel1VideoPublisher = children[0];
  const channel2VideoPublisher = children[1];
  const audioPublisher = children[2];
  assert.ok(channel1VideoPublisher.args.includes("0:v:0"));
  assert.ok(channel1VideoPublisher.args.includes(
    `rtsp://mediamtx:8554/${getRtspStreamPath(terminalPhoneHex, 1)}`,
  ));
  assert.equal(channel1VideoPublisher.args.includes("pipe:4"), false);
  assert.equal(channel1VideoPublisher.options.stdio[4], "ignore");
  assert.equal(channel1VideoPublisher.args.includes(
    getRtspAudioPath(terminalPhoneHex),
  ), false);
  assert.ok(audioPublisher.args.includes(
    `rtsp://mediamtx:8554/${getRtspAudioPath(terminalPhoneHex)}`,
  ));
  assert.ok(audioPublisher.args.includes("0:a:0"));
  assert.equal(audioPublisher.args.includes(
    getRtspStreamPath(terminalPhoneHex, 1),
  ), false);
  assert.equal(audioPublisher.options.stdio[3], "pipe");
  assert.ok(channel2VideoPublisher.args.includes(
    `rtsp://mediamtx:8554/${getRtspStreamPath(terminalPhoneHex, 2)}`,
  ));
  assert.ok(channel2VideoPublisher.args.includes("0:v:0"));
  assert.equal(channel2VideoPublisher.args.includes("1:a:0"), false);
  assert.equal(channel2VideoPublisher.args.includes("pipe:4"), false);
  assert.equal(channel1VideoPublisher.child.killed, false);
  assert.equal(pipeline.getStatus(terminalPhoneHex, 1).audioRequested, true);
  assert.equal(pipeline.getStatus(terminalPhoneHex, 1).audioEnabled, true);
  assert.equal(pipeline.getStatus(terminalPhoneHex, 2).audioRequested, false);
  assert.equal(pipeline.getStatus(terminalPhoneHex, 2).audioEnabled, false);
  assert.equal(pipeline.getAudioStatus(terminalPhoneHex).status, "starting");
  assert.equal(pipeline.getAudioStatus(terminalPhoneHex).audioFrames, 1);

  pipeline.close();
});

test("keeps channel 1 video and shared audio publishers alive independently during audio gaps", async () => {
  const children = [];
  const pipeline = createRtspMediaPipeline({
    rtspBaseUrl: "rtsp://mediamtx:8554",
    separateAudio: true,
    jitterBufferMs: 0,
    audioArrivalTimeoutMs: 50,
    getCapabilities: () => ({
      audioEncoding: 19,
      audioChannels: 1,
      audioSampleRate: 0,
      videoEncoding: 99,
    }),
    getAudioEnabled: () => true,
    isAudioWatchdogArmed: () => false,
    onEvent: () => {},
    spawnProcess: (_command, args, options) => {
      const child = new FakeChild();
      children.push({ args, options, child });
      return child;
    },
  });
  const terminalPhoneHex = "001200053180";
  const video = {
    terminalPhoneHex,
    channelNo: 1,
    kind: "video",
    dataType: 0,
    timestampMs: 1000,
    body: Buffer.from([0x26, 0x01, 0xaa]),
  };

  pipeline.pushFrame(video);
  const videoPublisher = children[0].child;
  videoPublisher.stderr.write("Output #0, rtsp, to '<video-url>':\n");
  pipeline.pushFrame({
    ...video,
    kind: "audio",
    body: Buffer.from([0x21, 0x10]),
  });
  const audioPublisher = children[1].child;
  audioPublisher.stderr.write("Output #0, rtsp, to '<audio-url>':\n");

  await new Promise((resolve) => setTimeout(resolve, 100));

  let videoStatus = pipeline.getStatus(terminalPhoneHex, 1);
  assert.equal(videoPublisher.killed, false);
  assert.equal(audioPublisher.killed, false);
  assert.equal(videoStatus.status, "publishing");
  assert.equal(videoStatus.audioState, "stalled");
  assert.equal(pipeline.getAudioStatus(terminalPhoneHex).status, "publishing");

  pipeline.pushFrame({
    ...video,
    kind: "audio",
    timestampMs: 1200,
    body: Buffer.from([0x21, 0x10]),
  });
  videoStatus = pipeline.getStatus(terminalPhoneHex, 1);
  assert.equal(children.length, 2);
  assert.equal(videoPublisher.killed, false);
  assert.equal(audioPublisher.killed, false);
  assert.equal(videoStatus.audioState, "active");

  pipeline.close();
  assert.equal(videoPublisher.killed, true);
  assert.equal(audioPublisher.killed, true);
});

test("uses H.265 for the terminal's video encoding value 99", () => {
  let spawnArgs;
  const terminalPhoneHex = "001200053180";
  const child = new FakeChild();
  const pipeline = createRtspMediaPipeline({
    rtspBaseUrl: "rtsp://mediamtx:8554",
    jitterBufferMs: 0,
    getCapabilities: () => ({
      audioEncoding: 19,
      audioChannels: 1,
      audioSampleRate: 0,
      videoEncoding: 99,
    }),
    onEvent: () => {},
    spawnProcess: (_command, args) => {
      spawnArgs = args;
      return child;
    },
  });

  pipeline.pushFrame({
    terminalPhoneHex,
    channelNo: 1,
    kind: "video",
    timestampMs: null,
    body: Buffer.from([0x02, 0x01, 0x84]),
  });

  assert.equal(spawnArgs[spawnArgs.indexOf("-f") + 1], "mpegts");
  const diagnostics = pipeline.getStatus(terminalPhoneHex, 1).videoDiagnostics;
  assert.equal(diagnostics.validHevcNalHeaders, 1);
  assert.equal(diagnostics.hevcNalTypes[1], 1);
  assert.equal(diagnostics.validH264NalHeaders, 1);
  assert.equal(diagnostics.h264NalTypes[2], 1);
  pipeline.stopStreamFor(terminalPhoneHex, 1);
});

test("publishes a video-only substream without waiting for audio", () => {
  let spawnArgs;
  let spawnOptions;
  let child;
  const terminalPhoneHex = "001200053180";
  const pipeline = createRtspMediaPipeline({
    rtspBaseUrl: "rtsp://mediamtx:8554",
    jitterBufferMs: 0,
    getCapabilities: () => ({
      audioEncoding: 19,
      audioChannels: 1,
      audioSampleRate: 0,
      videoEncoding: 99,
    }),
    getAudioEnabled: (_phone, channelNo) => channelNo !== 2,
    onEvent: () => {},
    spawnProcess: (_command, args, options) => {
      spawnArgs = args;
      spawnOptions = options;
      child = new FakeChild();
      return child;
    },
  });

  pipeline.pushFrame({
    terminalPhoneHex,
    channelNo: 2,
    kind: "video",
    dataType: 0,
    timestampMs: 1000,
    body: Buffer.from([0x26, 0x01, 0xaa]),
  });
  pipeline.pushFrame({
    terminalPhoneHex,
    channelNo: 2,
    kind: "audio",
    timestampMs: 1000,
    body: Buffer.from([0x21, 0x10]),
  });

  const status = pipeline.getStatus(terminalPhoneHex, 2);
  assert.equal(status.audioEnabled, false);
  assert.equal(status.audioFrames, 0);
  assert.equal(status.audioDiagnostics.framesReceived, 1);
  assert.ok(spawnArgs.includes("pipe:3"));
  assert.equal(spawnArgs.includes("pipe:4"), false);
  assert.equal(spawnArgs.includes("1:a:0"), false);
  assert.equal(spawnArgs.includes("aac"), false);
  assert.equal(spawnOptions.stdio[4], "ignore");
  pipeline.close();
});

test("falls back to video-only when requested audio never arrives", async () => {
  const children = [];
  const terminalPhoneHex = "001200053180";
  const pipeline = createRtspMediaPipeline({
    rtspBaseUrl: "rtsp://mediamtx:8554",
    jitterBufferMs: 0,
    audioArrivalTimeoutMs: 50,
    getCapabilities: () => ({
      audioEncoding: 19,
      audioChannels: 1,
      audioSampleRate: 0,
      videoEncoding: 99,
    }),
    getAudioEnabled: () => true,
    isAudioWatchdogArmed: () => true,
    onEvent: () => {},
    spawnProcess: (_command, args, options) => {
      const child = new FakeChild();
      children.push({ args, options, child });
      return child;
    },
  });

  pipeline.pushFrame({
    terminalPhoneHex,
    channelNo: 1,
    kind: "video",
    dataType: 0,
    timestampMs: 1000,
    body: Buffer.from([0x26, 0x01, 0xaa]),
  });

  assert.equal(children.length, 1);
  assert.equal(children[0].options.stdio[4], "pipe");
  assert.ok(children[0].args.includes("pipe:4"));

  // Nenhum quadro de áudio chega: aguarda o watchdog (50ms) e o atraso mínimo
  // de reconexão (1s) antes de tentar novamente.
  await new Promise((resolve) => setTimeout(resolve, 1_200));

  pipeline.pushFrame({
    terminalPhoneHex,
    channelNo: 1,
    kind: "video",
    dataType: 0,
    timestampMs: 1040,
    body: Buffer.from([0x26, 0x01, 0xbb]),
  });

  assert.equal(children.length, 2);
  assert.equal(children[1].options.stdio[4], "ignore");
  assert.equal(children[1].args.includes("pipe:4"), false);

  const status = pipeline.getStatus(terminalPhoneHex, 1);
  assert.equal(status.audioEnabled, false);

  pipeline.stopStreamFor(terminalPhoneHex, 1);
});

test("falls back to video-only when audio stalls after publisher startup", async () => {
  const children = [];
  const pipeline = createRtspMediaPipeline({
    rtspBaseUrl: "rtsp://mediamtx:8554",
    jitterBufferMs: 0,
    audioArrivalTimeoutMs: 50,
    getCapabilities: () => ({
      audioEncoding: 19,
      audioChannels: 1,
      audioSampleRate: 0,
      videoEncoding: 99,
    }),
    getAudioEnabled: () => true,
    isAudioWatchdogArmed: () => false,
    onEvent: () => {},
    spawnProcess: (_command, args, options) => {
      const child = new FakeChild();
      children.push({ args, options, child });
      return child;
    },
  });
  const terminalPhoneHex = "001200053180";
  const keyFrame = {
    terminalPhoneHex,
    channelNo: 1,
    kind: "video",
    dataType: 0,
    timestampMs: 1000,
    body: Buffer.from([0x26, 0x01, 0xaa]),
  };

  pipeline.pushFrame({
    ...keyFrame,
    kind: "audio",
    body: Buffer.from([0x21, 0x10]),
  });
  pipeline.pushFrame(keyFrame);

  assert.equal(children.length, 1);
  assert.equal(children[0].options.stdio[4], "pipe");
  await new Promise((resolve) => setTimeout(resolve, 100));

  pipeline.pushFrame({ ...keyFrame, timestampMs: 1040 });

  assert.equal(children[0].child.killed, true);
  assert.equal(children.length, 2);
  assert.equal(children[1].options.stdio[4], "ignore");
  assert.equal(pipeline.getStatus(terminalPhoneHex, 1).audioEnabled, false);

  pipeline.close();
});

test("publishes main-stream video immediately and restores late audio only at a keyframe", async () => {
  const children = [];
  const events = [];
  const terminalPhoneHex = "001200053180";
  const pipeline = createRtspMediaPipeline({
    rtspBaseUrl: "rtsp://mediamtx:8554",
    jitterBufferMs: 0,
    audioArrivalTimeoutMs: 50,
    getCapabilities: () => ({
      audioEncoding: 19,
      audioChannels: 1,
      audioSampleRate: 0,
      videoEncoding: 99,
    }),
    getAudioEnabled: (_phone, channel) => channel === 1,
    isAudioWatchdogArmed: () => false,
    onEvent: (...event) => events.push(event),
    spawnProcess: (_command, args, options) => {
      const child = new FakeChild();
      children.push({ args, options, child });
      return child;
    },
  });

  pipeline.pushFrame({
    terminalPhoneHex,
    channelNo: 1,
    kind: "video",
    dataType: 0,
    timestampMs: 1000,
    body: Buffer.from([0x26, 0x01, 0xaa]),
  });

  assert.equal(children.length, 1);
  assert.equal(children[0].options.stdio[4], "ignore");
  assert.equal(pipeline.getStatus(terminalPhoneHex, 1).audioEnabled, false);

  await new Promise((resolve) => setTimeout(resolve, 100));
  const video = {
    terminalPhoneHex, channelNo: 1, kind: "video", dataType: 0,
    timestampMs: 1040, body: Buffer.from([0x26, 0x01, 0xbb]),
  };
  pipeline.pushFrame(video);
  let status = pipeline.getStatus(terminalPhoneHex, 1);
  assert.equal(status.audioEnabled, false);
  assert.equal(status.audioRequested, true);
  assert.equal(status.audioState, "waiting");
  assert.equal(children.length, 1);
  assert.equal(children[0].args.includes("pipe:4"), false);
  pipeline.pushFrame({ ...video, channelNo: 2 });
  const sibling = children[1].child;
  pipeline.pushFrame({ ...video, kind: "audio", body: Buffer.from([0xff, 0xf1]) });
  assert.equal(pipeline.getStatus(terminalPhoneHex, 1).audioState, "waiting");
  assert.ok(events.some(([, event]) => event === "rtsp-media-invalid-audio"));
  pipeline.pushFrame({
    ...video, kind: "audio", body: Buffer.from([0x21, 0x10]),
  });
  assert.equal(pipeline.getStatus(terminalPhoneHex, 1).audioState, "restoring");
  pipeline.pushFrame({ ...video, dataType: 1 });
  assert.equal(children.length, 2);
  pipeline.pushFrame({ ...video, timestampMs: 1080 });
  status = pipeline.getStatus(terminalPhoneHex, 1);
  assert.equal(status.audioEnabled, true);
  assert.equal(status.audioState, "active");
  assert.equal(children.length, 3);
  assert.ok(children[2].args.includes("pipe:4"));
  assert.equal(children[0].child.killed, true);
  assert.equal(sibling.killed, false);

  pipeline.close();
});

test("waits for a video keyframe and retains the first received audio frame", async () => {
  const child = new FakeChild();
  const pipeline = createRtspMediaPipeline({
    rtspBaseUrl: "rtsp://mediamtx:8554",
    jitterBufferMs: 0,
    sourceClockCalibrationTimeoutMs: 500,
    sourceClockCalibrationSpanMs: 150,
    getCapabilities: () => ({
      audioEncoding: 19,
      audioChannels: 1,
      audioSampleRate: 0,
      videoEncoding: 99,
    }),
    onEvent: () => {},
    spawnProcess: () => child,
  });

  pipeline.pushFrame({
    terminalPhoneHex: "001200053180",
    channelNo: 1,
    kind: "audio",
    timestampMs: 1000,
    body: Buffer.from([0x21, 0x10]),
  });

  assert.equal(child.stdio[3].read(), null);
  assert.equal(child.stdio[4].read(), null);
  assert.equal(pipeline.getStatus("001200053180", 1).status, "waiting");

  pipeline.pushFrame({
    terminalPhoneHex: "001200053180",
    channelNo: 1,
    kind: "video",
    dataType: 0,
    timestampMs: 1000,
    body: Buffer.from([0x02, 0x01, 0x84]),
  });

  await new Promise((resolve) => setTimeout(resolve, 650));
  assert.ok(child.stdio[3].read().includes(Buffer.from([0, 0, 0, 1, 0x02, 0x01, 0x84])));
  assert.ok(child.stdio[4].read().includes(Buffer.from([0xff, 0xf1])));
  pipeline.stopStreamFor("001200053180", 1);
});

test("does not start or restart a publisher on a non-keyframe", async () => {
  const terminalPhoneHex = "001200053180";
  const children = [];
  const pipeline = createRtspMediaPipeline({
    rtspBaseUrl: "rtsp://mediamtx:8554",
    getCapabilities: () => ({
      audioEncoding: 19,
      audioChannels: 1,
      audioSampleRate: 0,
      videoEncoding: 99,
    }),
    onEvent: () => {},
    spawnProcess: () => {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
  });

  pipeline.pushFrame({
    terminalPhoneHex,
    channelNo: 1,
    kind: "video",
    dataType: 1,
    timestampMs: 1000,
    body: Buffer.from([0x02, 0x01, 0x84]),
  });
  assert.equal(children.length, 0);

  pipeline.pushFrame({
    terminalPhoneHex,
    channelNo: 1,
    kind: "video",
    dataType: 0,
    timestampMs: 1040,
    body: Buffer.from([0x02, 0x01, 0x84]),
  });
  assert.equal(children.length, 1);
  pipeline.close();
});

test("drops queued video only through the latest queued keyframe", () => {
  const frame = (size, isKeyFrame) => ({
    payload: Buffer.alloc(size),
    isKeyFrame,
  });
  const queue = [
    frame(100, false),
    frame(200, true),
    frame(300, false),
    frame(400, true),
    frame(500, false),
  ];

  const dropped = dropQueuedVideoBeforeLatestKeyFrame(queue);

  assert.equal(dropped.frames.length, 3);
  assert.equal(dropped.bytes, 600);
  assert.equal(queue.length, 2);
  assert.equal(queue[0].isKeyFrame, true);
  assert.equal(queue[1].isKeyFrame, false);
});

test("bounds queued RTSP writes while honoring FFmpeg drain", async () => {
  const terminalPhoneHex = "001200053180";
  const child = new BackpressureChild();
  const pipeline = createRtspMediaPipeline({
    rtspBaseUrl: "rtsp://mediamtx:8554",
    jitterBufferMs: 0,
    getCapabilities: () => ({
      audioEncoding: 19,
      audioChannels: 1,
      audioSampleRate: 0,
      videoEncoding: 99,
    }),
    onEvent: () => {},
    spawnProcess: () => child,
  });

  for (let index = 0; index < 5; index += 1) {
    pipeline.pushFrame({
      terminalPhoneHex,
      channelNo: 1,
      kind: "video",
      timestampMs: 1000 + index * 40,
      lastFrameIntervalMs: 40,
      body: Buffer.alloc(20_000, 0x26),
    });
    if (index < 4) {
      await new Promise((resolve) => setTimeout(resolve, 80));
    }
  }
  await new Promise((resolve) => setTimeout(resolve, 450));

  const blocked = pipeline.getStatus(terminalPhoneHex, 1);
  assert.notEqual(blocked.status, "error");
  assert.ok(blocked.timing.writeBackpressureEvents > 0);
  assert.ok(blocked.timing.pipeQueuedFrames > 0);
  assert.ok(blocked.timing.pipeQueuedBytes < 1024 * 1024);
  assert.equal(pipeline.trimVideoQueueFor(terminalPhoneHex, 1), 2);
  const trimmed = pipeline.getStatus(terminalPhoneHex, 1);
  assert.equal(trimmed.timing.pipeQueuedFramesByKind.video, 1);
  assert.equal(trimmed.audioEnabled, false);
  assert.equal(child.killed, false);

  for (let index = 0; index < 8; index += 1) {
    child.stdio[3].release();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  const drained = pipeline.getStatus(terminalPhoneHex, 1);
  assert.equal(drained.timing.pipeQueuedFrames, 0);
  assert.ok(drained.timing.pipeDiagnosticsByKind.video.drainEvents > 0);
  pipeline.stopStreamFor(terminalPhoneHex, 1);
});

test("tracks actual FFmpeg output separately from accepted pipe writes", () => {
  const child = new FakeChild();
  let args;
  const pipeline = createRtspMediaPipeline({
    rtspBaseUrl: "rtsp://mediamtx:8554",
    getCapabilities: () => ({
      audioEncoding: 19, audioChannels: 1, audioSampleRate: 0, videoEncoding: 99,
    }),
    onEvent: () => {},
    spawnProcess: (_command, arguments_) => {
      args = arguments_;
      return child;
    },
  });
  pipeline.pushFrame({
    terminalPhoneHex: "001200053180", channelNo: 1, kind: "video",
    dataType: 0, timestampMs: 1000, body: Buffer.from([0x26, 0x01, 0xaa]),
  });
  assert.ok(args.includes("pipe:5"));
  child.stdio[5].write("frame=7\nout_time_");
  assert.equal(pipeline.getStatus("001200053180", 1).outputProgress.frames, 0);
  child.stdio[5].write("us=1234000\nspeed=0.75x\nprogress=continue\n");
  const first = pipeline.getStatus("001200053180", 1).outputProgress;
  assert.equal(first.frames, 7);
  assert.equal(first.outTimeUs, 1234000);
  assert.equal(first.speed, 0.75);
  assert.equal(first.reports, 1);
  assert.ok(first.lastVideoAdvanceAtMs);
  child.stdio[5].write("frame=7\r\nout_time_us=1234000\r\nspeed=N/A\r\nprogress=continue\r\n");
  const stalled = pipeline.getStatus("001200053180", 1).outputProgress;
  assert.equal(stalled.lastVideoAdvanceAtMs, first.lastVideoAdvanceAtMs);
  assert.equal(stalled.lastTimeAdvanceAtMs, first.lastTimeAdvanceAtMs);
  assert.equal(stalled.speed, null);
  assert.equal(stalled.reports, 2);
  child.stdio[5].write("frame=N/A\nout_time_us=N/A\nprogress=end\n");
  assert.equal(pipeline.getStatus("001200053180", 1).outputProgress.frames, 7);
  child.stdio[5].write("frame=8\nout_time_us=1300000\nprogress=continue\nframe=9\nout_time_us=1400000\nprogress=end\n");
  const advanced = pipeline.getStatus("001200053180", 1).outputProgress;
  assert.equal(advanced.frames, 9);
  assert.equal(advanced.outTimeUs, 1400000);
  assert.equal(advanced.reports, 5);
  pipeline.allowStreamFor("001200053180", 1);
  assert.equal(pipeline.getStatus("001200053180", 1).outputProgress, null);
  pipeline.close();
});

test("uses AAC sample duration and monotonic video timestamps when media arrives in a burst", async (t) => {
  const child = new FakeChild();
  const pipeline = createRtspMediaPipeline({
    rtspBaseUrl: "rtsp://mediamtx:8554",
    jitterBufferMs: 0,
    sourceClockCalibrationTimeoutMs: 100,
    getCapabilities: () => ({
      audioEncoding: 19, audioChannels: 1, audioSampleRate: 0, videoEncoding: 99,
    }),
    onEvent: () => {},
    spawnProcess: () => child,
  });
  const frame = {
    terminalPhoneHex: "001200053180", channelNo: 1, timestampMs: 1000,
    lastFrameIntervalMs: 40,
  };
  t.after(() => pipeline.close());
  pipeline.pushFrame({ ...frame, kind: "audio", body: Buffer.from([0x21, 0x10]) });
  pipeline.pushFrame({ ...frame, kind: "video", dataType: 0, body: Buffer.from([0x26, 1, 0xaa]) });
  for (let index = 0; index < 3; index += 1) {
    if (index < 2) {
      pipeline.pushFrame({ ...frame, kind: "audio", body: Buffer.from([0x21, 0x10]) });
    }
    pipeline.pushFrame({ ...frame, kind: "video", dataType: 1, body: Buffer.from([0x02, 1, 0xaa]) });
  }
  const deadline = Date.now() + 1000;
  while ((pipeline.getStatus(frame.terminalPhoneHex, 1).videoFrames < 4 ||
      pipeline.getStatus(frame.terminalPhoneHex, 1).audioFrames < 3) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  const audio = child.stdio[4].read();
  const timestamps = readTransportPts(audio);
  assert.equal(timestamps.length, 3);
  assert.equal(timestamps[1] - timestamps[0], 11520);
  assert.equal(timestamps[2] - timestamps[1], 11520);
  assert.equal(pipeline.getStatus(frame.terminalPhoneHex, 1).mediaClock.lastAudio90k, timestamps[2]);
  const videoTimestamps = readTransportPts(child.stdio[3].read());
  assert.equal(videoTimestamps.length, 4);
  for (let index = 1; index < videoTimestamps.length; index += 1) {
    assert.ok(videoTimestamps[index] > videoTimestamps[index - 1]);
  }
  pipeline.close();
  pipeline.allowStreamFor(frame.terminalPhoneHex, 1);
  assert.equal(pipeline.getStatus(frame.terminalPhoneHex, 1).mediaClock, null);
});

test("keeps the previous raw-input timestamp strategy available for rollback", () => {
  let args;
  const pipeline = createRtspMediaPipeline({
    rtspBaseUrl: "rtsp://mediamtx:8554",
    timestampMode: "wallclock",
    getCapabilities: () => ({
      audioEncoding: 19, audioChannels: 1, audioSampleRate: 0, videoEncoding: 99,
    }),
    onEvent: () => {},
    spawnProcess: (_command, arguments_) => {
      args = arguments_;
      return new FakeChild();
    },
  });
  pipeline.pushFrame({
    terminalPhoneHex: "001200053180", channelNo: 1, kind: "audio",
    timestampMs: 1000, body: Buffer.from([0x21, 0x10]),
  });
  pipeline.pushFrame({
    terminalPhoneHex: "001200053180", channelNo: 1, kind: "video",
    dataType: 0, timestampMs: 1000, body: Buffer.from([0x26, 1, 0xaa]),
  });
  assert.ok(args.includes("hevc"));
  assert.ok(args.includes("-start_at_zero"));
  assert.equal(args.filter(arg => arg === "-use_wallclock_as_timestamps").length, 2);
  pipeline.close();
  assert.throws(() => createRtspMediaPipeline({ timestampMode: "invalid" }), /timestampMode/);
});

test("falls back only the channel with B-frames without assigning incorrect transport PTS", () => {
  const children = [];
  const events = [];
  const pipeline = createRtspMediaPipeline({
    rtspBaseUrl: "rtsp://mediamtx:8554",
    getCapabilities: () => ({
      audioEncoding: 19, audioChannels: 1, audioSampleRate: 0, videoEncoding: 99,
    }),
    onEvent: (...event) => events.push(event),
    spawnProcess: (_command, args) => {
      const child = new FakeChild();
      children.push({ child, args });
      return child;
    },
  });
  const frame = {
    terminalPhoneHex: "001200053180", kind: "video", timestampMs: 1000,
    body: Buffer.from([0x26, 1, 0xaa]),
  };
  pipeline.pushFrame({ ...frame, channelNo: 1, dataType: 0 });
  pipeline.pushFrame({ ...frame, channelNo: 2, dataType: 0 });
  pipeline.pushFrame({ ...frame, channelNo: 1, dataType: 2 });
  assert.equal(children[0].child.killed, true);
  assert.equal(children[1].child.killed, false);
  assert.ok(events.some(([, event, message]) =>
    event === "rtsp-media-pipeline-error" && message.includes("B-frames")));
  pipeline.allowStreamFor(frame.terminalPhoneHex, 1);
  pipeline.pushFrame({ ...frame, channelNo: 1, dataType: 0 });
  assert.ok(children[2].args.includes("hevc"));
  assert.ok(children[2].args.includes("-use_wallclock_as_timestamps"));
  assert.equal(pipeline.getStatus(frame.terminalPhoneHex, 1).timestampMode, "wallclock");
  assert.equal(pipeline.getStatus(frame.terminalPhoneHex, 2).timestampMode, "transport");
  pipeline.close();
});

function readTransportPts(buffer) {
  const timestamps = [];
  for (let offset = 0; offset < buffer.length; offset += 188) {
    const packet = buffer.subarray(offset, offset + 188);
    if (!(packet[1] & 0x40) || (((packet[1] & 0x1f) << 8) | packet[2]) !== 0x100) {
      continue;
    }
    const start = packet[3] & 0x20 ? 5 + packet[4] : 4;
    const pts = packet.subarray(start + 9, start + 14);
    timestamps.push(((pts[0] >> 1) & 7) * 2 ** 30 +
      pts[1] * 2 ** 22 + (pts[2] >> 1) * 2 ** 15 +
      pts[3] * 2 ** 7 + (pts[4] >> 1));
  }
  return timestamps;
}

test("records FFmpeg exit code and recent stderr after an unexpected close", async () => {
  const terminalPhoneHex = "001200053180";
  const events = [];
  const child = new FakeChild();
  const pipeline = createRtspMediaPipeline({
    rtspBaseUrl: "rtsp://mediamtx:8554",
    getCapabilities: () => ({
      audioEncoding: 19,
      audioChannels: 1,
      audioSampleRate: 0,
      videoEncoding: 99,
    }),
    onEvent: (...event) => events.push(event),
    spawnProcess: () => child,
  });

  pipeline.pushFrame({
    terminalPhoneHex,
    channelNo: 1,
    kind: "video",
    timestampMs: null,
    body: Buffer.from([0x26, 0x01, 0xaa]),
  });
  child.stderr.write("Invalid data\n");
  await new Promise((resolve) => setImmediate(resolve));
  child.emit("close", 1, null);

  const exitEvent = events.find(([, type]) => type === "rtsp-media-ffmpeg-exit");
  assert.ok(exitEvent);
  assert.equal(exitEvent[0], "error");
  assert.equal(exitEvent[2], "FFmpeg encerrou inesperadamente (código 1, sinal n/a)");
  assert.equal(exitEvent[3], "terminal-001200053180-channel-1");
  assert.deepEqual(exitEvent[4], {
    exitCode: 1,
    signal: null,
    statusAtExit: "starting",
    terminationRequestedByGateway: false,
    precedingFailure: null,
    lastStderrLines: ["Invalid data"],
  });
  assert.equal(
    events.filter(([, type]) => type === "rtsp-media-ffmpeg-exit").length,
    1,
  );
  pipeline.close();
});

test("restarts a failed RTSP publisher when media continues", async () => {
  const terminalPhoneHex = "001200053180";
  const children = [];
  const pipeline = createRtspMediaPipeline({
    rtspBaseUrl: "rtsp://mediamtx:8554",
    getCapabilities: () => ({
      audioEncoding: 19,
      audioChannels: 1,
      audioSampleRate: 0,
      videoEncoding: 99,
    }),
    onEvent: () => {},
    spawnProcess: () => {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
  });

  pipeline.pushFrame({
    terminalPhoneHex,
    channelNo: 1,
    kind: "video",
    timestampMs: null,
    lastFrameIntervalMs: 40,
    body: Buffer.from([0x26, 0x01, 0xaa]),
  });
  children[0].stdio[3].emit("error", new Error("simulated pipe failure"));
  assert.equal(pipeline.getStatus(terminalPhoneHex, 1).status, "error");

  await new Promise((resolve) => setTimeout(resolve, 1_050));
  for (let index = 0; index < 4; index += 1) {
    pipeline.pushFrame({
      terminalPhoneHex,
      channelNo: 1,
      kind: "video",
      timestampMs: 2000 + index * 40,
      lastFrameIntervalMs: 40,
      body: Buffer.from([0x26, 0x01, 0xaa]),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  assert.equal(children.length, 2);
  assert.notEqual(pipeline.getStatus(terminalPhoneHex, 1).status, "error");
  pipeline.close();
});

test("creates stable RTSP paths from terminal and channel identifiers", () => {
  assert.equal(
    getRtspStreamPath("001200053180", 2),
    "terminal-001200053180-channel-2",
  );
  assert.throws(() => getRtspStreamPath("invalid", 1), /6-byte hexadecimal/);
});

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.killed = false;
    this.stderr = new PassThrough();
    this.stdio = [
      null,
      null,
      this.stderr,
      new PassThrough(),
      new PassThrough(),
      new PassThrough(),
    ];
  }

  kill() {
    this.killed = true;
    this.emit("close", null, "SIGTERM");
    return true;
  }
}

class BackpressureChild extends EventEmitter {
  constructor() {
    super();
    this.killed = false;
    this.stderr = new PassThrough();
    this.stdio = [
      null,
      null,
      this.stderr,
      new ControlledWritable(),
      new ControlledWritable(),
      new PassThrough(),
    ];
  }

  kill() {
    this.killed = true;
    this.emit("close", null, "SIGTERM");
    return true;
  }
}

class ControlledWritable extends Writable {
  constructor() {
    super({ highWaterMark: 1 });
    this.pendingCallbacks = [];
    this.pendingDataSize = 0;
    this._highWaterMark = 1;
    this._allowWrites = false;
    this._firstWrite = true;
  }

  _write(chunk, _encoding, callback) {
    this.pendingDataSize += chunk.length;
    this.pendingCallbacks.push({ callback, size: chunk.length });
  }

  write(chunk) {
    if (this._firstWrite || this._allowWrites) {
      this._firstWrite = false;
      this.pendingDataSize += chunk.length;
      this.pendingCallbacks.push({ callback: () => {}, size: chunk.length });
      return true;
    }
    if (this.pendingDataSize + chunk.length <= this._highWaterMark) {
      this.pendingDataSize += chunk.length;
      this.pendingCallbacks.push({ callback: () => {}, size: chunk.length });
      return true;
    }
    return false;
  }

  release() {
    const entry = this.pendingCallbacks.shift();
    if (entry) {
      this.pendingDataSize -= entry.size;
      entry.callback();
      this._allowWrites = true;
      this.emit("drain");
    }
  }

  get writableLength() {
    return this.pendingDataSize;
  }
}
