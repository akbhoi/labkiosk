#!/usr/bin/env python3
"""
The boot server and a stand-in control plane for boot-test.sh's network boot
scenarios, on 127.0.0.1:80 (the VM reaches it as 10.0.2.2 through QEMU's user
network).

- Files under ROOT, as labkiosk-netboot.py laid them out: shim, GRUB, the
  menus, the kernel, initrd and squashfs.
- POST /api/devices/enroll: checks the organization and enrollment key the
  boot menu passed and answers with a device token.
- POST /api/telemetry: a heartbeat carrying that token is written to EVENTS as
  one JSON line, which is what the scenario waits for.
- The control channel's WebSocket route answers 404, so the agent falls back
  to the HTTP heartbeat; anything else under /api/ is accepted and ignored.

Usage: netboot_server.py ROOT EVENTS ORGANIZATION ENROLLMENT_KEY
"""
import functools
import http.server
import json
import os
import re
import secrets
import sys

CLIENT_ID_PATTERN = re.compile(r"^[A-Z0-9][A-Z0-9_-]{0,62}\Z")
MAX_BODY = 4 * 1024 * 1024


class Handler(http.server.SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    extensions_map = {**http.server.SimpleHTTPRequestHandler.extensions_map,
                      ".efi": "application/efi", ".ipxe": "text/plain", ".cfg": "text/plain"}

    def log_message(self, fmt, *args):
        sys.stderr.write("[netboot-server] %s %s\n" % (self.address_string(), fmt % args))

    def reply_json(self, status, body):
        data = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def read_json(self):
        length = int(self.headers.get("Content-Length") or 0)
        if not 0 <= length <= MAX_BODY:
            raise ValueError("body too large")
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8")) if raw else {}

    def record(self, event):
        with open(self.server.events, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(event) + "\n")

    def do_GET(self):
        if self.path.startswith("/api/"):
            self.reply_json(404, {"error": "not here"})
            return
        if self.path in ("/", "/index.html"):
            data = b"<!doctype html><title>Lab Kiosk network boot test</title><h1>Network boot test</h1>\n"
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        super().do_GET()

    def do_POST(self):
        try:
            body = self.read_json()
        except ValueError as err:
            self.reply_json(400, {"error": str(err)})
            return
        if self.path == "/api/devices/enroll":
            client_id = str(body.get("clientId", ""))
            if body.get("subdomain") != self.server.organization or body.get("enrollmentKey") != self.server.key:
                self.record({"event": "enroll-refused", "body": body})
                self.reply_json(403, {"error": "Invalid enrollment key"})
                return
            if not CLIENT_ID_PATTERN.match(client_id):
                self.reply_json(400, {"error": "Invalid client id"})
                return
            token = secrets.token_hex(32)
            self.server.tokens[token] = client_id
            self.record({"event": "enrolled", "clientId": client_id})
            self.reply_json(200, {"deviceToken": token, "clientId": client_id,
                                  "subdomain": self.server.organization, "targetUrl": "http://10.0.2.2/"})
            return
        if self.path == "/api/telemetry":
            auth = self.headers.get("Authorization", "")
            token = auth[len("Bearer "):] if auth.startswith("Bearer ") else ""
            if token not in self.server.tokens:
                self.reply_json(401, {"error": "Unknown device token"})
                return
            self.record({"event": "telemetry", "clientId": self.server.tokens[token]})
            self.reply_json(200, {})
            return
        if self.path.startswith("/api/"):
            self.reply_json(200, {})
            return
        self.reply_json(404, {"error": "not found"})


def main(argv):
    if len(argv) != 5:
        print(__doc__.strip().splitlines()[-1], file=sys.stderr)
        return 2
    handler = functools.partial(Handler, directory=os.path.abspath(argv[1]))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 80), handler)
    server.events = argv[2]
    server.organization = argv[3]
    server.key = argv[4]
    server.tokens = {}
    server.serve_forever()
    return 0


if __name__ == "__main__":
    sys.dont_write_bytecode = True
    sys.exit(main(sys.argv))
