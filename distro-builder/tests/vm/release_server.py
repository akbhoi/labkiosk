#!/usr/bin/env python3
"""
Serve a release folder over HTTP the way R2 does, for testing labkiosk-update.

GET of a file in DIRECTORY or one folder below it, with or without
`Range: bytes=N-`, answered 200 or 206 with Content-Range.
Two knobs make a download fail in the middle, as a flaky uplink would:

    --rate BYTES_PER_SECOND   send no faster than this
    --cut-after BYTES         close the connection after this many body bytes,
                              once, for the first file request that reaches it

boot-test.sh runs it as a process; the unit tests start it in a thread.

Usage: release_server.py DIRECTORY [--port N] [--rate N] [--cut-after N]
       (prints the port it listens on, then serves until killed)
"""

import argparse
import http.server
import os
import re
import sys
import threading
import time

RANGE_PATTERN = re.compile(r"^bytes=([0-9]+)-\Z")
BLOCK = 64 * 1024


class ReleaseHandler(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    # Set per server: directory, rate, cut_after, requests (a list), lock.

    def log_message(self, format, *args):
        pass

    def do_GET(self):
        server = self.server
        parts = self.path.lstrip("/").split("/")
        path = os.path.join(server.directory, *parts)
        with server.lock:
            server.requests.append((parts[-1], self.headers.get("Range")))
        if any(part in ("", ".", "..") for part in parts) or not os.path.isfile(path):
            self.send_error(404)
            return
        size = os.path.getsize(path)
        start = 0
        header = self.headers.get("Range")
        if header is not None:
            match = RANGE_PATTERN.match(header)
            if not match or int(match.group(1)) >= size:
                self.send_error(416)
                return
            start = int(match.group(1))
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{size - 1}/{size}")
        else:
            self.send_response(200)
        self.send_header("Content-Length", str(size - start))
        self.send_header("Accept-Ranges", "bytes")
        self.end_headers()
        try:
            self.send_body(path, start)
        except (BrokenPipeError, ConnectionResetError):
            # The client went away: the downloader was killed on purpose.
            self.close_connection = True

    def send_body(self, path, start):
        server = self.server
        sent = 0
        began = time.monotonic()
        with open(path, "rb") as handle:
            handle.seek(start)
            for block in iter(lambda: handle.read(BLOCK), b""):
                with server.lock:
                    cut = server.cut_after
                    if cut is not None and sent + len(block) > cut:
                        server.cut_after = None
                    else:
                        cut = None
                if cut is not None:
                    self.wfile.write(block[:cut - sent])
                    self.wfile.flush()
                    self.close_connection = True
                    return
                self.wfile.write(block)
                sent += len(block)
                if server.rate:
                    ahead = sent / server.rate - (time.monotonic() - began)
                    if ahead > 0:
                        time.sleep(ahead)


def make_server(directory, port=0, rate=None, cut_after=None):
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), ReleaseHandler)
    server.daemon_threads = True
    server.directory = directory
    server.rate = rate
    server.cut_after = cut_after
    server.requests = []
    server.lock = threading.Lock()
    return server


def start_in_thread(directory, **options):
    server = make_server(directory, **options)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def main(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument("directory")
    parser.add_argument("--port", type=int, default=0)
    parser.add_argument("--rate", type=int)
    parser.add_argument("--cut-after", type=int)
    args = parser.parse_args(argv)
    server = make_server(args.directory, args.port, args.rate, args.cut_after)
    print(server.server_address[1], flush=True)
    server.serve_forever()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
