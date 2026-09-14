/**
 * Modern High-Performance Teacher Lab Dashboard
 * Self-contained HTML/CSS/JS frontend rendered by the Cloudflare Worker.
 *
 * Rendering rules for this file:
 *  - Server-side interpolation of tenant data goes through escapeHtml/escapeJson.
 *  - Client-side rendering builds DOM nodes and sets textContent; it never
 *    concatenates untrusted values into innerHTML or into inline handlers.
 */

import { LabConfig, Tenant, PortalSite, BroadcastPreset } from "./types";
import { escapeHtml, escapeAttr, escapeJson, safeHttpUrl } from "./escape";

export interface DashboardOptions {
  config: LabConfig;
  tenant?: Tenant;
  sites?: PortalSite[];
  baseDomain?: string;
  presets?: BroadcastPreset[];
  /** Per-response CSP nonce; every <script> in this template must carry it. */
  nonce: string;
}

export function renderDashboardHtml(options: DashboardOptions): string {
  const { config, tenant, sites = [], baseDomain = "labkiosk.akbhoi.com", presets = [], nonce } = options;
  const labName = tenant?.name || "School Computer Lab Control";
  const fullDomain = tenant ? `${tenant.subdomain}.${baseDomain}` : "";
  const subtitle = tenant
    ? `${fullDomain} • Lab Console`
    : "Centralized Kiosk Monitoring & Cloudflare Management";

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
      flex-wrap: wrap;
    }

    .brand { display: flex; align-items: center; gap: 12px; }

    .brand-icon {
      width: 38px;
      height: 38px;
      background: linear-gradient(135deg, #3b82f6, #6366f1);
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 0 15px rgba(59, 130, 246, 0.4);
      flex-shrink: 0;
    }

    .brand-title { font-size: 18px; font-weight: 700; letter-spacing: -0.3px; }
    .brand-subtitle { font-size: 12px; color: var(--text-muted); }

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

    .stat-pill { display: flex; align-items: center; gap: 6px; }

    .stat-dot { width: 8px; height: 8px; border-radius: 50%; }
    .stat-dot.green { background: var(--success); box-shadow: 0 0 6px var(--success); }
    .stat-dot.red { background: var(--danger); }
    .stat-dot.yellow { background: var(--warning); }

    .action-toolbar { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }

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
      font-family: inherit;
      text-decoration: none;
    }

    .btn-primary { background: var(--accent); color: #fff; }
    .btn-primary:hover { background: var(--accent-hover); transform: translateY(-1px); }

    .btn-danger { background: rgba(239, 68, 68, 0.15); color: #fca5a5; border-color: rgba(239, 68, 68, 0.3); }
    .btn-danger:hover { background: var(--danger); color: #fff; }

    .btn-warning { background: rgba(245, 158, 11, 0.15); color: #fde68a; border-color: rgba(245, 158, 11, 0.3); }
    .btn-warning:hover { background: var(--warning); color: #000; }

    .btn-secondary { background: var(--bg-card); color: var(--text-main); border-color: var(--border); }
    .btn-secondary:hover { background: var(--bg-card-hover); }

    /* Workstation Grid */
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
      gap: 12px;
      flex-wrap: wrap;
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
      font-family: inherit;
    }
    .kiosk-card:hover .card-remove-btn { opacity: 0.9; }
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

    .kiosk-card.locked { border-color: var(--danger); }

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

    .card-badges { display: flex; align-items: center; gap: 6px; }

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

    .card-thumbnail-box:hover .card-hover-actions { opacity: 1; pointer-events: auto; }

    .action-mini-btn {
      display: flex;
      align-items: center;
      justify-content: center;
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
      font-family: inherit;
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
      gap: 8px;
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

    /* Modals */
    .modal-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.85);
      backdrop-filter: blur(4px);
      z-index: 2000;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      opacity: 0;
      visibility: hidden;
      transition: opacity 0.25s, visibility 0.25s;
    }

    .modal-overlay.active { opacity: 1; visibility: visible; }

    /* Generic modal shell used by the Portal Apps and Settings dialogs. */
    .modal-container {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 24px;
      width: 100%;
      max-height: 88vh;
      overflow-y: auto;
      position: relative;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.9);
    }

    .modal-close {
      background: transparent;
      border: none;
      color: var(--text-muted);
      font-size: 18px;
      cursor: pointer;
      line-height: 1;
      padding: 4px 8px;
      border-radius: 6px;
      font-family: inherit;
    }
    .modal-close:hover { color: var(--text-main); background: var(--bg-card); }

    .input-field {
      width: 100%;
      background: var(--bg-base);
      border: 1px solid var(--border);
      color: var(--text-main);
      padding: 9px 12px;
      border-radius: 8px;
      font-size: 13px;
      font-family: inherit;
      outline: none;
      transition: border-color 0.15s;
    }
    .input-field:focus { border-color: var(--accent); }
    .input-field[readonly] { opacity: 0.75; cursor: default; }

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
      gap: 12px;
      margin: -24px -24px 16px;
      border-radius: 12px 12px 0 0;
    }
    .vnc-modal-container .modal-header { margin: 0; border-radius: 0; }

    .modal-title {
      font-size: 16px;
      font-weight: 700;
      display: flex;
      align-items: center;
      gap: 10px;
    }

    .vnc-iframe-wrapper { flex: 1; background: #000; position: relative; }
    .vnc-iframe { width: 100%; height: 100%; border: none; }

    /* Prompt-style modal (broadcast URL, allowed sites) */
    .prompt-box {
      width: 100%;
      max-width: 520px;
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

    .quick-links { display: flex; flex-wrap: wrap; gap: 8px; }

    .quick-chip {
      background: var(--bg-card);
      border: 1px solid var(--border);
      padding: 5px 10px;
      border-radius: 20px;
      font-size: 12px;
      cursor: pointer;
      transition: background 0.15s;
      font-family: inherit;
      color: var(--text-main);
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
    .domain-tag:hover { border-color: var(--accent); }

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
      font-family: inherit;
    }
    .domain-remove-btn:hover { color: var(--danger); }

    .field-label { font-size: 13px; font-weight: 600; display: block; margin-bottom: 6px; }
    .field-hint { font-size: 12px; color: var(--text-muted); line-height: 1.5; }
    .field-group { margin-bottom: 16px; }
    .section-divider { border-top: 1px solid var(--border); padding-top: 16px; margin-top: 4px; }

    .enrollment-key {
      font-family: 'JetBrains Mono', monospace;
      font-size: 15px;
      letter-spacing: 1px;
      color: #6ee7b7;
      background: var(--bg-base);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px 14px;
      word-break: break-all;
      user-select: all;
    }

    /* Mobile & Tablet Responsiveness */
    @media (max-width: 900px) {
      .nav-container { padding: 12px 16px; }
      .action-toolbar { width: 100%; justify-content: flex-start; }
      .stats-bar { order: 3; width: 100%; justify-content: space-between; margin-top: 4px; }
    }
    @media (max-width: 640px) {
      .nav-container { padding: 10px 12px; gap: 10px; }
      .brand { gap: 10px; }
      .brand-icon { width: 34px; height: 34px; }
      .brand-title { font-size: 16px; }
      .brand-subtitle { font-size: 11px; }
      .action-toolbar { gap: 6px; }
      .btn { padding: 7px 12px; font-size: 12px; }
      main { padding: 16px 12px; }
      .kiosk-grid { grid-template-columns: 1fr; gap: 14px; }
      .modal-container { padding: 16px; border-radius: 10px; max-height: 94vh; }
      .modal-header { margin: -16px -16px 14px; padding: 10px 14px; }
      .prompt-box { padding: 18px 14px; border-radius: 10px; }
      .vnc-modal-container { width: 98vw; height: 94vh; border-radius: 8px; }
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
          <div class="brand-title">${escapeHtml(labName)}</div>
          <div class="brand-subtitle">${escapeHtml(subtitle)}</div>
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
        <button class="btn btn-warning" id="btn-lock-all">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
            <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
          </svg>
          Lock All
        </button>

        <button class="btn btn-secondary" id="btn-unlock-all">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
            <path d="M7 11V7a5 5 0 0 1 9.9-1"></path>
          </svg>
          Unlock All
        </button>

        <button class="btn btn-secondary" id="btn-open-portal" title="Configure Student Portal Cards & Homepage">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="3" width="7" height="7"></rect>
            <rect x="14" y="3" width="7" height="7"></rect>
            <rect x="14" y="14" width="7" height="7"></rect>
            <rect x="3" y="14" width="7" height="7"></rect>
          </svg>
          Portal Apps
        </button>

        <button class="btn btn-secondary" id="btn-open-whitelist" title="Manage allowed educational domains">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path>
            <polyline points="9 12 11 14 15 10"></polyline>
          </svg>
          Allowed Sites (<span id="stat-whitelist-count">${config.whitelist.length}</span>)
        </button>

        <button class="btn btn-primary" id="btn-open-broadcast">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="2" y1="12" x2="22" y2="12"></line>
            <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"></path>
          </svg>
          Broadcast URL
        </button>

        <button class="btn btn-secondary" id="btn-open-settings" title="Lab Settings & Subdomain Management">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="3"></circle>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
          </svg>
          Settings
        </button>

        <form method="post" action="/api/auth/logout" style="display: inline;">
          <button type="submit" class="btn btn-secondary" style="color: #ef4444;" title="Sign out of console">Sign Out</button>
        </form>
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
          <span id="vnc-modal-title">Live Remote Control</span>
        </div>
        <div style="display: flex; gap: 10px;">
          <button class="btn btn-secondary" id="btn-close-vnc">Close Session</button>
        </div>
      </div>
      <div class="vnc-iframe-wrapper">
        <iframe id="vnc-frame" class="vnc-iframe" src="about:blank" referrerpolicy="no-referrer"></iframe>
      </div>
    </div>
  </div>

  <!-- Broadcast URL Modal -->
  <div class="modal-overlay" id="url-modal">
    <div class="prompt-box" style="max-width: 620px;">
      <h3 style="font-size: 18px; font-weight: 700; display: flex; align-items: center; gap: 8px;">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2">
          <circle cx="12" cy="12" r="2"></circle>
          <path d="M16.24 7.76a6 6 0 0 1 0 8.49m-8.48-.01a6 6 0 0 1 0-8.49m11.31-2.82a10 10 0 0 1 0 14.14m-14.14 0a10 10 0 0 1 0-14.14"></path>
        </svg>
        Broadcast Lesson URL to All Clients
      </h3>
      <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 12px;">
        Enter a whitelisted URL to immediately navigate all connected thin clients.
      </p>

      <input type="text" id="target-url-input" class="prompt-input" value="${escapeHtml(tenant?.default_url || "")}" placeholder="https://...">
      <div id="broadcast-error" class="field-hint" style="color: #f87171; min-height: 16px; margin-top: -6px;"></div>

      <!-- Dynamic Shortcuts & Presets -->
      <div style="margin-top: 14px;">
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px;">
          <span style="font-size: 11px; font-weight: 700; color: var(--text-muted); text-transform: uppercase;">
            Quick Launch Shortcuts
          </span>
          <button type="button" id="btn-toggle-add-shortcut" style="font-size: 12px; color: #60a5fa; cursor: pointer; background: none; border: none; padding: 0;">
            + Add New Shortcut
          </button>
        </div>

        <!-- Inline Add Shortcut Form -->
        <div id="add-shortcut-form" style="display: none; background: var(--bg-base); border: 1px solid var(--border); border-radius: 8px; padding: 10px; margin-bottom: 10px;">
          <div style="display: grid; grid-template-columns: 1fr 1.5fr auto; gap: 8px;">
            <input type="text" id="new-preset-title" class="input-field" placeholder="Shortcut Name (e.g. Lab Portal)" style="font-size: 12px; padding: 6px 10px;">
            <input type="url" id="new-preset-url" class="input-field" placeholder="https://..." style="font-size: 12px; padding: 6px 10px;">
            <button type="button" class="btn btn-primary" id="btn-save-preset" style="padding: 6px 12px; font-size: 12px;">Save</button>
          </div>
          <div id="add-preset-error" class="field-hint" style="color: #f87171; min-height: 14px; margin-top: 4px;"></div>
        </div>

        <div class="quick-links" id="broadcast-quick-links" style="max-height: 150px; overflow-y: auto;">
          <!-- Populated dynamically from portal sites and custom presets -->
        </div>
      </div>

      <div style="display: flex; justify-content: space-between; align-items: center; gap: 10px; margin-top: 18px; border-top: 1px solid var(--border-subtle); padding-top: 14px;">
        <button type="button" class="btn btn-secondary" id="btn-reset-broadcast" style="color: #60a5fa;" title="Return all workstations to the school learning portal">
          Reset to School Portal
        </button>
        <div style="display: flex; gap: 10px;">
          <button type="button" class="btn btn-secondary" id="btn-cancel-broadcast">Cancel</button>
          <button type="button" class="btn btn-primary" id="btn-send-broadcast">Send to All PCs</button>
        </div>
      </div>
    </div>
  </div>

  <!-- Freeze Screens Announcement Modal -->
  <div class="modal-overlay" id="lock-modal">
    <div class="prompt-box" style="max-width: 520px;">
      <h3 style="font-size: 18px; font-weight: 700; color: #f87171; display: flex; align-items: center; gap: 8px;">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
          <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
        </svg>
        Freeze Workstation Screens
      </h3>
      <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 14px;">
        Immediately covers all thin client screens with a lockdown curtain and pauses student input.
      </p>

      <div class="field-group">
        <label class="field-label" for="lock-message-input">Curtain Announcement Message</label>
        <input type="text" id="lock-message-input" class="prompt-input" maxlength="280" placeholder="Screens locked by instructor. Please look to the front." value="${escapeHtml(tenant?.default_lock_message || "Screens locked by the instructor. Please look to the front.")}">
      </div>

      <div style="margin-bottom: 16px;">
        <div style="font-size: 11px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; margin-bottom: 6px;">Quick Announcements:</div>
        <div class="quick-links" id="lock-presets">
          <button type="button" class="quick-chip" data-msg="Class attention please! Eyes to the board.">Eyes to Front</button>
          <button type="button" class="quick-chip" data-msg="Midterm Examination in progress. Workstation locked.">Exam Active</button>
          <button type="button" class="quick-chip" data-msg="Lab session paused. Please listen to the instructor.">Session Paused</button>
          <button type="button" class="quick-chip" data-msg="Lab time has ended. Please log off and pack your belongings.">Lab Concluded</button>
          <button type="button" class="quick-chip" data-msg="Workstation temporarily locked for system maintenance.">Maintenance</button>
        </div>
      </div>

      <div style="display: flex; justify-content: flex-end; gap: 10px;">
        <button type="button" class="btn btn-secondary" id="btn-cancel-lock">Cancel</button>
        <button type="button" class="btn btn-danger" id="btn-confirm-lock">Freeze All Screens</button>
      </div>
    </div>
  </div>

  <!-- Manage Allowed Sites Modal -->
  <div class="modal-overlay" id="whitelist-modal">
    <div class="prompt-box" style="width: 680px; max-height: 85vh;">
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
      <p class="field-hint">
        Student kiosks are locked to this whitelist. Subdomains and paths are automatically permitted.
      </p>

      <div style="display: flex; gap: 10px;">
        <input type="text" id="new-domain-input" class="prompt-input" placeholder="e.g. scratch.mit.edu, geogebra.org, phet.colorado.edu" style="flex: 1;">
        <button class="btn btn-primary" id="btn-add-domain">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <line x1="12" y1="5" x2="12" y2="19"></line>
            <line x1="5" y1="12" x2="19" y2="12"></line>
          </svg>
          Add Site
        </button>
      </div>
      <div id="whitelist-error" class="field-hint" style="color: #f87171; min-height: 16px; margin-top: -10px;"></div>

      <div>
        <div style="font-size: 11px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; margin-bottom: 6px;">Quick Presets:</div>
        <div class="quick-links" id="whitelist-presets">
          <button type="button" class="quick-chip" data-domain="khanacademy.org">+ Khan Academy</button>
          <button type="button" class="quick-chip" data-domain="scratch.mit.edu">+ Scratch Coding</button>
          <button type="button" class="quick-chip" data-domain="cbse.gov.in">+ CBSE Official</button>
          <button type="button" class="quick-chip" data-domain="ncert.nic.in">+ NCERT Textbooks</button>
          <button type="button" class="quick-chip" data-domain="wikipedia.org">+ Wikipedia</button>
          <button type="button" class="quick-chip" data-domain="geogebra.org">+ GeoGebra</button>
          <button type="button" class="quick-chip" data-domain="phet.colorado.edu">+ PhET Sims</button>
          <button type="button" class="quick-chip" data-domain="github.com">+ GitHub</button>
          <button type="button" class="quick-chip" data-domain="stackoverflow.com">+ StackOverflow</button>
          <button type="button" class="quick-chip" data-domain="python.org">+ Python</button>
          <button type="button" class="quick-chip" data-domain="w3schools.com">+ W3Schools</button>
        </div>
      </div>

      <div style="flex: 1; overflow-y: auto; max-height: 260px; min-height: 120px; background: var(--bg-base); border: 1px solid var(--border); border-radius: 8px; padding: 12px; display: flex; flex-wrap: wrap; gap: 8px; align-content: flex-start;" id="whitelist-tag-container">
        <!-- Rendered dynamically -->
      </div>

      <div style="display: flex; justify-content: flex-end; gap: 10px; border-top: 1px solid var(--border-subtle); padding-top: 12px;">
        <button class="btn btn-secondary" id="btn-close-whitelist">Done</button>
      </div>
    </div>
  </div>

  <!-- Student Portal Apps Modal -->
  <div class="modal-overlay" id="portal-modal">
    <div class="modal-container" style="max-width: 680px;">
      <div class="modal-header">
        <div class="modal-title">Student Learning Portal Applications</div>
        <button class="modal-close" id="btn-close-portal">&#10005;</button>
      </div>
      <p class="field-hint" style="margin-bottom: 16px;">
        Configure the educational cards displayed on student thin clients when they open their web browser.
      </p>

      <!-- App Launcher Mode Toggle -->
      <div style="background: var(--bg-base); border: 1px solid var(--border); border-radius: 8px; padding: 14px; margin-bottom: 16px; display: flex; align-items: center; justify-content: space-between; gap: 12px;">
        <div>
          <div style="font-size: 14px; font-weight: 700;">Homepage Experience</div>
          <div class="field-hint">Choose whether students see the App Launcher Grid or land directly on a single site.</div>
        </div>
        <select id="kiosk-mode-select" class="input-field" style="width: auto;">
          <option value="portal" ${tenant?.mode === "portal" ? "selected" : ""}>Visual App Launcher Grid</option>
          <option value="single_url" ${tenant?.mode === "single_url" ? "selected" : ""}>Direct Single-Site Lockdown</option>
        </select>
      </div>

      <!-- Single Site Lockdown URL Configuration Panel -->
      <div id="single-url-panel" style="background: var(--bg-base); border: 1px solid #3b82f6; border-radius: 8px; padding: 14px; margin-bottom: 20px; display: ${tenant?.mode === "single_url" ? "block" : "none"};">
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px;">
          <div style="font-size: 14px; font-weight: 700; color: #93c5fd; display: flex; align-items: center; gap: 6px;">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"></path><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"></path></svg>
            Single-Site Lockdown Target URL
          </div>
          <span style="font-size: 11px; background: rgba(59, 130, 246, 0.2); color: #93c5fd; padding: 2px 8px; border-radius: 4px; font-weight: 600;">Lockdown Active</span>
        </div>
        <p class="field-hint" style="margin-bottom: 10px;">
          Thin clients automatically launch directly into this website (e.g. University LMS, Canvas, Moodle, Exam Portal, or Library Catalog) with 100% full-screen lockdown.
        </p>
        <div style="display: flex; gap: 8px;">
          <input type="url" id="single-url-input" class="input-field" placeholder="https://canvas.institution.edu or https://exam.school.edu" value="${escapeHtml(tenant?.default_url || "")}" style="flex: 1; font-family: 'JetBrains Mono', monospace; font-size: 13px;">
          <button class="btn btn-primary" id="btn-save-single-url">Save Target URL</button>
        </div>
        <div id="single-url-msg" class="field-hint" style="min-height: 16px; margin-top: 6px;"></div>
      </div>

      <!-- Current Apps List -->
      <div id="portal-apps-list" style="display: flex; flex-direction: column; gap: 10px; max-height: 220px; overflow-y: auto; margin-bottom: 20px; background: var(--bg-base); border: 1px solid var(--border); border-radius: 8px; padding: 12px;">
        <!-- Populated dynamically -->
      </div>

      <!-- Add New App Form -->
      <div class="section-divider">
        <h4 style="font-size: 14px; font-weight: 700; margin-bottom: 12px;">Add Approved Educational Website</h4>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 10px;">
          <input type="text" id="new-app-title" class="input-field" placeholder="App Title (e.g. PhET Simulations)">
          <input type="url" id="new-app-url" class="input-field" placeholder="URL (e.g. https://phet.colorado.edu)">
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 12px;">
          <input type="text" id="new-app-category" class="input-field" placeholder="Category (e.g. Science, Math)">
          <input type="text" id="new-app-icon" class="input-field" placeholder="Emoji Icon">
        </div>
        <div id="portal-error" class="field-hint" style="color: #f87171; min-height: 16px; margin-bottom: 8px;"></div>
        <button class="btn btn-primary" style="width: 100%; justify-content: center;" id="btn-add-app">Add to Student Portal</button>
      </div>
    </div>
  </div>

  <!-- Lab Settings Modal -->
  <div class="modal-overlay" id="settings-modal">
    <div class="modal-container" style="max-width: 600px; max-height: 85vh; overflow-y: auto;">
      <div class="modal-header">
        <div class="modal-title">Lab Settings &amp; Customization</div>
        <button class="modal-close" id="btn-close-settings">&#10005;</button>
      </div>

      <div class="field-group">
        <label class="field-label" for="setting-lab-name">Lab / Institution Name</label>
        <div style="display: flex; gap: 8px;">
          <input id="setting-lab-name" type="text" class="input-field" value="${escapeHtml(tenant?.name || "")}" maxlength="120" style="flex: 1;">
          <button class="btn btn-secondary" id="btn-save-lab-name">Save Name</button>
        </div>
        <div id="lab-name-status-msg" class="field-hint" style="min-height: 16px; margin-top: 4px;"></div>
      </div>

      <div class="field-group">
        <label class="field-label" for="setting-active-subdomain">Active Subdomain</label>
        <input id="setting-active-subdomain" type="text" class="input-field" value="${escapeHtml(fullDomain)}" readonly style="font-family: 'JetBrains Mono', monospace;">
      </div>

      <div class="field-group">
        <label class="field-label" for="setting-kiosk-mode">Homepage &amp; Lockdown Experience</label>
        <select id="setting-kiosk-mode" class="input-field" style="margin-bottom: 8px;">
          <option value="portal" ${tenant?.mode === "portal" ? "selected" : ""}>Visual App Launcher Grid (Educational Cards)</option>
          <option value="single_url" ${tenant?.mode === "single_url" ? "selected" : ""}>Direct Single-Site Lockdown (LMS / Exam / Single Site)</option>
        </select>
        <div id="setting-single-url-wrap" style="display: ${tenant?.mode === "single_url" ? "block" : "none"}; margin-top: 8px;">
          <label class="field-label" for="setting-default-url" style="font-size: 12px;">Single-Site Lockdown Target URL</label>
          <div style="display: flex; gap: 8px;">
            <input id="setting-default-url" type="url" class="input-field" placeholder="https://canvas.institution.edu or https://exam.school.edu" value="${escapeHtml(tenant?.default_url || "")}" style="flex: 1; font-family: 'JetBrains Mono', monospace; font-size: 13px;">
            <button class="btn btn-primary" id="btn-save-setting-mode">Save Mode &amp; URL</button>
          </div>
        </div>
        <div id="setting-mode-status-msg" class="field-hint" style="min-height: 16px; margin-top: 4px;"></div>
      </div>

      <div class="field-group">
        <label class="field-label" for="setting-lock-message">Default Lock Screen Announcement</label>
        <div style="display: flex; gap: 8px;">
          <input id="setting-lock-message" type="text" class="input-field" value="${escapeHtml(tenant?.default_lock_message || "Screens locked by the instructor. Please look to the front.")}" maxlength="280" style="flex: 1;">
          <button class="btn btn-secondary" id="btn-save-lock-message">Save</button>
        </div>
        <p class="field-hint" style="margin-top: 4px;">Displayed full-screen on workstations whenever screens are frozen.</p>
        <div id="lock-msg-status" class="field-hint" style="min-height: 16px; margin-top: 4px;"></div>
      </div>

      <div class="section-divider field-group">
        <h4 style="font-size: 14px; font-weight: 700; margin-bottom: 8px;">Student Portal Branding &amp; Labels</h4>
        <p class="field-hint" style="margin-bottom: 10px;">
          Customize the titles, subtitles, and footer displayed to students on the educational portal.
        </p>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 10px;">
          <div>
            <label class="field-label" for="setting-portal-title" style="font-size: 12px;">Portal Hero Title</label>
            <input id="setting-portal-title" type="text" class="input-field" placeholder="Select an Educational Resource" value="${escapeHtml(tenant?.portal_title || "")}" maxlength="100">
          </div>
          <div>
            <label class="field-label" for="setting-portal-subtitle" style="font-size: 12px;">Header Subtitle</label>
            <input id="setting-portal-subtitle" type="text" class="input-field" placeholder="Computer Lab Learning Portal" value="${escapeHtml(tenant?.portal_subtitle || "")}" maxlength="150">
          </div>
        </div>
        <div style="margin-bottom: 10px;">
          <label class="field-label" for="setting-portal-desc" style="font-size: 12px;">Instruction Description</label>
          <input id="setting-portal-desc" type="text" class="input-field" placeholder="Click any approved application below to begin your lesson..." value="${escapeHtml(tenant?.portal_description || "")}" maxlength="300">
        </div>
        <div style="margin-bottom: 10px;">
          <label class="field-label" for="setting-portal-footer" style="font-size: 12px;">Footer Note</label>
          <input id="setting-portal-footer" type="text" class="input-field" placeholder="Protected by Lab Kiosk OS • Educational Environment Restricted" value="${escapeHtml(tenant?.portal_footer || "")}" maxlength="200">
        </div>
        <button class="btn btn-primary" id="btn-save-branding" style="width: 100%; justify-content: center;">Save Portal Branding</button>
        <div id="branding-status-msg" class="field-hint" style="min-height: 16px; margin-top: 6px;"></div>
      </div>

      <div class="section-divider field-group">
        <h4 style="font-size: 14px; font-weight: 700; margin-bottom: 8px;">Workstation Enrollment Key</h4>
        <p class="field-hint" style="margin-bottom: 10px;">
          Enter this key in the first-boot wizard on each thin client, together with the subdomain above.
          It is what proves a workstation belongs to your school &mdash; treat it like a password and rotate
          it if a device is lost. Rotating does not disconnect workstations that are already enrolled.
        </p>
        <div class="enrollment-key" id="enrollment-key-value">Loading&hellip;</div>
        <div style="display: flex; gap: 8px; margin-top: 10px;">
          <button class="btn btn-secondary" id="btn-copy-key">Copy Key</button>
          <button class="btn btn-danger" id="btn-rotate-key">Rotate Key</button>
        </div>
        <div id="enrollment-status-msg" class="field-hint" style="min-height: 16px; margin-top: 8px;"></div>
      </div>

      <div class="section-divider">
        <h4 style="font-size: 14px; font-weight: 700; margin-bottom: 8px;">Request Subdomain Change</h4>
        <p class="field-hint" style="margin-bottom: 12px;">
          Submit a new subdomain slug. Once approved by the platform super administrator, your lab will be reachable at the new address.
        </p>
        <div style="display: flex; gap: 8px; margin-bottom: 8px;">
          <input type="text" id="setting-new-subdomain" class="input-field" placeholder="new-subdomain" pattern="[a-z0-9\\-]+" style="font-family: 'JetBrains Mono', monospace;">
          <button class="btn btn-primary" id="btn-request-subdomain">Submit Request</button>
        </div>
        <div id="subdomain-status-msg" class="field-hint" style="min-height: 16px;"></div>
      </div>

      <div class="section-divider field-group">
        <h4 style="font-size: 14px; font-weight: 700; margin-bottom: 8px;">Account Security</h4>
        <p class="field-hint" style="margin-bottom: 10px;">
          Change the password for this console login. Every other browser signed in to this account is signed out.
        </p>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 10px;">
          <input id="setting-current-password" type="password" class="input-field" placeholder="Current password" autocomplete="current-password">
          <input id="setting-new-password" type="password" class="input-field" placeholder="New password (12+ chars, letters and numbers)" autocomplete="new-password" minlength="12">
        </div>
        <button class="btn btn-secondary" id="btn-change-password">Change Password</button>
        <div id="password-status-msg" class="field-hint" style="min-height: 16px; margin-top: 6px;"></div>
      </div>

      <div class="section-divider">
        <h4 style="font-size: 14px; font-weight: 700; margin-bottom: 8px;">Custom Domain (FQDN)</h4>
        <p class="field-hint" style="margin-bottom: 12px;">
          Connect your institution's own custom domain (e.g. <code>kiosk.yourschool.edu</code>). Create a DNS <code>CNAME</code> pointing to <code>${escapeHtml(baseDomain)}</code> before submitting.
        </p>
        <div id="custom-domain-display" style="margin-bottom: 12px;">
          ${tenant?.custom_domain ? `
            <div style="display: flex; align-items: center; justify-content: space-between; background: rgba(16, 185, 129, 0.1); border: 1px solid rgba(16, 185, 129, 0.3); padding: 10px 14px; border-radius: 8px;">
              <div>
                <span class="status-badge status-active" style="margin-right: 8px;">ACTIVE</span>
                <a href="https://${escapeAttr(tenant.custom_domain)}" target="_blank" rel="noopener noreferrer" style="color: #6ee7b7; font-family: 'JetBrains Mono', monospace; font-weight: 600;">https://${escapeHtml(tenant.custom_domain)}</a>
              </div>
              <button class="btn btn-danger btn-sm" id="btn-remove-custom-domain">Disconnect</button>
            </div>
          ` : tenant?.custom_domain_status === 'pending' ? `
            <div style="display: flex; align-items: center; justify-content: space-between; background: rgba(245, 158, 11, 0.1); border: 1px solid rgba(245, 158, 11, 0.3); padding: 10px 14px; border-radius: 8px;">
              <div>
                <span class="status-badge status-pending" style="margin-right: 8px;">PENDING APPROVAL</span>
                <span style="font-family: 'JetBrains Mono', monospace; color: #fbbf24;">${escapeHtml(tenant.requested_custom_domain || "")}</span>
              </div>
              <button class="btn btn-secondary btn-sm" id="btn-cancel-custom-domain">Cancel Request</button>
            </div>
          ` : `
            <div style="display: flex; gap: 8px;">
              <input type="text" id="setting-custom-domain" class="input-field" placeholder="e.g. kiosk.yourschool.edu" style="font-family: 'JetBrains Mono', monospace;">
              <button class="btn btn-primary" id="btn-request-custom-domain">Request Domain</button>
            </div>
          `}
        </div>
        <div id="custom-domain-status-msg" class="field-hint" style="min-height: 16px;"></div>
      </div>
    </div>
  </div>

  <script nonce="${escapeAttr(nonce)}">
    "use strict";

    const TUNNEL_DOMAIN = ${escapeJson(config.tunnelDomain || "lab.myschool.edu")};
    const TENANT_QUERY = ${escapeJson(tenant ? "?tenant=" + tenant.subdomain : "")};

    let clientsData = {};
    let currentWhitelist = ${escapeJson(config.whitelist || [])};
    let portalSites = ${escapeJson(sites || [])};
    let broadcastPresets = ${escapeJson(presets || [])};
    let currentTenantData = {
      mode: ${escapeJson(tenant?.mode || "portal")},
      defaultUrl: ${escapeJson(tenant?.default_url || "")},
      defaultLockMessage: ${escapeJson(tenant?.default_lock_message || "Screens locked by the instructor. Please look to the front.")}
    };

    // ---------------------------------------------------------------- helpers

    /** Same-origin API call that keeps the tenant scope on every request. */
    async function api(path, options) {
      const separator = path.includes("?") ? "&" : "?";
      const query = TENANT_QUERY ? separator + TENANT_QUERY.slice(1) : "";
      const res = await fetch(path + query, options);
      let data = null;
      try {
        data = await res.json();
      } catch (err) {
        data = null;
      }
      if (res.status === 401 || res.status === 403) {
        throw new Error((data && data.error) || "Your session has expired. Please sign in again.");
      }
      if (!res.ok) {
        throw new Error((data && data.error) || "Request failed (" + res.status + ")");
      }
      return data || {};
    }

    function postJson(path, body) {
      return api(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
    }

    function el(tag, className, text) {
      const node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined && text !== null) node.textContent = String(text);
      return node;
    }

    function svg(markup, size) {
      const wrap = document.createElementNS("http://www.w3.org/2000/svg", "svg");
      wrap.setAttribute("width", size);
      wrap.setAttribute("height", size);
      wrap.setAttribute("viewBox", "0 0 24 24");
      wrap.setAttribute("fill", "none");
      wrap.setAttribute("stroke", "currentColor");
      wrap.setAttribute("stroke-width", "2");
      wrap.innerHTML = markup;
      return wrap;
    }

    function openModal(id) { document.getElementById(id).classList.add("active"); }
    function closeModal(id) { document.getElementById(id).classList.remove("active"); }

    function setMessage(id, text, tone) {
      const node = document.getElementById(id);
      if (!node) return;
      node.textContent = text || "";
      node.style.color = tone === "ok" ? "#34d399" : tone === "info" ? "#60a5fa" : "#f87171";
    }

    // ------------------------------------------------------------- whitelist

    function renderWhitelistTags() {
      const container = document.getElementById("whitelist-tag-container");
      const countEl = document.getElementById("stat-whitelist-count");
      const totalEl = document.getElementById("modal-whitelist-total");
      if (countEl) countEl.textContent = currentWhitelist.length;
      if (totalEl) totalEl.textContent = currentWhitelist.length + " Allowed";

      container.replaceChildren();

      if (!currentWhitelist.length) {
        const empty = el("span", null, "No domains currently allowed.");
        empty.style.cssText = "color: var(--text-muted); font-size: 12px; padding: 10px;";
        container.appendChild(empty);
        return;
      }

      for (const domain of currentWhitelist) {
        const tag = el("span", "domain-tag");
        tag.appendChild(el("span", null, domain));
        const remove = el("button", "domain-remove-btn", "\\u2715");
        remove.title = "Remove " + domain;
        remove.dataset.domain = domain;
        remove.addEventListener("click", () => changeWhitelist("remove", domain));
        tag.appendChild(remove);
        container.appendChild(tag);
      }
    }

    async function changeWhitelist(action, domain) {
      if (!domain) return;
      try {
        const data = await postJson("/api/whitelist", { action, domain });
        if (data.whitelist) currentWhitelist = data.whitelist;
        setMessage("whitelist-error", "", "ok");
        renderWhitelistTags();
      } catch (err) {
        setMessage("whitelist-error", err.message);
      }
    }

    async function openWhitelistModal() {
      try {
        const data = await api("/api/whitelist");
        if (data.whitelist) currentWhitelist = data.whitelist;
      } catch (err) {
        setMessage("whitelist-error", err.message);
      }
      renderWhitelistTags();
      openModal("whitelist-modal");
    }

    // ------------------------------------------------------ workstation grid

    function createCardElement(id) {
      const card = el("div", "kiosk-card");
      card.id = "card-" + id;

      const header = el("div", "card-header");
      const idWrap = el("div", "card-id-wrapper");
      const dot = el("div", "stat-dot red");
      dot.dataset.role = "dot";
      idWrap.append(dot, el("span", null, id));

      const badges = el("div", "card-badges");
      const lockBadge = el("span", "badge badge-locked", "Locked");
      lockBadge.dataset.role = "lock-badge";
      lockBadge.style.display = "none";
      const removeBtn = el("button", "card-remove-btn", "\\u2715");
      removeBtn.title = "Remove " + id + " from collection";
      removeBtn.addEventListener("click", () => removeClient(id));
      badges.append(lockBadge, removeBtn);
      header.append(idWrap, badges);

      const thumbBox = el("div", "card-thumbnail-box");
      const thumb = document.createElement("img");
      thumb.className = "card-thumbnail";
      thumb.dataset.role = "thumb";
      thumb.alt = "Live screen of " + id;
      thumb.style.display = "none";

      const placeholder = el("div", "offline-placeholder");
      placeholder.dataset.role = "placeholder";
      placeholder.append(
        svg('<circle cx="12" cy="12" r="10"></circle><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"></line>', "32"),
        el("span", null, "Standby / Offline")
      );

      const actions = el("div", "card-hover-actions");
      const vncBtn = el("button", "action-mini-btn", "Remote Control");
      vncBtn.addEventListener("click", () => openVncSession(id));
      const lockBtn = el("button", "action-mini-btn", "Lock Screen");
      lockBtn.addEventListener("click", () => sendClientCommand(id, "lock"));
      const unlockBtn = el("button", "action-mini-btn", "Unlock");
      unlockBtn.addEventListener("click", () => sendClientCommand(id, "unlock"));
      const reloadBtn = el("button", "action-mini-btn", "Reload");
      reloadBtn.addEventListener("click", () => sendClientCommand(id, "reload"));
      actions.append(vncBtn, lockBtn, unlockBtn, reloadBtn);

      thumbBox.append(thumb, placeholder, actions);

      const footer = el("div", "card-footer");
      const urlText = el("span", "active-domain", "Ready");
      urlText.dataset.role = "url";
      const ipText = el("span", null, "--");
      ipText.dataset.role = "ip";
      ipText.style.cssText = "font-family: 'JetBrains Mono', monospace; font-size: 11px;";
      footer.append(urlText, ipText);

      card.append(header, thumbBox, footer);
      return card;
    }

    function renderEmptyState(grid) {
      grid.replaceChildren();
      const empty = el("div", "empty-lab-state");
      empty.append(
        svg('<rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line>', "48")
      );
      const title = el("div", null, "No Thin Clients Connected Yet");
      title.style.cssText = "font-size: 16px; font-weight: 600; color: var(--text-main);";
      const hint = el(
        "div",
        null,
        "Workstations appear here as soon as they are enrolled with this school's enrollment key and send their first heartbeat."
      );
      hint.style.cssText = "font-size: 13px; color: var(--text-muted); max-width: 440px; line-height: 1.5;";
      empty.append(title, hint);
      grid.appendChild(empty);
    }

    function updateCard(card, id, client) {
      const dot = card.querySelector('[data-role="dot"]');
      const thumb = card.querySelector('[data-role="thumb"]');
      const placeholder = card.querySelector('[data-role="placeholder"]');
      const lockBadge = card.querySelector('[data-role="lock-badge"]');
      const urlText = card.querySelector('[data-role="url"]');
      const ipText = card.querySelector('[data-role="ip"]');

      if (client && client.online) {
        dot.className = "stat-dot green";
        // Only data: thumbnails are rendered; the worker rejects anything else.
        if (client.thumbnail && client.thumbnail.startsWith("data:image/")) {
          thumb.src = client.thumbnail;
          thumb.style.display = "block";
          placeholder.style.display = "none";
        } else {
          thumb.removeAttribute("src");
          thumb.style.display = "none";
          placeholder.style.display = "flex";
        }

        card.classList.toggle("locked", !!client.isLocked);
        lockBadge.style.display = client.isLocked ? "inline-block" : "none";

        let label = client.activeUrl || "Ready";
        try {
          label = new URL(client.activeUrl).hostname;
        } catch (err) {
          /* a non-URL active page is shown verbatim */
        }
        urlText.textContent = label;
      } else {
        dot.className = "stat-dot red";
        thumb.removeAttribute("src");
        thumb.style.display = "none";
        placeholder.style.display = "flex";
        card.classList.remove("locked");
        lockBadge.style.display = "none";
        urlText.textContent = "Standby / Offline";
      }

      ipText.textContent = (client && client.ip) || "--";
    }

    async function fetchTelemetry() {
      let data;
      try {
        data = await api("/api/clients");
      } catch (err) {
        console.warn("Telemetry poll error:", err.message);
        return;
      }

      clientsData = data.clients || {};
      const grid = document.getElementById("kiosk-grid");
      const clientIds = Object.keys(clientsData).sort();

      if (!clientIds.length) {
        renderEmptyState(grid);
        document.getElementById("stat-online-count").textContent = "0";
        document.getElementById("stat-total-count").textContent = "0";
        document.getElementById("stat-locked-count").textContent = "0";
        document.getElementById("stat-active-title").textContent = "0 Connected";
        return;
      }

      const emptyEl = grid.querySelector(".empty-lab-state");
      if (emptyEl) emptyEl.remove();

      for (const card of Array.from(grid.querySelectorAll(".kiosk-card"))) {
        if (!clientsData[card.id.replace("card-", "")]) card.remove();
      }

      let onlineCount = 0;
      let lockedCount = 0;

      for (const id of clientIds) {
        let card = document.getElementById("card-" + id);
        if (!card) {
          card = createCardElement(id);
          grid.appendChild(card);
        }
        const client = clientsData[id];
        if (client && client.online) onlineCount++;
        if (client && client.online && client.isLocked) lockedCount++;
        updateCard(card, id, client);
      }

      document.getElementById("stat-online-count").textContent = onlineCount;
      document.getElementById("stat-total-count").textContent = clientIds.length;
      document.getElementById("stat-locked-count").textContent = lockedCount;
      document.getElementById("stat-active-title").textContent = onlineCount + "/" + clientIds.length + " Online";
    }

    async function removeClient(clientId) {
      if (!confirm("Remove " + clientId + " from the dashboard? The workstation must be enrolled again to reconnect.")) {
        return;
      }
      try {
        await postJson("/api/clients/remove", { clientId });
        const card = document.getElementById("card-" + clientId);
        if (card) card.remove();
        delete clientsData[clientId];
        fetchTelemetry();
      } catch (err) {
        alert(err.message);
      }
    }

    // ------------------------------------------------------------- commands

    async function broadcastAction(action) {
      if (!confirm("Are you sure you want to " + action.toUpperCase() + " all lab computers?")) return;
      try {
        await postJson("/api/command", { target: "all", action });
        fetchTelemetry();
      } catch (err) {
        alert(err.message);
      }
    }

    async function sendClientCommand(clientId, action) {
      try {
        await postJson("/api/command", { target: clientId, action });
        fetchTelemetry();
      } catch (err) {
        alert(err.message);
      }
    }

    async function submitBroadcastUrl() {
      const url = document.getElementById("target-url-input").value.trim();
      if (!url) return;
      try {
        await postJson("/api/command", { target: "all", action: "navigate", url });
        closeModal("url-modal");
        setMessage("broadcast-error", "");
        fetchTelemetry();
      } catch (err) {
        setMessage("broadcast-error", err.message);
      }
    }

    async function resetBroadcastToPortal() {
      try {
        const portalUrl = window.location.origin + "/";
        await postJson("/api/command", { target: "all", action: "navigate", url: portalUrl, resetPortal: true });
        closeModal("url-modal");
        setMessage("broadcast-error", "");
        fetchTelemetry();
      } catch (err) {
        setMessage("broadcast-error", err.message);
      }
    }

    function renderBroadcastShortcuts() {
      const container = document.getElementById("broadcast-quick-links");
      if (!container) return;
      container.replaceChildren();

      let count = 0;

      // 1. Shortcuts from approved portal applications
      if (portalSites && portalSites.length) {
        const portalLabel = el("div", null, "From Approved Portal Apps:");
        portalLabel.style.cssText = "width: 100%; font-size: 11px; font-weight: 700; color: var(--text-muted); margin: 6px 0 2px;";
        container.appendChild(portalLabel);

        for (const site of portalSites) {
          const btn = el("button", "quick-chip", (site.icon || "🌐") + " " + site.title);
          btn.type = "button";
          btn.dataset.url = site.url;
          btn.title = site.url;
          container.appendChild(btn);
          count++;
        }
      }

      // 2. Custom broadcast presets
      if (broadcastPresets && broadcastPresets.length) {
        const customLabel = el("div", null, "Custom Shortcuts:");
        customLabel.style.cssText = "width: 100%; font-size: 11px; font-weight: 700; color: #93c5fd; margin: 8px 0 2px;";
        container.appendChild(customLabel);

        for (const preset of broadcastPresets) {
          const wrapper = el("span", "custom-preset-chip");
          wrapper.style.cssText = "display: inline-flex; align-items: center; background: var(--bg-card); border: 1px solid #3b82f6; border-radius: 6px; padding: 2px 6px; font-size: 12px; gap: 4px;";

          const btn = el("button", null, preset.title);
          btn.type = "button";
          btn.style.cssText = "background: none; border: none; color: #93c5fd; cursor: pointer; font-weight: 600; font-size: 12px; padding: 2px 4px;";
          btn.dataset.url = preset.url;
          btn.title = preset.url;

          const removeBtn = el("button", null, "✕");
          removeBtn.type = "button";
          removeBtn.style.cssText = "background: none; border: none; color: var(--text-muted); cursor: pointer; font-size: 11px; padding: 0 2px;";
          removeBtn.title = "Delete shortcut: " + preset.title;
          removeBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            deletePresetAction(preset.id);
          });

          wrapper.append(btn, removeBtn);
          container.appendChild(wrapper);
          count++;
        }
      }

      if (!count) {
        const empty = el("span", null, "No shortcuts configured yet. Click '+ Add New Shortcut' above or add applications to your Portal.");
        empty.style.cssText = "font-size: 12px; color: var(--text-muted); font-style: italic; padding: 6px 0;";
        container.appendChild(empty);
      }
    }

    async function addPresetAction() {
      const titleInput = document.getElementById("new-preset-title");
      const urlInput = document.getElementById("new-preset-url");
      const title = titleInput.value.trim();
      const url = urlInput.value.trim();
      if (!title || !url) {
        setMessage("add-preset-error", "Please provide both a shortcut name and URL.");
        return;
      }
      try {
        const res = await postJson("/api/broadcast-presets", { title, url });
        if (res.preset) {
          broadcastPresets.push(res.preset);
          titleInput.value = "";
          urlInput.value = "";
          document.getElementById("add-shortcut-form").style.display = "none";
          setMessage("add-preset-error", "");
          renderBroadcastShortcuts();
        }
      } catch (err) {
        setMessage("add-preset-error", err.message);
      }
    }

    async function deletePresetAction(id) {
      try {
        await api("/api/broadcast-presets/" + encodeURIComponent(id), { method: "DELETE" });
        broadcastPresets = broadcastPresets.filter((p) => p.id !== id);
        renderBroadcastShortcuts();
      } catch (err) {
        alert("Failed to delete shortcut: " + err.message);
      }
    }

    // --------------------------------------------------------- remote control

    function openVncSession(clientId) {
      document.getElementById("vnc-modal-title").textContent = "Live Remote Control: " + clientId;
      const client = clientsData[clientId] || {};
      const host = window.location.hostname;
      // Prefer the tunnel hostname the workstation itself reported; fall back to
      // the <pc>.<TUNNEL_DOMAIN> convention, or the simulator's published port.
      let base;
      if (client.remoteHost) {
        base = "https://" + client.remoteHost;
      } else if (host === "localhost" || host === "127.0.0.1") {
        base = "http://" + host + ":6080";
      } else {
        base = "https://" + encodeURIComponent(clientId.toLowerCase()) + "." + TUNNEL_DOMAIN;
      }
      const params = new URLSearchParams({ autoconnect: "true", resize: "scale" });
      if (client.vncPassword) params.set("password", client.vncPassword);
      document.getElementById("vnc-frame").src = base + "/vnc.html?" + params.toString();
      openModal("vnc-modal");
    }

    function closeVncModal() {
      closeModal("vnc-modal");
      document.getElementById("vnc-frame").src = "about:blank";
    }

    // ----------------------------------------------------------- portal apps

    function renderPortalSitesList() {
      const list = document.getElementById("portal-apps-list");
      list.replaceChildren();

      if (!portalSites.length) {
        const empty = el("span", null, "No apps configured. Add one below.");
        empty.style.cssText = "font-size: 13px; color: var(--text-muted); padding: 12px; text-align: center;";
        list.appendChild(empty);
        return;
      }

      for (const site of portalSites) {
        const row = el("div");
        row.style.cssText =
          "display: flex; align-items: center; justify-content: space-between; gap: 10px; background: #1f2937; border: 1px solid var(--border); border-radius: 6px; padding: 8px 12px;";

        const left = el("div");
        left.style.cssText = "display: flex; align-items: center; gap: 10px; min-width: 0;";
        const icon = el("span", null, site.icon || "\\u{1F310}");
        icon.style.fontSize = "18px";

        const meta = el("div");
        meta.style.minWidth = "0";
        const title = el("div", null, site.title);
        title.style.cssText = "font-size: 13px; font-weight: 700;";
        const urlLine = el("div", null, site.url);
        urlLine.style.cssText =
          "font-size: 11px; color: var(--text-muted); font-family: 'JetBrains Mono', monospace; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;";
        meta.append(title, urlLine);
        left.append(icon, meta);

        const remove = el("button", "domain-remove-btn", "\\u2715");
        remove.title = "Remove " + site.title;
        remove.addEventListener("click", () => deletePortalApp(site.id));

        row.append(left, remove);
        list.appendChild(row);
      }
    }

    async function addPortalApp() {
      const title = document.getElementById("new-app-title").value.trim();
      const url = document.getElementById("new-app-url").value.trim();
      const category = document.getElementById("new-app-category").value.trim() || "General";
      const icon = document.getElementById("new-app-icon").value.trim();

      if (!title || !url) {
        setMessage("portal-error", "Please enter both a title and a URL.");
        return;
      }

      try {
        const data = await postJson("/api/portal-sites", { title, url, category, icon: icon || undefined });
        if (data.site) {
          portalSites.push(data.site);
          renderPortalSitesList();
          document.getElementById("new-app-title").value = "";
          document.getElementById("new-app-url").value = "";
          document.getElementById("new-app-category").value = "";
          document.getElementById("new-app-icon").value = "";
          setMessage("portal-error", "");
        }
      } catch (err) {
        setMessage("portal-error", err.message);
      }
    }

    async function deletePortalApp(id) {
      if (!confirm("Remove this app from the student learning portal?")) return;
      try {
        await api("/api/portal-sites/" + encodeURIComponent(id), { method: "DELETE" });
        portalSites = portalSites.filter((s) => s.id !== id);
        renderPortalSitesList();
      } catch (err) {
        setMessage("portal-error", err.message);
      }
    }

    async function updateKioskMode(mode) {
      const panel = document.getElementById("single-url-panel");
      if (panel) {
        panel.style.display = mode === "single_url" ? "block" : "none";
      }
      const settingWrap = document.getElementById("setting-single-url-wrap");
      if (settingWrap) {
        settingWrap.style.display = mode === "single_url" ? "block" : "none";
      }
      const settingMode = document.getElementById("setting-kiosk-mode");
      if (settingMode) settingMode.value = mode;

      try {
        const urlInput = document.getElementById("single-url-input");
        const defaultUrl = (mode === "single_url" && urlInput) ? urlInput.value.trim() : undefined;
        const res = await postJson("/api/settings/mode", { mode, defaultUrl: defaultUrl || undefined });
        currentTenantData.mode = mode;
        if (res.defaultUrl) {
          currentTenantData.defaultUrl = res.defaultUrl;
          if (urlInput) urlInput.value = res.defaultUrl;
          const settingUrl = document.getElementById("setting-default-url");
          if (settingUrl) settingUrl.value = res.defaultUrl;
        }
        const msg = "Homepage mode set to " + (mode === "single_url" ? "Single-Site Lockdown" : "App Launcher Grid") + ".";
        if (mode === "single_url") {
          setMessage("single-url-msg", msg, "ok");
          if (urlInput && !urlInput.value) urlInput.focus();
        } else {
          setMessage("portal-error", msg, "ok");
        }
      } catch (err) {
        setMessage("single-url-msg", err.message);
        setMessage("portal-error", err.message);
      }
    }

    async function saveSingleUrlAction() {
      const input = document.getElementById("single-url-input");
      const url = input.value.trim();
      if (!url) {
        setMessage("single-url-msg", "Please enter a valid website URL.");
        return;
      }
      try {
        const res = await postJson("/api/settings/mode", { mode: "single_url", defaultUrl: url });
        currentTenantData.defaultUrl = res.defaultUrl || url;
        currentTenantData.mode = "single_url";
        if (res.defaultUrl) input.value = res.defaultUrl;
        const settingUrl = document.getElementById("setting-default-url");
        if (settingUrl) settingUrl.value = currentTenantData.defaultUrl;
        const settingMode = document.getElementById("setting-kiosk-mode");
        if (settingMode) settingMode.value = "single_url";
        const settingWrap = document.getElementById("setting-single-url-wrap");
        if (settingWrap) settingWrap.style.display = "block";
        const broadcastInput = document.getElementById("target-url-input");
        if (broadcastInput && !broadcastInput.value) broadcastInput.value = currentTenantData.defaultUrl;
        setMessage("single-url-msg", "Target website saved! Workstations will lock directly to this URL.", "ok");
      } catch (err) {
        setMessage("single-url-msg", err.message);
      }
    }

    async function saveSettingModeAction() {
      const modeSelect = document.getElementById("setting-kiosk-mode");
      const urlInput = document.getElementById("setting-default-url");
      const mode = modeSelect ? modeSelect.value : "portal";
      const url = urlInput ? urlInput.value.trim() : "";

      if (mode === "single_url" && !url) {
        setMessage("setting-mode-status-msg", "Please enter a valid target URL for Single-Site Lockdown.");
        if (urlInput) urlInput.focus();
        return;
      }

      try {
        const res = await postJson("/api/settings/mode", { mode, defaultUrl: url || undefined });
        currentTenantData.mode = mode;
        if (res.defaultUrl) {
          currentTenantData.defaultUrl = res.defaultUrl;
          if (urlInput) urlInput.value = res.defaultUrl;
          const portalUrlInput = document.getElementById("single-url-input");
          if (portalUrlInput) portalUrlInput.value = res.defaultUrl;
        }
        const portalModeSelect = document.getElementById("kiosk-mode-select");
        if (portalModeSelect) portalModeSelect.value = mode;
        const portalPanel = document.getElementById("single-url-panel");
        if (portalPanel) portalPanel.style.display = mode === "single_url" ? "block" : "none";

        const broadcastInput = document.getElementById("target-url-input");
        if (broadcastInput && !broadcastInput.value && currentTenantData.defaultUrl) {
          broadcastInput.value = currentTenantData.defaultUrl;
        }

        setMessage("setting-mode-status-msg", "Homepage experience and target URL saved.", "ok");
      } catch (err) {
        setMessage("setting-mode-status-msg", err.message);
      }
    }

    async function saveLabNameAction() {
      const input = document.getElementById("setting-lab-name");
      const name = input.value.trim();
      if (!name) {
        setMessage("lab-name-status-msg", "Lab name cannot be empty.");
        return;
      }
      try {
        await postJson("/api/settings/customization", { name });
        setMessage("lab-name-status-msg", "Lab name updated.", "ok");
        const brandTitle = document.querySelector(".brand-title");
        if (brandTitle) brandTitle.textContent = name;
      } catch (err) {
        setMessage("lab-name-status-msg", err.message);
      }
    }

    async function saveLockMessageAction() {
      const input = document.getElementById("setting-lock-message");
      const defaultLockMessage = input.value.trim();
      if (!defaultLockMessage) {
        setMessage("lock-msg-status", "Announcement message cannot be empty.");
        return;
      }
      try {
        await postJson("/api/settings/customization", { defaultLockMessage });
        currentTenantData.defaultLockMessage = defaultLockMessage;
        setMessage("lock-msg-status", "Default lock announcement saved.", "ok");
      } catch (err) {
        setMessage("lock-msg-status", err.message);
      }
    }

    async function saveBrandingAction() {
      const portalTitle = document.getElementById("setting-portal-title").value.trim();
      const portalSubtitle = document.getElementById("setting-portal-subtitle").value.trim();
      const portalDescription = document.getElementById("setting-portal-desc").value.trim();
      const portalFooter = document.getElementById("setting-portal-footer").value.trim();

      try {
        await postJson("/api/settings/customization", {
          portalTitle,
          portalSubtitle,
          portalDescription,
          portalFooter
        });
        setMessage("branding-status-msg", "Portal branding updated successfully.", "ok");
      } catch (err) {
        setMessage("branding-status-msg", err.message);
      }
    }

    function openLockModal() {
      const input = document.getElementById("lock-message-input");
      if (input) input.value = currentTenantData.defaultLockMessage || "Screens locked by the instructor. Please look to the front.";
      openModal("lock-modal");
    }

    async function executeLockAll() {
      const input = document.getElementById("lock-message-input");
      const message = (input ? input.value.trim() : "") || currentTenantData.defaultLockMessage;
      try {
        await postJson("/api/command", { target: "all", action: "lock", message });
        closeModal("lock-modal");
        fetchTelemetry();
      } catch (err) {
        alert("Failed to freeze screens: " + err.message);
      }
    }

    // -------------------------------------------------------------- settings

    async function loadEnrollmentKey() {
      const node = document.getElementById("enrollment-key-value");
      try {
        const data = await api("/api/settings/enrollment-key");
        if (data.enrollmentKey) {
          node.textContent = data.enrollmentKey;
        } else {
          node.textContent = "No key issued yet";
          setMessage(
            "enrollment-status-msg",
            "This school has no enrollment key yet. Choose “Rotate Key” to issue one before setting up workstations.",
            "info"
          );
        }
      } catch (err) {
        node.textContent = "Unavailable";
        setMessage("enrollment-status-msg", err.message);
      }
    }

    async function rotateEnrollmentKey() {
      if (!confirm("Issue a new enrollment key? Workstations already enrolled keep working, but the old key stops working for new ones.")) {
        return;
      }
      try {
        const data = await postJson("/api/settings/enrollment-key", {});
        document.getElementById("enrollment-key-value").textContent = data.enrollmentKey;
        setMessage("enrollment-status-msg", "A new enrollment key has been issued.", "ok");
      } catch (err) {
        setMessage("enrollment-status-msg", err.message);
      }
    }

    async function copyEnrollmentKey() {
      const value = document.getElementById("enrollment-key-value").textContent;
      try {
        await navigator.clipboard.writeText(value);
        setMessage("enrollment-status-msg", "Enrollment key copied to the clipboard.", "ok");
      } catch (err) {
        setMessage("enrollment-status-msg", "Select the key above and copy it manually.", "info");
      }
    }

    async function changePasswordAction() {
      const currentInput = document.getElementById("setting-current-password");
      const newInput = document.getElementById("setting-new-password");
      const currentPassword = currentInput.value;
      const newPassword = newInput.value;
      if (!currentPassword || !newPassword) {
        setMessage("password-status-msg", "Enter your current password and a new one.");
        return;
      }
      try {
        await postJson("/api/auth/change-password", { currentPassword, newPassword });
        currentInput.value = "";
        newInput.value = "";
        setMessage("password-status-msg", "Password changed. Other signed-in browsers have been signed out.", "ok");
      } catch (err) {
        setMessage("password-status-msg", err.message);
      }
    }

    async function requestSubdomainChange() {
      const sub = document.getElementById("setting-new-subdomain").value.trim().toLowerCase();
      if (!sub) return;
      try {
        const data = await postJson("/api/settings/subdomain", { requestedSubdomain: sub });
        setMessage("subdomain-status-msg", "Request for '" + data.requestedSubdomain + "' submitted for approval.", "ok");
      } catch (err) {
        setMessage("subdomain-status-msg", err.message);
      }
    }

    async function requestCustomDomainChange() {
      const input = document.getElementById("setting-custom-domain");
      if (!input) return;
      const domain = input.value.trim().toLowerCase();
      if (!domain) return;
      try {
        const data = await postJson("/api/settings/custom-domain", { domain });
        setMessage("custom-domain-status-msg", "Custom domain '" + data.requestedCustomDomain + "' submitted for superadmin approval.", "ok");
        setTimeout(() => window.location.reload(), 1200);
      } catch (err) {
        setMessage("custom-domain-status-msg", err.message);
      }
    }

    async function removeCustomDomainAction() {
      if (!confirm("Disconnect custom domain from this school?")) return;
      try {
        await api("/api/settings/custom-domain", { method: "DELETE" });
        setMessage("custom-domain-status-msg", "Custom domain removed.", "ok");
        setTimeout(() => window.location.reload(), 800);
      } catch (err) {
        setMessage("custom-domain-status-msg", err.message);
      }
    }

    // ------------------------------------------------------------- wiring up

    document.getElementById("btn-lock-all").addEventListener("click", openLockModal);
    document.getElementById("btn-cancel-lock").addEventListener("click", () => closeModal("lock-modal"));
    document.getElementById("btn-confirm-lock").addEventListener("click", executeLockAll);
    const lockPresets = document.getElementById("lock-presets");
    if (lockPresets) {
      lockPresets.addEventListener("click", (e) => {
        const chip = e.target.closest("[data-msg]");
        if (chip) {
          const input = document.getElementById("lock-message-input");
          if (input) input.value = chip.dataset.msg;
        }
      });
    }

    document.getElementById("btn-unlock-all").addEventListener("click", () => broadcastAction("unlock"));

    document.getElementById("btn-open-portal").addEventListener("click", () => {
      renderPortalSitesList();
      setMessage("portal-error", "");
      setMessage("single-url-msg", "");
      const modeSelect = document.getElementById("kiosk-mode-select");
      if (modeSelect) modeSelect.value = currentTenantData.mode;
      const urlInput = document.getElementById("single-url-input");
      if (urlInput) urlInput.value = currentTenantData.defaultUrl || "";
      const panel = document.getElementById("single-url-panel");
      if (panel) panel.style.display = currentTenantData.mode === "single_url" ? "block" : "none";
      openModal("portal-modal");
    });
    document.getElementById("btn-close-portal").addEventListener("click", () => closeModal("portal-modal"));
    document.getElementById("btn-add-app").addEventListener("click", addPortalApp);
    document.getElementById("kiosk-mode-select").addEventListener("change", (e) => updateKioskMode(e.target.value));
    const btnSaveSingleUrl = document.getElementById("btn-save-single-url");
    if (btnSaveSingleUrl) btnSaveSingleUrl.addEventListener("click", saveSingleUrlAction);
    const singleUrlInput = document.getElementById("single-url-input");
    if (singleUrlInput) {
      singleUrlInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") saveSingleUrlAction();
      });
    }

    document.getElementById("btn-open-whitelist").addEventListener("click", openWhitelistModal);
    document.getElementById("btn-close-whitelist").addEventListener("click", () => closeModal("whitelist-modal"));
    document.getElementById("btn-add-domain").addEventListener("click", () => {
      const input = document.getElementById("new-domain-input");
      changeWhitelist("add", input.value.trim()).then(() => {
        input.value = "";
      });
    });
    document.getElementById("new-domain-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") document.getElementById("btn-add-domain").click();
    });
    document.getElementById("whitelist-presets").addEventListener("click", (e) => {
      const chip = e.target.closest("[data-domain]");
      if (chip) changeWhitelist("add", chip.dataset.domain);
    });

    document.getElementById("btn-open-broadcast").addEventListener("click", () => {
      setMessage("broadcast-error", "");
      const targetInput = document.getElementById("target-url-input");
      if (targetInput && !targetInput.value && currentTenantData.defaultUrl) {
        targetInput.value = currentTenantData.defaultUrl;
      }
      const resetBtn = document.getElementById("btn-reset-broadcast");
      if (resetBtn) {
        resetBtn.textContent = currentTenantData.mode === "single_url" ? "Reset to Single-Site Lockdown" : "Reset to School Portal";
        resetBtn.title = currentTenantData.mode === "single_url" ? "Return all workstations to the single-site lockdown target" : "Return all workstations to the school learning portal";
      }
      renderBroadcastShortcuts();
      openModal("url-modal");
    });
    document.getElementById("btn-cancel-broadcast").addEventListener("click", () => closeModal("url-modal"));
    document.getElementById("btn-send-broadcast").addEventListener("click", submitBroadcastUrl);
    document.getElementById("btn-reset-broadcast").addEventListener("click", resetBroadcastToPortal);
    document.getElementById("broadcast-quick-links").addEventListener("click", (e) => {
      const chip = e.target.closest("[data-url]");
      if (chip) document.getElementById("target-url-input").value = chip.dataset.url;
    });
    const btnToggleShortcut = document.getElementById("btn-toggle-add-shortcut");
    if (btnToggleShortcut) {
      btnToggleShortcut.addEventListener("click", () => {
        const form = document.getElementById("add-shortcut-form");
        if (form) {
          form.style.display = form.style.display === "none" ? "block" : "none";
        }
      });
    }
    const btnSavePreset = document.getElementById("btn-save-preset");
    if (btnSavePreset) btnSavePreset.addEventListener("click", addPresetAction);
    const newPresetTitle = document.getElementById("new-preset-title");
    const newPresetUrl = document.getElementById("new-preset-url");
    if (newPresetTitle) {
      newPresetTitle.addEventListener("keydown", (e) => {
        if (e.key === "Enter") addPresetAction();
      });
    }
    if (newPresetUrl) {
      newPresetUrl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") addPresetAction();
      });
    }

    document.getElementById("btn-open-settings").addEventListener("click", () => {
      setMessage("subdomain-status-msg", "");
      setMessage("enrollment-status-msg", "");
      setMessage("lab-name-status-msg", "");
      setMessage("lock-msg-status", "");
      setMessage("branding-status-msg", "");
      setMessage("setting-mode-status-msg", "");
      setMessage("password-status-msg", "");
      const modeSelect = document.getElementById("setting-kiosk-mode");
      if (modeSelect) modeSelect.value = currentTenantData.mode;
      const urlInput = document.getElementById("setting-default-url");
      if (urlInput) urlInput.value = currentTenantData.defaultUrl || "";
      const wrap = document.getElementById("setting-single-url-wrap");
      if (wrap) wrap.style.display = currentTenantData.mode === "single_url" ? "block" : "none";
      openModal("settings-modal");
      loadEnrollmentKey();
    });
    document.getElementById("btn-close-settings").addEventListener("click", () => closeModal("settings-modal"));
    const settingKioskMode = document.getElementById("setting-kiosk-mode");
    if (settingKioskMode) {
      settingKioskMode.addEventListener("change", (e) => {
        const wrap = document.getElementById("setting-single-url-wrap");
        if (wrap) wrap.style.display = e.target.value === "single_url" ? "block" : "none";
        if (e.target.value === "single_url") {
          const input = document.getElementById("setting-default-url");
          if (input && !input.value) input.focus();
        }
      });
    }
    const btnSaveSettingMode = document.getElementById("btn-save-setting-mode");
    if (btnSaveSettingMode) btnSaveSettingMode.addEventListener("click", saveSettingModeAction);
    const settingDefaultUrl = document.getElementById("setting-default-url");
    if (settingDefaultUrl) {
      settingDefaultUrl.addEventListener("keydown", (e) => {
        if (e.key === "Enter") saveSettingModeAction();
      });
    }
    const btnSaveLabName = document.getElementById("btn-save-lab-name");
    if (btnSaveLabName) btnSaveLabName.addEventListener("click", saveLabNameAction);
    const btnSaveLockMsg = document.getElementById("btn-save-lock-message");
    if (btnSaveLockMsg) btnSaveLockMsg.addEventListener("click", saveLockMessageAction);
    const btnSaveBranding = document.getElementById("btn-save-branding");
    if (btnSaveBranding) btnSaveBranding.addEventListener("click", saveBrandingAction);
    document.getElementById("btn-request-subdomain").addEventListener("click", requestSubdomainChange);
    document.getElementById("btn-change-password").addEventListener("click", changePasswordAction);
    document.getElementById("btn-copy-key").addEventListener("click", copyEnrollmentKey);
    document.getElementById("btn-rotate-key").addEventListener("click", rotateEnrollmentKey);

    const btnReqCustom = document.getElementById("btn-request-custom-domain");
    if (btnReqCustom) btnReqCustom.addEventListener("click", requestCustomDomainChange);

    const btnRemCustom = document.getElementById("btn-remove-custom-domain");
    if (btnRemCustom) btnRemCustom.addEventListener("click", removeCustomDomainAction);

    const btnCancelCustom = document.getElementById("btn-cancel-custom-domain");
    if (btnCancelCustom) btnCancelCustom.addEventListener("click", removeCustomDomainAction);

    document.getElementById("btn-close-vnc").addEventListener("click", closeVncModal);

    // Dismiss any open modal with Escape, and by clicking the backdrop.
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      for (const overlay of document.querySelectorAll(".modal-overlay.active")) {
        if (overlay.id === "vnc-modal") closeVncModal();
        else overlay.classList.remove("active");
      }
    });
    for (const overlay of document.querySelectorAll(".modal-overlay")) {
      overlay.addEventListener("click", (e) => {
        if (e.target !== overlay) return;
        if (overlay.id === "vnc-modal") closeVncModal();
        else overlay.classList.remove("active");
      });
    }

    // Start Loops
    renderWhitelistTags();
    renderBroadcastShortcuts();
    fetchTelemetry();
    setInterval(fetchTelemetry, 3000);
  </script>
</body>
</html>`;
}
