const FRAME_FLAG = 0x7e;
const ESCAPE = 0x7d;
const VERSION_FLAG = 0x4000;
const SUBPACKAGE_FLAG = 0x2000;
const BODY_LENGTH_MASK = 0x03ff;

export function decodeFrame(wireFrame) {
  if (
    wireFrame.length < 2 ||
    wireFrame[0] !== FRAME_FLAG ||
    wireFrame[wireFrame.length - 1] !== FRAME_FLAG
  ) {
    throw new Error("Frame is missing JT808 delimiters");
  }

  const bytes = unescapeBytes(wireFrame.subarray(1, -1));
  if (bytes.length < 13) {
    throw new Error("Frame is too short to contain a JT808 header");
  }

  const expectedChecksum = checksum(bytes.subarray(0, -1));
  const actualChecksum = bytes[bytes.length - 1];
  if (expectedChecksum !== actualChecksum) {
    throw new Error("JT808 checksum mismatch");
  }

  const messageId = bytes.readUInt16BE(0);
  const properties = bytes.readUInt16BE(2);
  const bodyLength = properties & BODY_LENGTH_MASK;
  const hasVersion = (properties & VERSION_FLAG) !== 0;
  const hasSubpackage = (properties & SUBPACKAGE_FLAG) !== 0;
  let offset = 4;
  let version;

  if (hasVersion) {
    version = bytes[offset];
    offset += 1;
  }

  const phoneLength = hasVersion ? 10 : 6;
  const terminalPhone = Buffer.from(bytes.subarray(offset, offset + phoneLength));
  offset += phoneLength;

  if (offset + 2 > bytes.length - 1) {
    throw new Error("JT808 header is incomplete");
  }

  const serial = bytes.readUInt16BE(offset);
  offset += 2;

  let subpackage;
  if (hasSubpackage) {
    if (offset + 4 > bytes.length - 1) {
      throw new Error("JT808 subpackage header is incomplete");
    }
    subpackage = {
      total: bytes.readUInt16BE(offset),
      index: bytes.readUInt16BE(offset + 2),
    };
    offset += 4;
  }

  const body = Buffer.from(bytes.subarray(offset, -1));
  if (body.length !== bodyLength) {
    throw new Error(
      `JT808 body length mismatch: declared ${bodyLength}, received ${body.length}`,
    );
  }

  return {
    messageId,
    properties,
    bodyLength,
    encrypted: ((properties >> 10) & 0x07) !== 0,
    hasVersion,
    version,
    hasSubpackage,
    subpackage,
    terminalPhone,
    serial,
    body,
  };
}

export function encodeMessage({
  messageId,
  terminalPhone,
  serial,
  body = Buffer.alloc(0),
  hasVersion = false,
  version = 1,
}) {
  const phone = Buffer.from(terminalPhone);
  const expectedPhoneLength = hasVersion ? 10 : 6;
  if (phone.length !== expectedPhoneLength) {
    throw new Error(`Terminal phone must be ${expectedPhoneLength} bytes`);
  }
  if (!Number.isInteger(messageId) || messageId < 0 || messageId > 0xffff) {
    throw new Error("Message ID must be a 16-bit unsigned integer");
  }
  if (!Number.isInteger(serial) || serial < 0 || serial > 0xffff) {
    throw new Error("Serial must be a 16-bit unsigned integer");
  }

  const payload = Buffer.from(body);
  if (payload.length > BODY_LENGTH_MASK) {
    throw new Error("JT808 body exceeds the 10-bit body length limit");
  }

  const header = Buffer.alloc(4 + (hasVersion ? 1 : 0) + phone.length + 2);
  header.writeUInt16BE(messageId, 0);
  header.writeUInt16BE(payload.length | (hasVersion ? VERSION_FLAG : 0), 2);

  let offset = 4;
  if (hasVersion) {
    if (!Number.isInteger(version) || version < 0 || version > 0xff) {
      throw new Error("Protocol version must be an 8-bit unsigned integer");
    }
    header[offset] = version;
    offset += 1;
  }
  phone.copy(header, offset);
  offset += phone.length;
  header.writeUInt16BE(serial, offset);

  const unescaped = Buffer.concat([header, payload]);
  const content = Buffer.concat([
    unescaped,
    Buffer.from([checksum(unescaped)]),
  ]);
  return Buffer.concat([
    Buffer.from([FRAME_FLAG]),
    escapeBytes(content),
    Buffer.from([FRAME_FLAG]),
  ]);
}

export function encodeGeneralResponse(request, responseSerial) {
  const body = Buffer.alloc(5);
  body.writeUInt16BE(request.messageId, 0);
  body.writeUInt16BE(request.serial, 2);
  body[4] = 0;

  return encodeMessage({
    messageId: 0x8001,
    terminalPhone: request.terminalPhone,
    serial: responseSerial,
    body,
    hasVersion: request.hasVersion,
    version: request.version,
  });
}

export function encodeRegistrationResponse(request, responseSerial, authCode) {
  const code = Buffer.from(authCode, "utf8");
  const body = Buffer.alloc(3 + code.length);
  body.writeUInt16BE(request.serial, 0);
  body[2] = 0;
  code.copy(body, 3);

  return encodeMessage({
    messageId: 0x8100,
    terminalPhone: request.terminalPhone,
    serial: responseSerial,
    body,
    hasVersion: request.hasVersion,
    version: request.version,
  });
}

export function encodeRealtimeAvRequestBody({
  serverIp,
  tcpPort,
  udpPort = 0,
  channelNo,
  dataType = 1,
  streamType = 0,
}) {
  const ipParts = serverIp.split(".");
  if (
    ipParts.length !== 4 ||
    ipParts.some(
      (part) =>
        !/^\d{1,3}$/.test(part) ||
        Number(part) < 0 ||
        Number(part) > 255,
    )
  ) {
    throw new Error("JT1078 server IP must be a valid IPv4 address");
  }

  const ipBytes = Buffer.from(serverIp, "ascii");
  if (ipBytes.length > 0xff) {
    throw new Error("JT1078 server IP is too long");
  }
  validateUint(tcpPort, 0xffff, "TCP port");
  validateUint(udpPort, 0xffff, "UDP port");
  validateUint(channelNo, 0xff, "Channel number");
  if (channelNo === 0) {
    throw new Error("Channel number must be greater than zero");
  }
  validateUint(dataType, 5, "AV data type");
  validateUint(streamType, 1, "Stream type");

  const body = Buffer.alloc(1 + ipBytes.length + 2 + 2 + 3);
  body[0] = ipBytes.length;
  ipBytes.copy(body, 1);
  let offset = 1 + ipBytes.length;
  body.writeUInt16BE(tcpPort, offset);
  offset += 2;
  body.writeUInt16BE(udpPort, offset);
  offset += 2;
  body[offset] = channelNo;
  body[offset + 1] = dataType;
  body[offset + 2] = streamType;
  return body;
}

export function encodeStreamControlBody({
  channelNo,
  controlCommand = 0,
  closeAvData = 0,
  streamType = 0,
}) {
  validateUint(channelNo, 0xff, "Channel number");
  validateUint(controlCommand, 4, "Stream control command");
  validateUint(closeAvData, 2, "Close AV data type");
  validateUint(streamType, 1, "Stream type");
  if (channelNo === 0) {
    throw new Error("Channel number must be greater than zero");
  }

  return Buffer.from([channelNo, controlCommand, closeAvData, streamType]);
}

export function parseAvAttributes(body) {
  if (body.length < 10) {
    return null;
  }

  return {
    audioEncoding: body[0],
    audioChannels: body[1],
    audioSampleRate: body[2],
    audioSampleBits: body[3],
    audioFrameLength: body.readUInt16BE(4),
    supportsAudioOutput: body[6] !== 0,
    videoEncoding: body[7],
    maxAudioChannels: body[8],
    maxVideoChannels: body[9],
  };
}

export function parseTerminalGeneralResponse(body) {
  if (body.length !== 5) {
    return null;
  }

  return {
    responseSerial: body.readUInt16BE(0),
    responseMessageId: body.readUInt16BE(2),
    result: body[4],
  };
}

export function parseRegistration(body) {
  if (body.length < 37) {
    return null;
  }

  return {
    provinceId: body.readUInt16BE(0),
    cityId: body.readUInt16BE(2),
    manufacturer: decodeTextField(body.subarray(4, 9)),
    model: decodeTextField(body.subarray(9, 29)),
    terminalId: decodeTextField(body.subarray(29, 36)),
  };
}

export function maskTerminalPhone(phone) {
  const digits = [...phone]
    .flatMap((byte) => [byte >> 4, byte & 0x0f])
    .filter((digit) => digit <= 9)
    .join("");
  return digits.length > 4 ? `…${digits.slice(-4)}` : "unavailable";
}

function unescapeBytes(bytes) {
  const output = [];
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index];
    if (byte !== ESCAPE) {
      output.push(byte);
      continue;
    }

    index += 1;
    if (index >= bytes.length) {
      throw new Error("Incomplete JT808 escape sequence");
    }
    if (bytes[index] === 0x01) {
      output.push(ESCAPE);
    } else if (bytes[index] === 0x02) {
      output.push(FRAME_FLAG);
    } else {
      throw new Error("Invalid JT808 escape sequence");
    }
  }
  return Buffer.from(output);
}

function escapeBytes(bytes) {
  const output = [];
  for (const byte of bytes) {
    if (byte === FRAME_FLAG) {
      output.push(ESCAPE, 0x02);
    } else if (byte === ESCAPE) {
      output.push(ESCAPE, 0x01);
    } else {
      output.push(byte);
    }
  }
  return Buffer.from(output);
}

function checksum(bytes) {
  let result = 0;
  for (const byte of bytes) {
    result ^= byte;
  }
  return result;
}

function decodeTextField(bytes) {
  return bytes
    .toString("ascii")
    .replace(/\0/g, "")
    .trim();
}

function validateUint(value, max, label) {
  if (!Number.isInteger(value) || value < 0 || value > max) {
    throw new Error(`${label} must be an integer from 0 to ${max}`);
  }
}
