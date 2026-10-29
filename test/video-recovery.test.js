import assert from "node:assert/strict";
import test from "node:test";
import { createVideoRecovery } from "../src/video-recovery.js";

function setup(overrides = {}) {
  let timestamp = 100_000;
  const states = new Map([1, 2].map((channelNo) => [channelNo, {
    enabled: true,
    connected: true,
    status: "publishing",
    lastVideoReceivedAtMs: timestamp,
    lastVideoWriteAtMs: timestamp,
    lastAudioWriteAtMs: timestamp,
    publisherStartedAtMs: timestamp - 10_000,
    videoFrames: 100,
    audioFrames: 100,
    audioEnabled: true,
    audioRequested: true,
    outputProgress: { frames: 100, lastVideoAdvanceAtMs: timestamp },
    commandPending: false,
    videoQueueAgeMs: 0,
    audioQueueAgeMs: 0,
    videoBlockedMs: 0,
    audioBlockedMs: 0,
  }]));
  const actions = [];
  const notifications = [];
  const recovery = createVideoRecovery({
    getChannelState: (_key, channelNo) => states.get(channelNo),
    trimQueue: (_key, channelNo) => {
      actions.push(["trim", channelNo]);
      return 10;
    },
    restartPublisher: (_key, channelNo) => {
      actions.push(["restart", channelNo]);
      states.get(channelNo).status = "stopped";
    },
    requestMedia: async (_key, channelNo) => {
      actions.push(["request", channelNo]);
    },
    onChange: (_key, status) => notifications.push(status),
    now: () => timestamp,
    schedule: () => {},
    ...overrides,
  });
  async function advance(ms, progressing = [], withAudio = true) {
    timestamp += ms;
    for (const channelNo of progressing) {
      Object.assign(states.get(channelNo), {
        status: "publishing",
        lastVideoReceivedAtMs: timestamp,
        lastVideoWriteAtMs: timestamp,
        videoFrames: states.get(channelNo).videoFrames + 1,
        videoQueueAgeMs: 0,
        audioQueueAgeMs: 0,
        videoBlockedMs: 0,
        audioBlockedMs: 0,
        outputProgress: {
          frames: states.get(channelNo).outputProgress.frames + 1,
          lastVideoAdvanceAtMs: timestamp,
        },
      });
      if (withAudio) {
        states.get(channelNo).lastAudioWriteAtMs = timestamp;
        states.get(channelNo).audioFrames += 1;
      }
    }
    await recovery.tick("terminal");
  }
  return { recovery, states, actions, notifications, advance, now: () => timestamp };
}

test("verifies healthy channels without interrupting either publisher", async () => {
  const { recovery, actions, advance } = setup();
  const result = await recovery.start("terminal", [1, 2]);
  assert.equal(result.status, "recovering");
  assert.deepEqual(actions, []);
  await advance(500, [1, 2]);
  assert.equal(recovery.getStatus("terminal").status, "recovering");
  await advance(2000, [1, 2]);
  assert.equal(recovery.getStatus("terminal").status, "recovered");
  assert.deepEqual(actions, []);
});

test("trims only the delayed channel and preserves audio", async () => {
  const { recovery, states, actions, advance } = setup();
  states.get(2).videoQueueAgeMs = 1500;
  await recovery.start("terminal", [1, 2]);
  assert.deepEqual(actions, [["trim", 2]]);
  assert.match(recovery.getStatus("terminal").channels[1].message, /10 quadros/);
  await advance(500, [1, 2]);
  await advance(2000, [1, 2]);
  assert.equal(recovery.getStatus("terminal").status, "recovered");
  assert.equal(states.get(2).audioEnabled, true);
});

test("restarts only a blocked publisher while media is still arriving", async () => {
  const { recovery, states, actions } = setup();
  states.get(2).videoBlockedMs = 3000;
  await recovery.start("terminal", [1, 2]);
  assert.deepEqual(actions, [["restart", 2]]);
  assert.equal(states.get(1).status, "publishing");
});

test("does not restart a newly published stream before its first output progress report", async () => {
  const { recovery, states, actions } = setup();
  Object.assign(states.get(2), {
    status: "publishing",
    publisherStartedAtMs: 100_000,
    outputProgress: { frames: 0, lastVideoAdvanceAtMs: null },
  });

  await recovery.start("terminal", [2]);

  assert.deepEqual(actions, []);
  assert.equal(recovery.getStatus("terminal").channels[0].action, "check");
});

test("requests the camera only after video has been absent for five seconds", async () => {
  const { recovery, states, actions } = setup();
  states.get(2).lastVideoReceivedAtMs = 95_000;
  await recovery.start("terminal", [1, 2]);
  assert.deepEqual(actions, [["request", 2]]);
});

test("does not restart a local publisher while camera video remains absent", async () => {
  const { recovery, states, actions, advance } = setup();
  states.get(2).lastVideoReceivedAtMs = null;

  await recovery.start("terminal", [2]);
  await advance(10_000, [1]);

  assert.deepEqual(actions, [["request", 2]]);
  assert.equal(recovery.getStatus("terminal").channels[0].action, "request-media");
});

test("waits for an outstanding camera command rather than duplicating it", async () => {
  const { recovery, states, actions, advance } = setup();
  states.get(2).lastVideoReceivedAtMs = null;
  states.get(2).commandPending = true;
  await recovery.start("terminal", [1, 2]);
  await advance(6000, [1]);
  assert.deepEqual(actions, []);
  assert.equal(recovery.getStatus("terminal").channels[1].action, "waiting-command");
});

test("manual recovery respects camera retry timers even when live video is blocked", async () => {
  const { recovery, states, actions, advance } = setup();
  states.get(2).cameraRetryPending = true;
  states.get(2).videoBlockedMs = 4000;
  await recovery.start("terminal", [2]);
  assert.equal(recovery.getStatus("terminal").channels[0].action, "waiting-command");
  await advance(3000);
  assert.deepEqual(actions, []);
  states.get(2).cameraRetryPending = false;
  states.get(2).lastVideoReceivedAtMs = 106_000;
  await advance(3000);
  assert.deepEqual(actions, [["restart", 2]]);
});

test("waiting for a command does not permanently consume the recovery camera request", async () => {
  const { recovery, states, actions, advance } = setup();
  states.get(2).lastVideoReceivedAtMs = null;
  states.get(2).commandPending = true;
  await recovery.start("terminal", [2]);
  assert.equal(recovery.getStatus("terminal").channels[0].cameraRequested, false);
  states.get(2).commandPending = false;
  await advance(3000);
  assert.deepEqual(actions, [["request", 2]]);
  await advance(3000);
  assert.deepEqual(actions, [["request", 2]]);
});

test("a camera retry taking over during recovery prevents publisher escalation", async () => {
  const { recovery, states, actions, advance } = setup();
  states.get(2).videoQueueAgeMs = 1500;
  await recovery.start("terminal", [2]);
  states.get(2).cameraRetryPending = true;
  states.get(2).lastVideoReceivedAtMs = 103_000;
  await advance(3000);
  assert.deepEqual(actions, [["trim", 2]]);
  assert.equal(recovery.getStatus("terminal").channels[0].action, "waiting-command");
  states.get(2).cameraRetryPending = false;
  states.get(2).lastVideoReceivedAtMs = null;
  await advance(3000);
  assert.deepEqual(actions, [["trim", 2], ["request", 2]]);
});

test("escalates a persistent queue once, without restarting the healthy sibling", async () => {
  const { recovery, states, actions, advance } = setup();
  states.get(2).videoQueueAgeMs = 1500;
  await recovery.start("terminal", [1, 2]);
  states.get(2).lastVideoReceivedAtMs = 103_000;
  await advance(3000, [1]);
  assert.deepEqual(actions, [["trim", 2], ["restart", 2]]);
  states.get(2).lastVideoReceivedAtMs = 106_000;
  await advance(3000, [1]);
  assert.deepEqual(actions, [["trim", 2], ["restart", 2]]);
});

test("requests camera media if input stops during local recovery", async () => {
  const { recovery, states, actions, advance } = setup();
  states.get(2).videoBlockedMs = 3000;
  await recovery.start("terminal", [1, 2]);
  await advance(5000, [1]);
  await advance(5000, [1]);
  assert.deepEqual(actions, [["restart", 2], ["request", 2]]);
});

test("reports a timeout rather than successful restart without advancing audio", async () => {
  const { recovery, states, advance } = setup();
  states.get(2).lastVideoReceivedAtMs = null;
  await recovery.start("terminal", [1, 2]);
  await advance(500, [1]);
  await advance(2000, [1]);
  await advance(27_500);
  const result = recovery.getStatus("terminal");
  assert.equal(result.status, "failed");
  assert.equal(result.channels[0].status, "recovered");
  assert.match(result.channels[1].message, /30 segundos/);
});

test("does not confirm a publishing stream whose output has stopped advancing", async () => {
  const { recovery, advance } = setup();
  await recovery.start("terminal", [1]);
  await advance(500, [1]);
  await advance(2000);
  assert.equal(recovery.getStatus("terminal").status, "recovering");
});

test("recognizes progress after an automatic publisher restart resets frame counters", async () => {
  const { recovery, states, advance } = setup();
  await recovery.start("terminal", [1]);
  states.get(1).videoFrames = 0;
  states.get(1).audioFrames = 0;
  await advance(500, [1]);
  await advance(2000, [1]);
  assert.equal(recovery.getStatus("terminal").status, "recovered");
});

test("requires new audio writes when audio is enabled", async () => {
  const { recovery, advance } = setup();
  await recovery.start("terminal", [1]);
  await advance(500, [1], false);
  await advance(2000, [1], false);
  assert.equal(recovery.getStatus("terminal").status, "recovering");
});

test("accepts a configured video-only channel without enabling audio", async () => {
  const { recovery, states, advance } = setup();
  states.get(1).audioEnabled = false;
  await recovery.start("terminal", [1]);
  await advance(500, [1]);
  await advance(2000, [1]);
  assert.equal(recovery.getStatus("terminal").status, "recovered");
  assert.equal(states.get(1).audioEnabled, false);
});

test("respects manually stopped channels and cancels an in-progress recovery", async () => {
  const { recovery, states, actions, advance } = setup();
  states.get(2).enabled = false;
  await recovery.start("terminal", [1, 2]);
  assert.deepEqual(recovery.getStatus("terminal").channels.map((c) => c.channelNo), [1]);
  states.get(1).enabled = false;
  await advance(500);
  assert.equal(recovery.getStatus("terminal").status, "failed");
  assert.match(recovery.getStatus("terminal").channels[0].message, /operador/);
  assert.deepEqual(actions, []);
});

test("rejects concurrent clicks and enforces the cooldown on completed recovery", async () => {
  const { recovery, advance } = setup();
  await recovery.start("terminal", [1]);
  await assert.rejects(recovery.start("terminal", [1]), { statusCode: 409 });
  await advance(500, [1]);
  await advance(2000, [1]);
  await assert.rejects(recovery.start("terminal", [1]), { statusCode: 429 });
  await advance(27_500);
  await recovery.start("terminal", [1]);
});

test("surfaces camera command failures per channel", async () => {
  const { recovery, states, notifications, advance } = setup({
    requestMedia: async () => { throw new Error("Terminal desconectado"); },
  });
  states.get(2).lastVideoReceivedAtMs = null;
  await recovery.start("terminal", [1, 2]);
  assert.equal(recovery.getStatus("terminal").channels[1].status, "failed");
  assert.match(notifications.at(-1).channels[1].message, /desconectado/);
  await advance(500, [1]);
  await advance(2000, [1]);
  assert.equal(recovery.getStatus("terminal").status, "failed");
});

async function setupMonitor() {
  const fixture = setup();
  await fixture.recovery.monitor("terminal", [1, 2]);
  await fixture.advance(20_000, [1, 2]);
  return fixture;
}

test("automatic monitor allows startup and ignores healthy publishers", async () => {
  const { recovery, actions, advance } = setup();
  await recovery.monitor("terminal", [1, 2]);
  await advance(19_999);
  await recovery.monitor("terminal", [1, 2]);
  assert.deepEqual(actions, []);
  await advance(1, [1, 2]);
  await recovery.monitor("terminal", [1, 2]);
  await advance(3000, [1, 2]);
  await recovery.monitor("terminal", [1, 2]);
  assert.equal(recovery.getStatus("terminal"), null);
});

test("automatic monitor preserves publishers while strict synchronization is holding", async () => {
  const { recovery, states, actions, advance, now } = await setupMonitor();
  for (const state of states.values()) {
    state.syncStatus = { mode: "strict-arrival", state: "holding" };
    state.outputProgress.lastVideoAdvanceAtMs = now() - 5_000;
  }

  await advance(4_000);
  await recovery.monitor("terminal", [1, 2]);

  assert.deepEqual(actions, []);
  assert.equal(recovery.getStatus("terminal"), null);
});

test("does not escalate an active recovery while strict synchronization is holding", async () => {
  const { recovery, states, actions, advance, now } = setup();
  const state = states.get(2);
  state.syncStatus = { mode: "strict-arrival", state: "holding" };
  state.lastVideoReceivedAtMs = now();
  state.outputProgress.lastVideoAdvanceAtMs = now() - 5_000;

  await recovery.start("terminal", [2]);
  assert.equal(recovery.getStatus("terminal").channels[0].action, "waiting-sync");
  await advance(1_000);
  assert.deepEqual(actions, []);

  state.syncStatus.state = "aligned";
  await advance(500, [2]);
  await advance(500, [2]);
  await advance(2_000, [2]);

  assert.equal(recovery.getStatus("terminal").status, "recovered");
  assert.deepEqual(actions, []);
});

test("automatic monitor recovers only a persistently blocked channel", async () => {
  const { recovery, states, actions, advance } = await setupMonitor();
  states.get(2).videoBlockedMs = 3000;
  await recovery.monitor("terminal", [1, 2]);
  await advance(2999, [1]);
  states.get(2).lastVideoReceivedAtMs += 2999;
  await recovery.monitor("terminal", [1, 2]);
  assert.deepEqual(actions, []);
  await advance(1, [1]);
  await recovery.monitor("terminal", [1, 2]);
  assert.deepEqual(actions, [["restart", 2]]);
  const result = recovery.getStatus("terminal");
  assert.equal(result.source, "automatic");
  assert.deepEqual(result.channels.map((c) => c.channelNo), [2]);
  assert.match(result.channels[0].reason, /bloqueada/);
  await advance(500, [2]);
  await advance(2000, [2]);
  assert.equal(recovery.getStatus("terminal").status, "recovered");
});

test("automatic monitor does not react to transient queue bursts", async () => {
  const { recovery, states, actions, advance } = await setupMonitor();
  states.get(2).videoQueueAgeMs = 1000;
  await recovery.monitor("terminal", [1, 2]);
  await advance(2000, [1, 2]);
  await recovery.monitor("terminal", [1, 2]);
  await advance(4000, [1, 2]);
  await recovery.monitor("terminal", [1, 2]);
  assert.deepEqual(actions, []);
});

test("automatic monitor trims a persistent queue without disturbing the sibling", async () => {
  const { recovery, states, actions, advance, now } = await setupMonitor();
  states.get(2).videoQueueAgeMs = 1000;
  await recovery.monitor("terminal", [1, 2]);
  await advance(3000, [1]);
  states.get(2).lastVideoReceivedAtMs = now();
  states.get(2).lastVideoWriteAtMs = now();
  states.get(2).lastAudioWriteAtMs = now();
  states.get(2).outputProgress.lastVideoAdvanceAtMs = now();
  await recovery.monitor("terminal", [1, 2]);
  assert.deepEqual(actions, [["trim", 2]]);
});

test("automatic monitor re-requests camera media after persistent absence of video", async () => {
  const { recovery, states, actions, advance } = await setupMonitor();
  states.get(2).syncStatus = { mode: "strict-arrival", state: "holding" };
  await advance(5000, [1]);
  await recovery.monitor("terminal", [1, 2]);
  await advance(3000, [1]);
  await recovery.monitor("terminal", [1, 2]);
  assert.deepEqual(actions, [["request", 2]]);
});

test("does not restart advancing video solely because camera audio stopped arriving", async () => {
  const { recovery, states, actions, advance, now } = await setupMonitor();
  await advance(5000, [1, 2], false);
  states.get(1).lastAudioWriteAtMs = now();
  await recovery.monitor("terminal", [1, 2]);
  await advance(3000, [1, 2], false);
  states.get(1).lastAudioWriteAtMs = now();
  await recovery.monitor("terminal", [1, 2]);
  assert.deepEqual(actions, []);
});

test("does not mistake new input writes or repeated progress reports for output advancement", async () => {
  const { recovery, states, actions, advance, now } = await setupMonitor();
  const stalledOutput = { ...states.get(2).outputProgress };
  await advance(3000, [1, 2]);
  states.get(2).outputProgress = { ...stalledOutput, lastReportAtMs: now() };
  await recovery.monitor("terminal", [1, 2]);
  await advance(3000, [1, 2]);
  states.get(2).outputProgress = { ...stalledOutput, lastReportAtMs: now() };
  await recovery.monitor("terminal", [1, 2]);
  assert.deepEqual(actions, [["restart", 2]]);
});

test("waits for a newly restarted publisher even when its input pipe is blocked", async () => {
  const { recovery, states, actions, advance, now } = await setupMonitor();
  Object.assign(states.get(2), {
    status: "starting", publisherStartedAtMs: now(), videoBlockedMs: 10_000,
  });
  await recovery.monitor("terminal", [1, 2]);
  await recovery.start("terminal", [2]);
  states.get(2).lastVideoReceivedAtMs = now() + 6000;
  await advance(6000, [1]);
  states.get(2).lastVideoReceivedAtMs = now();
  await recovery.monitor("terminal", [1, 2]);
  assert.deepEqual(actions, []);
  states.get(2).lastVideoReceivedAtMs = now() + 14_000;
  await advance(14_000, [1]);
  states.get(2).lastVideoReceivedAtMs = now();
  await recovery.tick("terminal");
  assert.deepEqual(actions, [["restart", 2]]);
});

test("confirms degraded video recovery without pretending camera audio is present", async () => {
  const { recovery, states, actions, advance } = setup();
  states.get(2).audioEnabled = false;
  states.get(2).audioState = "waiting";
  await recovery.start("terminal", [2]);
  await advance(500, [2], false);
  await advance(2000, [2], false);
  assert.equal(recovery.getStatus("terminal").status, "recovered");
  assert.match(recovery.getStatus("terminal").channels[0].message, /aguardando audio/);
  assert.deepEqual(actions, []);
});

test("automatic monitor respects pending commands, retry timers, disabled and disconnected channels", async () => {
  for (const setting of [
    { commandPending: true },
    { cameraRetryPending: true },
    { enabled: false },
    { connected: false },
  ]) {
    const { recovery, states, actions, advance } = await setupMonitor();
    Object.assign(states.get(2), setting, { lastVideoReceivedAtMs: null });
    await recovery.monitor("terminal", [1, 2]);
    await advance(30_000, [1]);
    await recovery.monitor("terminal", [1, 2]);
    assert.deepEqual(actions, []);
  }
});

test("automatic monitor gives a reconnected channel a fresh startup grace", async () => {
  const { recovery, states, actions, advance } = await setupMonitor();
  states.get(2).connected = false;
  await recovery.monitor("terminal", [1, 2]);
  await advance(30_000, [1]);
  states.get(2).connected = true;
  await recovery.monitor("terminal", [1, 2]);
  await advance(19_999, [1]);
  await recovery.monitor("terminal", [1, 2]);
  assert.deepEqual(actions, []);
});

test("manual and automatic recoveries share the same concurrency guard and cooldown", async () => {
  const { recovery, states, actions, advance } = await setupMonitor();
  states.get(2).lastVideoReceivedAtMs = null;
  await recovery.monitor("terminal", [1, 2]);
  await recovery.start("terminal", [2]);
  await advance(3000, [1]);
  await recovery.monitor("terminal", [1, 2]);
  assert.deepEqual(actions, [["request", 2]]);
  assert.equal(recovery.getStatus("terminal").source, "manual");
  await advance(500, [2]);
  await advance(2000, [2]);
  states.get(2).lastVideoReceivedAtMs = null;
  await recovery.monitor("terminal", [1, 2]);
  assert.deepEqual(actions, [["request", 2]]);
});

test("failed automatic recoveries use increasing retry delays capped at five minutes", async () => {
  const { recovery, states, actions, advance } = await setupMonitor();
  states.get(2).lastVideoReceivedAtMs = null;
  const retryDelays = [60_000, 120_000, 240_000, 300_000, 300_000];
  for (let attempt = 0; attempt < retryDelays.length; attempt += 1) {
    await recovery.monitor("terminal", [1, 2]);
    await advance(3000, [1]);
    await recovery.monitor("terminal", [1, 2]);
    assert.equal(actions.length, attempt + 1);
    await advance(30_000, [1]);
    assert.equal(recovery.getStatus("terminal").status, "failed");
    await recovery.monitor("terminal", [1, 2]);
    await advance(retryDelays[attempt] - 1, [1]);
    await recovery.monitor("terminal", [1, 2]);
    assert.equal(actions.length, attempt + 1);
    await advance(1, [1]);
  }
});
