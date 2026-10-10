import {detectDuplicates} from "./dedupe-engine.mjs";

const ACCOUNTS_BASE = "https://accounts.spotify.com";
const API_BASE = "https://api.spotify.com/v1";
const SCOPES = "user-read-private user-library-read user-library-modify playlist-modify-private";
const DATABASE_NAME = "spotify-dedupe-guard";
const DATABASE_VERSION = 1;
const OBJECT_STORE = "entries";
const OAUTH_SESSION_KEY = "spotify-dedupe-oauth";

export const BROWSER_STORAGE_KEYS = Object.freeze({
  clientId: "spotify_client_id",
  token: "spotify_token",
  profile: "spotify_profile",
});

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || new Error("La transacción local se canceló."));
    transaction.onerror = () => reject(transaction.error || new Error("No se pudo guardar en este navegador."));
  });
}

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("No se pudo leer el almacenamiento local."));
  });
}

export async function openBrowserStore(indexedDBApi = globalThis.indexedDB) {
  if (!indexedDBApi) throw new Error("Este navegador no permite almacenamiento local persistente.");
  const database = await new Promise((resolve, reject) => {
    const request = indexedDBApi.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(OBJECT_STORE)) {
        request.result.createObjectStore(OBJECT_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("No se pudo abrir el almacenamiento local."));
    request.onblocked = () => reject(new Error("Cierra otras pestañas de Dedupe Guard y vuelve a cargar."));
  });

  return {
    async get(key) {
      const transaction = database.transaction(OBJECT_STORE, "readonly");
      const done = transactionDone(transaction);
      const value = await requestResult(transaction.objectStore(OBJECT_STORE).get(key));
      await done;
      return value ?? null;
    },
    async set(key, value) {
      const transaction = database.transaction(OBJECT_STORE, "readwrite");
      transaction.objectStore(OBJECT_STORE).put(value, key);
      await transactionDone(transaction);
    },
    async remove(key) {
      const transaction = database.transaction(OBJECT_STORE, "readwrite");
      transaction.objectStore(OBJECT_STORE).delete(key);
      await transactionDone(transaction);
    },
    async updateMany(keys, updater) {
      if (!keys.length) return {};
      const transaction = database.transaction(OBJECT_STORE, "readwrite");
      const objectStore = transaction.objectStore(OBJECT_STORE);
      const current = {};
      let remaining = keys.length;
      let changes;
      let updateError = null;

      for (const key of keys) {
        const request = objectStore.get(key);
        request.onsuccess = () => {
          current[key] = request.result ?? null;
          remaining -= 1;
          if (remaining !== 0) return;
          try {
            changes = updater(current);
            for (const [updatedKey, value] of Object.entries(changes)) {
              if (!keys.includes(updatedKey)) throw new Error("La transacción intentó cambiar una clave no solicitada.");
              if (value === null) objectStore.delete(updatedKey);
              else if (value !== undefined) objectStore.put(value, updatedKey);
            }
          } catch (error) {
            updateError = error;
            transaction.abort();
            return;
          }
        };
      }
      try {
        await transactionDone(transaction);
      } catch (error) {
        throw updateError || error;
      }
      return changes || {};
    },
  };
}

function base64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function spotifyError(message, status = 500, details = undefined) {
  const error = new Error(message || "La operación no pudo completarse.");
  error.status = status;
  error.details = details;
  return error;
}

async function readJson(response) {
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {error: text};
  }
}

export function createBrowserClient({
  store,
  fetchImpl = globalThis.fetch,
  cryptoImpl = globalThis.crypto,
  sessionStorage = globalThis.sessionStorage,
  location = globalThis.location,
  history = globalThis.history,
  now = () => Date.now(),
}) {
  if (!store?.get || !store?.set || !store?.remove) throw new TypeError("Falta el almacenamiento IndexedDB.");
  if (!fetchImpl || !cryptoImpl?.subtle || !cryptoImpl?.getRandomValues) {
    throw new Error("El navegador no ofrece las funciones criptográficas necesarias para Spotify PKCE.");
  }

  const redirectUri = `${location.origin}/`;
  let refreshPromise = null;
  let profilePromise = null;

  const userKey = (userId, name) => `user:${userId}:${name}`;

  async function updateMany(keys, updater) {
    if (store.updateMany) return store.updateMany(keys, updater);
    const current = Object.fromEntries(await Promise.all(keys.map(async key => [key, await store.get(key)])));
    const changes = updater(current);
    await Promise.all(Object.entries(changes).map(([key, value]) =>
      value === null ? store.remove(key) : value === undefined ? Promise.resolve() : store.set(key, value)));
    return changes;
  }

  async function updateValue(key, updater) {
    const changes = await updateMany([key], current => ({[key]: updater(current[key])}));
    return Object.hasOwn(changes, key) ? changes[key] : store.get(key);
  }

  async function parseResponseError(response, payload) {
    const errorValue = payload?.error;
    const message = errorValue && typeof errorValue === "object"
      ? errorValue.message
      : payload?.error_description || errorValue;
    const details = {...(payload && typeof payload === "object" ? payload : {})};
    if (response.status === 429) {
      const retryAfter = Number(response.headers?.get("Retry-After") || 0);
      if (retryAfter > 0) {
        details.retry_after = retryAfter;
        details.reason = errorValue?.reason || null;
        await store.set("spotify_rate_limit", {until: now() + retryAfter * 1000, reason: details.reason});
      }
    }
    return spotifyError(String(message || "La operación no pudo completarse."), response.status, details);
  }

  async function tokenRequest(fields) {
    const response = await fetchImpl(`${ACCOUNTS_BASE}/api/token`, {
      method: "POST",
      headers: {"Content-Type": "application/x-www-form-urlencoded"},
      body: new URLSearchParams(fields),
    });
    const payload = await readJson(response);
    if (!response.ok) throw await parseResponseError(response, payload);
    return payload;
  }

  async function refreshAccessToken() {
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      const [token, clientId] = await Promise.all([
        store.get(BROWSER_STORAGE_KEYS.token),
        store.get(BROWSER_STORAGE_KEYS.clientId),
      ]);
      if (!token?.refresh_token || !clientId) {
        throw spotifyError("La sesión de Spotify expiró. Vuelve a conectar tu cuenta.", 401);
      }
      let refreshed;
      try {
        refreshed = await tokenRequest({
          grant_type: "refresh_token",
          refresh_token: token.refresh_token,
          client_id: clientId,
        });
      } catch (error) {
        if (error.details?.error === "invalid_grant") {
          await store.remove(BROWSER_STORAGE_KEYS.token);
          await store.remove(BROWSER_STORAGE_KEYS.profile);
          throw spotifyError("La sesión de Spotify expiró. Vuelve a conectar tu cuenta.", 401);
        }
        throw error;
      }
      const updated = {
        ...token,
        ...refreshed,
        refresh_token: refreshed.refresh_token || token.refresh_token,
        expires_at: now() + Number(refreshed.expires_in || 3600) * 1000 - 60_000,
      };
      await store.set(BROWSER_STORAGE_KEYS.token, updated);
      return updated.access_token;
    })().finally(() => {
      refreshPromise = null;
    });
    return refreshPromise;
  }

  async function accessToken(forceRefresh = false) {
    const token = await store.get(BROWSER_STORAGE_KEYS.token);
    if (!token?.access_token) throw spotifyError("Conecta tu cuenta de Spotify primero.", 401);
    if (forceRefresh || Number(token.expires_at || 0) <= now() + 30_000) return refreshAccessToken();
    return token.access_token;
  }

  async function spotifyRequest(method, path, {query = {}, body = undefined, retryUnauthorized = true} = {}) {
    const url = new URL(`${API_BASE}${path}`);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
    const token = await accessToken();
    const options = {
      method,
      headers: {Authorization: `Bearer ${token}`},
    };
    if (body !== undefined) {
      options.headers["Content-Type"] = "application/json";
      options.body = JSON.stringify(body);
    }
    let response;
    try {
      response = await fetchImpl(url, options);
    } catch (error) {
      throw spotifyError(`No se pudo conectar con Spotify: ${error.message || error}`, 503);
    }
    if (response.status === 401 && retryUnauthorized) {
      const refreshedToken = await accessToken(true);
      response = await fetchImpl(url, {...options, headers: {...options.headers, Authorization: `Bearer ${refreshedToken}`}});
    }
    const payload = await readJson(response);
    if (!response.ok) throw await parseResponseError(response, payload);
    return payload;
  }

  async function refreshProfile() {
    const profile = await spotifyRequest("GET", "/me");
    if (!profile?.id) throw new Error("Spotify no devolvió el perfil de la cuenta.");
    await store.set(BROWSER_STORAGE_KEYS.profile, profile);
    return profile;
  }

  async function ensureProfile() {
    const cached = await store.get(BROWSER_STORAGE_KEYS.profile);
    if (cached?.id) return cached;
    if (!profilePromise) {
      profilePromise = refreshProfile().finally(() => {
        profilePromise = null;
      });
    }
    return profilePromise;
  }

  async function beginLogin() {
    const clientId = await store.get(BROWSER_STORAGE_KEYS.clientId);
    if (!clientId) throw new Error("Guarda tu Client ID de Spotify antes de conectar la cuenta.");
    const verifierBytes = cryptoImpl.getRandomValues(new Uint8Array(64));
    const stateBytes = cryptoImpl.getRandomValues(new Uint8Array(32));
    const verifier = base64Url(verifierBytes);
    const state = base64Url(stateBytes);
    const challengeDigest = await cryptoImpl.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
    const challenge = base64Url(new Uint8Array(challengeDigest));
    sessionStorage.setItem(OAUTH_SESSION_KEY, JSON.stringify({state, verifier, client_id: clientId}));
    const authorize = new URL(`${ACCOUNTS_BASE}/authorize`);
    authorize.search = new URLSearchParams({
      client_id: clientId,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: SCOPES,
      state,
      code_challenge_method: "S256",
      code_challenge: challenge,
    });
    location.assign(authorize.toString());
  }

  async function completeOAuthCallback() {
    const params = new URLSearchParams(location.search || "");
    const code = params.get("code");
    const state = params.get("state");
    const oauthError = params.get("error");
    if (!code && !state && !oauthError) return false;
    history.replaceState(null, "", location.pathname || "/");

    let pending;
    try {
      pending = JSON.parse(sessionStorage.getItem(OAUTH_SESSION_KEY) || "null");
    } catch {
      pending = null;
    }
    sessionStorage.removeItem(OAUTH_SESSION_KEY);
    if (oauthError) throw new Error(`Spotify rechazó la autorización: ${oauthError}`);
    const currentClientId = await store.get(BROWSER_STORAGE_KEYS.clientId);
    if (!pending || !code || !state || state !== pending.state || pending.client_id !== currentClientId) {
      throw new Error("La respuesta de autorización no es válida. Inicia la conexión otra vez.");
    }

    const token = await tokenRequest({
      client_id: currentClientId,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: pending.verifier,
    });
    if (!token.access_token) throw new Error("Spotify no devolvió un token de acceso.");
    await store.set(BROWSER_STORAGE_KEYS.token, {
      ...token,
      expires_at: now() + Number(token.expires_in || 3600) * 1000 - 60_000,
    });
    await store.remove(BROWSER_STORAGE_KEYS.profile);
    await refreshProfile();
    return true;
  }

  async function rateLimitStatus() {
    const stored = await store.get("spotify_rate_limit");
    const retryAfter = Math.max(0, Math.ceil((Number(stored?.until || 0) - now()) / 1000));
    if (!retryAfter) {
      if (stored) await store.remove("spotify_rate_limit");
      return {active: false, retry_after: 0, reason: null};
    }
    return {active: true, retry_after: retryAfter, reason: stored.reason || null};
  }

  function scanView(result) {
    if (!result) return null;
    const dedupeState = result._dedupe_state || {removed_track_ids: [], keepers: {}};
    const removedIds = new Set((dedupeState.removed_track_ids || []).map(String));
    const keeperChoices = dedupeState.keepers || {};
    const groups = [];
    for (const sourceGroup of result.groups || []) {
      const tracks = [sourceGroup.keeper, ...(sourceGroup.remove || [])];
      const remaining = tracks.filter(track => !removedIds.has(String(track.id)));
      if (remaining.length < 2) continue;
      const preferred = String(keeperChoices[sourceGroup.id] || sourceGroup.keeper.id);
      const keeper = remaining.find(track => String(track.id) === preferred) || remaining[0];
      groups.push({...sourceGroup, keeper, remove: remaining.filter(track => track.id !== keeper.id)});
    }
    const counts = Object.fromEntries(["safe", "probable", "version"].map(kind => [
      kind,
      groups.filter(group => group.kind === kind).reduce((count, group) => count + group.remove.length, 0),
    ]));
    const summary = {
      ...(result.summary || {}),
      safe: groups.filter(group => group.kind === "safe").length,
      probable: groups.filter(group => group.kind === "probable").length,
      version: groups.filter(group => group.kind === "version").length,
      removable_safe: counts.safe,
      removable_probable: counts.probable,
      removable_version: counts.version,
      total_groups: groups.length,
      total_removable: counts.safe + counts.probable + counts.version,
    };
    const view = Object.fromEntries(Object.entries(result).filter(([key]) =>
      !["_dedupe_state", "_updated_at", "groups", "summary"].includes(key)));
    return {
      ...view,
      total_tracks: Math.max(0, Number(result.total_tracks || 0) - removedIds.size),
      groups,
      summary,
      scan_id: result.scan_id,
      created_at: result.created_at,
      ...(result._updated_at ? {updated_at: result._updated_at} : {}),
    };
  }

  function scanJobView(job) {
    if (!job) return {status: "idle"};
    const view = {};
    for (const key of ["status", "started_at", "finished_at", "scan_id", "error", "tracks_processed"]) {
      if (job[key] !== undefined) view[key] = job[key];
    }
    return view;
  }

  async function ensureScanJob(profile) {
    return userKey(profile.id, "scan_job");
  }

  function compactSavedTrack(saved) {
    const track = saved?.track || {};
    const album = track.album || {};
    return {
      added_at: saved?.added_at || "",
      track: {
        id: track.id,
        uri: track.uri,
        name: track.name,
        artists: (track.artists || []).map(artist => ({name: artist?.name || ""})),
        album: {
          name: album.name,
          album_type: album.album_type,
          release_date: album.release_date,
        },
        duration_ms: track.duration_ms,
        explicit: track.explicit,
        external_ids: {isrc: track.external_ids?.isrc},
        is_playable: track.is_playable,
      },
    };
  }

  async function startScan() {
    const profile = await ensureProfile();
    const key = await ensureScanJob(profile);
    const current = await store.get(key);
    if (["running", "cancelling"].includes(current?.status)) return scanJobView(current);
    const job = {
      id: cryptoImpl.randomUUID?.() || base64Url(cryptoImpl.getRandomValues(new Uint8Array(16))),
      status: "running",
      started_at: new Date(now()).toISOString(),
      offset: 0,
      tracks_processed: 0,
      items: [],
    };
    await store.set(key, job);
    return scanJobView(job);
  }

  async function cancelScan() {
    const profile = await ensureProfile();
    const key = await ensureScanJob(profile);
    let result = {status: "idle"};
    await updateMany([key], current => {
      const job = current[key];
      if (!job) return {};
      if (job.status === "running" || job.status === "cancelling") {
        const cancelled = {
          ...job,
          status: "cancelled",
          finished_at: new Date(now()).toISOString(),
          items: [],
        };
        result = scanJobView(cancelled);
        return {[key]: cancelled};
      }
      result = scanJobView(job);
      return {};
    });
    return result;
  }

  async function advanceScan() {
    const profile = await ensureProfile();
    const jobKey = await ensureScanJob(profile);
    let job = await store.get(jobKey);
    if (!job) return {status: "idle"};
    if (job.status !== "running") return scanJobView(job);
    const offset = Number(job.offset || 0);
    const jobId = job.id;
    try {
      const page = await spotifyRequest("GET", "/me/tracks", {query: {limit: 50, offset}});
      const latest = await store.get(jobKey);
      if (latest?.id !== jobId || latest.status !== "running" || Number(latest.offset || 0) !== offset) {
        return scanJobView(latest);
      }
      const batch = (page.items || []).map(compactSavedTrack);
      const items = [...(latest.items || []), ...batch];
      const hasMore = Boolean(page.next) && batch.length > 0;
      if (hasMore) {
        job = {...latest, offset: offset + batch.length, tracks_processed: items.length, items};
        await updateMany([jobKey], current => {
          const currentJob = current[jobKey];
          if (currentJob?.id !== jobId || currentJob.status !== "running" || Number(currentJob.offset || 0) !== offset) return {};
          return {[jobKey]: job};
        });
        return scanJobView(await store.get(jobKey));
      }

      const result = await detectDuplicates(items, cryptoImpl);
      const sequenceKey = userKey(profile.id, "scan_sequence");
      const scanId = await updateValue(sequenceKey, value => Number(value || 0) + 1);
      const createdAt = new Date(now()).toISOString();
      const scan = {
        ...result,
        scan_id: scanId,
        created_at: createdAt,
        _dedupe_state: {removed_track_ids: [], keepers: {}},
      };
      const completed = {
        ...latest,
        status: "completed",
        finished_at: createdAt,
        scan_id: scanId,
        tracks_processed: items.length,
        items: [],
      };
      const changes = await updateMany([
        jobKey,
        userKey(profile.id, "latest_scan"),
      ], current => {
        const currentJob = current[jobKey];
        if (currentJob?.id !== jobId || currentJob.status !== "running" || Number(currentJob.offset || 0) !== offset) return {};
        return {
          [jobKey]: completed,
          [userKey(profile.id, "latest_scan")]: scan,
        };
      });
      if (!Object.hasOwn(changes, jobKey)) return scanJobView(await store.get(jobKey));
      return scanJobView(completed);
    } catch (error) {
      const failedAt = new Date(now()).toISOString();
      await updateMany([jobKey], current => {
        const currentJob = current[jobKey];
        if (currentJob?.id !== jobId || currentJob.status !== "running") return {};
        return {[jobKey]: {
          ...currentJob,
          status: "failed",
          finished_at: failedAt,
          error: error.message,
          items: [],
        }};
      });
      throw error;
    }
  }

  async function actionHistory(profile) {
    const history = await store.get(userKey(profile.id, "history"));
    return Array.isArray(history) ? history : [];
  }

  async function nextActionId(profile) {
    return updateValue(userKey(profile.id, "action_sequence"), value => Number(value || 0) + 1);
  }

  async function createBackupPlaylist(uris) {
    const stamp = new Intl.DateTimeFormat("sv-SE", {dateStyle: "short", timeStyle: "short"})
      .format(new Date(now())).replace(/[/:]/g, "-");
    const playlist = await spotifyRequest("POST", "/me/playlists", {
      body: {
        name: `Dedupe Guard · Respaldo ${stamp}`,
        public: false,
        description: "Respaldo creado por Spotify Dedupe Guard antes de retirar duplicados.",
      },
    });
    if (!playlist?.id) throw new Error("Spotify no devolvió la playlist de respaldo.");
    for (let index = 0; index < uris.length; index += 100) {
      await spotifyRequest("POST", `/playlists/${encodeURIComponent(playlist.id)}/items`, {
        body: {uris: uris.slice(index, index + 100)},
      });
    }
    return playlist;
  }

  async function changeLibrary(method, uris) {
    for (let index = 0; index < uris.length; index += 40) {
      await spotifyRequest(method, "/me/library", {query: {uris: uris.slice(index, index + 40).join(",")}});
    }
  }

  async function removeTracks(payload) {
    if (payload.create_backup !== true && payload.create_backup !== false) {
      throw new Error("La opción de respaldo no es válida.");
    }
    const profile = await ensureProfile();
    const latestKey = userKey(profile.id, "latest_scan");
    const record = await store.get(latestKey);
    const view = scanView(record);
    if (!view || String(view.scan_id) !== String(payload.scan_id)) {
      throw new Error("La auditoría ya no está disponible. Ejecuta una nueva.");
    }
    if (!Array.isArray(payload.track_ids)) throw new Error("La selección de canciones no es válida.");
    const selectedIds = [...new Set(payload.track_ids.map(String))];
    if (!selectedIds.length) throw new Error("Selecciona al menos una canción para retirar.");
    const keeperChoices = payload.keepers || {};
    if (!keeperChoices || typeof keeperChoices !== "object" || Array.isArray(keeperChoices)) {
      throw new Error("La selección de copias a conservar no es válida.");
    }
    const allowed = new Map();
    const keepers = new Set();
    for (const group of view.groups) {
      const groupTracks = [group.keeper, ...(group.remove || [])];
      const groupIds = new Set(groupTracks.map(track => String(track.id)));
      const keeperId = String(keeperChoices[group.id] || group.keeper.id);
      if (!groupIds.has(keeperId)) throw new Error("Una de las copias elegidas para conservar no pertenece a su grupo.");
      keepers.add(keeperId);
      for (const track of groupTracks) {
        if (String(track.id) !== keeperId) allowed.set(String(track.id), {...track, group_id: group.id, kind: group.kind});
      }
    }
    if (selectedIds.some(id => !allowed.has(id) || keepers.has(id))) {
      throw new Error("La selección contiene una canción que no puede retirarse.");
    }
    const tracks = selectedIds.map(id => allowed.get(id));
    const uris = tracks.map(track => track.uri);
    const backup = payload.create_backup ? await createBackupPlaylist(uris) : null;
    await changeLibrary("DELETE", uris);

    const current = await store.get(latestKey);
    if (!current || String(current.scan_id) !== String(payload.scan_id)) {
      throw new Error("Spotify retiró las canciones, pero la auditoría cambió antes de guardar el historial local.");
    }
    const currentState = current._dedupe_state || {removed_track_ids: [], keepers: {}};
    const alreadyRemoved = new Set((currentState.removed_track_ids || []).map(String));
    if (selectedIds.some(id => alreadyRemoved.has(id))) {
      throw new Error("Algunas canciones ya fueron retiradas. Actualiza los resultados.");
    }
    const actionId = await nextActionId(profile);
    const createdAt = new Date(now()).toISOString();
    const updatedRecord = {
      ...current,
      _dedupe_state: {
        removed_track_ids: [...alreadyRemoved, ...selectedIds].sort(),
        keepers: {...(currentState.keepers || {}), ...keeperChoices},
      },
      _updated_at: createdAt,
    };
    const action = {
      id: actionId,
      action: "remove",
      created_at: createdAt,
      count: tracks.length,
      tracks,
      scan_id: current.scan_id,
      created_backup: Boolean(backup),
      backup_playlist: backup?.external_urls?.spotify || null,
      can_undo: true,
    };
    const historyKey = userKey(profile.id, "history");
    const changes = await updateMany([latestKey, historyKey], values => {
      const latest = values[latestKey];
      if (!latest || String(latest.scan_id) !== String(payload.scan_id)) return {};
      return {
        [latestKey]: updatedRecord,
        [historyKey]: [action, ...(Array.isArray(values[historyKey]) ? values[historyKey] : [])].slice(0, 100),
      };
    });
    if (!Object.hasOwn(changes, latestKey)) {
      throw new Error("Spotify retiró las canciones, pero la auditoría cambió antes de guardar el historial local.");
    }
    return {
      ok: true,
      action_id: actionId,
      removed: tracks.length,
      created_backup: Boolean(backup),
      backup_playlist: backup?.external_urls?.spotify || null,
      scan: scanView(updatedRecord),
    };
  }

  async function undoAction(payload) {
    const profile = await ensureProfile();
    const historyKey = userKey(profile.id, "history");
    const history = await actionHistory(profile);
    const actionId = Number(payload.action_id);
    const action = history.find(item => item.id === actionId && item.action === "remove");
    const alreadyUndone = history.some(item => item.action === "undo" && item.related_action_id === actionId);
    if (!action || alreadyUndone || !action.can_undo) {
      throw new Error("No se encontró una limpieza que pueda deshacerse.");
    }
    const tracks = action.tracks || [];
    await changeLibrary("PUT", tracks.map(track => track.uri));
    const latestKey = userKey(profile.id, "latest_scan");
    const undoId = await nextActionId(profile);
    const createdAt = new Date(now()).toISOString();
    const undo = {
      id: undoId,
      action: "undo",
      related_action_id: actionId,
      created_at: createdAt,
      count: tracks.length,
      tracks,
      scan_id: action.scan_id,
      can_undo: false,
    };
    const changes = await updateMany([historyKey, latestKey], values => {
      const currentHistory = values[historyKey];
      if (!Array.isArray(currentHistory) || !currentHistory.some(item => item.id === actionId && item.can_undo)) return {};
      const currentRecord = values[latestKey];
      let latestValue;
      if (currentRecord && String(currentRecord.scan_id) === String(action.scan_id)) {
        const currentDedupeState = currentRecord._dedupe_state || {removed_track_ids: [], keepers: {}};
        const restoredIds = new Set(tracks.map(track => String(track.id)));
        latestValue = {
          ...currentRecord,
          _dedupe_state: {
            ...currentDedupeState,
            removed_track_ids: (currentDedupeState.removed_track_ids || []).filter(id => !restoredIds.has(String(id))),
          },
          _updated_at: createdAt,
        };
      }
      return {
        [historyKey]: [
          undo,
          ...currentHistory.map(item => item.id === actionId ? {...item, can_undo: false} : item),
        ].slice(0, 100),
        ...(latestValue === undefined ? {} : {[latestKey]: latestValue}),
      };
    });
    if (!Object.hasOwn(changes, historyKey)) {
      throw new Error("Las canciones se restauraron, pero el historial local cambió durante la operación.");
    }
    const savedLatest = changes[latestKey] ?? await store.get(latestKey);
    return {
      ok: true,
      action_id: undoId,
      restored: tracks.length,
      scan: savedLatest && String(savedLatest.scan_id) === String(action.scan_id) ? scanView(savedLatest) : null,
    };
  }

  async function api(path, options = {}) {
    const method = String(options.method || "GET").toUpperCase();
    let payload = {};
    if (options.body) {
      try {
        payload = typeof options.body === "string" ? JSON.parse(options.body) : options.body;
      } catch {
        throw new Error("La solicitud no contiene JSON válido.");
      }
    }

    if (path === "/api/status" && method === "GET") {
      const [clientId, token, profile, rateLimit] = await Promise.all([
        store.get(BROWSER_STORAGE_KEYS.clientId),
        store.get(BROWSER_STORAGE_KEYS.token),
        store.get(BROWSER_STORAGE_KEYS.profile),
        rateLimitStatus(),
      ]);
      return {
        configured: Boolean(clientId),
        authenticated: Boolean(token?.access_token),
        private_deployment: false,
        profile: profile || null,
        profile_refreshing: false,
        redirect_uri: redirectUri,
        rate_limit: rateLimit,
      };
    }
    if (path === "/api/config" && method === "POST") {
      const clientId = String(payload.client_id || "").trim();
      if (!clientId) {
        await Promise.all([
          store.remove(BROWSER_STORAGE_KEYS.clientId),
          store.remove(BROWSER_STORAGE_KEYS.token),
          store.remove(BROWSER_STORAGE_KEYS.profile),
        ]);
        return {ok: true, redirect_uri: redirectUri};
      }
      if (!/^[A-Za-z0-9]{16,64}$/.test(clientId)) throw new Error("Revisa el Client ID de Spotify.");
      const previous = await store.get(BROWSER_STORAGE_KEYS.clientId);
      if (previous !== clientId) {
        await store.remove(BROWSER_STORAGE_KEYS.token);
        await store.remove(BROWSER_STORAGE_KEYS.profile);
      }
      await store.set(BROWSER_STORAGE_KEYS.clientId, clientId);
      return {ok: true, redirect_uri: redirectUri};
    }
    if (path === "/api/profile/refresh" && method === "POST") {
      return {profile: await refreshProfile(), profile_refreshing: false};
    }
    if (path === "/api/disconnect" && method === "POST") {
      await Promise.all([store.remove(BROWSER_STORAGE_KEYS.token), store.remove(BROWSER_STORAGE_KEYS.profile)]);
      return {ok: true};
    }
    if (path === "/api/scan/latest" && method === "GET") {
      const profile = await ensureProfile();
      const record = await store.get(userKey(profile.id, "latest_scan"));
      return {scan: scanView(record)};
    }
    if (path === "/api/history" && method === "GET") {
      const profile = await ensureProfile();
      return {history: await actionHistory(profile)};
    }
    if (path === "/api/scan" && method === "POST") return startScan();
    if (path === "/api/scan/status" && method === "GET") return advanceScan();
    if (path === "/api/scan/cancel" && method === "POST") return cancelScan();
    if (path === "/api/remove" && method === "POST") {
      if (options.headers?.["X-Dedupe-Intent"] !== "confirmed") throw new Error("Falta la confirmación explícita de la operación.");
      return removeTracks(payload);
    }
    if (path === "/api/undo" && method === "POST") {
      if (options.headers?.["X-Dedupe-Intent"] !== "confirmed") throw new Error("Falta la confirmación explícita de la operación.");
      return undoAction(payload);
    }
    throw spotifyError("Ruta no encontrada.", 404);
  }

  return {api, beginLogin, completeOAuthCallback, redirectUri};
}
