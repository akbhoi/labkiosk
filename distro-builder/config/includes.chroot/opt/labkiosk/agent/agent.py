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
import pwd
import re
import socket
import subprocess
import sys
import threading
import time
import base64
import grp
import hashlib
import hmac
import ipaddress
import secrets
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import ProxyHandler, Request, build_opener

CONFIG_FILE = "/etc/labkiosk/config.json"
# Where the Openbox autostart redirects this agent's output. A kiosk has no
# terminal, no getty and no SSH, and file:// is blocked in the browser, so
# GET /api/log is the only way anyone can read it on a real workstation.
AGENT_LOG_FILE = "/tmp/lab-agent.log"
MAX_LOG_BYTES = 64 * 1024
PROXY_CONFIG_FILE = "/etc/labkiosk/proxy.json"
GRUB_PASSWORD_FILE = "/etc/grub.d/01_labkiosk_password"
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
KIOSK_EXTENSION_ORIGIN = f"chrome-extension://{KIOSK_EXTENSION_ID}"
# Origins already named in the agent log, so a page in a loop cannot flood it.
_rejected_origins = set()
_rejected_origins_lock = threading.Lock()
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
GRUB_PASSWORD_LINE = re.compile(
    r"^\s*password_pbkdf2\s+\S+\s+(grub\.pbkdf2\.sha512\.[0-9]+\.[0-9A-Fa-f]+\.[0-9A-Fa-f]+)\s*$",
    re.MULTILINE,
)

# Post-install network changes are gated by the boot-menu password. A
# successful /api/admin/verify issues a short-lived token that the mutating
# network route requires, so the gate lives here and not only in the UI.
ADMIN_TOKEN_HEADER = "X-LabKiosk-Admin"
ADMIN_SESSION_SECONDS = 600
ADMIN_MAX_FAILURES = 5
ADMIN_LOCKOUT_SECONDS = 60

# Network input accepted by /api/network/configure. Everything reaches nmcli as
# an argument vector, never through a shell, but a value that starts with "-"
# or carries a newline would still be read as something other than data.
NET_DEVICE_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,14}$")
PROXY_HOST_PATTERN = re.compile(r"^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$")
PROXY_BYPASS_PATTERN = re.compile(r"^[A-Za-z0-9*.\-:\[\]/<>]{1,253}$")
LOOPBACK_NO_PROXY = ("localhost", "127.0.0.1", "::1")
NMCLI_TIMEOUT_SECONDS = 15
# A heartbeat that reached the control plane this recently proves the
# workstation is online even where the generic probes below are firewalled
# (schools that force all traffic through a proxy commonly block both).
ONLINE_HEARTBEAT_WINDOW_SECONDS = 20

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
    # time.monotonic() of the last heartbeat the control plane accepted.
    "lastHeartbeatOk": 0.0,
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

    # Said at every start, because the agent log is the only place a workstation
    # with no terminal can be asked why yesterday's enrolment is gone.
    if not enrolment_is_persistent():
        directory = os.path.dirname(CONFIG_FILE)
        fstype = mounted_fstype(directory)
        log(f"WARNING: {directory} is "
            + (f"a {fstype} mount" if fstype else "not a mount point")
            + ", not the LABKIOSK_DATA partition. An enrolment made now lives in "
              "RAM and will be gone at the next reboot.")

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


# Filesystems that exist only until the power goes off. An overlay belongs here
# because overlayroot mounts one over every fstab entry unless it is told
# recurse=0: the data partition is then mounted read-only somewhere else and
# /etc/labkiosk is an overlay whose upper layer is the RAM tmpfs. It passes
# every "is it mounted?" test and still loses the enrolment at reboot, which is
# why this checks what the mount *is* and not merely that there is one.
EPHEMERAL_FSTYPES = {"overlay", "overlayfs", "tmpfs", "ramfs"}


def mounted_fstype(path):
    """The filesystem type mounted exactly at path, or "" if nothing is."""
    try:
        target = os.path.realpath(path)
    except OSError:
        return ""

    def unescape(field):
        # /proc/mounts writes spaces, tabs, newlines and backslashes in octal.
        for code, char in ((r"\040", " "), (r"\011", "\t"), (r"\012", "\n"), (r"\134", "\\")):
            field = field.replace(code, char)
        return field

    found = ""
    try:
        with open("/proc/mounts", "r", encoding="utf-8", errors="replace") as handle:
            for line in handle:
                fields = line.split()
                if len(fields) >= 3 and unescape(fields[1]) == target:
                    found = fields[2]  # A later mount shadows an earlier one.
    except OSError:
        return ""
    return found


def enrolment_is_persistent():
    """
    Will something written to /etc/labkiosk still be there after a power-off?

    On an installed workstation that path is the LABKIOSK_DATA partition and
    everything else is an overlay in RAM (Rule 1). Two ways to lose that: no
    mount at all, so the write lands in the root overlay; or a mount that is
    itself made of RAM, which is what overlayroot does to every fstab entry
    unless it is configured with recurse=0. Both look enrolled until somebody
    reboots the workstation. Live media keeps nothing by design, so the question
    only means anything once installed.
    """
    if is_live_session():
        return True
    directory = os.path.dirname(CONFIG_FILE)
    if not os.path.ismount(directory):
        return False
    return mounted_fstype(directory) not in EPHEMERAL_FSTYPES


def describe_config_dir():
    """
    Why the agent cannot write its configuration, in terms someone can act on.

    A bare "[Errno 13] Permission denied" leaves a workstation that has no shell
    with nowhere to go. On an installed disk this directory is the LABKIOSK_DATA
    partition, so the answer is almost always its ownership.
    """
    directory = os.path.dirname(CONFIG_FILE)
    try:
        info = os.stat(directory)
    except OSError as err:
        return f"{directory} cannot be inspected ({err})."

    def owner_name(uid, resolver):
        try:
            return resolver(uid)[0]
        except (KeyError, OSError):
            return str(uid)

    owner = owner_name(info.st_uid, pwd.getpwuid)
    group = owner_name(info.st_gid, grp.getgrgid)
    mounted = os.path.ismount(directory)
    me = owner_name(os.getuid(), pwd.getpwuid)
    where = (
        f"{directory} (a separate mount point) is owned by" if mounted
        else f"{directory} is owned by"
    )
    if enrolment_is_persistent():
        fix = "It has to be owned by the agent's user."
    elif mounted:
        fix = (f"It is also a {mounted_fstype(directory)} mount rather than the "
               "LABKIOSK_DATA partition, so anything written here is in RAM and "
               "is gone at the next reboot -- reinstall from a current ISO.")
    else:
        fix = ("It is also not a mount point, so the LABKIOSK_DATA partition is "
               "not mounted here -- reinstall this workstation from a current ISO, "
               "because a directory in the RAM overlay cannot keep an enrolment.")
    return (
        f"{where} {owner}:{group} ({info.st_uid}:{info.st_gid}) "
        f"with mode {info.st_mode & 0o777:04o}, and this agent runs as "
        f"{me} ({os.getuid()}). {fix}"
    )


def save_config(payload):
    """Persist enrolment with owner-only permissions; it contains a device token."""
    directory = os.path.dirname(CONFIG_FILE)
    temp_path = CONFIG_FILE + ".tmp"
    try:
        os.makedirs(directory, exist_ok=True)
        with open(temp_path, "w", encoding="utf-8") as handle:
            json.dump(payload, handle, indent=2)
            handle.flush()
            # The next thing that happens to a freshly enrolled workstation is
            # usually a reboot, and often not a graceful one. Without these the
            # rename can still be in the page cache when the power goes.
            os.fsync(handle.fileno())
        os.chmod(temp_path, 0o600)
        os.replace(temp_path, CONFIG_FILE)
    except OSError as err:
        raise RuntimeError(
            f"could not save the enrolment to {CONFIG_FILE} ({err.strerror}). "
            f"{describe_config_dir()} The school has already registered this "
            "workstation, so enrol again once the permission is corrected."
        ) from err

    # Best effort, and deliberately outside the block above: the enrolment is
    # already written, so a filesystem that will not fsync a directory handle
    # must not turn a successful save into a failure.
    try:
        dir_fd = os.open(directory, os.O_RDONLY)
        try:
            os.fsync(dir_fd)
        finally:
            os.close(dir_fd)
    except OSError as err:
        log(f"Could not flush {directory} after saving the enrolment: {err}")


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
        with open_url(request, timeout=10) as response:
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
    persistent = enrolment_is_persistent()
    if not persistent:
        log(f"WARNING: {os.path.dirname(CONFIG_FILE)} is not the LABKIOSK_DATA "
            f"partition (it is {mounted_fstype(os.path.dirname(CONFIG_FILE)) or 'not a mount point'}), "
            "so this enrolment lives in RAM and will be gone at the next reboot.")
    return {
        "status": "ok",
        "schoolName": data.get("schoolName", subdomain or custom_domain),
        "clientId": config["clientId"],
        "targetUrl": config["targetUrl"],
        # The wizard shows this instead of a plain success: the workstation is
        # usable now but will forget everything when it is switched off.
        "persistent": persistent,
        "warning": "" if persistent else (
            "This workstation cannot store its enrolment. /etc/labkiosk is "
            + (f"a {mounted_fstype(os.path.dirname(CONFIG_FILE))} mount in RAM"
               if mounted_fstype(os.path.dirname(CONFIG_FILE))
               else "not the persistent data partition")
            + ", so the school address and the device token are only in memory "
              "and will be gone after the next reboot. Reinstall from a current "
              "Lab Kiosk ISO to fix it."
        ),
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

    threading.Thread(target=_run, daemon=True).start()


# --------------------------------------------------------------------------
# Network configuration, proxy and administrator gate
# --------------------------------------------------------------------------

_last_connectivity_check = {"time": 0.0, "result": None}
_connectivity_lock = threading.Lock()

DEFAULT_PROXY_CONFIG = {"enabled": False, "host": "", "port": 8080, "bypass": ""}


def validate_proxy_config(raw):
    """
    Normalise a proxy setting, raising ValueError on anything unusable.

    The result is written into Chromium's managed policy and the agent's own
    environment, and is read back from a file the kiosk user can write, so it is
    validated on every load rather than trusted.
    """
    raw = raw if isinstance(raw, dict) else {}
    enabled = bool(raw.get("enabled", False))
    host = str(raw.get("host", "") or "").strip()
    bypass_raw = str(raw.get("bypass", "") or "")
    try:
        port = int(raw.get("port", 8080) or 8080)
    except (TypeError, ValueError) as err:
        raise ValueError("Proxy port must be a number") from err

    if not enabled:
        return dict(DEFAULT_PROXY_CONFIG)
    if not host:
        raise ValueError("Proxy host is required when the proxy is enabled")
    is_ip = True
    try:
        ipaddress.ip_address(host)
    except ValueError:
        is_ip = False
    if not is_ip and not PROXY_HOST_PATTERN.match(host):
        raise ValueError("Proxy host must be a hostname or an IP address")
    if not 1 <= port <= 65535:
        raise ValueError("Proxy port must be between 1 and 65535")

    bypass = []
    for entry in (item.strip() for item in bypass_raw.split(",")):
        if not entry:
            continue
        if not PROXY_BYPASS_PATTERN.match(entry):
            raise ValueError(f"Invalid proxy bypass entry: {entry[:40]}")
        bypass.append(entry)
    return {"enabled": True, "host": host, "port": port, "bypass": ",".join(bypass)}


def proxy_server_address(cfg):
    host = cfg["host"]
    return f"[{host}]:{cfg['port']}" if ":" in host else f"{host}:{cfg['port']}"


def load_proxy_config():
    """The saved proxy, or the disabled default when there is none or it is invalid."""
    try:
        with open(PROXY_CONFIG_FILE, "r", encoding="utf-8") as handle:
            return validate_proxy_config(json.load(handle))
    except FileNotFoundError:
        return dict(DEFAULT_PROXY_CONFIG)
    except (OSError, ValueError) as err:
        log(f"Ignoring unusable proxy configuration at {PROXY_CONFIG_FILE}: {err}")
        return dict(DEFAULT_PROXY_CONFIG)


def save_proxy_config(cfg):
    """Persist the proxy atomically. Raises OSError so the caller can report it."""
    os.makedirs(os.path.dirname(PROXY_CONFIG_FILE), exist_ok=True)
    temp_file = PROXY_CONFIG_FILE + ".tmp"
    with open(temp_file, "w", encoding="utf-8") as handle:
        json.dump(cfg, handle, indent=2)
    os.chmod(temp_file, 0o600)
    os.replace(temp_file, PROXY_CONFIG_FILE)


def apply_proxy_to_environment(cfg):
    """
    Point the agent's own outbound requests at the proxy.

    open_url() builds its opener per request, so a change here applies to the
    very next heartbeat. Loopback is always exempt: the local worker used in
    development must never be sent through a school proxy.
    """
    names = ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "no_proxy", "NO_PROXY")
    for name in names:
        os.environ.pop(name, None)
    if not cfg.get("enabled"):
        return
    proxy_url = f"http://{proxy_server_address(cfg)}"
    bypass = [item for item in cfg.get("bypass", "").split(",") if item]
    no_proxy = ",".join(list(LOOPBACK_NO_PROXY) + bypass)
    for name in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY"):
        os.environ[name] = proxy_url
    os.environ["no_proxy"] = no_proxy
    os.environ["NO_PROXY"] = no_proxy


def open_url(request, timeout):
    """urlopen() that honours the proxy as it is now, not as it was at first use."""
    return build_opener(ProxyHandler()).open(request, timeout=timeout)


def run_nmcli(args, timeout=NMCLI_TIMEOUT_SECONDS):
    """Run nmcli with an argument vector and return the completed process."""
    return subprocess.run(
        ["nmcli", *args],
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=timeout,
        check=False,
    )


def split_nmcli_terse(line):
    """Split one `nmcli -t` line on unescaped colons and unescape each field."""
    fields = re.split(r"(?<!\\):", line)
    return [field.replace("\\:", ":").replace("\\\\", "\\") for field in fields]


def read_carrier(device):
    try:
        with open(f"/sys/class/net/{device}/carrier", "r", encoding="ascii") as handle:
            return handle.read().strip() == "1"
    except OSError:
        return False


def get_network_interfaces():
    interfaces = []
    try:
        proc = run_nmcli(["-t", "-f", "DEVICE,TYPE,STATE,CONNECTION", "device"], timeout=5)
    except (OSError, subprocess.TimeoutExpired) as err:
        log(f"Error querying network interfaces: {err}")
        return interfaces
    if proc.returncode != 0:
        log(f"nmcli device listing failed: {proc.stderr.strip()}")
        return interfaces
    for line in proc.stdout.splitlines():
        parts = split_nmcli_terse(line)
        if len(parts) < 3:
            continue
        device, dev_type, dev_state = parts[0], parts[1].lower(), parts[2].lower()
        if dev_type not in ("ethernet", "wifi"):
            continue
        interfaces.append({
            "device": device,
            "type": dev_type,
            "state": dev_state,
            "connection": parts[3] if len(parts) > 3 else "",
            "carrier": read_carrier(device) or dev_state == "connected",
        })
    return interfaces


def scan_wifi_networks():
    networks = {}
    try:
        proc = run_nmcli(
            ["-t", "-f", "IN-USE,SSID,SIGNAL,BARS,SECURITY", "device", "wifi", "list", "--rescan", "yes"],
            timeout=20,
        )
    except (OSError, subprocess.TimeoutExpired) as err:
        log(f"Error scanning Wi-Fi: {err}")
        return []
    if proc.returncode != 0:
        log(f"Wi-Fi scan failed: {proc.stderr.strip()}")
        return []
    for line in proc.stdout.splitlines():
        parts = split_nmcli_terse(line)
        if len(parts) < 5:
            continue
        ssid = parts[1]
        if not ssid or ssid == "--":
            continue
        try:
            signal = int(parts[2].strip())
        except ValueError:
            signal = 0
        security = parts[4].strip()
        if security in ("", "--"):
            security = "Open"
        if ssid not in networks or signal > networks[ssid]["signal"]:
            networks[ssid] = {
                "ssid": ssid,
                "signal": signal,
                "bars": parts[3].strip(),
                "security": security,
                "inUse": parts[0].strip() == "*",
            }
    return sorted(networks.values(), key=lambda item: item["signal"], reverse=True)


def _probe_tcp(host, port, timeout=2.5):
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def test_connectivity(force=False):
    """
    Best-effort reachability check, cached for five seconds.

    Probes run outside any agent state lock: offline, they take several
    seconds, and /api/status is polled every second.
    """
    with _connectivity_lock:
        now = time.monotonic()
        cached = _last_connectivity_check["result"]
        if cached is not None and not force and now - _last_connectivity_check["time"] < 5:
            return cached

        details = []
        try:
            socket.getaddrinfo("cloudflare.com", 443, socket.AF_UNSPEC, socket.SOCK_STREAM)
            dns_ok = True
            details.append("DNS resolution OK")
        except OSError as err:
            dns_ok = False
            details.append(f"DNS lookup failed: {err}")

        internet_ok = False
        for host in ("1.1.1.1", "8.8.8.8"):
            if _probe_tcp(host, 53):
                internet_ok = True
                details.append(f"Internet route reachable ({host})")
                break
        if not internet_ok:
            details.append("Public resolvers unreachable")

        proxy_cfg = load_proxy_config()
        proxy_ok = None
        if proxy_cfg["enabled"]:
            proxy_ok = _probe_tcp(proxy_cfg["host"], proxy_cfg["port"])
            details.append(f"Proxy {'reachable' if proxy_ok else 'unreachable'}")

        with state_lock:
            last_heartbeat = state["lastHeartbeatOk"]
        heartbeat_ok = last_heartbeat > 0 and now - last_heartbeat < ONLINE_HEARTBEAT_WINDOW_SECONDS
        if heartbeat_ok:
            details.append("Control plane reachable")

        result = {
            "ok": bool(internet_ok or dns_ok or proxy_ok or heartbeat_ok),
            "dns": dns_ok,
            "internet": internet_ok,
            "proxy": proxy_ok,
            "controlPlane": heartbeat_ok,
            "details": "; ".join(details),
        }
        _last_connectivity_check["time"] = now
        _last_connectivity_check["result"] = result
        return result


def read_ip_details(device):
    ipv4 = {"address": "", "gateway": "", "dns": []}
    ipv6 = {"address": "", "gateway": "", "dns": []}
    try:
        proc = run_nmcli(
            ["-t", "-f", "IP4.ADDRESS,IP4.GATEWAY,IP4.DNS,IP6.ADDRESS,IP6.GATEWAY,IP6.DNS", "device", "show", device],
            timeout=5,
        )
    except (OSError, subprocess.TimeoutExpired) as err:
        log(f"Error fetching IP details for {device}: {err}")
        return ipv4, ipv6
    if proc.returncode != 0:
        return ipv4, ipv6
    for line in proc.stdout.splitlines():
        key, _, value = line.partition(":")
        value = value.strip()
        if not value:
            continue
        target = ipv4 if key.startswith("IP4.") else ipv6
        if ".ADDRESS" in key and not target["address"]:
            target["address"] = value
        elif ".GATEWAY" in key:
            target["gateway"] = value
        elif ".DNS" in key:
            target["dns"].append(value)
    return ipv4, ipv6


# Everything the wizard needs to render the settings this workstation is
# actually running on. Without it the form always opened on its defaults and
# looked as though nothing had ever been configured.
PROFILE_FIELDS = ",".join([
    "connection.id", "connection.type", "connection.interface-name",
    "802-11-wireless.ssid", "802-11-wireless.hidden",
    "ipv4.method", "ipv4.addresses", "ipv4.gateway", "ipv4.dns", "ipv4.ignore-auto-dns",
    "ipv6.method", "ipv6.addresses", "ipv6.gateway", "ipv6.dns", "ipv6.ignore-auto-dns",
])
KIOSK_CONNECTIONS = ("Kiosk-Ethernet", "Kiosk-Wifi")


def _profile_family(raw, prefix):
    """Turn one address family's nmcli properties back into a wizard mode."""
    method = raw.get(f"{prefix}.method", "").lower()
    dns = [item for item in re.split(r"[,;]\s*", raw.get(f"{prefix}.dns", "")) if item]
    addresses = [item for item in re.split(r"[,;]\s*", raw.get(f"{prefix}.addresses", "")) if item]
    ignores_auto_dns = raw.get(f"{prefix}.ignore-auto-dns", "").lower() in ("yes", "true")
    if method == "manual":
        mode = "manual"
    elif method in ("disabled", "ignore", "link-local"):
        mode = "disabled"
    elif dns and ignores_auto_dns:
        mode = "custom_dns"
    else:
        mode = "auto"
    return {
        "mode": mode,
        "address": addresses[0] if addresses else "",
        "gateway": raw.get(f"{prefix}.gateway", ""),
        "dns": dns,
    }


def read_connection_profile(name):
    """The saved settings of one NetworkManager profile, or None if there is none."""
    if not name or name in ("--", "*"):
        return None
    try:
        proc = run_nmcli(["-t", "-f", PROFILE_FIELDS, "connection", "show", "id", name], timeout=5)
    except (OSError, subprocess.TimeoutExpired) as err:
        log(f"Could not read the profile {name}: {err}")
        return None
    if proc.returncode != 0:
        return None

    raw = {}
    for line in proc.stdout.splitlines():
        key, _, value = line.partition(":")
        value = value.strip()
        raw[key.strip()] = "" if value == "--" else value.replace("\\:", ":")

    con_type = raw.get("connection.type", "")
    return {
        "name": raw.get("connection.id", name),
        "type": "wifi" if "wireless" in con_type else "ethernet",
        "device": raw.get("connection.interface-name", ""),
        "ssid": raw.get("802-11-wireless.ssid", ""),
        "hidden": raw.get("802-11-wireless.hidden", "").lower() in ("yes", "true"),
        "ipv4": _profile_family(raw, "ipv4"),
        "ipv6": _profile_family(raw, "ipv6"),
    }


def read_saved_wifi_psk(con_name, ssid):
    """
    The passphrase already stored for this SSID.

    configure_network() replaces the profile outright, so without this, changing
    a DNS server would mean typing the Wi-Fi password again -- and the wizard
    never receives it back, so it could not resend it either.
    """
    try:
        proc = run_nmcli(
            ["-s", "-t", "-f", "802-11-wireless.ssid,802-11-wireless-security.psk",
             "connection", "show", "id", con_name],
            timeout=5,
        )
    except (OSError, subprocess.TimeoutExpired):
        return ""
    if proc.returncode != 0:
        return ""
    saved = {}
    for line in proc.stdout.splitlines():
        key, _, value = line.partition(":")
        saved[key.strip()] = value.strip().replace("\\:", ":")
    if saved.get("802-11-wireless.ssid", "") != ssid:
        return ""
    return saved.get("802-11-wireless-security.psk", "")


def get_network_status():
    interfaces = get_network_interfaces()
    active = next((iface for iface in interfaces if iface["state"] == "connected"), None)
    ipv4 = {"address": "", "gateway": "", "dns": []}
    ipv6 = {"address": "", "gateway": "", "dns": []}
    if active:
        ipv4, ipv6 = read_ip_details(active["device"])
    profile = None
    candidates = []
    if active and active["connection"]:
        candidates.append(active["connection"])
    candidates.extend(name for name in KIOSK_CONNECTIONS if name not in candidates)
    for name in candidates:
        profile = read_connection_profile(name)
        if profile:
            break

    connectivity = test_connectivity()
    return {
        "online": connectivity["ok"],
        "profile": profile,
        "activeType": active["type"] if active else "none",
        "activeDevice": active["device"] if active else "",
        "activeConnection": active["connection"] if active else "",
        "ipv4": ipv4,
        "ipv6": ipv6,
        "proxy": load_proxy_config(),
        "connectivity": connectivity,
        "interfaces": interfaces,
        "adminRequired": admin_auth_required(),
    }


def _ip_list(values, version, label):
    if not isinstance(values, list):
        raise ValueError(f"{label} must be a list")
    result = []
    for value in values[:3]:
        text = str(value or "").strip()
        if not text:
            continue
        try:
            addr = ipaddress.ip_address(text)
        except ValueError as err:
            raise ValueError(f"{label}: '{text[:45]}' is not an IP address") from err
        if addr.version != version:
            raise ValueError(f"{label}: '{text}' is not an IPv{version} address")
        result.append(str(addr))
    return result


def ip_settings(family, raw):
    """
    Translate one address family's wizard settings into nmcli properties.

    Validated completely before anything is changed, so a typo can never leave
    the workstation with its old profile deleted and no new one in its place.
    """
    version = 4 if family == "ipv4" else 6
    raw = raw if isinstance(raw, dict) else {}
    mode = str(raw.get("mode", "auto"))
    modes = ("auto", "custom_dns", "manual") + (("disabled",) if version == 6 else ())
    if mode not in modes:
        raise ValueError(f"Unknown {family} mode: {mode[:20]}")
    if mode == "disabled":
        return [f"{family}.method", "disabled"]
    if mode == "auto":
        return [f"{family}.method", "auto"]

    dns = _ip_list(raw.get("dns", []), version, f"IPv{version} DNS")
    if mode == "custom_dns":
        if not dns:
            raise ValueError(f"At least one IPv{version} DNS server is required")
        return [f"{family}.method", "auto", f"{family}.ignore-auto-dns", "yes", f"{family}.dns", ",".join(dns)]

    address = str(raw.get("address", "") or "").strip()
    try:
        iface = ipaddress.ip_interface(address)
    except ValueError as err:
        raise ValueError(f"IPv{version} static address must look like {'192.168.1.50/24' if version == 4 else '2001:db8::50/64'}") from err
    if iface.version != version or "/" not in address:
        raise ValueError(f"IPv{version} static address needs a prefix length, e.g. /24")
    props = [f"{family}.method", "manual", f"{family}.addresses", str(iface)]
    gateway = _ip_list([raw.get("gateway", "")], version, f"IPv{version} gateway")
    if gateway:
        props += [f"{family}.gateway", gateway[0]]
    if dns:
        props += [f"{family}.dns", ",".join(dns)]
    return props


def wifi_settings(data, fallback_psk=""):
    ssid = str(data.get("ssid", "") or "")
    if not ssid.strip() or len(ssid.encode("utf-8")) > 32 or any(ord(ch) < 32 for ch in ssid):
        raise ValueError("A Wi-Fi network name (1-32 bytes) is required")
    # Never strip a passphrase: leading and trailing spaces are legal in WPA.
    password = str(data.get("password", "") or "") or fallback_psk
    security = str(data.get("security", "") or "").upper()
    if "802.1X" in security:
        raise ValueError("WPA-Enterprise (802.1X) networks are not supported by the setup wizard")
    props = ["802-11-wireless.ssid", ssid]
    if bool(data.get("hidden", False)):
        props += ["802-11-wireless.hidden", "yes"]
    if password:
        is_hex_key = len(password) == 64 and all(ch in "0123456789abcdefABCDEF" for ch in password)
        if not (8 <= len(password) <= 63 or is_hex_key):
            raise ValueError("A WPA passphrase is 8 to 63 characters long")
        key_mgmt = "sae" if "WPA3" in security and "WPA2" not in security else "wpa-psk"
        props += ["wifi-sec.key-mgmt", key_mgmt, "wifi-sec.psk", password]
    elif security and security != "OPEN":
        raise ValueError("This Wi-Fi network requires a password")
    return props


def configure_network(data):
    iface_type = str(data.get("interfaceType", "ethernet")).lower()
    if iface_type not in ("ethernet", "wifi"):
        raise ValueError(f"Unknown interface type: {iface_type[:20]}")
    device = str(data.get("device", "") or "").strip()
    if device:
        known = {iface["device"] for iface in get_network_interfaces() if iface["type"] == iface_type}
        if not NET_DEVICE_PATTERN.match(device) or device not in known:
            raise ValueError(f"Unknown {iface_type} adapter: {device[:20]}")

    if iface_type == "wifi":
        # An empty password field means "keep the one already saved for this
        # SSID", so changing DNS does not require retyping the Wi-Fi key.
        saved_psk = ""
        if not str(data.get("password", "") or ""):
            saved_psk = read_saved_wifi_psk("Kiosk-Wifi", str(data.get("ssid", "") or ""))
        type_props = wifi_settings(data, saved_psk)
    else:
        type_props = []
    ip_props = ip_settings("ipv4", data.get("ipv4")) + ip_settings("ipv6", data.get("ipv6"))
    proxy_cfg = validate_proxy_config(data.get("proxy"))

    con_name = "Kiosk-Wifi" if iface_type == "wifi" else "Kiosk-Ethernet"
    run_nmcli(["connection", "delete", "id", con_name])
    add_args = ["connection", "add", "type", iface_type, "con-name", con_name,
                "ifname", device or "*", "connection.autoconnect", "yes",
                "connection.autoconnect-priority", "10"]
    proc = run_nmcli(add_args + type_props + ip_props)
    if proc.returncode != 0:
        raise RuntimeError(f"Could not create the {iface_type} profile: {proc.stderr.strip()}")

    up = run_nmcli(["--wait", "30", "connection", "up", "id", con_name], timeout=40)
    if up.returncode != 0:
        raise RuntimeError(f"The connection did not come up: {up.stderr.strip()}")

    proxy_changed = proxy_cfg != load_proxy_config()
    save_proxy_config(proxy_cfg)
    apply_proxy_to_environment(proxy_cfg)
    if proxy_changed:
        sync_chromium_policies(list(cached_whitelist or []), force=True)
        with state_lock:
            # Applied at the next successful heartbeat, as after enrolment.
            state["pendingBrowserRestart"] = state["isConfigured"]
    log(f"Network profile {con_name} applied ({iface_type}, proxy {'on' if proxy_cfg['enabled'] else 'off'})")

    return {
        "status": "ok",
        "connection": con_name,
        "connectivity": test_connectivity(force=True),
    }


def read_agent_log(max_bytes=MAX_LOG_BYTES):
    """
    The tail of the agent log, for the wizard's diagnostics panel.

    Returns a message rather than raising when the log is missing: an empty log
    is itself the answer when the agent never started.
    """
    try:
        size = os.path.getsize(AGENT_LOG_FILE)
        with open(AGENT_LOG_FILE, "r", encoding="utf-8", errors="replace") as handle:
            if size > max_bytes:
                handle.seek(size - max_bytes)
                handle.readline()  # Drop the partial line the seek landed in.
            return handle.read()
    except FileNotFoundError:
        return (
            f"{AGENT_LOG_FILE} does not exist.\n"
            "The agent writes it through the Openbox autostart, so this workstation "
            "is either running the agent some other way or it never started."
        )
    except OSError as err:
        return f"Could not read {AGENT_LOG_FILE}: {err}"


# -- administrator gate -----------------------------------------------------

_admin_lock = threading.Lock()
_admin_sessions = {}
_admin_failures = {"count": 0, "lockedUntil": 0.0}


def admin_auth_required():
    """Only an installed workstation is gated; live media is setup mode."""
    return not is_live_session()


def read_admin_password_hash():
    """
    The boot-menu PBKDF2 digest, or None when this installation has none.

    None is a deliberate state: the wizard warns before installing without a
    password that settings stay unlocked. A file that exists but cannot be
    read or parsed raises instead, so a damaged gate stays shut.
    """
    try:
        with open(GRUB_PASSWORD_FILE, "r", encoding="utf-8") as handle:
            content = handle.read()
    except FileNotFoundError:
        return None
    match = GRUB_PASSWORD_LINE.search(content)
    if not match:
        raise ValueError(f"{GRUB_PASSWORD_FILE} has no password_pbkdf2 entry")
    return match.group(1)


def verify_admin_password(password):
    digest = read_admin_password_hash()
    if digest is None:
        return True
    _, _, _, rounds, salt_hex, expected_hex = digest.split(".")
    rounds = int(rounds)
    if not 1 <= rounds <= 10_000_000:
        raise ValueError("Implausible PBKDF2 round count in the boot-menu password")
    expected = bytes.fromhex(expected_hex)
    derived = hashlib.pbkdf2_hmac(
        "sha512", password.encode("utf-8"), bytes.fromhex(salt_hex), rounds, dklen=len(expected)
    )
    return hmac.compare_digest(derived, expected)


def issue_admin_session(password):
    """
    Check the password and return (status, payload) for /api/admin/verify.

    Attempts are serialised and throttled: each check costs a full PBKDF2 run,
    and repeated failures lock the gate for a minute.
    """
    with _admin_lock:
        now = time.monotonic()
        if now < _admin_failures["lockedUntil"]:
            wait = int(_admin_failures["lockedUntil"] - now) + 1
            return 429, {"verified": False, "error": f"Too many attempts. Try again in {wait} s."}
        try:
            ok = verify_admin_password(password)
        except (OSError, ValueError) as err:
            log(f"Administrator password check failed closed: {err}")
            return 500, {"verified": False, "error": "The administrator password on this workstation is unreadable."}
        if not ok:
            _admin_failures["count"] += 1
            if _admin_failures["count"] >= ADMIN_MAX_FAILURES:
                _admin_failures["count"] = 0
                _admin_failures["lockedUntil"] = now + ADMIN_LOCKOUT_SECONDS
                log("Administrator password: too many failures, gate locked for a minute")
            return 401, {"verified": False, "error": "Invalid administrator password"}

        _admin_failures["count"] = 0
        for token, expiry in list(_admin_sessions.items()):
            if expiry <= now:
                del _admin_sessions[token]
        token = secrets.token_urlsafe(32)
        _admin_sessions[token] = now + ADMIN_SESSION_SECONDS
        return 200, {"verified": True, "token": token, "expiresIn": ADMIN_SESSION_SECONDS}


def has_admin_session(token):
    if not token:
        return False
    with _admin_lock:
        now = time.monotonic()
        for known, expiry in _admin_sessions.items():
            if expiry > now and hmac.compare_digest(known, token):
                return True
    return False


def _log_rejected_origin(origin):
    """
    Name the origin that was turned away, once per distinct value.

    A workstation has no terminal, so an Origin the agent did not expect is
    invisible otherwise -- the browser only shows the refusal. The set is
    capped because the caller can be a page in a loop.
    """
    with _rejected_origins_lock:
        if origin in _rejected_origins or len(_rejected_origins) >= 8:
            return
        _rejected_origins.add(origin)
    log(f"Refused a request from origin {origin!r}: only loopback and "
        f"{KIOSK_EXTENSION_ORIGIN} are accepted.")


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
        if origin == KIOSK_EXTENSION_ORIGIN:
            # The one caller that is legitimately not a page on this origin.
            # Chromium stamps every non-GET fetch from the extension's service
            # worker with the extension's own origin, so the admin modal in the
            # kiosk top bar would otherwise be refused. The id is pinned by the
            # "key" in manifest.json, and Origin is a forbidden header a page
            # cannot set, so nothing else can present this value.
            return True
        host = urlparse(origin).hostname
        if host in ("127.0.0.1", "localhost"):
            return True
        _log_rejected_origin(origin)
        return False

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
            try:
                with open(WIZARD_HTML_FILE, "rb") as handle:
                    self._send(200, handle.read(), "text/html; charset=utf-8")
            except OSError as err:
                log(f"Setup wizard missing at {WIZARD_HTML_FILE}: {err}")
                self._send(500, b"<h1>Setup wizard unavailable</h1>", "text/html; charset=utf-8")
            return

        if self.path == "/api/status":
            live = is_live_session()
            online = test_connectivity()["ok"]
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
                        "isLive": live,
                        "isInstalled": not live,
                        "isOnline": online,
                        # False on an installed workstation whose LABKIOSK_DATA
                        # partition is not mounted: it can be enrolled, but it
                        # forgets the enrolment at the next power-off.
                        "persistentStorage": enrolment_is_persistent(),
                        # Only meaningful on live media; an installed disk has
                        # nothing to install to and the wizard hides the tab.
                        "installRequested": live and install_mode_requested(),
                    },
                )
            return

        if self.path.split("?", 1)[0] == "/api/log":
            # Same gate as changing the network: on an installed workstation a
            # student must not be able to read it, but during setup, and on live
            # media, it has to be reachable before anything is configured.
            if admin_auth_required() and not has_admin_session(self.headers.get(ADMIN_TOKEN_HEADER, "")):
                self._send(401, {"error": "Administrator authentication is required"})
                return
            self._send(200, read_agent_log().encode("utf-8"), "text/plain; charset=utf-8")
            return

        if self.path == "/api/network/status":
            self._send(200, get_network_status())
            return

        if self.path == "/api/network/interfaces":
            self._send(200, get_network_interfaces())
            return

        if self.path == "/api/network/wifi/scan":
            self._send(200, scan_wifi_networks())
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
                log(f"Unexpected enrolment failure: {type(err).__name__}: {err}")
                # The reason itself, not just a pointer to a log the workstation
                # has no way to show: this API is loopback-only and the person
                # reading it is the administrator running the setup wizard.
                self._send(
                    500,
                    {
                        "error": f"Enrolment failed unexpectedly: {type(err).__name__}: {err}",
                        "detail": "See the agent log below for the full context.",
                    },
                )
            return

        if self.path == "/api/network/configure":
            if admin_auth_required() and not has_admin_session(self.headers.get(ADMIN_TOKEN_HEADER, "")):
                self._send(401, {"error": "Administrator authentication is required"})
                return
            data = self._read_json()
            if not isinstance(data, dict):
                self._send(400, {"error": "A JSON body is required"})
                return
            try:
                self._send(200, configure_network(data))
            except ValueError as err:
                self._send(400, {"error": str(err)})
            except (RuntimeError, OSError, subprocess.TimeoutExpired) as err:
                log(f"Network configuration failed: {err}")
                self._send(500, {"error": f"Failed to configure network: {err}"})
            return

        if self.path == "/api/network/test":
            self._send(200, test_connectivity(force=True))
            return

        if self.path == "/api/admin/verify":
            data = self._read_json()
            password = str(data.get("password", "") or "") if isinstance(data, dict) else ""
            status, payload = issue_admin_session(password)
            self._send(status, payload)
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


def sync_chromium_policies(new_whitelist, force=False):
    """
    Write the school's allowlist into Chromium's managed enterprise policy.

    `force` rewrites the policy even when the allowlist is unchanged, which is
    how a proxy change made in the setup wizard reaches the browser.
    """
    global cached_whitelist
    if not isinstance(new_whitelist, list):
        return

    sorted_new = sorted({str(d).strip().lower() for d in new_whitelist if str(d).strip()})
    if cached_whitelist == sorted_new and not force:
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

    # Chromium bypasses loopback on its own, so the agent's API and the setup
    # wizard stay reachable however the school proxy is configured.
    proxy_cfg = load_proxy_config()
    if proxy_cfg["enabled"]:
        proxy_settings = {"ProxyMode": "fixed_servers", "ProxyServer": proxy_server_address(proxy_cfg)}
        if proxy_cfg["bypass"]:
            # A comma-separated string: Chromium rejects a list for this key.
            proxy_settings["ProxyBypassList"] = proxy_cfg["bypass"]
        policy_data["ProxySettings"] = proxy_settings
    else:
        policy_data.pop("ProxySettings", None)

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

    with open_url(request, timeout=8) as response:
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
            with state_lock:
                state["lastHeartbeatOk"] = time.monotonic()

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
    apply_proxy_to_environment(load_proxy_config())
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
