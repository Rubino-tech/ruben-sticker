#!/usr/bin/env python3
"""
Ruben Sticker Map — Local Launcher
Double-click this file to start the app on your computer.
"""
import http.server, socketserver, webbrowser, os, threading, sys, errno

CANDIDATE_PORTS = [8000, 8080, 8888, 3000, 5500]
DIR = os.path.dirname(os.path.abspath(__file__))

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=DIR, **kw)
    def log_message(self, *a): pass  # silent

def open_browser(port):
    import time; time.sleep(0.8)
    webbrowser.open(f"http://localhost:{port}")

httpd = None
port = None
for candidate in CANDIDATE_PORTS:
    try:
        httpd = socketserver.TCPServer(("", candidate), Handler)
        port = candidate
        break
    except OSError as e:
        # Port already in use, reserved, or blocked — try the next one.
        print(f"   Port {candidate} unavailable ({e.strerror or e}), trying another...")
        continue

if httpd is None:
    print("\n❌ Could not bind to any of these ports:", ", ".join(str(p) for p in CANDIDATE_PORTS))
    print("   This is usually a Windows port-reservation or firewall issue, not a problem")
    print("   with this project. Try running a specific port yourself, e.g.:")
    print("     python -m http.server 8000")
    print("   then open http://localhost:8000 in your browser.")
    sys.exit(1)

print(f"\n🌟 Ruben Sticker Map")
print(f"   Open in browser: http://localhost:{port}")
print(f"   Press Ctrl+C to stop\n")
threading.Thread(target=open_browser, args=(port,), daemon=True).start()

with httpd:
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
