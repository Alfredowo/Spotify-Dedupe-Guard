const state = {
  status: null,
  scan: null,
  filter: "all",
  selected: new Set(),
  history: [],
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;","'":"&#39;",'"':"&quot;"}[char]));
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {"Content-Type": "application/json", ...(options.headers || {})},
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || "La operación no pudo completarse.");
  return payload;
}

function toast(message, error = false) {
  const element = $("#toast");
  element.textContent = message;
  element.className = `toast show${error ? " error" : ""}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => element.className = "toast", 4200);
}

function setBusy(button, busy, busyText = "Procesando…") {
  if (!button.dataset.label) button.dataset.label = button.textContent.trim();
  button.disabled = busy;
  button.classList.toggle("loading", busy);
  button.lastChild.textContent = busy ? ` ${busyText}` : ` ${button.dataset.label}`;
}

function formatDuration(ms) {
  const seconds = Math.round((ms || 0) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
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
    state.status = await api("/api/status");
    renderStatus();
    if (state.status.authenticated) {
      await Promise.all([loadLatestScan(), loadHistory()]);
    }
  } catch (error) {
    toast(error.message, true);
  }
}

function renderStatus() {
  const setup = $("#setup");
  const dashboard = $("#dashboard");
  const configStep = $("#config-step");
  const authStep = $("#auth-step");
  $("#redirect-uri").textContent = state.status.redirect_uri;

  if (!state.status.authenticated) {
    setup.hidden = false;
    dashboard.hidden = true;
    configStep.hidden = state.status.configured;
    authStep.hidden = !state.status.configured;
    return;
  }

  setup.hidden = true;
  dashboard.hidden = false;
  const profile = state.status.profile || {};
  const pill = $("#account-pill");
  const image = profile.images?.[0]?.url;
  pill.innerHTML = image
    ? `<img src="${escapeHtml(image)}" alt=""><span>${escapeHtml(profile.display_name)}</span>`
    : `<span class="account-fallback">${escapeHtml((profile.display_name || "S")[0])}</span><span>${escapeHtml(profile.display_name || "Spotify")}</span>`;
  pill.hidden = false;
}

async function loadLatestScan() {
  const payload = await api("/api/scan/latest");
  if (payload.scan) {
    state.scan = payload.scan;
    selectSafe();
    renderScan();
  }
}

async function loadHistory() {
  const payload = await api("/api/history");
  state.history = payload.history || [];
  renderHistory();
}

function selectSafe() {
  state.selected.clear();
  for (const group of state.scan?.groups || []) {
    if (group.kind === "safe") group.remove.forEach(track => state.selected.add(track.id));
  }
}

function renderScan() {
  const scan = state.scan;
  if (!scan) return;
  $("#empty-state").hidden = true;
  $("#results").hidden = false;
  $("#last-scan").textContent = `Última auditoría · ${formatDateTime(scan.created_at)}`;
  $("#total-tracks").textContent = scan.total_tracks.toLocaleString("es-MX");
  $("#safe-count").textContent = scan.summary.safe.toLocaleString("es-MX");
  $("#review-count").textContent = (scan.summary.probable + scan.summary.version).toLocaleString("es-MX");
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

function trackRow(track, keeper, group) {
  const durationRatio = Math.max(22, Math.min(100, (track.duration_ms / Math.max(group.keeper.duration_ms, ...group.remove.map(item => item.duration_ms))) * 100));
  const tags = (track.tags || []).map(tag => `<span class="tag">${escapeHtml(tag)}</span>`).join("");
  const control = keeper
    ? `<span class="keep-symbol" title="Conservar">◆</span>`
    : `<input class="track-check" type="checkbox" aria-label="Retirar ${escapeHtml(track.name)}" data-track-id="${escapeHtml(track.id)}" ${state.selected.has(track.id) ? "checked" : ""}>`;
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
  const groups = (state.scan?.groups || []).filter(group => state.filter === "all" || group.kind === state.filter);
  $("#group-count").textContent = `${groups.length} ${groups.length === 1 ? "coincidencia" : "coincidencias"}`;
  $("#visible-label").textContent = state.filter === "all" ? "Todos los grupos" : kindLabel(state.filter);
  $("#groups").innerHTML = groups.length ? groups.map(group => `
    <article class="group-card" data-kind="${group.kind}">
      <header class="group-head">
        <div class="confidence ${group.kind}"><i class="dot ${group.kind}"></i>${kindLabel(group.kind)} · ${Math.round(group.confidence * 100)}%</div>
        <div class="group-reason">${escapeHtml(group.reason)}<br><small>${escapeHtml(group.keeper_reason)}</small></div>
      </header>
      ${trackRow(group.keeper, true, group)}
      ${group.remove.map(track => trackRow(track, false, group)).join("")}
    </article>`).join("") : `<div class="empty-state"><h2>No hay grupos en esta categoría</h2><p>Cambia el filtro o ejecuta una auditoría nueva.</p></div>`;

  $$(".track-check").forEach(input => input.addEventListener("change", event => {
    const id = event.currentTarget.dataset.trackId;
    event.currentTarget.checked ? state.selected.add(id) : state.selected.delete(id);
    renderSelection();
  }));
}

function renderSelection() {
  const count = state.selected.size;
  $("#selected-count").textContent = count;
  const button = $("#remove-button");
  button.disabled = count === 0;
  $("span", button).textContent = count;
}

function renderHistory() {
  const section = $("#history-section");
  if (!state.history.length) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  $("#history").innerHTML = state.history.map(item => `
    <div class="history-row">
      <div><b>${item.action === "remove" ? "Duplicados retirados" : "Limpieza restaurada"}</b><small>${formatDateTime(item.created_at)}</small></div>
      <span class="history-count">${item.count} canciones</span>
      ${item.can_undo ? `<button class="text-button undo-button" data-action-id="${item.id}" type="button">Deshacer</button>` : "<span></span>"}
    </div>`).join("");
  $$(".undo-button").forEach(button => button.addEventListener("click", () => undoAction(button)));
}

async function scanLibrary() {
  const button = $("#scan-button");
  setBusy(button, true, "Leyendo canciones…");
  try {
    const payload = await api("/api/scan", {method: "POST", body: "{}"});
    state.scan = payload.scan;
    state.filter = "all";
    selectSafe();
    renderScan();
    toast(`Auditoría completa: ${state.scan.summary.total_groups} grupos encontrados.`);
  } catch (error) {
    toast(error.message, true);
  } finally {
    setBusy(button, false);
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
      body: JSON.stringify({scan_id: state.scan.scan_id, track_ids: [...state.selected]}),
    });
    $("#confirm-dialog").close();
    state.selected.clear();
    renderGroups();
    renderSelection();
    await loadHistory();
    toast(`${payload.removed} duplicados retirados. El respaldo quedó en Spotify.`);
  } catch (error) {
    toast(error.message, true);
  } finally {
    button.textContent = "Crear respaldo y retirar";
    $("#confirm-checkbox").checked = false;
    button.disabled = true;
  }
}

async function undoAction(button) {
  button.disabled = true;
  button.textContent = "Restaurando…";
  try {
    const payload = await api("/api/undo", {
      method: "POST",
      headers: {"X-Dedupe-Intent": "confirmed"},
      body: JSON.stringify({action_id: Number(button.dataset.actionId)}),
    });
    await loadHistory();
    toast(`${payload.restored} canciones restauradas en Tus me gusta.`);
  } catch (error) {
    toast(error.message, true);
    button.disabled = false;
    button.textContent = "Deshacer";
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

$("#copy-redirect").addEventListener("click", async () => {
  await navigator.clipboard.writeText($("#redirect-uri").textContent);
  toast("Redirect URI copiada.");
});

$("#change-client").addEventListener("click", () => {
  state.status.configured = false;
  renderStatus();
});

$("#scan-button").addEventListener("click", scanLibrary);
$("#select-safe").addEventListener("click", () => { selectSafe(); renderGroups(); renderSelection(); });

$$(".filter").forEach(button => button.addEventListener("click", () => {
  state.filter = button.dataset.filter;
  $$(".filter").forEach(item => item.classList.toggle("active", item === button));
  renderGroups();
}));

$("#remove-button").addEventListener("click", () => {
  $("#confirm-count").textContent = state.selected.size;
  $("#confirm-checkbox").checked = false;
  $("#confirm-remove").disabled = true;
  $("#confirm-dialog").showModal();
});

$("#confirm-checkbox").addEventListener("change", event => {
  $("#confirm-remove").disabled = !event.currentTarget.checked;
});
$("#confirm-remove").addEventListener("click", removeSelected);

boot();
