from __future__ import annotations

import json
import mimetypes
import sqlite3
import sys
import threading
import urllib.parse
import webbrowser
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from dedupe_engine import detect_duplicates
from spotify_api import SpotifyClient, SpotifyError, TokenStore, new_oauth_state


ROOT = Path(__file__).resolve().parent
STATIC = ROOT / "static"
DATA = ROOT / "data"
CONFIG_PATH = DATA / "config.json"
TOKEN_PATH = DATA / "spotify_token.bin"
OAUTH_PATH = DATA / "oauth_pending.json"
DB_PATH = DATA / "dedupe.sqlite3"
HOST = "127.0.0.1"
PORT = 8765
REDIRECT_URI = f"http://{HOST}:{PORT}/callback"


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def load_config() -> dict[str, Any]:
    if not CONFIG_PATH.exists():
        return {}
    return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))


def save_config(config: dict[str, Any]) -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    CONFIG_PATH.write_text(json.dumps(config, indent=2), encoding="utf-8")


def spotify_client() -> SpotifyClient:
    client_id = str(load_config().get("client_id") or "").strip()
    if not client_id:
        raise SpotifyError("Configura el Client ID de Spotify.", 400)
    return SpotifyClient(client_id, REDIRECT_URI, TokenStore(TOKEN_PATH))


def database() -> sqlite3.Connection:
    DATA.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    connection.executescript(
        """
        CREATE TABLE IF NOT EXISTS scans (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at TEXT NOT NULL,
            total_tracks INTEGER NOT NULL,
            result_json TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS actions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at TEXT NOT NULL,
            action TEXT NOT NULL,
            payload_json TEXT NOT NULL,
            backup_playlist_id TEXT,
            related_action_id INTEGER
        );
        """
    )
    return connection


def store_scan(result: dict[str, Any]) -> int:
    with database() as db:
        cursor = db.execute(
            "INSERT INTO scans(created_at, total_tracks, result_json) VALUES (?, ?, ?)",
            (utc_now(), result["total_tracks"], json.dumps(result, ensure_ascii=False)),
        )
        return int(cursor.lastrowid)


def get_scan(scan_id: int | None = None) -> dict[str, Any] | None:
    with database() as db:
        if scan_id is None:
            row = db.execute("SELECT * FROM scans ORDER BY id DESC LIMIT 1").fetchone()
        else:
            row = db.execute("SELECT * FROM scans WHERE id = ?", (scan_id,)).fetchone()
    if not row:
        return None
    result = json.loads(row["result_json"])
    result["scan_id"] = row["id"]
    result["created_at"] = row["created_at"]
    return result


def store_action(
    action: str,
    payload: dict[str, Any],
    *,
    backup_playlist_id: str | None = None,
    related_action_id: int | None = None,
) -> int:
    with database() as db:
        cursor = db.execute(
            """INSERT INTO actions(created_at, action, payload_json, backup_playlist_id, related_action_id)
               VALUES (?, ?, ?, ?, ?)""",
            (
                utc_now(),
                action,
                json.dumps(payload, ensure_ascii=False),
                backup_playlist_id,
                related_action_id,
            ),
        )
        return int(cursor.lastrowid)


def get_action(action_id: int) -> dict[str, Any] | None:
    with database() as db:
        row = db.execute("SELECT * FROM actions WHERE id = ?", (action_id,)).fetchone()
    if not row:
        return None
    return {
        "id": row["id"],
        "created_at": row["created_at"],
        "action": row["action"],
        "payload": json.loads(row["payload_json"]),
        "backup_playlist_id": row["backup_playlist_id"],
        "related_action_id": row["related_action_id"],
    }


def action_history() -> list[dict[str, Any]]:
    with database() as db:
        rows = db.execute("SELECT * FROM actions ORDER BY id DESC LIMIT 50").fetchall()
    undone = {row["related_action_id"] for row in rows if row["action"] == "undo"}
    return [
        {
            "id": row["id"],
            "created_at": row["created_at"],
            "action": row["action"],
            "count": len(json.loads(row["payload_json"]).get("tracks", [])),
            "backup_playlist_id": row["backup_playlist_id"],
            "can_undo": row["action"] == "remove" and row["id"] not in undone,
        }
        for row in rows
    ]


class DedupeHandler(BaseHTTPRequestHandler):
    server_version = "SpotifyDedupeGuard/1.0"

    def log_message(self, fmt: str, *args: Any) -> None:
        print(f"[{self.log_date_time_string()}] {fmt % args}")

    def send_json(self, payload: Any, status: int = 200) -> None:
        encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(encoded)

    def send_error_json(self, error: Exception) -> None:
        if isinstance(error, SpotifyError):
            self.send_json({"error": str(error), "details": error.payload}, error.status)
        elif isinstance(error, ValueError):
            self.send_json({"error": str(error)}, 400)
        else:
            print(f"Unhandled error: {error!r}")
            self.send_json({"error": "La operación no pudo completarse.", "details": str(error)}, 500)

    def body_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0"))
        if not length:
            return {}
        return json.loads(self.rfile.read(length).decode("utf-8"))

    def require_intent(self) -> None:
        if self.headers.get("X-Dedupe-Intent") != "confirmed":
            raise ValueError("Falta la confirmación explícita de la operación.")

    def do_GET(self) -> None:
        try:
            parsed = urllib.parse.urlparse(self.path)
            if parsed.path == "/api/status":
                self.api_status()
            elif parsed.path == "/api/scan/latest":
                self.send_json({"scan": get_scan()})
            elif parsed.path == "/api/history":
                self.send_json({"history": action_history()})
            elif parsed.path == "/auth/login":
                self.auth_login()
            elif parsed.path == "/callback":
                self.auth_callback(urllib.parse.parse_qs(parsed.query))
            else:
                self.serve_static(parsed.path)
        except Exception as error:
            self.send_error_json(error)

    def do_POST(self) -> None:
        try:
            parsed = urllib.parse.urlparse(self.path)
            if parsed.path == "/api/config":
                self.api_config()
            elif parsed.path == "/api/disconnect":
                self.require_intent()
                TokenStore(TOKEN_PATH).clear()
                self.send_json({"ok": True})
            elif parsed.path == "/api/scan":
                self.api_scan()
            elif parsed.path == "/api/remove":
                self.require_intent()
                self.api_remove()
            elif parsed.path == "/api/undo":
                self.require_intent()
                self.api_undo()
            else:
                self.send_json({"error": "Ruta no encontrada."}, 404)
        except Exception as error:
            self.send_error_json(error)

    def api_status(self) -> None:
        config = load_config()
        configured = bool(config.get("client_id"))
        authenticated = TOKEN_PATH.exists()
        profile = None
        auth_error = None
        if configured and authenticated:
            try:
                raw_profile = spotify_client().profile()
                profile = {
                    "display_name": raw_profile.get("display_name") or "Spotify",
                    "id": raw_profile.get("id"),
                    "images": raw_profile.get("images") or [],
                }
            except SpotifyError as error:
                auth_error = str(error)
        self.send_json(
            {
                "configured": configured,
                "authenticated": authenticated and not auth_error,
                "profile": profile,
                "auth_error": auth_error,
                "redirect_uri": REDIRECT_URI,
            }
        )

    def api_config(self) -> None:
        client_id = str(self.body_json().get("client_id") or "").strip()
        if not client_id or not all(ch.isalnum() for ch in client_id):
            raise ValueError("El Client ID no tiene un formato válido.")
        if len(client_id) < 16 or len(client_id) > 64:
            raise ValueError("Revisa el Client ID de Spotify.")
        save_config({"client_id": client_id})
        self.send_json({"ok": True, "redirect_uri": REDIRECT_URI})

    def auth_login(self) -> None:
        state, verifier = new_oauth_state()
        DATA.mkdir(parents=True, exist_ok=True)
        OAUTH_PATH.write_text(
            json.dumps({"state": state, "verifier": verifier, "created_at": utc_now()}),
            encoding="utf-8",
        )
        self.send_response(302)
        self.send_header("Location", spotify_client().authorization_url(state, verifier))
        self.end_headers()

    def auth_callback(self, query: dict[str, list[str]]) -> None:
        if "error" in query:
            raise SpotifyError(f"Spotify rechazó la autorización: {query['error'][0]}", 400)
        if not OAUTH_PATH.exists():
            raise SpotifyError("La autorización expiró. Iníciala de nuevo.", 400)
        pending = json.loads(OAUTH_PATH.read_text(encoding="utf-8"))
        state = (query.get("state") or [""])[0]
        code = (query.get("code") or [""])[0]
        if not code or state != pending.get("state"):
            raise SpotifyError("La respuesta de autorización no es válida.", 400)
        spotify_client().exchange_code(code, pending["verifier"])
        OAUTH_PATH.unlink(missing_ok=True)
        self.send_response(302)
        self.send_header("Location", "/?connected=1")
        self.end_headers()

    def api_scan(self) -> None:
        items = spotify_client().saved_tracks()
        result = detect_duplicates(items)
        result["scan_id"] = store_scan(result)
        result["created_at"] = utc_now()
        self.send_json({"scan": result})

    def api_remove(self) -> None:
        payload = self.body_json()
        scan_id = int(payload.get("scan_id") or 0)
        selected_ids = list(dict.fromkeys(str(item) for item in payload.get("track_ids") or []))
        if not selected_ids:
            raise ValueError("Selecciona al menos una canción para retirar.")
        scan = get_scan(scan_id)
        if not scan:
            raise ValueError("La auditoría ya no está disponible. Ejecuta una nueva.")

        allowed: dict[str, dict[str, Any]] = {}
        keepers: set[str] = set()
        for group in scan["groups"]:
            keepers.add(group["keeper"]["id"])
            for track in group["remove"]:
                allowed[track["id"]] = {**track, "group_id": group["id"], "kind": group["kind"]}
        if any(track_id not in allowed or track_id in keepers for track_id in selected_ids):
            raise ValueError("La selección contiene una canción que no puede retirarse.")

        tracks = [allowed[track_id] for track_id in selected_ids]
        uris = [track["uri"] for track in tracks]
        stamp = datetime.now().strftime("%Y-%m-%d %H.%M")
        client = spotify_client()
        backup = client.create_backup_playlist(f"Dedupe Guard · Respaldo {stamp}", uris)
        client.remove_library_items(uris)
        action_id = store_action(
            "remove",
            {"scan_id": scan_id, "tracks": tracks},
            backup_playlist_id=(backup or {}).get("id"),
        )
        self.send_json(
            {
                "ok": True,
                "action_id": action_id,
                "removed": len(tracks),
                "backup_playlist": (backup or {}).get("external_urls", {}).get("spotify"),
            }
        )

    def api_undo(self) -> None:
        action_id = int(self.body_json().get("action_id") or 0)
        action = get_action(action_id)
        if not action or action["action"] != "remove":
            raise ValueError("No se encontró una limpieza que pueda deshacerse.")
        with database() as db:
            exists = db.execute(
                "SELECT 1 FROM actions WHERE action = 'undo' AND related_action_id = ?", (action_id,)
            ).fetchone()
        if exists:
            raise ValueError("Esta limpieza ya fue restaurada.")
        tracks = action["payload"].get("tracks") or []
        spotify_client().save_library_items([track["uri"] for track in tracks])
        undo_id = store_action("undo", {"tracks": tracks}, related_action_id=action_id)
        self.send_json({"ok": True, "action_id": undo_id, "restored": len(tracks)})

    def serve_static(self, path: str) -> None:
        relative = "index.html" if path in ("", "/") else path.lstrip("/")
        target = (STATIC / relative).resolve()
        if STATIC.resolve() not in target.parents and target != STATIC.resolve():
            self.send_json({"error": "Ruta no válida."}, 400)
            return
        if not target.is_file():
            self.send_json({"error": "Archivo no encontrado."}, 404)
            return
        content = target.read_bytes()
        content_type = mimetypes.guess_type(target.name)[0] or "application/octet-stream"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(content)


def main(open_browser: bool = True) -> None:
    DATA.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer((HOST, PORT), DedupeHandler)
    url = f"http://{HOST}:{PORT}"
    print(f"Spotify Dedupe Guard disponible en {url}")
    if open_browser:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServidor detenido.")
    finally:
        server.server_close()


if __name__ == "__main__":
    main(open_browser="--no-browser" not in sys.argv)
