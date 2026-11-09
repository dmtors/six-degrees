"""Local preview server: python's http.server, but telling the browser not to
cache, so an ordinary reload always picks up edited JS modules and CSS.

    python3 serve.py [port]   (default 5182)
"""

import http.server
import os
import sys


class NoCache(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()


if __name__ == "__main__":
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5182
    http.server.ThreadingHTTPServer(("127.0.0.1", port), NoCache).serve_forever()
