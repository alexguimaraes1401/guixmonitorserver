const connectionStatus = document.querySelector("#connection-status");
const connectionLabel = document.querySelector("#connection-label");
const onlineCount = document.querySelector("#online-count");
const terminalCount = document.querySelector("#terminal-count");
const terminalCountLabel = document.querySelector("#terminal-count-label");
const listenerAddress = document.querySelector("#listener-address");
const terminalList = document.querySelector("#terminal-list");
const eventList = document.querySelector("#event-list");
const lastUpdate = document.querySelector("#last-update");
const mediaSummary = document.querySelector("#media-summary");
const obsConnection = document.querySelector("#obs-connection");
const obsConnectionLabel = document.querySelector("#obs-connection-label");
const obsScenesContainer = document.querySelector("#obs-scenes");
const obsSceneStatus = document.querySelector("#obs-scene-status");
let terminalRenderKey;
let obsSceneRenderKey;
let obsSwitchInFlight = false;
let lastObsSnapshot = null;
let lastTerminals = [];
const recoveryRequests = new Set();
const recoveryErrors = new Map();

setInterval(() => {
  for (const terminal of lastTerminals) {
    updateRecoveryControls(terminal);
  }
}, 1000);

const eventSource = new EventSource("/api/stream");

eventSource.addEventListener("open", () => {
  setPanelConnection("connected", "Painel conectado");
});

eventSource.addEventListener("message", (event) => {
  try {
    renderSnapshot(JSON.parse(event.data));
  } catch {
    setPanelConnection("error", "Resposta inválida do painel");
  }
});

eventSource.addEventListener("error", () => {
  setPanelConnection("error", "Reconectando ao painel");
});

function renderSnapshot(snapshot) {
  if (!snapshot || !snapshot.listener || !Array.isArray(snapshot.terminals)) {
    setPanelConnection("error", "Estado do servidor inválido");
    return;
  }

  const terminals = snapshot.terminals;
  lastTerminals = terminals;
  const online = terminals.filter((terminal) => terminal.connected).length;
  const registered = terminals.filter((terminal) => terminal.terminalId).length;

  onlineCount.textContent = String(online);
  terminalCount.textContent = String(registered);
  terminalCountLabel.textContent = String(terminals.length);
  listenerAddress.textContent =
    `TCP ${snapshot.listener.publishedPort} → ${snapshot.listener.containerPort}`;

  renderMedia(snapshot.media);
  renderObs(snapshot.obs);
  renderTerminals(terminals);
  for (const terminal of terminals) {
    updateRecoveryControls(terminal);
  }
  renderEvents(Array.isArray(snapshot.events) ? snapshot.events : []);
  lastUpdate.textContent = `Atualizado ${formatTime(snapshot.updatedAt)}`;
}

function renderMedia(media) {
  if (!media) {
    mediaSummary.textContent = "Estado do receptor JT1078 indisponível.";
    return;
  }

  const byteCount = Number(media.bytesReceivedTotal || 0).toLocaleString("pt-BR");
  const signature = media.signatureDetected
    ? "Marcador JT1078 detectado."
    : "Marcador JT1078 ainda não detectado.";
  mediaSummary.textContent =
    `${media.activeConnections || 0} conexão(ões) de mídia · ` +
    `${byteCount} bytes recebidos. ${signature} ` +
    "Os canais RTSP 1 e 2 são publicados para o OBS.";
}

function renderObs(obs) {
  lastObsSnapshot = obs;
  if (!obs || !obs.enabled) {
    obsConnection.dataset.state = "disabled";
    obsConnectionLabel.textContent = "OBS não configurado";
    if (obsSceneRenderKey !== null) {
      obsSceneRenderKey = null;
      obsScenesContainer.replaceChildren(buildObsEmptyState(
        "Integração não configurada",
        "Defina OBS_WEBSOCKET_URL no servidor para trocar a cena do OBS por aqui.",
      ));
    }
    return;
  }

  if (!obs.connected) {
    obsConnection.dataset.state = "error";
    obsConnectionLabel.textContent = obs.lastError
      ? `Sem conexão: ${obs.lastError}`
      : "Conectando ao OBS…";
  } else {
    obsConnection.dataset.state = "connected";
    obsConnectionLabel.textContent = "OBS conectado";
  }

  const scenes = Array.isArray(obs.scenes) ? obs.scenes : [];
  const renderKey = JSON.stringify({ scenes, current: obs.currentScene, connected: obs.connected });
  if (renderKey === obsSceneRenderKey) {
    return;
  }
  obsSceneRenderKey = renderKey;
  obsScenesContainer.replaceChildren();

  if (scenes.length === 0) {
    obsScenesContainer.append(
      buildObsEmptyState(
        obs.connected ? "Nenhuma cena encontrada" : "Aguardando conexão com o OBS",
        obs.connected
          ? "Crie cenas no OBS para que elas apareçam aqui."
          : "As cenas aparecerão assim que a conexão for estabelecida.",
      ),
    );
    return;
  }

  for (const sceneName of scenes) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "obs-scene-button";
    button.textContent = sceneName;
    button.dataset.active = String(sceneName === obs.currentScene);
    button.disabled = !obs.connected || obsSwitchInFlight;
    button.addEventListener("click", () => requestObsSceneSwitch(sceneName));
    obsScenesContainer.append(button);
  }
}

function buildObsEmptyState(title, description) {
  const empty = document.createElement("div");
  empty.className = "empty-state";

  const icon = document.createElement("span");
  icon.className = "empty-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = "⛶";

  const strong = document.createElement("strong");
  strong.textContent = title;

  const span = document.createElement("span");
  span.textContent = description;

  empty.append(icon, strong, span);
  return empty;
}

async function requestObsSceneSwitch(sceneName) {
  if (obsSwitchInFlight) {
    return;
  }
  obsSwitchInFlight = true;
  obsSceneRenderKey = null;
  renderObs(lastObsSnapshot);
  obsSceneStatus.dataset.state = "sending";
  obsSceneStatus.textContent = `Trocando para "${sceneName}"…`;

  try {
    const response = await fetch("/api/obs/scene", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sceneName }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || "Falha ao trocar a cena");
    }
    obsSceneStatus.dataset.state = "success";
    obsSceneStatus.textContent = `Cena "${sceneName}" ativa`;
  } catch (error) {
    obsSceneStatus.dataset.state = "error";
    obsSceneStatus.textContent =
      error instanceof Error ? error.message : "Falha ao trocar a cena";
  } finally {
    obsSwitchInFlight = false;
    // O servidor publica o novo estado via SSE assim que troca a cena no
    // OBS, o que pode chegar aqui ANTES desta promise resolver (a resposta
    // HTTP só é enviada depois). Nesse caso os botões já foram redesenhados
    // com obsSwitchInFlight ainda true e ficariam travados em disabled para
    // sempre, já que nada mais força um novo render. Por isso redesenhamos
    // explicitamente aqui, usando o último snapshot conhecido, para garantir
    // que os botões voltem a ficar clicáveis mesmo sem um novo push do SSE.
    obsSceneRenderKey = null;
    renderObs(lastObsSnapshot);
    setTimeout(() => {
      if (obsSceneStatus.dataset.state !== "sending") {
        obsSceneStatus.dataset.state = "";
        obsSceneStatus.textContent = "";
      }
    }, 4000);
  }
}

function renderTerminals(terminals) {
  const renderKey = createTerminalRenderKey(terminals);
  if (renderKey === terminalRenderKey) {
    updateTerminalDetails(terminals);
    return;
  }
  terminalRenderKey = renderKey;
  terminalList.replaceChildren();

  if (terminals.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";

    const icon = document.createElement("span");
    icon.className = "empty-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "⌁";

    const title = document.createElement("strong");
    title.textContent = "Aguardando terminal";

    const copy = document.createElement("span");
    copy.textContent = "Os canais RTSP aparecerão quando a câmera se conectar.";

    empty.append(icon, title, copy);
    terminalList.append(empty);
    return;
  }

  for (const terminal of terminals) {
    terminalList.append(createTerminalCard(terminal));
  }
}

function createTerminalCard(terminal) {
  const card = document.createElement("article");
  const terminalKey = terminal.terminalId || terminal.phone || "";
  card.className = "terminal-card";
  card.dataset.terminalKey = terminalKey;

  const top = document.createElement("div");
  top.className = "terminal-card-top";

  const name = document.createElement("strong");
  name.className = "terminal-name";
  name.textContent = terminal.terminalId || `Terminal ${terminal.phone || "sem ID"}`;

  const state = document.createElement("span");
  state.className = "terminal-state";
  state.dataset.online = String(Boolean(terminal.connected));
  state.textContent = terminal.connected ? "Conectado" : "Desconectado";
  top.append(name, state);

  const model = document.createElement("p");
  model.className = "terminal-model";
  model.textContent =
    [terminal.manufacturer, terminal.model].filter(Boolean).join(" · ") ||
    "Modelo ainda não informado";

  const details = document.createElement("dl");
  details.className = "terminal-details";
  appendDetail(details, "Última mensagem", terminal.lastMessage || "—", "last-message");
  appendDetail(details, "Última atividade", formatTime(terminal.lastSeenAt), "last-seen");
  appendDetail(
    details,
    "Último heartbeat",
    formatTime(terminal.lastHeartbeatAt),
    "last-heartbeat",
  );

  card.append(top, model, details, createRtspStreams(terminal));
  return card;
}

function createRtspStreams(terminal) {
  const section = document.createElement("section");
  section.className = "rtsp-streams";

  const headingRow = document.createElement("div");
  headingRow.className = "rtsp-streams-head";

  const heading = document.createElement("strong");
  heading.className = "rtsp-streams-heading";
  heading.textContent = "Canais RTSP para OBS";

  const resyncStatus = document.createElement("span");
  resyncStatus.className = "rtsp-resync-status";
  resyncStatus.dataset.resyncState = "";

  const resyncButton = document.createElement("button");
  resyncButton.type = "button";
  resyncButton.className = "rtsp-resync-button";
  resyncButton.textContent = "Recuperar transmissão";
  resyncButton.title =
    "Recupera somente os canais afetados: alivia filas, reinicia o publicador ou solicita mídia novamente à câmera";
  resyncButton.disabled = !terminal.terminalId;
  resyncButton.addEventListener("click", () => {
    requestVideoResync(terminal.terminalId);
  });

  headingRow.append(heading, resyncButton);
  section.append(headingRow, resyncStatus);

  for (const channelNo of [1, 2]) {
    const stream = (terminal.rtspStreams || []).find(
      (candidate) => candidate.channelNo === channelNo,
    );
    const row = document.createElement("div");
    row.className = "rtsp-stream";
    row.dataset.rtspChannel = String(channelNo);

    const label = document.createElement("span");
    label.className = "rtsp-stream-label";
    label.textContent = `Canal ${channelNo}`;

    const address = document.createElement("code");
    address.className = "rtsp-stream-address";
    address.dataset.rtspAddress = String(channelNo);
    address.textContent = stream
      ? `rtsp://127.0.0.1:8554/${stream.path}`
      : "Aguardando terminal";

    const state = document.createElement("span");
    state.className = "rtsp-stream-state";
    state.dataset.rtspStatus = String(channelNo);
    state.dataset.status = stream?.status || "not-started";
    state.textContent = stream ? formatStreamStatus(stream) : formatRtspStatus();

    row.append(label, address, state);
    section.append(row);
  }

  const audioStream = terminal.rtspAudioStream;
  const audioRow = document.createElement("div");
  audioRow.className = "rtsp-stream";
  audioRow.dataset.rtspAudio = "true";

  const audioLabel = document.createElement("span");
  audioLabel.className = "rtsp-stream-label";
  audioLabel.textContent = "Áudio compartilhado";

  const audioAddress = document.createElement("code");
  audioAddress.className = "rtsp-stream-address";
  audioAddress.dataset.rtspAudioAddress = "true";
  audioAddress.textContent = audioStream
    ? `rtsp://127.0.0.1:8554/${audioStream.path}`
    : "Aguardando terminal";

  const audioState = document.createElement("span");
  audioState.className = "rtsp-stream-state";
  audioState.dataset.rtspAudioStatus = "true";
  audioState.dataset.status = audioStream?.status || "not-started";
  audioState.textContent = formatAudioStreamStatus(audioStream);

  audioRow.append(audioLabel, audioAddress, audioState);
  section.append(audioRow);

  return section;
}

function createTerminalRenderKey(terminals) {
  return JSON.stringify(
    terminals.map((terminal) => ({
      terminalId: terminal.terminalId,
      phone: terminal.phone,
      connected: terminal.connected,
      manufacturer: terminal.manufacturer,
      model: terminal.model,
      audioPath: terminal.rtspAudioStream?.path,
      channels: (terminal.rtspStreams || []).map(({ channelNo, path }) => ({
        channelNo,
        path,
      })),
    })),
  );
}

function updateTerminalDetails(terminals) {
  for (const terminal of terminals) {
    const key = terminal.terminalId || terminal.phone || "";
    const card = [...terminalList.querySelectorAll(".terminal-card")].find(
      (candidate) => candidate.dataset.terminalKey === key,
    );
    if (!card) {
      continue;
    }

    setTerminalDetail(card, "last-message", terminal.lastMessage || "—");
    setTerminalDetail(card, "last-seen", formatTime(terminal.lastSeenAt));
    setTerminalDetail(card, "last-heartbeat", formatTime(terminal.lastHeartbeatAt));

    for (const stream of terminal.rtspStreams || []) {
      const status = card.querySelector(
        `[data-rtsp-status="${stream.channelNo}"]`,
      );
      if (status) {
        status.dataset.status = stream.status || "not-started";
        status.textContent = formatStreamStatus(stream);
      }
    }

    const audioStatus = card.querySelector("[data-rtsp-audio-status]");
    if (audioStatus) {
      audioStatus.dataset.status = terminal.rtspAudioStream?.status || "not-started";
      audioStatus.textContent = formatAudioStreamStatus(terminal.rtspAudioStream);
    }
  }
}

function formatRtspStatus(value) {
  const labels = {
    publishing: "Transmitindo",
    starting: "Iniciando",
    waiting: "Aguardando mídia",
    "not-started": "Aguardando mídia",
    stopped: "Parado",
    error: "Erro na publicação",
    disabled: "Desativado",
  };
  return labels[value] || value || "Aguardando mídia";
}

function formatStreamStatus(stream) {
  const status = formatRtspStatus(stream.status);
  if (stream.audioState === "waiting") {
    return `${status} - aguardando audio da camera`;
  }
  if (stream.audioState === "restoring") {
    return `${status} - incorporando audio no proximo quadro-chave`;
  }
  if (stream.audioState === "starting") {
    return `${status} - aguardando inicio do audio`;
  }
  if (stream.audioState === "stalled") {
    return `${status} - audio da camera interrompido`;
  }
  return status;
}

function formatAudioStreamStatus(stream) {
  if (stream && (!stream.enabled || stream.audioState === "disabled")) {
    return "Áudio desativado";
  }
  if (!stream || stream.audioState === "not-started") {
    return "Aguardando áudio da câmera";
  }
  if (stream.audioState === "waiting") {
    return "Aguardando áudio da câmera";
  }
  if (stream.audioState === "restoring") {
    return "Restaurando no próximo quadro-chave";
  }
  if (stream.audioState === "starting") {
    return "Iniciando áudio";
  }
  if (stream.audioState === "stalled") {
    return "Áudio da câmera interrompido";
  }
  return formatRtspStatus(stream.status);
}

function updateRecoveryControls(terminal) {
  const key = terminal.terminalId || terminal.phone || "";
  const card = [...terminalList.querySelectorAll(".terminal-card")].find(
    (candidate) => candidate.dataset.terminalKey === key,
  );
  if (!card) {
    return;
  }
  const button = card.querySelector(".rtsp-resync-button");
  const label = card.querySelector(".rtsp-resync-status");
  const recovery = terminal.recovery;
  const requesting = recoveryRequests.has(terminal.terminalId);
  const coolingDown = recovery && Date.now() < recovery.cooldownUntilMs;
  button.disabled = !terminal.terminalId || requesting ||
    recovery?.status === "recovering" || Boolean(coolingDown);
  button.textContent = coolingDown && recovery.status !== "recovering"
    ? `Aguarde ${Math.ceil((recovery.cooldownUntilMs - Date.now()) / 1000)} s`
    : "Recuperar transmissão";
  const error = recoveryErrors.get(terminal.terminalId);
  label.dataset.resyncState = error || recovery?.status === "failed"
    ? "error"
    : requesting || recovery?.status === "recovering" ? "sending"
      : recovery ? "success" : "";
  label.textContent = error || (requesting ? "Analisando canais…" : recovery
    ? `${recovery.source === "automatic" ? "Recuperação automática" : "Recuperação manual"}: ` +
      recovery.channels.map(({ channelNo, message }) => `Canal ${channelNo}: ${message}`).join(" · ")
    : terminal.autoRecoveryEnabled ? "Recuperação automática ativa" : "");
}

async function requestVideoResync(terminalId) {
  if (!terminalId || recoveryRequests.has(terminalId)) {
    return;
  }
  recoveryRequests.add(terminalId);
  recoveryErrors.delete(terminalId);
  const terminal = lastTerminals.find((candidate) => candidate.terminalId === terminalId);
  if (terminal) {
    updateRecoveryControls(terminal);
  }

  try {
    const response = await fetch(
      `/api/terminals/${encodeURIComponent(terminalId)}/video/resync`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      },
    );
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || "Falha ao recuperar transmissão");
    }
    const current = lastTerminals.find((candidate) => candidate.terminalId === terminalId);
    if (current && current.recovery?.startedAtMs !== payload.startedAtMs) {
      current.recovery = payload;
    }
  } catch (error) {
    recoveryErrors.set(
      terminalId,
      error instanceof Error ? error.message : "Falha ao recuperar transmissão",
    );
  } finally {
    recoveryRequests.delete(terminalId);
    const current = lastTerminals.find((candidate) => candidate.terminalId === terminalId);
    if (current) {
      updateRecoveryControls(current);
    }
  }
}

function setTerminalDetail(card, key, value) {
  const detail = card.querySelector(`[data-terminal-detail="${key}"]`);
  if (detail && detail.textContent !== value) {
    detail.textContent = value;
  }
}

function appendDetail(list, label, value, key) {
  const wrapper = document.createElement("div");
  const term = document.createElement("dt");
  term.textContent = label;
  const description = document.createElement("dd");
  description.textContent = value;
  description.dataset.terminalDetail = key;
  wrapper.append(term, description);
  list.append(wrapper);
}

function renderEvents(events) {
  eventList.replaceChildren();

  if (events.length === 0) {
    const empty = document.createElement("li");
    empty.className = "event-empty";
    empty.textContent = "Aguardando mensagens JT808…";
    eventList.append(empty);
    return;
  }

  for (const event of events.slice(0, 50)) {
    const row = document.createElement("li");
    row.className = "event-row";
    row.dataset.level = event.level || "info";

    const marker = document.createElement("span");
    marker.className = "event-marker";
    marker.setAttribute("aria-hidden", "true");

    const copy = document.createElement("div");
    copy.className = "event-copy";
    const message = document.createElement("p");
    message.className = "event-message";
    message.textContent = event.message || event.type || "Evento JT808";

    const meta = document.createElement("div");
    meta.className = "event-meta";
    const time = document.createElement("span");
    time.textContent = formatTime(event.timestamp);
    const terminal = document.createElement("span");
    terminal.textContent = event.terminalId
      ? `Terminal ${event.terminalId}`
      : "Gateway";
    meta.append(time, terminal);
    copy.append(message, meta);
    row.append(marker, copy);
    eventList.append(row);
  }
}

function formatTime(value) {
  if (!value) {
    return "—";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "—";
  }
  return new Intl.DateTimeFormat("pt-BR", {
    dateStyle: "short",
    timeStyle: "medium",
  }).format(date);
}

function setPanelConnection(state, label) {
  connectionStatus.dataset.state = state;
  connectionLabel.textContent = label;
}
