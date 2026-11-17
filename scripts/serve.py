#!/usr/bin/env python3
"""Preview the site locally: serves site/ with /data/ mapped to a data folder.

Usage: python scripts/serve.py [--data DIR] [--port 8000]
"""

import argparse
import functools
import http.server
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class Handler(http.server.SimpleHTTPRequestHandler):
    data_dir = os.path.join(ROOT, "data")

    def translate_path(self, path):
        clean = path.split("?", 1)[0].split("#", 1)[0]
        if clean.startswith("/data/"):
            return os.path.join(self.data_dir, os.path.basename(clean))
        return super().translate_path(path)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", default=os.path.join(ROOT, "data"))
    ap.add_argument("--port", type=int, default=8000)
    args = ap.parse_args()
    Handler.data_dir = os.path.abspath(args.data)
    handler = functools.partial(Handler, directory=os.path.join(ROOT, "site"))
    print(f"Serving http://localhost:{args.port}/ (data from {Handler.data_dir})")
    http.server.ThreadingHTTPServer(("127.0.0.1", args.port), handler).serve_forever()


if __name__ == "__main__":
    main()
