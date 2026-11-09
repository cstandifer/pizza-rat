"""Local server for Pizza Rat that tells the browser never to cache files.

Run from this folder:   python3 serve.py
Then open:              http://localhost:8123

(The plain `python3 -m http.server` lets browsers keep old copies of the JavaScript,
so after code changes you could still be watching an older version.)
"""
import http.server
import socketserver

PORT = 8123


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Expires", "0")
        super().end_headers()


socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("127.0.0.1", PORT), NoCacheHandler) as httpd:
    print(f"Pizza Rat running at http://localhost:{PORT}  (Ctrl+C to stop)")
    httpd.serve_forever()
