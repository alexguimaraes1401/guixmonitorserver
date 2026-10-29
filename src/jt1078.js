const JT1078_START = Buffer.from([0x30, 0x31, 0x63, 0x64]);
const MAX_PACKET_BODY_BYTES = 950;
const MAX_FRAME_BYTES = 4 * 1024 * 1024;

const HEADER_LAYOUT = new Map([
  [0, { headerLength: 30, video: true }],
  [1, { headerLength: 30, video: true }],
  [2, { headerLength: 30, video: true }],
  [3, { headerLength: 26, video: false }],
  [4, { headerLength: 18, video: false }],
]);

export function createJt1078Parser({ onPacket, onError }) {
  if (typeof onPacket !== "function" || typeof onError !== "function") {
    throw new TypeError("JT1078 parser callbacks are required");
  }

  let pending = Buffer.alloc(0);

  return {
    push(chunk) {
      pending = Buffer.concat([pending, chunk]);
      while (pending.length > 0) {
        const markerIndex = pending.indexOf(JT1078_START);
        if (markerIndex === -1) {
          if (pending.length > JT1078_START.length - 1) {
            pending = Buffer.from(pending.subarray(-3));
          }
          return;
        }
        if (markerIndex > 0) {
          onError(`Discarded ${markerIndex} byte(s) before a JT1078 marker`);
          pending = Buffer.from(pending.subarray(markerIndex));
        }
        if (pending.length < 16) {
          return;
        }

        const dataType = pending[15] >> 4;
        const layout = HEADER_LAYOUT.get(dataType);
        if (!layout) {
          onError(`Unsupported JT1078 data type ${dataType}`);
          pending = Buffer.from(pending.subarray(1));
          continue;
        }
        if (pending.length < layout.headerLength) {
          return;
        }

        const bodyLengthOffset = layout.headerLength - 2;
        const bodyLength = pending.readUInt16BE(bodyLengthOffset);
        if (bodyLength > MAX_PACKET_BODY_BYTES) {
          onError(
            `JT1078 packet body length ${bodyLength} exceeds ${MAX_PACKET_BODY_BYTES}`,
          );
          pending = Buffer.from(pending.subarray(1));
          continue;
        }

        const packetLength = layout.headerLength + bodyLength;
        if (pending.length < packetLength) {
          return;
        }
        onPacket(parsePacket(pending.subarray(0, packetLength), layout));
        pending = Buffer.from(pending.subarray(packetLength));
      }
    },
    reset() {
      pending = Buffer.alloc(0);
    },
  };
}

export function createJt1078FrameAssembler({ onFrame, onError }) {
  if (typeof onFrame !== "function" || typeof onError !== "function") {
    throw new TypeError("JT1078 frame assembler callbacks are required");
  }

  const assemblies = new Map();

  return {
    push(packet) {
      if (
        packet.dataType !== 0 &&
        packet.dataType !== 1 &&
        packet.dataType !== 2 &&
        packet.dataType !== 3
      ) {
        return;
      }

      const kind = packet.dataType === 3 ? "audio" : "video";
      const assemblyKey = `${packet.terminalPhoneHex}:${packet.channelNo}:${kind}`;
      const current = assemblies.get(assemblyKey);
      if (packet.subpacketType === 0) {
        assemblies.delete(assemblyKey);
        onFrame(makeFrame(packet, kind, packet.body));
        return;
      }
      if (packet.subpacketType === 1) {
        if (current) {
          onError(`Discarded incomplete JT1078 ${kind} frame`);
        }
        assemblies.set(assemblyKey, {
          firstPacket: packet,
          chunks: [packet.body],
          length: packet.body.length,
        });
        return;
      }
      if (packet.subpacketType !== 2 && packet.subpacketType !== 3) {
        onError(`Unsupported JT1078 subpacket type ${packet.subpacketType}`);
        assemblies.delete(assemblyKey);
        return;
      }
      if (!current) {
        onError(`JT1078 ${kind} continuation arrived without a first packet`);
        return;
      }

      current.length += packet.body.length;
      if (current.length > MAX_FRAME_BYTES) {
        assemblies.delete(assemblyKey);
        onError(`JT1078 ${kind} frame exceeds ${MAX_FRAME_BYTES} bytes`);
        return;
      }
      current.chunks.push(packet.body);
      if (packet.subpacketType === 2) {
        assemblies.delete(assemblyKey);
        onFrame(
          makeFrame(
            current.firstPacket,
            kind,
            Buffer.concat(current.chunks, current.length),
          ),
        );
      }
    },
    reset() {
      assemblies.clear();
    },
  };
}

function parsePacket(packetBytes, layout) {
  const dataTypeAndSubpacket = packetBytes[15];
  const dataType = dataTypeAndSubpacket >> 4;
  const timestampRaw =
    layout.video || dataType === 3
      ? packetBytes.readBigUInt64BE(16).toString()
      : null;
  const timestampMs = timestampRaw === null ? null : Number(timestampRaw);
  return {
    version: packetBytes[4] >> 6,
    marker: (packetBytes[5] & 0x80) !== 0,
    sequence: packetBytes.readUInt16BE(6),
    terminalPhoneHex: packetBytes.subarray(8, 14).toString("hex"),
    channelNo: packetBytes[14],
    dataType,
    subpacketType: dataTypeAndSubpacket & 0x0f,
    timestampRaw,
    timestampMs,
    lastIFrameIntervalMs: layout.video
      ? packetBytes.readUInt16BE(24)
      : null,
    lastFrameIntervalMs: layout.video
      ? packetBytes.readUInt16BE(26)
      : null,
    body: Buffer.from(packetBytes.subarray(layout.headerLength)),
    wireLength: packetBytes.length,
  };
}

function makeFrame(firstPacket, kind, body) {
  return {
    terminalPhoneHex: firstPacket.terminalPhoneHex,
    channelNo: firstPacket.channelNo,
    kind,
    dataType: firstPacket.dataType,
    timestampRaw: firstPacket.timestampRaw,
    timestampMs: firstPacket.timestampMs,
    lastIFrameIntervalMs: firstPacket.lastIFrameIntervalMs,
    lastFrameIntervalMs: firstPacket.lastFrameIntervalMs,
    body,
  };
}
