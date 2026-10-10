"""Serve the browser-only app locally without a user-data backend."""

import sys
import threading
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit


HOST = "127.0.0.1"
PORT = 8765
STATIC_DIR = Path(__file__).resolve().parent / "static"


class StaticAppHandler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(STATIC_DIR), **kwargs)

    def translate_path(self, path):
        if urlsplit(path).path == "/":
            path = "/index.html"
        return super().translate_path(path)

    def log_message(self, fmt, *args):
        # OAuth callback URLs include a short-lived authorization code.
        return


def main(open_browser=True):
    server = ThreadingHTTPServer((HOST, PORT), StaticAppHandler)
    url = f"http://{HOST}:{PORT}/"
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
