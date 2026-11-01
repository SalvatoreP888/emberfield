#!/usr/bin/env python3
"""Start EMBERFIELD locally without installing any project dependencies."""

import argparse
import functools
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sys
import webbrowser


ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"


class EmberfieldHandler(SimpleHTTPRequestHandler):
    # WebAssembly streaming compilation needs the correct MIME type, including
    # on systems whose MIME database does not define it.
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".wasm": "application/wasm",
    }


def main():
    parser = argparse.ArgumentParser(description="Launch EMBERFIELD locally.")
    parser.add_argument(
        "--port",
        type=int,
        default=0,
        help="local port to use (default: choose an available port)",
    )
    parser.add_argument(
        "--no-browser", action="store_true", help="do not open a browser automatically"
    )
    args = parser.parse_args()
    if not 0 <= args.port <= 65535:
        parser.error("port must be between 0 and 65535")
    if not (DIST / "index.html").is_file():
        print("EMBERFIELD could not find dist/index.html. Keep the launcher with the complete project.", file=sys.stderr)
        return 1

    handler = functools.partial(EmberfieldHandler, directory=str(DIST))
    try:
        server = ThreadingHTTPServer(("127.0.0.1", args.port), handler)
    except OSError as exc:
        print("Could not start EMBERFIELD's local server: {}".format(exc), file=sys.stderr)
        return 1

    with server:
        url = "http://127.0.0.1:{}/".format(server.server_port)
        print("EMBERFIELD is ready: {}".format(url), flush=True)
        print("Keep this window open while playing. Close it or press Ctrl+C to stop.", flush=True)
        if not args.no_browser:
            try:
                if not webbrowser.open(url, new=2):
                    print("Open the address above in your browser to play.", flush=True)
            except (OSError, webbrowser.Error):
                print("Open the address above in your browser to play.", flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("\nEMBERFIELD stopped.", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
