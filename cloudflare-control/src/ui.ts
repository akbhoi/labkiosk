/**
 * Modern High-Performance Teacher Lab Dashboard
 * Self-contained HTML/CSS/JS frontend rendered by the Cloudflare Worker.
 */

import { LabConfig, Tenant, PortalSite } from "./types";

export function renderDashboardHtml(config: LabConfig, tenant?: Tenant, sites: PortalSite[] = []): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>School Lab Control Console</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-base: #090d16;
      --bg-surface: #111827;
      --bg-card: #1f2937;
      --bg-card-hover: #283548;
      --border: #374151;
      --border-subtle: #2d3748;
      --text-main: #f9fafb;
      --text-muted: #9ca3af;
      --accent: #3b82f6;
      --accent-hover: #2563eb;
      --success: #10b981;
      --danger: #ef4444;
      --warning: #f59e0b;
      --radius: 10px;
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif;
      background-color: var(--bg-base);
      color: var(--text-main);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }

    /* Header & Action Toolbar */
    header {
      background-color: var(--bg-surface);
      border-bottom: 1px solid var(--border);
      position: sticky;
      top: 0;
      z-index: 1000;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
    }

    .nav-container {
      max-width: 1720px;
      margin: 0 auto;
      padding: 12px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
    }

    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .brand-icon {
      width: 38px;
      height: 38px;
      background: linear-gradient(135deg, #3b82f6, #6366f1);
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 0 15px rgba(59, 130, 246, 0.4);
    }

    .brand-title {
      font-size: 18px;
      font-weight: 700;
      letter-spacing: -0.3px;
    }

    .brand-subtitle {
      font-size: 12px;
      color: var(--text-muted);
    }

    .stats-bar {
      display: flex;
      align-items: center;
      gap: 16px;
      background: var(--bg-base);
      padding: 6px 16px;
      border-radius: 30px;
      border: 1px solid var(--border);
      font-size: 13px;
    }

    .stat-pill {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .stat-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
    }
    .stat-dot.green { background: var(--success); box-shadow: 0 0 6px var(--success); }
    .stat-dot.red { background: var(--danger); }
    .stat-dot.yellow { background: var(--warning); }

    .action-toolbar {
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .btn {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 8px 16px;
      border-radius: 8px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      border: 1px solid transparent;
      transition: all 0.2s;
    }

    .btn-primary { background: var(--accent); color: #fff; }
    .btn-primary:hover { background: var(--accent-hover); transform: translateY(-1px); }

    .btn-danger { background: rgba(239, 68, 68, 0.15); color: #fca5a5; border-color: rgba(239, 68, 68, 0.3); }
    .btn-danger:hover { background: var(--danger); color: #fff; }

    .btn-warning { background: rgba(245, 158, 11, 0.15); color: #fde68a; border-color: rgba(245, 158, 11, 0.3); }
    .btn-warning:hover { background: var(--warning); color: #000; }

    .btn-secondary { background: var(--bg-card); color: var(--text-main); border-color: var(--border); }
    .btn-secondary:hover { background: var(--bg-card-hover); }

    /* Grid Layout for 40 Clients */
    main {
      flex: 1;
      max-width: 1720px;
      width: 100%;
      margin: 0 auto;
      padding: 24px;
    }

    .grid-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 18px;
    }

    .grid-title {
      font-size: 16px;
      font-weight: 600;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .kiosk-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
      gap: 18px;
    }

    .empty-lab-state {
      grid-column: 1 / -1;
      background: var(--bg-card);
      border: 1px dashed var(--border);
      border-radius: var(--radius);
      padding: 60px 24px;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 12px;
      color: var(--text-muted);
      text-align: center;
    }

    .card-remove-btn {
      color: var(--text-muted);
      background: transparent;
      border: none;
      cursor: pointer;
      font-size: 13px;
      padding: 2px 6px;
      border-radius: 4px;
      transition: all 0.15s;
      opacity: 0.5;
    }
    .kiosk-card:hover .card-remove-btn {
      opacity: 0.9;
    }
    .card-remove-btn:hover {
      opacity: 1 !important;
      color: var(--danger);
      background: rgba(239, 68, 68, 0.15);
    }

    /* Client Card */
    .kiosk-card {
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      overflow: hidden;
      display: flex;
      flex-direction: column;
      transition: transform 0.2s, border-color 0.2s, box-shadow 0.2s;
      position: relative;
    }

    .kiosk-card:hover {
      border-color: var(--accent);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
      transform: translateY(-2px);
    }

    .kiosk-card.locked {
      border-color: var(--danger);
    }

    .card-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 10px 14px;
      background: rgba(17, 24, 39, 0.6);
      border-bottom: 1px solid var(--border-subtle);
    }

    .card-id-wrapper {
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 700;
      font-size: 14px;
      letter-spacing: 0.5px;
    }

    .card-badges {
      display: flex;
      align-items: center;
      gap: 6px;
    }

    .badge {
      font-size: 11px;
      padding: 2px 6px;
      border-radius: 4px;
      font-weight: 600;
      text-transform: uppercase;
    }
    .badge-locked { background: rgba(239, 68, 68, 0.2); color: #f87171; border: 1px solid rgba(239, 68, 68, 0.4); }

    /* Screen Thumbnail Viewport */
    .card-thumbnail-box {
      width: 100%;
      height: 160px;
      background: #000;
      position: relative;
      overflow: hidden;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .card-thumbnail {
      width: 100%;
      height: 100%;
      object-fit: cover;
      transition: opacity 0.3s;
    }

    .offline-placeholder {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
      color: var(--text-muted);
      font-size: 12px;
    }

    /* Card Hover Action Buttons */
    .card-hover-actions {
      position: absolute;
      top: 0;
      left: 0;
      width: 100%;
      height: 100%;
      background: rgba(15, 23, 42, 0.88);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 8px;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.2s;
    }

    .card-thumbnail-box:hover .card-hover-actions {
      opacity: 1;
      pointer-events: auto;
    }

    .action-mini-btn {
      display: flex;
      align-items: center;
      gap: 6px;
      width: 80%;
      padding: 7px 12px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      border: 1px solid rgba(255, 255, 255, 0.1);
      background: #1e293b;
      color: #fff;
      transition: background 0.15s;
    }
    .action-mini-btn:hover { background: var(--accent); }
    .action-mini-btn.danger:hover { background: var(--danger); }

    .card-footer {
      padding: 10px 14px;
      background: var(--bg-surface);
      font-size: 12px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      color: var(--text-muted);
      border-top: 1px solid var(--border-subtle);
    }

    .active-domain {
      font-family: 'JetBrains Mono', monospace;
      color: #93c5fd;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      max-width: 180px;
    }

    /* Remote Control Modal (noVNC) */
    .modal-overlay {
      position: fixed;
      top: 0;
      left: 0;
      width: 100vw;
      height: 100vh;
      background: rgba(0, 0, 0, 0.85);
      backdrop-filter: blur(4px);
      z-index: 2000;
      display: flex;
      align-items: center;
      justify-content: center;
      opacity: 0;
      visibility: hidden;
      transition: all 0.25s;
    }

    .modal-overlay.active {
      opacity: 1;
      visibility: visible;
    }

    .vnc-modal-container {
      width: 92vw;
      height: 90vh;
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.9);
    }

    .modal-header {
      padding: 12px 20px;
      background: var(--bg-card);
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .modal-title {
      font-size: 16px;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .vnc-iframe-wrapper {
      flex: 1;
      background: #000;
      position: relative;
    }

    .vnc-iframe {
      width: 100%;
      height: 100%;
      border: none;
    }

    /* Prompt Modal for Broadcast URL */
    .prompt-box {
      width: 520px;
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 24px;
      display: flex;
      flex-direction: column;
      gap: 18px;
    }

    .prompt-input {
      width: 100%;
      background: var(--bg-base);
      border: 1px solid var(--border);
      color: #fff;
      padding: 10px 14px;
      border-radius: 8px;
      font-size: 14px;
      font-family: 'JetBrains Mono', monospace;
      outline: none;
    }
    .prompt-input:focus { border-color: var(--accent); }

    .quick-links {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
    }

    .quick-chip {
      background: var(--bg-card);
      border: 1px solid var(--border);
      padding: 5px 10px;
      border-radius: 20px;
      font-size: 12px;
      cursor: pointer;
      transition: background 0.15s;
    }
    .quick-chip:hover { background: var(--accent); color: #fff; }

    .domain-tag {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      color: #93c5fd;
      font-family: 'JetBrains Mono', monospace;
      font-size: 12px;
      padding: 5px 10px;
      border-radius: 6px;
      transition: all 0.15s;
    }
    .domain-tag:hover {
      border-color: var(--accent);
    }
    .domain-remove-btn {
      color: var(--text-muted);
      cursor: pointer;
      font-size: 14px;
      font-weight: 700;
      border: none;
      background: transparent;
      line-height: 1;
      padding: 0 2px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .domain-remove-btn:hover {
      color: var(--danger);
    }
  </style>
</head>
<body>
  <!-- Header Bar -->
  <header>
    <div class="nav-container">
      <div class="brand">
        <div class="brand-icon">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2.2">
            <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
            <line x1="8" y1="21" x2="16" y2="21"></line>
            <line x1="12" y1="17" x2="12" y2="21"></line>
          </svg>
        </div>
        <div>
          <div class="brand-title">${tenant?.name || "School Computer Lab Control"}</div>
          <div class="brand-subtitle">${tenant ? tenant.subdomain + ".labkiosk.io • Lab Console" : "Centralized Kiosk Monitoring & Cloudflare Management"}</div>
        </div>
      </div>

      <!-- Live Telemetry Status -->
      <div class="stats-bar">
        <div class="stat-pill">
          <div class="stat-dot green" id="stat-online-dot"></div>
          <span>Online: <strong id="stat-online-count">0</strong>/<span id="stat-total-count">0</span></span>
        </div>
        <div class="stat-pill">
          <div class="stat-dot red"></div>
          <span>Locked: <strong id="stat-locked-count">0</strong></span>
        </div>
      </div>

      <!-- Global Actions -->
      <div class="action-toolbar">
        <button class="btn btn-warning" id="btn-lock-all" onclick="broadcastAction('lock')">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
            <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
          </svg>
          Lock All
        </button>

        <button class="btn btn-secondary" id="btn-unlock-all" onclick="broadcastAction('unlock')">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
            <path d="M7 11V7a5 5 0 0 1 9.9-1"></path>
          </svg>
          Unlock All
        </button>

        <button class="btn btn-secondary" onclick="openPortalModal()" title="Configure Student Portal Cards & Homepage">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="3" width="7" height="7"></rect>
            <rect x="14" y="3" width="7" height="7"></rect>
            <rect x="14" y="14" width="7" height="7"></rect>
            <rect x="3" y="14" width="7" height="7"></rect>
          </svg>
          Portal Apps
        </button>

        <button class="btn btn-secondary" onclick="openWhitelistModal()" title="Manage allowed educational domains">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
            <polyline points="9 12 11 14 15 10"></polyline>
          </svg>
          Allowed Sites (<span id="stat-whitelist-count">${config.whitelist.length}</span>)
        </button>

        <button class="btn btn-primary" onclick="openBroadcastUrlModal()">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="2" y1="12" x2="22" y2="12"></line>
            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>
          </svg>
          Broadcast URL
        </button>

        <button class="btn btn-secondary" onclick="openSettingsModal()" title="Lab Settings & Subdomain Management">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="3"></circle>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
          </svg>
          Settings
        </button>

        <a href="/api/auth/logout" class="btn btn-secondary" style="color: #ef4444;" title="Sign out of console">
          Sign Out
        </a>
      </div>
    </div>
  </header>

  <!-- Main Kiosk Screen Grid -->
  <main>
    <div class="grid-header">
      <div class="grid-title">Thin Client Workstations (<span id="stat-active-title">0 Connected</span>)</div>
      <div style="font-size: 12px; color: var(--text-muted);">Click any screen for interactive remote control</div>
    </div>

    <div class="kiosk-grid" id="kiosk-grid">
      <!-- Dynamically populated only with active/registered PCs -->
    </div>
  </main>

  <!-- Interactive noVNC Remote Control Modal -->
  <div class="modal-overlay" id="vnc-modal">
    <div class="vnc-modal-container">
      <div class="modal-header">
        <div class="modal-title">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2">
            <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
            <line x1="8" y1="21" x2="16" y2="21"></line>
            <line x1="12" y1="17" x2="12" y2="21"></line>
          </svg>
          <span id="vnc-modal-title">Live Remote Control: PC-01</span>
        </div>
        <div style="display: flex; gap: 10px;">
          <button class="btn btn-secondary" onclick="closeVncModal()">Close Session</button>
        </div>
      </div>
      <div class="vnc-iframe-wrapper">
        <iframe id="vnc-frame" class="vnc-iframe" src="about:blank"></iframe>
      </div>
    </div>
  </div>

  <!-- Broadcast URL Modal -->
  <div class="modal-overlay" id="url-modal">
    <div class="prompt-box">
      <h3 style="font-size: 18px; font-weight: 700;">Broadcast Lesson URL to All Clients</h3>
      <p style="font-size: 13px; color: var(--text-muted);">
        Enter a whitelisted URL to immediately navigate all connected thin clients.
      </p>

      <input type="text" id="target-url-input" class="prompt-input" value="https://www.khanacademy.org" placeholder="https://...">

      <div class="quick-links">
        <span class="quick-chip" onclick="setQuickUrl('https://www.khanacademy.org')">Khan Academy</span>
        <span class="quick-chip" onclick="setQuickUrl('https://www.khanacademy.org/math')">Khan Math</span>
        <span class="quick-chip" onclick="setQuickUrl('https://www.khanacademy.org/science')">Khan Science</span>
        <span class="quick-chip" onclick="setQuickUrl('https://scratch.mit.edu')">Scratch Coding</span>
        <span class="quick-chip" onclick="setQuickUrl('https://cbse.gov.in')">CBSE Portal</span>
      </div>

      <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 10px;">
        <button class="btn btn-secondary" onclick="closeUrlModal()">Cancel</button>
        <button class="btn btn-primary" onclick="submitBroadcastUrl()">Send to All PCs</button>
      </div>
    </div>
  </div>

  <!-- Manage Allowed Sites Modal -->
  <div class="modal-overlay" id="whitelist-modal">
    <div class="prompt-box" style="width: 680px; max-height: 85vh; display: flex; flex-direction: column;">
      <div style="display: flex; align-items: center; justify-content: space-between;">
        <h3 style="font-size: 18px; font-weight: 700; display: flex; align-items: center; gap: 8px;">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
            <polyline points="9 12 11 14 15 10"></polyline>
          </svg>
          Manage Allowed Websites
        </h3>
        <span style="font-size: 12px; color: var(--text-muted); background: var(--bg-card); padding: 3px 10px; border-radius: 12px; border: 1px solid var(--border);" id="modal-whitelist-total">
          ${config.whitelist.length} Allowed
        </span>
      </div>
      <p style="font-size: 13px; color: var(--text-muted); line-height: 1.4; margin-top: 4px;">
        Student kiosks are locked to this whitelist. Subdomains and paths are automatically permitted.
      </p>

      <!-- Input to add domain -->
      <div style="display: flex; gap: 10px; margin-top: 8px;">
        <input type="text" id="new-domain-input" class="prompt-input" placeholder="e.g. scratch.mit.edu, geogebra.org, phet.colorado.edu" style="flex: 1;" onkeydown="if(event.key==='Enter') addWhitelistDomain()">
        <button class="btn btn-primary" onclick="addWhitelistDomain()">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <line x1="12" y1="5" x2="12" y2="19"></line>
            <line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
          Add Site
        </button>
      </div>

      <!-- Quick presets -->
      <div style="margin-top: 8px;">
        <div style="font-size: 11px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; margin-bottom: 6px;">Quick Presets:</div>
        <div class="quick-links">
          <span class="quick-chip" onclick="quickAddDomain('khanacademy.org')">+ Khan Academy</span>
          <span class="quick-chip" onclick="quickAddDomain('scratch.mit.edu')">+ Scratch Coding</span>
          <span class="quick-chip" onclick="quickAddDomain('cbse.gov.in')">+ CBSE Official</span>
          <span class="quick-chip" onclick="quickAddDomain('ncert.nic.in')">+ NCERT Textbooks</span>
          <span class="quick-chip" onclick="quickAddDomain('wikipedia.org')">+ Wikipedia</span>
          <span class="quick-chip" onclick="quickAddDomain('geogebra.org')">+ GeoGebra</span>
          <span class="quick-chip" onclick="quickAddDomain('phet.colorado.edu')">+ PhET Sims</span>
        </div>
      </div>

      <!-- Whitelist Scrollable Tag Container -->
      <div style="flex: 1; overflow-y: auto; max-height: 260px; min-height: 120px; margin-top: 10px; background: var(--bg-base); border: 1px solid var(--border); border-radius: 8px; padding: 12px; display: flex; flex-wrap: wrap; gap: 8px; align-content: flex-start;" id="whitelist-tag-container">
        <!-- Rendered dynamically -->
      </div>

      <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 12px; border-top: 1px solid var(--border-subtle); padding-top: 12px;">
        <button class="btn btn-secondary" onclick="closeWhitelistModal()">Done</button>
  <!-- Student Portal Apps Modal -->
  <div class="modal-overlay" id="portal-modal">
    <div class="modal-container" style="max-width: 680px;">
      <div class="modal-header">
        <div class="modal-title">Student Learning Portal Applications</div>
        <button class="modal-close" onclick="closePortalModal()">✕</button>
      </div>
      <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 16px;">
        Configure the educational cards displayed on student thin clients when they open their web browser.
      </p>
      
      <!-- App Launcher Mode Toggle -->
      <div style="background: var(--bg-base); border: 1px solid var(--border); border-radius: 8px; padding: 14px; margin-bottom: 20px; display: flex; align-items: center; justify-content: space-between;">
        <div>
          <div style="font-size: 14px; font-weight: 700;">Homepage Experience</div>
          <div style="font-size: 12px; color: var(--text-muted);">Choose whether students see the App Launcher Grid or land directly on a single site.</div>
        </div>
        <select id="kiosk-mode-select" class="input-field" style="width: auto; padding: 6px 12px;" onchange="updateKioskMode(this.value)">
          <option value="portal" ${tenant?.mode === 'portal' ? 'selected' : ''}>Visual App Launcher Grid</option>
          <option value="single_url" ${tenant?.mode === 'single_url' ? 'selected' : ''}>Direct Single-Site Lockdown</option>
        </select>
      </div>

      <!-- Current Apps List -->
      <div id="portal-apps-list" style="display: flex; flex-direction: column; gap: 10px; max-height: 220px; overflow-y: auto; margin-bottom: 20px; background: var(--bg-base); border: 1px solid var(--border); border-radius: 8px; padding: 12px;">
        <!-- Populated dynamically -->
      </div>

      <!-- Add New App Form -->
      <div style="border-top: 1px solid var(--border); padding-top: 16px;">
        <h4 style="font-size: 14px; font-weight: 700; margin-bottom: 12px;">Add Approved Educational Website</h4>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 10px;">
          <input type="text" id="new-app-title" class="input-field" placeholder="App Title (e.g. PhET Simulations)">
          <input type="url" id="new-app-url" class="input-field" placeholder="URL (e.g. https://phet.colorado.edu)">
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 12px;">
          <input type="text" id="new-app-category" class="input-field" placeholder="Category (e.g. Science, Math)">
          <input type="text" id="new-app-icon" class="input-field" placeholder="Emoji Icon (e.g. ⚛️, 🔬, 📘)">
        </div>
        <button class="btn btn-primary" style="width: 100%; justify-content: center;" onclick="addPortalApp()">Add to Student Portal</button>
      </div>
    </div>
  </div>

  <!-- Lab Settings Modal -->
  <div class="modal-overlay" id="settings-modal">
    <div class="modal-container" style="max-width: 500px;">
      <div class="modal-header">
        <div class="modal-title">Computer Lab & Subdomain Settings</div>
        <button class="modal-close" onclick="closeSettingsModal()">✕</button>
      </div>
      <div style="margin-bottom: 16px;">
        <label style="font-size: 13px; font-weight: 600; display: block; margin-bottom: 6px;">School Lab Name</label>
        <input type="text" class="input-field" value="${tenant?.name || ''}" readonly style="opacity: 0.8;">
      </div>

      <div style="margin-bottom: 16px;">
        <label style="font-size: 13px; font-weight: 600; display: block; margin-bottom: 6px;">Active Subdomain</label>
        <input type="text" class="input-field" value="${tenant?.subdomain || 'lab1'}.labkiosk.io" readonly style="font-family: monospace; opacity: 0.8;">
      </div>

      <div style="border-top: 1px solid var(--border); padding-top: 16px;">
        <h4 style="font-size: 14px; font-weight: 700; margin-bottom: 8px;">Request Subdomain Change</h4>
        <p style="font-size: 12px; color: var(--text-muted); margin-bottom: 12px;">
          Submit a new subdomain slug. Once approved by the platform super administrator, your lab will be reachable at the new address.
        </p>
        <div style="display: flex; gap: 8px; margin-bottom: 8px;">
          <input type="text" id="setting-new-subdomain" class="input-field" placeholder="new-subdomain" pattern="[a-z0-9\-]+" style="font-family: monospace;">
          <button class="btn btn-primary" onclick="requestSubdomainChange()">Submit Request</button>
        </div>
        <div id="subdomain-status-msg" style="font-size: 12px; color: #60a5fa; min-height: 16px;"></div>
      </div>
    </div>
  </div>

  <script>
    const TUNNEL_DOMAIN = "${config.tunnelDomain || 'lab.myschool.edu'}";
    let clientsData = {};
    let currentWhitelist = ${JSON.stringify(config.whitelist || [])};

    function renderWhitelistTags() {
      const container = document.getElementById('whitelist-tag-container');
      const countEl = document.getElementById('stat-whitelist-count');
      const totalEl = document.getElementById('modal-whitelist-total');
      if (countEl) countEl.textContent = currentWhitelist.length;
      if (totalEl) totalEl.textContent = currentWhitelist.length + ' Allowed';

      if (!currentWhitelist || currentWhitelist.length === 0) {
        container.innerHTML = '<span style="color: var(--text-muted); font-size: 12px; padding: 10px;">No domains currently allowed.</span>';
        return;
      }

      container.innerHTML = currentWhitelist.map(d => \`
        <span class="domain-tag">
          <span>\${d}</span>
          <button class="domain-remove-btn" title="Remove \${d}" onclick="removeWhitelistDomain('\${d}')">✕</button>
        </span>
      \`).join('');
    }

    async function openWhitelistModal() {
      try {
        const res = await fetch('/api/whitelist');
        if (res.ok) {
          const data = await res.json();
          if (data.whitelist) currentWhitelist = data.whitelist;
        }
      } catch (e) {
        console.warn("Could not fetch whitelist:", e);
      }
      renderWhitelistTags();
      document.getElementById('whitelist-modal').classList.add('active');
    }

    function closeWhitelistModal() {
      document.getElementById('whitelist-modal').classList.remove('active');
    }

    async function addWhitelistDomain() {
      const input = document.getElementById('new-domain-input');
      const domain = input.value.trim();
      if (!domain) return;
      await quickAddDomain(domain);
      input.value = '';
    }

    async function quickAddDomain(domain) {
      try {
        const res = await fetch('/api/whitelist', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'add', domain })
        });
        if (res.ok) {
          const data = await res.json();
          if (data.whitelist) currentWhitelist = data.whitelist;
          renderWhitelistTags();
        }
      } catch (e) {
        console.error("Failed adding domain:", e);
      }
    }

    async function removeWhitelistDomain(domain) {
      try {
        const res = await fetch('/api/whitelist', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'remove', domain })
        });
        if (res.ok) {
          const data = await res.json();
          if (data.whitelist) currentWhitelist = data.whitelist;
          renderWhitelistTags();
        }
      } catch (e) {
        console.error("Failed removing domain:", e);
      }
    }

    // Create new card DOM element for a dynamically discovered client
    function createCardElement(id) {
      const div = document.createElement('div');
      div.className = 'kiosk-card';
      div.id = 'card-' + id;
      div.innerHTML = \`
        <div class="card-header">
          <div class="card-id-wrapper">
            <div class="stat-dot red" id="dot-\${id}"></div>
            <span>\${id}</span>
          </div>
          <div class="card-badges">
            <span class="badge badge-locked" id="lock-badge-\${id}" style="display: none;">Locked</span>
            <button class="card-remove-btn" title="Remove \${id} from collection" onclick="removeClient('\${id}')">✕</button>
          </div>
        </div>
        <div class="card-thumbnail-box">
          <img id="thumb-\${id}" class="card-thumbnail" style="display: none;" />
          <div class="offline-placeholder" id="placeholder-\${id}">
            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <circle cx="12" cy="12" r="10"></circle>
              <line x1="4.93" y1="4.93" x2="19.07" y2="19.07"></line>
            </svg>
            <span>Standby / Offline</span>
          </div>
          <div class="card-hover-actions">
            <button class="action-mini-btn" onclick="openVncSession('\${id}')">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <rect x="2" y="3" width="20" height="14" rx="2"></rect>
                <line x1="8" y1="21" x2="16" y2="21"></line>
                <line x1="12" y1="17" x2="12" y2="21"></line>
              </svg>
              Remote Control
            </button>
            <button class="action-mini-btn" onclick="sendClientCommand('\${id}', 'lock')">Lock Screen</button>
            <button class="action-mini-btn" onclick="sendClientCommand('\${id}', 'unlock')">Unlock</button>
            <button class="action-mini-btn" onclick="sendClientCommand('\${id}', 'reload')">Reload</button>
          </div>
        </div>
        <div class="card-footer">
          <span class="active-domain" id="url-\${id}">Ready</span>
          <span id="ip-\${id}" style="font-family: monospace; font-size: 11px;">--</span>
        </div>
      \`;
      return div;
    }

    // Refresh telemetry from worker API and dynamically update cards
    async function fetchTelemetry() {
      try {
        const res = await fetch('/api/clients');
        if (!res.ok) return;
        const data = await res.json();
        clientsData = data.clients || {};

        const grid = document.getElementById('kiosk-grid');
        const clientIds = Object.keys(clientsData).sort();
        const totalCount = clientIds.length;

        // 1. If no clients exist, show empty state
        if (totalCount === 0) {
          grid.innerHTML = \`
            <div class="empty-lab-state">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#4b5563" stroke-width="1.5">
                <rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect>
                <line x1="8" y1="21" x2="16" y2="21"></line>
                <line x1="12" y1="17" x2="12" y2="21"></line>
              </svg>
              <div style="font-size: 16px; font-weight: 600; color: var(--text-main);">No Thin Clients Connected Yet</div>
              <div style="font-size: 13px; color: var(--text-muted); max-width: 440px; line-height: 1.5;">
                Workstations will automatically appear here as soon as they boot up and check in with this Cloudflare Worker.
              </div>
            </div>
          \`;
          document.getElementById('stat-online-count').textContent = '0';
          document.getElementById('stat-total-count').textContent = '0';
          document.getElementById('stat-locked-count').textContent = '0';
          const titleCount = document.getElementById('stat-active-title');
          if (titleCount) titleCount.textContent = '0 Connected';
          return;
        }

        // Remove empty state placeholder if present
        const emptyEl = grid.querySelector('.empty-lab-state');
        if (emptyEl) emptyEl.remove();

        // Remove cards for any clients no longer in clientsData
        const existingCards = grid.querySelectorAll('.kiosk-card');
        existingCards.forEach(card => {
          const cardId = card.id.replace('card-', '');
          if (!clientsData[cardId]) {
            card.remove();
          }
        });

        let onlineCount = 0;
        let lockedCount = 0;

        for (const id of clientIds) {
          let card = document.getElementById('card-' + id);
          if (!card) {
            card = createCardElement(id);
            grid.appendChild(card);
          }

          const client = clientsData[id];
          const dot = document.getElementById('dot-' + id);
          const thumb = document.getElementById('thumb-' + id);
          const placeholder = document.getElementById('placeholder-' + id);
          const lockBadge = document.getElementById('lock-badge-' + id);
          const urlText = document.getElementById('url-' + id);
          const ipText = document.getElementById('ip-' + id);

          if (client && client.online) {
            onlineCount++;
            if (dot) dot.className = 'stat-dot green';
            if (thumb && placeholder) {
              if (client.thumbnail) {
                thumb.src = client.thumbnail;
                thumb.style.display = 'block';
                placeholder.style.display = 'none';
              } else {
                thumb.style.display = 'none';
                placeholder.style.display = 'flex';
              }
            }
            if (client.isLocked) {
              lockedCount++;
              card.classList.add('locked');
              if (lockBadge) lockBadge.style.display = 'inline-block';
            } else {
              card.classList.remove('locked');
              if (lockBadge) lockBadge.style.display = 'none';
            }
            if (client.activeUrl && urlText) {
              try {
                const u = new URL(client.activeUrl);
                urlText.textContent = u.hostname;
              } catch(e) {
                urlText.textContent = client.activeUrl;
              }
            }
            if (client.ip && ipText) ipText.textContent = client.ip;
          } else {
            if (dot) dot.className = 'stat-dot red';
            if (thumb) thumb.style.display = 'none';
            if (placeholder) placeholder.style.display = 'flex';
            card.classList.remove('locked');
            if (lockBadge) lockBadge.style.display = 'none';
            if (urlText) urlText.textContent = 'Standby / Offline';
            if (client && client.ip && ipText) ipText.textContent = client.ip;
          }
        }

        document.getElementById('stat-online-count').textContent = onlineCount;
        document.getElementById('stat-total-count').textContent = totalCount;
        document.getElementById('stat-locked-count').textContent = lockedCount;
        const titleCount = document.getElementById('stat-active-title');
        if (titleCount) titleCount.textContent = \`\${onlineCount}/\${totalCount} Online\`;
      } catch (err) {
        console.warn("Telemetry poll error:", err);
      }
    }

    async function removeClient(clientId) {
      if (!confirm(\`Remove \${clientId} from the dashboard collection?\`)) return;
      try {
        await fetch('/api/clients/remove', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ clientId })
        });
        const card = document.getElementById('card-' + clientId);
        if (card) card.remove();
        delete clientsData[clientId];
        fetchTelemetry();
      } catch (e) {
        console.error("Failed removing client:", e);
      }
    }

    // Command Dispatchers
    async function broadcastAction(action) {
      if (!confirm(\`Are you sure you want to \${action.toUpperCase()} all lab computers?\`)) return;
      await fetch('/api/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: 'all', action })
      });
      fetchTelemetry();
    }

    async function sendClientCommand(clientId, action) {
      await fetch('/api/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: clientId, action })
      });
      fetchTelemetry();
    }

    function openBroadcastUrlModal() {
      document.getElementById('url-modal').classList.add('active');
    }
    function closeUrlModal() {
      document.getElementById('url-modal').classList.remove('active');
    }
    function setQuickUrl(url) {
      document.getElementById('target-url-input').value = url;
    }
    async function submitBroadcastUrl() {
      const url = document.getElementById('target-url-input').value.trim();
      if (!url) return;
      await fetch('/api/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ target: 'all', action: 'navigate', url })
      });
      closeUrlModal();
      fetchTelemetry();
    }

    function confirmPoweroff() {
      if (confirm("WARNING: This will power off all connected thin clients immediately. Proceed?")) {
        broadcastAction('shutdown');
      }
    }

    // noVNC Interactive Remote Control Modal
    function openVncSession(clientId) {
      document.getElementById('vnc-modal-title').textContent = 'Live Remote Control: ' + clientId;
      let vncUrl;
      if (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1') {
        // Local Dev / Docker Simulation Mode: Connect directly to local noVNC gateway
        vncUrl = \`http://\${window.location.hostname}:6080/vnc.html?autoconnect=true&resize=scale\`;
      } else {
        // Production: Route through Cloudflare Named Tunnel subdomain
        const sub = clientId.toLowerCase();
        vncUrl = \`https://\${sub}.\${TUNNEL_DOMAIN}/vnc.html?autoconnect=true&resize=scale\`;
      }
      document.getElementById('vnc-frame').src = vncUrl;
      document.getElementById('vnc-modal').classList.add('active');
    }
    function closeVncModal() {
      document.getElementById('vnc-modal').classList.remove('active');
      document.getElementById('vnc-frame').src = 'about:blank';
    }

    // Portal Apps Management
    let portalSites = ${JSON.stringify(sites || [])};

    function renderPortalSitesList() {
      const list = document.getElementById('portal-apps-list');
      if (!list) return;
      if (!portalSites || portalSites.length === 0) {
        list.innerHTML = '<span style="font-size: 13px; color: var(--text-muted); padding: 12px; text-align: center;">No apps configured. Add one below!</span>';
        return;
      }
      list.innerHTML = portalSites.map(s => \`
        <div style="display: flex; align-items: center; justify-content: space-between; background: #1f2937; border: 1px solid var(--border); border-radius: 6px; padding: 8px 12px;">
          <div style="display: flex; align-items: center; gap: 10px;">
            <span style="font-size: 18px;">\${s.icon || '🌐'}</span>
            <div>
              <div style="font-size: 13px; font-weight: 700;">\${s.title}</div>
              <div style="font-size: 11px; color: var(--text-muted); font-family: monospace;">\${s.url}</div>
            </div>
          </div>
          <button class="domain-remove-btn" title="Remove \${s.title}" onclick="deletePortalApp('\${s.id}')">✕</button>
        </div>
      \`).join('');
    }

    function openPortalModal() {
      renderPortalSitesList();
      document.getElementById('portal-modal').classList.add('active');
    }
    function closePortalModal() {
      document.getElementById('portal-modal').classList.remove('active');
    }

    async function addPortalApp() {
      const title = document.getElementById('new-app-title').value.trim();
      const url = document.getElementById('new-app-url').value.trim();
      const category = document.getElementById('new-app-category').value.trim() || 'General';
      const icon = document.getElementById('new-app-icon').value.trim() || '🌐';
      if (!title || !url) {
        alert("Please enter both Title and URL");
        return;
      }
      try {
        const res = await fetch('/api/portal-sites', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, url, category, icon })
        });
        const data = await res.json();
        if (data.site) {
          portalSites.push(data.site);
          renderPortalSitesList();
          document.getElementById('new-app-title').value = '';
          document.getElementById('new-app-url').value = '';
        }
      } catch (e) {
        console.error("Failed adding app:", e);
      }
    }

    async function deletePortalApp(id) {
      if (!confirm("Remove this app from the student learning portal?")) return;
      try {
        await fetch('/api/portal-sites/' + id, { method: 'DELETE' });
        portalSites = portalSites.filter(s => s.id !== id);
        renderPortalSitesList();
      } catch (e) {
        console.error("Failed deleting app:", e);
      }
    }

    async function updateKioskMode(mode) {
      try {
        await fetch('/api/settings/mode', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mode })
        });
      } catch (e) {
        console.error("Failed updating mode:", e);
      }
    }

    // Settings & Subdomain Management
    function openSettingsModal() {
      document.getElementById('settings-modal').classList.add('active');
    }
    function closeSettingsModal() {
      document.getElementById('settings-modal').classList.remove('active');
    }

    async function requestSubdomainChange() {
      const sub = document.getElementById('setting-new-subdomain').value.trim().toLowerCase();
      const msg = document.getElementById('subdomain-status-msg');
      if (!sub) return;
      try {
        const res = await fetch('/api/settings/subdomain', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestedSubdomain: sub })
        });
        const data = await res.json();
        if (data.status === 'ok') {
          msg.textContent = "Request for '" + sub + "' submitted for super admin approval!";
          msg.style.color = "#34d399";
        } else {
          msg.textContent = data.error || "Failed submitting request";
          msg.style.color = "#f87171";
        }
      } catch (e) {
        msg.textContent = "Error submitting request";
        msg.style.color = "#f87171";
      }
    }

    // Start Loops
    fetchTelemetry();
    setInterval(fetchTelemetry, 3000);
  </script>
</body>
</html>`;
}
