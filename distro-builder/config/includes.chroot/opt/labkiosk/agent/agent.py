#!/usr/bin/env python3
"""
Lab Kiosk Local Agent
Manages Cloudflare Worker telemetry, screen thumbnails, remote execution, and local wrapper API.
"""

import os
import sys
import time
import json
import socket
import base64
import subprocess
import threading
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.request import Request, urlopen
from urllib.error import URLError
from urllib.parse import urlparse

# Configuration Defaults
CONFIG_FILE = "/etc/labkiosk/config.json"
DEFAULT_WORKER_URL = "https://lab-kiosk-oavb.workers.dev" # Can be set via config
DEFAULT_HOMEPAGE = "https://www.khanacademy.org"

# In-Memory State
state = {
    "clientId": "PC-01",
    "clientNum": 1,
    "workerUrl": DEFAULT_WORKER_URL,
    "isLocked": False,
    "lockMessage": "Screens locked by the teacher. Please look to the front.",
    "targetUrl": DEFAULT_HOMEPAGE,
    "vncPort": 6080, # noVNC / websockify port
    "tunnelActive": False,
    "lastSeenTeacher": 0
}

def probe_worker_url(candidate_url):
    """Auto-detects whether host.docker.internal or host.containers.internal is resolvable."""
    if "host.docker.internal" in candidate_url:
        try:
            socket.gethostbyname("host.docker.internal")
            return candidate_url
        except Exception:
            return candidate_url.replace("host.docker.internal", "host.containers.internal")
    elif "host.containers.internal" in candidate_url:
        try:
            socket.gethostbyname("host.containers.internal")
            return candidate_url
        except Exception:
            return candidate_url.replace("host.containers.internal", "host.docker.internal")
    return candidate_url

WIZARD_HTML_FILE = "/opt/labkiosk/setup/wizard.html"

def load_config():
    """Derive or load client ID and worker URL."""
    state["isConfigured"] = False
    if os.path.exists(CONFIG_FILE):
        try:
            with open(CONFIG_FILE, "r") as f:
                cfg = json.load(f)
                raw_url = cfg.get("workerUrl", DEFAULT_WORKER_URL)
                state["workerUrl"] = probe_worker_url(raw_url)
                if "clientId" in cfg:
                    state["clientId"] = cfg["clientId"]
                if "clientNum" in cfg:
                    state["clientNum"] = int(cfg["clientNum"])
                state["isConfigured"] = cfg.get("configured", True)
                if not state["isConfigured"]:
                    state["targetUrl"] = "http://127.0.0.1:8888/setup"
                return
        except Exception as e:
            print(f"[Agent] Failed reading config: {e}")

    # Fallback: unconfigured setup mode
    state["targetUrl"] = "http://127.0.0.1:8888/setup"
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        local_ip = s.getsockname()[0]
        s.close()
        last_octet = int(local_ip.split(".")[-1])
        if 101 <= last_octet <= 199:
            num = last_octet - 100
        else:
            num = last_octet
        state["clientNum"] = num
        state["clientId"] = f"PC-{num:02d}"
    except Exception:
        hostname = socket.gethostname()
        state["clientId"] = hostname

# --- Local HTTP Server for Web Wrapper & Setup Wizard (Port 8888) ---
class LocalApiHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass # Suppress noisy stdout logs

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        if self.path == "/setup" or self.path == "/setup/":
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.end_headers()
            if os.path.exists(WIZARD_HTML_FILE):
                with open(WIZARD_HTML_FILE, "rb") as f:
                    self.wfile.write(f.read())
            else:
                self.wfile.write(b"<h1>Workstation Setup Wizard</h1><p>Setup file not found.</p>")
            return

        if self.path == "/api/status":
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Access-Control-Allow-Origin", "*")
            self.end_headers()
            payload = {
                "clientId": state["clientId"],
                "clientNum": state["clientNum"],
                "isLocked": state["isLocked"],
                "lockMessage": state["lockMessage"],
                "targetUrl": state["targetUrl"],
                "isConfigured": state.get("isConfigured", True)
            }
            self.wfile.write(json.dumps(payload).encode("utf-8"))
        else:
            self.send_response(404)
            self.end_headers()

    def do_POST(self):
        if self.path == "/api/setup":
            content_len = int(self.headers.get("Content-Length", 0))
            post_body = self.rfile.read(content_len)
            try:
                data = json.loads(post_body.decode("utf-8"))
                subdomain = data.get("subdomain", "").strip().lower()
                client_id = data.get("clientId", "").strip().upper()
                if not subdomain or not client_id:
                    self.send_response(400)
                    self.send_header("Content-Type", "application/json")
                    self.end_headers()
                    self.wfile.write(b'{"error": "Subdomain and Client ID required"}')
                    return

                # Target Worker URL
                worker_host = state["workerUrl"]
                final_url = f"https://{subdomain}.labkiosk.io"
                if "containers.internal" in worker_host or "docker.internal" in worker_host or "127.0.0.1" in worker_host:
                    final_url = worker_host

                # Save config
                os.makedirs(os.path.dirname(CONFIG_FILE), exist_ok=True)
                with open(CONFIG_FILE, "w") as f:
                    json.dump({
                        "subdomain": subdomain,
                        "clientId": client_id,
                        "workerUrl": final_url,
                        "configured": True
                    }, f, indent=2)

                state["clientId"] = client_id
                state["workerUrl"] = probe_worker_url(final_url)
                state["isConfigured"] = True
                state["targetUrl"] = final_url

                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(json.dumps({
                    "status": "ok",
                    "schoolName": subdomain,
                    "targetUrl": final_url
                }).encode("utf-8"))
            except Exception as e:
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"error": str(e)}).encode("utf-8"))
            return

        if self.path == "/api/nav":
            content_len = int(self.headers.get("Content-Length", 0))
            post_body = self.rfile.read(content_len)
            try:
                data = json.loads(post_body.decode("utf-8"))
                action = data.get("action")
                os.environ["DISPLAY"] = ":0"
                if action == "back":
                    subprocess.run(["xdotool", "key", "Alt+Left"], check=False)
                elif action == "forward":
                    subprocess.run(["xdotool", "key", "Alt+Right"], check=False)
                elif action == "reload":
                    subprocess.run(["xdotool", "key", "F5"], check=False)
                
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Access-Control-Allow-Origin", "*")
                self.end_headers()
                self.wfile.write(b'{"status":"ok"}')
            except Exception as e:
                self.send_response(500)
                self.end_headers()
        else:
            self.send_response(404)
            self.end_headers()

def start_local_server():
    server = HTTPServer(("0.0.0.0", 8888), LocalApiHandler)
    server.serve_forever()

CHROMIUM_POLICY_FILE = "/etc/chromium/policies/managed/policies.json"
cached_whitelist = None

def sync_chromium_policies(new_whitelist):
    """Dynamically writes Cloudflare Worker whitelist into Chromium managed policies."""
    global cached_whitelist
    if not new_whitelist or not isinstance(new_whitelist, list):
        return

    sorted_new = sorted(list(set(new_whitelist)))
    if cached_whitelist == sorted_new:
        return  # Whitelist unchanged

    allowlist = [
        "127.0.0.1",
        "localhost",
        "host.containers.internal",
        "labkiosk.io",
        ".labkiosk.io",
        "file:///opt/labkiosk/*",
        "chrome://*"
    ]

    # Add worker host if configured
    if state.get("workerUrl"):
        try:
            worker_host = urlparse(state["workerUrl"]).hostname
            if worker_host and worker_host not in allowlist:
                allowlist.extend([worker_host, f".{worker_host}"])
        except Exception:
            pass

    for d in sorted_new:
        clean = d.strip().lower().replace("https://", "").replace("http://", "").split("/")[0].split(":")[0]
        if not clean:
            continue
        allowlist.extend([
            clean,
            f".{clean}",
            f"http://{clean}/*",
            f"https://{clean}/*",
            f"http://*.{clean}/*",
            f"https://*.{clean}/*"
        ])

    policy_data = {
        "HomepageLocation": state["targetUrl"],
        "HomepageIsNewTabPage": True,
        "NewTabPageLocation": state["targetUrl"],
        "DeveloperToolsAvailability": 2,
        "PasswordManagerEnabled": False,
        "AutofillAddressEnabled": False,
        "AutofillCreditCardEnabled": False,
        "BookmarkBarEnabled": False,
        "ShowHomeButton": False,
        "PrintingEnabled": False,
        "PromptForDownloadLocation": False,
        "DefaultDownloadDirectory": "/tmp",
        "SafeBrowsingProtectionLevel": 1,
        "HardwareAccelerationModeEnabled": True,
        "DefaultSearchProviderEnabled": False,
        "BackgroundModeEnabled": False,
        "ExtensionInstallBlocklist": [],
        "ExtensionInstallAllowlist": ["*"],
        "URLBlocklist": [
            "chrome://*",
            "edge://*",
            "about:flags",
            "about:version",
            "http://*",
            "https://*"
        ],
        "URLAllowlist": list(dict.fromkeys(allowlist))
    }

    try:
        os.makedirs(os.path.dirname(CHROMIUM_POLICY_FILE), exist_ok=True)
        temp_file = CHROMIUM_POLICY_FILE + ".tmp"
        with open(temp_file, "w") as f:
            json.dump(policy_data, f, indent=2)
        os.replace(temp_file, CHROMIUM_POLICY_FILE)
        cached_whitelist = sorted_new
        print(f"[Agent] Synchronized Chromium enterprise policies with {len(sorted_new)} allowed domains", flush=True)
    except Exception as e:
        print(f"[Agent] Failed updating Chromium policies: {e}", flush=True)

# --- Screen Capture & Telemetry Loop ---
def capture_thumbnail_base64():
    """Takes a low-res thumbnail of the X11 screen and returns base64 jpeg."""
    thumb_path = "/tmp/kiosk_thumb.jpg"
    try:
        os.environ["DISPLAY"] = ":0"
        # Scrot thumbnail generation with -o (overwrite)
        subprocess.run(
            ["scrot", "-o", "-z", "-q", "35", "-t", "20", thumb_path],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=2,
            check=False
        )
        # scrot generates thumb_path with a '-thumb' suffix
        thumb_actual = "/tmp/kiosk_thumb-thumb.jpg"
        target_file = thumb_actual if os.path.exists(thumb_actual) else thumb_path

        if os.path.exists(target_file):
            with open(target_file, "rb") as f:
                encoded = base64.b64encode(f.read()).decode("utf-8")
                return f"data:image/jpeg;base64,{encoded}"
    except Exception as e:
        print(f"[Agent] Thumbnail capture error: {e}")
    return ""

def execute_command(cmd_data):
    """Processes directives pushed from Cloudflare Worker."""
    action = cmd_data.get("action")
    if not action:
        return

    print(f"[Agent] Executing remote action: {action}")
    if action == "lock":
        state["isLocked"] = True
        if "message" in cmd_data:
            state["lockMessage"] = cmd_data["message"]
    elif action == "unlock":
        state["isLocked"] = False
    elif action == "navigate":
        new_url = cmd_data.get("url")
        if new_url:
            state["targetUrl"] = new_url
            state["isLocked"] = False
            try:
                os.environ["DISPLAY"] = ":0"
                subprocess.Popen(
                    ["chromium", "--no-sandbox", new_url],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL
                )
            except Exception as err:
                print(f"[Agent] Navigation execution error: {err}")
    elif action == "reload":
        os.environ["DISPLAY"] = ":0"
        subprocess.run(["xdotool", "key", "F5"], check=False)
    elif action == "reboot":
        subprocess.run(["systemctl", "reboot"], check=False)
    elif action == "shutdown":
        subprocess.run(["systemctl", "poweroff"], check=False)
    elif action == "mute":
        subprocess.run(["amixer", "-D", "pulse", "set", "Master", "mute"], check=False)

def telemetry_loop():
    """Periodic telemetry push and command pull loop."""
    time.sleep(3) # Wait for Xorg and browser to render
    while True:
        try:
            thumbnail = capture_thumbnail_base64()
            payload = {
                "clientId": state["clientId"],
                "clientNum": state["clientNum"],
                "activeUrl": state["targetUrl"],
                "isLocked": state["isLocked"],
                "thumbnail": thumbnail,
                "timestamp": int(time.time())
            }

            url = f"{state['workerUrl']}/api/telemetry"
            req = Request(
                url,
                data=json.dumps(payload).encode("utf-8"),
                headers={"Content-Type": "application/json", "User-Agent": f"LabKioskAgent/{state['clientId']}"}
            )

            with urlopen(req, timeout=4) as response:
                if response.status == 200:
                    resp_data = json.loads(response.read().decode("utf-8"))
                    # 1. Synchronize Whitelist to Chromium policies
                    if "whitelist" in resp_data:
                        sync_chromium_policies(resp_data["whitelist"])
                    # 2. Process queued commands if any returned
                    if "commands" in resp_data:
                        for cmd in resp_data["commands"]:
                            execute_command(cmd)
        except Exception as e:
            print(f"[Agent] Telemetry error ({state['workerUrl']}): {e}", flush=True)

        time.sleep(3)

def main():
    load_config()
    print(f"[Agent] Starting Lab Kiosk Agent for {state['clientId']}...")

    # 1. Start local API thread for wrapper
    local_thread = threading.Thread(target=start_local_server, daemon=True)
    local_thread.start()

    # 2. Start telemetry and command loop
    telemetry_loop()

if __name__ == "__main__":
    main()
