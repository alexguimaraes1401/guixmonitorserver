import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeFrame,
  encodeGeneralResponse,
  encodeMessage,
  encodeRealtimeAvRequestBody,
  encodeRegistrationResponse,
  encodeStreamControlBody,
  parseAvAttributes,
  parseRegistration,
  parseTerminalGeneralResponse,
} from "../src/jt808.js";

const legacyPhone = Buffer.from("001200053180", "hex");

test("round-trips a legacy JT808 frame containing escaped bytes", () => {
  const wireFrame = encodeMessage({
    messageId: 0x0200,
    terminalPhone: legacyPhone,
    serial: 42,
    body: Buffer.from([0x7e, 0x7d, 0x01]),
  });

  const decoded = decodeFrame(wireFrame);
  assert.equal(decoded.messageId, 0x0200);
  assert.equal(decoded.serial, 42);
  assert.deepEqual(decoded.terminalPhone, legacyPhone);
  assert.deepEqual(decoded.body, Buffer.from([0x7e, 0x7d, 0x01]));
  assert.equal(decoded.hasVersion, false);
});

test("round-trips a versioned JT808 frame", () => {
  const phone = Buffer.from("00123456789012345678", "hex");
  const wireFrame = encodeMessage({
    messageId: 0x0002,
    terminalPhone: phone,
    serial: 7,
    hasVersion: true,
    version: 1,
  });

  const decoded = decodeFrame(wireFrame);
  assert.equal(decoded.hasVersion, true);
  assert.equal(decoded.version, 1);
  assert.deepEqual(decoded.terminalPhone, phone);
});

test("rejects a frame with an invalid checksum", () => {
  const wireFrame = encodeMessage({
    messageId: 0x0002,
    terminalPhone: legacyPhone,
    serial: 1,
  });
  wireFrame[wireFrame.length - 2] ^= 0x01;

  assert.throws(() => decodeFrame(wireFrame), /checksum mismatch/);
});

test("builds a registration acknowledgement with the requested auth code", () => {
  const request = {
    messageId: 0x0100,
    terminalPhone: legacyPhone,
    serial: 12,
    hasVersion: false,
  };
  const response = decodeFrame(
    encodeRegistrationResponse(request, 3, "test-code"),
  );

  assert.equal(response.messageId, 0x8100);
  assert.equal(response.serial, 3);
  assert.equal(response.body.readUInt16BE(0), 12);
  assert.equal(response.body[2], 0);
  assert.equal(response.body.subarray(3).toString("utf8"), "test-code");
});

test("builds a terminal general-response acknowledgement", () => {
  const request = {
    messageId: 0x0002,
    terminalPhone: legacyPhone,
    serial: 99,
    hasVersion: false,
  };
  const response = decodeFrame(encodeGeneralResponse(request, 4));

  assert.equal(response.messageId, 0x8001);
  assert.equal(response.body.readUInt16BE(0), 0x0002);
  assert.equal(response.body.readUInt16BE(2), 99);
  assert.equal(response.body[4], 0);
});

test("parses the standard fixed fields from a registration body", () => {
  const body = Buffer.alloc(37);
  body.writeUInt16BE(35, 0);
  body.writeUInt16BE(76, 2);
  Buffer.from("forfu").copy(body, 4);
  Buffer.from("A3-LA").copy(body, 9);
  Buffer.from("8005318").copy(body, 29);

  assert.deepEqual(parseRegistration(body), {
    provinceId: 35,
    cityId: 76,
    manufacturer: "forfu",
    model: "A3-LA",
    terminalId: "8005318",
  });
});

test("encodes a JT1078 audio-and-video main-stream request body", () => {
  const body = encodeRealtimeAvRequestBody({
    serverIp: "201.66.73.13",
    tcpPort: 1078,
    udpPort: 0,
    channelNo: 2,
    dataType: 0,
    streamType: 0,
  });

  assert.equal(body[0], Buffer.byteLength("201.66.73.13"));
  assert.equal(body.subarray(1, 13).toString("ascii"), "201.66.73.13");
  assert.equal(body.readUInt16BE(13), 1078);
  assert.equal(body.readUInt16BE(15), 0);
  assert.deepEqual([...body.subarray(17)], [2, 0, 0]);

  const frame = decodeFrame(
    encodeMessage({
      messageId: 0x9101,
      terminalPhone: legacyPhone,
      serial: 23,
      body,
    }),
  );
  assert.equal(frame.messageId, 0x9101);
  assert.deepEqual(frame.body, body);
});

test("encodes a command to stop the selected video channel", () => {
  assert.deepEqual(
    encodeStreamControlBody({
      channelNo: 2,
      controlCommand: 0,
      closeAvData: 0,
      streamType: 0,
    }),
    Buffer.from([2, 0, 0, 0]),
  );
});

test("parses AV attributes and terminal command results", () => {
  const attributes = Buffer.from([1, 1, 2, 8, 0, 40, 1, 2, 2, 4]);
  assert.deepEqual(parseAvAttributes(attributes), {
    audioEncoding: 1,
    audioChannels: 1,
    audioSampleRate: 2,
    audioSampleBits: 8,
    audioFrameLength: 40,
    supportsAudioOutput: true,
    videoEncoding: 2,
    maxAudioChannels: 2,
    maxVideoChannels: 4,
  });
  assert.equal(parseAvAttributes(Buffer.alloc(9)), null);

  const responseBody = Buffer.from([0x00, 0x17, 0x91, 0x01, 0x00]);
  assert.deepEqual(parseTerminalGeneralResponse(responseBody), {
    responseSerial: 23,
    responseMessageId: 0x9101,
    result: 0,
  });
  assert.equal(parseTerminalGeneralResponse(Buffer.alloc(4)), null);
});
