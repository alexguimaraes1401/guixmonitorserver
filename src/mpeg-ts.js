const PACKET_BYTES = 188;
const PMT_PID = 0x1000;
const MEDIA_PID = 0x100;
const CLOCK_WRAP = 2 ** 33;

// One elementary stream per pipe; both pipes receive timestamps from the same clock.
export function createMpegTsWriter(codec) {
  const streamType = { h264: 0x1b, hevc: 0x24, aac: 0x0f }[codec];
  if (streamType === undefined) {
    throw new RangeError(`Unsupported MPEG-TS codec: ${codec}`);
  }
  const counters = new Map();
  const pat = withCrc(Buffer.from([
    0x00, 0xb0, 0x0d, 0x00, 0x01, 0xc1, 0x00, 0x00,
    0x00, 0x01, 0xe0 | (PMT_PID >> 8), PMT_PID & 0xff,
  ]));
  const pmt = withCrc(Buffer.from([
    0x02, 0xb0, 0x12, 0x00, 0x01, 0xc1, 0x00, 0x00,
    0xe0 | (MEDIA_PID >> 8), MEDIA_PID & 0xff, 0xf0, 0x00,
    streamType, 0xe0 | (MEDIA_PID >> 8), MEDIA_PID & 0xff, 0xf0, 0x00,
  ]));

  function packetize(pid, payload, pcr = null, randomAccess = false) {
    const packets = [];
    let offset = 0;
    while (offset < payload.length) {
      const first = offset === 0;
      const withPcr = first && pcr !== null;
      const size = Math.min(payload.length - offset, withPcr ? 176 : 184);
      const adaptationBytes = 184 - size;
      const packet = Buffer.alloc(PACKET_BYTES, 0xff);
      packet[0] = 0x47;
      packet[1] = (first ? 0x40 : 0) | (pid >> 8);
      packet[2] = pid & 0xff;
      const counter = counters.get(pid) ?? 0;
      packet[3] = (adaptationBytes > 0 ? 0x30 : 0x10) | counter;
      counters.set(pid, (counter + 1) & 0x0f);
      if (adaptationBytes > 0) {
        packet[4] = adaptationBytes - 1;
        if (adaptationBytes > 1) {
          packet[5] = (withPcr ? 0x10 : 0) | (first && randomAccess ? 0x40 : 0);
          if (withPcr) {
            const base = pcr % CLOCK_WRAP;
            packet[6] = Math.floor(base / 2 ** 25);
            packet[7] = Math.floor(base / 2 ** 17) & 0xff;
            packet[8] = Math.floor(base / 2 ** 9) & 0xff;
            packet[9] = Math.floor(base / 2) & 0xff;
            packet[10] = ((base % 2) << 7) | 0x7e;
            packet[11] = 0;
          }
        }
      }
      payload.copy(packet, 4 + adaptationBytes, offset, offset + size);
      packets.push(packet);
      offset += size;
    }
    return packets;
  }

  return {
    write(payload, timestamp90k, { keyFrame = false } = {}) {
      if (!Buffer.isBuffer(payload) || payload.length === 0) {
        throw new TypeError("MPEG-TS payload must be a nonempty Buffer");
      }
      if (!Number.isSafeInteger(timestamp90k) || timestamp90k < 0) {
        throw new RangeError("MPEG-TS timestamp must be a nonnegative safe integer");
      }
      const pes = Buffer.alloc(14);
      pes.set([0, 0, 1, codec === "aac" ? 0xc0 : 0xe0]);
      const length = payload.length + 8;
      if (codec === "aac" && length > 0xffff) {
        throw new RangeError("AAC PES payload exceeds 65535 bytes");
      }
      pes.writeUInt16BE(codec === "aac" ? length : 0, 4);
      pes.set([0x80, 0x80, 0x05], 6);
      const pts = timestamp90k % CLOCK_WRAP;
      pes[9] = 0x21 | (Math.floor(pts / 2 ** 30) << 1);
      pes[10] = Math.floor(pts / 2 ** 22) & 0xff;
      pes[11] = ((Math.floor(pts / 2 ** 15) & 0x7f) << 1) | 1;
      pes[12] = Math.floor(pts / 2 ** 7) & 0xff;
      pes[13] = ((pts & 0x7f) << 1) | 1;
      return Buffer.concat([
        ...packetize(0, Buffer.concat([Buffer.from([0]), pat])),
        ...packetize(PMT_PID, Buffer.concat([Buffer.from([0]), pmt])),
        ...packetize(MEDIA_PID, Buffer.concat([pes, payload]), timestamp90k, keyFrame),
      ]);
    },
  };
}

function withCrc(section) {
  let crc = 0xffffffff;
  for (const byte of section) {
    crc ^= byte << 24;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = ((crc << 1) ^ (crc & 0x80000000 ? 0x04c11db7 : 0)) >>> 0;
    }
  }
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc);
  return Buffer.concat([section, checksum]);
}
