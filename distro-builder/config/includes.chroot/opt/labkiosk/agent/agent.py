#!/usr/bin/env python3
"""
Lab Kiosk Local Agent

Responsibilities:
  * First-boot enrolment against the organization's Cloudflare Worker.
  * Screen thumbnail telemetry and remote command execution.
  * Synchronising the organization's domain allowlist into Chromium managed policies.
  * A loopback-only HTTP API for the setup wizard and the browser extension.

Security notes:
  * The local API binds to 127.0.0.1 only. It used to listen on 0.0.0.0 with a
    wildcard CORS header, which let any device on the organization network re-point a
    workstation at a different control plane or inject keystrokes into it.
  * Telemetry is authenticated with a per-device bearer token obtained by
    exchanging the organization's enrollment key once, at enrolment.
  * There is no built-in control-plane URL. An unconfigured workstation talks to
    nobody until an operator completes the setup wizard.
"""

import json
import os
try:
    import pwd
except ImportError:
    pwd = None
import re
import socket
import stat
import subprocess
import sys
import threading
import time
from datetime import datetime, timedelta
try:
    import syslog
except ImportError:
    # Not a Linux host (the unit tests on Windows): the file log is the only log.
    syslog = None
else:
    syslog.openlog("labkiosk-agent", syslog.LOG_PID, syslog.LOG_USER)
import base64
try:
    import grp
except ImportError:
    grp = None
import hashlib
import hmac
import ipaddress
import random
import secrets
try:
    # Debian's python3-websocket (websocket-client). Without it the agent keeps
    # to the HTTP heartbeat, which every control plane still answers.
    import websocket
except ImportError:
    websocket = None
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
# The log lives on /tmp, which is a tmpfs -- so it is RAM, on machines with as
# little as 2 GB of it. The agent is at its most talkative exactly when a
# workstation is left running with something wrong (a pulled cable logs on every
# probe), so an append-only file is a slow leak that ends in a room.
# Trimmed in place rather than rotated: the autostart owns the file through a
# ">>" redirect, and renaming it would leave the shell writing to an inode
# nobody can read any more.
LOG_TRIM_AT_BYTES = 1024 * 1024
LOG_KEEP_BYTES = 128 * 1024
LOG_CHECK_EVERY_LINES = 200
_log_lock = threading.Lock()
_log_lines_written = 0
PROXY_CONFIG_FILE = "/etc/labkiosk/proxy.json"
# Language, region, timezone and keyboard, chosen in the wizard before the
# network is configured -- a workstation with no route to an NTP server still
# has to know what time it is. Persisted on LABKIOSK_DATA so the choice
# survives a reboot, and carried onto the target disk by the installer.
LOCALIZATION_CONFIG_FILE = "/etc/labkiosk/localization.json"
LOCALIZATION_HELPER = "/usr/local/sbin/labkiosk-localization"
LOCALIZATION_TIMEOUT_SECONDS = 60
# Printing, off until an administrator turns it on (Settings -> Printing): the
# root helper that starts CUPS, sets up the printers and lets Chromium print.
PRINTING_HELPER = "/usr/local/sbin/labkiosk-printing"
# Every printer is asked for its capabilities, up to 45 s each, 20 at most.
PRINTING_HELPER_TIMEOUT_SECONDS = 20 * 60
# A printer that could not be set up (switched off, not on this network yet)
# is tried again this often.
PRINTING_RETRY_SECONDS = 300
# Chromium reloads its managed policy about five seconds after a file changes;
# the bar's Print button waits that long after the helper allowed printing.
PRINTING_POLICY_SETTLE_SECONDS = 6
PRINTING_MAX_PRINTERS = 20
# Keep these in step with usr/local/sbin/labkiosk-printing, which checks them
# again as root, and with cloudflare-control/src/printing.ts.
PRINTER_ID_PATTERN = re.compile(r"^[0-9a-f]{16}\Z")
PRINTER_URI_PATTERN = re.compile(
    r"^(ipps?)://(\[[0-9A-Fa-f:]+\]|[A-Za-z0-9.-]+)(?::([0-9]{1,5}))?(/(?:[A-Za-z0-9._~/-]|%[0-9A-Fa-f]{2})*)?\Z"
)
# en-US ships in the image; every other catalog is dropped onto the data
# partition, which is how an organization adds its language without a new ISO.
UI_LANGUAGE_DIR = "/opt/labkiosk/i18n"
UI_LANGUAGE_EXTRA_DIR = "/etc/labkiosk/i18n"
UI_LANGUAGE_PATTERN = re.compile(r"^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}\Z")
# A catalog is UI text. These caps are what stops a compromised or simply
# wrong control plane from filling the data partition, or handing the wizard
# a document it will spend a second walking on every page load.
CATALOG_MAX_BYTES = 256 * 1024
CATALOG_MAX_KEYS = 2000
CATALOG_MAX_VALUE = 2000
# The boot-menu password digest, which is also the administrator password. An
# installed disk keeps it in boot/grub on LABKIOSK_ROOT, outside every system
# image, and live-boot mounts that partition here read-only. On the ISO the same
# path holds the build-time password, if one was pinned.
BOOT_MEDIUM_GRUB_DIR = "/run/live/medium/boot/grub"
GRUB_PASSWORD_FILE = os.path.join(BOOT_MEDIUM_GRUB_DIR, "labkiosk-password.cfg")
GRUB_CONFIG_FILE = os.path.join(BOOT_MEDIUM_GRUB_DIR, "grub.cfg")
# Only the installed boot menu passes this (/usr/share/labkiosk/boot/grub.cfg).
INSTALLED_KERNEL_ARG = "labkiosk.installed=1"
# Network boot (docs: wiki/Network-Boot.md): the boot server's menu starts the
# image over the LAN with this, and with what to enrol as. Nothing written to
# /etc/labkiosk survives, so the workstation enrols again at every boot under
# its hostname, which labkiosk-hostname derives from the network card.
NETBOOT_KERNEL_ARG = "labkiosk.netboot=1"
NETBOOT_RETRY_SECONDS = 15
# A refused key waits longer: the control plane rate-limits failed enrolments
# per address, and a lab behind one public address shares that limit.
NETBOOT_REFUSED_RETRY_SECONDS = 600
ORG_SUBDOMAIN_PATTERN = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\Z")
CUSTOM_DOMAIN_PATTERN = re.compile(r"^(?=.{1,253}\Z)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}\Z")
# What labkiosk-boot-slots check (root) recorded about this boot's system image.
# /run/labkiosk-update is root's; the browser's user cannot write a report here.
BOOT_STATUS_FILE = "/run/labkiosk-update/status.json"
MAX_BOOT_STATUS_BYTES = 4096
# Outcomes Settings -> Errors & Warnings should show; routine boots are not sent.
BOOT_REPORT_STATES = frozenset({"installed", "failed", "rolled-back", "fallback", "error"})
BOOT_REPORT_FIELDS = ("version", "previous", "failed", "error")
BOOT_REPORT_INTERVAL_SECONDS = 30
# Answers after which a report is settled: recorded (200), or one the control
# plane will never take (400 malformed, 404 a Worker without the route).
BOOT_REPORT_SETTLED_STATUSES = (200, 400, 404)
# Boots that ended without shutting down, as labkiosk-logs (root) found them at
# the next start: one <boot id>.json each, deleted by it after seven days. The
# agent cannot write there, so it keeps its own list of the ones it has sent.
RESTART_REPORTS_DIR = "/etc/labkiosk/logs/reports"
# Disk health, as labkiosk-health (root) found it at its last check: shortly
# after boot and every six hours. The agent reports the disks wearing out or
# failing; the Worker lists each disk once per state, so sending the same
# finding after every check costs nothing.
DISK_HEALTH_FILE = "/run/labkiosk-health/disks.json"
DISK_PROBLEM_STATES = ("warning", "failing")
DISK_FIELDS = ("device", "model", "serial", "state", "summary")
MAX_DISK_HEALTH_BYTES = 16 * 1024
MAX_DISKS_REPORTED = 8
# Video decoding: what each GPU's VA-API driver can decode and encode, read
# with vainfo once per agent start and sent to the console, so an operator can
# tell a lab decoding video on the GPU from one decoding it on the CPU.
DRM_CLASS_DIR = "/sys/class/drm"
RENDER_NODE_PATTERN = re.compile(r"^renderD[0-9]{3}\Z")
MAX_GPUS_REPORTED = 4
VAINFO_TIMEOUT_SECONDS = 15
# PCI vendor ids; anything else is "other".
GPU_VENDORS = {
    "0x8086": "intel",
    "0x1002": "amd",
    "0x10de": "nvidia",
    "0x1af4": "virtual",  # virtio-gpu
    "0x1234": "virtual",  # QEMU standard VGA
    "0x15ad": "virtual",  # VMware SVGA
    "0x1414": "virtual",  # Hyper-V
    "0x80ee": "virtual",  # VirtualBox
}
# VAProfile name prefixes, longest first, and the codec each is reported as.
VA_PROFILE_CODECS = (
    ("VAProfileH264", "h264"),
    ("VAProfileHEVC", "hevc"),
    ("VAProfileVP8", "vp8"),
    ("VAProfileVP9", "vp9"),
    ("VAProfileAV1", "av1"),
    ("VAProfileMPEG2", "mpeg2"),
    ("VAProfileVC1", "vc1"),
    ("VAProfileJPEG", "jpeg"),
)
VA_DECODE_ENTRYPOINTS = frozenset({"VAEntrypointVLD"})
VA_ENCODE_ENTRYPOINTS = frozenset({"VAEntrypointEncSlice", "VAEntrypointEncSliceLP", "VAEntrypointEncPicture"})
VA_PROFILE_LINE = re.compile(r"^\s*(VAProfile[A-Za-z0-9_]+)\s*:\s*(VAEntrypoint[A-Za-z0-9_]+)\s*\Z")
VA_DRIVER_LINE = re.compile(r"Driver version:\s*(.+?)\s*\Z")
MAX_VA_DRIVER_LENGTH = 120
# What the machine is (probe_hardware), sent once per start: POST /api/devices/hardware.
DMI_DIR = "/sys/class/dmi/id"
NET_CLASS_DIR = "/sys/class/net"
CPUINFO_FILE = "/proc/cpuinfo"
MEMINFO_FILE = "/proc/meminfo"
MAX_WIRED_MACS = 8
MAC_ADDRESS_PATTERN = re.compile(r"^[0-9a-f]{2}(?::[0-9a-f]{2}){5}\Z")
# Usage reports (UsageCounter): counted per day of this machine's clock and
# sent every USAGE_REPORT_SECONDS with POST /api/devices/usage. The limits
# match the control plane's (src/usage.ts).
USAGE_REPORT_SECONDS = 15 * 60
USAGE_ON_STEP_SECONDS = 60
USAGE_ON_MAX_CREDIT_SECONDS = 2 * USAGE_ON_STEP_SECONDS
USAGE_TICK_MAX_CREDIT_SECONDS = 90
USAGE_MAX_AGE_DAYS = 7
USAGE_MAX_DAYS_PER_REPORT = USAGE_MAX_AGE_DAYS + 2
USAGE_MAX_SITES_PER_DAY = 100
USAGE_HOST_PATTERN = re.compile(r"^(?=.{1,253}\Z)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]\Z")
RESTART_REPORTS_SENT_FILE = "/etc/labkiosk/restart-reports-sent.json"
RESTART_REPORT_NAME_PATTERN = re.compile(r"^([0-9a-f]{32})\.json\Z")
# A report carries at most 16 KB of journal; anything far larger is not root's.
MAX_RESTART_REPORT_BYTES = 64 * 1024
MAX_RESTART_REPORTS = 100
# Over-the-air updates, phase 3. labkiosk-update (root) writes what it is doing
# beside the boot status; the agent reports it and never writes it.
UPDATE_STATE_FILE = "/run/labkiosk-update/update.json"
IMAGE_VERSION_FILE = "/usr/share/labkiosk/version"
UPDATE_PHASES = frozenset({"idle", "checking", "downloading", "ready", "staged", "installing", "up-to-date", "error"})
UPDATE_KINDS = frozenset({"feature", "security"})
UPDATE_VERSION_PATTERN = re.compile(r"^[0-9]{1,4}\.[0-9]{1,4}\.[0-9]{1,4}(?:-[0-9A-Za-z.]{1,32})?\Z")
MAX_UPDATE_DETAIL = 300
# The only units the kiosk user may start (50-labkiosk-update.rules).
UPDATE_DOWNLOAD_UNIT = "labkiosk-update-download.service"
UPDATE_INSTALL_UNIT = "labkiosk-update-install.service"
SYSTEMCTL_TIMEOUT_SECONDS = 15
# Phase 5: sharing a release on the local network. labkiosk-update starts the
# server as root; the agent may only stop it (the same polkit rule), when the
# organization turns sharing off.
LAN_SHARE_UNIT = "labkiosk-share.service"
# Where the address is learned: the kernel's route to an address never routed
# (TEST-NET-1, RFC 5737), as derive_default_client_id() does. No packet is sent.
LAN_PROBE_ADDRESS = "192.0.2.1"
LAN_PRIVATE_NETWORKS = tuple(ipaddress.ip_network(n) for n in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"))
LAN_PREFIX_RANGE = range(16, 31)
LAN_REPORT_TTL_SECONDS = 60
IP_COMMAND_TIMEOUT_SECONDS = 5
# The install screen comes down by itself if no restart follows: the install
# failed in a way its unit could not report.
UPDATE_SCREEN_TIMEOUT_SECONDS = 15 * 60
WIZARD_HTML_FILE = "/opt/labkiosk/setup/wizard.html"
BLOCKED_HTML_FILE = "/opt/labkiosk/setup/blocked.html"
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
DEFAULT_BASE_DOMAIN = os.environ.get("LABKIOSK_DOMAIN", "labkiosk.org")

# Remote control. The Openbox autostart (and the simulator's entrypoint) writes
# the plaintext x11vnc password it generated for this boot here, mode 600, so
# the agent can hand it to the admin console over the authenticated
# telemetry channel.
VNC_SECRET_FILE = "/tmp/labkiosk/vnc.secret"

AGENT_VERSION = "4.0.2"
LOCAL_API_HOST = "127.0.0.1"
LOCAL_API_PORT = 8888
HEARTBEAT_SECONDS = 3
MAX_BACKOFF_SECONDS = 60
# The HTTP heartbeat's reply names the next interval (`heartbeatSeconds`: fast
# while a console is open, slower otherwise) and whether an operator is watching
# this screen (`frames`). A control plane older than those fields gets the
# 3-second cadence with a frame on every heartbeat, as before.
HTTP_HEARTBEAT_BOUNDS = (HEARTBEAT_SECONDS, MAX_BACKOFF_SECONDS)
http_pace = {"seconds": HEARTBEAT_SECONDS, "frames": True}
# Upper bound on the base64 thumbnail in one heartbeat. At a 3-second cadence an
# unbounded screenshot is a standing egress cost on an organization's uplink, and the
# control plane documents this ceiling; a frame over budget is dropped rather
# than sent, so the heartbeat itself always gets through.
MAX_THUMBNAIL_BYTES = 256 * 1024

# The control channel. A workstation holds one WebSocket to its organization's
# hub instead of posting a heartbeat every 3 seconds: the hub pushes the
# allowlist, the broadcast and commands the moment they change, and asks for
# screen frames only while an operator has this screen on view. The ping must
# be byte-for-byte the hub's auto-response request -- the edge answers it
# without waking the hub, which is what makes an idle workstation free.
WEBSOCKET_PING = '{"type":"ping"}'
WEBSOCKET_PING_SECONDS = 15
# Nothing heard for this long (not even a pong) means the connection is dead.
WEBSOCKET_SILENCE_SECONDS = 45
WEBSOCKET_CONNECT_TIMEOUT_SECONDS = 10
# How long one receive waits before the loop sends what is due.
WEBSOCKET_POLL_SECONDS = 0.5
# Connections the server ended on purpose (a deploy restarts every hub) are
# re-opened after a random pause up to this, so a whole fleet does not return at once.
WEBSOCKET_RECONNECT_SECONDS = 10
# A control plane that answers the upgrade with one of these has no WebSocket
# route (an older Worker, or the Node development server): use HTTP for a while.
WEBSOCKET_UNSUPPORTED_STATUSES = (404, 426, 501)
# Connections that fail this many times in a row (a proxy that drops upgrades)
# also fall back to HTTP; nothing may leave a workstation without a control channel.
WEBSOCKET_FAILURES_BEFORE_HTTP = 3
WEBSOCKET_RETRY_SECONDS = 600
# Close codes the hub uses (org_hub.ts).
WS_CLOSE_REPLACED = 4000
WS_CLOSE_REMOVED = 4001
WS_CLOSE_INACTIVE = 4003
WS_CLOSE_STALE = 4008
FRAME_INTERVAL_BOUNDS = (1, 60)

# Remote Control through the console (remote_relay.ts). The hub asks over the
# control channel; the agent opens a second WebSocket and, once noVNC is there
# ("ready"), pipes the loopback x11vnc into it. Nothing listens beyond loopback.
REMOTE_SESSION_PATTERN = re.compile(r"[0-9a-f]{64}\Z")
REMOTE_VNC_ADDRESS = ("127.0.0.1", 5900)
REMOTE_READY = '{"type":"ready"}'
# The relay's auto-response request, like WEBSOCKET_PING for the hub.
REMOTE_PING = '{"type":"ping"}'
REMOTE_PING_SECONDS = 30
# The relay closes a session nobody joined after 60 s; wait a little longer for it.
REMOTE_READY_TIMEOUT_SECONDS = 70
REMOTE_CHUNK_BYTES = 64 * 1024
REMOTE_POLL_SECONDS = 1.0

# Hosts that may appear in a workerUrl in addition to a public https origin.
LOCAL_WORKER_HOSTS = {
    "127.0.0.1",
    "localhost",
    "host.docker.internal",
    "host.containers.internal",
}

# Kept in step with the maxlength="64" on the wizard's identifier input.
CLIENT_ID_PATTERN = re.compile(r"^[A-Z0-9][A-Z0-9_-]{0,62}\Z")

# An organization's enrollment key as the control plane generates it
# (generateEnrollmentKey in cloudflare-control/src/auth.ts): four groups of five
# from an alphabet without I, L, O, U, 0 and 1, which are misread, the last
# character being a check on the nineteen before it. A key that is not this
# shape, or whose check character does not fit, was mistyped, and is refused
# here without asking the server -- so a typo costs no attempt against the
# organization's enrolment limit. Kept in step with the wizard.
ENROLLMENT_KEY_ALPHABET = "ABCDEFGHJKMNPQRSTVWXYZ23456789"
ENROLLMENT_KEY_PATTERN = re.compile(r"^[%s]{5}(?:-[%s]{5}){3}\Z" % (ENROLLMENT_KEY_ALPHABET, ENROLLMENT_KEY_ALPHABET))


def enrollment_key_check_character(payload):
    """
    The check character for the characters before it: the Luhn algorithm over the
    key's alphabet, exactly as enrollmentKeyCheckCharacter in the control plane
    computes it. One wrong character, or two neighbours swapped, changes it.
    """
    n = len(ENROLLMENT_KEY_ALPHABET)
    factor = 2
    total = 0
    for char in reversed(payload):
        addend = factor * ENROLLMENT_KEY_ALPHABET.index(char)
        total += addend // n + addend % n
        factor = 1 if factor == 2 else 2
    return ENROLLMENT_KEY_ALPHABET[(n - total % n) % n]


def enrollment_key_is_valid(key):
    """True for a key of the generated shape whose last character checks the rest."""
    if not isinstance(key, str) or not ENROLLMENT_KEY_PATTERN.match(key):
        return False
    chars = key.replace("-", "")
    return enrollment_key_check_character(chars[:-1]) == chars[-1]

# Whole-disk device nodes the guided installer may target. Kept identical to
# TARGET_DISK_PATTERN in /usr/local/bin/labkiosk-install, which re-checks it
# because sudoers lets the kiosk user invoke that binary directly.
TARGET_DISK_PATTERN = re.compile(r"^/dev/(sd[a-z]|vd[a-z]|nvme[0-9]+n[0-9]+|mmcblk[0-9]+)\Z")
# One partition of such a disk, which an install beside another system may
# replace. Kept identical to PARTITION_PATTERN in labkiosk-install.
REPLACE_PARTITION_PATTERN = re.compile(
    r"^/dev/(sd[a-z][0-9]{1,3}|vd[a-z][0-9]{1,3}|nvme[0-9]+n[0-9]+p[0-9]{1,3}|mmcblk[0-9]+p[0-9]{1,3})\Z"
)

# A grub-mkpasswd-pbkdf2 digest. The setup wizard derives this in the browser
# with WebCrypto and posts only the digest, so the boot-menu password itself
# never crosses this API. Kept identical to GRUB_PBKDF2_PATTERN in
# /usr/local/bin/labkiosk-install, which re-validates it.
GRUB_PBKDF2_PATTERN = re.compile(r"^grub\.pbkdf2\.sha512\.[0-9]+\.[0-9A-Fa-f]+\.[0-9A-Fa-f]+\Z")
# A hostname typed in the setup wizard's install step: one lowercase DNS label.
# Kept identical to HOSTNAME_PATTERN in /usr/local/bin/labkiosk-install, which
# re-validates it.
INSTALL_HOSTNAME_PATTERN = re.compile(r"^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\Z")
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
NET_DEVICE_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.-]{0,14}\Z")
PROXY_HOST_PATTERN = re.compile(r"^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?\Z")
PROXY_BYPASS_PATTERN = re.compile(r"^[A-Za-z0-9*.\-:\[\]/<>]{1,253}\Z")
LOOPBACK_NO_PROXY = ("localhost", "127.0.0.1", "::1")
NMCLI_TIMEOUT_SECONDS = 15
# A heartbeat that reached the control plane this recently proves the
# workstation is online even where the generic probes below are firewalled
# (organizations that force all traffic through a proxy commonly block both).
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
    "lockMessage": "This screen has been locked by an administrator. Please wait.",
    "targetUrl": SETUP_URL,
    "broadcastUrl": "",
    "broadcastEpoch": 0,
    "reloadEpoch": 0,
    # Set at enrolment. Chromium reads its managed policy at startup, so a
    # workstation that just enrolled is still running under the boot-time
    # allowlist and would show "This page is blocked" on its new home page until
    # Chromium's own file watcher caught up. Restarting the browser once, after
    # the first policy sync, makes the transition immediate.
    "pendingBrowserRestart": False,
    # time.monotonic() of the last heartbeat the control plane accepted.
    "lastHeartbeatOk": 0.0,
    # The control plane refused this workstation's device token (the
    # organization was deleted, or the workstation removed). The screen is sent
    # to the wizard's re-enrolment form rather than left on a page Chromium
    # blocks, which is a page the kiosk bar cannot appear on.
    "enrolmentRejected": False,
    # The organization lets Home in the kiosk bar start a new session (sign
    # everyone out). Off until its configuration says so, so a workstation the
    # control plane has not answered yet only goes back to its start page.
    "homeReset": False,
    # An administrator's install of a system update is under way: the screen
    # says so, and reboot or shutdown commands wait for it. Unlock leaves it.
    "updateInstalling": "",
    "updateInstallingSince": 0.0,
}
REENROL_URL = "http://127.0.0.1:8888/setup#reenrol"
# Set by an enrolment so the heartbeat runs at once instead of finishing a
# back-off (up to MAX_BACKOFF_SECONDS after a rejected token): until that
# heartbeat brings the new allowlist, the new home page is itself blocked.
heartbeat_wakeup = threading.Event()
state_lock = threading.Lock()


def trim_agent_log():
    """
    Keep the tail of the log and drop the rest.

    Truncating a file another process holds open in append mode is safe: O_APPEND
    always writes at the current end, so the next line from the autostart lands
    after what was kept rather than at the old offset.
    """
    with _log_lock:
        try:
            if os.path.getsize(AGENT_LOG_FILE) <= LOG_TRIM_AT_BYTES:
                return
            with open(AGENT_LOG_FILE, "r+b") as handle:
                handle.seek(-LOG_KEEP_BYTES, os.SEEK_END)
                tail = handle.read()
                # The seek landed mid-line; drop that fragment so the file starts
                # with a whole entry.
                newline = tail.find(b"\n")
                if newline != -1:
                    tail = tail[newline + 1:]
                handle.seek(0)
                handle.write(b"[Agent] ---- earlier entries were dropped to keep this log out of RAM ----\n")
                handle.write(tail)
                handle.truncate()
        except OSError:
            # A log that cannot be trimmed must never stop the agent logging.
            pass


def log(message):
    """
    One line, stamped with the workstation's own local time.

    The log is read through the wizard's diagnostics panel on a machine with no
    terminal, usually to answer "when did this happen?" -- so the zone matters
    as much as the clock, and both now follow the Language & Region step.
    """
    global _log_lines_written
    print(f"{datetime.now():%Y-%m-%d %H:%M:%S} {time.strftime('%Z')} [Agent] {message}", flush=True)
    # The same line in the system journal, which an installed disk keeps on its
    # data partition (labkiosk-logs): after a crash, what the agent was doing is
    # in the log sent with the restart report. The file above is in RAM.
    if syslog is not None:
        syslog.syslog(syslog.LOG_INFO, message)

    # Checked every few hundred lines rather than on each one: a stat() per line
    # is wasted work on a workstation that logs nothing for weeks.
    with _log_lock:
        _log_lines_written += 1
        due = _log_lines_written >= LOG_CHECK_EVERY_LINES
        if due:
            _log_lines_written = 0
    if due:
        trim_agent_log()


# --------------------------------------------------------------------------
# Configuration
# --------------------------------------------------------------------------

def is_private_ip_literal(hostname):
    """
    True for a loopback or RFC 1918 address written as an IP literal.

    This is the same set the control plane treats as a dev host (isDevHost() in
    guard.ts): the machine running `pnpm dev`, reached from a test VM or the
    simulator by its LAN or Hyper-V/WSL adapter address (e.g. 172.31.64.1). A
    public address, a link-local one or a hostname never qualifies, so plain
    http cannot be pointed at anything off the local network.
    """
    try:
        address = ipaddress.ip_address(str(hostname or "").strip("[]"))
    except ValueError:
        return False
    if address.is_loopback:
        return True
    return address.version == 4 and any(
        address in ipaddress.ip_network(block)
        for block in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16")
    )


def organization_name(reply, fallback):
    """
    The organization's display name from an enrolment reply.

    Workers older than the organization vocabulary send it as `schoolName`, so
    that key is still read; `fallback` (the subdomain or custom domain the
    operator typed) covers a reply with neither.
    """
    for key in ("organizationName", "schoolName"):
        value = reply.get(key) if isinstance(reply, dict) else None
        if isinstance(value, str) and value.strip():
            return value.strip()
    return fallback


def validate_worker_url(candidate):
    """
    Accept only an https origin, or plain http to a local test server.

    Plain http is for development only: a loopback or container host, or a
    private IP literal (see is_private_ip_literal). An organization's real server is
    always https, and the device token travels in every heartbeat.
    """
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
        or is_private_ip_literal(parsed.hostname)
    )
    if parsed.scheme == "https" or (parsed.scheme == "http" and is_local):
        return f"{parsed.scheme}://{parsed.netloc}"
    return None


def safe_navigable_url(candidate):
    """
    Return an http(s) URL the kiosk may be pointed at, or "" if it is not one.

    Everything the control plane sends eventually reaches window.location in the
    browser, so a javascript: or data: value arriving as a targetUrl would run in
    whatever page the user is on. navigate_to() already checked this for
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


def read_vnc_password():
    """The per-boot x11vnc password, or an empty string when none was written."""
    return _read_cached_file(
        VNC_SECRET_FILE, _vnc_secret_cache, lambda text: text.strip()[:64]
    )


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


def mounted_fstype(path, mounts_file="/proc/mounts"):
    """
    The filesystem type mounted exactly at path, or "" if nothing is.

    mounts_file is a parameter so this can be tested against a fixture; nothing
    in the agent passes anything but the default.
    """
    try:
        target = os.path.realpath(path)
        if os.name != "posix":
            drive, rest = os.path.splitdrive(target)
            target = rest.replace("\\", "/")
    except OSError:
        return ""

    def unescape(field):
        # /proc/mounts writes spaces, tabs, newlines and backslashes in octal.
        for code, char in ((r"\040", " "), (r"\011", "\t"), (r"\012", "\n"), (r"\134", "\\")):
            field = field.replace(code, char)
        return field

    found = ""
    try:
        with open(mounts_file, "r", encoding="utf-8", errors="replace") as handle:
            for line in handle:
                fields = line.split()
                if len(fields) >= 3 and unescape(fields[1]) == target:
                    found = fields[2]  # A later mount shadows an earlier one.
    except OSError:
        return ""
    return found


EFI_DIR = "/sys/firmware/efi"
# The UEFI global variable the firmware sets to 1 while it enforces Secure Boot.
SECURE_BOOT_VAR = "/sys/firmware/efi/efivars/SecureBoot-8be4df61-93ca-11d2-aa0d-00e098032b8c"


def secure_boot_state(efi_dir=EFI_DIR, var_path=SECURE_BOOT_VAR):
    """
    "on" when the firmware enforced Secure Boot for this boot, "off" when it
    did not, "legacy-bios" when the machine did not start through UEFI, and
    "unknown" when the variable cannot be read. efivarfs files are four bytes
    of attributes, then the value.
    """
    if not os.path.isdir(efi_dir):
        return "legacy-bios"
    try:
        with open(var_path, "rb") as handle:
            raw = handle.read(16)
    except FileNotFoundError:
        # Firmware without Secure Boot support has no such variable.
        return "off"
    except OSError as err:
        log(f"Could not read the Secure Boot state: {err}")
        return "unknown"
    if len(raw) != 5:
        return "unknown"
    return "on" if raw[4] == 1 else "off"


# systemd-timesyncd touches this file each time it sets the clock from a time
# server, and only then.
CLOCK_SYNCHRONIZED_FILE = "/run/systemd/timesync/synchronized"


def clock_synchronized(path=CLOCK_SYNCHRONIZED_FILE):
    """
    Has a time server set the clock since boot? A clock that never was can be
    far enough off for every HTTPS connection to fail, which is worth seeing on
    the diagnostics page before anything else.
    """
    return os.path.exists(path)


# --------------------------------------------------------------------------
# Input devices: is a keyboard attached, is there a touchscreen?
# --------------------------------------------------------------------------
#
# The kiosk bar shows its on-screen keyboard by itself on a workstation that
# has no keyboard, so the question has to be answered without guessing from a
# device's name: power buttons, lid switches, the video bus and many laptop
# hotkey devices all register a "kbd" handler, and none of them can type a
# letter. A keyboard is a device that can type every letter, space and Enter.

INPUT_DEVICES_FILE = "/proc/bus/input/devices"
# Keyboards are plugged in and pulled out; the bar asks every second.
INPUT_DEVICES_TTL_SECONDS = 5
INPUT_DEVICES_MAX_BYTES = 256 * 1024
# The kernel prints each bitmap as hexadecimal unsigned longs, most significant
# first: 64 bits each on the amd64 image (the agent runs on the same kernel).
INPUT_BITMAP_WORD_BITS = 64 if sys.maxsize > 2 ** 32 else 32
# linux/input-event-codes.h
EV_KEY = 0x01
EV_ABS = 0x03
ABS_X = 0x00
ABS_MT_POSITION_X = 0x35
INPUT_PROP_DIRECT = 0x01
KEY_ENTER = 28
KEY_SPACE = 57
# KEY_Q..KEY_P, KEY_A..KEY_L, KEY_Z..KEY_M: the 26 letters.
KEYBOARD_REQUIRED_KEYS = tuple(range(16, 26)) + tuple(range(30, 39)) + tuple(range(44, 51)) + (KEY_ENTER, KEY_SPACE)
# Software-made devices (uinput, ydotool, an X server's XTEST device) type
# whatever a program tells them to; none of them is a keyboard a person has.
VIRTUAL_INPUT_NAME = re.compile(r"virtual|xtest|uinput|ydotool", re.IGNORECASE)
TOUCHSCREEN_NAME = re.compile(r"touch\s*screen", re.IGNORECASE)


def parse_input_devices(text):
    """
    The devices in /proc/bus/input/devices: name, bus, handlers and bitmaps.
    Blocks are separated by blank lines; each line is "<letter>: <data>".
    """
    devices = []
    current = None
    for raw in text.splitlines():
        line = raw.strip()
        if not line:
            current = None
            continue
        kind, separator, rest = line.partition(": ")
        if not separator:
            continue
        if current is None:
            current = {"name": "", "bus": "", "handlers": [], "bitmaps": {}}
            devices.append(current)
        if kind == "I":
            for field in rest.split():
                key, _, value = field.partition("=")
                if key == "Bus":
                    current["bus"] = value.lower()
        elif kind == "N":
            _, _, name = rest.partition("=")
            current["name"] = name.strip().strip('"')
        elif kind == "H":
            _, _, handlers = rest.partition("=")
            current["handlers"] = handlers.split()
        elif kind == "B":
            key, _, value = rest.partition("=")
            current["bitmaps"][key.strip()] = value.split()
    return devices


def input_bitmap_has(words, bit, word_bits=INPUT_BITMAP_WORD_BITS):
    """Is `bit` set in a bitmap printed as hexadecimal words, most significant first?"""
    index = bit // word_bits
    if index >= len(words):
        return False
    try:
        word = int(words[len(words) - 1 - index], 16)
    except ValueError:
        return False
    return bool((word >> (bit % word_bits)) & 1)


def is_keyboard_device(device, word_bits=INPUT_BITMAP_WORD_BITS):
    """A device a person can type a word on: every letter, space and Enter."""
    if "kbd" not in device["handlers"] or VIRTUAL_INPUT_NAME.search(device["name"]):
        return False
    bitmaps = device["bitmaps"]
    if not input_bitmap_has(bitmaps.get("EV", []), EV_KEY, word_bits):
        return False
    keys = bitmaps.get("KEY", [])
    return all(input_bitmap_has(keys, code, word_bits) for code in KEYBOARD_REQUIRED_KEYS)


def is_touchscreen_device(device, word_bits=INPUT_BITMAP_WORD_BITS):
    """
    Absolute positions on the screen itself (INPUT_PROP_DIRECT); a touchpad has
    the same axes but is INPUT_PROP_POINTER. A driver too old to set the
    property still counts when it calls itself a touchscreen.
    """
    if VIRTUAL_INPUT_NAME.search(device["name"]):
        return False
    bitmaps = device["bitmaps"]
    if not input_bitmap_has(bitmaps.get("EV", []), EV_ABS, word_bits):
        return False
    axes = bitmaps.get("ABS", [])
    if not (input_bitmap_has(axes, ABS_MT_POSITION_X, word_bits) or input_bitmap_has(axes, ABS_X, word_bits)):
        return False
    if input_bitmap_has(bitmaps.get("PROP", []), INPUT_PROP_DIRECT, word_bits):
        return True
    return bool(TOUCHSCREEN_NAME.search(device["name"]))


def detect_input_devices(text, word_bits=INPUT_BITMAP_WORD_BITS):
    """
    {"keyboardPresent", "touchPresent"} from the text of /proc/bus/input/devices.

    Both are None when the file lists no device at all. Real hardware always
    lists something (a power button, the touchscreen itself); an empty list
    means this machine's input is not visible from here -- a container, or a
    virtual machine driven over VNC -- and nothing should be concluded from it.
    """
    devices = parse_input_devices(text)
    if not devices:
        return {"keyboardPresent": None, "touchPresent": None}
    return {
        "keyboardPresent": any(is_keyboard_device(d, word_bits) for d in devices),
        "touchPresent": any(is_touchscreen_device(d, word_bits) for d in devices),
    }


_input_devices = {"value": None, "at": None, "problem": None}


def input_devices_report(now=None, path=INPUT_DEVICES_FILE):
    """detect_input_devices() of the running machine, read at most every few seconds."""
    now = time.monotonic() if now is None else now
    cached = _input_devices
    if cached["at"] is not None and now - cached["at"] < INPUT_DEVICES_TTL_SECONDS:
        return cached["value"]
    try:
        with open(path, encoding="utf-8", errors="replace") as handle:
            value = detect_input_devices(handle.read(INPUT_DEVICES_MAX_BYTES))
        problem = None if value["keyboardPresent"] is not None else f"{path} lists no input devices"
    except OSError as err:
        value = {"keyboardPresent": None, "touchPresent": None}
        problem = f"{path} could not be read: {err}"
    if problem and problem != cached["problem"]:
        log(f"Keyboard presence unknown ({problem}); the on-screen keyboard opens only from the bar")
    cached.update(value=value, at=now, problem=problem)
    return value


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
        if uid is None or resolver is None:
            return str(uid)
        try:
            return resolver(uid)[0]
        except (KeyError, OSError):
            return str(uid)

    st_uid = getattr(info, "st_uid", None)
    st_gid = getattr(info, "st_gid", None)
    get_uid = getattr(os, "getuid", lambda: None)
    my_uid = get_uid()
    owner = owner_name(st_uid, getattr(pwd, "getpwuid", None) if pwd else None)
    group = owner_name(st_gid, getattr(grp, "getgrgid", None) if grp else None)
    mounted = os.path.ismount(directory)
    me = owner_name(my_uid, getattr(pwd, "getpwuid", None) if pwd else None)
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
        f"{where} {owner}:{group} ({st_uid}:{st_gid}) "
        f"with mode {info.st_mode & 0o777:04o}, and this agent runs as "
        f"{me} ({my_uid}). {fix}"
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
            f"{describe_config_dir()} The organization has already registered this "
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
# Language, region and clock
# --------------------------------------------------------------------------

def run_localization_helper(args, privileged):
    """
    Call the one privileged program the agent is allowed to run.

    Listing what the system supports needs no privileges; changing anything
    does, and goes through sudo against a single named program that re-validates
    every argument (/etc/sudoers.d/51-labkiosk-localization).
    """
    command = (["sudo", "-n", LOCALIZATION_HELPER] if privileged else [LOCALIZATION_HELPER]) + args
    try:
        proc = subprocess.run(
            command, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, timeout=LOCALIZATION_TIMEOUT_SECONDS,
        )
    except FileNotFoundError as err:
        raise RuntimeError(f"{LOCALIZATION_HELPER} is not installed on this image") from err
    except subprocess.TimeoutExpired as err:
        raise RuntimeError("the localization helper did not finish in time") from err

    for line in proc.stderr.strip().splitlines():
        log(line)
    try:
        payload = json.loads(proc.stdout or "{}")
    except ValueError as err:
        raise RuntimeError(
            f"the localization helper returned no JSON ({proc.stdout[:120]!r})") from err
    if proc.returncode != 0:
        raise ValueError(payload.get("error", f"localization failed ({proc.returncode})"))
    return payload


def load_localization_config():
    try:
        with open(LOCALIZATION_CONFIG_FILE, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except (OSError, ValueError):
        return {}
    return data if isinstance(data, dict) else {}


def save_localization_config(cfg):
    directory = os.path.dirname(LOCALIZATION_CONFIG_FILE)
    temp_path = LOCALIZATION_CONFIG_FILE + ".tmp"
    try:
        os.makedirs(directory, exist_ok=True)
        with open(temp_path, "w", encoding="utf-8") as handle:
            json.dump(cfg, handle, indent=2)
        os.replace(temp_path, LOCALIZATION_CONFIG_FILE)
    except OSError as err:
        raise RuntimeError(
            f"could not save the language and region settings to "
            f"{LOCALIZATION_CONFIG_FILE} ({err.strerror}). {describe_config_dir()}"
        ) from err


def available_ui_languages():
    """
    Interface languages this workstation can display.

    A catalog is <tag>.json; en-US is the source and ships in the image. The
    rest are added by dropping files into /etc/labkiosk/i18n, so an organization can
    add its own language without rebuilding the ISO.
    """
    languages = {}
    for directory in (UI_LANGUAGE_DIR, UI_LANGUAGE_EXTRA_DIR):
        try:
            entries = sorted(os.listdir(directory))
        except OSError:
            continue
        for entry in entries:
            if not entry.endswith(".json"):
                continue
            tag = entry[:-5]
            if not UI_LANGUAGE_PATTERN.match(tag):
                continue
            try:
                with open(os.path.join(directory, entry), "r", encoding="utf-8") as handle:
                    catalog = json.load(handle)
            except (OSError, ValueError) as err:
                log(f"Ignoring language catalog {entry}: {err}")
                continue
            meta = catalog.get("_meta", {}) if isinstance(catalog, dict) else {}
            languages[tag] = {
                "tag": tag,
                "name": str(meta.get("name", tag)),
                "direction": "rtl" if str(meta.get("direction", "ltr")).lower() == "rtl" else "ltr",
                "bundled": directory == UI_LANGUAGE_DIR,
            }
    return [languages[tag] for tag in sorted(languages)]


def validate_catalog(document):
    """
    A catalog is a flat map of key to string, and nothing else.

    It arrives from the control plane, so it is checked here rather than
    trusted: the wizard inserts these values as text, and this keeps a
    malformed one from reaching it at all.
    """
    if not isinstance(document, dict):
        raise ValueError("A catalog must be a JSON object.")
    if len(document) > CATALOG_MAX_KEYS:
        raise ValueError(f"A catalog may hold at most {CATALOG_MAX_KEYS} entries.")
    cleaned = {}
    for key, value in document.items():
        if not isinstance(key, str) or not key:
            raise ValueError("A catalog key must be a non-empty string.")
        if key == "_meta":
            if not isinstance(value, dict):
                raise ValueError("_meta must be an object.")
            cleaned[key] = {
                "name": str(value.get("name", ""))[:120],
                "direction": "rtl" if str(value.get("direction", "")).lower() == "rtl" else "ltr",
            }
            continue
        if not isinstance(value, str):
            raise ValueError(f"The value for {key!r} is not a string.")
        cleaned[key] = value[:CATALOG_MAX_VALUE]
    return cleaned


def remote_languages():
    """
    Interface languages the organization's control plane offers.

    Only meaningful once the workstation is enrolled and online, which is why
    this is a separate call and not part of the options the wizard opens with.
    """
    with state_lock:
        worker_url = state["workerUrl"]
    if not worker_url:
        raise ValueError("This workstation is not enrolled yet, so it has no server to ask.")
    request = Request(f"{worker_url}/api/i18n", headers={"User-Agent": "LabKioskAgent/i18n"})
    try:
        with open_url(request, timeout=10) as response:
            document = json.loads(response.read(CATALOG_MAX_BYTES).decode("utf-8"))
    except HTTPError as err:
        raise ValueError(f"The server answered {err.code} when asked for its languages.") from err
    except (URLError, TimeoutError, socket.timeout, ValueError, OSError) as err:
        raise ValueError(f"Could not reach {worker_url}: {err}") from err

    languages = document.get("languages", []) if isinstance(document, dict) else []
    installed = {entry["tag"] for entry in available_ui_languages()}
    result = []
    for entry in languages:
        if not isinstance(entry, dict):
            continue
        tag = str(entry.get("tag", ""))
        if not UI_LANGUAGE_PATTERN.match(tag):
            continue
        result.append({
            "tag": tag,
            "name": str(entry.get("name", tag))[:120],
            "direction": "rtl" if str(entry.get("direction", "")).lower() == "rtl" else "ltr",
            "installed": tag in installed,
        })
    return {"languages": result}


def download_language_catalog(tag):
    """Fetch one catalog and keep it on the data partition, where it survives."""
    if not UI_LANGUAGE_PATTERN.match(str(tag or "")):
        raise ValueError(f"{tag!r} is not a language tag.")
    with state_lock:
        worker_url = state["workerUrl"]
    if not worker_url:
        raise ValueError("This workstation is not enrolled yet, so it has no server to ask.")

    request = Request(f"{worker_url}/i18n/{tag}.json", headers={"User-Agent": "LabKioskAgent/i18n"})
    try:
        with open_url(request, timeout=15) as response:
            raw = response.read(CATALOG_MAX_BYTES + 1)
    except HTTPError as err:
        if err.code == 404:
            raise ValueError(f"The server has no catalog for {tag}.") from err
        raise ValueError(f"The server answered {err.code} for {tag}.") from err
    except (URLError, TimeoutError, socket.timeout, OSError) as err:
        raise ValueError(f"Could not download {tag}: {err}") from err

    if len(raw) > CATALOG_MAX_BYTES:
        raise ValueError(f"The catalog for {tag} is larger than {CATALOG_MAX_BYTES // 1024} KB.")
    try:
        catalog = validate_catalog(json.loads(raw.decode("utf-8")))
    except ValueError as err:
        raise ValueError(f"The catalog for {tag} is not usable: {err}") from err

    os.makedirs(UI_LANGUAGE_EXTRA_DIR, exist_ok=True)
    destination = os.path.join(UI_LANGUAGE_EXTRA_DIR, f"{tag}.json")
    temp_path = destination + ".tmp"
    with open(temp_path, "w", encoding="utf-8") as handle:
        json.dump(catalog, handle, ensure_ascii=False, indent=2)
    os.chmod(temp_path, 0o644)
    os.replace(temp_path, destination)
    log(f"Installed the {tag} interface catalog ({len(catalog)} entries).")
    return {"status": "ok", "tag": tag, "entries": len(catalog),
            "languages": available_ui_languages()}


def localization_options():
    options = run_localization_helper(["--list-options"], privileged=False)
    options["uiLanguages"] = available_ui_languages()
    options["saved"] = load_localization_config()
    return options


def configure_localization(data):
    """
    Apply the Language & Region step, then remember it.

    Validation lives in the helper, which checks each value against the system's
    own tables, so a value this agent has never heard of cannot be smuggled
    through by a caller that skipped the wizard.
    """
    args = []
    timezone = str(data.get("timezone", "")).strip()
    locale = str(data.get("locale", "")).strip()
    ui_language = str(data.get("uiLanguage", "")).strip()
    keymap = str(data.get("keymap", "")).strip()
    keymap_variant = str(data.get("keymapVariant", "")).strip()
    manual_time = str(data.get("time", "")).strip()
    sync_time = bool(data.get("syncTime", True))
    ntp_server = data.get("ntpServer", None)

    if timezone:
        args += ["--timezone", timezone]
    if locale:
        args += ["--locale", locale]
    if ui_language:
        known = {entry["tag"] for entry in available_ui_languages()}
        if ui_language not in known:
            raise ValueError(f"{ui_language} is not an interface language on this workstation.")
        args += ["--ui-language", ui_language]
    if keymap:
        args += ["--keymap", keymap]
        if keymap_variant:
            args += ["--keymap-variant", keymap_variant]
    if manual_time and not sync_time:
        args += ["--time", manual_time]
    else:
        args += ["--ntp", "on" if sync_time else "off"]
    if ntp_server is not None:
        args += ["--ntp-server", str(ntp_server).strip()]

    result = run_localization_helper(args, privileged=True)

    cfg = load_localization_config()
    cfg.update({
        "timezone": timezone or cfg.get("timezone", ""),
        "locale": locale or cfg.get("locale", ""),
        "uiLanguage": ui_language or cfg.get("uiLanguage", ""),
        "keymap": keymap or cfg.get("keymap", ""),
        "keymapVariant": keymap_variant if keymap else cfg.get("keymapVariant", ""),
        "syncTime": sync_time,
        "ntpServer": (str(ntp_server).strip() if ntp_server is not None
                      else cfg.get("ntpServer", "")),
    })
    save_localization_config(cfg)

    if keymap:
        # setxkbmap rebuilds the keymap from scratch, which puts back every F
        # key, Super key and media key labkiosk-lock-keys removed. The agent
        # runs inside the X session, so it is the one that can put them back
        # out again -- the helper is root and may not even reach the display.
        relock_keyboard(keymap, keymap_variant)

    # Accept-Language is what actually changes which version of a page site a
    # organization gets, so the browser is told as well as the system.
    sync_chromium_policies(cached_whitelist or [], force=True)
    os.environ.pop("TZ", None)
    time.tzset()
    return {"status": "ok", "applied": result.get("applied", {}), "saved": cfg}


def relock_keyboard(keymap, variant):
    """Apply a layout in the running session, then strip it again."""
    env = dict(os.environ)
    env.setdefault("DISPLAY", ":0")
    layout_cmd = ["setxkbmap", "-layout", keymap]
    if variant:
        layout_cmd += ["-variant", variant]
    for command in (layout_cmd, ["labkiosk-lock-keys"]):
        try:
            result = subprocess.run(
                command, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                text=True, timeout=20,
            )
            if result.returncode != 0:
                log(f"{command[0]} reported: {result.stderr.strip() or result.returncode}")
        except (OSError, subprocess.TimeoutExpired) as err:
            log(f"Could not run {command[0]}: {err}")


def apply_saved_localization():
    """
    Re-apply the saved settings at every start.

    This is the only place an installed workstation gets them back: it boots a
    system image under a RAM overlay, exactly as the ISO does, so the timezone,
    the keyboard, the time server and any generated locale are the image's own
    defaults again at every boot, and an update replaces the image altogether.
    The choice itself lives on LABKIOSK_DATA (docs/OTA_UPDATES.md section 5.2).
    The helper regenerates the locale and does nothing when it is already there.
    """
    cfg = load_localization_config()
    if not cfg:
        return
    args = []
    if cfg.get("timezone"):
        args += ["--timezone", str(cfg["timezone"])]
    if cfg.get("locale"):
        args += ["--locale", str(cfg["locale"])]
    if cfg.get("uiLanguage"):
        args += ["--ui-language", str(cfg["uiLanguage"])]
    if cfg.get("keymap"):
        args += ["--keymap", str(cfg["keymap"])]
        if cfg.get("keymapVariant"):
            args += ["--keymap-variant", str(cfg["keymapVariant"])]
    if cfg.get("ntpServer"):
        # The drop-in lives on the root filesystem, which is a RAM overlay on an
        # installed workstation, so it has to be written again at every boot.
        args += ["--ntp-server", str(cfg["ntpServer"])]
    if not args:
        return
    try:
        run_localization_helper(args, privileged=True)
        # The helper changed /etc/localtime under this process, which caches it.
        os.environ.pop("TZ", None)
        time.tzset()
        log("Re-applied the saved language and region settings.")
    except (ValueError, RuntimeError) as err:
        # Never fatal: a workstation with an odd locale must still come up.
        log(f"Could not re-apply the saved language and region settings: {err}")


# --------------------------------------------------------------------------
# Enrolment
# --------------------------------------------------------------------------

class EnrolmentUnreachable(ValueError):
    """The control plane could not be reached; trying again later may work."""


def enroll(subdomain, client_id, enrollment_key, worker_override=None, custom_domain=None):
    """
    Exchange the organization's enrollment key for this workstation's device token.

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
        raise ValueError("The organization address is not a valid server URL.")

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
        raise EnrolmentUnreachable(f"Could not reach {base_url}. Check the network connection.") from err

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
        # A re-enrolment starts clean: the previous organization's broadcast or
        # lock does not carry over.
        state["enrolmentRejected"] = False
        state["broadcastUrl"] = ""
        state["broadcastEpoch"] = 0
        state["isLocked"] = False

        state["pendingBrowserRestart"] = True
    heartbeat_wakeup.set()

    log(f"Enrolled {config['clientId']} with {config['subdomain'] or config['customDomain']}")
    persistent = enrolment_is_persistent()
    if not persistent:
        log(f"WARNING: {os.path.dirname(CONFIG_FILE)} is not the LABKIOSK_DATA "
            f"partition (it is {mounted_fstype(os.path.dirname(CONFIG_FILE)) or 'not a mount point'}), "
            "so this enrolment lives in RAM and will be gone at the next reboot.")
    return {
        "status": "ok",
        "organizationName": organization_name(data, subdomain or custom_domain),
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
            + ", so the organization address and the device token are only in memory "
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

    An installed disk boots its system image through live-boot too, so
    /run/live and boot=live are there either way; labkiosk.installed=1 on the
    command line is what tells them apart. The marker file identifies a disk
    installed before the image store, whose root is a copy of the live system.
    """
    if INSTALLED_KERNEL_ARG in kernel_cmdline().split() or os.path.exists("/etc/labkiosk-installed"):
        return False
    if os.path.exists("/run/live") or os.path.exists("/lib/live/mount"):
        return True
    return "boot=live" in kernel_cmdline()


def kernel_cmdline():
    """The raw kernel command line, or an empty string off Linux."""
    try:
        with open("/proc/cmdline", "r") as handle:
            return handle.read()
    except OSError:
        return ""


def kernel_arg(name):
    """The value of the last name=value on the kernel command line, or None."""
    value = None
    for arg in kernel_cmdline().split():
        if arg.startswith(name + "="):
            value = arg[len(name) + 1:]
    return value


def is_network_boot():
    """
    Started over the network from a boot server. It is a live session -- no
    disk, nothing kept -- but nobody is there to run the setup wizard: it
    enrols by itself (network_boot_enrol_loop) and offers no installer.
    """
    return NETBOOT_KERNEL_ARG in kernel_cmdline().split()


def network_boot_enrolment():
    """
    What the boot server's menu says to enrol with: labkiosk.org=<subdomain>
    or labkiosk.domain=<custom domain>, labkiosk.key=<enrollment key> and, for
    a server other than the platform's, labkiosk.server=<URL>. None when the
    menu names no organization (the workstation is then set up by hand);
    ValueError when it names one wrongly.
    """
    if not is_network_boot():
        return None
    subdomain = (kernel_arg("labkiosk.org") or "").lower()
    custom_domain = (kernel_arg("labkiosk.domain") or "").lower()
    key = (kernel_arg("labkiosk.key") or "").upper()
    server = kernel_arg("labkiosk.server")
    if not subdomain and not custom_domain and not key:
        return None
    if bool(subdomain) == bool(custom_domain):
        raise ValueError("the boot menu must name exactly one of labkiosk.org= and labkiosk.domain=")
    if subdomain and not ORG_SUBDOMAIN_PATTERN.match(subdomain):
        raise ValueError(f"labkiosk.org={subdomain[:64]!r} is not an organization subdomain")
    if custom_domain and not CUSTOM_DOMAIN_PATTERN.match(custom_domain):
        raise ValueError(f"labkiosk.domain={custom_domain[:64]!r} is not a domain name")
    if not enrollment_key_is_valid(key):
        raise ValueError("labkiosk.key= is not a valid enrollment key")
    if server is not None and not validate_worker_url(server):
        raise ValueError(f"labkiosk.server={server[:100]!r} is not a valid server URL")
    client_id = socket.gethostname().upper()
    if not CLIENT_ID_PATTERN.match(client_id):
        raise ValueError(f"the hostname {client_id[:64]!r} cannot be a workstation name")
    return {"subdomain": subdomain, "customDomain": custom_domain, "key": key, "server": server,
            "clientId": client_id}


def network_boot_enrol_loop(sleep=time.sleep):
    """
    Enrol a network-booted workstation with what its boot menu names, until it
    is enrolled: the control plane re-issues the device token of a workstation
    it already knows by name, so the same machine keeps its place in the
    console from one boot to the next.
    """
    try:
        params = network_boot_enrolment()
    except ValueError as err:
        log(f"Network boot: not enrolling by itself, because {err}.")
        return
    if params is None:
        return
    target = params["subdomain"] or params["customDomain"]
    while True:
        with state_lock:
            if state["isConfigured"]:
                return
        try:
            enroll(params["subdomain"], params["clientId"], params["key"], params["server"],
                   params["customDomain"])
            log(f"Network boot: enrolled as {params['clientId']} with {target}.")
            return
        except EnrolmentUnreachable as err:
            delay = NETBOOT_RETRY_SECONDS
            log(f"Network boot: {err} Trying again in {delay} s.")
        except Exception as err:  # noqa: BLE001 - logged; a refused key is retried slowly
            delay = NETBOOT_REFUSED_RETRY_SECONDS
            log(f"Network boot: enrolment with {target} failed: {err} Trying again in {delay} s.")
        sleep(delay)


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
    if is_network_boot():
        log("Started over the network; the disk installer is disabled.")
        return []
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


def start_disk_install(target_disk, grub_password_hash=None, hostname=None, beside=False,
                       replace_partition=None):
    def _run():
        try:
            log(f"Starting local disk installation to {target_disk}...")
            argv = ["sudo", "/usr/local/bin/labkiosk-install", "--target", target_disk]
            if replace_partition:
                argv += ["--replace-partition", replace_partition]
                log(f"Installing beside the drive's other system, in place of {replace_partition}.")
            elif beside:
                argv += ["--dual-boot"]
                log("Installing beside the drive's other system, in its free space.")
            if grub_password_hash:
                # A PBKDF2 digest, not the password, so its appearance in the
                # process list is not a credential disclosure. sudo resets the
                # environment by default, which is why this is an argument
                # rather than an exported variable.
                argv += ["--grub-password-hash", grub_password_hash]
                log("A boot-menu password was supplied for the installed system.")
            else:
                log("No boot-menu password supplied; the installed GRUB menu will be editable.")
            if hostname:
                argv += ["--hostname", hostname]
                log(f"The installed workstation will be named {hostname}.")
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
    development must never be sent through an organization proxy.
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
    """
    An installed workstation is gated, and so is a network-booted one whose
    boot menu sets labkiosk.admin=; live media is setup mode.
    """
    if is_network_boot():
        return kernel_arg("labkiosk.admin") is not None
    return not is_live_session()


def read_admin_password_hash():
    """
    The boot-menu PBKDF2 digest, or None when this installation has none.

    None is a deliberate state: the wizard warns before installing without a
    password that settings stay unlocked. A file that exists but cannot be
    read or parsed raises instead, so a damaged gate stays shut.

    A network-booted workstation has no boot partition: its boot server's menu
    passes the digest as labkiosk.admin=<grub.pbkdf2...>.
    """
    if is_network_boot():
        digest = kernel_arg("labkiosk.admin")
        if digest is None:
            return None
        if not GRUB_PBKDF2_PATTERN.match(digest):
            raise ValueError("labkiosk.admin= on the kernel command line is not a grub-mkpasswd-pbkdf2 digest")
        return digest
    try:
        with open(GRUB_PASSWORD_FILE, "r", encoding="utf-8") as handle:
            content = handle.read()
    except FileNotFoundError:
        # "No password" is only believable when the boot partition it would be
        # on is readable. If it is not mounted, an installed workstation cannot
        # tell, and the gate stays shut rather than opening for everyone.
        if is_live_session() or os.path.isfile(GRUB_CONFIG_FILE):
            return None
        raise ValueError(f"{BOOT_MEDIUM_GRUB_DIR} is not readable, so the password cannot be checked")
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
    server_version = f"LabKioskAgent/{AGENT_VERSION}"

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
        Reject cross-origin calls from a page the user navigated to.

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
        try:
            host = urlparse(origin).hostname
        except ValueError:
            _log_rejected_origin(origin)
            return False
        if host in ("127.0.0.1", "localhost"):
            return True
        _log_rejected_origin(origin)
        return False

    def _is_expected_host(self):
        """
        Require the request to be addressed to loopback by name.

        Binding to 127.0.0.1 stops packets from the network but not DNS
        rebinding: a page on an attacker's domain whose name briefly resolves to
        127.0.0.1 reaches this server through the user's own browser with an
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

        if self.path.split("?", 1)[0] == "/blocked":
            # Where the extension sends a page the managed policy blocked.
            # Chromium's own block page is chrome-error://, which no extension
            # runs on, so the kiosk bar -- and with it the network status and
            # the way back -- could never appear there. This page is on the
            # agent's origin, where the bar does.
            try:
                with open(BLOCKED_HTML_FILE, "rb") as handle:
                    self._send(200, handle.read(), "text/html; charset=utf-8")
            except OSError as err:
                log(f"Blocked-page notice missing at {BLOCKED_HTML_FILE}: {err}")
                self._send(500, b"<h1>This site is not allowed on this workstation</h1>", "text/html; charset=utf-8")
            return

        if self.path == "/api/status":
            live = is_live_session()
            network_boot = is_network_boot()
            online = test_connectivity()["ok"]
            screen = update_screen()
            power_off = power_off_screen()
            inputs = input_devices_report()
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
                        "reloadEpoch": state.get("reloadEpoch", 0),
                        "isConfigured": state["isConfigured"],
                        # True once the control plane refuses this workstation's
                        # device token; the wizard then offers to register again.
                        "enrolmentRejected": state["enrolmentRejected"],
                        "organization": state["subdomain"] or state["customDomain"],
                        "baseDomain": DEFAULT_BASE_DOMAIN,
                        # A network-booted workstation is a live session too,
                        # but one with no installer and nobody to set it up.
                        "isLive": live and not network_boot,
                        "isInstalled": not live,
                        "isNetworkBoot": network_boot,
                        "adminRequired": admin_auth_required(),
                        "isOnline": online,
                        # False on an installed workstation whose LABKIOSK_DATA
                        # partition is not mounted: it can be enrolled, but it
                        # forgets the enrolment at the next power-off.
                        "persistentStorage": enrolment_is_persistent(),
                        # Shown in the wizard's diagnostics: how to check
                        # Secure Boot on a machine with no shell.
                        "secureBoot": secure_boot_state(),
                        "clockSynchronized": clock_synchronized(),
                        "hostname": socket.gethostname(),
                        # The kiosk bar asks for this to know which interface
                        # catalog to fetch, once per boot.
                        "uiLanguage": str(load_localization_config().get("uiLanguage", "") or "en-US"),
                        # Only meaningful on live media; an installed disk has
                        # nothing to install to and the wizard hides the tab.
                        "installRequested": live and not network_boot and install_mode_requested(),
                        # A system update installing or finishing: the kiosk
                        # bar's curtain says so (None otherwise).
                        "updateScreen": screen,
                        # Whether a keyboard and a touchscreen are attached
                        # (None: cannot be told here). The kiosk bar opens its
                        # on-screen keyboard by itself when keyboardPresent is
                        # False and a text field gets the focus.
                        "keyboardPresent": inputs["keyboardPresent"],
                        "touchPresent": inputs["touchPresent"],
                        # A switch-off by the power schedule under way: the
                        # kiosk bar counts down to `at` (ms); `postponed` while
                        # a system update installs. None otherwise.
                        "powerOff": power_off,
                        # The kiosk bar shows its Print button, and lets Ctrl+P
                        # print, only while this is true (printing_ready).
                        "printing": printing_ready(),
                        # Home asks "Start over?" and, on Yes, posts
                        # /api/session/reset; otherwise it only navigates.
                        "homeReset": state["homeReset"],
                    },
                )
            return

        if self.path.split("?", 1)[0] == "/api/log":
            # Same gate as changing the network: on an installed workstation a
            # user must not be able to read it, but during setup, and on live
            # media, it has to be reachable before anything is configured.
            if admin_auth_required() and not has_admin_session(self.headers.get(ADMIN_TOKEN_HEADER, "")):
                self._send(401, {"error": "Administrator authentication is required"})
                return
            self._send(200, read_agent_log().encode("utf-8"), "text/plain; charset=utf-8")
            return

        if self.path == "/api/network/status":
            self._send(200, get_network_status())
            return

        if self.path.startswith("/i18n/") and self.path.endswith(".json"):
            # Interface catalogs, for the wizard and (through the service
            # worker) the kiosk top bar. Read-only, and the name is matched
            # against the pattern before it ever reaches a path.
            tag = self.path[len("/i18n/"):-len(".json")]
            if not UI_LANGUAGE_PATTERN.match(tag):
                self._send(404, {"error": "No such language"})
                return
            for directory in (UI_LANGUAGE_EXTRA_DIR, UI_LANGUAGE_DIR):
                candidate = os.path.join(directory, tag + ".json")
                try:
                    with open(candidate, "rb") as handle:
                        self._send(200, handle.read(), "application/json; charset=utf-8")
                        return
                except OSError:
                    continue
            self._send(404, {"error": "No such language"})
            return

        if self.path == "/api/localization/languages":
            # Deliberately separate from the options above: this one needs the
            # network and the control plane, and the wizard opens before either.
            try:
                self._send(200, remote_languages())
            except ValueError as err:
                self._send(400, {"error": str(err)})
            return

        if self.path == "/api/localization/options":
            try:
                self._send(200, localization_options())
            except (ValueError, RuntimeError) as err:
                log(f"Could not list localization options: {err}")
                self._send(500, {"error": str(err)})
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
            if is_network_boot():
                self._send(400, {"error": "A workstation started over the network is not installed to a drive"})
                return
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

            hostname = str(data.get("hostname", "") or "").strip()
            if hostname and not INSTALL_HOSTNAME_PATTERN.match(hostname):
                self._send(400, {"error": "The hostname must be 1-63 lowercase letters, digits and hyphens, not starting or ending with a hyphen"})
                return

            # Beside the drive's other system (dual boot), or the whole drive.
            # Dual boot is only as safe as that other system: anyone with
            # administrator rights there can change Lab Kiosk's partitions, so
            # the wizard has the administrator accept that in so many words.
            mode = str(data.get("mode", "erase") or "erase")
            if mode not in ("erase", "beside"):
                self._send(400, {"error": "The install mode must be erase or beside"})
                return
            replace_partition = str(data.get("replacePartition", "") or "").strip()
            if mode == "beside":
                if data.get("acceptRisk") is not True:
                    self._send(400, {"error": "Installing beside another system needs the administrator to accept that its administrators can change Lab Kiosk"})
                    return
                if replace_partition and not (
                    REPLACE_PARTITION_PATTERN.match(replace_partition)
                    and re.match(r"^p?[0-9]{1,3}\Z", replace_partition[len(target_disk):])
                    and replace_partition.startswith(target_disk)
                ):
                    self._send(400, {"error": "The partition to replace must be one partition of the target disk"})
                    return
            elif replace_partition:
                self._send(400, {"error": "A partition can be replaced only when installing beside another system"})
                return

            start_disk_install(target_disk, grub_hash or None, hostname or None, mode == "beside",
                               replace_partition or None)
            self._send(200, {"status": "started", "targetDisk": target_disk, "mode": mode})
            return

        if self.path == "/api/reboot":
            if admin_auth_required() and not has_admin_session(self.headers.get(ADMIN_TOKEN_HEADER, "")):
                self._send(401, {"error": "Administrator authentication is required"})
                return
            subprocess.Popen(["systemctl", "reboot"])
            self._send(200, {"status": "rebooting"})
            return

        if self.path == "/api/setup":
            with state_lock:
                already = state["isConfigured"]
            # Registering again replaces the enrolment, so on an installed
            # workstation it takes the administrator password, like changing its
            # network. It used to be refused outright, which left a workstation
            # whose organization was deleted with no way back but a reinstall.
            if already and admin_auth_required() and not has_admin_session(self.headers.get(ADMIN_TOKEN_HEADER, "")):
                self._send(401, {"error": "Administrator authentication is required to register this workstation again"})
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
                        "error": "Organization subdomain or custom domain, workstation name, and enrollment key are all required."
                    },
                )
                return

            if not enrollment_key_is_valid(enrollment_key):
                self._send(
                    400,
                    {
                        "error": (
                            "The enrollment key is not valid: it is 20 characters in four groups "
                            "(XXXXX-XXXXX-XXXXX-XXXXX), never contains the letters I, L, O, U or "
                            "the digits 0 and 1, and its last character checks the rest. One "
                            "character is wrong or two are swapped. Nothing was sent."
                        )
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

        if self.path == "/api/localization/language/download":
            if admin_auth_required() and not has_admin_session(self.headers.get(ADMIN_TOKEN_HEADER, "")):
                self._send(401, {"error": "Administrator authentication is required"})
                return
            data = self._read_json()
            if not isinstance(data, dict):
                self._send(400, {"error": "A JSON body is required"})
                return
            try:
                self._send(200, download_language_catalog(data.get("tag", "")))
            except ValueError as err:
                self._send(400, {"error": str(err)})
            except OSError as err:
                log(f"Could not store the catalog: {err}")
                self._send(500, {"error": f"Could not store the catalog: {err}"})
            return

        if self.path == "/api/localization/configure":
            # Same gate as the network: open while the workstation is being set
            # up, behind the boot password once it is installed and in a lab.
            if admin_auth_required() and not has_admin_session(self.headers.get(ADMIN_TOKEN_HEADER, "")):
                self._send(401, {"error": "Administrator authentication is required"})
                return
            data = self._read_json()
            if not isinstance(data, dict):
                self._send(400, {"error": "A JSON body is required"})
                return
            try:
                self._send(200, configure_localization(data))
            except ValueError as err:
                self._send(400, {"error": str(err)})
            except (RuntimeError, OSError) as err:
                log(f"Localization failed: {err}")
                self._send(500, {"error": f"Failed to apply language and region: {err}"})
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

        if self.path == "/api/usage/tick":
            # The extension, once a minute: the page's hostname and whether
            # someone used the keyboard, mouse or touchscreen in the last minute.
            data = self._read_json()
            if not isinstance(data, dict) or not isinstance(data.get("active"), bool) or not isinstance(data.get("host", ""), str):
                self._send(400, {"error": "Send host (text) and active (true or false)"})
                return
            usage_counter.tick(usage_host(data.get("host", "")[:300]), data["active"])
            self._send(200, {"status": "ok"})
            return

        if self.path == "/api/session/reset":
            # Home in the kiosk bar, confirmed by the user: the same end of a
            # session as the console's Clear session, when the organization
            # allows it. There is nothing to choose, so no body is read.
            with state_lock:
                allowed = state["homeReset"]
            if not allowed:
                self._send(409, {"error": "This organization does not let Home start a new session"})
                return
            log("Home in the kiosk bar started a new session.")
            clear_session()
            self._send(200, {"status": "ok"})
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
    -- so an operator's "lock screens" could arrive up to ten seconds late with
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
    Write the organization's allowlist into Chromium's managed enterprise policy.

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
        # would drop URLBlocklist and hand the user an unfiltered browser.
        log(
            f"REFUSING to update Chromium policy: {CHROMIUM_POLICY_BASE_FILE} is "
            "unreadable, so the blocklist cannot be reproduced. The browser keeps "
            "the policy it booted with."
        )
        return

    # The interface language the operator chose, and the locale's own language,
    # are what an organization website uses to decide which translation to serve.
    localization = load_localization_config()
    accept = []
    for tag in (str(localization.get("uiLanguage", "")), str(localization.get("locale", ""))):
        tag = tag.split(".")[0].replace("_", "-")
        if tag and tag not in accept:
            accept.append(tag)
            base = tag.split("-")[0]
            if base not in accept:
                accept.append(base)
    if accept:
        policy_data["AcceptLanguages"] = ",".join(accept)

    policy_data["HomepageLocation"] = target_url
    policy_data["NewTabPageLocation"] = target_url
    policy_data["URLAllowlist"] = list(dict.fromkeys(allowlist))

    # Chromium bypasses loopback on its own, so the agent's API and the setup
    # wizard stay reachable however the organization proxy is configured.
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

def restart_browser(reason="to apply the new policy"):
    """
    Ask the kiosk watchdog to relaunch Chromium.

    The watchdog loop in the Openbox autostart (and in the Docker simulator's
    entrypoint) relaunches the browser whenever it exits, re-reading the agent's
    current target URL, so terminating it is how the agent applies a new policy
    or a new home page. Before every launch it deletes BROWSER_PROFILE_DIR and
    the disk cache, so every restart is also a fresh, signed-out session.
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
            log(f"Restarting the browser {reason}")
        else:
            log(f"No running kiosk browser matched {pattern}; nothing to restart")
    except OSError as err:
        log(f"Could not restart the browser: {err}")


def clear_session():
    """
    The end of a session: sign every user out without a reboot.

    Ending Chromium is enough, because the kiosk watchdog deletes the profile
    (cookies, saved sign-ins, history, local storage, IndexedDB, service
    workers) and the disk cache before it relaunches, and the in-memory HTTP
    auth cache and X clipboard die with the process. The relaunch opens the
    page this workstation is assigned. The wipe stays in the watchdog on
    purpose: deleting the profile from here while Chromium still has it open
    would race its own writes.
    """
    restart_browser("to clear the session (profile and cache are wiped before relaunch)")
    usage_counter.session_started()


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
        with state_lock:
            state["reloadEpoch"] = int(time.time() * 1000)
    elif action in ("reboot", "shutdown"):
        with state_lock:
            installing = state["updateInstalling"]
        if installing:
            # The install restarts the machine itself; cutting it short would
            # leave the new image half-staged.
            log(f"Ignoring {action}: the update to {installing} is installing.")
            return
        if action == "shutdown":
            # Switched off from the console, it still switches itself on by its schedule.
            prepare_wake_alarm()
        run_x11(["systemctl", "reboot" if action == "reboot" else "poweroff"])
    elif action == "release-available":
        # The organization is offered a newer release: the root updater asks the
        # control plane which one, and fetches it in the background.
        if is_live_session():
            log("A release is available; a live session is updated by re-flashing.")
        else:
            start_update_unit(UPDATE_DOWNLOAD_UNIT)
    elif action == "install-update":
        begin_update_install(cmd_data.get("version"))
    elif action == "clear-session":
        clear_session()
    elif action == "mute":
        # Plain ALSA: the image ships alsa-utils and no sound server.
        run_x11(["amixer", "-q", "set", "Master", "mute"])
    elif action == "wake":
        # Workstations at this site that are off: the control plane took their
        # addresses from their own hardware reports (POST /api/clients/wake).
        send_magic_packets(cmd_data.get("macs"))
    else:
        log(f"Ignoring unknown action: {action}")


def navigate_to(new_url, epoch=0):
    """Point the kiosk browser at an operator-supplied URL."""
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

    # Make sure the page's host is allowed right away, without dropping the
    # rest of the organization's allowlist until the next heartbeat replaces it.
    sync_chromium_policies(sorted(set(cached_whitelist or []) | {parsed.hostname.lower()}))
    log(f"Broadcast navigation set to {new_url} (epoch {now_epoch})")


# --------------------------------------------------------------------------
# Telemetry loop
# --------------------------------------------------------------------------

def current_status():
    """What the console shows about this workstation, minus the screen."""
    with state_lock:
        status = {
            "clientNum": state["clientNum"],
            "activeUrl": state["targetUrl"],
            "isLocked": state["isLocked"],
        }
    # The VNC password, sent only when the workstation actually has one so the
    # control plane keeps whatever it already knows otherwise.
    vnc_password = read_vnc_password()
    if vnc_password:
        status["vncPassword"] = vnc_password
    status["agentVersion"] = AGENT_VERSION
    if image_version():
        status["imageVersion"] = image_version()
    status["update"] = read_update_report()
    # Only an installed disk keeps images to share; a live session is at no site.
    lan = None if is_live_session() else lan_report()
    if lan:
        status["lan"] = lan
    return status


def post_telemetry():
    """One heartbeat. Returns the decoded response, or raises on failure."""
    with state_lock:
        worker_url = state["workerUrl"]
        token = state["deviceToken"]

    payload = current_status()
    if http_pace["frames"]:
        payload["thumbnail"] = capture_thumbnail_base64()

    request = Request(
        f"{worker_url}/api/telemetry",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
            "User-Agent": f"LabKioskAgent/{AGENT_VERSION}",
        },
    )

    with open_url(request, timeout=8) as response:
        return json.loads(response.read().decode("utf-8"))


def read_root_json(path, owner_uid=0, max_bytes=MAX_BOOT_STATUS_BYTES):
    """
    A small JSON object root wrote under /run, or None when there is none.
    ValueError when the file is not what root wrote.
    """
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        return None
    except OSError as err:
        raise ValueError(f"{path} could not be opened: {err}") from err
    with os.fdopen(fd, "rb") as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != owner_uid:
            raise ValueError(f"{path} is not a file written by root")
        raw = handle.read(max_bytes + 1)
    if len(raw) > max_bytes:
        raise ValueError(f"{path} is larger than {max_bytes} bytes")
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as err:
        raise ValueError(f"{path} is not valid JSON: {err}") from err
    if not isinstance(data, dict):
        raise ValueError(f"{path} does not hold a JSON object")
    return data


def read_boot_report(path=BOOT_STATUS_FILE, owner_uid=0):
    """
    This boot's outcome as labkiosk-boot-slots recorded it, when it is one to
    report: a new image installed, a failed first boot, a rollback, a fallback
    or an error. None when there is nothing to report (a live session, a routine
    boot, a check still running). ValueError when the file is not what root wrote.
    """
    data = read_root_json(path, owner_uid)
    if data is None or data.get("state") not in BOOT_REPORT_STATES:
        return None
    at = data.get("at")
    if not isinstance(at, int) or isinstance(at, bool):
        raise ValueError(f"{path} has no time")
    report = {"state": data["state"], "at": at}
    for field in BOOT_REPORT_FIELDS:
        if isinstance(data.get(field), str) and data[field]:
            report[field] = data[field]
    return report


_image_version = None


def image_version(path=IMAGE_VERSION_FILE):
    """The system image this workstation runs, or "" when it cannot be read."""
    global _image_version
    if _image_version is None:
        try:
            with open(path, "r", encoding="utf-8") as handle:
                value = handle.read(64).strip()
        except OSError as err:
            log(f"System image version unreadable at {path}: {err}")
            value = ""
        _image_version = value if UPDATE_VERSION_PATTERN.match(value) else ""
    return _image_version


_update_state_problem = None


def read_update_report(path=UPDATE_STATE_FILE, owner_uid=0):
    """
    What this workstation says about system updates: a live session (updated
    by re-flashing), or labkiosk-update's last state, or idle when it has none.
    """
    global _update_state_problem
    if is_live_session():
        return {"phase": "live"}
    try:
        data = read_root_json(path, owner_uid)
    except ValueError as err:
        if _update_state_problem != str(err):
            _update_state_problem = str(err)
            log(f"Update state not reported: {err}")
        return {"phase": "error", "detail": "The update state is unreadable"}
    _update_state_problem = None
    if data is None or data.get("phase") not in UPDATE_PHASES:
        return {"phase": "idle"}
    report = {"phase": data["phase"]}
    if isinstance(data.get("version"), str) and UPDATE_VERSION_PATTERN.match(data["version"]):
        report["version"] = data["version"]
    progress = data.get("progress")
    if isinstance(progress, int) and not isinstance(progress, bool) and 0 <= progress <= 100:
        report["progress"] = progress
    if isinstance(data.get("detail"), str) and data["detail"].strip():
        report["detail"] = data["detail"].strip()[:MAX_UPDATE_DETAIL]
    # Phase 4: a security release `staged` for the next boot, and since when.
    if data.get("kind") in UPDATE_KINDS:
        report["kind"] = data["kind"]
    since = data.get("since")
    if isinstance(since, int) and not isinstance(since, bool) and since > 0:
        report["since"] = since
    return report


def _ip_json(args):
    """The JSON iproute2 prints for `ip -j <args>`."""
    proc = subprocess.run(
        ["ip", "-j", *args], capture_output=True, text=True, timeout=IP_COMMAND_TIMEOUT_SECONDS, check=False
    )
    if proc.returncode != 0:
        raise OSError(f"ip {' '.join(args)} failed: {(proc.stderr or proc.stdout).strip()[:200]}")
    return json.loads(proc.stdout or "null")


def read_lan_address():
    """
    This workstation's address on the network its traffic leaves by, and that
    subnet's prefix length: {"address": "192.168.1.23", "prefix": 24}. None when
    it is not on a private IPv4 subnet from /16 to /30, the only networks it
    shares a release on (docs/OTA_UPDATES.md section 5.9). Raises OSError or
    ValueError when iproute2 cannot say.
    """
    routes = _ip_json(["-4", "route", "get", LAN_PROBE_ADDRESS])
    route = routes[0] if isinstance(routes, list) and routes and isinstance(routes[0], dict) else {}
    device, source = route.get("dev"), route.get("prefsrc")
    if not isinstance(device, str) or not NET_DEVICE_PATTERN.match(device) or not isinstance(source, str):
        return None
    address = ipaddress.ip_address(source)
    if address.version != 4 or not any(address in network for network in LAN_PRIVATE_NETWORKS):
        return None
    for link in _ip_json(["-4", "addr", "show", "dev", device]) or []:
        for info in (link.get("addr_info") or []) if isinstance(link, dict) else []:
            if not isinstance(info, dict) or info.get("family") != "inet" or info.get("local") != source:
                continue
            prefix = info.get("prefixlen")
            if isinstance(prefix, bool) or not isinstance(prefix, int) or prefix not in LAN_PREFIX_RANGE:
                return None
            network = ipaddress.ip_network(f"{source}/{prefix}", strict=False)
            if address in (network.network_address, network.broadcast_address):
                return None
            return {"address": source, "prefix": prefix}
    return None


_lan_report = {"value": None, "at": None, "problem": None}


def lan_report(now=None):
    """read_lan_address(), at most once a minute; None when it cannot be read."""
    now = time.monotonic() if now is None else now
    cached = _lan_report
    if cached["at"] is not None and now - cached["at"] < LAN_REPORT_TTL_SECONDS:
        return cached["value"]
    try:
        value, problem = read_lan_address(), None
    except (OSError, ValueError, subprocess.SubprocessError) as err:
        value, problem = None, str(err)
        if problem != cached["problem"]:
            log(f"LAN address not reported: {problem}")
    cached.update(value=value, at=now, problem=problem)
    return value


_lan_sharing = {"allowed": None}


def apply_lan_sharing(allowed):
    """
    Stop serving releases on the LAN when the organization no longer shares
    them. Starting is the root updater's: it serves only a release it verified.
    """
    if not isinstance(allowed, bool) or allowed == _lan_sharing["allowed"]:
        return
    _lan_sharing["allowed"] = allowed
    if allowed or is_live_session():
        return
    try:
        result = subprocess.run(
            ["systemctl", "stop", "--no-block", LAN_SHARE_UNIT],
            capture_output=True,
            text=True,
            timeout=SYSTEMCTL_TIMEOUT_SECONDS,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as err:
        log(f"Could not stop {LAN_SHARE_UNIT}: {err}")
        _lan_sharing["allowed"] = None
        return
    if result.returncode != 0:
        log(f"Could not stop {LAN_SHARE_UNIT}: {(result.stderr or result.stdout).strip()[:300]}")
        _lan_sharing["allowed"] = None


# --------------------------------------------------------------------------
# Printing
# --------------------------------------------------------------------------

# "wanted" is the helper's printer list for what the control plane last said,
# [] for off; the image ships with printing off, so [] is also where a boot
# starts and nothing runs until an organization turns printing on.
_printing = {"wanted": [], "ready": False, "readyAt": 0.0, "unavailable": False}
_printing_cond = threading.Condition()


def printing_plan(value):
    """
    The printers this workstation should print to, as the helper takes them:
    [(queue, uri, name)]. [] means printing is off, which is also what anything
    malformed means -- a workstation never prints by mistake.
    """
    if not isinstance(value, dict) or value.get("enabled") is not True:
        return []
    printers = value.get("printers")
    if not isinstance(printers, list) or len(printers) > PRINTING_MAX_PRINTERS:
        log("Ignoring an unusable printer list from the control plane; printing stays off.")
        return []
    plan = []
    for printer in printers:
        if not isinstance(printer, dict) or any(f"labkiosk-{printer.get('id')}" == queue for queue, _, _ in plan):
            continue
        pid, uri, name = printer.get("id"), printer.get("uri"), printer.get("name")
        if not (isinstance(pid, str) and PRINTER_ID_PATTERN.match(pid)
                and isinstance(uri, str) and len(uri) <= 255 and PRINTER_URI_PATTERN.match(uri)
                and isinstance(name, str) and name.strip() and len(name) <= 64 and name.isprintable()):
            log(f"Ignoring an unusable printer from the control plane: {str(printer)[:200]}")
            continue
        plan.append((f"labkiosk-{pid}", uri, name))
    return plan


def apply_printing(value):
    """Hand what the control plane says about printing to the printing loop."""
    plan = printing_plan(value)
    with _printing_cond:
        if plan == _printing["wanted"]:
            return
        _printing["wanted"] = plan
        if not plan:
            # Hide the Print button before the policy goes.
            _printing["ready"] = False
        _printing_cond.notify_all()


def printing_ready():
    """Whether Chromium may print now: the helper allowed it and Chromium has reloaded its policy."""
    with _printing_cond:
        return _printing["ready"] and time.monotonic() >= _printing["readyAt"]


def run_printing_helper(plan):
    """Run labkiosk-printing for a plan; returns its JSON answer. Raises RuntimeError when it did not answer."""
    if plan:
        args = ["apply"]
        for queue, uri, name in plan:
            args += ["--printer", queue, uri, name]
    else:
        args = ["disable"]
    try:
        proc = subprocess.run(
            ["sudo", "-n", PRINTING_HELPER] + args, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, timeout=PRINTING_HELPER_TIMEOUT_SECONDS, check=False,
        )
    except (OSError, subprocess.SubprocessError) as err:
        raise RuntimeError(f"could not run {PRINTING_HELPER}: {err}") from err
    for line in (proc.stderr or "").strip().splitlines():
        log(line)
    try:
        answer = json.loads(proc.stdout or "")
    except ValueError as err:
        raise RuntimeError(f"{PRINTING_HELPER} returned no JSON ({(proc.stdout or '')[:120]!r})") from err
    if not isinstance(answer, dict):
        raise RuntimeError(f"{PRINTING_HELPER} returned {type(answer).__name__}, not an object")
    return answer


def printing_pass(plan):
    """
    Bring printing to `plan` once. Returns when to try again (a monotonic
    time), or None when there is nothing to retry.
    """
    if not os.path.exists(PRINTING_HELPER):
        with _printing_cond:
            first = not _printing["unavailable"]
            _printing["unavailable"] = True
            _printing["ready"] = False
        if first and plan:
            log(f"Printing is turned on, but this image has no {PRINTING_HELPER}; it cannot print.")
        return None
    try:
        answer = run_printing_helper(plan)
    except RuntimeError as err:
        log(f"Printing: {err}")
        answer = {"error": str(err)}
    allowed = bool(plan) and answer.get("policy") is True
    with _printing_cond:
        if _printing["wanted"] == plan:
            if allowed and (answer.get("policyChanged") is True or not _printing["ready"]):
                _printing["readyAt"] = time.monotonic() + PRINTING_POLICY_SETTLE_SECONDS
            _printing["ready"] = allowed
    if "error" in answer:
        log(f"Printing could not be {'set up' if plan else 'turned off'}: {str(answer['error'])[:300]}")
        return time.monotonic() + PRINTING_RETRY_SECONDS
    failed = answer.get("failed") or []
    if failed:
        log(f"Printing: {len(failed)} of {len(plan)} printers could not be set up; trying them again in "
            f"{PRINTING_RETRY_SECONDS // 60} minutes.")
        return time.monotonic() + PRINTING_RETRY_SECONDS
    if plan:
        log(f"Printing is on, to {len(plan)} printer{'s' if len(plan) != 1 else ''}.")
    else:
        log("Printing is off.")
    return None


def printing_loop():
    """Apply each change of printing as it comes, one at a time, and retry what failed."""
    applied = []
    retry_at = None
    while True:
        with _printing_cond:
            while _printing["wanted"] == applied and (retry_at is None or time.monotonic() < retry_at):
                _printing_cond.wait(None if retry_at is None else max(0.0, retry_at - time.monotonic()))
            plan = _printing["wanted"]
        retry_at = printing_pass(plan)
        applied = plan


def start_update_unit(unit):
    """Ask systemd to start one of the two update units. True when it took the job."""
    if unit not in (UPDATE_DOWNLOAD_UNIT, UPDATE_INSTALL_UNIT):
        raise ValueError(f"{unit} is not an update unit")
    try:
        result = subprocess.run(
            ["systemctl", "start", "--no-block", unit],
            capture_output=True,
            text=True,
            timeout=SYSTEMCTL_TIMEOUT_SECONDS,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as err:
        log(f"Could not start {unit}: {err}")
        return False
    if result.returncode != 0:
        log(f"Could not start {unit}: {(result.stderr or result.stdout).strip()[:300]}")
        return False
    log(f"Started {unit}")
    return True


def begin_update_install(version):
    """
    Install the release an administrator chose, if it is the one this
    workstation holds downloaded and verified; the install unit then restarts
    the machine. Until it does, the screen says an update is installing.
    """
    version = str(version or "")
    if is_live_session():
        log("Not installing an update on a live session; it is updated by re-flashing.")
        return False
    report = read_update_report()
    if not UPDATE_VERSION_PATTERN.match(version) or report.get("phase") != "ready" or report.get("version") != version:
        log(f"Not installing {version[:40]!r}: this workstation holds {json.dumps(report)}")
        return False
    with state_lock:
        state["updateInstalling"] = version
        state["updateInstallingSince"] = time.monotonic()
    if start_update_unit(UPDATE_INSTALL_UNIT):
        return True
    with state_lock:
        state["updateInstalling"] = ""
    return False


def update_screen(clock=time.monotonic):
    """
    What the kiosk bar's curtain says about a system update, or None.

    `installing` from an administrator's install until the restart, unless the
    install reports an error or no restart follows; `finishing` while a new
    image passes its first-start check.
    """
    with state_lock:
        version = state["updateInstalling"]
        since = state["updateInstallingSince"]
    if version:
        report = read_update_report()
        if report.get("phase") == "error" or clock() - since > UPDATE_SCREEN_TIMEOUT_SECONDS:
            log(f"The install of {version} did not restart this workstation: {report.get('detail', 'no restart followed')}")
            with state_lock:
                state["updateInstalling"] = ""
        else:
            return {"kind": "installing", "version": version}
    try:
        boot = read_root_json(BOOT_STATUS_FILE)
    except ValueError:
        return None
    if boot and boot.get("state") == "finishing" and isinstance(boot.get("version"), str) \
            and UPDATE_VERSION_PATTERN.match(boot["version"]):
        return {"kind": "finishing", "version": boot["version"]}
    return None


def post_boot_report(report):
    """Send one boot report. Returns the HTTP status; raises on a network failure."""
    with state_lock:
        worker_url = state["workerUrl"]
        token = state["deviceToken"]
    request = Request(
        f"{worker_url}/api/devices/boot-report",
        data=json.dumps(report).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
            "User-Agent": f"LabKioskAgent/{AGENT_VERSION}",
        },
    )
    try:
        with open_url(request, timeout=8) as response:
            return response.status
    except HTTPError as err:
        return err.code


def report_boot_outcome(settled):
    """
    Send this boot's outcome to the organization's console, once.

    `settled` is the (state, at) of the last report the control plane answered
    for good; the new one is returned. Anything else -- offline, a token being
    replaced, a workstation the hub has not written yet (409) -- is tried again
    on the next round. The Worker drops a report it already holds, so sending
    one twice after a restart records it once.
    """
    with state_lock:
        configured = state["isConfigured"]
    if not configured:
        return settled
    try:
        report = read_boot_report()
    except ValueError as err:
        problem = ("unreadable", str(err))
        if settled != problem:
            log(f"Boot outcome not reported: {err}")
        return problem
    if report is None:
        return settled
    key = (report["state"], report["at"])
    if key == settled:
        return settled
    try:
        status = post_boot_report(report)
    except (URLError, TimeoutError, socket.timeout, OSError) as err:
        log(f"Boot outcome not sent yet: {err}")
        return settled
    if status == 200:
        log(f"Reported this boot's outcome to the organization: {report['state']} {report.get('version', '')}".rstrip())
        return key
    if status in BOOT_REPORT_SETTLED_STATUSES:
        log(f"The control plane did not take the boot outcome (HTTP {status}); not sending it again.")
        return key
    log(f"Boot outcome not recorded yet (HTTP {status}); trying again.")
    return settled


def read_restart_report(dir_fd, name, owner_uid=0):
    """One report labkiosk-logs wrote. ValueError when it is not what root wrote."""
    match = RESTART_REPORT_NAME_PATTERN.match(name)
    if not match:
        raise ValueError(f"{name} is not a restart report")
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=dir_fd)
    except OSError as err:
        raise ValueError(f"{name} could not be opened: {err}") from err
    with os.fdopen(fd, "rb") as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != owner_uid:
            raise ValueError(f"{name} is not a file written by root")
        raw = handle.read(MAX_RESTART_REPORT_BYTES + 1)
    if len(raw) > MAX_RESTART_REPORT_BYTES:
        raise ValueError(f"{name} is larger than {MAX_RESTART_REPORT_BYTES} bytes")
    try:
        report = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as err:
        raise ValueError(f"{name} is not valid JSON: {err}") from err
    if not isinstance(report, dict) or report.get("bootId") != match.group(1):
        raise ValueError(f"{name} is not the report of boot {match.group(1)}")
    return report


def read_restart_reports(directory=RESTART_REPORTS_DIR, owner_uid=0):
    """
    The restart reports waiting in `directory`, oldest first, and the problems
    met reading them. No reports on a live session or an older disk.
    """
    try:
        dir_fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    except FileNotFoundError:
        return [], []
    except OSError as err:
        return [], [f"{directory} could not be opened: {err}"]
    reports, problems = [], []
    try:
        if os.fstat(dir_fd).st_uid != owner_uid:
            return [], [f"{directory} is not a folder of root's"]
        names = sorted(name for name in os.listdir(dir_fd) if not name.startswith("."))
        for name in names[:MAX_RESTART_REPORTS]:
            try:
                reports.append(read_restart_report(dir_fd, name, owner_uid))
            except ValueError as err:
                problems.append(str(err))
    finally:
        os.close(dir_fd)
    reports.sort(key=lambda report: report.get("endedAt") if isinstance(report.get("endedAt"), int) else 0)
    return reports, problems


def load_sent_restart_reports(path=RESTART_REPORTS_SENT_FILE):
    """The boot ids whose reports the control plane has answered for good."""
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.loads(handle.read(MAX_RESTART_REPORT_BYTES))
    except FileNotFoundError:
        return set()
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as err:
        log(f"{path} is unreadable ({err}); restart reports may be sent again, and the console keeps one of each.")
        return set()
    ids = data.get("sent") if isinstance(data, dict) else None
    if not isinstance(ids, list):
        log(f"{path} does not list the restart reports sent; they may be sent again.")
        return set()
    return {value for value in ids if isinstance(value, str) and RESTART_REPORT_NAME_PATTERN.match(f"{value}.json")}


def save_sent_restart_reports(sent, path=RESTART_REPORTS_SENT_FILE):
    temp_path = path + ".tmp"
    try:
        with open(temp_path, "w", encoding="utf-8") as handle:
            json.dump({"sent": sorted(sent)}, handle)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temp_path, 0o600)
        os.replace(temp_path, path)
    except OSError as err:
        log(f"Could not record which restart reports were sent ({err}); they may be sent again after a restart.")


def post_restart_report(report):
    """Send one restart report. Returns the HTTP status; raises on a network failure."""
    with state_lock:
        worker_url = state["workerUrl"]
        token = state["deviceToken"]
    request = Request(
        f"{worker_url}/api/devices/restart-report",
        data=json.dumps(report).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
            "User-Agent": f"LabKioskAgent/{AGENT_VERSION}",
        },
    )
    try:
        with open_url(request, timeout=15) as response:
            return response.status
    except HTTPError as err:
        return err.code


def report_restarts(progress):
    """
    Send the reports of boots that ended without shutting down, each once.

    `progress` lives as long as the agent: "sent" is the list kept on the data
    partition, "logged" the problems already written to the log, and "held"
    turns true when the control plane says this workstation sent too many
    today (429), so the rest wait for the next start. Offline, a token being
    replaced or a workstation not written yet (409) is tried again next round;
    the Worker keeps one issue per boot, so a report sent twice counts once.
    """
    with state_lock:
        configured = state["isConfigured"]
    if not configured or progress["held"]:
        return
    reports, problems = read_restart_reports()
    for problem in problems:
        if problem not in progress["logged"]:
            progress["logged"].add(problem)
            log(f"Restart report not sent: {problem}")
    sent = progress["sent"]
    changed = False
    if not problems:
        # labkiosk-logs deletes a report after seven days; forget it here too.
        # Not while any report is unreadable: that one may already be sent.
        waiting = {report["bootId"] for report in reports}
        changed = bool(sent - waiting)
        sent &= waiting
    for report in reports:
        boot_id = report["bootId"]
        if boot_id in sent:
            continue
        try:
            status = post_restart_report(report)
        except (URLError, TimeoutError, socket.timeout, OSError) as err:
            if "offline" not in progress["logged"]:
                progress["logged"].add("offline")
                log(f"Restart reports not sent yet: {err}")
            break
        progress["logged"].discard("offline")
        if status == 200:
            log(f"Reported to the organization that boot {boot_id} ended without shutting down ({report.get('kind')}).")
        elif status in BOOT_REPORT_SETTLED_STATUSES:
            log(f"The control plane did not take the restart report of boot {boot_id} (HTTP {status}); not sending it again.")
        elif status == 429:
            log("The control plane has taken enough restart reports from this workstation today; the rest wait for the next start.")
            progress["held"] = True
            break
        else:
            log(f"Restart report of boot {boot_id} not recorded yet (HTTP {status}); trying again.")
            break
        sent.add(boot_id)
        changed = True
    if changed:
        save_sent_restart_reports(sent)


def read_disk_problems(path=DISK_HEALTH_FILE, owner_uid=0):
    """
    The disks labkiosk-health found wearing out or failing, as the Worker takes
    them. None when it has not checked yet. ValueError when the file is not
    what root wrote.
    """
    data = read_root_json(path, owner_uid, MAX_DISK_HEALTH_BYTES)
    if data is None:
        return None
    disks = data.get("disks")
    if not isinstance(disks, list):
        raise ValueError(f"{path} does not list disks")
    problems = []
    for disk in disks[:MAX_DISKS_REPORTED]:
        if not isinstance(disk, dict) or disk.get("state") not in DISK_PROBLEM_STATES:
            continue
        if not all(isinstance(disk.get(field), str) for field in DISK_FIELDS):
            raise ValueError(f"{path} has a disk without {', '.join(DISK_FIELDS)}")
        problems.append({field: disk[field] for field in DISK_FIELDS})
    return problems


def post_disk_health(problems):
    """Send the problem disks. Returns the HTTP status; raises on a network failure."""
    with state_lock:
        worker_url = state["workerUrl"]
        token = state["deviceToken"]
    request = Request(
        f"{worker_url}/api/devices/disk-health",
        data=json.dumps({"disks": problems}).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
            "User-Agent": f"LabKioskAgent/{AGENT_VERSION}",
        },
    )
    try:
        with open_url(request, timeout=15) as response:
            return response.status
    except HTTPError as err:
        return err.code


def report_disk_health(progress, path=DISK_HEALTH_FILE):
    """
    Send the result of each disk check that found a problem, once.

    `progress["checked"]` is the modification time of the check last dealt
    with; "logged" the problems already written to the log. Offline, a token
    being replaced or a workstation not written yet (409) is tried again next
    round; anything else waits for the next check.
    """
    with state_lock:
        configured = state["isConfigured"]
    if not configured:
        return
    try:
        checked = os.stat(path).st_mtime_ns
    except FileNotFoundError:
        return
    except OSError as err:
        message = f"Disk health not read: {err}"
        if message not in progress["logged"]:
            progress["logged"].add(message)
            log(message)
        return
    if checked == progress["checked"]:
        return
    try:
        problems = read_disk_problems(path)
    except ValueError as err:
        log(f"Disk health not reported: {err}")
        progress["checked"] = checked
        return
    if not problems:
        progress["checked"] = checked
        return
    for disk in problems:
        log(f"Disk {disk['device']} is {'failing' if disk['state'] == 'failing' else 'wearing out'}: {disk['summary']}")
    try:
        status = post_disk_health(problems)
    except (URLError, TimeoutError, socket.timeout, OSError) as err:
        if "offline" not in progress["logged"]:
            progress["logged"].add("offline")
            log(f"Disk health not reported yet: {err}")
        return
    progress["logged"].discard("offline")
    if status == 200:
        log("Reported the disk problems to the organization.")
    elif status in BOOT_REPORT_SETTLED_STATUSES:
        log(f"The control plane did not take the disk health report (HTTP {status}); not sending it again.")
    elif status == 429:
        log("The control plane has taken enough disk reports from this workstation today; the next check sends again.")
    else:
        log(f"Disk health report not recorded yet (HTTP {status}); trying again.")
        return
    progress["checked"] = checked


def parse_vainfo(output):
    """
    vainfo's report as {"vaDriver", "decode", "encode"}: the driver's own name
    and the codecs it decodes (VLD) and encodes, each sorted. ValueError when
    the output names no driver, which is how vainfo says none loaded.
    """
    driver = ""
    decode, encode = set(), set()
    for line in output.splitlines():
        found = VA_DRIVER_LINE.search(line)
        if found:
            driver = "".join(ch for ch in found.group(1) if ch.isprintable())[:MAX_VA_DRIVER_LENGTH]
            continue
        match = VA_PROFILE_LINE.match(line)
        if not match:
            continue
        profile, entrypoint = match.groups()
        codec = next((name for prefix, name in VA_PROFILE_CODECS if profile.startswith(prefix)), None)
        if codec is None:
            continue
        if entrypoint in VA_DECODE_ENTRYPOINTS:
            decode.add(codec)
        elif entrypoint in VA_ENCODE_ENTRYPOINTS:
            encode.add(codec)
    if not driver:
        raise ValueError("vainfo found no VA-API driver")
    return {"vaDriver": driver, "decode": sorted(decode), "encode": sorted(encode)}


def gpu_identity(node, drm_dir=DRM_CLASS_DIR):
    """The vendor (intel, amd, nvidia, virtual, other) and kernel driver behind a render node."""
    device = os.path.join(drm_dir, node, "device")
    try:
        with open(os.path.join(device, "vendor"), encoding="ascii") as handle:
            vendor = GPU_VENDORS.get(handle.read().strip().lower(), "other")
    except (OSError, UnicodeDecodeError):
        vendor = "other"
    try:
        driver = os.path.basename(os.readlink(os.path.join(device, "driver")))
    except OSError:
        driver = ""
    if not re.match(r"^[A-Za-z0-9_.-]{1,40}\Z", driver):
        driver = ""
    return vendor, driver


def run_vainfo(device):
    """vainfo's output for one render node. Raises OSError or ValueError when it cannot say."""
    try:
        proc = subprocess.run(
            ["vainfo", "--display", "drm", "--device", device],
            capture_output=True, text=True, timeout=VAINFO_TIMEOUT_SECONDS, check=False,
        )
    except subprocess.TimeoutExpired as err:
        raise OSError(f"vainfo did not answer within {VAINFO_TIMEOUT_SECONDS} s") from err
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout).strip().splitlines()
        raise ValueError(detail[-1][:200] if detail else f"vainfo exited with {proc.returncode}")
    return proc.stdout


def probe_video_decoding(drm_dir=DRM_CLASS_DIR, vainfo=None):
    """
    What this machine's GPUs decode in hardware: {"gpus": [...]}, one entry
    per render node (at most MAX_GPUS_REPORTED) with its vendor, kernel driver,
    VA-API driver and codec lists, or "problem" saying why there is none.
    Chromium decodes on the CPU whenever this finds nothing.
    """
    vainfo = vainfo or run_vainfo
    try:
        nodes = sorted(n for n in os.listdir(drm_dir) if RENDER_NODE_PATTERN.match(n))
    except OSError:
        nodes = []
    if not nodes:
        return {"gpus": [], "problem": "No GPU render device (/dev/dri/renderD*)."}
    gpus = []
    for node in nodes[:MAX_GPUS_REPORTED]:
        vendor, driver = gpu_identity(node, drm_dir)
        gpu = {"vendor": vendor, "kernelDriver": driver, "vaDriver": "", "decode": [], "encode": []}
        try:
            gpu.update(parse_vainfo(vainfo(f"/dev/dri/{node}")))
        except FileNotFoundError:
            gpu["problem"] = "vainfo is not installed."
        except (OSError, ValueError) as err:
            gpu["problem"] = str(err)[:200]
        gpus.append(gpu)
    return {"gpus": gpus}


def post_video_decoding(report):
    """Send the video decoding report. Returns the HTTP status; raises on a network failure."""
    with state_lock:
        worker_url = state["workerUrl"]
        token = state["deviceToken"]
    request = Request(
        f"{worker_url}/api/devices/video-decoding",
        data=json.dumps(report).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
            "User-Agent": f"LabKioskAgent/{AGENT_VERSION}",
        },
    )
    try:
        with open_url(request, timeout=15) as response:
            return response.status
    except HTTPError as err:
        return err.code


def report_video_decoding(progress):
    """
    Read the GPUs once and send what they decode, once per agent start.

    `progress["report"]` is the probe's result, `progress["done"]` true once
    the control plane has answered for good. Offline or a workstation not
    written yet (409) is tried again next round.
    """
    if progress["done"]:
        return
    with state_lock:
        configured = state["isConfigured"]
    if not configured:
        return
    if progress["report"] is None:
        progress["report"] = probe_video_decoding()
        decoders = sorted({codec for gpu in progress["report"]["gpus"] for codec in gpu["decode"]})
        log(f"Hardware video decoding: {', '.join(decoders) if decoders else 'none, Chromium decodes on the CPU'}.")
    try:
        status = post_video_decoding(progress["report"])
    except (URLError, TimeoutError, socket.timeout, OSError) as err:
        if not progress["logged"]:
            progress["logged"] = True
            log(f"Video decoding not reported yet: {err}")
        return
    if status == 200:
        progress["done"] = True
    elif status in BOOT_REPORT_SETTLED_STATUSES:
        log(f"The control plane did not take the video decoding report (HTTP {status}); not sending it again.")
        progress["done"] = True


# --------------------------------------------------------------------------
# Hardware report and usage counting
# --------------------------------------------------------------------------

def read_sys_text(path, limit=200):
    """One line of a sysfs or procfs file, stripped; "" when it cannot be read."""
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as handle:
            return handle.read(limit * 2).strip()[:limit]
    except OSError:
        return ""


def hardware_model(vendor, product_name, product_version):
    """
    The model to report. Lenovo firmware puts a machine-type code (10T7S0B500)
    in product_name and the model people know (ThinkCentre M720q) in
    product_version; everyone else puts the model in product_name.
    """
    if vendor.lower().startswith("lenovo") and product_version and product_version.lower() not in ("none", "lenovo"):
        return product_version
    return product_name


def read_cpu_model(cpuinfo=CPUINFO_FILE):
    try:
        with open(cpuinfo, "r", encoding="utf-8", errors="replace") as handle:
            for line in handle:
                key, _, value = line.partition(":")
                if key.strip() in ("model name", "Model", "Hardware"):
                    return " ".join(value.split())[:120]
    except OSError as err:
        log(f"Could not read the CPU model: {err}")
    return ""


def read_memory_mb(meminfo=MEMINFO_FILE):
    try:
        with open(meminfo, "r", encoding="utf-8") as handle:
            for line in handle:
                if line.startswith("MemTotal:"):
                    return int(line.split()[1]) // 1024
    except (OSError, ValueError, IndexError) as err:
        log(f"Could not read the memory size: {err}")
    return 0


def wired_adapters(net_dir=NET_CLASS_DIR):
    """
    This machine's wired Ethernet adapters as (name, MAC address): physical
    (a `device` link), not wireless, ARP type 1. What Wake-on-LAN can reach,
    and what a wake command sends its magic packets on.
    """
    adapters = []
    try:
        names = sorted(os.listdir(net_dir))
    except OSError as err:
        log(f"Could not list the network adapters: {err}")
        return adapters
    for name in names:
        base = os.path.join(net_dir, name)
        if not os.path.exists(os.path.join(base, "device")):
            continue
        if os.path.exists(os.path.join(base, "wireless")) or os.path.exists(os.path.join(base, "phy80211")):
            continue
        if read_sys_text(os.path.join(base, "type"), 8) != "1":
            continue
        mac = read_sys_text(os.path.join(base, "address"), 32).lower()
        if MAC_ADDRESS_PATTERN.match(mac) and mac != "00:00:00:00:00:00" and mac not in (m for _, m in adapters):
            adapters.append((name, mac))
        if len(adapters) >= MAX_WIRED_MACS:
            break
    return adapters


def wired_macs(net_dir=NET_CLASS_DIR):
    """The MAC addresses of this machine's wired Ethernet adapters (wired_adapters)."""
    return [mac for _, mac in wired_adapters(net_dir)]


def probe_hardware(dmi_dir=DMI_DIR, net_dir=NET_CLASS_DIR, efi_dir=EFI_DIR, cpuinfo=CPUINFO_FILE, meminfo=MEMINFO_FILE,
                   inputs=None):
    """What this machine is, for its organization's console and the hardware list.

    inputs is input_devices_report()'s answer; keyboard and touch stay None
    where it could not tell (a container, a VM driven over VNC).
    """
    if inputs is None:
        inputs = input_devices_report()
    vendor = read_sys_text(os.path.join(dmi_dir, "sys_vendor"), 80)
    model = hardware_model(
        vendor,
        read_sys_text(os.path.join(dmi_dir, "product_name"), 80),
        read_sys_text(os.path.join(dmi_dir, "product_version"), 80),
    )
    return {
        "vendor": vendor,
        "model": model,
        "cpu": read_cpu_model(cpuinfo),
        "cores": max(1, min(1024, os.cpu_count() or 1)),
        "memoryMb": max(64, read_memory_mb(meminfo)),
        "bootMode": "uefi" if os.path.isdir(efi_dir) else "bios",
        "keyboard": inputs["keyboardPresent"],
        "touch": inputs["touchPresent"],
        "macs": wired_macs(net_dir),
    }


def post_device_json(path, payload, timeout=15):
    """POST a report as this workstation. Returns the HTTP status; raises on a network failure."""
    with state_lock:
        worker_url = state["workerUrl"]
        token = state["deviceToken"]
    request = Request(
        f"{worker_url}{path}",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
            "User-Agent": f"LabKioskAgent/{AGENT_VERSION}",
        },
    )
    try:
        with open_url(request, timeout=timeout) as response:
            return response.status
    except HTTPError as err:
        return err.code


def report_hardware(progress):
    """
    Read the machine once and send it, once per agent start, the same way as
    report_video_decoding: offline or a row not written yet (409) is tried again.
    """
    if progress["done"]:
        return
    with state_lock:
        configured = state["isConfigured"]
    if not configured:
        return
    if progress["report"] is None:
        progress["report"] = probe_hardware()
        report = progress["report"]
        log(
            f"Hardware: {report['vendor'] or 'unknown maker'} {report['model'] or 'unknown model'}, "
            f"{report['cores']} cores, {report['memoryMb']} MB, {report['bootMode'].upper()}, "
            f"{len(report['macs'])} wired adapters."
        )
    try:
        status = post_device_json("/api/devices/hardware", progress["report"])
    except (URLError, TimeoutError, socket.timeout, OSError) as err:
        if not progress["logged"]:
            progress["logged"] = True
            log(f"Hardware not reported yet: {err}")
        return
    if status == 200:
        progress["done"] = True
    elif status in BOOT_REPORT_SETTLED_STATUSES:
        log(f"The control plane did not take the hardware report (HTTP {status}); not sending it again.")
        progress["done"] = True


def usage_host(raw):
    """A site's hostname as usage reports keep it, or "" for anything else (an IP address, localhost, a local page)."""
    if not isinstance(raw, str):
        return ""
    host = raw.strip().lower().rstrip(".")
    return host if USAGE_HOST_PATTERN.match(host) else ""


class UsageCounter:
    """
    What this workstation counts for its organization's usage reports, per
    calendar day of its own clock: seconds on, seconds in use, fresh sessions
    and -- when the organization records them -- seconds in use and visits per
    site. The browser extension ticks once a minute with the page's hostname
    and whether someone used the keyboard, mouse or touchscreen in the last
    minute; each tick credits the time since the previous one to what the
    previous one said. Kept in memory only: a power cut loses at most one
    report period.
    """

    def __init__(self, clock=time.monotonic, today=None):
        self._clock = clock
        self._today = today or (lambda: time.strftime("%Y-%m-%d"))
        self._lock = threading.Lock()
        self._days = {}
        self._last_tick = None
        self._last_on = clock()
        self.record_sites = False

    def _day(self, day):
        return self._days.setdefault(day, {"onSeconds": 0.0, "activeSeconds": 0.0, "sessions": 0, "sites": {}})

    def count_on(self):
        """Credit the time since the last call as switched on."""
        with self._lock:
            now = self._clock()
            elapsed = min(max(0.0, now - self._last_on), USAGE_ON_MAX_CREDIT_SECONDS)
            self._last_on = now
            self._day(self._today())["onSeconds"] += elapsed

    def session_started(self):
        with self._lock:
            self._day(self._today())["sessions"] += 1

    def tick(self, host, active):
        with self._lock:
            now = self._clock()
            day = self._day(self._today())
            previous = self._last_tick
            if previous is not None:
                elapsed = min(max(0.0, now - previous[0]), USAGE_TICK_MAX_CREDIT_SECONDS)
                if previous[2]:
                    day["activeSeconds"] += elapsed
                    if self.record_sites and previous[1] and previous[1] in day["sites"]:
                        day["sites"][previous[1]]["seconds"] += elapsed
            if self.record_sites and host and (previous is None or previous[1] != host):
                site = day["sites"].get(host)
                if site is None and len(day["sites"]) < USAGE_MAX_SITES_PER_DAY:
                    site = day["sites"][host] = {"seconds": 0.0, "visits": 0}
                if site is not None:
                    site["visits"] += 1
            self._last_tick = (now, host, bool(active))

    def set_record_sites(self, allowed):
        """The organization's choice; turned off, the sites counted so far are dropped too."""
        with self._lock:
            self.record_sites = allowed
            if not allowed:
                for day in self._days.values():
                    day["sites"] = {}

    def take(self):
        """
        Everything counted so far, as the report's `days`, and forget it.
        Days older than the control plane takes are dropped.
        """
        oldest = time.strftime("%Y-%m-%d", time.localtime(time.time() - USAGE_MAX_AGE_DAYS * 86400))
        with self._lock:
            days, self._days = self._days, {}
        report = []
        for name in sorted(days)[-USAGE_MAX_DAYS_PER_REPORT:]:
            if name < oldest:
                continue
            day = days[name]
            on = int(round(day["onSeconds"]))
            active = min(on, int(round(day["activeSeconds"])))
            sites = [
                {"domain": host, "seconds": min(active, int(round(site["seconds"]))), "visits": site["visits"]}
                for host, site in sorted(day["sites"].items())
            ]
            if on or active or day["sessions"] or sites:
                report.append({"day": name, "onSeconds": on, "activeSeconds": active, "sessions": day["sessions"], "sites": sites})
        return report

    def put_back(self, report):
        """Add a report that could not be sent back to what is being counted."""
        with self._lock:
            for entry in report:
                day = self._day(entry["day"])
                day["onSeconds"] += entry["onSeconds"]
                day["activeSeconds"] += entry["activeSeconds"]
                day["sessions"] += entry["sessions"]
                for site in entry["sites"]:
                    known = day["sites"].get(site["domain"])
                    if known is None and len(day["sites"]) >= USAGE_MAX_SITES_PER_DAY:
                        continue
                    known = day["sites"].setdefault(site["domain"], {"seconds": 0.0, "visits": 0})
                    known["seconds"] += site["seconds"]
                    known["visits"] += site["visits"]


usage_counter = UsageCounter()


def report_usage(counter=usage_counter):
    """Send what was counted. Kept for the next round when offline or refused for now; dropped when malformed or not taken at all (404)."""
    with state_lock:
        configured = state["isConfigured"]
    if not configured:
        return
    report = counter.take()
    if not report:
        return
    try:
        status = post_device_json("/api/devices/usage", {"days": report})
    except (URLError, TimeoutError, socket.timeout, OSError) as err:
        counter.put_back(report)
        log(f"Usage not reported yet: {err}")
        return
    if status == 200:
        return
    if status == 400:
        log("The control plane refused a usage report as malformed (HTTP 400); dropping it.")
        return
    if status == 404:
        # A control plane older than usage reports: it has nowhere to keep them.
        log("The control plane does not take usage reports (HTTP 404); dropping this one.")
        return
    counter.put_back(report)
    log(f"Usage not reported yet (HTTP {status}).")


def usage_loop(sleep=time.sleep, clock=time.monotonic):
    usage_counter.session_started()
    next_report = clock() + USAGE_REPORT_SECONDS
    while True:
        sleep(USAGE_ON_STEP_SECONDS)
        usage_counter.count_on()
        if clock() >= next_report:
            next_report = clock() + USAGE_REPORT_SECONDS
            report_usage()


# --------------------------------------------------------------------------
# Power schedules and Wake-on-LAN
# --------------------------------------------------------------------------
#
# The organization's power schedule arrives with the configuration as `power`:
# {"week": [day, ...]} with seven entries, Sunday first, each null or
# {"off": minutes, "on": minutes|null} after midnight on this machine's own
# clock (src/power.ts). At a switch-off time the kiosk bar warns for
# POWER_WARNING_SECONDS, then the machine shuts down cleanly -- never while a
# system update installs: that waits, and is retried, and a restart the update
# makes picks the shutdown up again (POWER_PENDING_FILE). Before it shuts down,
# the hardware clock is set to wake the machine at the next switch-on through
# labkiosk-wake-alarm (root, via sudo), and a machine that cannot be set is
# reported to the console (POST /api/devices/power-report).
#
# A `wake` command names the MAC addresses of workstations that are off at
# this one's site; the agent sends each a magic packet on its wired networks.

POWER_WARNING_SECONDS = 5 * 60
POWER_CHECK_SECONDS = 15
# A shutdown an installing update holds back is tried again this often.
POWER_POSTPONE_SECONDS = 60
# Two checks further apart than this are a clock change (the first time sync
# after boot), not a switch-off that was missed: nothing fires for it.
POWER_CLOCK_JUMP_SECONDS = 5 * 60
# A shutdown an update held back, kept across the restart the update makes.
POWER_PENDING_FILE = "/etc/labkiosk/power-pending.json"
# ...and honoured only this long after its switch-off time.
POWER_PENDING_MAX_AGE_SECONDS = 2 * 60 * 60
WAKE_ALARM_HELPER = "/usr/local/sbin/labkiosk-wake-alarm"
WAKE_ALARM_TIMEOUT_SECONDS = 15
# The helper's exit codes (labkiosk-wake-alarm).
WAKE_ALARM_EXIT_NO_RTC = 3
# A switch-on is looked for this many days ahead: a week, and the day after.
WAKE_LOOKAHEAD_DAYS = 8
# The helper refuses a time sooner than this; a switch-on closer than that is skipped.
WAKE_MIN_LEAD_SECONDS = 120
# What POST /api/devices/power-report accepts (WAKE_ALARM_PROBLEMS in src/power.ts).
POWER_PROBLEMS = ("no-rtc", "failed")
WOL_PORT = 9
MAX_WAKE_MACS = 64
WOL_REPEATS = 3

power_lock = threading.Lock()
power_state = {
    # The week the control plane sent, normalized; None: never switched off.
    "week": None,
    # The shutdown under way: {"day", "minute", "event", "shutdownAt",
    # "postponed", "resumed"}; None when there is none.
    "pending": None,
}


def normalize_power_week(raw):
    """The control plane's `power`, validated: seven entries of None or {"off", "on"}; None for none."""
    if not isinstance(raw, dict):
        return None
    week = raw.get("week")
    if not isinstance(week, list) or len(week) != 7:
        return None

    def minute(value):
        return isinstance(value, int) and not isinstance(value, bool) and 0 <= value < 1440

    days = []
    for entry in week:
        if entry is None:
            days.append(None)
            continue
        if not isinstance(entry, dict) or not minute(entry.get("off")):
            return None
        on = entry.get("on")
        if on is not None and not minute(on):
            return None
        days.append({"off": entry["off"], "on": on})
    return days if any(days) else None


def schedule_day(moment):
    """The week's index for a local datetime: 0 Sunday to 6 Saturday, as the control plane counts."""
    return (moment.weekday() + 1) % 7


def at_minute(day_start, minute):
    return day_start + timedelta(minutes=minute)


def switch_off_due(week, last, now):
    """
    The latest switch-off time after `last` and no later than `now` (local
    datetimes), or None. A gap longer than POWER_CLOCK_JUMP_SECONDS, or the
    clock going back, is a clock change and fires nothing.
    """
    if not week or now <= last or (now - last).total_seconds() > POWER_CLOCK_JUMP_SECONDS:
        return None
    due = None
    day = datetime(last.year, last.month, last.day)
    while day <= now:
        entry = week[schedule_day(day)]
        if entry:
            event = at_minute(day, entry["off"])
            if last < event <= now:
                due = event
        day += timedelta(days=1)
    return due


def next_switch_on(week, after):
    """The first switch-on time later than `after` (local datetime) within WAKE_LOOKAHEAD_DAYS, or None."""
    if not week:
        return None
    day = datetime(after.year, after.month, after.day)
    for _ in range(WAKE_LOOKAHEAD_DAYS + 1):
        entry = week[schedule_day(day)]
        if entry and entry["on"] is not None:
            event = at_minute(day, entry["on"])
            if event > after:
                return event
        day += timedelta(days=1)
    return None


def local_epoch(moment):
    """A local datetime as seconds since the epoch, daylight saving time included."""
    return int(time.mktime(moment.timetuple()))


def apply_power_schedule(raw):
    """Keep the week the control plane sent; a shutdown it no longer asks for is called off."""
    week = normalize_power_week(raw)
    with power_lock:
        changed = week != power_state["week"]
        power_state["week"] = week
        pending = power_state["pending"]
        if pending and not pending.get("resumed"):
            entry = week[pending["day"]] if week else None
            if not entry or entry["off"] != pending["minute"]:
                power_state["pending"] = None
                log("The power schedule changed: the switch-off under way is called off.")
                forget_power_pending()
    if changed:
        log(f"Power schedule: {json.dumps(week) if week else 'none'}")


def power_off_screen():
    """What the kiosk bar shows of a switch-off under way: {"at": ms, "postponed": bool}, or None."""
    with power_lock:
        pending = power_state["pending"]
        if not pending:
            return None
        return {"at": int(pending["shutdownAt"] * 1000), "postponed": bool(pending.get("postponed"))}


def update_units_active():
    """Whether either update unit is running; True when systemd cannot say, so nothing is cut short."""
    try:
        result = subprocess.run(
            ["systemctl", "is-active", "--quiet", UPDATE_DOWNLOAD_UNIT, UPDATE_INSTALL_UNIT],
            capture_output=True,
            text=True,
            timeout=SYSTEMCTL_TIMEOUT_SECONDS,
            check=False,
        )
    except (OSError, subprocess.SubprocessError) as err:
        log(f"Could not ask systemd whether an update is running: {err}")
        return True
    # is-active exits 0 when at least one of the units is active.
    return result.returncode == 0


def update_blocks_shutdown(installing=None, report=None, units_active=None):
    """
    Whether a system update is being installed or staged right now: an
    administrator's install (the agent's own flag, or the updater's
    `installing` phase), or an update unit still running (the download unit
    stages a security release into the boot partition itself).
    """
    if is_live_session():
        return False
    if installing is None:
        with state_lock:
            installing = state["updateInstalling"]
    if installing:
        return True
    if report is None:
        report = read_update_report()
    if report.get("phase") == "installing":
        return True
    return update_units_active() if units_active is None else units_active


def run_wake_alarm_helper(args):
    """Run labkiosk-wake-alarm through its sudoers entry. Returns (exit code, message)."""
    try:
        proc = subprocess.run(
            ["sudo", "-n", WAKE_ALARM_HELPER, *args],
            capture_output=True,
            text=True,
            timeout=WAKE_ALARM_TIMEOUT_SECONDS,
            check=False,
        )
    except FileNotFoundError as err:
        return 1, f"{WAKE_ALARM_HELPER} is not installed on this image ({err})"
    except (OSError, subprocess.SubprocessError) as err:
        return 1, f"the wake alarm helper did not run: {err}"
    return proc.returncode, (proc.stderr or proc.stdout).strip()[:300]


def report_power_problem(problem, wake_at, detail):
    """Tell the console this workstation will not switch itself on. Logged either way."""
    if problem not in POWER_PROBLEMS:
        raise ValueError(f"{problem} is not a power problem")
    payload = {"problem": problem, "wakeAt": wake_at.strftime("%Y-%m-%d %H:%M"), "detail": detail[:300]}
    with state_lock:
        configured = state["isConfigured"]
    if not configured:
        return
    try:
        status = post_device_json("/api/devices/power-report", payload, timeout=10)
    except (URLError, TimeoutError, socket.timeout, OSError) as err:
        log(f"Could not tell the console the wake alarm was not set: {err}")
        return
    if status != 200:
        log(f"The console did not take the power report (HTTP {status}).")


def prepare_wake_alarm(now=None):
    """
    Before a shutdown: set the hardware clock to wake the machine at the next
    switch-on, or clear an alarm left from before when there is none. A machine
    without an RTC, or one that refuses the time, is logged and reported.
    """
    now = now or datetime.now()
    with power_lock:
        week = power_state["week"]
    wake_at = next_switch_on(week, now + timedelta(seconds=WAKE_MIN_LEAD_SECONDS))
    if wake_at is None:
        code, message = run_wake_alarm_helper(["clear"])
        if code not in (0, WAKE_ALARM_EXIT_NO_RTC):
            log(f"Could not clear the wake alarm: {message or f'exit {code}'}")
        return None
    code, message = run_wake_alarm_helper(["set", str(local_epoch(wake_at))])
    if code == 0:
        log(f"Wake alarm set for {wake_at:%Y-%m-%d %H:%M}.")
        return "armed"
    problem = "no-rtc" if code == WAKE_ALARM_EXIT_NO_RTC else "failed"
    log(f"Wake alarm NOT set for {wake_at:%Y-%m-%d %H:%M} ({problem}): {message or f'exit {code}'}")
    report_power_problem(problem, wake_at, message or f"labkiosk-wake-alarm exited with {code}")
    return problem


def remember_power_pending(event):
    try:
        fd = os.open(POWER_PENDING_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump({"event": int(event)}, handle)
    except OSError as err:
        log(f"Could not keep the postponed switch-off across a restart: {err}")


def forget_power_pending():
    try:
        os.unlink(POWER_PENDING_FILE)
    except FileNotFoundError:
        pass
    except OSError as err:
        log(f"Could not remove {POWER_PENDING_FILE}: {err}")


def take_power_pending(now_epoch, path=None):
    """
    A switch-off an update held back before this start, if it is recent enough:
    the epoch of its switch-off time, or None. The file is removed either way.
    """
    path = path or POWER_PENDING_FILE
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as err:
        log(f"Ignoring an unreadable {path}: {err}")
        data = None
    try:
        os.unlink(path)
    except OSError as err:
        log(f"Could not remove {path}: {err}")
    event = data.get("event") if isinstance(data, dict) else None
    if not isinstance(event, int) or isinstance(event, bool):
        return None
    if not 0 <= now_epoch - event <= POWER_PENDING_MAX_AGE_SECONDS:
        return None
    return event


def begin_switch_off(event, resumed=False, clock=time.time):
    """Show the warning; the machine shuts down POWER_WARNING_SECONDS from now."""
    with power_lock:
        if power_state["pending"]:
            return
        power_state["pending"] = {
            "day": schedule_day(event),
            "minute": event.hour * 60 + event.minute,
            "event": local_epoch(event),
            "shutdownAt": clock() + POWER_WARNING_SECONDS,
            "postponed": False,
            "resumed": resumed,
        }
    log(f"Switching off by the power schedule in {POWER_WARNING_SECONDS // 60} minutes"
        f"{' (held back by a system update before the last restart)' if resumed else ''}.")


def power_off_step(clock=time.time, blocked=update_blocks_shutdown, arm=prepare_wake_alarm, poweroff=None):
    """
    Shut down when the warning is over, unless an update is installing: then
    wait POWER_POSTPONE_SECONDS and look again. Returns "waiting", "postponed",
    "off" or None (nothing under way).
    """
    with power_lock:
        pending = power_state["pending"]
        if not pending:
            return None
        if clock() < pending["shutdownAt"]:
            return "waiting"
    if blocked():
        with power_lock:
            first = not pending["postponed"]
            pending["postponed"] = True
            pending["shutdownAt"] = clock() + POWER_POSTPONE_SECONDS
        if first:
            log("A system update is installing: the scheduled switch-off waits for it.")
            remember_power_pending(pending["event"])
        return "postponed"
    with power_lock:
        if power_state["pending"] is not pending:
            # Called off by a schedule change while the update was asked about.
            return None
    arm()
    forget_power_pending()
    log("Switching off by the power schedule.")
    (poweroff or (lambda: run_x11(["systemctl", "poweroff"])))()
    return "off"


def power_loop(sleep=time.sleep, now=datetime.now):
    resumed = take_power_pending(int(time.time()))
    if resumed is not None:
        begin_switch_off(datetime.fromtimestamp(resumed), resumed=True)
    last = now()
    while True:
        sleep(POWER_CHECK_SECONDS)
        # The time zone can change while the agent runs (Language & Region).
        time.tzset()
        current = now()
        with power_lock:
            week = power_state["week"]
            idle = power_state["pending"] is None
        event = switch_off_due(week, last, current) if idle else None
        last = current
        if event:
            begin_switch_off(event)
        if power_off_step() == "off":
            return


def magic_packet(mac):
    """The Wake-on-LAN magic packet for one MAC address: six 0xFF bytes, then the address sixteen times."""
    if not MAC_ADDRESS_PATTERN.match(mac):
        raise ValueError(f"{mac!r} is not a MAC address")
    return b"\xff" * 6 + bytes.fromhex(mac.replace(":", "")) * 16


def wakeable_macs(raw):
    """The `wake` command's addresses, validated: unicast, not zero, at most MAX_WAKE_MACS, each once."""
    macs = []
    for value in raw if isinstance(raw, list) else []:
        mac = value.lower() if isinstance(value, str) else ""
        if not MAC_ADDRESS_PATTERN.match(mac) or mac == "00:00:00:00:00:00" or int(mac[:2], 16) & 1:
            continue
        if mac not in macs:
            macs.append(mac)
    return macs[:MAX_WAKE_MACS]


def wired_broadcast_addresses(net_dir=NET_CLASS_DIR):
    """(local address, broadcast address) of each IPv4 network on this machine's wired adapters."""
    pairs = []
    for name, _mac in wired_adapters(net_dir):
        if not NET_DEVICE_PATTERN.match(name):
            continue
        try:
            links = _ip_json(["-4", "addr", "show", "dev", name]) or []
        except (OSError, ValueError, subprocess.SubprocessError) as err:
            log(f"Could not read the addresses of {name}: {err}")
            continue
        for link in links if isinstance(links, list) else []:
            for info in (link.get("addr_info") or []) if isinstance(link, dict) else []:
                if not isinstance(info, dict) or info.get("family") != "inet":
                    continue
                local, broadcast = info.get("local"), info.get("broadcast")
                try:
                    if ipaddress.ip_address(local).version == 4 and ipaddress.ip_address(broadcast).version == 4:
                        pairs.append((local, broadcast))
                except ValueError:
                    continue
    return pairs


def send_magic_packets(raw_macs, networks=None, open_socket=None):
    """Broadcast a magic packet to each address on every wired IPv4 network. Returns how many were sent."""
    macs = wakeable_macs(raw_macs)
    if not macs:
        log("Ignoring a wake command without a usable MAC address.")
        return 0
    networks = wired_broadcast_addresses() if networks is None else networks
    if not networks:
        log(f"Cannot wake {', '.join(macs)}: no wired network with an IPv4 address here.")
        return 0
    open_socket = open_socket or (lambda: socket.socket(socket.AF_INET, socket.SOCK_DGRAM))
    sent = 0
    for local, broadcast in networks:
        try:
            with open_socket() as sock:
                sock.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
                sock.bind((local, 0))
                for mac in macs:
                    packet = magic_packet(mac)
                    # UDP is not acknowledged; a few copies get past a dropped one.
                    for _ in range(WOL_REPEATS):
                        sock.sendto(packet, (broadcast, WOL_PORT))
                    sent += 1
        except OSError as err:
            log(f"Could not send the wake signal on {local}: {err}")
    if sent:
        log(f"Wake signal sent to {', '.join(macs)} on {len(networks)} wired network(s).")
    return sent



def boot_report_loop():
    settled = None
    restarts = {"sent": load_sent_restart_reports(), "logged": set(), "held": False}
    disks = {"checked": None, "logged": set()}
    video = {"report": None, "done": False, "logged": False}
    hardware = {"report": None, "done": False, "logged": False}
    while True:
        settled = report_boot_outcome(settled)
        report_restarts(restarts)
        report_disk_health(disks)
        report_video_decoding(video)
        report_hardware(hardware)
        time.sleep(BOOT_REPORT_INTERVAL_SECONDS)


def mark_enrolment_rejected():
    """
    React, once, to the control plane refusing this workstation's device token.

    Logging it was all this did, which left the kiosk on its old home page with
    no allowlist -- after a reboot Chromium blocks that page outright, and a
    blocked page is one the kiosk bar can never appear on. So the screen goes to
    the wizard's re-enrolment form instead, which the boot-time policy always
    allows. The enrolment on disk is kept: the token needs replacing either way,
    and a mistaken refusal on the server must not wipe a healthy workstation.
    """
    with state_lock:
        if state["enrolmentRejected"]:
            return False
        state["enrolmentRejected"] = True
        state["targetUrl"] = REENROL_URL
        state["broadcastUrl"] = ""
        state["broadcastEpoch"] = 0
        state["isLocked"] = False
        organization = state["subdomain"] or state["customDomain"]
    log(
        f"The control plane rejected this workstation's device token for {organization or 'its organization'} "
        "(the organization or this workstation may have been removed). "
        "Showing the re-enrolment form; registering again needs the administrator password."
    )
    restart_browser("to show the re-enrolment form")
    return True


def clear_enrolment_rejected():
    """A heartbeat was accepted again (typically right after re-enrolling)."""
    with state_lock:
        was = state["enrolmentRejected"]
        state["enrolmentRejected"] = False
    if was:
        log("The control plane accepts this workstation's device token again.")


def control_plane_reached():
    """The control plane answered: the workstation is online whatever the generic probes say."""
    with state_lock:
        state["lastHeartbeatOk"] = time.monotonic()


def apply_control_update(data):
    """
    Apply what the control plane says this workstation should be doing.

    One shape, whichever way it arrived: the reply to an HTTP heartbeat and the
    hub's "config" message carry the same allowlist, target and broadcast.
    """
    if not isinstance(data, dict):
        log(f"Ignoring an update from the control plane that is not an object: {type(data).__name__}")
        return

    # The target first, then the policy: the policy allows the target's host and
    # names it as the home page, so writing it before a change of target (an
    # organization's new subdomain) would block the very page the kiosk moves to.
    target_changed = False
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
                target_changed = True
                log(f"Target URL updated from {old_target} to {new_target}")

    if "whitelist" in data:
        sync_chromium_policies(data["whitelist"], force=target_changed)
    elif target_changed:
        sync_chromium_policies(list(cached_whitelist or []), force=True)

    srv_epoch = data.get("broadcastEpoch")
    if srv_epoch is not None and (isinstance(srv_epoch, bool) or not isinstance(srv_epoch, int)):
        log(f"Ignoring an unusable broadcastEpoch from the control plane: {srv_epoch!r}")
    elif srv_epoch:
        with state_lock:
            local_epoch = state["broadcastEpoch"]
            if srv_epoch > local_epoch:
                state["broadcastEpoch"] = srv_epoch
                state["broadcastUrl"] = safe_navigable_url(data.get("broadcastUrl"))
                log(f"Synced broadcast epoch {srv_epoch} from control plane")
    elif srv_epoch == 0:
        with state_lock:
            state["broadcastEpoch"] = 0
            state["broadcastUrl"] = ""

    if "lanSharing" in data:
        apply_lan_sharing(data["lanSharing"])

    if "power" in data:
        apply_power_schedule(data["power"])
    if "printing" in data:
        apply_printing(data["printing"])

    if isinstance(data.get("usageSites"), bool) and data["usageSites"] != usage_counter.record_sites:
        usage_counter.set_record_sites(data["usageSites"])
        log(f"Usage reports {'now record' if data['usageSites'] else 'no longer record'} the sites visited.")

    if isinstance(data.get("homeReset"), bool):
        with state_lock:
            changed = state["homeReset"] != data["homeReset"]
            state["homeReset"] = data["homeReset"]
        if changed:
            log(f"Home in the kiosk bar {'now starts a new session' if data['homeReset'] else 'now only goes back to the start page'}.")

    # Apply a just-completed enrolment to the running browser.
    with state_lock:
        needs_restart = state["pendingBrowserRestart"]
        state["pendingBrowserRestart"] = False
    if needs_restart:
        restart_browser()

    commands = data.get("commands", [])
    if isinstance(commands, list):
        for command in commands:
            if isinstance(command, dict):
                execute_command(command)


def http_heartbeat():
    """One HTTP heartbeat. Returns "ok", "rejected" or "error"."""
    try:
        data = post_telemetry()
    except HTTPError as err:
        if err.code in (401, 403):
            mark_enrolment_rejected()
            return "rejected"
        log(f"Telemetry rejected with HTTP {err.code}")
        return "error"
    except (URLError, TimeoutError, socket.timeout, ValueError, OSError) as err:
        log(f"Telemetry error: {err}")
        return "error"
    clear_enrolment_rejected()
    control_plane_reached()
    apply_control_update(data)
    if isinstance(data, dict):
        http_pace["seconds"], http_pace["frames"] = http_pace_from(data)
    return "ok"


def http_pace_from(data):
    """The interval (seconds) and frame request an HTTP heartbeat reply asks for."""
    seconds = data.get("heartbeatSeconds")
    if isinstance(seconds, bool) or not isinstance(seconds, int):
        seconds = HEARTBEAT_SECONDS
    low, high = HTTP_HEARTBEAT_BOUNDS
    frames = data.get("frames")
    return min(max(seconds, low), high), frames if isinstance(frames, bool) else True


# How one WebSocket session ended, which decides what the loop does next.
SESSION_ENDED = "ended"              # it worked, then closed: reconnect soon
SESSION_FAILED = "failed"            # could not connect, or was replaced: back off
SESSION_REJECTED = "rejected"        # the token was refused: re-enrolment form, back off
SESSION_UNSUPPORTED = "unsupported"  # no WebSocket route: use HTTP for a while


def websocket_url(worker_url):
    """The hub's address for this worker: ws:// beside http://, wss:// beside https://."""
    parsed = urlparse(worker_url)
    scheme = "wss" if parsed.scheme == "https" else "ws"
    return f"{scheme}://{parsed.netloc}/api/devices/ws"


def websocket_proxy_options(cfg):
    """The saved proxy in websocket-client's terms, or nothing when there is none."""
    if not cfg.get("enabled"):
        return {}
    bypass = [item for item in cfg.get("bypass", "").split(",") if item]
    return {
        "http_proxy_host": cfg["host"],
        "http_proxy_port": int(cfg["port"]),
        "http_no_proxy": list(LOOPBACK_NO_PROXY) + bypass,
        "proxy_type": "http",
    }


def open_control_channel():
    """Connect to the hub. Returns (socket, None), or (None, how the attempt ended)."""
    # This connection uses the enrolment as it is now; only a later one should
    # make ControlChannel.run() reconnect.
    heartbeat_wakeup.clear()
    with state_lock:
        worker_url = state["workerUrl"]
        token = state["deviceToken"]
    try:
        ws = websocket.create_connection(
            websocket_url(worker_url),
            timeout=WEBSOCKET_CONNECT_TIMEOUT_SECONDS,
            header=[f"Authorization: Bearer {token}", f"User-Agent: LabKioskAgent/{AGENT_VERSION}"],
            suppress_origin=True,
            **websocket_proxy_options(load_proxy_config()),
        )
    except websocket.WebSocketBadStatusException as err:
        status = getattr(err, "status_code", 0)
        if status in (401, 403):
            mark_enrolment_rejected()
            return None, SESSION_REJECTED
        if status in WEBSOCKET_UNSUPPORTED_STATUSES:
            log(f"The control plane has no WebSocket route (HTTP {status}); using the HTTP heartbeat.")
            return None, SESSION_UNSUPPORTED
        log(f"The control plane refused the WebSocket with HTTP {status}")
        return None, SESSION_FAILED
    except (websocket.WebSocketException, OSError, ValueError) as err:
        log(f"Could not open the control channel: {err}")
        return None, SESSION_FAILED
    return ws, None


class ControlChannel:
    """
    One open WebSocket to the organization's hub.

    Single-threaded on purpose: every receive waits at most
    WEBSOCKET_POLL_SECONDS, and between receives the loop sends whatever is
    due -- the ping, a changed status, a frame an operator is watching.
    """

    def __init__(self, ws, clock=time.monotonic):
        self.ws = ws
        self.clock = clock
        now = clock()
        self.last_heard = now
        self.next_ping = now + WEBSOCKET_PING_SECONDS
        self.next_status_check = now
        self.last_status = None
        # Seconds between frames while a console is watching; 0 when nobody is.
        self.frame_interval = 0
        self.next_frame = now

    def run(self):
        """Serve the connection until it ends; returns a SESSION_* outcome."""
        clear_enrolment_rejected()
        control_plane_reached()
        self.ws.settimeout(WEBSOCKET_POLL_SECONDS)
        while True:
            if heartbeat_wakeup.is_set():
                # A new enrolment: its token and organization need a new connection.
                heartbeat_wakeup.clear()
                log("Reconnecting the control channel for the new enrolment.")
                return SESSION_ENDED
            outcome = self.receive() or self.tick()
            if outcome:
                return outcome

    def receive(self):
        try:
            opcode, data = self.ws.recv_data()
        except (websocket.WebSocketTimeoutException, socket.timeout):
            return None
        except websocket.WebSocketConnectionClosedException:
            log("The control channel was closed.")
            return SESSION_ENDED
        except (websocket.WebSocketException, OSError, ValueError) as err:
            log(f"The control channel failed: {err}")
            return SESSION_ENDED
        self.last_heard = self.clock()
        control_plane_reached()
        if opcode == websocket.ABNF.OPCODE_CLOSE:
            return self.closed(data)
        if opcode == websocket.ABNF.OPCODE_TEXT:
            self.handle(data.decode("utf-8", "replace") if isinstance(data, bytes) else data)
        return None

    def closed(self, data):
        code = int.from_bytes(data[:2], "big") if len(data) >= 2 else 1005
        reason = data[2:].decode("utf-8", "replace")
        if code in (WS_CLOSE_REMOVED, WS_CLOSE_INACTIVE):
            log(f"The control plane closed the channel: {reason or code}")
            mark_enrolment_rejected()
            return SESSION_REJECTED
        log(f"The control plane closed the channel ({code}{': ' + reason if reason else ''}).")
        # Another connection for this workstation took over: do not fight it.
        return SESSION_FAILED if code == WS_CLOSE_REPLACED else SESSION_ENDED

    def handle(self, text):
        try:
            message = json.loads(text)
        except ValueError as err:
            log(f"Ignoring a control message that is not JSON: {err}")
            return
        if not isinstance(message, dict):
            log("Ignoring a control message that is not an object.")
            return
        kind = message.get("type")
        if kind == "pong":
            return
        if kind == "config":
            apply_control_update(message)
        elif kind == "commands":
            apply_control_update({"commands": message.get("commands", [])})
        elif kind == "frames":
            self.set_frames(message)
        elif kind == "remote":
            start_remote_session(message.get("session"))
        else:
            log(f"Ignoring an unknown control message: {str(kind)[:40]!r}")

    def set_frames(self, message):
        low, high = FRAME_INTERVAL_BOUNDS
        try:
            interval = int(message.get("intervalSeconds", HEARTBEAT_SECONDS))
        except (TypeError, ValueError):
            interval = HEARTBEAT_SECONDS
        interval = min(max(interval, low), high)
        if message.get("on") is True:
            if not self.frame_interval:
                self.next_frame = self.clock()
                log("An operator is watching this screen; sending frames.")
            self.frame_interval = interval
        elif self.frame_interval:
            self.frame_interval = 0
            log("Nobody is watching this screen; frames stopped.")

    def send(self, text):
        try:
            self.ws.send(text)
            return True
        except (websocket.WebSocketException, OSError) as err:
            log(f"The control channel failed while sending: {err}")
            return False

    def tick(self):
        """Send what is due. Returns a SESSION_* outcome when the connection is over."""
        now = self.clock()
        if now - self.last_heard > WEBSOCKET_SILENCE_SECONDS:
            log(f"Nothing heard from the control plane for {WEBSOCKET_SILENCE_SECONDS} s; reconnecting.")
            return SESSION_ENDED
        if now >= self.next_ping:
            self.next_ping = now + WEBSOCKET_PING_SECONDS
            if not self.send(WEBSOCKET_PING):
                return SESSION_ENDED
        if now >= self.next_status_check:
            self.next_status_check = now + 1
            status = current_status()
            if status != self.last_status:
                if not self.send(json.dumps({"type": "status", **status})):
                    return SESSION_ENDED
                self.last_status = status
        if self.frame_interval and now >= self.next_frame:
            self.next_frame = now + self.frame_interval
            frame = capture_thumbnail_base64()
            if frame and not self.send(json.dumps({"type": "frame", "thumbnail": frame})):
                return SESSION_ENDED
        return None


def websocket_session():
    """Open the control channel and serve it until it ends."""
    ws, outcome = open_control_channel()
    if ws is None:
        return outcome
    log("Control channel open.")
    try:
        return ControlChannel(ws).run()
    finally:
        try:
            ws.close()
        except (websocket.WebSocketException, OSError) as err:
            log(f"Closing the control channel: {err}")


def remote_relay_url(worker_url):
    """The relay's address for this worker, beside the control channel's."""
    parsed = urlparse(worker_url)
    scheme = "wss" if parsed.scheme == "https" else "ws"
    return f"{scheme}://{parsed.netloc}/api/devices/remote"


# The one Remote Control session this workstation serves; a new one replaces it.
_remote_lock = threading.Lock()
_remote_stop = None


def start_remote_session(session):
    """Join the session the hub named, in the background, ending any earlier one."""
    global _remote_stop
    if websocket is None:
        log("Remote Control needs python3-websocket, which this image lacks.")
        return
    if not isinstance(session, str) or not REMOTE_SESSION_PATTERN.match(session):
        log("Ignoring a Remote Control request without a valid session.")
        return
    stop = threading.Event()
    with _remote_lock:
        previous, _remote_stop = _remote_stop, stop
    if previous is not None:
        previous.set()
    threading.Thread(target=run_remote_session, args=(session, stop), name="remote-control", daemon=True).start()


def open_remote_channel(session):
    """The workstation's end of the session, or None when the relay refused it."""
    with state_lock:
        worker_url = state["workerUrl"]
        token = state["deviceToken"]
    try:
        return websocket.create_connection(
            remote_relay_url(worker_url),
            timeout=WEBSOCKET_CONNECT_TIMEOUT_SECONDS,
            header=[
                f"Authorization: Bearer {token}",
                f"User-Agent: LabKioskAgent/{AGENT_VERSION}",
                f"X-Labkiosk-Session: {session}",
            ],
            suppress_origin=True,
            enable_multithread=True,
            **websocket_proxy_options(load_proxy_config()),
        )
    except websocket.WebSocketBadStatusException as err:
        log(f"The Remote Control relay refused this workstation (HTTP {getattr(err, 'status_code', 0)}).")
    except (websocket.WebSocketException, OSError, ValueError) as err:
        log(f"Could not reach the Remote Control relay: {err}")
    return None


def wait_for_remote_ready(ws, stop, clock=time.monotonic):
    """Wait until noVNC has joined. False when the session ended first."""
    deadline = clock() + REMOTE_READY_TIMEOUT_SECONDS
    ws.settimeout(REMOTE_POLL_SECONDS)
    while not stop.is_set() and clock() < deadline:
        try:
            opcode, data = ws.recv_data()
        except (websocket.WebSocketTimeoutException, socket.timeout):
            continue
        except (websocket.WebSocketException, OSError, ValueError) as err:
            log(f"The Remote Control session ended before it started: {err}")
            return False
        if opcode == websocket.ABNF.OPCODE_CLOSE:
            return False
        if opcode == websocket.ABNF.OPCODE_TEXT:
            text = data.decode("utf-8", "replace") if isinstance(data, bytes) else data
            if text == REMOTE_READY:
                return True
    return False


def pipe_vnc_to_relay(vnc, ws, stop):
    """x11vnc's bytes to noVNC, until either end closes."""
    try:
        while not stop.is_set():
            data = vnc.recv(REMOTE_CHUNK_BYTES)
            if not data:
                break
            ws.send_binary(data)
    except (websocket.WebSocketException, OSError) as err:
        if not stop.is_set():
            log(f"Remote Control: the screen stream stopped: {err}")
    finally:
        stop.set()


def pipe_relay_to_vnc(ws, vnc, stop, clock=time.monotonic):
    """noVNC's input to x11vnc, with the keepalive, until either end closes."""
    next_ping = clock() + REMOTE_PING_SECONDS
    ws.settimeout(REMOTE_POLL_SECONDS)
    try:
        while not stop.is_set():
            if clock() >= next_ping:
                next_ping = clock() + REMOTE_PING_SECONDS
                ws.send(REMOTE_PING)
            try:
                opcode, data = ws.recv_data()
            except (websocket.WebSocketTimeoutException, socket.timeout):
                continue
            if opcode == websocket.ABNF.OPCODE_CLOSE:
                break
            if opcode == websocket.ABNF.OPCODE_BINARY:
                vnc.sendall(data)
    except (websocket.WebSocketException, OSError, ValueError) as err:
        if not stop.is_set():
            log(f"Remote Control: the operator's input stopped: {err}")
    finally:
        stop.set()


def run_remote_session(session, stop):
    """Serve one Remote Control session from start to end."""
    ws = open_remote_channel(session)
    if ws is None:
        return
    vnc = None
    try:
        if not wait_for_remote_ready(ws, stop):
            log("Remote Control: nobody joined the session.")
            return
        try:
            vnc = socket.create_connection(REMOTE_VNC_ADDRESS, timeout=WEBSOCKET_CONNECT_TIMEOUT_SECONDS)
        except OSError as err:
            log(f"Remote Control: x11vnc is not answering on 127.0.0.1:5900: {err}")
            return
        vnc.settimeout(None)
        log("Remote Control session started.")
        reader = threading.Thread(target=pipe_vnc_to_relay, args=(vnc, ws, stop), name="remote-control-screen", daemon=True)
        reader.start()
        pipe_relay_to_vnc(ws, vnc, stop)
        # Closing the VNC socket wakes the reader from recv().
        try:
            vnc.shutdown(socket.SHUT_RDWR)
        except OSError as err:
            log(f"Remote Control: closing the VNC connection: {err}")
        reader.join(timeout=5)
        log("Remote Control session ended.")
    finally:
        stop.set()
        if vnc is not None:
            vnc.close()
        try:
            ws.close()
        except (websocket.WebSocketException, OSError) as err:
            log(f"Remote Control: closing the relay connection: {err}")


def telemetry_loop():
    """
    Keep this workstation in touch with its control plane.

    A WebSocket when the image has websocket-client and the server has the
    route; the HTTP heartbeat otherwise (every 3 seconds while a console is
    open, slower when the hub says nobody is), and for a while after the
    WebSocket keeps failing. Both apply the same updates, and both send a
    refused workstation to the re-enrolment form.
    """
    backoff = HEARTBEAT_SECONDS
    failures = 0
    websocket_after = 0.0

    while True:
        with state_lock:
            configured = state["isConfigured"]

        if not configured:
            # Nothing to report until an operator completes the wizard.
            time.sleep(HEARTBEAT_SECONDS)
            continue

        if websocket is not None and time.monotonic() >= websocket_after:
            outcome = websocket_session()
            failures = failures + 1 if outcome == SESSION_FAILED else 0
            if outcome == SESSION_UNSUPPORTED or failures >= WEBSOCKET_FAILURES_BEFORE_HTTP:
                if outcome == SESSION_FAILED:
                    log("The control channel keeps failing; using the HTTP heartbeat for now.")
                failures = 0
                websocket_after = time.monotonic() + WEBSOCKET_RETRY_SECONDS
                backoff = HEARTBEAT_SECONDS
                continue
            if outcome == SESSION_ENDED:
                wait = random.uniform(1, WEBSOCKET_RECONNECT_SECONDS)
                backoff = HEARTBEAT_SECONDS
            else:
                backoff = min(backoff * 2, MAX_BACKOFF_SECONDS)
                wait = backoff * random.uniform(0.5, 1)
        else:
            result = http_heartbeat()
            backoff = HEARTBEAT_SECONDS if result == "ok" else min(backoff * 2, MAX_BACKOFF_SECONDS)
            wait = http_pace["seconds"] if result == "ok" else backoff

        if heartbeat_wakeup.wait(wait):
            heartbeat_wakeup.clear()
            backoff = HEARTBEAT_SECONDS
            websocket_after = 0.0


def main():
    apply_proxy_to_environment(load_proxy_config())
    apply_saved_localization()
    load_config()
    with state_lock:
        client_id = state["clientId"]
        configured = state["isConfigured"]

    log(f"Starting Lab Kiosk Agent for {client_id} ({'enrolled' if configured else 'awaiting setup'})")
    log(f"Hostname {socket.gethostname()}; Secure Boot {secure_boot_state()}.")

    if configured:
        # A reboot brings back the boot-time policy, which allows only loopback,
        # and the launcher opens the home page as soon as the local API below
        # answers -- usually before the network is up. Allow this workstation's
        # own server and home page first, from the saved enrolment, or that page
        # is blocked before the control channel can deliver the allowlist.
        sync_chromium_policies([], force=True)

    threading.Thread(target=start_local_server, daemon=True).start()
    threading.Thread(target=boot_report_loop, daemon=True).start()
    threading.Thread(target=usage_loop, daemon=True).start()
    threading.Thread(target=power_loop, daemon=True).start()
    threading.Thread(target=printing_loop, daemon=True).start()
    if is_network_boot():
        threading.Thread(target=network_boot_enrol_loop, name="network-boot-enrol", daemon=True).start()

    try:
        telemetry_loop()
    except KeyboardInterrupt:
        log("Shutting down.")
        sys.exit(0)


if __name__ == "__main__":
    main()
