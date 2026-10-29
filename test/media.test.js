import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import test from "node:test";
import { createMediaReceiver } from "../src/media.js";

test("receives raw TCP media and detects the JT1078 start marker", async (t) => {
  const phone = Buffer.from("001200053180", "hex");
  let detectSignature;
  const observedEvents = [];
  const signatureDetected = new Promise((resolve) => {
    detectSignature = resolve;
  });
  const receiver = createMediaReceiver({
    port: 0,
    onEvent: (level, type, message, details) => {
      observedEvents.push({ level, type, message, details });
      if (type === "jt1078-signature-detected") {
        detectSignature();
      }
    },
  });
  receiver.server.listen(0, "127.0.0.1");
  await once(receiver.server, "listening");

  const address = receiver.server.address();
  assert.ok(address && typeof address === "object");
  const socket = net.connect(address.port, "127.0.0.1");
  receiver.allowStreamFor(phone, 1);
  t.after(async () => {
    socket.destroy();
    await new Promise((resolve) => receiver.server.close(resolve));
  });
  await once(socket, "connect");

  const packet = createVideoPacket(phone);
  socket.write(packet);
  await signatureDetected;

  assert.equal(receiver.getStatus().activeConnections, 1);
  assert.equal(receiver.getStatus().bytesReceivedTotal, packet.length);
  assert.equal(receiver.getStatus().signatureDetected, true);
  assert.deepEqual(receiver.getActiveStreamsFor(phone), [
    {
      channelNo: 1,
      bytesReceived: packet.length,
      lastDataAt: receiver.getStatus().lastMediaAt,
    },
  ]);
  assert.equal(receiver.hasActiveStreamFor(phone, 1), true);

  const closed = once(socket, "close");
  socket.end();
  await closed;
  assert.equal(receiver.getStatus().activeConnections, 0);
  assert.equal(receiver.getStatus().signatureDetected, true);
  const closeEvent = observedEvents.find(
    ({ type }) => type === "media-connection-closed",
  );
  assert.equal(closeEvent.details.channels[0].channelNo, 1);
  assert.equal(closeEvent.details.terminalPhoneHex, phone.toString("hex"));
  assert.equal(closeEvent.details.bytesReceived, packet.length);
  assert.ok(closeEvent.details.remoteAddress);
  assert.equal(typeof closeEvent.details.remotePort, "number");
  assert.equal(typeof closeEvent.details.connectionDurationMs, "number");
  assert.equal(closeEvent.details.hadError, false);
  assert.equal(closeEvent.details.closeInitiator, "unclassified");
});

test("keeps a channel active while another media connection remains open", async (t) => {
  const phone = Buffer.from("001200053180", "hex");
  const closedStreams = [];
  let identifiedCount = 0;
  let identifyBoth;
  const bothIdentified = new Promise((resolve) => {
    identifyBoth = resolve;
  });
  let closedConnectionCount = 0;
  let closeFirstConnection;
  let closeLastConnection;
  const firstConnectionClosed = new Promise((resolve) => {
    closeFirstConnection = resolve;
  });
  const lastConnectionClosed = new Promise((resolve) => {
    closeLastConnection = resolve;
  });
  let resolveLastStreamClosed;
  const lastStreamClosed = new Promise((resolve) => {
    resolveLastStreamClosed = resolve;
  });
  const receiver = createMediaReceiver({
    port: 0,
    reconnectGraceMs: 10,
    onEvent: (_level, type) => {
      if (type === "media-stream-identified" && ++identifiedCount === 2) {
        identifyBoth();
      }
      if (type === "media-connection-closed") {
        closedConnectionCount += 1;
        if (closedConnectionCount === 1) {
          closeFirstConnection();
        } else if (closedConnectionCount === 2) {
          closeLastConnection();
        }
      }
    },
    onStreamClosed: (terminalPhoneHex, channelNo) => {
      closedStreams.push({ terminalPhoneHex, channelNo });
      resolveLastStreamClosed();
    },
  });
  receiver.server.listen(0, "127.0.0.1");
  await once(receiver.server, "listening");

  const address = receiver.server.address();
  assert.ok(address && typeof address === "object");
  receiver.allowStreamFor(phone, 1);
  const first = net.connect(address.port, "127.0.0.1");
  const second = net.connect(address.port, "127.0.0.1");
  t.after(async () => {
    first.destroy();
    second.destroy();
    await new Promise((resolve) => receiver.server.close(resolve));
  });
  await Promise.all([once(first, "connect"), once(second, "connect")]);

  first.write(createVideoPacket(phone));
  second.write(createVideoPacket(phone));
  await bothIdentified;

  const firstClosed = once(first, "close");
  first.end();
  await Promise.all([firstClosed, firstConnectionClosed]);
  assert.equal(receiver.hasActiveStreamFor(phone, 1), true);
  assert.deepEqual(closedStreams, []);

  const secondClosed = once(second, "close");
  second.end();
  await Promise.all([
    secondClosed,
    lastConnectionClosed,
    lastStreamClosed,
  ]);
  assert.equal(receiver.hasActiveStreamFor(phone, 1), false);
  assert.deepEqual(closedStreams, [
    { terminalPhoneHex: phone.toString("hex"), channelNo: 1 },
  ]);
});

test("auto-allows media from JT1078 connections without explicit start request", async (t) => {
  const phone = Buffer.from("001200053180", "hex");
  let signatureResolved;
  const signatureDetected = new Promise((resolve) => {
    signatureResolved = resolve;
  });

  const receiver = createMediaReceiver({
    port: 0,
    onEvent: (_level, type) => {
      if (type === "jt1078-signature-detected") {
        signatureResolved();
      }
    },
  });
  receiver.server.listen(0, "127.0.0.1");
  await once(receiver.server, "listening");
  const address = receiver.server.address();
  assert.ok(address && typeof address === "object");
  const socket = net.connect(address.port, "127.0.0.1");
  t.after(async () => {
    socket.destroy();
    await new Promise((resolve) => receiver.server.close(resolve));
  });
  await once(socket, "connect");

  socket.write(createVideoPacket(phone));
  // With auto-allow, signature is detected and stream is accepted
  await signatureDetected;

  // Stream is auto-allowed and active while connected
  assert.equal(receiver.getStatus().activeConnections, 1);
  assert.equal(receiver.getStatus().signatureDetected, true);
  assert.equal(receiver.hasActiveStreamFor(phone, 1), true);

  socket.end();
  await once(socket, "close");

  // Connection cleaned up after close
  assert.equal(receiver.getStatus().activeConnections, 0);
});

test("preserves a stream close during the reconnect grace and cancels it on resumed media", async (t) => {
  const phone = Buffer.from("001200053180", "hex");
  const closedStreams = [];
  let disconnectCount = 0;
  let identifiedCount = 0;
  let identifyFirst;
  let identifySecond;
  const firstIdentified = new Promise((resolve) => {
    identifyFirst = resolve;
  });
  const secondIdentified = new Promise((resolve) => {
    identifySecond = resolve;
  });
  const receiver = createMediaReceiver({
    port: 0,
    reconnectGraceMs: 60,
    onEvent: (_level, type) => {
      if (type === "media-stream-identified") {
        identifiedCount += 1;
        (identifiedCount === 1 ? identifyFirst : identifySecond)();
      }
    },
    onStreamDisconnected: () => {
      disconnectCount += 1;
    },
    onStreamClosed: (terminalPhoneHex, channelNo) => {
      closedStreams.push({ terminalPhoneHex, channelNo });
    },
  });
  receiver.server.listen(0, "127.0.0.1");
  await once(receiver.server, "listening");
  const address = receiver.server.address();
  assert.ok(address && typeof address === "object");
  const first = net.connect(address.port, "127.0.0.1");
  let second;
  t.after(async () => {
    first.destroy();
    second?.destroy();
    await new Promise((resolve) => receiver.server.close(resolve));
  });
  await once(first, "connect");
  first.write(createVideoPacket(phone));
  await firstIdentified;
  const firstClosed = once(first, "close");
  first.end();
  await firstClosed;

  assert.equal(disconnectCount, 1);
  assert.deepEqual(closedStreams, []);

  second = net.connect(address.port, "127.0.0.1");
  await once(second, "connect");
  second.write(createVideoPacket(phone));
  await secondIdentified;
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.deepEqual(closedStreams, []);
  assert.equal(receiver.hasActiveStreamFor(phone, 1), true);

  const secondClosed = once(second, "close");
  second.end();
  await secondClosed;
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(disconnectCount, 2);
  assert.deepEqual(closedStreams, [
    { terminalPhoneHex: phone.toString("hex"), channelNo: 1 },
  ]);
});

test("accepts temporary JT1078 reconnects without exceeding the media connection limit", async (t) => {
  let rejectConnection;
  const connectionRejected = new Promise((resolve) => {
    rejectConnection = resolve;
  });
  const receiver = createMediaReceiver({
    port: 0,
    onEvent: (_level, type) => {
      if (type === "media-connection-rejected") {
        rejectConnection();
      }
    },
  });
  receiver.server.listen(0, "127.0.0.1");
  await once(receiver.server, "listening");

  const address = receiver.server.address();
  assert.ok(address && typeof address === "object");
  const sockets = Array.from({ length: 9 }, () =>
    net.connect(address.port, "127.0.0.1"),
  );
  t.after(async () => {
    sockets.forEach((socket) => socket.destroy());
    await new Promise((resolve) => receiver.server.close(resolve));
  });
  await Promise.all(sockets.map((socket) => once(socket, "connect")));
  await connectionRejected;

  assert.equal(receiver.getStatus().activeConnections, 8);
});

test("destroys a connection proactively after idleTimeoutMs without data", async (t) => {
  const phone = Buffer.from("001200053180", "hex");
  const observedEvents = [];
  let resolveStreamClosed;
  const streamClosed = new Promise((resolve) => {
    resolveStreamClosed = resolve;
  });
  const receiver = createMediaReceiver({
    port: 0,
    idleTimeoutMs: 100,
    reconnectGraceMs: 0,
    onEvent: (level, type, message, details) => {
      observedEvents.push({ level, type, message, details });
    },
    onStreamClosed: (terminalPhoneHex, channelNo) => {
      resolveStreamClosed({ terminalPhoneHex, channelNo });
    },
  });
  receiver.server.listen(0, "127.0.0.1");
  await once(receiver.server, "listening");

  const address = receiver.server.address();
  assert.ok(address && typeof address === "object");
  const socket = net.connect(address.port, "127.0.0.1");
  t.after(async () => {
    socket.destroy();
    await new Promise((resolve) => receiver.server.close(resolve));
  });
  await once(socket, "connect");

  socket.write(createVideoPacket(phone));
  const closed = once(socket, "close");
  const closedStream = await streamClosed;
  await closed;

  assert.deepEqual(closedStream, {
    terminalPhoneHex: phone.toString("hex"),
    channelNo: 1,
  });
  const idleTimeoutEvent = observedEvents.find(
    ({ type }) => type === "media-connection-idle-timeout",
  );
  assert.ok(idleTimeoutEvent);
  assert.equal(idleTimeoutEvent.details.channels[0].channelNo, 1);
  assert.equal(idleTimeoutEvent.details.closeInitiator, "idle-timeout");
  const closeEvent = observedEvents.find(
    ({ type }) => type === "media-connection-closed",
  );
  assert.equal(closeEvent.details.idleTimedOut, true);
});

test("rejects an invalid idleTimeoutMs", () => {
  assert.throws(
    () => createMediaReceiver({ port: 0, onEvent: () => {}, idleTimeoutMs: 0 }),
    RangeError,
  );
});

function createVideoPacket(phone) {
  const packet = Buffer.alloc(31);
  Buffer.from([0x30, 0x31, 0x63, 0x64]).copy(packet, 0);
  phone.copy(packet, 8);
  packet[14] = 1;
  packet[15] = 0x00;
  packet.writeUInt16BE(1, 28);
  packet[30] = 0x42;
  return packet;
}
