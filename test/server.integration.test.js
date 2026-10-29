import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { decodeFrame, encodeMessage } from "../src/jt808.js";

const workspaceRoot = fileURLToPath(new URL("..", import.meta.url));
const terminalPhone = Buffer.from("001200053180", "hex");

test("queries AV capabilities, starts video, and stops it over JT808", async (t) => {
  const jt808Port = await reservePort();
  const dashboardPort = await reservePort();
  const mediaPort = await reservePort();
  const publicMediaPort = await reservePort();
  let childOutput = "";
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      JT808_PORT: String(jt808Port),
      JT808_HOST_PORT: "6608",
      DASHBOARD_PORT: String(dashboardPort),
      JT1078_PORT: String(mediaPort),
      JT1078_RECONNECT_GRACE_MS: "100",
      JT1078_PUBLIC_PORT: String(publicMediaPort),
      JT1078_PUBLIC_IP: "127.0.0.1",
      JT1078_CHANNEL_2_STREAM_TYPE: "0",
      RTSP_MEDIA_ENABLED: "false",
      JT808_AUTH_CODE: "integration-test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    childOutput = `${childOutput}${chunk}`.slice(-20_000);
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    childOutput = `${childOutput}${chunk}`.slice(-20_000);
  });

  const socket = new net.Socket();
  const backupSocket = new net.Socket();
  const mediaSocket = new net.Socket();
  const secondMediaSocket = new net.Socket();
  const retrySecondMediaSocket = new net.Socket();
  const repeatedMediaSocket = new net.Socket();
  const retryMediaSocket = new net.Socket();
  t.after(async () => {
    socket.destroy();
    backupSocket.destroy();
    mediaSocket.destroy();
    secondMediaSocket.destroy();
    retrySecondMediaSocket.destroy();
    repeatedMediaSocket.destroy();
    retryMediaSocket.destroy();
    if (child.exitCode === null) {
      child.kill();
      if (child.exitCode === null) {
        await once(child, "exit");
      }
    }
  });

  const baseUrl = `http://127.0.0.1:${dashboardPort}`;
  await waitFor(async () => {
    if (child.exitCode !== null) {
      throw new Error(`JT808 test server exited:\n${childOutput}`);
    }
    try {
      return (await fetch(`${baseUrl}/healthz`)).ok;
    } catch {
      return false;
    }
  });

  socket.connect(jt808Port, "127.0.0.1");
  await once(socket, "connect");
  const nextFrame = createFrameReader(socket);
  const nextBackupFrame = createFrameReader(backupSocket);

  const registration = Buffer.alloc(37);
  registration.writeUInt16BE(35, 0);
  registration.writeUInt16BE(76, 2);
  Buffer.from("forfu").copy(registration, 4);
  Buffer.from("A3-LA").copy(registration, 9);
  Buffer.from("8005318").copy(registration, 29);
  const registrationResponse = decodeFrame(
    await sendAndRead(nextFrame, socket, 0x0100, 1, registration),
  );
  assert.equal(registrationResponse.messageId, 0x8100);

  const loginResponse = decodeFrame(
    await sendAndRead(nextFrame, socket, 0x0102, 2),
  );
  assert.equal(loginResponse.messageId, 0x8001);
  const queryFrame = decodeFrame(await nextFrame());
  assert.equal(queryFrame.messageId, 0x9003);
  assert.equal(queryFrame.body.length, 0);

  backupSocket.connect(jt808Port, "127.0.0.1");
  await once(backupSocket, "connect");
  assert.equal(
    decodeFrame(
      await sendAndRead(nextBackupFrame, backupSocket, 0x0100, 3, registration),
    ).messageId,
    0x8100,
  );
  assert.equal(
    decodeFrame(await sendAndRead(nextBackupFrame, backupSocket, 0x0102, 4)).messageId,
    0x8001,
  );

  backupSocket.write(encodeMessage({
    messageId: 0x0001,
    terminalPhone,
    serial: 10,
    body: terminalResponseBody(queryFrame),
  }));

  const attributes = Buffer.from([1, 1, 2, 8, 0, 40, 1, 2, 2, 1]);
  const capabilitiesAckPromise = nextBackupFrame();
  backupSocket.write(encodeMessage({
    messageId: 0x1003,
    terminalPhone,
    serial: 11,
    body: attributes,
  }));
  assert.equal(decodeFrame(await capabilitiesAckPromise).messageId, 0x8001);
  await waitFor(async () => {
    const snapshot = await (await fetch(`${baseUrl}/api/status`)).json();
    return snapshot.terminals[0]?.capabilitiesStatus === "ready";
  });

  const startFrames = (
    await Promise.all([nextBackupFrame(), nextBackupFrame()])
  ).map(decodeFrame);
  assert.deepEqual(startFrames.map((frame) => frame.messageId), [0x9101, 0x9101]);
  const channelNos = startFrames.map((frame) => {
    const ipLength = frame.body[0];
    assert.equal(frame.body.subarray(1, 1 + ipLength).toString("ascii"), "127.0.0.1");
    const portOffset = 1 + ipLength;
    assert.equal(frame.body.readUInt16BE(portOffset), publicMediaPort);
    assert.equal(frame.body.readUInt16BE(portOffset + 2), 0);
    assert.equal(frame.body[portOffset + 5], 0);
    assert.equal(frame.body[portOffset + 6], 0);
    return frame.body[portOffset + 4];
  });
  assert.deepEqual(channelNos, [1, 2]);
  for (const [index, frame] of startFrames.entries()) {
    backupSocket.write(encodeMessage({
      messageId: 0x0001,
      terminalPhone,
      serial: 12 + index,
      body: terminalResponseBody(frame),
    }));
  }
  await waitFor(async () => {
    const snapshot = await (await fetch(`${baseUrl}/api/status`)).json();
    return snapshot.terminals[0]?.videoChannels?.length === 2 &&
      snapshot.terminals[0].videoChannels.every(
        (channel) => channel.status === "accepted",
      );
  });
  const rtspSnapshot = await (await fetch(`${baseUrl}/api/status`)).json();
  assert.deepEqual(
    rtspSnapshot.terminals[0].rtspStreams.map(({ channelNo }) => channelNo),
    [1, 2],
  );
  assert.deepEqual(
    rtspSnapshot.terminals[0].rtspStreams.map(({ audioEnabled }) => audioEnabled),
    [true, false],
  );
  assert.equal(
    rtspSnapshot.terminals[0].rtspAudioStream.path,
    "terminal-001200053180-audio",
  );
  assert.equal(rtspSnapshot.terminals[0].rtspAudioStream.audioRequested, true);
  assert.equal(rtspSnapshot.terminals[0].rtspAudioStream.status, "disabled");
  assert.equal(
    rtspSnapshot.terminals[0].timestampMonitor.sampleIntervalMs,
    5000,
  );
  assert.equal(rtspSnapshot.terminals[0].timestampMonitor.sampleCount, 0);
  assert.ok(
    rtspSnapshot.terminals[0].rtspStreams.every(
      ({ timing }) => typeof timing?.maxQueuedBytes === "number",
    ),
  );

  const heartbeatAckPromise = nextFrame();
  socket.write(encodeMessage({
    messageId: 0x0002,
    terminalPhone,
    serial: 5,
  }));
  assert.equal(decodeFrame(await heartbeatAckPromise).messageId, 0x8001);

  mediaSocket.connect(mediaPort, "127.0.0.1");
  await once(mediaSocket, "connect");
  const mediaPacket = createMediaPacket(1);
  const secondMediaPacket = createMediaPacket(2);
  mediaSocket.write(mediaPacket);
  secondMediaSocket.connect(mediaPort, "127.0.0.1");
  await once(secondMediaSocket, "connect");
  secondMediaSocket.write(secondMediaPacket);
  await waitFor(async () => {
    const snapshot = await (await fetch(`${baseUrl}/api/status`)).json();
    return snapshot.terminals[0]?.activeMediaStreams?.length === 2;
  });

  const channel2RestartPromise = nextFrame();
  const channel2Closed = once(secondMediaSocket, "close");
  secondMediaSocket.destroy();
  await channel2Closed;
  await waitFor(async () => {
    const snapshot = await (await fetch(`${baseUrl}/api/status`)).json();
    return snapshot.events.some(
      (event) =>
        event.type === "media-stream-reconnect-grace-started" &&
        event.channelNo === 2,
    );
  });
  await new Promise((resolve) => setTimeout(resolve, 25));
  let mediaCloseSnapshot = await (await fetch(`${baseUrl}/api/status`)).json();
  assert.equal(
    mediaCloseSnapshot.events.some(
      (event) =>
        event.type === "video-stream-auto-restart-scheduled" &&
        event.message.includes("canal 2"),
    ),
    false,
    "camera restart should wait for the reconnect grace",
  );
  await waitFor(async () => {
    mediaCloseSnapshot = await (await fetch(`${baseUrl}/api/status`)).json();
    return mediaCloseSnapshot.events.some(
      (event) =>
        event.type === "video-stream-auto-restart-scheduled" &&
        event.message.includes("canal 2"),
    );
  });
  const channel2RestartFrame = decodeFrame(
    await channel2RestartPromise.catch((error) => {
      throw new Error(`${error.message}\n${childOutput}`);
    }),
  );
  assert.equal(channel2RestartFrame.messageId, 0x9101);
  assert.equal(channel2RestartFrame.body[1 + channel2RestartFrame.body[0] + 4], 2);
  assert.equal(channel2RestartFrame.body[1 + channel2RestartFrame.body[0] + 6], 0);
  backupSocket.write(encodeMessage({
    messageId: 0x0001,
    terminalPhone,
    serial: 16,
    body: terminalResponseBody(channel2RestartFrame),
  }));
  retrySecondMediaSocket.connect(mediaPort, "127.0.0.1");
  await once(retrySecondMediaSocket, "connect");
  retrySecondMediaSocket.write(secondMediaPacket);
  await waitFor(async () => {
    const snapshot = await (await fetch(`${baseUrl}/api/status`)).json();
    return snapshot.terminals[0]?.activeMediaStreams?.some(
      (stream) => stream.channelNo === 2,
    );
  });
  const transientSnapshot = await (await fetch(`${baseUrl}/api/status`)).json();
  assert.equal(transientSnapshot.terminals[0].videoChannels.find(({ channelNo }) => channelNo === 2).cameraRetryAttempts, 1);
  const repeatedRestartPromise = nextBackupFrame();
  retrySecondMediaSocket.destroy();
  const repeatedRestart = decodeFrame(await repeatedRestartPromise);
  assert.equal(repeatedRestart.messageId, 0x9101);
  assert.equal(repeatedRestart.body[1 + repeatedRestart.body[0] + 4], 2);
  backupSocket.write(encodeMessage({
    messageId: 0x0001, terminalPhone, serial: 17,
    body: terminalResponseBody(repeatedRestart),
  }));
  repeatedMediaSocket.connect(mediaPort, "127.0.0.1");
  await once(repeatedMediaSocket, "connect");
  repeatedMediaSocket.write(secondMediaPacket);
  await waitFor(async () => {
    const snapshot = await (await fetch(`${baseUrl}/api/status`)).json();
    return snapshot.terminals[0]?.activeMediaStreams?.some(({ channelNo }) => channelNo === 2);
  });
  const repeatedSnapshot = await (await fetch(`${baseUrl}/api/status`)).json();
  assert.equal(repeatedSnapshot.terminals[0].videoChannels.find(({ channelNo }) => channelNo === 2).cameraRetryAttempts, 2);
  assert.ok(repeatedSnapshot.events.some(event =>
    event.type === "video-stream-auto-restart-scheduled" && event.message.includes("2000 ms")));
  const stableMediaTimer = setInterval(() => repeatedMediaSocket.write(secondMediaPacket), 100);
  t.after(() => clearInterval(stableMediaTimer));
  await waitFor(async () => {
    const snapshot = await (await fetch(`${baseUrl}/api/status`)).json();
    return snapshot.terminals[0]?.videoChannels.find(({ channelNo }) => channelNo === 2).cameraRetryAttempts === 0;
  }, 7000);
  clearInterval(stableMediaTimer);

  const stopPrimaryPromise = nextFrame();
  const stopBackupPromise = nextBackupFrame();
  const stopResult = await postCommand(baseUrl, "stop", { channelNo: 1 });
  assert.equal(stopResult.response.status, 202);
  assert.equal(stopResult.body.sessions, 2);
  assert.equal(stopResult.body.serials.length, 2);
  assert.notEqual(stopResult.body.serials[0], stopResult.body.serials[1]);
  const stopFrame = decodeFrame(await stopBackupPromise);
  const stopPrimaryFrame = decodeFrame(await stopPrimaryPromise);
  assert.equal(stopFrame.messageId, 0x9102);
  assert.deepEqual(stopFrame.body, Buffer.from([1, 0, 0, 0]));
  assert.equal(stopPrimaryFrame.messageId, 0x9102);
  assert.equal(stopPrimaryFrame.serial, stopResult.body.serials[0]);
  assert.equal(stopFrame.serial, stopResult.body.serials[1]);
  const mediaClosed = once(mediaSocket, "close");
  backupSocket.write(encodeMessage({
    messageId: 0x0001,
    terminalPhone,
    serial: 13,
    body: terminalResponseBody(stopFrame),
  }));
  socket.write(encodeMessage({
    messageId: 0x0001,
    terminalPhone,
    serial: 15,
    body: terminalResponseBody(stopPrimaryFrame),
  }));
  await mediaClosed;
  await waitFor(async () => {
    const snapshot = await (await fetch(`${baseUrl}/api/status`)).json();
    return (
      snapshot.media.activeConnections === 1 &&
      snapshot.terminals[0]?.activeMediaStreams?.some(
        (stream) => stream.channelNo === 2,
      ) &&
      snapshot.terminals[0]?.videoStatus === "stop-accepted"
    );
  });
  retryMediaSocket.connect(mediaPort, "127.0.0.1");
  await once(retryMediaSocket, "connect");
  const retryClosed = once(retryMediaSocket, "close");
  retryMediaSocket.write(mediaPacket);
  await retryClosed;
  await waitFor(async () => {
    const snapshot = await (await fetch(`${baseUrl}/api/status`)).json();
    return (
      snapshot.media.activeConnections === 1 &&
      snapshot.events.some((event) => event.type === "media-stream-rejected-after-stop")
    );
  });
  const stoppedSnapshot = await (await fetch(`${baseUrl}/api/status`)).json();
  assert.ok(
    stoppedSnapshot.events.some((event) => event.type === "media-connection-forced-close"),
  );

  // A recuperação exige publicação RTSP habilitada.
  const resyncResult = await postCommand(baseUrl, "resync");
  assert.equal(resyncResult.response.status, 409);
  assert.match(resyncResult.body.error, /recuperar/i);
});

test("recovery requests missing camera media through JT808 without changing stream type",
  (t) => testRecovery(t, "manual"));

test("server automatically detects failed publishers without a dashboard command",
  (t) => testRecovery(t, "automatic"));

test("automatic recovery can be disabled while manual recovery remains available",
  (t) => testRecovery(t, "disabled"));

test("missing camera acknowledgements preserve live video but audio alone does not suppress retries",
  (t) => testRecovery(t, "ack-missing"));

test("late start acknowledgements do not override a manual stop or schedule retries",
  (t) => testRecovery(t, "late-stop"));

async function testRecovery(t, source) {
  const jt808Port = await reservePort();
  const dashboardPort = await reservePort();
  const mediaPort = await reservePort();
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      JT808_PORT: String(jt808Port),
      DASHBOARD_PORT: String(dashboardPort),
      JT1078_PORT: String(mediaPort),
      JT1078_PUBLIC_PORT: String(mediaPort),
      JT1078_PUBLIC_IP: "127.0.0.1",
      JT1078_CHANNEL_1_STREAM_TYPE: "0",
      JT1078_CHANNEL_2_STREAM_TYPE: "0",
      RTSP_MEDIA_ENABLED: "true",
      VIDEO_AUTO_RECOVERY_ENABLED: source === "disabled" ? "false" : "true",
      FFMPEG_PATH: "guix-test-missing-ffmpeg",
    },
    stdio: "ignore",
  });
  const socket = new net.Socket();
  const mediaSocket = new net.Socket();
  let mediaTimer;
  t.after(async () => {
    clearInterval(mediaTimer);
    mediaSocket.destroy();
    socket.destroy();
    if (child.exitCode === null) {
      child.kill();
      if (child.exitCode === null) {
        await once(child, "exit");
      }
    }
  });
  const baseUrl = `http://127.0.0.1:${dashboardPort}`;
  await waitFor(async () => {
    if (child.exitCode !== null) {
      throw new Error("Recovery test server exited before startup");
    }
    try {
      return (await fetch(`${baseUrl}/healthz`)).ok;
    } catch {
      return false;
    }
  });
  socket.connect(jt808Port, "127.0.0.1");
  await once(socket, "connect");
  const nextFrame = createFrameReader(socket);
  const registration = Buffer.alloc(37);
  Buffer.from("8005318").copy(registration, 29);
  await sendAndRead(nextFrame, socket, 0x0100, 1, registration);
  await sendAndRead(nextFrame, socket, 0x0102, 2);
  const query = decodeFrame(await nextFrame());
  socket.write(encodeMessage({
    messageId: 0x0001, terminalPhone, serial: 3,
    body: terminalResponseBody(query),
  }));
  await sendAndRead(nextFrame, socket, 0x1003, 4, Buffer.from([19, 1, 0, 8, 0, 40, 99, 2, 2, 1]));
  const starts = [];
  for (let index = 0; index < 2; index += 1) {
    const start = decodeFrame(await nextFrame());
    starts.push(start);
    const channelNo = start.body[1 + start.body[0] + 4];
    if (source !== "ack-missing" && !(source === "late-stop" && channelNo === 1)) {
      socket.write(encodeMessage({
        messageId: 0x0001, terminalPhone, serial: 5 + index,
        body: terminalResponseBody(start),
      }));
    }
  }
  if (source === "late-stop") {
    const result = await postCommand(baseUrl, "stop", { channelNo: 1 });
    assert.equal(result.response.status, 202);
    const stop = decodeFrame(await nextFrame());
    assert.equal(stop.messageId, 0x9102);
    socket.write(encodeMessage({
      messageId: 0x0001, terminalPhone, serial: 10,
      body: terminalResponseBody(stop),
    }));
    const lateStart = starts.find(({ body }) => body[1 + body[0] + 4] === 1);
    socket.write(encodeMessage({
      messageId: 0x0001, terminalPhone, serial: 11,
      body: terminalResponseBody(lateStart),
    }));
    await waitFor(async () => {
      const snapshot = await (await fetch(`${baseUrl}/api/status`)).json();
      return snapshot.events.some(event => event.type === "video-start-response-after-stop");
    });
    const snapshot = await (await fetch(`${baseUrl}/api/status`)).json();
    const channel = snapshot.terminals[0].videoChannels.find(({ channelNo }) => channelNo === 1);
    assert.equal(channel.status, "stop-accepted");
    assert.equal(channel.autoStart, false);
    assert.equal(channel.cameraRetryPending, false);
    assert.equal(channel.cameraRetryAttempts, 0);
    return;
  }
  if (source === "ack-missing") {
    mediaSocket.connect(mediaPort, "127.0.0.1");
    await once(mediaSocket, "connect");
    const audioPacket = Buffer.alloc(27);
    Buffer.from([0x30, 0x31, 0x63, 0x64]).copy(audioPacket);
    terminalPhone.copy(audioPacket, 8);
    audioPacket[14] = 2;
    audioPacket[15] = 0x30;
    audioPacket.writeUInt16BE(1, 24);
    audioPacket[26] = 0x21;
    const sendMedia = () => {
      if (!mediaSocket.destroyed) {
        mediaSocket.write(createMediaPacket(1));
        mediaSocket.write(audioPacket);
      }
    };
    sendMedia();
    mediaTimer = setInterval(sendMedia, 250);
    const result = await postCommand(baseUrl, "resync");
    assert.equal(result.response.status, 202);
    assert.ok(result.body.channels.every(({ action }) => action === "waiting-command"));
    const retry = decodeFrame(await nextFrame(20_000));
    assert.equal(retry.messageId, 0x9101);
    assert.equal(retry.body[1 + retry.body[0] + 4], 2);
    const snapshot = await (await fetch(`${baseUrl}/api/status`)).json();
    assert.ok(snapshot.events.some(event => event.type === "video-start-ack-missing" && event.channelNo === 1));
    assert.ok(snapshot.events.some(event => event.type === "video-stream-auto-restart-scheduled"));
    assert.ok(snapshot.terminals[0].activeMediaStreams.some(({ channelNo }) => channelNo === 1));
    assert.equal(mediaSocket.destroyed, false);
    assert.equal(snapshot.terminals[0].videoChannels.find(({ channelNo }) => channelNo === 1).cameraRetryAttempts, 0);
    assert.equal(snapshot.terminals[0].videoChannels.find(({ channelNo }) => channelNo === 2).cameraRetryAttempts, 1);
    return;
  }
  await waitFor(async () => {
    const status = await (await fetch(`${baseUrl}/api/status`)).json();
    return status.terminals[0]?.videoChannels.every(({ status }) => status === "accepted");
  });
  if (source === "automatic") {
    mediaSocket.connect(mediaPort, "127.0.0.1");
    await once(mediaSocket, "connect");
    const sendMedia = () => {
      mediaSocket.write(createMediaPacket(1));
      mediaSocket.write(createMediaPacket(2));
    };
    sendMedia();
    mediaTimer = setInterval(sendMedia, 500);
    await waitFor(async () => {
      const status = await (await fetch(`${baseUrl}/api/status`)).json();
      return status.terminals[0]?.recovery?.source === "automatic";
    }, 30_000);
    const status = await (await fetch(`${baseUrl}/api/status`)).json();
    const recovery = status.terminals[0].recovery;
    assert.equal(status.terminals[0].autoRecoveryEnabled, true);
    assert.deepEqual(recovery.channels.map(({ channelNo }) => channelNo), [1, 2]);
    assert.ok(recovery.channels.every(({ action }) => action === "restart-publisher"));
    assert.equal((await postCommand(baseUrl, "resync")).response.status, 409);
    return;
  }
  const result = await postCommand(baseUrl, "resync");
  assert.equal(result.response.status, 202);
  assert.equal(result.body.status, "recovering");
  assert.deepEqual(result.body.channels.map(({ action }) => action), ["waiting-command", "waiting-command"]);
  const requests = (await Promise.all([nextFrame(25_000), nextFrame(25_000)])).map(decodeFrame);
  assert.deepEqual(requests.map(({ messageId }) => messageId), [0x9101, 0x9101]);
  assert.deepEqual(requests.map(({ body }) => body[1 + body[0] + 4]), [1, 2]);
  for (const { body } of requests) {
    assert.equal(body[1 + body[0] + 5], 0);
    assert.equal(body[1 + body[0] + 6], 0);
  }
  const duplicate = await postCommand(baseUrl, "resync");
  assert.equal(duplicate.response.status, 409);
  const status = await (await fetch(`${baseUrl}/api/status`)).json();
  assert.equal(status.terminals[0].recovery.status, "recovering");
  assert.equal(status.terminals[0].recovery.source, "manual");
  assert.equal(status.terminals[0].autoRecoveryEnabled, source !== "disabled");
}

test("resumes previously requested video after reconnect and honors a manual stop", async (t) => {
  const jt808Port = await reservePort();
  const dashboardPort = await reservePort();
  const mediaPort = await reservePort();
  const publicMediaPort = await reservePort();
  let childOutput = "";
  const child = spawn(process.execPath, ["src/server.js"], {
    cwd: workspaceRoot,
    env: {
      ...process.env,
      JT808_PORT: String(jt808Port),
      JT808_HOST_PORT: "6608",
      DASHBOARD_PORT: String(dashboardPort),
      JT1078_PORT: String(mediaPort),
      JT1078_PUBLIC_PORT: String(publicMediaPort),
      JT1078_PUBLIC_IP: "127.0.0.1",
      RTSP_MEDIA_ENABLED: "false",
      JT808_AUTH_CODE: "integration-test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    childOutput = `${childOutput}${chunk}`.slice(-20_000);
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    childOutput = `${childOutput}${chunk}`.slice(-20_000);
  });

  const sockets = [
    new net.Socket(),
    new net.Socket(),
    new net.Socket(),
  ];
  const mediaSockets = [new net.Socket(), new net.Socket()];
  const frameReaders = sockets.map(createFrameReader);
  t.after(async () => {
    for (const socket of [...sockets, ...mediaSockets]) {
      socket.destroy();
    }
    if (child.exitCode === null) {
      child.kill();
      if (child.exitCode === null) {
        await once(child, "exit");
      }
    }
  });

  const baseUrl = `http://127.0.0.1:${dashboardPort}`;
  await waitFor(async () => {
    if (child.exitCode !== null) {
      throw new Error(`JT808 test server exited:\n${childOutput}`);
    }
    try {
      return (await fetch(`${baseUrl}/healthz`)).ok;
    } catch {
      return false;
    }
  });

  const registration = Buffer.alloc(37);
  registration.writeUInt16BE(35, 0);
  registration.writeUInt16BE(76, 2);
  Buffer.from("forfu").copy(registration, 4);
  Buffer.from("A3-LA").copy(registration, 9);
  Buffer.from("8005318").copy(registration, 29);

  async function connectAndLogin(socket, nextFrame, registrationSerial) {
    socket.connect(jt808Port, "127.0.0.1");
    await once(socket, "connect");
    assert.equal(
      decodeFrame(
        await sendAndRead(
          nextFrame,
          socket,
          0x0100,
          registrationSerial,
          registration,
        ),
      ).messageId,
      0x8100,
    );
    assert.equal(
      decodeFrame(
        await sendAndRead(
          nextFrame,
          socket,
          0x0102,
          registrationSerial + 1,
        ),
      ).messageId,
      0x8001,
    );
  }

  await connectAndLogin(sockets[0], frameReaders[0], 1);
  const firstCapabilitiesFrame = decodeFrame(await frameReaders[0]());
  assert.equal(firstCapabilitiesFrame.messageId, 0x9003);
  sockets[0].write(encodeMessage({
    messageId: 0x0001,
    terminalPhone,
    serial: 10,
    body: terminalResponseBody(firstCapabilitiesFrame),
  }));
  const attributes = Buffer.from([1, 1, 2, 8, 0, 40, 1, 2, 2, 2]);
  const firstCapabilitiesAck = frameReaders[0]();
  sockets[0].write(encodeMessage({
    messageId: 0x1003,
    terminalPhone,
    serial: 11,
    body: attributes,
  }));
  assert.equal(decodeFrame(await firstCapabilitiesAck).messageId, 0x8001);
  await waitFor(async () => {
    const snapshot = await (await fetch(`${baseUrl}/api/status`)).json();
    return snapshot.terminals[0]?.capabilitiesStatus === "ready";
  });

  const firstStartFrames = (
    await Promise.all([frameReaders[0](), frameReaders[0]()])
  ).map(decodeFrame);
  assert.deepEqual(
    firstStartFrames.map((frame) => frame.body[1 + frame.body[0] + 4]),
    [1, 2],
  );
  for (const [index, frame] of firstStartFrames.entries()) {
    sockets[0].write(encodeMessage({
      messageId: 0x0001,
      terminalPhone,
      serial: 12 + index,
      body: terminalResponseBody(frame),
    }));
  }
  await waitFor(async () => {
    const snapshot = await (await fetch(`${baseUrl}/api/status`)).json();
    return snapshot.terminals[0]?.videoChannels?.length === 2 &&
      snapshot.terminals[0].videoChannels.every(
        (channel) => channel.status === "accepted",
      );
  });

  const mediaPacket = createMediaPacket(1);
  mediaSockets[0].connect(mediaPort, "127.0.0.1");
  await once(mediaSockets[0], "connect");
  mediaSockets[0].write(mediaPacket);
  await waitFor(async () => {
    const snapshot = await (await fetch(`${baseUrl}/api/status`)).json();
    return snapshot.terminals[0]?.activeMediaStreams?.some(
      (stream) => stream.channelNo === 1,
    );
  });

  const firstSocketClosed = once(sockets[0], "close");
  const firstMediaClosed = once(mediaSockets[0], "close");
  sockets[0].destroy();
  await Promise.all([firstSocketClosed, firstMediaClosed]);
  await waitFor(async () => {
    const snapshot = await (await fetch(`${baseUrl}/api/status`)).json();
    return (
      snapshot.terminals[0]?.connected === false &&
      snapshot.terminals[0]?.videoStatus === "reconnecting" &&
      snapshot.media.activeConnections === 0
    );
  });

  await connectAndLogin(sockets[1], frameReaders[1], 3);
  const resumedCapabilitiesFrame = decodeFrame(await frameReaders[1]());
  assert.equal(resumedCapabilitiesFrame.messageId, 0x9003);
  sockets[1].write(encodeMessage({
    messageId: 0x0001,
    terminalPhone,
    serial: 14,
    body: terminalResponseBody(resumedCapabilitiesFrame),
  }));
  const resumedCapabilitiesAck = frameReaders[1]();
  sockets[1].write(encodeMessage({
    messageId: 0x1003,
    terminalPhone,
    serial: 15,
    body: attributes,
  }));
  assert.equal(decodeFrame(await resumedCapabilitiesAck).messageId, 0x8001);
  const resumedStartFrames = (
    await Promise.all([frameReaders[1](), frameReaders[1]()])
  ).map(decodeFrame);
  assert.deepEqual(
    resumedStartFrames.map((frame) => frame.body[1 + frame.body[0] + 4]),
    [1, 2],
  );
  for (const [index, frame] of resumedStartFrames.entries()) {
    sockets[1].write(encodeMessage({
      messageId: 0x0001,
      terminalPhone,
      serial: 16 + index,
      body: terminalResponseBody(frame),
    }));
  }
  await waitFor(async () => {
    const snapshot = await (await fetch(`${baseUrl}/api/status`)).json();
    return snapshot.terminals[0]?.videoChannels?.every(
      (channel) => channel.status === "accepted",
    );
  });

  mediaSockets[1].connect(mediaPort, "127.0.0.1");
  await once(mediaSockets[1], "connect");
  mediaSockets[1].write(mediaPacket);
  await waitFor(async () => {
    const snapshot = await (await fetch(`${baseUrl}/api/status`)).json();
    return snapshot.terminals[0]?.activeMediaStreams?.some(
      (stream) => stream.channelNo === 1,
    );
  });

  const stopPromise = frameReaders[1]();
  const stopResult = await postCommand(baseUrl, "stop", { channelNo: 1 });
  assert.equal(stopResult.response.status, 202);
  const stopFrame = decodeFrame(await stopPromise);
  const resumedMediaClosed = once(mediaSockets[1], "close");
  sockets[1].write(encodeMessage({
    messageId: 0x0001,
    terminalPhone,
    serial: 17,
    body: terminalResponseBody(stopFrame),
  }));
  await resumedMediaClosed;
  await waitFor(async () => {
    const snapshot = await (await fetch(`${baseUrl}/api/status`)).json();
    return snapshot.terminals[0]?.videoStatus === "stop-accepted";
  });

  const secondSocketClosed = once(sockets[1], "close");
  sockets[1].destroy();
  await secondSocketClosed;
  await connectAndLogin(sockets[2], frameReaders[2], 5);
  const finalCapabilitiesFrame = decodeFrame(await frameReaders[2]());
  assert.equal(finalCapabilitiesFrame.messageId, 0x9003);
  sockets[2].write(encodeMessage({
    messageId: 0x0001,
    terminalPhone,
    serial: 19,
    body: terminalResponseBody(finalCapabilitiesFrame),
  }));
  const finalCapabilitiesAck = frameReaders[2]();
  sockets[2].write(encodeMessage({
    messageId: 0x1003,
    terminalPhone,
    serial: 20,
    body: attributes,
  }));
  assert.equal(decodeFrame(await finalCapabilitiesAck).messageId, 0x8001);
  const finalStartFrame = decodeFrame(await frameReaders[2]());
  assert.equal(finalStartFrame.messageId, 0x9101);
  assert.equal(finalStartFrame.body[1 + finalStartFrame.body[0] + 4], 2);
  sockets[2].write(encodeMessage({
    messageId: 0x0001,
    terminalPhone,
    serial: 21,
    body: terminalResponseBody(finalStartFrame),
  }));
  await waitFor(async () => {
    const snapshot = await (await fetch(`${baseUrl}/api/status`)).json();
    const channel1 = snapshot.terminals[0]?.videoChannels?.find(
      (channel) => channel.channelNo === 1,
    );
    const channel2 = snapshot.terminals[0]?.videoChannels?.find(
      (channel) => channel.channelNo === 2,
    );
    return channel1?.status === "stop-accepted" && channel2?.status === "accepted";
  });
});

async function reservePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

function createMediaPacket(channelNo) {
  const packet = Buffer.alloc(31);
  Buffer.from([0x30, 0x31, 0x63, 0x64]).copy(packet, 0);
  terminalPhone.copy(packet, 8);
  packet[14] = channelNo;
  packet[15] = 0;
  packet.writeUInt16BE(1, 28);
  packet[30] = 0x42;
  return packet;
}

function createFrameReader(socket) {
  let buffer = Buffer.alloc(0);
  const frames = [];
  const waiters = [];

  socket.on("data", (chunk) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
      const start = buffer.indexOf(0x7e);
      if (start === -1) {
        buffer = Buffer.alloc(0);
        return;
      }
      const end = buffer.indexOf(0x7e, start + 1);
      if (end === -1) {
        buffer = buffer.subarray(start);
        return;
      }
      const frame = buffer.subarray(start, end + 1);
      buffer = buffer.subarray(end + 1);
      const waiter = waiters.shift();
      if (waiter) {
        waiter.resolve(frame);
      } else {
        frames.push(frame);
      }
    }
  });
  socket.on("close", () => {
    for (const waiter of waiters.splice(0)) {
      waiter.reject(new Error("JT808 test socket closed unexpectedly"));
    }
  });

  return (timeoutMs = 5000) => {
    if (frames.length > 0) {
      return Promise.resolve(frames.shift());
    }
    return new Promise((resolve, reject) => {
      let waiter;
      const timer = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index !== -1) {
          waiters.splice(index, 1);
        }
        reject(new Error("Timed out waiting for a JT808 frame"));
      }, timeoutMs);
      waiter = {
        resolve: (frame) => {
          clearTimeout(timer);
          resolve(frame);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      waiters.push(waiter);
    });
  };
}

async function sendAndRead(nextFrame, socket, messageId, serial, body) {
  const responsePromise = nextFrame();
  socket.write(encodeMessage({ messageId, terminalPhone, serial, body }));
  return responsePromise;
}

function terminalResponseBody(commandFrame) {
  const body = Buffer.alloc(5);
  body.writeUInt16BE(commandFrame.serial, 0);
  body.writeUInt16BE(commandFrame.messageId, 2);
  body[4] = 0;
  return body;
}

async function postCommand(baseUrl, action, parameters = {}) {
  const response = await fetch(
    `${baseUrl}/api/terminals/8005318/video/${action}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(parameters),
    },
  );
  return { response, body: await response.json() };
}

async function waitFor(predicate, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for JT808 server state");
}
