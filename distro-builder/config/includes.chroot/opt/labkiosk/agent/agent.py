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
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen

CONFIG_FILE = "/etc/labkiosk/config.json"
WIZARD_HTML_FILE = "/opt/labkiosk/setup/wizard.html"
CHROMIUM_POLICY_FILE = "/etc/chromium/policies/managed/policies.json"
# The single declaration of the static Chromium policy. The ISO build generates
# the boot-time policies.json from this same file (01-lockdown.hook.chroot), so
# the policy a workstation boots with and the one it runs with after enrolling
# cannot drift. Never re-declare these keys here.
CHROMIUM_POLICY_BASE_FILE = "/usr/share/labkiosk/chromium-policy-base.json"
SETUP_URL = "http://127.0.0.1:8888/setup"
# Must match --user-data-dir in the kiosk launch (openbox autostart / entrypoint.sh).
BROWSER_PROFILE_DIR = "/tmp/chromium-profile"
# Fixed by the "key" field in /opt/labkiosk/extension/manifest.json. Keep the two
# in step: if the key changes, this id changes and the extension stops loading.
KIOSK_EXTENSION_ID = "hfjmbeplebjipenkfabncgkpadnjmmoe"
DEFAULT_BASE_DOMAIN = os.environ.get("LABKIOSK_DOMAIN", "labkiosk.akbhoi.com")

# Remote control. The Openbox autostart (and the simulator's entrypoint) writes
# the plaintext x11vnc password it generated for this boot here, mode 600, so
# the agent can hand it to the teacher console over the authenticated
# telemetry channel. The tunnel hostname comes from LABKIOSK_REMOTE_HOST or, on
# the real image, from the first ingress hostname in cloudflared's config.
VNC_SECRET_FILE = "/tmp/labkiosk/vnc.secret"
CLOUDFLARED_CONFIG_FILE = "/etc/cloudflared/config.yml"
REMOTE_HOST_PATTERN = re.compile(r"^\s*-?\s*hostname:\s*['\"]?([A-Za-z0-9.-]+)['\"]?\s*$", re.MULTILINE)

LOCAL_API_HOST = "127.0.0.1"
LOCAL_API_PORT = 8888
HEARTBEAT_SECONDS = 3
MAX_BACKOFF_SECONDS = 60
# Upper bound on the base64 thumbnail in one heartbeat. At a 3-second cadence an
# unbounded screenshot is a standing egress cost on a school's uplink, and the
# control plane documents this ceiling; a frame over budget is dropped rather
# than sent, so the heartbeat itself always gets through.
MAX_THUMBNAIL_BYTES = 256 * 1024

# Hosts that may appear in a workerUrl in addition to a public https origin.
LOCAL_WORKER_HOSTS = {
    "127.0.0.1",
    "localhost",
    "host.docker.internal",
    "host.containers.internal",
}

HOSTNAME_PATTERN = re.compile(r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$")

# Kept in step with the maxlength="64" on the wizard's identifier input.
CLIENT_ID_PATTERN = re.compile(r"^[A-Z0-9][A-Z0-9_-]{0,62}$")

# Whole-disk device nodes the guided installer may target. Kept identical to
# TARGET_DISK_PATTERN in /usr/local/bin/labkiosk-install, which re-checks it
# because sudoers lets the kiosk user invoke that binary directly.
TARGET_DISK_PATTERN = re.compile(r"^/dev/(sd[a-z]|vd[a-z]|nvme[0-9]+n[0-9]+|mmcblk[0-9]+)$")

# A grub-mkpasswd-pbkdf2 digest. The setup wizard derives this in the browser
# with WebCrypto and posts only the digest, so the boot-menu password itself
# never crosses this API. Kept identical to GRUB_PBKDF2_PATTERN in
# /usr/local/bin/labkiosk-install, which re-validates it.
GRUB_PBKDF2_PATTERN = re.compile(r"^grub\.pbkdf2\.sha512\.[0-9]+\.[0-9A-Fa-f]+\.[0-9A-Fa-f]+$")

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


def safe_navigable_url(candidate):
    """
    Return an http(s) URL the kiosk may be pointed at, or "" if it is not one.

    Everything the control plane sends eventually reaches window.location in the
    browser, so a javascript: or data: value arriving as a targetUrl would run in
    whatever page the student is on. navigate_to() already checked this for
    broadcast commands; this makes the same check reusable for the values that
    arrive on the telemetry response and at enrolment.
    """
    if not candidate:
        return ""
    try:
        parsed = urlparse(str(candidate))
    except ValueError:
        return ""
    if parsed.scheme not in ("http", "https") or not parsed.hostname:
        return ""
    return str(candidate)


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


def _read_cached_file(path, cache, parse):
    """
    Read and parse `path`, reusing the last result while its mtime is unchanged.

    Both callers below sit on the 3-second heartbeat and read files that change
    at most once per boot, so re-reading and re-parsing them ~1200 times an hour
    is pure overhead on a thin client.
    """
    try:
        mtime = os.stat(path).st_mtime_ns
    except OSError:
        cache["mtime"] = None
        cache["value"] = ""
        return ""
    if cache.get("mtime") == mtime:
        return cache["value"]
    try:
        with open(path, "r", encoding="utf-8") as handle:
            value = parse(handle.read())
    except OSError:
        value = ""
    cache["mtime"] = mtime
    cache["value"] = value
    return value


_vnc_secret_cache = {}
_remote_host_cache = {}


def read_vnc_password():
    """The per-boot x11vnc password, or an empty string when none was written."""
    return _read_cached_file(
        VNC_SECRET_FILE, _vnc_secret_cache, lambda text: text.strip()[:64]
    )


def detect_remote_host():
    """Hostname the noVNC gateway is reachable on through the tunnel, if any."""
    candidate = os.environ.get("LABKIOSK_REMOTE_HOST", "").strip().lower()
    if not candidate:
        def _first_ingress_hostname(text):
            match = REMOTE_HOST_PATTERN.search(text)
            return match.group(1).lower() if match else ""

        candidate = _read_cached_file(
            CLOUDFLARED_CONFIG_FILE, _remote_host_cache, _first_ingress_hostname
        )
    if candidate and not HOSTNAME_PATTERN.match(candidate):
        log(f"Ignoring remote host {candidate!r}: not a valid hostname")
        return ""
    return candidate


def derive_default_client_id():
    """Suggest a workstation name from the host's last IP octet, else its hostname."""
    try:
        # A UDP connect() only asks the kernel which local address would be
        # used; no packet leaves the machine. The destination is TEST-NET-1
        # (RFC 5737), which is reserved for documentation and never routed, so
        # this cannot depend on a third party's resolver being reachable.
        probe = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            probe.connect(("192.0.2.1", 9))
            local_ip = probe.getsockname()[0]
        finally:
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
        state["targetUrl"] = safe_navigable_url(cfg.get("targetUrl")) or worker_url

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

    target_url = safe_navigable_url(data.get("targetUrl")) or base_url
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
def is_live_session():
    """
    Check if currently running from live installer media (USB/ISO).
    Returns False when booted from an installed internal drive.
    """
    if os.path.exists("/etc/labkiosk-installed"):
        return False
    if os.path.exists("/run/live") or os.path.exists("/lib/live/mount"):
        return True
    try:
        with open("/proc/cmdline", "r") as f:
            if "boot=live" in f.read():
                return True
    except Exception:
        pass
    return False


def kernel_cmdline():
    """The raw kernel command line, or an empty string off Linux."""
    try:
        with open("/proc/cmdline", "r") as handle:
            return handle.read()
    except OSError:
        return ""


def install_mode_requested():
    """
    True when the operator picked "Install Lab Kiosk to Hard Disk / SSD".

    Both boot menus have offered that entry all along, appending
    labkiosk.mode=install, but nothing read it -- the entry booted an ordinary
    live session and the operator still had to find the installer tab by hand.
    This is what makes the menu entry mean what it says.
    """
    return "labkiosk.mode=install" in kernel_cmdline()


def get_available_disks():
    if not is_live_session():
        log("Running on installed disk; disk installer is disabled.")
        return []
    try:
        proc = subprocess.run(
            ["/usr/local/bin/labkiosk-install", "--list-disks"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=10,
        )
        if proc.returncode == 0:
            stdout = proc.stdout.strip()
            idx = stdout.find("[")
            if idx != -1:
                return json.loads(stdout[idx:])
            return json.loads(stdout)
        else:
            log(f"labkiosk-install --list-disks exited with {proc.returncode}: {proc.stderr.strip()}")
    except Exception as e:
        log(f"Error listing disks: {e}")
    return []


def get_install_status():
    try:
        proc = subprocess.run(
            ["/usr/local/bin/labkiosk-install", "--status"],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            timeout=5,
        )
        if proc.returncode == 0:
            stdout = proc.stdout.strip()
            idx = stdout.find("{")
            if idx != -1:
                return json.loads(stdout[idx:])
            return json.loads(stdout)
    except Exception as e:
        log(f"Error reading install status: {e}")
    return {"state": "idle", "step": "Ready", "progress": 0, "error": None}


def start_disk_install(target_disk, grub_password_hash=None):
    def _run():
        try:
            log(f"Starting local disk installation to {target_disk}...")
            argv = ["sudo", "/usr/local/bin/labkiosk-install", "--target", target_disk]
            if grub_password_hash:
                # A PBKDF2 digest, not the password, so its appearance in the
                # process list is not a credential disclosure. sudo resets the
                # environment by default, which is why this is an argument
                # rather than an exported variable.
                argv += ["--grub-password-hash", grub_password_hash]
                log("A boot-menu password was supplied for the installed system.")
            else:
                log("No boot-menu password supplied; the installed GRUB menu will be editable.")
            subprocess.run(argv, check=True)
            log("Local disk installation finished successfully.")
        except Exception as e:
            log(f"Disk installation failed: {e}")

    t = threading.Thread(target=_run, daemon=True)
    t.start()


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
        self.send_header("X-Frame-Options", "DENY")
        if "text/html" in content_type:
            self.send_header(
                "Content-Security-Policy",
                "default-src 'self'; style-src 'self' 'unsafe-inline'; "
                "script-src 'self' 'unsafe-inline'; img-src 'self' data:; "
                "connect-src 'self' http://127.0.0.1:8888; form-action 'none'; "
                "base-uri 'none'; frame-ancestors 'none';",
            )
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

    def _is_expected_host(self):
        """
        Require the request to be addressed to loopback by name.

        Binding to 127.0.0.1 stops packets from the network but not DNS
        rebinding: a page on an attacker's domain whose name briefly resolves to
        127.0.0.1 reaches this server through the student's own browser with an
        Origin the checks above never see on a GET. Such a request still carries
        the attacker's hostname in Host, so that is what is checked here.
        """
        host_header = self.headers.get("Host", "")
        hostname = host_header.rsplit(":", 1)[0].strip("[]").lower() if host_header else ""
        return hostname in ("127.0.0.1", "localhost", "::1")

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
        if not self._is_expected_host():
            self._send(403, {"error": "Unexpected Host header"})
            return
        if not self._is_local_caller():
            self._send(403, {"error": "Cross-origin requests are not accepted"})
            return

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
                live = is_live_session()
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
                        "isLive": True,
                        "isInstalled": not live,
                        # Only meaningful on live media; an installed disk has
                        # nothing to install to and the wizard hides the tab.
                        "installRequested": live and install_mode_requested(),
                    },
                )
            return

        if self.path == "/api/install/disks":
            self._send(200, get_available_disks())
            return

        if self.path == "/api/install/status":
            self._send(200, get_install_status())
            return

        self._send(404, {"error": "Not found"})

    def do_POST(self):
        if not self._is_expected_host():
            self._send(403, {"error": "Unexpected Host header"})
            return
        if not self._is_local_caller():
            self._send(403, {"error": "Cross-origin requests are not accepted"})
            return

        if self.path == "/api/install":
            if not is_live_session():
                self._send(400, {"error": "System is already installed on an internal drive"})
                return
            data = self._read_json()
            if not data:
                self._send(400, {"error": "A JSON body is required"})
                return
            target_disk = str(data.get("targetDisk", "")).strip()
            if not TARGET_DISK_PATTERN.match(target_disk):
                self._send(400, {"error": "Invalid target disk specification"})
                return
            grub_hash = str(data.get("grubPasswordHash", "") or "").strip()
            if grub_hash and not GRUB_PBKDF2_PATTERN.match(grub_hash):
                self._send(400, {"error": "The boot-menu password hash is not in GRUB PBKDF2 format"})
                return

            start_disk_install(target_disk, grub_hash or None)
            self._send(200, {"status": "started", "targetDisk": target_disk})
            return

        if self.path == "/api/reboot":
            subprocess.Popen(["systemctl", "reboot"])
            self._send(200, {"status": "rebooting"})
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

        self._send(404, {"error": "Not found"})


class LocalApiServer(ThreadingHTTPServer):
    """
    Threaded so one slow call cannot stall the rest of the API.

    /api/install/disks shells out with a 10 s timeout. On the single-threaded
    HTTPServer this blocked every other request for that whole window, and the
    browser extension polls /api/status once a second to drive the lock curtain
    -- so a teacher's "lock screens" could arrive up to ten seconds late with
    nothing in the log to explain it.
    """

    daemon_threads = True


def start_local_server():
    try:
        server = LocalApiServer((LOCAL_API_HOST, LOCAL_API_PORT), LocalApiHandler)
    except OSError as err:
        # Loud, because the failure is otherwise invisible: this runs in a
        # daemon thread, and without the API the kiosk browser never learns its
        # target URL and the lock curtain never updates.
        log(
            f"FATAL: could not bind the local API to {LOCAL_API_HOST}:{LOCAL_API_PORT} "
            f"({err}). The setup wizard and the kiosk navigation bar will not work."
        )
        return
    log(f"Local API listening on http://{LOCAL_API_HOST}:{LOCAL_API_PORT}")
    server.serve_forever()


# --------------------------------------------------------------------------
# Chromium policy synchronisation
# --------------------------------------------------------------------------

cached_whitelist = None


def load_policy_base():
    """
    Read the static half of the Chromium managed policy.

    Returns None when the file is missing or malformed, which callers must treat
    as "do not touch the live policy" rather than "write what we have".
    """
    try:
        with open(CHROMIUM_POLICY_BASE_FILE, "r", encoding="utf-8") as handle:
            base = json.load(handle)
    except (OSError, ValueError) as err:
        log(f"Could not read the Chromium policy base at {CHROMIUM_POLICY_BASE_FILE}: {err}")
        return None
    if not isinstance(base, dict) or "URLBlocklist" not in base:
        log(f"{CHROMIUM_POLICY_BASE_FILE} is not a usable policy document.")
        return None
    return base


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

    policy_data = load_policy_base()
    if policy_data is None:
        # Fail closed: overwriting the managed policy with a partial document
        # would drop URLBlocklist and hand the student an unfiltered browser.
        log(
            f"REFUSING to update Chromium policy: {CHROMIUM_POLICY_BASE_FILE} is "
            "unreadable, so the blocklist cannot be reproduced. The browser keeps "
            "the policy it booted with."
        )
        return

    policy_data["HomepageLocation"] = target_url
    policy_data["NewTabPageLocation"] = target_url
    policy_data["URLAllowlist"] = list(dict.fromkeys(allowlist))

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

    # scrot -t writes the full-resolution capture *and* the thumbnail. Only the
    # thumbnail is ever sent, so the full frame is removed rather than left to
    # sit in tmpfs (that is RAM on this image) until the next heartbeat.
    target = thumb_actual if os.path.exists(thumb_actual) else thumb_path
    try:
        with open(target, "rb") as handle:
            encoded = base64.b64encode(handle.read()).decode("utf-8")
    except OSError as err:
        log(f"Could not read the captured thumbnail: {err}")
        return ""
    finally:
        if target != thumb_path:
            try:
                os.unlink(thumb_path)
            except OSError:
                pass

    if len(encoded) > MAX_THUMBNAIL_BYTES:
        log(
            f"Dropping a {len(encoded) // 1024} KB thumbnail: over the "
            f"{MAX_THUMBNAIL_BYTES // 1024} KB budget for one heartbeat."
        )
        return ""
    return f"data:image/jpeg;base64,{encoded}"


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
        # Plain ALSA: the image ships alsa-utils and no sound server.
        run_x11(["amixer", "-q", "set", "Master", "mute"])
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

    # Make sure the lesson's host is allowed right away, without dropping the
    # rest of the school's allowlist until the next heartbeat replaces it.
    sync_chromium_policies(sorted(set(cached_whitelist or []) | {parsed.hostname.lower()}))
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

    # Remote-control details, sent only when the workstation actually has them
    # so the control plane keeps whatever it already knows otherwise.
    vnc_password = read_vnc_password()
    if vnc_password:
        payload["vncPassword"] = vnc_password
    remote_host = detect_remote_host()
    if remote_host:
        payload["remoteHost"] = remote_host

    request = Request(
        f"{worker_url}/api/telemetry",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
            "User-Agent": "LabKioskAgent/2.0",
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

            new_target = safe_navigable_url(data.get("targetUrl"))
            if "targetUrl" in data and data["targetUrl"] and not new_target:
                log(f"Ignoring an unusable targetUrl from the control plane: {data['targetUrl']!r}")
            if new_target:
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
                        state["broadcastUrl"] = safe_navigable_url(data.get("broadcastUrl"))
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
