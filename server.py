import http.server
import socketserver
import urllib.request
import urllib.parse
import os
import sys
import threading
import time

DIRECTORY = os.path.dirname(os.path.abspath(__file__))
CACHE_DIR = os.path.join(DIRECTORY, "cache_frames")
CDN_BASE = "https://cdn.riwaaz.in/wedding-websites/themes/rameswaram/frames"

class CustomHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Range, User-Agent')
        if self.path.endswith(('.js', '.css', '.html', '.json')):
            self.send_header('Cache-Control', 'no-cache, must-revalidate')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path.startswith("/frames/"):
            subpath = path[len("/frames/"):]
            local_subpath = subpath.split('?')[0].replace('/', os.sep)
            local_cache_path = os.path.join(CACHE_DIR, local_subpath)

            # Serve from local disk cache if present
            if os.path.isfile(local_cache_path):
                try:
                    with open(local_cache_path, 'rb') as f:
                        data = f.read()
                    content_type = 'image/webp' if subpath.endswith('.webp') else ('application/json' if subpath.endswith('.json') else 'application/octet-stream')
                    self.send_response(200)
                    self.send_header('Content-Type', content_type)
                    self.send_header('Content-Length', str(len(data)))
                    self.send_header('Cache-Control', 'public, max-age=31536000')
                    self.end_headers()
                    self.wfile.write(data)
                    return
                except Exception as e:
                    pass

            # Proxy from CDN with required headers
            target_url = f"{CDN_BASE}/{subpath}"
            if parsed.query:
                target_url += f"?{parsed.query}"

            req = urllib.request.Request(
                target_url,
                headers={
                    'Origin': 'https://demos.riwaaz.in',
                    'Referer': 'https://demos.riwaaz.in/',
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                }
            )

            try:
                with urllib.request.urlopen(req, timeout=15) as resp:
                    data = resp.read()
                    content_type = resp.headers.get('Content-Type', 'image/webp')

                    # Cache to disk
                    try:
                        os.makedirs(os.path.dirname(local_cache_path), exist_ok=True)
                        with open(local_cache_path, 'wb') as f:
                            f.write(data)
                    except Exception:
                        pass

                    self.send_response(200)
                    self.send_header('Content-Type', content_type)
                    self.send_header('Content-Length', str(len(data)))
                    self.send_header('Cache-Control', 'public, max-age=31536000')
                    self.end_headers()
                    self.wfile.write(data)
                    return
            except Exception as err:
                print(f"[Proxy error] {subpath}: {err}", flush=True)
                self.send_error(502, f"Proxy error: {err}")
                return

        return super().do_GET()

# Background pre-cacher for ultra-smooth scrolling
def background_precache():
    time.sleep(1)
    variants = ['desktop', 'mobile']
    print("[Precache] Starting background frame prefetch...", flush=True)
    # Prefetch manifest first
    manifest_cache = os.path.join(CACHE_DIR, "manifest.json")
    if not os.path.isfile(manifest_cache):
        try:
            req = urllib.request.Request(
                f"{CDN_BASE}/manifest.json",
                headers={'Origin': 'https://demos.riwaaz.in', 'Referer': 'https://demos.riwaaz.in/'}
            )
            with urllib.request.urlopen(req, timeout=10) as resp:
                data = resp.read()
                os.makedirs(CACHE_DIR, exist_ok=True)
                with open(manifest_cache, 'wb') as f:
                    f.write(data)
        except Exception:
            pass

    # Pre-cache the first 30 desktop sheets immediately
    for var in ['desktop', 'mobile']:
        for i in range(152):
            fname = f"{i:03d}.webp"
            local_file = os.path.join(CACHE_DIR, var, fname)
            if not os.path.isfile(local_file):
                try:
                    req = urllib.request.Request(
                        f"{CDN_BASE}/{var}/{fname}?v=cors2",
                        headers={'Origin': 'https://demos.riwaaz.in', 'Referer': 'https://demos.riwaaz.in/'}
                    )
                    with urllib.request.urlopen(req, timeout=10) as resp:
                        data = resp.read()
                        os.makedirs(os.path.join(CACHE_DIR, var), exist_ok=True)
                        with open(local_file, 'wb') as f:
                            f.write(data)
                    if (i + 1) % 10 == 0:
                        print(f"[Precache] {var}: {i+1}/152 sheets cached", flush=True)
                except Exception as e:
                    pass
            time.sleep(0.05)

if __name__ == '__main__':
    PORT = 8080
    socketserver.TCPServer.allow_reuse_address = True
    bg_thread = threading.Thread(target=background_precache, daemon=True)
    bg_thread.start()
    with socketserver.TCPServer(("", PORT), CustomHandler) as httpd:
        print(f"Invite server live at http://localhost:{PORT}", flush=True)
        httpd.serve_forever()