from __future__ import annotations

import base64
import ctypes
import ctypes.wintypes
import hashlib
import json
import math
import os
import secrets
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Iterator


ACCOUNTS_BASE = "https://accounts.spotify.com"
API_BASE = "https://api.spotify.com/v1"
SCOPES = "user-read-private user-library-read user-library-modify playlist-modify-private"


class SpotifyError(RuntimeError):
    def __init__(self, message: str, status: int = 500, payload: Any = None):
        super().__init__(message)
        self.status = status
        self.payload = payload


class RateLimitState:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._blocked_until = 0.0
        self._reason: str | None = None

    def block_for(self, seconds: int, reason: str | None = None) -> None:
        with self._lock:
            blocked_until = time.monotonic() + max(1, seconds)
            if blocked_until >= self._blocked_until:
                self._blocked_until = blocked_until
                self._reason = reason

    def remaining(self) -> int:
        with self._lock:
            return max(0, math.ceil(self._blocked_until - time.monotonic()))

    def status(self) -> dict[str, Any]:
        with self._lock:
            remaining = max(0, math.ceil(self._blocked_until - time.monotonic()))
            return {"active": remaining > 0, "retry_after": remaining, "reason": self._reason if remaining else None}

    def clear(self) -> None:
        with self._lock:
            self._blocked_until = 0.0
            self._reason = None


RATE_LIMIT_STATE = RateLimitState()


def rate_limit_remaining() -> int:
    return RATE_LIMIT_STATE.remaining()


def rate_limit_status() -> dict[str, Any]:
    return RATE_LIMIT_STATE.status()


class _DataBlob(ctypes.Structure):
    _fields_ = [("cbData", ctypes.wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_char))]


def _blob(data: bytes) -> tuple[_DataBlob, Any]:
    buffer = ctypes.create_string_buffer(data)
    return _DataBlob(len(data), ctypes.cast(buffer, ctypes.POINTER(ctypes.c_char))), buffer


def protect_bytes(data: bytes) -> bytes:
    if os.name != "nt":
        return b"plain:" + base64.b64encode(data)
    source, source_buffer = _blob(data)
    result = _DataBlob()
    if not ctypes.windll.crypt32.CryptProtectData(
        ctypes.byref(source), None, None, None, None, 0, ctypes.byref(result)
    ):
        raise ctypes.WinError()
    try:
        return ctypes.string_at(result.pbData, result.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(result.pbData)


def unprotect_bytes(data: bytes) -> bytes:
    if data.startswith(b"plain:"):
        return base64.b64decode(data[6:])
    if os.name != "nt":
        raise RuntimeError("Token cifrado de Windows no disponible en este sistema.")
    source, source_buffer = _blob(data)
    result = _DataBlob()
    if not ctypes.windll.crypt32.CryptUnprotectData(
        ctypes.byref(source), None, None, None, None, 0, ctypes.byref(result)
    ):
        raise ctypes.WinError()
    try:
        return ctypes.string_at(result.pbData, result.cbData)
    finally:
        ctypes.windll.kernel32.LocalFree(result.pbData)


class TokenStore:
    def __init__(self, path: Path):
        self.path = path

    def load(self) -> dict[str, Any] | None:
        if not self.path.exists():
            return None
        return json.loads(unprotect_bytes(self.path.read_bytes()).decode("utf-8"))

    def save(self, token: dict[str, Any]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_bytes(protect_bytes(json.dumps(token).encode("utf-8")))

    def clear(self) -> None:
        if self.path.exists():
            self.path.unlink()


class SpotifyClient:
    def __init__(self, client_id: str, redirect_uri: str, token_store: TokenStore):
        self.client_id = client_id
        self.redirect_uri = redirect_uri
        self.token_store = token_store

    def authorization_url(self, state: str, verifier: str) -> str:
        challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).rstrip(b"=").decode()
        params = {
            "client_id": self.client_id,
            "response_type": "code",
            "redirect_uri": self.redirect_uri,
            "scope": SCOPES,
            "state": state,
            "code_challenge_method": "S256",
            "code_challenge": challenge,
        }
        return f"{ACCOUNTS_BASE}/authorize?{urllib.parse.urlencode(params)}"

    def exchange_code(self, code: str, verifier: str) -> dict[str, Any]:
        token = self._form_request(
            f"{ACCOUNTS_BASE}/api/token",
            {
                "client_id": self.client_id,
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": self.redirect_uri,
                "code_verifier": verifier,
            },
        )
        token["expires_at"] = int(time.time()) + int(token.get("expires_in", 3600)) - 60
        self.token_store.save(token)
        return token

    def _refresh(self, token: dict[str, Any]) -> dict[str, Any]:
        refreshed = self._form_request(
            f"{ACCOUNTS_BASE}/api/token",
            {
                "client_id": self.client_id,
                "grant_type": "refresh_token",
                "refresh_token": token["refresh_token"],
            },
        )
        refreshed["refresh_token"] = refreshed.get("refresh_token", token["refresh_token"])
        refreshed["expires_at"] = int(time.time()) + int(refreshed.get("expires_in", 3600)) - 60
        self.token_store.save(refreshed)
        return refreshed

    def access_token(self) -> str:
        token = self.token_store.load()
        if not token:
            raise SpotifyError("Conecta tu cuenta de Spotify primero.", 401)
        if int(token.get("expires_at", 0)) <= int(time.time()):
            token = self._refresh(token)
        return str(token["access_token"])

    def _form_request(self, url: str, fields: dict[str, str]) -> dict[str, Any]:
        request = urllib.request.Request(
            url,
            data=urllib.parse.urlencode(fields).encode("utf-8"),
            headers={"Content-Type": "application/x-www-form-urlencoded"},
            method="POST",
        )
        return self._read_json(request)

    def request(
        self,
        method: str,
        path: str,
        *,
        query: dict[str, Any] | None = None,
        body: dict[str, Any] | None = None,
    ) -> Any:
        retry_after = rate_limit_remaining()
        if retry_after:
            limit_status = rate_limit_status()
            raise SpotifyError(
                f"Spotify limitó temporalmente las solicitudes. Intenta de nuevo en {retry_after} s.",
                429,
                {"retry_after": retry_after, "reason": limit_status["reason"]},
            )
        url = f"{API_BASE}{path}"
        if query:
            url += "?" + urllib.parse.urlencode(query)
        data = json.dumps(body).encode("utf-8") if body is not None else None
        request = urllib.request.Request(
            url,
            data=data,
            headers={
                "Authorization": f"Bearer {self.access_token()}",
                "Content-Type": "application/json",
            },
            method=method,
        )
        return self._read_json(request)

    @staticmethod
    def _read_json(request: urllib.request.Request) -> Any:
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                raw = response.read()
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as error:
            raw = error.read().decode("utf-8", errors="replace")
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                payload = raw

            if error.code == 429:
                try:
                    retry_after = int(error.headers.get("Retry-After", "1"))
                except (TypeError, ValueError):
                    retry_after = 1
                retry_after = max(1, retry_after)
                reason = None
                if isinstance(payload, dict) and isinstance(payload.get("error"), dict):
                    reason = payload["error"].get("reason")
                RATE_LIMIT_STATE.block_for(retry_after, reason)
                endpoint = urllib.parse.urlparse(request.full_url).path
                print(
                    f"Spotify respondió 429 en {endpoint}; pausa activa durante {retry_after} s"
                    f"{f' ({reason})' if reason else ''}.",
                    flush=True,
                )
                if isinstance(payload, dict):
                    payload = {**payload, "retry_after": retry_after}

            message = payload.get("error", payload) if isinstance(payload, dict) else payload
            if isinstance(message, dict):
                message = message.get("message") or str(message)
            raise SpotifyError(str(message), error.code, payload) from error
        except urllib.error.URLError as error:
            raise SpotifyError(f"No se pudo conectar con Spotify: {error.reason}", 503) from error

    def profile(self) -> dict[str, Any]:
        return self.request("GET", "/me")

    def saved_tracks(self) -> list[dict[str, Any]]:
        items: list[dict[str, Any]] = []
        offset = 0
        while True:
            page = self.request("GET", "/me/tracks", query={"limit": 50, "offset": offset})
            batch = page.get("items") or []
            items.extend(batch)
            if not page.get("next") or not batch:
                break
            offset += len(batch)
        return items

    @staticmethod
    def chunks(values: list[str], size: int) -> Iterator[list[str]]:
        for index in range(0, len(values), size):
            yield values[index : index + size]

    def create_backup_playlist(self, name: str, uris: list[str]) -> dict[str, Any] | None:
        if not uris:
            return None
        playlist = self.request(
            "POST",
            "/me/playlists",
            body={
                "name": name,
                "public": False,
                "description": "Respaldo creado por Spotify Dedupe Guard antes de retirar duplicados.",
            },
        )
        playlist_id = playlist["id"]
        for chunk in self.chunks(uris, 100):
            self.request("POST", f"/playlists/{playlist_id}/items", body={"uris": chunk})
        return playlist

    def remove_library_items(self, uris: list[str]) -> None:
        for chunk in self.chunks(uris, 40):
            self.request("DELETE", "/me/library", query={"uris": ",".join(chunk)})

    def save_library_items(self, uris: list[str]) -> None:
        for chunk in self.chunks(uris, 40):
            self.request("PUT", "/me/library", query={"uris": ",".join(chunk)})


def new_oauth_state() -> tuple[str, str]:
    return secrets.token_urlsafe(24), secrets.token_urlsafe(64)
