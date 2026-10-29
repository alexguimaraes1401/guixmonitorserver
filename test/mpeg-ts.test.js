import assert from "node:assert/strict";
import test from "node:test";
import { createMpegTsWriter } from "../src/mpeg-ts.js";

function readPackets(buffer) {
  const result = [];
  for (let offset = 0; offset < buffer.length; offset += 188) {
    const packet = buffer.subarray(offset, offset + 188);
    assert.equal(packet.length, 188);
    assert.equal(packet[0], 0x47);
    const adaptation = (packet[3] >> 4) & 3;
    const start = adaptation & 2 ? 5 + packet[4] : 4;
    result.push({
      pid: ((packet[1] & 0x1f) << 8) | packet[2],
      counter: packet[3] & 0x0f,
      first: Boolean(packet[1] & 0x40),
      payload: packet.subarray(start),
      packet,
    });
  }
  return result;
}

function decodePts(bytes) {
  return ((bytes[0] >> 1) & 7) * 2 ** 30 +
    bytes[1] * 2 ** 22 + (bytes[2] >> 1) * 2 ** 15 +
    bytes[3] * 2 ** 7 + (bytes[4] >> 1);
}

test("MPEG-TS preserves payloads, 33-bit PTS/PCR and continuity across PES packets", () => {
  for (const codec of ["h264", "hevc", "aac"]) {
    const writer = createMpegTsWriter(codec);
    for (const size of [1, 161, 162, 170, 184, 185, 5000]) {
      const payload = Buffer.alloc(size, 0xab);
      const pts = 2 ** 33 + 90_123;
      const packets = readPackets(writer.write(payload, pts, { keyFrame: true }));
      assert.equal(packets[0].pid, 0);
      assert.equal(packets[1].pid, 0x1000);
      const media = packets.filter(packet => packet.pid === 0x100);
      const pes = Buffer.concat(media.map(packet => packet.payload));
      assert.equal(decodePts(pes.subarray(9, 14)), 90_123);
      assert.deepEqual(pes.subarray(14), payload);
      assert.equal(media[0].packet[5] & 0x50, 0x50);
      const pcr = media[0].packet;
      assert.equal(pcr[6] * 2 ** 25 + pcr[7] * 2 ** 17 +
        pcr[8] * 2 ** 9 + pcr[9] * 2 + (pcr[10] >> 7), 90_123);
      assert.equal(media[0].first, true);
      for (let index = 1; index < media.length; index += 1) {
        assert.equal(media[index].first, false);
        assert.equal(media[index].counter, (media[index - 1].counter + 1) & 15);
      }
    }
  }
});

test("MPEG-TS PAT and PMT have valid CRC and announce the correct codecs", () => {
  for (const [codec, streamType] of [["h264", 0x1b], ["hevc", 0x24], ["aac", 0x0f]]) {
    const packets = readPackets(createMpegTsWriter(codec).write(Buffer.from([1]), 90_000));
    for (const packet of packets.slice(0, 2)) {
      const section = packet.payload.subarray(1);
      let crc = 0xffffffff;
      for (const byte of section) {
        crc ^= byte << 24;
        for (let bit = 0; bit < 8; bit += 1) {
          crc = ((crc << 1) ^ (crc & 0x80000000 ? 0x04c11db7 : 0)) >>> 0;
        }
      }
      assert.equal(crc, 0);
    }
    assert.equal(packets[1].payload[13], streamType);
  }
});

test("MPEG-TS rejects unsupported codecs, timestamps and oversized AAC PES", () => {
  assert.throws(() => createMpegTsWriter("unknown"), /Unsupported/);
  const writer = createMpegTsWriter("aac");
  assert.throws(() => writer.write(Buffer.alloc(1), -1), /timestamp/);
  assert.throws(() => writer.write(Buffer.alloc(1), NaN), /timestamp/);
  assert.throws(() => writer.write(Buffer.alloc(0), 0), /nonempty/);
  assert.throws(() => writer.write(Buffer.alloc(65528), 0), /65535/);
});
