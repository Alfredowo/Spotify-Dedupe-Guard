import assert from "node:assert/strict";
import test from "node:test";
import {webcrypto} from "node:crypto";

import {BROWSER_STORAGE_KEYS, createBrowserClient} from "../static/browser-client.mjs";

class MemoryStore {
  values = new Map();

  async get(key) {
    return this.values.get(key) ?? null;
  }

  async set(key, value) {
    this.values.set(key, structuredClone(value));
  }

  async remove(key) {
    this.values.delete(key);
  }
}

class MemorySessionStorage {
  values = new Map();

  getItem(key) {
    return this.values.get(key) ?? null;
  }

  setItem(key, value) {
    this.values.set(key, String(value));
  }

  removeItem(key) {
    this.values.delete(key);
  }
}

const clientId = "spotifyclientid123456";
const profile = {id: "user-1", display_name: "Alfredo", images: []};

function clientOptions(overrides = {}) {
  return {
    store: new MemoryStore(),
    sessionStorage: new MemorySessionStorage(),
    cryptoImpl: webcrypto,
    fetchImpl: async () => new Response("{}", {status: 200}),
    location: {origin: "https://dedupe.example", pathname: "/", search: "", assign() {}},
    history: {replaceState() {}},
    now: () => 1_800_000_000_000,
    ...overrides,
  };
}

function savedTrack(id, isrc) {
  return {
    added_at: "2020-01-01T00:00:00Z",
    track: {
      id,
      uri: `spotify:track:${id}`,
      name: "Song",
      artists: [{name: "Artist"}],
      album: {name: "Album", album_type: "album", release_date: "2020"},
      duration_ms: 180_000,
      explicit: false,
      external_ids: {isrc},
      is_playable: true,
    },
  };
}

test("stores the Client ID in browser storage and uses the root redirect URI", async () => {
  const store = new MemoryStore();
  const client = createBrowserClient(clientOptions({store}));

  const result = await client.api("/api/config", {
    method: "POST",
    body: JSON.stringify({client_id: clientId}),
  });

  assert.equal(result.ok, true);
  assert.equal(result.redirect_uri, "https://dedupe.example/");
  assert.equal(await store.get(BROWSER_STORAGE_KEYS.clientId), clientId);
});

test("starts PKCE authorization without a client secret", async () => {
  const store = new MemoryStore();
  await store.set(BROWSER_STORAGE_KEYS.clientId, clientId);
  const sessionStorage = new MemorySessionStorage();
  let assignedUrl = "";
  const client = createBrowserClient(clientOptions({
    store,
    sessionStorage,
    location: {
      origin: "https://dedupe.example",
      pathname: "/",
      search: "",
      assign(url) { assignedUrl = url; },
    },
  }));

  await client.beginLogin();

  const authUrl = new URL(assignedUrl);
  assert.equal(authUrl.origin, "https://accounts.spotify.com");
  assert.equal(authUrl.pathname, "/authorize");
  assert.equal(authUrl.searchParams.get("client_id"), clientId);
  assert.equal(authUrl.searchParams.get("redirect_uri"), "https://dedupe.example/");
  assert.equal(authUrl.searchParams.get("response_type"), "code");
  assert.equal(authUrl.searchParams.get("code_challenge_method"), "S256");
  assert.ok(authUrl.searchParams.get("code_challenge"));
  assert.equal(authUrl.searchParams.has("code_verifier"), false);
  assert.equal(authUrl.searchParams.has("client_secret"), false);
  assert.ok(sessionStorage.getItem("spotify-dedupe-oauth"));
});

test("rejects an OAuth callback whose state does not match", async () => {
  const store = new MemoryStore();
  await store.set(BROWSER_STORAGE_KEYS.clientId, clientId);
  const sessionStorage = new MemorySessionStorage();
  sessionStorage.setItem("spotify-dedupe-oauth", JSON.stringify({
    state: "expected-state",
    verifier: "verifier",
    client_id: clientId,
  }));
  let fetchCount = 0;
  const client = createBrowserClient(clientOptions({
    store,
    sessionStorage,
    location: {origin: "https://dedupe.example", pathname: "/", search: "?code=code&state=wrong", assign() {}},
    fetchImpl: async () => { fetchCount += 1; return new Response("{}", {status: 200}); },
  }));

  await assert.rejects(client.completeOAuthCallback(), /autorización no es válida/i);
  assert.equal(fetchCount, 0);
  assert.equal(await store.get(BROWSER_STORAGE_KEYS.token), null);
});

test("exchanges a valid PKCE callback and stores the token and Spotify profile locally", async () => {
  const store = new MemoryStore();
  await store.set(BROWSER_STORAGE_KEYS.clientId, clientId);
  const sessionStorage = new MemorySessionStorage();
  sessionStorage.setItem("spotify-dedupe-oauth", JSON.stringify({
    state: "valid-state",
    verifier: "pkce-verifier",
    client_id: clientId,
  }));
  const historyCalls = [];
  const requests = [];
  const client = createBrowserClient(clientOptions({
    store,
    sessionStorage,
    location: {origin: "https://dedupe.example", pathname: "/", search: "?code=auth-code&state=valid-state", assign() {}},
    history: {replaceState(...args) { historyCalls.push(args); }},
    fetchImpl: async (url, options = {}) => {
      requests.push({url: String(url), options});
      if (String(url).includes("accounts.spotify.com/api/token")) {
        return Response.json({access_token: "access", refresh_token: "refresh", expires_in: 3600});
      }
      if (String(url).endsWith("/v1/me")) return Response.json(profile);
      throw new Error(`Unexpected URL: ${url}`);
    },
  }));

  assert.equal(await client.completeOAuthCallback(), true);

  const token = await store.get(BROWSER_STORAGE_KEYS.token);
  assert.equal(token.access_token, "access");
  assert.equal(token.refresh_token, "refresh");
  assert.deepEqual(await store.get(BROWSER_STORAGE_KEYS.profile), profile);
  assert.equal(sessionStorage.getItem("spotify-dedupe-oauth"), null);
  assert.equal(historyCalls.length, 1);
  assert.deepEqual(historyCalls[0], [null, "", "/"]);
  assert.equal(requests.length, 2);
  assert.match(requests[0].options.body.toString(), /code_verifier=pkce-verifier/);
  assert.doesNotMatch(requests[0].options.body.toString(), /client_secret/);
});

test("refreshes an expired token through PKCE and keeps an unchanged refresh token", async () => {
  const store = new MemoryStore();
  await store.set(BROWSER_STORAGE_KEYS.clientId, clientId);
  await store.set(BROWSER_STORAGE_KEYS.token, {
    access_token: "expired-access",
    refresh_token: "long-lived-refresh",
    expires_at: 0,
  });
  const requests = [];
  const client = createBrowserClient(clientOptions({
    store,
    fetchImpl: async (url, options = {}) => {
      requests.push({url: String(url), options});
      if (String(url).includes("accounts.spotify.com/api/token")) {
        return Response.json({access_token: "new-access", expires_in: 3600});
      }
      if (String(url).endsWith("/v1/me")) return Response.json(profile);
      throw new Error(`Unexpected URL: ${url}`);
    },
  }));

  const result = await client.api("/api/profile/refresh", {method: "POST", body: "{}"});

  assert.deepEqual(result.profile, profile);
  assert.equal(requests[0].options.body.get("grant_type"), "refresh_token");
  assert.equal(requests[0].options.body.get("refresh_token"), "long-lived-refresh");
  assert.equal(requests[0].options.body.get("client_id"), clientId);
  assert.equal(requests[0].options.body.has("client_secret"), false);
  const token = await store.get(BROWSER_STORAGE_KEYS.token);
  assert.equal(token.access_token, "new-access");
  assert.equal(token.refresh_token, "long-lived-refresh");
});

test("a cancelled browser scan discards partial pages and keeps the previous scan", async () => {
  const store = new MemoryStore();
  await store.set(BROWSER_STORAGE_KEYS.clientId, clientId);
  await store.set(BROWSER_STORAGE_KEYS.token, {access_token: "access", expires_at: 1_900_000_000_000});
  await store.set(BROWSER_STORAGE_KEYS.profile, profile);
  const previousScan = {
    scan_id: 7,
    total_tracks: 0,
    groups: [],
    summary: {safe: 0, probable: 0, version: 0, total_groups: 0},
  };
  await store.set("user:user-1:latest_scan", previousScan);
  const client = createBrowserClient(clientOptions({
    store,
    fetchImpl: async url => {
      if (String(url).includes("/me/tracks")) {
        return Response.json({items: [savedTrack("partial", "ISRC-PARTIAL")], next: "next-page"});
      }
      throw new Error(`Unexpected URL: ${url}`);
    },
  }));

  await client.api("/api/scan", {method: "POST", body: "{}"});
  const partial = await client.api("/api/scan/status");
  assert.equal(partial.status, "running");
  assert.equal(partial.tracks_processed, 1);

  const cancelled = await client.api("/api/scan/cancel", {method: "POST", body: "{}"});
  assert.equal(cancelled.status, "cancelled");
  assert.equal((await client.api("/api/scan/status")).status, "cancelled");
  assert.equal((await client.api("/api/scan/latest")).scan.scan_id, 7);
});

test("a completed browser scan stores duplicate results locally", async () => {
  const store = new MemoryStore();
  await store.set(BROWSER_STORAGE_KEYS.clientId, clientId);
  await store.set(BROWSER_STORAGE_KEYS.token, {access_token: "access", expires_at: 1_900_000_000_000});
  await store.set(BROWSER_STORAGE_KEYS.profile, profile);
  let trackPage = 0;
  const client = createBrowserClient(clientOptions({
    store,
    fetchImpl: async url => {
      if (!String(url).includes("/me/tracks")) throw new Error(`Unexpected URL: ${url}`);
      trackPage += 1;
      return trackPage === 1
        ? Response.json({items: [savedTrack("first", "ISRC-SAME")], next: "next-page"})
        : Response.json({items: [savedTrack("second", "ISRC-SAME")], next: null});
    },
  }));

  await client.api("/api/scan", {method: "POST", body: "{}"});
  assert.equal((await client.api("/api/scan/status")).status, "running");
  const completed = await client.api("/api/scan/status");
  assert.equal(completed.status, "completed");

  const scan = (await client.api("/api/scan/latest")).scan;
  assert.equal(scan.total_tracks, 2);
  assert.equal(scan.summary.safe, 1);
  assert.deepEqual(scan.groups[0].remove.map(track => track.id), ["second"]);
});

test("backs up and removes selected tracks, then restores them from local history", async () => {
  const store = new MemoryStore();
  await store.set(BROWSER_STORAGE_KEYS.clientId, clientId);
  await store.set(BROWSER_STORAGE_KEYS.token, {access_token: "access", expires_at: 1_900_000_000_000});
  await store.set(BROWSER_STORAGE_KEYS.profile, profile);
  const keeper = {id: "keeper", uri: "spotify:track:keeper", name: "Song", artists: ["Artist"]};
  const duplicate = {id: "duplicate", uri: "spotify:track:duplicate", name: "Song", artists: ["Artist"]};
  await store.set("user:user-1:latest_scan", {
    scan_id: 3,
    created_at: "2026-10-10T00:00:00.000Z",
    total_tracks: 2,
    groups: [{
      id: "group-1",
      kind: "safe",
      confidence: 1,
      reason: "Mismo ISRC",
      keeper_reason: "Se conserva el álbum.",
      keeper,
      remove: [duplicate],
    }],
    summary: {safe: 1, probable: 0, version: 0, total_groups: 1},
    _dedupe_state: {removed_track_ids: [], keepers: {}},
  });
  const requests = [];
  const client = createBrowserClient(clientOptions({
    store,
    fetchImpl: async (url, options = {}) => {
      requests.push({url: String(url), options});
      if (String(url).endsWith("/v1/me/playlists")) {
        return Response.json({id: "backup-id", external_urls: {spotify: "https://open.spotify.com/playlist/backup-id"}});
      }
      if (String(url).endsWith("/v1/playlists/backup-id/items")) return Response.json({snapshot_id: "snapshot"});
      if (String(url).startsWith("https://api.spotify.com/v1/me/library?uris=")) return new Response(null, {status: 200});
      throw new Error(`Unexpected URL: ${url}`);
    },
  }));

  const removed = await client.api("/api/remove", {
    method: "POST",
    headers: {"X-Dedupe-Intent": "confirmed"},
    body: JSON.stringify({
      scan_id: 3,
      track_ids: ["duplicate"],
      keepers: {"group-1": "keeper"},
      create_backup: true,
    }),
  });
  assert.equal(removed.removed, 1);
  assert.equal(removed.created_backup, true);
  assert.equal(removed.scan.groups.length, 0);
  assert.equal(requests[2].options.method, "DELETE");
  assert.equal(requests[0].options.method, "POST");
  assert.deepEqual(JSON.parse(requests[1].options.body).uris, ["spotify:track:duplicate"]);

  const restored = await client.api("/api/undo", {
    method: "POST",
    headers: {"X-Dedupe-Intent": "confirmed"},
    body: JSON.stringify({action_id: removed.action_id}),
  });
  assert.equal(restored.restored, 1);
  assert.equal(restored.scan.groups[0].remove[0].id, "duplicate");
  assert.equal(requests[3].options.method, "PUT");
  const history = (await client.api("/api/history")).history;
  assert.deepEqual(history.map(item => item.action), ["undo", "remove"]);
  assert.equal(history[1].can_undo, false);
});
