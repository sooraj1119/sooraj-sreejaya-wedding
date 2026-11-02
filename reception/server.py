import http.server
import socketserver
import os
import sys
import json
import urllib.request
import urllib.parse
from datetime import datetime

PORT = 8081
DIRECTORY = os.path.dirname(os.path.abspath(__file__))
RSVPS_FILE = os.path.join(DIRECTORY, "rsvps.json")

class CustomHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=DIRECTORY, **kwargs)

    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, Range, User-Agent')
        clean = self.path.split('?')[0]
        if clean.endswith(('.js', '.css', '.html', '.json')):
            self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
            self.send_header('Pragma', 'no-cache')
            self.send_header('Expires', '0')
        elif clean.endswith(('.webp', '.jpg', '.mp4', '.mp3')):
            self.send_header('Cache-Control', 'public, max-age=31536000')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def do_POST(self):
        clean = self.path.split('?')[0]
        if clean == '/api/rsvp':
            content_length = int(self.headers.get('Content-Length', 0))
            post_body = self.rfile.read(content_length)
            try:
                data = json.loads(post_body.decode('utf-8'))
                data['received_at'] = datetime.now().isoformat()
                
                # Persist to local rsvps.json
                existing = []
                if os.path.exists(RSVPS_FILE):
                    try:
                        with open(RSVPS_FILE, 'r', encoding='utf-8') as f:
                            existing = json.load(f)
                    except Exception:
                        existing = []
                existing.append(data)
                with open(RSVPS_FILE, 'w', encoding='utf-8') as f:
                    json.dump(existing, f, indent=2, ensure_ascii=False)
                
                print(f"[RSVP RECEIVED] {data.get('name')} | Attendance: {data.get('attendance')} | Guests: {data.get('guests')}")

                # Forward email via FormSubmit API to sooraj1119@gmail.com
                try:
                    fs_payload = json.dumps({
                        '_subject': f"Wedding Reception RSVP from {data.get('name')}",
                        '_template': 'table',
                        'Guest Name': data.get('name'),
                        'Attending': 'Yes' if data.get('attendance') == 'yes' else 'No (Sending Love)',
                        'Guest Count': data.get('guests', '1'),
                        'Message / Blessings': data.get('message', ''),
                        'Submitted At': data['received_at']
                    }).encode('utf-8')
                    req = urllib.request.Request(
                        "https://formsubmit.co/ajax/sooraj1119@gmail.com",
                        data=fs_payload,
                        headers={'Content-Type': 'application/json', 'Accept': 'application/json'}
                    )
                    with urllib.request.urlopen(req, timeout=5) as fs_resp:
                        print(f"[EMAIL FORWARDED] FormSubmit status: {fs_resp.status}")
                except Exception as mail_err:
                    print(f"[EMAIL NOTE] Direct HTTP forward note: {mail_err}")

                resp_body = json.dumps({
                    'success': True,
                    'message': f"Thank you {data.get('name')}, your RSVP has been recorded and emailed to sooraj1119@gmail.com"
                }).encode('utf-8')
                self.send_response(200)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(resp_body)))
                self.end_headers()
                self.wfile.write(resp_body)
                return
            except Exception as e:
                err_resp = json.dumps({'success': False, 'error': str(e)}).encode('utf-8')
                self.send_response(500)
                self.send_header('Content-Type', 'application/json')
                self.send_header('Content-Length', str(len(err_resp)))
                self.end_headers()
                self.wfile.write(err_resp)
                return
        super().do_POST()

    def guess_type(self, path):
        clean = path.split('?')[0]
        if clean.endswith('.webp'):
            return 'image/webp'
        if clean.endswith('.js'):
            return 'application/javascript'
        if clean.endswith('.json'):
            return 'application/json'
        if clean.endswith('.css'):
            return 'text/css'
        if clean.endswith('.mp3'):
            return 'audio/mpeg'
        if clean.endswith('.mp4'):
            return 'video/mp4'
        if clean.endswith('.ics'):
            return 'text/calendar'
        return super().guess_type(path)

class ThreadingHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True

if __name__ == '__main__':
    port = int(sys.argv[1]) if len(sys.argv) > 1 else PORT
    with ThreadingHTTPServer(("", port), CustomHandler) as httpd:
        print(f"Serving Wedding Reception Invitation at http://localhost:{port}/")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nShutting down server.")
