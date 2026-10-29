import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { createObsController } from "../src/obs.js";

// Node não possui servidor WebSocket embutido (só cliente), então este teste
// sobe um servidor WebSocket mínimo (RFC 6455) para simular as respostas do
// obs-websocket v5 e validar o handshake completo do nosso cliente.
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const initialScenes = [
  { sceneName: "Canal 2", sceneIndex: 1 },
  { sceneName: "Canal 1", sceneIndex: 0 },
];

function acceptKey(key) {
  return createHash("sha1").update(key + WS_GUID).digest("base64");
}

function encodeTextFrame(payloadObj) {
  const payload = Buffer.from(JSON.stringify(payloadObj), "utf8");
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  }
  return Buffer.concat([header, payload]);
}

function decodeTextFrames(buffer) {
  const messages = [];
  let offset = 0;
  while (offset < buffer.length) {
    const byte1 = buffer[offset];
    const opcode = byte1 & 0x0f;
    const byte2 = buffer[offset + 1];
    const masked = (byte2 & 0x80) !== 0;
    let len = byte2 & 0x7f;
    let pos = offset + 2;
    if (len === 126) {
      len = buffer.readUInt16BE(pos);
      pos += 2;
    }
    let maskKey;
    if (masked) {
      maskKey = buffer.subarray(pos, pos + 4);
      pos += 4;
    }
    let payload = buffer.subarray(pos, pos + len);
    if (masked) {
      payload = Buffer.from(payload);
      for (let i = 0; i < payload.length; i += 1) {
        payload[i] ^= maskKey[i % 4];
      }
    }
    // Ignora frames de controle (close=0x8, ping=0x9, pong=0xA): só nos
    // interessam frames de texto (0x1) do protocolo obs-websocket.
    if (opcode === 0x1) {
      messages.push(JSON.parse(payload.toString("utf8")));
    }
    offset = pos + len;
  }
  return messages;
}

async function startFakeObsServer(fixedPort = 0) {
  const server = createServer();
  const sockets = new Set();
  let scenes = initialScenes;
  server.on("upgrade", (request, socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    const key = request.headers["sec-websocket-key"];
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
    );

    // op 0 Hello (sem autenticação, para simplificar o teste)
    socket.write(encodeTextFrame({ op: 0, d: { obsWebSocketVersion: "5.0.0", rpcVersion: 1 } }));

    socket.on("data", (chunk) => {
      for (const message of decodeTextFrames(chunk)) {
        if (message.op === 1) {
          socket.write(encodeTextFrame({ op: 2, d: { negotiatedRpcVersion: 1 } }));
        } else if (message.op === 6) {
          const { requestType, requestId } = message.d;
          let responseData = {};
          if (requestType === "GetSceneList") {
            responseData = { scenes };
          } else if (requestType === "GetCurrentProgramScene") {
            responseData = { currentProgramSceneName: "Canal 1" };
          } else if (requestType === "SetCurrentProgramScene") {
            responseData = {};
          }
          socket.write(
            encodeTextFrame({
              op: 7,
              d: {
                requestType,
                requestId,
                requestStatus: { result: true, code: 100 },
                responseData,
              },
            }),
          );
        }
      }
    });
    socket.on("error", () => {});
  });

  await new Promise((resolve) => server.listen(fixedPort, "127.0.0.1", resolve));
  return {
    server,
    updateScenes(nextScenes, eventType = "SceneCreated") {
      scenes = nextScenes;
      const event = encodeTextFrame({
        op: 5,
        d: { eventType, eventData: {} },
      });
      for (const socket of sockets) {
        socket.write(event);
      }
    },
    close() {
      for (const socket of sockets) {
        socket.destroy();
      }
      server.close();
    },
  };
}

test("conecta no obs-websocket, lista cenas e troca a cena ativa", async () => {
  const fakeServer = await startFakeObsServer();
  const { port } = fakeServer.server.address();
  const obs = createObsController({ url: `ws://127.0.0.1:${port}`, password: "" });

  try {
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("timed out waiting for identify")),
        3000,
      );
      obs.onStateChange(() => {
        const status = obs.getStatus();
        if (status.connected && status.scenes.length > 0) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });

    const statusAfterConnect = obs.getStatus();
    assert.equal(statusAfterConnect.connected, true);
    assert.equal(statusAfterConnect.currentScene, "Canal 1");
    assert.deepEqual(statusAfterConnect.scenes, ["Canal 1", "Canal 2"]);

    await obs.setCurrentScene("Canal 2");
    assert.equal(obs.getStatus().currentScene, "Canal 2");

    fakeServer.updateScenes([
      { sceneName: "Canal 3", sceneIndex: 2 },
      ...initialScenes,
    ]);
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("timed out waiting for scene list refresh")),
        3000,
      );
      const checkStatus = () => {
        if (obs.getStatus().scenes.includes("Canal 3")) {
          clearTimeout(timeout);
          obs.onStateChange(() => {});
          resolve();
        }
      };
      obs.onStateChange(checkStatus);
      checkStatus();
    });
    assert.deepEqual(obs.getStatus().scenes, ["Canal 1", "Canal 2", "Canal 3"]);
    await obs.setCurrentScene("Canal 3");
    assert.equal(obs.getStatus().currentScene, "Canal 3");

    await assert.rejects(() => obs.setCurrentScene(""), /obrigatório/);
  } finally {
    obs.close();
    fakeServer.close();
  }
});

test("reconecta sozinho mesmo quando a primeira falha só dispara o evento error (sem close)", async () => {
  // Reproduz o bug encontrado em produção: ao tentar conectar a uma porta
  // sem nada escutando (ex.: ECONNREFUSED), o WebSocket nativo do Node pode
  // disparar só "error" e nunca "close" depois — o cliente precisa tratar
  // isso como uma desconexão e reagendar a reconexão mesmo assim.
  const net = await import("node:net");
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  // A porta acima foi liberada propositalmente: nada está escutando nela
  // agora, então a primeira tentativa de conexão deve falhar.

  const obs = createObsController({ url: `ws://127.0.0.1:${port}`, password: "" });

  try {
    // A primeira tentativa falha quase instantaneamente (nada escutando na
    // porta). Como nada muda de "connected: false" -> "connected: false",
    // onStateChange não dispara nesse caso — damos uma folga curta para o
    // evento "error" ser processado e o backoff ser agendado.
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Agora sobe um servidor de verdade na mesma porta e aguarda a
    // reconexão automática (backoff inicial de 2s).
    const fakeServer = await startFakeObsServer(port);
    try {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error("timed out waiting for automatic reconnect")),
          10_000,
        );
        obs.onStateChange(() => {
          const status = obs.getStatus();
          if (status.connected && status.scenes.length > 0) {
            clearTimeout(timeout);
            resolve();
          }
        });
      });
      assert.equal(obs.getStatus().connected, true);
    } finally {
      fakeServer.close();
    }
  } finally {
    obs.close();
  }
});

test("rejeita comandos quando a integração não está habilitada", async () => {
  const obs = createObsController({ url: "", password: "" });
  assert.deepEqual(obs.getStatus(), {
    enabled: false,
    connected: false,
    currentScene: null,
    scenes: [],
    lastError: null,
  });
  await assert.rejects(() => obs.setCurrentScene("Canal 1"), /não está configurada/);
  obs.close();
});
