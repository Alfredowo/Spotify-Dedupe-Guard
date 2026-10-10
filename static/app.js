const state = {
  status: null,
  scan: null,
  filter: "all",
  search: "",
  selected: new Set(),
  keepers: new Map(),
  history: [],
};

let scanPollPromise = null;
let rateLimitTimer = null;
let pendingUndoActionId = null;
let toastTimer = null;
let toastDeadline = 0;
let toastRemainingMs = 0;
let toastPaused = false;
const TOAST_DURATION_MS = 4200;
const BROWSER_MODE = true;
let browserClientPromise = null;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function getBrowserClient() {
  if (!browserClientPromise) {
    browserClientPromise = Promise.all([
      import("/browser-client.mjs"),
    ]).then(async ([browserModule]) => {
      const store = await browserModule.openBrowserStore();
      return browserModule.createBrowserClient({store});
    }).catch(error => {
      browserClientPromise = null;
      throw error;
    });
  }
  return browserClientPromise;
}

$("#toast").addEventListener("mouseenter", pauseToast);
$("#toast").addEventListener("mouseleave", resumeToast);

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[char]));
}

function normalizeSearch(value = "") {
  return String(value)
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("es-MX")
    .trim();
}

async function api(path, options = {}) {
  if (BROWSER_MODE) return (await getBrowserClient()).api(path, options);
  const response = await fetch(path, {
    ...options,
    headers: {"Content-Type": "application/json", ...(options.headers || {})},
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || "La operación no pudo completarse.");
    error.status = response.status;
    error.details = payload.details;
    throw error;
  }
  return payload;
}

function toast(message, error = false) {
  const element = $("#toast");
  clearTimeout(toastTimer);
  toastRemainingMs = TOAST_DURATION_MS;
  toastPaused = element.matches(":hover");
  element.textContent = message;
  element.style.setProperty("--toast-duration", `${TOAST_DURATION_MS}ms`);
  element.className = "toast";
  void element.offsetWidth;
  element.className = `toast show${error ? " error" : ""}`;
  if (!toastPaused) startToastTimer();
}

function startToastTimer() {
  toastDeadline = Date.now() + toastRemainingMs;
  toastTimer = setTimeout(() => {
    $("#toast").className = "toast";
    toastTimer = null;
    toastPaused = false;
  }, toastRemainingMs);
}

function pauseToast() {
  const element = $("#toast");
  if (!element.classList.contains("show") || toastPaused) return;
  toastPaused = true;
  toastRemainingMs = Math.max(0, toastDeadline - Date.now());
  clearTimeout(toastTimer);
  toastTimer = null;
}

function resumeToast() {
  if (!toastPaused) return;
  toastPaused = false;
  if (toastRemainingMs <= 0) {
    $("#toast").className = "toast";
    return;
  }
  startToastTimer();
}

function setScanButtonState(status) {
  const button = $("#scan-button");
  if (!button.dataset.label) button.dataset.label = button.textContent.trim();
  const labels = {
    starting: "Iniciando análisis…",
    running: "Cancelar análisis",
    cancelling: "Cancelando análisis…",
  };
  const busy = status !== "idle";
  button.dataset.scanState = status;
  button.disabled = status === "starting" || status === "cancelling";
  button.setAttribute("aria-busy", busy ? "true" : "false");
  button.classList.toggle("loading", busy);
  button.classList.toggle("cancelling", status === "cancelling");
  button.lastChild.textContent = ` ${labels[status] || button.dataset.label}`;
}

function formatDuration(ms) {
  const seconds = Math.round((ms || 0) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function isRateLimitError(error) {
  return error?.status === 429 || /too many requests|\b429\b|spotify limitó temporalmente/i.test(error?.message || "");
}

function formatRateLimitWait(seconds) {
  const safeSeconds = Math.max(0, Math.ceil(seconds));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const remainder = safeSeconds % 60;
  if (hours) return `${hours} h ${minutes} min`;
  if (minutes) return `${minutes} min ${remainder} s`;
  return `${remainder} s`;
}

function renderRateLimit(rateLimit = state.status?.rate_limit) {
  const note = $("#rate-limit-note");
  const button = $("#scan-button");
  clearInterval(rateLimitTimer);
  rateLimitTimer = null;

  let remaining = Number(rateLimit?.retry_after || 0);
  if (!rateLimit?.active || remaining <= 0) {
    note.hidden = true;
    if (!["starting", "cancelling"].includes(button.dataset.scanState)) button.disabled = false;
    return;
  }

  const deadline = Date.now() + remaining * 1000;
  const update = () => {
    remaining = Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
    if (state.status?.rate_limit) state.status.rate_limit.retry_after = remaining;
    if (remaining <= 0) {
      clearInterval(rateLimitTimer);
      rateLimitTimer = null;
      if (state.status?.rate_limit) state.status.rate_limit.active = false;
      note.hidden = true;
      if (!["starting", "cancelling"].includes(button.dataset.scanState)) button.disabled = false;
      return;
    }
    button.disabled = button.dataset.scanState !== "running";
    note.hidden = false;
    const explanation = rateLimit?.reason === "QUOTA_EXCEEDED"
      ? "Se alcanzó la cuota de Spotify para apps en desarrollo."
      : "Spotify limitó temporalmente las solicitudes.";
    note.textContent = `${explanation} Podrás volver a analizar en ${formatRateLimitWait(remaining)}.`;
  };

  update();
  rateLimitTimer = setInterval(update, 1000);
}

async function refreshStatus() {
  state.status = await api("/api/status");
  renderStatus();
}

function formatDate(value) {
  if (!value) return "Fecha desconocida";
  return new Intl.DateTimeFormat("es-MX", {day: "numeric", month: "short", year: "numeric"}).format(new Date(value));
}

function formatDateTime(value) {
  if (!value) return "";
  return new Intl.DateTimeFormat("es-MX", {dateStyle: "medium", timeStyle: "short"}).format(new Date(value));
}

async function boot() {
  try {
    let oauthConnected = false;
    if (BROWSER_MODE) {
      try {
        oauthConnected = await (await getBrowserClient()).completeOAuthCallback();
      } catch (error) {
        toast(error.message, true);
      }
    }
    state.status = await api("/api/status");
    renderStatus();
    if (oauthConnected) toast("Spotify conectado. Tus datos se guardan en este navegador.");
    if (state.status.authenticated) {
      if (state.status.profile_refreshing) void waitForProfileRefresh();
      else if (!state.status.profile?.display_name || state.status.profile.display_name === "Spotify") {
        void refreshMissingProfile();
      }
      await Promise.all([loadLatestScan(), loadHistory()]);
      void resumeScan();
    }
  } catch (error) {
    if (BROWSER_MODE && !state.status) {
      state.status = {
        configured: false,
        authenticated: false,
        private_deployment: false,
        redirect_uri: `${window.location.origin}/`,
        rate_limit: {active: false, retry_after: 0},
      };
      renderStatus();
    }
    toast(error.message, true);
  }
}

function renderStatus() {
  const setup = $("#setup");
  const dashboard = $("#dashboard");
  const configStep = $("#config-step");
  const authStep = $("#auth-step");
  const accountControls = $("#account-controls");
  $("#redirect-uri").textContent = state.status.redirect_uri || "";
  $("#connect-spotify").href = BROWSER_MODE ? "#" : "/auth/login";
  $("#browser-storage-note").hidden = !BROWSER_MODE;

  if (!state.status.authenticated) {
    setup.hidden = false;
    dashboard.hidden = true;
    accountControls.hidden = !state.status.private_deployment;
    $("#account-pill").hidden = true;
    $("#disconnect-button").hidden = true;
    $("#app-logout-form").hidden = !state.status.private_deployment;
    configStep.hidden = state.status.configured;
    authStep.hidden = !state.status.configured;
    renderRateLimit({active: false, retry_after: 0});
    return;
  }

  setup.hidden = true;
  dashboard.hidden = false;
  accountControls.hidden = false;
  $("#account-pill").hidden = false;
  $("#disconnect-button").hidden = false;
  $("#app-logout-form").hidden = !state.status.private_deployment;
  const profile = state.status.profile || {};
  const pill = $("#account-pill");
  const displayName = profile.display_name || "Spotify";
  const image = profile.images?.[0]?.url;
  pill.innerHTML = image
    ? `<img src="${escapeHtml(image)}" alt=""><span class="account-name">${escapeHtml(displayName)}</span>`
    : `<span class="account-fallback">${escapeHtml(displayName[0])}</span><span class="account-name">${escapeHtml(displayName)}</span>`;
  renderRateLimit();
}

async function disconnectSpotify() {
  const button = $("#disconnect-button");
  button.disabled = true;
  button.textContent = "Cerrando…";
  try {
    await api("/api/disconnect", {
      method: "POST",
      headers: {"X-Dedupe-Intent": "confirmed"},
      body: "{}",
    });
    state.scan = null;
    state.selected.clear();
    state.keepers.clear();
    state.history = [];
    state.status = await api("/api/status");
    renderStatus();
    toast("Spotify desconectado. Ya puedes conectar otra cuenta.");
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
    button.textContent = "Desconectar Spotify";
  }
}

async function waitForProfileRefresh() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await delay(1000);
    const status = await api("/api/status");
    if (!status.authenticated || !status.profile_refreshing) {
      state.status = status;
      renderStatus();
      return;
    }
  }
}

async function refreshMissingProfile() {
  try {
    await api("/api/profile/refresh", {method: "POST", body: "{}"});
    await waitForProfileRefresh();
  } catch (error) {
    toast(error.message, true);
  }
}

async function loadLatestScan({resetSelection = true} = {}) {
  const payload = await api("/api/scan/latest");
  if (payload.scan) {
    state.scan = payload.scan;
    state.keepers = new Map(state.scan.groups.map(group => [group.id, group.keeper.id]));
    if (resetSelection) {
      state.selected.clear();
      if (!state.scan.updated_at) selectSafe();
    }
    renderScan();
  }
}

async function loadHistory() {
  const payload = await api("/api/history");
  state.history = payload.history || [];
  renderHistory();
}

function selectSafe() {
  selectCategory("safe", true);
}

function groupTracks(group) {
  return [group.keeper, ...(group.remove || [])];
}

function selectedKeeper(group) {
  return state.keepers.get(group.id) || group.keeper.id;
}

function categoryTrackIds(kind) {
  return (state.scan?.groups || [])
    .filter(group => group.kind === kind)
    .flatMap(group => {
      const keeperId = selectedKeeper(group);
      return groupTracks(group).filter(track => track.id !== keeperId).map(track => track.id);
    });
}

function selectCategory(kind, replace = false) {
  if (replace) state.selected.clear();
  categoryTrackIds(kind).forEach(trackId => state.selected.add(trackId));
}

function toggleCategory(kind) {
  const trackIds = categoryTrackIds(kind);
  const allSelected = trackIds.length > 0 && trackIds.every(trackId => state.selected.has(trackId));
  trackIds.forEach(trackId => allSelected ? state.selected.delete(trackId) : state.selected.add(trackId));
}

function renderScan() {
  const scan = state.scan;
  if (!scan) return;
  $("#empty-state").hidden = true;
  $("#results").hidden = false;
  $("#last-scan").textContent = scan.updated_at
    ? `Auditoría actualizada · ${formatDateTime(scan.updated_at)}`
    : `Última auditoría · ${formatDateTime(scan.created_at)}`;
  $("#total-tracks").textContent = scan.total_tracks.toLocaleString("es-MX");
  $("#safe-count").textContent = (scan.summary.removable_safe ?? removableCount("safe")).toLocaleString("es-MX");
  $("#probable-count").textContent = (scan.summary.removable_probable ?? removableCount("probable")).toLocaleString("es-MX");
  $("#version-count").textContent = (scan.summary.removable_version ?? removableCount("version")).toLocaleString("es-MX");
  $("#filter-all").textContent = scan.summary.total_groups;
  $("#filter-safe").textContent = scan.summary.safe;
  $("#filter-probable").textContent = scan.summary.probable;
  $("#filter-version").textContent = scan.summary.version;
  renderGroups();
  renderSelection();
}

function kindLabel(kind) {
  return {safe: "Seguro", probable: "Probable", version: "Versiones"}[kind] || kind;
}

function removableCount(kind) {
  return (state.scan?.groups || [])
    .filter(group => group.kind === kind)
    .reduce((count, group) => count + groupTracks(group).length - 1, 0);
}

function trackRow(track, keeper, group) {
  const durationRatio = Math.max(22, Math.min(100, (track.duration_ms / Math.max(group.keeper.duration_ms, ...group.remove.map(item => item.duration_ms))) * 100));
  const tags = (track.tags || []).map(tag => `<span class="tag">${escapeHtml(tag)}</span>`).join("");
  const control = `<div class="row-controls">
      <label class="keeper-control" title="Conservar esta copia">
        <input class="keeper-radio" type="radio" name="keeper-${escapeHtml(group.id)}" data-group-id="${escapeHtml(group.id)}" data-track-id="${escapeHtml(track.id)}" ${keeper ? "checked" : ""}>
        <span>Conservar</span>
      </label>
      <label class="remove-control${keeper ? " disabled" : ""}">
        <input class="track-check" type="checkbox" name="remove-${escapeHtml(group.id)}" value="${escapeHtml(track.id)}" aria-label="Retirar ${escapeHtml(track.name)}" data-track-id="${escapeHtml(track.id)}" ${state.selected.has(track.id) ? "checked" : ""} ${keeper ? "disabled" : ""}>
        <span>Retirar</span>
      </label>
    </div>`;
  return `
    <div class="track-row ${keeper ? "keeper" : "duplicate"}">
      ${control}
      <div class="track-title">
        <b>${escapeHtml(track.name)}${keeper ? "<em>CONSERVAR</em>" : ""}</b>
        <span>${escapeHtml(track.artists.join(", "))}</span>
        ${tags ? `<div class="tags">${tags}</div>` : ""}
      </div>
      <div class="album-cell" title="${escapeHtml(track.album)}">${escapeHtml(track.album)}<small>${escapeHtml(track.album_type || "edición")}${track.release_date ? ` · ${escapeHtml(track.release_date.slice(0, 4))}` : ""}</small></div>
      <div class="date-cell">${formatDate(track.added_at)}</div>
      <div class="duration-cell"><div class="groove" style="--groove-width:${durationRatio}%"><i></i></div>${formatDuration(track.duration_ms)}</div>
    </div>`;
}

function renderGroups() {
  const query = normalizeSearch(state.search);
  const groups = (state.scan?.groups || []).filter(group => {
    if (state.filter !== "all" && group.kind !== state.filter) return false;
    if (!query) return true;
    const searchable = groupTracks(group).flatMap(track => [
      track.name,
      ...(track.artists || []),
      track.album,
      ...(track.tags || []),
    ]).join(" ");
    return normalizeSearch(searchable).includes(query);
  });
  $("#group-count").textContent = `${groups.length} ${groups.length === 1 ? "coincidencia" : "coincidencias"}`;
  const visibleLabel = $("#visible-label");
  visibleLabel.textContent = state.filter === "all" ? "Todos los grupos" : kindLabel(state.filter);
  visibleLabel.dataset.kind = state.filter;
  const emptyMessage = query
    ? `<div class="groups-empty"><h2>No encontramos esa canción</h2><p>Prueba con otro título, artista o álbum.</p></div>`
    : `<div class="groups-empty"><h2>Todo limpio por aquí</h2><p>No encontramos duplicados en esta categoría. Puedes explorar otro filtro o analizar de nuevo cuando cambie tu biblioteca.</p></div>`;
  $("#groups").innerHTML = groups.length ? groups.map(group => `
    <article class="group-card" data-kind="${group.kind}">
      <header class="group-head">
        <div class="confidence ${group.kind}"><i class="dot ${group.kind}"></i>${kindLabel(group.kind)} · ${Math.round(group.confidence * 100)}%</div>
        <div class="group-reason">${escapeHtml(group.reason)}<br><small>${escapeHtml(group.keeper_reason)}</small></div>
      </header>
      ${groupTracks(group).map(track => trackRow(track, track.id === selectedKeeper(group), group)).join("")}
    </article>`).join("") : emptyMessage;

  $$(".track-check").forEach(input => input.addEventListener("change", event => {
    const id = event.currentTarget.dataset.trackId;
    event.currentTarget.checked ? state.selected.add(id) : state.selected.delete(id);
    renderSelection();
  }));
  $$(".keeper-radio").forEach(input => input.addEventListener("change", event => {
    const group = (state.scan?.groups || []).find(item => item.id === event.currentTarget.dataset.groupId);
    if (!group) return;
    const oldKeeper = selectedKeeper(group);
    const newKeeper = event.currentTarget.dataset.trackId;
    const newKeeperWasSelected = state.selected.has(newKeeper);
    state.keepers.set(group.id, newKeeper);
    state.selected.delete(newKeeper);
    if (newKeeperWasSelected && oldKeeper !== newKeeper) state.selected.add(oldKeeper);
    renderGroups();
    renderSelection();
  }));
}

function renderSelection() {
  const count = state.selected.size;
  $("#selected-count").textContent = count;
  const button = $("#remove-button");
  button.disabled = count === 0;
  $("span", button).textContent = count;
  $$("[data-selection-kind]").forEach(toggle => {
    const trackIds = categoryTrackIds(toggle.dataset.selectionKind);
    const active = trackIds.length > 0 && trackIds.every(trackId => state.selected.has(trackId));
    toggle.checked = active;
    toggle.disabled = trackIds.length === 0;
  });
}

function setupGroupsToolbar() {
  const toolbar = $("#groups-toolbar");
  const sentinel = $("#groups-toolbar-sentinel");
  const topbar = $(".topbar");
  if (!toolbar || !sentinel || !topbar) return;

  let observer;
  let observedOffset = -1;
  const connectObserver = () => {
    const offset = Math.round(topbar.getBoundingClientRect().height);
    if (offset === observedOffset) return;
    observedOffset = offset;
    observer?.disconnect();
    observer = new IntersectionObserver(([entry]) => {
      const stuck = !entry.isIntersecting && entry.boundingClientRect.top <= offset;
      toolbar.classList.toggle("is-stuck", stuck);
    }, {rootMargin: `-${offset}px 0px 0px 0px`, threshold: 0});
    observer.observe(sentinel);
  };

  connectObserver();
  if ("ResizeObserver" in window) {
    new ResizeObserver(connectObserver).observe(topbar);
  } else {
    window.addEventListener("resize", connectObserver);
  }
}

function renderHistory() {
  const section = $("#history-section");
  if (!state.history.length) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  $("#history").innerHTML = state.history.map(item => `
    <div class="history-entry">
      <div class="history-row">
        <div class="history-main">
          <b>${item.action === "remove" ? "Duplicados retirados" : "Limpieza restaurada"}</b>
          <small>${formatDateTime(item.created_at)}</small>
        </div>
        <div class="history-actions">
          <span class="history-count">${item.count} canciones</span>
          ${item.can_undo ? `<button class="text-button undo-button" data-action-id="${item.id}" data-action-count="${item.count}" type="button">Deshacer</button>` : ""}
        </div>
      </div>
      ${item.tracks?.length ? `
        <details class="history-details">
          <summary>
            <svg class="history-chevron" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
              <path d="m6 3.5 4.5 4.5L6 12.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"></path>
            </svg>
            <span>Ver canciones ${item.action === "remove" ? "retiradas" : "restauradas"}</span>
          </summary>
          <ul class="history-tracks">
            ${item.tracks.map(track => `
              <li>
                <span>${escapeHtml(track.name || "Canción sin título")}</span>
                <small>${escapeHtml((track.artists || []).join(", ") || "Artista desconocido")}</small>
              </li>`).join("")}
          </ul>
        </details>` : ""}
    </div>`).join("");
  $$(".undo-button").forEach(button => button.addEventListener("click", () => openUndoDialog(button)));
}

async function scanLibrary() {
  setScanButtonState("starting");
  let jobAccepted = false;
  try {
    const job = await api("/api/scan", {method: "POST", body: "{}"});
    jobAccepted = true;
    await followScan(job, {announceResume: false});
  } catch (error) {
    if (isRateLimitError(error)) {
      await refreshStatus().catch(() => {});
      const message = state.status?.rate_limit?.reason === "QUOTA_EXCEEDED"
        ? "Se alcanzó la cuota de Spotify para apps en desarrollo. El contador indica cuándo podrás volver a analizar."
        : "Spotify limitó temporalmente las solicitudes. El contador indica cuándo podrás volver a analizar.";
      toast(message, true);
      return;
    }
    toast(error.message, true);
  } finally {
    if (!jobAccepted) {
      setScanButtonState("idle");
      renderRateLimit();
    }
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function resumeScan() {
  try {
    const job = await api("/api/scan/status");
    if (["running", "cancelling"].includes(job.status)) await followScan(job, {announceResume: true});
  } catch (error) {
    toast(error.message, true);
  }
}

function followScan(job, {announceResume = false} = {}) {
  if (scanPollPromise) return scanPollPromise;
  scanPollPromise = pollScan(job, announceResume).finally(() => {
    scanPollPromise = null;
  });
  return scanPollPromise;
}

async function pollScan(job, announceResume) {
  const button = $("#scan-button");
  setScanButtonState(job.status === "cancelling" ? "cancelling" : "running");
  if (announceResume) {
    toast(job.status === "cancelling"
      ? "La cancelación sigue en curso. Retomando la actualización…"
      : "El análisis sigue en curso. Retomando la actualización…");
  }
  try {
    while (["running", "cancelling"].includes(job.status)) {
      await delay(900);
      job = await api("/api/scan/status");
    }
    if (job.status === "cancelled") {
      toast("Análisis cancelado. No se guardaron resultados nuevos.");
      return;
    }
    if (job.status === "failed") throw new Error(job.error || "El análisis no pudo completarse.");
    if (job.status !== "completed") return;
    await loadLatestScan();
    state.filter = "all";
    $$(".filter").forEach(item => item.classList.toggle("active", item.dataset.filter === "all"));
    renderScan();
    toast(`Auditoría completa: ${state.scan.summary.total_groups} grupos encontrados.`);
  } catch (error) {
    if (isRateLimitError(error)) await refreshStatus().catch(() => {});
    const message = isRateLimitError(error)
      ? "Spotify pidió una pausa breve. El análisis no se completó y los resultados visibles son anteriores; podrás intentarlo de nuevo cuando termine el contador."
      : error.message;
    toast(message, true);
  } finally {
    setScanButtonState("idle");
    renderRateLimit();
  }
}

async function cancelScan() {
  const button = $("#scan-button");
  if (button.dataset.scanState !== "running") return;

  setScanButtonState("cancelling");
  try {
    const job = await api("/api/scan/cancel", {method: "POST", body: "{}"});
    if (!scanPollPromise) await followScan(job);
  } catch (error) {
    setScanButtonState("running");
    toast(error.message, true);
  }
}

async function removeSelected() {
  const button = $("#confirm-remove");
  button.disabled = true;
  button.textContent = "Creando respaldo…";
  try {
    const payload = await api("/api/remove", {
      method: "POST",
      headers: {"X-Dedupe-Intent": "confirmed"},
      body: JSON.stringify({
        scan_id: state.scan.scan_id,
        track_ids: [...state.selected],
        keepers: Object.fromEntries(state.keepers),
        create_backup: $("#create-backup").checked,
      }),
    });
    $("#confirm-dialog").close();
    state.scan = payload.scan;
    state.keepers = new Map(state.scan.groups.map(group => [group.id, group.keeper.id]));
    state.selected.clear();
    renderScan();
    await loadHistory();
    const remaining = state.scan.summary.total_removable;
    const pendingMessage = remaining === 0
      ? "No quedan duplicados pendientes."
      : remaining === 1
      ? "Queda 1 duplicado pendiente."
      : `Quedan ${remaining} duplicados pendientes.`;
    toast(payload.created_backup
      ? `${payload.removed} duplicados retirados. El respaldo quedó en Spotify. ${pendingMessage}`
      : `${payload.removed} duplicados retirados sin crear playlist de respaldo. ${pendingMessage}`);
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.textContent = "Crear respaldo y retirar";
    $("#confirm-checkbox").checked = false;
    button.disabled = true;
  }
}

function openUndoDialog(button) {
  pendingUndoActionId = Number(button.dataset.actionId);
  $("#undo-count").textContent = button.dataset.actionCount;
  $("#undo-checkbox").checked = false;
  $("#confirm-undo").disabled = true;
  $("#undo-dialog").showModal();
}

async function undoAction() {
  const button = $("#confirm-undo");
  const actionId = pendingUndoActionId;
  if (!Number.isInteger(actionId)) return;

  button.disabled = true;
  button.textContent = "Restaurando…";
  try {
    const payload = await api("/api/undo", {
      method: "POST",
      headers: {"X-Dedupe-Intent": "confirmed"},
      body: JSON.stringify({action_id: actionId}),
    });
    $("#undo-dialog").close();
    if (payload.scan && state.scan?.scan_id === payload.scan.scan_id) {
      state.scan = payload.scan;
      state.keepers = new Map(state.scan.groups.map(group => [group.id, group.keeper.id]));
      state.selected.clear();
      renderScan();
    }
    await loadHistory();
    toast(`${payload.restored} canciones restauradas en Tus me gusta.`);
  } catch (error) {
    toast(error.message, true);
    button.disabled = false;
    button.textContent = "Restaurar canciones";
  }
}

$("#config-form").addEventListener("submit", async event => {
  event.preventDefault();
  const button = $("button[type=submit]", event.currentTarget);
  button.disabled = true;
  try {
    await api("/api/config", {method: "POST", body: JSON.stringify({client_id: $("#client-id").value.trim()})});
    state.status.configured = true;
    renderStatus();
    toast("Client ID guardado. Ya puedes autorizar Spotify.");
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.disabled = false;
  }
});

$("#connect-spotify").addEventListener("click", event => {
  if (!BROWSER_MODE) return;
  event.preventDefault();
  void getBrowserClient()
    .then(client => client.beginLogin())
    .catch(error => toast(error.message, true));
});

$("#copy-redirect").addEventListener("click", async () => {
  await navigator.clipboard.writeText($("#redirect-uri").textContent);
  toast("Redirect URI copiada.");
});

$("#change-client").addEventListener("click", () => {
  if (!BROWSER_MODE) {
    state.status.configured = false;
    renderStatus();
    return;
  }
  void api("/api/config", {method: "POST", body: JSON.stringify({client_id: ""})})
    .then(async () => {
      state.status = await api("/api/status");
      renderStatus();
    })
    .catch(error => toast(error.message, true));
});

$("#scan-button").addEventListener("click", () => {
  if ($("#scan-button").dataset.scanState === "running") {
    void cancelScan();
    return;
  }
  void scanLibrary();
});
$("#disconnect-button").addEventListener("click", disconnectSpotify);
let searchTimer;
$("#track-search").addEventListener("input", event => {
  state.search = event.currentTarget.value;
  clearTimeout(searchTimer);
  searchTimer = setTimeout(renderGroups, 120);
});
$("#track-search").addEventListener("keydown", event => {
  if (event.key !== "Escape" || !event.currentTarget.value) return;
  event.currentTarget.value = "";
  state.search = "";
  clearTimeout(searchTimer);
  renderGroups();
});
$$('[data-selection-kind]').forEach(checkbox => checkbox.addEventListener("change", () => {
  toggleCategory(checkbox.dataset.selectionKind);
  renderGroups();
  renderSelection();
}));

$$(".filter").forEach(button => button.addEventListener("click", () => {
  state.filter = button.dataset.filter;
  $$(".filter").forEach(item => item.classList.toggle("active", item === button));
  renderGroups();
}));

function closeOnBackdropClick(dialog) {
  dialog.addEventListener("click", event => {
    if (event.target === dialog) dialog.close("cancel");
  });
}

closeOnBackdropClick($("#confirm-dialog"));
closeOnBackdropClick($("#undo-dialog"));

$("#remove-button").addEventListener("click", () => {
  const withBackup = $("#create-backup").checked;
  $("#confirm-count").textContent = state.selected.size;
  $("#confirm-checkbox").checked = false;
  $("#confirm-remove").disabled = true;
  $("#no-backup-warning").hidden = withBackup;
  $("#confirm-copy").textContent = withBackup
    ? "Primero se guardarán en una playlist privada de respaldo. Después desaparecerán de “Tus me gusta”."
    : "Las canciones desaparecerán de “Tus me gusta” sin crear una playlist de respaldo.";
  $("#confirm-label").textContent = withBackup
    ? "Entiendo que esta acción modifica mi biblioteca."
    : "Entiendo que estoy retirando canciones sin una playlist de respaldo.";
  $("#confirm-remove").textContent = withBackup ? "Crear respaldo y retirar" : "Retirar sin respaldo";
  $("#confirm-dialog").showModal();
});

$("#confirm-checkbox").addEventListener("change", event => {
  $("#confirm-remove").disabled = !event.currentTarget.checked;
});
$("#confirm-remove").addEventListener("click", removeSelected);
$("#undo-checkbox").addEventListener("change", event => {
  $("#confirm-undo").disabled = !event.currentTarget.checked;
});
$("#confirm-undo").addEventListener("click", undoAction);
$("#undo-dialog").addEventListener("close", () => {
  pendingUndoActionId = null;
  $("#undo-checkbox").checked = false;
  $("#confirm-undo").disabled = true;
  $("#confirm-undo").textContent = "Restaurar canciones";
});

boot().finally(setupGroupsToolbar);
