import assert from "node:assert/strict";
import test from "node:test";
import {
  createJt1078FrameAssembler,
  createJt1078Parser,
} from "../src/jt1078.js";

const phoneHex = "001200053180";

test("parses audio and video packets across TCP chunk boundaries", () => {
  const packets = [];
  const errors = [];
  const parser = createJt1078Parser({
    onPacket: (packet) => packets.push(packet),
    onError: (message) => errors.push(message),
  });
  const video = makePacket({ dataType: 0, body: Buffer.from([1, 2, 3]) });
  const audio = makePacket({ dataType: 3, body: Buffer.from([4, 5]) });

  parser.push(video.subarray(0, 7));
  parser.push(Buffer.concat([video.subarray(7), audio]));

  assert.equal(errors.length, 0);
  assert.equal(packets.length, 2);
  assert.equal(packets[0].terminalPhoneHex, phoneHex);
  assert.equal(packets[0].channelNo, 1);
  assert.equal(packets[0].dataType, 0);
  assert.equal(packets[0].timestampRaw, "1234");
  assert.equal(packets[0].timestampMs, 1234);
  assert.deepEqual(packets[0].body, Buffer.from([1, 2, 3]));
  assert.equal(packets[1].dataType, 3);
  assert.equal(packets[1].timestampRaw, "1234");
  assert.deepEqual(packets[1].body, Buffer.from([4, 5]));
});

test("preserves the complete 64-bit JT1078 timestamp as decimal text", () => {
  const packets = [];
  const parser = createJt1078Parser({
    onPacket: (packet) => packets.push(packet),
    onError: (message) => assert.fail(message),
  });
  const rawTimestamp = 18_446_744_073_709_551_615n;
  parser.push(makePacket({
    dataType: 0,
    timestamp: rawTimestamp,
    body: [],
  }));

  assert.equal(packets[0].timestampRaw, rawTimestamp.toString());
  assert.equal(packets[0].timestampMs, Number(rawTimestamp));
});

test("reassembles JT1078 first, middle, and last subpackets per channel", () => {
  const frames = [];
  const errors = [];
  const assembler = createJt1078FrameAssembler({
    onFrame: (frame) => frames.push(frame),
    onError: (message) => errors.push(message),
  });

  assembler.push(
    parseSinglePacket(
      makePacket({ dataType: 0x01, subpacketType: 1, body: [1, 2] }),
    ),
  );
  assembler.push(
    parseSinglePacket(
      makePacket({ dataType: 0x03, subpacketType: 0, body: [9] }),
    ),
  );
  assembler.push(
    parseSinglePacket(
      makePacket({ dataType: 0x01, subpacketType: 3, body: [3] }),
    ),
  );
  assembler.push(
    parseSinglePacket(
      makePacket({ dataType: 0x01, subpacketType: 2, body: [4, 5] }),
    ),
  );

  assert.equal(errors.length, 0);
  assert.equal(frames.length, 2);
  assert.equal(frames[0].kind, "audio");
  assert.equal(frames[0].timestampRaw, "1234");
  assert.deepEqual(frames[0].body, Buffer.from([9]));
  assert.equal(frames[1].kind, "video");
  assert.equal(frames[1].timestampRaw, "1234");
  assert.deepEqual(frames[1].body, Buffer.from([1, 2, 3, 4, 5]));
});

test("rejects packet lengths above the JT1078 maximum", () => {
  const errors = [];
  const parser = createJt1078Parser({
    onPacket: () => assert.fail("malformed packet must not be emitted"),
    onError: (message) => errors.push(message),
  });
  const malformed = makePacket({ dataType: 0, body: [] });
  malformed.writeUInt16BE(951, 28);
  parser.push(malformed);

  assert.ok(errors.some((message) => message.includes("exceeds 950")));
});

function parseSinglePacket(packetBytes) {
  let parsed;
  const parser = createJt1078Parser({
    onPacket: (packet) => {
      parsed = packet;
    },
    onError: (message) => assert.fail(message),
  });
  parser.push(packetBytes);
  assert.ok(parsed);
  return parsed;
}

function makePacket({
  dataType,
  timestamp = 1234n,
  subpacketType = 0,
  channelNo = 1,
  body,
}) {
  const payload = Buffer.from(body);
  const headerLength = dataType <= 2 ? 30 : dataType === 3 ? 26 : 18;
  const packet = Buffer.alloc(headerLength + payload.length);
  Buffer.from([0x30, 0x31, 0x63, 0x64]).copy(packet, 0);
  Buffer.from(phoneHex, "hex").copy(packet, 8);
  packet[14] = channelNo;
  packet[15] = (dataType << 4) | subpacketType;
  if (dataType <= 3) {
    packet.writeBigUInt64BE(BigInt(timestamp), 16);
  }
  packet.writeUInt16BE(payload.length, headerLength - 2);
  payload.copy(packet, headerLength);
  return packet;
}
