import { createHash } from "node:crypto";

// Cliente mínimo para o protocolo obs-websocket v5 (embutido no OBS Studio
// 28+). Usa o WebSocket nativo do Node (sem dependências externas) para
// permitir trocar a cena/fonte exibida no OBS remotamente, a partir de um
// clique no dashboard — o OBS pode estar rodando em outra máquina na rede.
//
// Protocolo (ver https://github.com/obsproject/obs-websocket/blob/master/docs/generated/protocol.md):
//   0 Hello            servidor -> cliente, inicia o handshake
//   1 Identify         cliente -> servidor, autentica e assina eventos
//   2 Identified       servidor -> cliente, handshake concluído
//   5 Event            servidor -> cliente, notificação assíncrona
//   6 Request          cliente -> servidor, chamada de API
//   7 RequestResponse  servidor -> cliente, resposta de uma chamada

const OPCODE = {
  HELLO: 0,
  IDENTIFY: 1,
  IDENTIFIED: 2,
  EVENT: 5,
  REQUEST: 6,
  REQUEST_RESPONSE: 7,
};

// EventSubscription.General | EventSubscription.Scenes — o suficiente para
// sermos avisados quando a cena de programa ativa mudar (inclusive se for
// trocada manualmente dentro do próprio OBS), sem nos inscrevermos em todo o
// volume de eventos (áudio, entradas, etc.) que não usamos.
const EVENT_SUBSCRIPTIONS = (1 << 0) | (1 << 2);

const RECONNECT_BASE_MS = 2_000;
const RECONNECT_MAX_MS = 30_000;
const REQUEST_TIMEOUT_MS = 8_000;

export function createObsController({ url, password, log } = {}) {
  const logEvent = typeof log === "function" ? log : () => {};
  const enabled = Boolean(url);

  let socket = null;
  let identified = false;
  let closedByUser = false;
  let reconnectAttempt = 0;
  let reconnectTimer = null;
  let requestSeq = 0;
  const pendingRequests = new Map();

  const state = {
    enabled,
    connected: false,
    currentScene: null,
    scenes: [],
    lastError: null,
  };

  let onStateChange = () => {};

  function scheduleReconnect() {
    if (closedByUser || reconnectTimer) {
      return;
    }
    const delay = Math.min(
      RECONNECT_MAX_MS,
      RECONNECT_BASE_MS * 2 ** reconnectAttempt,
    );
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
    if (typeof reconnectTimer.unref === "function") {
      reconnectTimer.unref();
    }
  }

  function connect() {
    if (!enabled || closedByUser) {
      return;
    }
    try {
      socket = new WebSocket(url);
    } catch (error) {
      setError(error);
      scheduleReconnect();
      return;
    }

    const currentSocket = socket;
    let disconnectHandled = false;

    function handleDisconnect(code, reason) {
      // Tanto "close" quanto "error" podem levar à desconexão (algumas
      // falhas, como ECONNREFUSED, disparam só "error" e nunca "close" no
      // WebSocket nativo do Node) — este guard evita tratar o mesmo
      // desligamento duas vezes caso ambos os eventos cheguem a disparar.
      if (disconnectHandled) {
        return;
      }
      disconnectHandled = true;
      const wasIdentified = identified;
      identified = false;
      if (socket === currentSocket) {
        socket = null;
      }
      rejectAllPending(new Error("A conexão com o OBS foi encerrada"));
      if (wasIdentified || state.connected) {
        state.connected = false;
        state.currentScene = null;
        state.scenes = [];
        onStateChange();
      }
      if (!closedByUser) {
        logEvent("warn", "obs-disconnected", { code, reason });
        scheduleReconnect();
      }
    }

    socket.addEventListener("open", () => {
      logEvent("info", "obs-connected", { url: redactUrl(url) });
    });

    socket.addEventListener("message", (messageEvent) => {
      handleMessage(messageEvent.data);
    });

    socket.addEventListener("close", (closeEvent) => {
      handleDisconnect(closeEvent.code, closeEvent.reason);
    });

    socket.addEventListener("error", () => {
      handleDisconnect(undefined, "error");
    });
  }

  function handleMessage(raw) {
    let message;
    try {
      message = JSON.parse(String(raw));
    } catch {
      return;
    }

    switch (message.op) {
      case OPCODE.HELLO:
        sendIdentify(message.d);
        break;
      case OPCODE.IDENTIFIED:
        identified = true;
        reconnectAttempt = 0;
        state.connected = true;
        state.lastError = null;
        onStateChange();
        refreshSceneState().catch((error) => setError(error));
        break;
      case OPCODE.EVENT:
        handleEvent(message.d);
        break;
      case OPCODE.REQUEST_RESPONSE:
        handleRequestResponse(message.d);
        break;
      default:
        break;
    }
  }

  function sendIdentify(hello) {
    const payload = { rpcVersion: 1, eventSubscriptions: EVENT_SUBSCRIPTIONS };
    if (hello?.authentication) {
      payload.authentication = computeAuthResponse(
        password ?? "",
        hello.authentication.salt,
        hello.authentication.challenge,
      );
    }
    send({ op: OPCODE.IDENTIFY, d: payload });
  }

  function handleEvent(eventData) {
    if (eventData?.eventType === "CurrentProgramSceneChanged") {
      state.currentScene = eventData.eventData?.sceneName ?? state.currentScene;
      onStateChange();
    } else if (
      eventData?.eventType === "SceneCreated" ||
      eventData?.eventType === "SceneRemoved" ||
      eventData?.eventType === "SceneNameChanged"
    ) {
      refreshSceneState().catch((error) => setError(error));
    }
  }

  function handleRequestResponse(data) {
    const pending = pendingRequests.get(data?.requestId);
    if (!pending) {
      return;
    }
    pendingRequests.delete(data.requestId);
    clearTimeout(pending.timer);
    if (data.requestStatus?.result) {
      pending.resolve(data.responseData ?? {});
    } else {
      pending.reject(
        new Error(
          data.requestStatus?.comment ?? "A requisição ao OBS falhou",
        ),
      );
    }
  }

  function rejectAllPending(error) {
    for (const pending of pendingRequests.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    pendingRequests.clear();
  }

  function send(message) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return;
    }
    socket.send(JSON.stringify(message));
  }

  function request(requestType, requestData) {
    if (!enabled) {
      return Promise.reject(new Error("A integração com o OBS não está configurada"));
    }
    if (!identified || !socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Sem conexão com o OBS no momento"));
    }

    requestSeq += 1;
    const requestId = `req-${requestSeq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingRequests.delete(requestId);
        reject(new Error("O OBS não respondeu a tempo"));
      }, REQUEST_TIMEOUT_MS);
      pendingRequests.set(requestId, { resolve, reject, timer });
      send({
        op: OPCODE.REQUEST,
        d: { requestType, requestId, requestData },
      });
    });
  }

  async function refreshSceneState() {
    const [sceneList, current] = await Promise.all([
      request("GetSceneList", undefined),
      request("GetCurrentProgramScene", undefined),
    ]);
    state.scenes = (sceneList.scenes ?? [])
      .map((scene) => scene.sceneName)
      .reverse();
    state.currentScene = current.currentProgramSceneName ?? state.currentScene;
    onStateChange();
  }

  function setError(error) {
    state.lastError = error instanceof Error ? error.message : String(error);
    logEvent("error", "obs-error", { error: state.lastError });
    onStateChange();
  }

  async function setCurrentScene(sceneName) {
    if (typeof sceneName !== "string" || sceneName.length === 0) {
      throw httpError(400, "sceneName é obrigatório");
    }
    try {
      await request("SetCurrentProgramScene", { sceneName });
    } catch (error) {
      const wrapped = httpError(
        502,
        error instanceof Error ? error.message : "Falha ao trocar a cena no OBS",
      );
      throw wrapped;
    }
    state.currentScene = sceneName;
    onStateChange();
  }

  function getStatus() {
    return {
      enabled: state.enabled,
      connected: state.connected,
      currentScene: state.currentScene,
      scenes: [...state.scenes],
      lastError: state.lastError,
    };
  }

  if (enabled) {
    connect();
  }

  return {
    getStatus,
    setCurrentScene,
    onStateChange(listener) {
      onStateChange = typeof listener === "function" ? listener : () => {};
    },
    close() {
      closedByUser = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      rejectAllPending(new Error("O cliente OBS foi encerrado"));
      socket?.close();
    },
  };
}

function computeAuthResponse(password, salt, challenge) {
  const secret = createHash("sha256")
    .update(password + salt)
    .digest("base64");
  return createHash("sha256")
    .update(secret + challenge)
    .digest("base64");
}

function redactUrl(url) {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname}:${parsed.port}`;
  } catch {
    return "obs-websocket";
  }
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
