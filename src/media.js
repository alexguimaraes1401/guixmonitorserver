import net from "node:net";
import {
  createJt1078FrameAssembler,
  createJt1078Parser,
} from "./jt1078.js";

const MAX_MEDIA_CONNECTIONS = 8;
const DEFAULT_SOCKET_IDLE_TIMEOUT_MS = 20_000;
const DEFAULT_RECONNECT_GRACE_MS = 30_000;

export function createMediaReceiver({
  port,
  onEvent,
  onFrame = () => {},
  onStreamDisconnected = () => {},
  onStreamClosed = () => {},
  idleTimeoutMs = DEFAULT_SOCKET_IDLE_TIMEOUT_MS,
  reconnectGraceMs = DEFAULT_RECONNECT_GRACE_MS,
}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error("JT1078_PORT must be an integer from 1 to 65535");
  }
  if (typeof onEvent !== "function") {
    throw new TypeError("onEvent must be a function");
  }
  if (
    typeof onFrame !== "function" ||
    typeof onStreamDisconnected !== "function" ||
    typeof onStreamClosed !== "function"
  ) {
    throw new TypeError("Media callbacks must be functions");
  }
  if (!Number.isInteger(idleTimeoutMs) || idleTimeoutMs < 1) {
    throw new RangeError("idleTimeoutMs must be a positive integer");
  }
  if (!Number.isInteger(reconnectGraceMs) || reconnectGraceMs < 0) {
    throw new RangeError("reconnectGraceMs must be a non-negative integer");
  }

  const connections = new Map();
  const blockedStreams = new Set();
  const allowedStreams = new Set();
  const pendingStreamClosures = new Map();
  let connectionId = 0;
  let bytesReceivedTotal = 0;
  let lastMediaAt = null;
  let signatureDetectedAny = false;

  const server = net.createServer((socket) => {
    if (connections.size >= MAX_MEDIA_CONNECTIONS) {
      onEvent(
        "warn",
        "media-connection-rejected",
        "Conexão de mídia recusada: limite de conexões atingido",
      );
      socket.destroy();
      return;
    }

    const connection = {
      id: ++connectionId,
      socket,
      bytesReceived: 0,
      connectedAt: new Date().toISOString(),
      connectedAtMs: Date.now(),
      remoteAddress: socket.remoteAddress ?? null,
      remotePort: socket.remotePort ?? null,
      localAddress: socket.localAddress ?? null,
      localPort: socket.localPort ?? null,
      lastDataAt: null,
      streams: new Map(),
      suppressedStreamCloseKeys: new Set(),
      closeInitiator: null,
      progressEventAt: 0,
      idleTimedOut: false,
    };
    connections.set(connection.id, connection);
    socket.setNoDelay(true);
    socket.setTimeout(idleTimeoutMs, () => {
      connection.idleTimedOut = true;
      connection.closeInitiator = "idle-timeout";
      onEvent(
        "warn",
        "media-connection-idle-timeout",
        `Conexão JT1078 ${connection.id} sem dados por ${idleTimeoutMs}ms; encerrando para permitir reconexão rápida`,
        getConnectionDiagnostics(connection),
      );
      socket.destroy();
    });
    onEvent(
      "info",
      "media-connection-open",
      "Conexão TCP recebida na porta JT1078",
    );

    const assembler = createJt1078FrameAssembler({
      onFrame: (frame) => {
        try {
          onFrame(frame);
        } catch (error) {
          onEvent(
            "error",
            "media-frame-handler-error",
            `Falha ao processar quadro JT1078: ${error.message}`,
          );
        }
      },
      onError: (message) =>
        onEvent("warn", "invalid-media-frame", message),
    });
    const parser = createJt1078Parser({
      onPacket: (packet) => {
        const streamKey = getStreamKey(
          packet.terminalPhoneHex,
          packet.channelNo,
        );
        if (blockedStreams.has(streamKey)) {
          connection.closeInitiator = "blocked-stream";
          onEvent(
            "warn",
            "media-stream-rejected-after-stop",
            `Fluxo JT1078 rejeitado após comando de parada para o canal ${packet.channelNo}`,
          );
          socket.destroy();
          return;
        }
        clearPendingStreamClosure(
          packet.terminalPhoneHex,
          packet.channelNo,
          true,
        );
        allowedStreams.add(streamKey);

        const stream = connection.streams.get(packet.channelNo) ?? {
          terminalPhoneHex: packet.terminalPhoneHex,
          channelNo: packet.channelNo,
          bytesReceived: 0,
          lastDataAt: null,
        };
        stream.bytesReceived += packet.wireLength;
        stream.lastDataAt = connection.lastDataAt;
        connection.streams.set(packet.channelNo, stream);
        if (!signatureDetectedAny) {
          signatureDetectedAny = true;
          onEvent(
            "info",
            "jt1078-signature-detected",
            "Pacote JT1078 válido recebido e decodificado",
          );
        }

        if (stream.bytesReceived === packet.wireLength) {
          onEvent(
            "info",
            "media-stream-identified",
            `Fluxo JT1078 identificado no canal ${packet.channelNo}`,
          );
        }
        assembler.push(packet);
      },
      onError: (message) => onEvent("warn", "invalid-media-packet", message),
    });

    socket.on("data", (chunk) => {
      connection.bytesReceived += chunk.length;
      bytesReceivedTotal += chunk.length;
      connection.lastDataAt = new Date().toISOString();
      lastMediaAt = connection.lastDataAt;
      parser.push(chunk);

      const now = Date.now();
      if (now - connection.progressEventAt >= 1000) {
        connection.progressEventAt = now;
        onEvent(
          "info",
          "media-progress",
          `Dados JT1078 recebidos: ${connection.bytesReceived} bytes nesta conexão`,
        );
      }
    });

    socket.on("close", (hadError) => {
      connections.delete(connection.id);
      assembler.reset();
      for (const stream of connection.streams.values()) {
        const streamKey = getStreamKey(
          stream.terminalPhoneHex,
          stream.channelNo,
        );
        if (
          !blockedStreams.has(streamKey) &&
          !connection.suppressedStreamCloseKeys.has(streamKey) &&
          !hasActiveStream(stream.terminalPhoneHex, stream.channelNo)
        ) {
          onStreamDisconnected(stream.terminalPhoneHex, stream.channelNo);
          scheduleStreamClosure(stream);
        }
      }
      connection.closeInitiator ??= hadError ? "socket-error" : "unclassified";
      onEvent(
        "info",
        "media-connection-closed",
        `Conexão JT1078 ${connection.id} encerrada após ${connection.bytesReceived} bytes`,
        getConnectionDiagnostics(connection, { hadError }),
      );
    });

    socket.on("error", (error) => {
      connection.closeInitiator = "socket-error";
      onEvent(
        "warn",
        "media-connection-error",
        `Erro na conexão JT1078 ${connection.id}: ${error.message}`,
        getConnectionDiagnostics(connection),
      );
    });
  });

  server.on("close", () => {
    for (const timer of pendingStreamClosures.values()) {
      clearTimeout(timer);
    }
    pendingStreamClosures.clear();
  });

  return {
    server,
    getStatus() {
      return {
        transport: "TCP",
        port:
          server.address() && typeof server.address() === "object"
            ? server.address().port
            : port,
        activeConnections: connections.size,
        bytesReceivedTotal,
        lastMediaAt,
        signatureDetected: signatureDetectedAny,
        connections: [...connections.values()].map((connection) => ({
          bytesReceived: connection.bytesReceived,
          connectedAt: connection.connectedAt,
          lastDataAt: connection.lastDataAt,
          signatureDetected: connection.streams.size > 0,
          channels: [...connection.streams.values()].map((stream) => ({
            channelNo: stream.channelNo,
            bytesReceived: stream.bytesReceived,
            lastDataAt: stream.lastDataAt,
          })),
        })),
      };
    },
    getActiveStreamsFor(terminalPhone) {
      const terminalPhoneHex = Buffer.from(terminalPhone).toString("hex");
      return [...connections.values()].flatMap((connection) =>
        [...connection.streams.values()]
          .filter((stream) => stream.terminalPhoneHex === terminalPhoneHex)
          .map(({ channelNo, bytesReceived, lastDataAt }) => ({
            channelNo,
            bytesReceived,
            lastDataAt,
          })),
      );
    },
    hasActiveStreamFor(terminalPhone, channelNo) {
      const terminalPhoneHex = Buffer.from(terminalPhone).toString("hex");
      return hasActiveStream(terminalPhoneHex, channelNo);
    },
    hasPendingReconnectFor(terminalPhone, channelNo) {
      const terminalPhoneHex = Buffer.from(terminalPhone).toString("hex");
      return pendingStreamClosures.has(
        getStreamKey(terminalPhoneHex, channelNo),
      );
    },
    stopStreamFor(terminalPhone, channelNo) {
      const terminalPhoneHex = Buffer.from(terminalPhone).toString("hex");
      const streamKey = getStreamKey(terminalPhoneHex, channelNo);
      clearPendingStreamClosure(terminalPhoneHex, channelNo);
      blockedStreams.add(streamKey);
      allowedStreams.delete(streamKey);
      let activeStreams = 0;
      for (const connection of connections.values()) {
        if (
          connection.streams.get(channelNo)?.terminalPhoneHex ===
          terminalPhoneHex
        ) {
          activeStreams += 1;
          connection.closeInitiator = "explicit-stop";
          connection.suppressedStreamCloseKeys.add(streamKey);
          connection.socket.destroy();
        }
      }
      onStreamClosed(terminalPhoneHex, channelNo);
      return activeStreams;
    },
    allowStreamFor(terminalPhone, channelNo) {
      const terminalPhoneHex = Buffer.from(terminalPhone).toString("hex");
      const streamKey = getStreamKey(terminalPhoneHex, channelNo);
      blockedStreams.delete(streamKey);
      allowedStreams.add(streamKey);
    },
  };

  function hasActiveStream(terminalPhoneHex, channelNo) {
    return [...connections.values()].some((connection) =>
      [...connection.streams.values()].some(
        (stream) =>
          stream.terminalPhoneHex === terminalPhoneHex &&
          (channelNo === undefined || stream.channelNo === channelNo),
      ),
    );
  }

  function clearPendingStreamClosure(
    terminalPhoneHex,
    channelNo,
    resumed = false,
  ) {
    const streamKey = getStreamKey(terminalPhoneHex, channelNo);
    const timer = pendingStreamClosures.get(streamKey);
    if (!timer) {
      return false;
    }
    clearTimeout(timer);
    pendingStreamClosures.delete(streamKey);
    if (resumed) {
      onEvent(
        "info",
        "media-stream-reconnect-grace-cancelled",
        `Mídia retomada no canal ${channelNo} antes do fim da janela de reconexão`,
        { terminalPhoneHex, channelNo },
      );
    }
    return true;
  }

  function scheduleStreamClosure(stream) {
    const { terminalPhoneHex, channelNo } = stream;
    const streamKey = getStreamKey(terminalPhoneHex, channelNo);
    clearPendingStreamClosure(terminalPhoneHex, channelNo);
    if (reconnectGraceMs === 0) {
      onStreamClosed(terminalPhoneHex, channelNo);
      return;
    }
    const timer = setTimeout(() => {
      pendingStreamClosures.delete(streamKey);
      if (
        !blockedStreams.has(streamKey) &&
        !hasActiveStream(terminalPhoneHex, channelNo)
      ) {
        onEvent(
          "warn",
          "media-stream-reconnect-grace-expired",
          `Canal ${channelNo} sem mídia após ${reconnectGraceMs}ms; encerrando a publicação RTSP`,
          { terminalPhoneHex, channelNo, reconnectGraceMs },
        );
        onStreamClosed(terminalPhoneHex, channelNo);
      }
    }, reconnectGraceMs);
    timer.unref?.();
    pendingStreamClosures.set(streamKey, timer);
    onEvent(
      "info",
      "media-stream-reconnect-grace-started",
      `Aguardando até ${reconnectGraceMs}ms pela reconexão do canal ${channelNo}`,
      { terminalPhoneHex, channelNo, reconnectGraceMs },
    );
  }
}

function getConnectionDiagnostics(connection, extra = {}) {
  const channels = [...connection.streams.values()].map((stream) => ({
    channelNo: stream.channelNo,
    bytesReceived: stream.bytesReceived,
  }));
  const terminalPhoneHex = connection.streams.values().next().value
    ?.terminalPhoneHex;
  return {
    connectionId: connection.id,
    terminalPhoneHex,
    channels,
    remoteAddress: connection.remoteAddress,
    remotePort: connection.remotePort,
    localAddress: connection.localAddress,
    localPort: connection.localPort,
    connectedAt: connection.connectedAt,
    lastDataAt: connection.lastDataAt,
    connectionDurationMs: Date.now() - connection.connectedAtMs,
    bytesReceived: connection.bytesReceived,
    idleTimedOut: connection.idleTimedOut,
    closeInitiator: connection.closeInitiator,
    ...extra,
  };
}

function getStreamKey(terminalPhoneHex, channelNo) {
  return `${terminalPhoneHex}:${channelNo}`;
}
