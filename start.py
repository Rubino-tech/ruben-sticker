#!/usr/bin/env python3
"""
Ruben Sticker Map — Local Launcher
Double-click this file to start the app on your computer.
"""
import http.server, socketserver, webbrowser, os, threading, sys

PORT = 5173
DIR  = os.path.dirname(os.path.abspath(__file__))

class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=DIR, **kw)
    def log_message(self, *a): pass  # silent

def open_browser():
    import time; time.sleep(0.8)
    webbrowser.open(f"http://localhost:{PORT}")

print(f"\n🌟 Ruben Sticker Map")
print(f"   Open in browser: http://localhost:{PORT}")
print(f"   Press Ctrl+C to stop\n")
threading.Thread(target=open_browser, daemon=True).start()

with socketserver.TCPServer(("", PORT), Handler) as httpd:
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
