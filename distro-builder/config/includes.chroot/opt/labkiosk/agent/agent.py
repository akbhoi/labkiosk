#!/usr/bin/env python3
"""
Lab Kiosk Local Agent

Responsibilities:
  * First-boot enrolment against the school's Cloudflare Worker.
  * Screen thumbnail telemetry and remote command execution.
  * Synchronising the school's domain allowlist into Chromium managed policies.
  * A loopback-only HTTP API for the setup wizard and the browser extension.

Security notes:
  * The local API binds to 127.0.0.1 only. It used to listen on 0.0.0.0 with a
    wildcard CORS header, which let any device on the school network re-point a
    workstation at a different control plane or inject keystrokes into it.
  * Telemetry is authenticated with a per-device bearer token obtained by
    exchanging the school's enrollment key once, at enrolment.
  * There is no built-in control-plane URL. An unconfigured workstation talks to
    nobody until a teacher completes the setup wizard.
"""

import json
import os
import re
import socket
import subprocess
import sys
import threading
import time
import base64
from http.server import HTTPServer, BaseHTTPRequestHandler
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

CONFIG_FILE = "/etc/labkiosk/config.json"
WIZARD_HTML_FILE = "/opt/labkiosk/setup/wizard.html"
CHROMIUM_POLICY_FILE = "/etc/chromium/policies/managed/policies.json"
SETUP_URL = "http://127.0.0.1:8888/setup"
# Must match --user-data-dir in the kiosk launch (openbox autostart / entrypoint.sh).
BROWSER_PROFILE_DIR = "/tmp/chromium-profile"
# Fixed by the "key" field in /opt/labkiosk/extension/manifest.json. Keep the two
# in step: if the key changes, this id changes and the extension stops loading.
KIOSK_EXTENSION_ID = "hfjmbeplebjipenkfabncgkpadnjmmoe"
DEFAULT_BASE_DOMAIN = os.environ.get("LABKIOSK_DOMAIN", "labkiosk.akbhoi.com")
DEFAULT_HOMEPAGE = os.environ.get("LABKIOSK_DEFAULT_HOMEPAGE", f"https://{DEFAULT_BASE_DOMAIN}")

LOCAL_API_HOST = "127.0.0.1"
LOCAL_API_PORT = 8888
HEARTBEAT_SECONDS = 3
MAX_BACKOFF_SECONDS = 60

# Hosts that may appear in a workerUrl in addition to a public https origin.
LOCAL_WORKER_HOSTS = {
    "127.0.0.1",
    "localhost",
    "host.docker.internal",
    "host.containers.internal",
}

CLIENT_ID_PATTERN = re.compile(r"^[A-Z0-9][A-Z0-9_-]{0,63}$")

state = {
    "clientId": "",
    "clientNum": 1,
    "workerUrl": "",
    "deviceToken": "",
    "subdomain": "",
    "customDomain": "",
    "isConfigured": False,
    "isLocked": False,
    "lockMessage": "Screens locked by the instructor. Please look to the front.",
    "targetUrl": SETUP_URL,
    "broadcastUrl": "",
    "broadcastEpoch": 0,
    "vncPort": 6080,
    # Set at enrolment. Chromium reads its managed policy at startup, so a
    # workstation that just enrolled is still running under the boot-time
    # allowlist and would show "This page is blocked" on its new home page until
    # Chromium's own file watcher caught up. Restarting the browser once, after
    # the first policy sync, makes the transition immediate.
    "pendingBrowserRestart": False,
}
state_lock = threading.Lock()


def log(message):
    print(f"[Agent] {message}", flush=True)


# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------

def validate_worker_url(candidate):
    """Accept only an https origin, or a loopback/container host for local testing."""
    if not candidate:
        return None
    cand = candidate if candidate.startswith(("http://", "https://")) else f"https://{candidate}"
    try:
        parsed = urlparse(cand)
    except ValueError:
        return None
    if not parsed.hostname:
        return None
    is_local = (
        parsed.hostname in LOCAL_WORKER_HOSTS
        or parsed.hostname.endswith(".internal")
        or parsed.hostname.endswith(".local")
    )
    if parsed.scheme == "https" or (parsed.scheme == "http" and is_local):
        return f"{parsed.scheme}://{parsed.netloc}"
    return None


def probe_worker_url(candidate_url):
    """Swap between the Docker and Podman gateway aliases, whichever resolves."""
    for name, alternate in (
        ("host.docker.internal", "host.containers.internal"),
        ("host.containers.internal", "host.docker.internal"),
    ):
        if name in candidate_url:
            try:
                socket.gethostbyname(name)
                return candidate_url
            except OSError:
                return candidate_url.replace(name, alternate)
    return candidate_url


def derive_default_client_id():
    """Suggest a workstation name from the host's last IP octet, else its hostname."""
    try:
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        probe.connect(("8.8.8.8", 80))
        local_ip = probe.getsockname()[0]
        probe.close()
        last_octet = int(local_ip.split(".")[-1])
        num = last_octet - 100 if 101 <= last_octet <= 199 else last_octet
        return f"PC-{num:02d}", num
    except (OSError, ValueError) as err:
        log(f"Could not derive a workstation number from the network address: {err}")
        return socket.gethostname().upper()[:64], 1


def load_config():
    """Load persisted enrolment, or stay in setup mode."""
    suggested_id, suggested_num = derive_default_client_id()

    with state_lock:
        state["clientId"] = suggested_id
        state["clientNum"] = suggested_num
        state["isConfigured"] = False
        state["targetUrl"] = SETUP_URL

    if not os.path.exists(CONFIG_FILE):
        log("No configuration found; starting the first-boot setup wizard.")
        return

    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as handle:
            cfg = json.load(handle)
    except (OSError, ValueError) as err:
        log(f"Configuration at {CONFIG_FILE} is unreadable ({err}); starting the setup wizard.")
        return

    worker_url = validate_worker_url(cfg.get("workerUrl", ""))
    device_token = str(cfg.get("deviceToken", "") or "")
    client_id = str(cfg.get("clientId", "") or "").upper()

    if not worker_url or not device_token or not CLIENT_ID_PATTERN.match(client_id):
        log("Configuration is incomplete or not a valid enrolment; starting the setup wizard.")
        return

    with state_lock:
        state["workerUrl"] = probe_worker_url(worker_url)
        state["deviceToken"] = device_token
        state["clientId"] = client_id
        state["subdomain"] = str(cfg.get("subdomain", "") or "")
        state["customDomain"] = str(cfg.get("customDomain", "") or "")
        state["clientNum"] = int(cfg.get("clientNum", suggested_num) or suggested_num)
        state["isConfigured"] = True
        state["targetUrl"] = cfg.get("targetUrl") or worker_url

    log(f"Loaded enrolment for {client_id} against {worker_url}")


def save_config(payload):
    """Persist enrolment with owner-only permissions; it contains a device token."""
    directory = os.path.dirname(CONFIG_FILE)
    os.makedirs(directory, exist_ok=True)
    temp_path = CONFIG_FILE + ".tmp"
    with open(temp_path, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, indent=2)
    os.chmod(temp_path, 0o600)
    os.replace(temp_path, CONFIG_FILE)


# --------------------------------------------------------------------------
# Enrolment
# --------------------------------------------------------------------------

def enroll(subdomain, client_id, enrollment_key, worker_override=None, custom_domain=None):
    """
    Exchange the school's enrollment key for this workstation's device token.

    This is also what makes the wizard's "Verify & Connect" button honest: a
    wrong subdomain or key is reported here instead of being written to disk and
    failing silently forever afterwards.
    """
    if custom_domain:
        candidate = worker_override or (
            custom_domain if custom_domain.startswith(("http://", "https://")) else f"https://{custom_domain}"
        )
    else:
        candidate = worker_override or f"https://{subdomain}.{DEFAULT_BASE_DOMAIN}"

    base_url = validate_worker_url(candidate)
    if not base_url:
        raise ValueError("The school address is not a valid server URL.")

    base_url = probe_worker_url(base_url)
    payload = {
        "clientId": client_id,
        "enrollmentKey": enrollment_key,
    }
    if subdomain:
        payload["subdomain"] = subdomain
    if custom_domain:
        clean_custom = (
            custom_domain.replace("https://", "")
            .replace("http://", "")
            .split("/")[0]
            .split(":")[0]
            .strip()
            .lower()
        )
        if clean_custom:
            payload["customDomain"] = clean_custom

    body = json.dumps(payload).encode("utf-8")
    parsed_worker = urlparse(base_url)
    request = Request(
        f"{base_url}/api/devices/enroll",
        data=body,
        headers={
            "Content-Type": "application/json",
            "User-Agent": "LabKioskAgent/enroll",
            "X-Forwarded-Host": parsed_worker.netloc,
        },
    )

    try:
        with urlopen(request, timeout=10) as response:
            data = json.loads(response.read().decode("utf-8"))
    except HTTPError as err:
        detail = "Enrolment was refused."
        try:
            detail = json.loads(err.read().decode("utf-8")).get("error", detail)
        except (ValueError, OSError):
            pass
        raise ValueError(detail) from err
    except (URLError, TimeoutError, socket.timeout) as err:
        raise ValueError(f"Could not reach {base_url}. Check the network connection.") from err

    token = data.get("deviceToken")
    if not token:
        raise ValueError("The server did not return a device token.")

    target_url = data.get("targetUrl") or base_url
    if (parsed_worker.hostname in LOCAL_WORKER_HOSTS or parsed_worker.scheme == "http") and "tenant=" in target_url:
        target_url = f"{base_url}/?tenant={data.get('subdomain', subdomain)}"

    config = {
        "subdomain": data.get("subdomain", subdomain),
        "customDomain": data.get("customDomain", custom_domain or ""),
        "clientId": data.get("clientId", client_id),
        "workerUrl": base_url,
        "deviceToken": token,
        "targetUrl": target_url,
        "configured": True,
    }
    save_config(config)

    with state_lock:
        state["subdomain"] = config["subdomain"]
        state["customDomain"] = config["customDomain"]
        state["clientId"] = config["clientId"]
        state["workerUrl"] = base_url
        state["deviceToken"] = token
        state["targetUrl"] = config["targetUrl"]
        state["isConfigured"] = True

        state["pendingBrowserRestart"] = True

    log(f"Enrolled {config['clientId']} with {config['subdomain'] or config['customDomain']}")
    return {
        "status": "ok",
        "schoolName": data.get("schoolName", subdomain or custom_domain),
        "clientId": config["clientId"],
        "targetUrl": config["targetUrl"],
    }


# --------------------------------------------------------------------------
# Local HTTP API (loopback only)
# --------------------------------------------------------------------------

class LocalApiHandler(BaseHTTPRequestHandler):
    server_version = "LabKioskAgent/2.0"

    def log_message(self, fmt, *args):
        pass  # Suppress per-request noise; the agent logs what matters itself.

    # -- helpers ----------------------------------------------------------

    def _send(self, status, payload, content_type="application/json"):
        body = payload if isinstance(payload, bytes) else json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        self.wfile.write(body)

    def _is_local_caller(self):
        """
        Reject cross-origin calls from a page the student navigated to.

        The socket already only accepts loopback connections, but the kiosk
        browser itself is a loopback client, so a hostile page could otherwise
        drive this API through the user's own browser.
        """
        origin = self.headers.get("Origin")
        if origin is None:
            return True  # Same-origin fetches and non-browser callers send none.
        host = urlparse(origin).hostname
        return host in ("127.0.0.1", "localhost")

    def _read_json(self):
        try:
            length = int(self.headers.get("Content-Length", 0))
        except ValueError:
            return None
        if length <= 0 or length > 64 * 1024:
            return None
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, OSError):
            return None

    # -- routes -----------------------------------------------------------

    def do_GET(self):
        if self.path in ("/setup", "/setup/"):
            with state_lock:
                configured = state["isConfigured"]
            if configured:
                # Once a workstation is enrolled the wizard is no longer an entry
                # point; sending a student back to it would only invite tampering.
                self._send(
                    403,
                    b"<h1>Already configured</h1><p>This workstation is already connected to a school.</p>",
                    "text/html; charset=utf-8",
                )
                return
            try:
                with open(WIZARD_HTML_FILE, "rb") as handle:
                    self._send(200, handle.read(), "text/html; charset=utf-8")
            except OSError as err:
                log(f"Setup wizard missing at {WIZARD_HTML_FILE}: {err}")
                self._send(500, b"<h1>Setup wizard unavailable</h1>", "text/html; charset=utf-8")
            return

        if self.path == "/api/status":
            with state_lock:
                self._send(
                    200,
                    {
                        "clientId": state["clientId"],
                        "clientNum": state["clientNum"],
                        "isLocked": state["isLocked"],
                        "lockMessage": state["lockMessage"],
                        "targetUrl": state["targetUrl"],
                        "broadcastUrl": state.get("broadcastUrl", ""),
                        "broadcastEpoch": state.get("broadcastEpoch", 0),
                        "isConfigured": state["isConfigured"],
                        "baseDomain": DEFAULT_BASE_DOMAIN,
                    },
                )
            return

        self._send(404, {"error": "Not found"})

    def do_POST(self):
        if not self._is_local_caller():
            self._send(403, {"error": "Cross-origin requests are not accepted"})
            return

        if self.path == "/api/setup":
            with state_lock:
                already = state["isConfigured"]
            if already:
                self._send(409, {"error": "This workstation is already enrolled."})
                return

            data = self._read_json()
            if not data:
                self._send(400, {"error": "A JSON body is required"})
                return

            subdomain = str(data.get("subdomain", "")).strip().lower()
            custom_domain = str(data.get("customDomain", "")).strip().lower()
            client_id = str(data.get("clientId", "")).strip().upper()
            enrollment_key = str(data.get("enrollmentKey", "")).strip().upper()
            worker_override = data.get("workerUrl") or os.environ.get("WORKER_URL")

            if (not subdomain and not custom_domain) or not CLIENT_ID_PATTERN.match(client_id) or not enrollment_key:
                self._send(
                    400,
                    {
                        "error": "School subdomain or custom domain, workstation name, and enrollment key are all required."
                    },
                )
                return

            try:
                self._send(200, enroll(subdomain, client_id, enrollment_key, worker_override, custom_domain))
            except ValueError as err:
                self._send(400, {"error": str(err)})
            except Exception as err:  # noqa: BLE001 - surfaced to the wizard UI
                log(f"Unexpected enrolment failure: {err}")
                self._send(500, {"error": "Enrolment failed unexpectedly. Check the agent log."})
            return

        if self.path == "/api/nav":
            data = self._read_json()
            action = (data or {}).get("action")
            keys = {"back": "Alt+Left", "forward": "Alt+Right", "reload": "F5"}
            if action not in keys:
                self._send(400, {"error": "Unsupported navigation action"})
                return
            run_x11(["xdotool", "key", keys[action]])
            self._send(200, {"status": "ok"})
            return

        self._send(404, {"error": "Not found"})


def start_local_server():
    server = HTTPServer((LOCAL_API_HOST, LOCAL_API_PORT), LocalApiHandler)
    log(f"Local API listening on http://{LOCAL_API_HOST}:{LOCAL_API_PORT}")
    server.serve_forever()


# --------------------------------------------------------------------------
# Chromium policy synchronisation
# --------------------------------------------------------------------------

cached_whitelist = None


def sync_chromium_policies(new_whitelist):
    """Write the school's allowlist into Chromium's managed enterprise policy."""
    global cached_whitelist
    if not isinstance(new_whitelist, list):
        return

    sorted_new = sorted({str(d).strip().lower() for d in new_whitelist if str(d).strip()})
    if cached_whitelist == sorted_new:
        return

    with state_lock:
        worker_url = state["workerUrl"]
        target_url = state["targetUrl"]

    allowlist = [
        "127.0.0.1",
        f"127.0.0.1:{LOCAL_API_PORT}",
        "localhost",
        f"localhost:{LOCAL_API_PORT}",
        "file:///opt/labkiosk/*",
    ]

    if worker_url:
        parsed_worker = urlparse(worker_url)
        worker_host = parsed_worker.hostname
        if worker_host:
            allowlist.extend([worker_host, f".{worker_host}"])
            if parsed_worker.port:
                allowlist.extend([f"{worker_host}:{parsed_worker.port}", f".{worker_host}:{parsed_worker.port}"])

    if target_url:
        parsed_target = urlparse(target_url)
        target_host = parsed_target.hostname
        if target_host:
            allowlist.extend([target_host, f".{target_host}"])
            if parsed_target.port:
                allowlist.extend([f"{target_host}:{parsed_target.port}", f".{target_host}:{parsed_target.port}"])

    for domain in sorted_new:
        clean = domain.replace("https://", "").replace("http://", "").split("/")[0].split(":")[0]
        if not clean:
            continue
        allowlist.extend([clean, f".{clean}"])

    policy_data = {
        "HomepageLocation": target_url,
        "HomepageIsNewTabPage": True,
        "NewTabPageLocation": target_url,
        "DeveloperToolsAvailability": 2,
        "PasswordManagerEnabled": False,
        "AutofillAddressEnabled": False,
        "AutofillCreditCardEnabled": False,
        "BookmarkBarEnabled": False,
        "ShowHomeButton": False,
        "PrintingEnabled": False,
        "PromptForDownloadLocation": False,
        "DownloadRestrictions": 3,
        "DefaultDownloadDirectory": "/tmp",
        "SafeBrowsingProtectionLevel": 1,
        "HardwareAccelerationModeEnabled": True,
        "DefaultSearchProviderEnabled": False,
        "BackgroundModeEnabled": False,
        "IncognitoModeAvailability": 1,
        "BrowserSignin": 0,
        "SyncDisabled": True,
        # NOTE: no ExtensionInstallBlocklist here, on purpose. Setting it to ["*"]
        # makes Chromium refuse --load-extension altogether ("Loading of unpacked
        # extensions is disabled by the administrator"), silently disabling this
        # kiosk's own navigation bar and lock curtain; an ExtensionInstallAllowlist
        # entry does not override it. Students cannot install extensions anyway:
        # chrome:// is blocked, the browser runs in kiosk mode with no UI, the Web
        # Store is not allowlisted, and the profile is wiped on every launch.
        "URLBlocklist": [
            "chrome://*",
            "edge://*",
            "about:flags",
            "about:version",
            "javascript://*",
            "file://*",
            "http://*",
            "https://*",
        ],
        "URLAllowlist": list(dict.fromkeys(allowlist)),
    }

    try:
        os.makedirs(os.path.dirname(CHROMIUM_POLICY_FILE), exist_ok=True)
        temp_file = CHROMIUM_POLICY_FILE + ".tmp"
        with open(temp_file, "w", encoding="utf-8") as handle:
            json.dump(policy_data, handle, indent=2)
        os.replace(temp_file, CHROMIUM_POLICY_FILE)
        cached_whitelist = sorted_new
        log(f"Synchronised Chromium policy with {len(sorted_new)} allowed domains")
    except OSError as err:
        # Without this the kiosk silently keeps whatever allowlist it booted with,
        # so it must be loud: it means the policy directory is not writable by the
        # agent's user (see the chown in 01-lockdown.hook.chroot).
        log(f"FAILED updating Chromium policy at {CHROMIUM_POLICY_FILE}: {err}")


# --------------------------------------------------------------------------
# Screen capture & command execution
# --------------------------------------------------------------------------

def restart_browser():
    """
    Ask the kiosk watchdog to relaunch Chromium.

    The watchdog loop in the Openbox autostart (and in the Docker simulator's
    entrypoint) relaunches the browser whenever it exits, re-reading the agent's
    current target URL, so terminating it is how the agent applies a new policy
    or a new home page.
    """
    # Match on the kiosk profile directory rather than on the flags as written:
    # Debian's `chromium` wrapper re-orders arguments and re-execs
    # /usr/lib/chromium/chromium, so a pattern like "chromium --kiosk" never
    # appears in the real command line. This flag is unique to our launch, so it
    # cannot match an unrelated browser.
    pattern = f"--user-data-dir={BROWSER_PROFILE_DIR}"
    try:
        result = subprocess.run(["pkill", "-f", "--", pattern], check=False)
        if result.returncode == 0:
            log("Restarting the browser to apply the new policy")
        else:
            log(f"No running kiosk browser matched {pattern}; nothing to restart")
    except OSError as err:
        log(f"Could not restart the browser: {err}")


def run_x11(argv, **kwargs):
    """Run a command against the local X display, never through a shell."""
    env = dict(os.environ, DISPLAY=os.environ.get("DISPLAY", ":0"))
    return subprocess.run(argv, env=env, check=False, **kwargs)


def capture_thumbnail_base64():
    """Return a small JPEG of the current screen as a data URL, or an empty string."""
    thumb_path = "/tmp/kiosk_thumb.jpg"
    thumb_actual = "/tmp/kiosk_thumb-thumb.jpg"
    try:
        run_x11(
            ["scrot", "-o", "-z", "-q", "35", "-t", "20", thumb_path],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=4,
        )
    except (OSError, subprocess.TimeoutExpired) as err:
        log(f"Screen capture failed: {err}")
        return ""

    target = thumb_actual if os.path.exists(thumb_actual) else thumb_path
    try:
        with open(target, "rb") as handle:
            encoded = base64.b64encode(handle.read()).decode("utf-8")
        return f"data:image/jpeg;base64,{encoded}"
    except OSError as err:
        log(f"Could not read the captured thumbnail: {err}")
        return ""


def execute_command(cmd_data):
    """Apply one directive from the control plane."""
    action = cmd_data.get("action")
    if not action:
        return

    log(f"Executing remote action: {action}")

    if action == "lock":
        with state_lock:
            state["isLocked"] = True
            if cmd_data.get("message"):
                state["lockMessage"] = str(cmd_data["message"])[:280]
    elif action == "unlock":
        with state_lock:
            state["isLocked"] = False
    elif action == "navigate":
        navigate_to(cmd_data.get("url"), cmd_data.get("epoch", 0))
    elif action == "reload":
        run_x11(["xdotool", "key", "F5"])
    elif action == "reboot":
        run_x11(["systemctl", "reboot"])
    elif action == "shutdown":
        run_x11(["systemctl", "poweroff"])
    elif action == "mute":
        run_x11(["amixer", "-D", "pulse", "set", "Master", "mute"])
    else:
        log(f"Ignoring unknown action: {action}")


def navigate_to(new_url, epoch=0):
    """Point the kiosk browser at a teacher-supplied URL."""
    if not new_url:
        return
    parsed = urlparse(str(new_url))
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        log(f"Refusing to navigate to a non-http(s) URL: {new_url}")
        return

    now_epoch = int(epoch) if epoch else int(time.time() * 1000)
    with state_lock:
        state["targetUrl"] = new_url
        state["broadcastUrl"] = new_url
        state["broadcastEpoch"] = now_epoch
        state["isLocked"] = False

    # Immediately ensure domain is in the Chromium allowlist
    sync_chromium_policies([parsed.hostname])
    log(f"Broadcast navigation set to {new_url} (epoch {now_epoch})")


# --------------------------------------------------------------------------
# Telemetry loop
# --------------------------------------------------------------------------

def post_telemetry():
    """One heartbeat. Returns the decoded response, or raises on failure."""
    with state_lock:
        worker_url = state["workerUrl"]
        token = state["deviceToken"]
        payload = {
            "clientNum": state["clientNum"],
            "activeUrl": state["targetUrl"],
            "isLocked": state["isLocked"],
        }

    payload["thumbnail"] = capture_thumbnail_base64()

    parsed_worker = urlparse(worker_url)
    request = Request(
        f"{worker_url}/api/telemetry",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
            "User-Agent": "LabKioskAgent/2.0",
            "X-Forwarded-Host": parsed_worker.netloc,
        },
    )

    with urlopen(request, timeout=8) as response:
        return json.loads(response.read().decode("utf-8"))


def telemetry_loop():
    backoff = HEARTBEAT_SECONDS
    revoked_notified = False

    while True:
        with state_lock:
            configured = state["isConfigured"]

        if not configured:
            # Nothing to report until a teacher completes the wizard.
            time.sleep(HEARTBEAT_SECONDS)
            continue

        try:
            data = post_telemetry()
            backoff = HEARTBEAT_SECONDS
            revoked_notified = False

            if "whitelist" in data:
                sync_chromium_policies(data["whitelist"])

            if "targetUrl" in data and data["targetUrl"]:
                new_target = data["targetUrl"]
                with state_lock:
                    worker_url = state["workerUrl"]
                    sub = state["subdomain"]
                if worker_url:
                    parsed_worker = urlparse(worker_url)
                    if (parsed_worker.hostname in LOCAL_WORKER_HOSTS or parsed_worker.scheme == "http") and "tenant=" in new_target:
                        new_target = f"{worker_url}/?tenant={sub}"
                with state_lock:
                    old_target = state["targetUrl"]
                    if old_target != new_target:
                        state["targetUrl"] = new_target
                        log(f"Target URL updated from {old_target} to {new_target}")

            if "broadcastEpoch" in data and data["broadcastEpoch"]:
                srv_epoch = int(data["broadcastEpoch"])
                with state_lock:
                    local_epoch = state["broadcastEpoch"]
                    if srv_epoch > local_epoch:
                        state["broadcastEpoch"] = srv_epoch
                        state["broadcastUrl"] = data.get("broadcastUrl", "")
                        log(f"Synced broadcast epoch {srv_epoch} from control plane")
            elif "broadcastEpoch" in data and data["broadcastEpoch"] == 0:
                with state_lock:
                    state["broadcastEpoch"] = 0
                    state["broadcastUrl"] = ""

            # Apply a just-completed enrolment to the running browser.
            with state_lock:
                needs_restart = state["pendingBrowserRestart"]
                state["pendingBrowserRestart"] = False
            if needs_restart:
                restart_browser()

            for command in data.get("commands", []):
                execute_command(command)

        except HTTPError as err:
            if err.code in (401, 403):
                if not revoked_notified:
                    log(
                        "The control plane rejected this workstation's device token "
                        "(it may have been decommissioned). Re-enrolment is required."
                    )
                    revoked_notified = True
                backoff = min(backoff * 2, MAX_BACKOFF_SECONDS)
            else:
                log(f"Telemetry rejected with HTTP {err.code}")
                backoff = min(backoff * 2, MAX_BACKOFF_SECONDS)
        except (URLError, TimeoutError, socket.timeout, ValueError, OSError) as err:
            log(f"Telemetry error: {err}")
            backoff = min(backoff * 2, MAX_BACKOFF_SECONDS)

        time.sleep(backoff)


def main():
    load_config()
    with state_lock:
        client_id = state["clientId"]
        configured = state["isConfigured"]

    log(f"Starting Lab Kiosk Agent for {client_id} ({'enrolled' if configured else 'awaiting setup'})")

    threading.Thread(target=start_local_server, daemon=True).start()

    try:
        telemetry_loop()
    except KeyboardInterrupt:
        log("Shutting down.")
        sys.exit(0)


if __name__ == "__main__":
    main()
