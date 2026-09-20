/**
 * Modern Responsive Dashboard Shell & Left-Side Multi-Level Panels Layout
 * Provides Level 1 primary navigation rail (72px), Level 2 context action panel (268px),
 * seamless hardware-accelerated transitions, fluid content canvas, and 2026 design tokens.
 */

import { escapeHtml, escapeAttr } from "./escape";

export interface NavItem {
  id: string;
  label: string;
  href: string;
  iconSvg: string;
  badge?: string | number;
}

export interface StatItem {
  label: string;
  value: string | number;
  color?: "green" | "red" | "yellow" | "blue";
  id?: string;
}

export interface LayoutOptions {
  title: string;
  brandTitle: string;
  brandSubtitle: string;
  brandIconSvg?: string;
  navItems: NavItem[];
  activeNavId: string;
  subPanelTitle?: string;
  subPanelSubtitle?: string;
  subPanelHtml?: string;
  stats?: StatItem[];
  userMeta?: { name: string; email?: string; role: string };
  logoutAction?: string;
  contentHtml: string;
  modalsHtml?: string;
  scriptsHtml?: string;
  nonce: string;
}

export function renderLayoutHtml(options: LayoutOptions): string {
  const {
    title,
    brandTitle,
    brandSubtitle,
    brandIconSvg,
    navItems,
    activeNavId,
    subPanelTitle = "Module Actions",
    subPanelSubtitle = "Quick tools & filters",
    subPanelHtml = "",
    stats = [],
    userMeta,
    logoutAction = "/api/auth/logout",
    contentHtml,
    modalsHtml = "",
    scriptsHtml = "",
    nonce
  } = options;

  const defaultBrandIcon = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`;

  const activeItem = navItems.find((item) => item.id === activeNavId) || navItems[0];
  const activeNavLabel = activeItem ? activeItem.label : "Dashboard";

  // Level 1: Primary Vertical Rail items
  const railItemsHtml = navItems
    .map((item) => {
      const isActive = item.id === activeNavId;
      return `
        <a href="${escapeAttr(item.href)}" class="rail-item ${isActive ? "active" : ""}" data-nav="${escapeAttr(item.id)}" title="${escapeAttr(item.label)}">
          <span class="rail-icon">${item.iconSvg}</span>
          <span class="rail-tooltip">${escapeHtml(item.label)}</span>
          ${item.badge !== undefined ? `<span class="rail-badge">${escapeHtml(String(item.badge))}</span>` : ""}
        </a>
      `;
    })
    .join("");

  // Stats pills
  const statsHtml = stats
    .map((s) => {
      const colorClass = s.color ? `dot-${s.color}` : "dot-green";
      const idAttr = s.id ? ` id="${escapeAttr(s.id)}"` : "";
      return `
        <div class="stat-pill">
          <span class="stat-dot ${colorClass}"></span>
          <span class="stat-label">${escapeHtml(s.label)}:</span>
          <strong class="stat-val"${idAttr}>${escapeHtml(String(s.value))}</strong>
        </div>
      `;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg-base: #080c14;
      --bg-rail: #0c121e;
      --bg-panel: #111827;
      --bg-surface: #141d2d;
      --bg-card: #1a2538;
      --bg-card-hover: #223049;
      --border-subtle: rgba(255, 255, 255, 0.08);
      --border: #2d3748;
      --border-focus: #3b82f6;
      --text-main: #f8fafc;
      --text-muted: #94a3b8;
      --text-subtle: #64748b;
      --accent: #3b82f6;
      --accent-hover: #2563eb;
      --accent-glow: rgba(59, 130, 246, 0.28);
      --accent-gradient: linear-gradient(135deg, #3b82f6, #6366f1);
      --success: #10b981;
      --danger: #ef4444;
      --warning: #f59e0b;
      --radius: 12px;
      --radius-sm: 8px;
      --rail-width: 72px;
      --subpanel-width: 272px;
      --ease-spring: cubic-bezier(0.16, 1, 0.3, 1);
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Plus Jakarta Sans', -apple-system, BlinkMacSystemFont, sans-serif;
      background-color: var(--bg-base);
      color: var(--text-main);
      min-height: 100vh;
      overflow-x: hidden;
    }

    /* Outer App Layout with Left-Side Multi-Level Panels */
    .app-layout {
      display: flex;
      min-height: 100vh;
      width: 100%;
      position: relative;
    }

    /* ---------------------------------------------------------------------- */
    /* Level 1: Primary Navigation Rail (Slim 72px)                           */
    /* ---------------------------------------------------------------------- */
    .nav-rail {
      width: var(--rail-width);
      background-color: var(--bg-rail);
      border-right: 1px solid var(--border-subtle);
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      position: fixed;
      top: 0;
      bottom: 0;
      left: 0;
      z-index: 1020;
      padding: 14px 0;
      box-shadow: 2px 0 16px rgba(0, 0, 0, 0.3);
      transition: transform 0.28s var(--ease-spring);
    }

    .rail-top {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 12px;
    }

    .brand-glyph {
      display: flex;
      align-items: center;
      justify-content: center;
      text-decoration: none;
      margin-bottom: 6px;
    }

    .brand-icon {
      width: 44px;
      height: 44px;
      background: var(--accent-gradient);
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 0 16px var(--accent-glow);
      transition: transform 0.2s ease, box-shadow 0.2s ease;
    }
    .brand-icon:hover {
      transform: scale(1.05);
      box-shadow: 0 0 22px var(--accent-glow);
    }

    .rail-divider {
      width: 36px;
      height: 1px;
      background: var(--border-subtle);
      margin: 4px 0;
    }

    .rail-nav {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 8px;
      width: 100%;
      padding: 0 8px;
    }

    .rail-item {
      width: 48px;
      height: 48px;
      border-radius: 12px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--text-muted);
      text-decoration: none;
      position: relative;
      transition: all 0.2s ease;
    }
    .rail-item:hover {
      color: var(--text-main);
      background: rgba(255, 255, 255, 0.05);
    }
    .rail-item.active {
      color: #fff;
      background: var(--accent);
      box-shadow: 0 0 16px var(--accent-glow);
    }
    .rail-item.active::before {
      content: '';
      position: absolute;
      left: -8px;
      top: 12px;
      bottom: 12px;
      width: 4px;
      background: #fff;
      border-radius: 0 4px 4px 0;
    }

    .rail-icon { display: flex; align-items: center; justify-content: center; }

    /* Tooltip on hover */
    .rail-tooltip {
      position: absolute;
      left: calc(var(--rail-width) + 8px);
      background: var(--bg-surface);
      color: var(--text-main);
      padding: 6px 12px;
      border-radius: 6px;
      font-size: 12px;
      font-weight: 600;
      white-space: nowrap;
      pointer-events: none;
      opacity: 0;
      transform: translateX(-6px);
      transition: opacity 0.15s ease, transform 0.15s ease;
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.5);
      border: 1px solid var(--border);
      z-index: 1050;
    }
    .rail-item:hover .rail-tooltip {
      opacity: 1;
      transform: translateX(0);
    }

    .rail-badge {
      position: absolute;
      top: 4px;
      right: 4px;
      background: var(--danger);
      color: #fff;
      font-size: 10px;
      font-weight: 700;
      min-width: 16px;
      height: 16px;
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 0 4px;
    }

    .rail-bottom {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 12px;
      width: 100%;
      padding: 0 8px;
    }

    .rail-action-btn {
      width: 44px;
      height: 44px;
      border-radius: 12px;
      background: transparent;
      border: 1px solid var(--border-subtle);
      color: var(--text-muted);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s ease;
    }
    .rail-action-btn:hover {
      color: var(--text-main);
      background: rgba(255, 255, 255, 0.05);
      border-color: var(--border);
    }
    .rail-action-btn svg {
      transition: transform 0.28s var(--ease-spring);
    }
    .app-layout.subpanel-collapsed .rail-action-btn svg {
      transform: rotate(180deg);
    }

    .rail-user-avatar {
      width: 40px;
      height: 40px;
      border-radius: 50%;
      background: linear-gradient(135deg, #1e293b, #334155);
      border: 2px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-size: 14px;
      color: #93c5fd;
      cursor: default;
    }

    /* ---------------------------------------------------------------------- */
    /* Level 2: Secondary Context Action Panel (272px, animated & collapsible)*/
    /* ---------------------------------------------------------------------- */
    .sub-panel {
      width: var(--subpanel-width);
      background-color: var(--bg-panel);
      border-right: 1px solid var(--border-subtle);
      position: fixed;
      top: 0;
      bottom: 0;
      left: var(--rail-width);
      z-index: 1010;
      display: flex;
      flex-direction: column;
      transform: translateX(0);
      opacity: 1;
      transition: transform 0.28s var(--ease-spring), opacity 0.2s ease;
      backdrop-filter: blur(12px);
      box-shadow: 4px 0 20px rgba(0, 0, 0, 0.25);
    }

    .app-layout.subpanel-collapsed .sub-panel {
      transform: translateX(-100%);
      opacity: 0;
      pointer-events: none;
    }

    .sub-panel-header {
      padding: 20px 18px 16px;
      border-bottom: 1px solid var(--border-subtle);
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 10px;
    }

    .sub-panel-title-wrap { flex: 1; min-width: 0; }
    .sub-panel-title {
      font-size: 15px;
      font-weight: 700;
      color: var(--text-main);
      letter-spacing: -0.2px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .sub-panel-subtitle {
      font-size: 12px;
      color: var(--text-muted);
      margin-top: 2px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .sub-panel-close-btn {
      background: transparent;
      border: none;
      color: var(--text-muted);
      cursor: pointer;
      padding: 4px;
      border-radius: 6px;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: color 0.15s ease, background 0.15s ease;
    }
    .sub-panel-close-btn:hover {
      color: var(--text-main);
      background: rgba(255, 255, 255, 0.05);
    }

    .sub-panel-content {
      flex: 1;
      overflow-y: auto;
      padding: 16px 14px;
      display: flex;
      flex-direction: column;
      gap: 16px;
      scrollbar-width: thin;
      scrollbar-color: var(--border) transparent;
    }

    /* Sub-panel Section Elements */
    .sub-section-title {
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.6px;
      color: var(--text-subtle);
      margin-bottom: 8px;
      padding: 0 4px;
    }

    .sub-action-list {
      display: flex;
      flex-direction: column;
      gap: 6px;
    }

    .sub-action-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 8px 12px;
      border-radius: var(--radius-sm);
      color: var(--text-muted);
      text-decoration: none;
      font-size: 13px;
      font-weight: 500;
      background: transparent;
      border: 1px solid transparent;
      cursor: pointer;
      width: 100%;
      text-align: left;
      font-family: inherit;
      transition: all 0.15s ease;
    }
    .sub-action-item:hover {
      color: var(--text-main);
      background: rgba(255, 255, 255, 0.03);
      border-color: var(--border-subtle);
    }
    .sub-action-item.active {
      color: #93c5fd;
      background: rgba(59, 130, 246, 0.1);
      border-color: rgba(59, 130, 246, 0.25);
      font-weight: 600;
    }
    .sub-action-badge {
      font-size: 11px;
      padding: 2px 7px;
      border-radius: 10px;
      background: var(--bg-card);
      color: var(--text-muted);
      font-weight: 600;
    }

    /* ---------------------------------------------------------------------- */
    /* App Canvas (Fluid Content)                                             */
    /* ---------------------------------------------------------------------- */
    .app-canvas {
      flex: 1;
      margin-left: calc(var(--rail-width) + var(--subpanel-width));
      transition: margin-left 0.28s var(--ease-spring);
      min-width: 0;
      display: flex;
      flex-direction: column;
      background-color: var(--bg-base);
    }

    .app-layout.subpanel-collapsed .app-canvas {
      margin-left: var(--rail-width);
    }

    /* Top Utility Header */
    .canvas-header {
      background-color: var(--bg-surface);
      border-bottom: 1px solid var(--border-subtle);
      position: sticky;
      top: 0;
      z-index: 1000;
      padding: 12px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      flex-wrap: wrap;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.35);
    }

    .canvas-header-left {
      display: flex;
      align-items: center;
      gap: 14px;
    }

    .btn-mobile-menu {
      display: none;
      background: transparent;
      border: 1px solid var(--border-subtle);
      color: var(--text-main);
      padding: 6px;
      border-radius: 8px;
      cursor: pointer;
    }

    .canvas-breadcrumb {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 14px;
    }
    .breadcrumb-school { font-weight: 700; color: var(--text-main); }
    .breadcrumb-sep { color: var(--text-subtle); }
    .breadcrumb-page { color: var(--text-muted); font-weight: 500; }

    .canvas-header-center {
      display: flex;
      align-items: center;
      gap: 10px;
      flex-wrap: wrap;
    }

    .stat-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: var(--bg-base);
      padding: 5px 12px;
      border-radius: 20px;
      border: 1px solid var(--border-subtle);
      font-size: 12px;
    }
    .stat-dot { width: 7px; height: 7px; border-radius: 50%; }
    .dot-green { background: var(--success); box-shadow: 0 0 6px var(--success); }
    .dot-red { background: var(--danger); }
    .dot-yellow { background: var(--warning); }
    .dot-blue { background: var(--accent); }

    .canvas-header-right {
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .user-pill {
      display: flex;
      align-items: center;
      gap: 8px;
      background: rgba(59, 130, 246, 0.08);
      border: 1px solid rgba(59, 130, 246, 0.25);
      padding: 5px 12px;
      border-radius: 18px;
      font-size: 12px;
    }
    .user-name { font-weight: 700; color: #93c5fd; }
    .user-role {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      background: rgba(59, 130, 246, 0.2);
      padding: 2px 6px;
      border-radius: 8px;
      color: #bfdbfe;
      font-weight: 700;
    }

    .btn-logout {
      background: transparent;
      border: 1px solid var(--border-subtle);
      color: var(--text-muted);
      padding: 6px 12px;
      border-radius: 8px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
    }
    .btn-logout:hover {
      background: rgba(239, 68, 68, 0.15);
      color: #fca5a5;
      border-color: rgba(239, 68, 68, 0.3);
    }

    /* Main Body */
    .canvas-body {
      flex: 1;
      padding: 24px;
      max-width: 1680px;
      width: 100%;
      margin: 0 auto;
    }

    /* Backdrop for mobile drawer */
    .panel-backdrop {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.6);
      backdrop-filter: blur(4px);
      z-index: 1005;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.25s ease;
    }

    /* Shared Page Header & Card Layout */
    .page-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 24px;
      flex-wrap: wrap;
    }
    .page-title { font-size: 22px; font-weight: 800; letter-spacing: -0.4px; }
    .page-desc { font-size: 13px; color: var(--text-muted); margin-top: 4px; }

    .card {
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius);
      padding: 24px;
      margin-bottom: 24px;
      box-shadow: 0 4px 18px rgba(0, 0, 0, 0.2);
    }
    .card-title {
      font-size: 17px;
      font-weight: 700;
      margin-bottom: 8px;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .card-sub { font-size: 13px; color: var(--text-muted); margin-bottom: 20px; }

    .grid-2col {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(380px, 1fr));
      gap: 20px;
    }

    /* Buttons */
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 9px 16px;
      border-radius: var(--radius-sm);
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
      border: 1px solid transparent;
      transition: all 0.2s ease;
      font-family: inherit;
      text-decoration: none;
    }
    .btn-primary { background: var(--accent); color: #fff; }
    .btn-primary:hover { background: var(--accent-hover); transform: translateY(-1px); box-shadow: 0 4px 12px var(--accent-glow); }
    .btn-secondary { background: var(--bg-card); color: var(--text-main); border-color: var(--border); }
    .btn-secondary:hover { background: var(--bg-card-hover); }
    .btn-danger { background: rgba(239, 68, 68, 0.15); color: #fca5a5; border-color: rgba(239, 68, 68, 0.3); }
    .btn-danger:hover { background: var(--danger); color: #fff; }
    .btn-warning { background: rgba(245, 158, 11, 0.15); color: #fde68a; border-color: rgba(245, 158, 11, 0.3); }
    .btn-warning:hover { background: var(--warning); color: #000; }
    .btn-success { background: rgba(16, 185, 129, 0.15); color: #6ee7b7; border-color: rgba(16, 185, 129, 0.3); }
    .btn-success:hover { background: var(--success); color: #fff; }
    .btn-sm { padding: 5px 10px; font-size: 12px; }

    /* Form Controls */
    .form-group { margin-bottom: 18px; }
    .form-label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; color: var(--text-main); }
    .form-hint { font-size: 12px; color: var(--text-muted); margin-top: 4px; }
    .form-input, .form-select, .form-textarea {
      width: 100%;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 10px 14px;
      color: var(--text-main);
      font-size: 13px;
      font-family: inherit;
      transition: border-color 0.2s, box-shadow 0.2s;
    }
    .form-input:focus, .form-select:focus, .form-textarea:focus {
      outline: none;
      border-color: var(--accent);
      box-shadow: 0 0 0 3px var(--accent-glow);
    }
    .form-row { display: flex; gap: 12px; align-items: flex-end; }

    /* Tables */
    .table-container {
      overflow-x: auto;
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius);
      background: var(--bg-surface);
      box-shadow: 0 4px 18px rgba(0, 0, 0, 0.2);
    }
    table { width: 100%; border-collapse: collapse; text-align: left; font-size: 13px; }
    th {
      background: var(--bg-card);
      padding: 12px 16px;
      font-weight: 700;
      color: var(--text-muted);
      border-bottom: 1px solid var(--border);
      text-transform: uppercase;
      font-size: 11px;
      letter-spacing: 0.5px;
    }
    td { padding: 14px 16px; border-bottom: 1px solid var(--border-subtle); vertical-align: middle; }
    tr:last-child td { border-bottom: none; }
    tr:hover td { background: rgba(255, 255, 255, 0.02); }

    /* Badges */
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 3px 8px;
      border-radius: 12px;
      font-size: 11px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .badge-green { background: rgba(16, 185, 129, 0.15); color: #6ee7b7; border: 1px solid rgba(16, 185, 129, 0.3); }
    .badge-blue { background: rgba(59, 130, 246, 0.15); color: #93c5fd; border: 1px solid rgba(59, 130, 246, 0.3); }
    .badge-yellow { background: rgba(245, 158, 11, 0.15); color: #fde68a; border-color: rgba(245, 158, 11, 0.3); }
    .badge-red { background: rgba(239, 68, 68, 0.15); color: #fca5a5; border-color: rgba(239, 68, 68, 0.3); }

    /* Modal Overlay (VNC remote control & quick confirmation) */
    .modal-overlay {
      position: fixed; inset: 0; background: rgba(0, 0, 0, 0.85); backdrop-filter: blur(8px);
      z-index: 2000; display: none; align-items: center; justify-content: center; padding: 20px;
    }
    .modal-overlay.active { display: flex; }
    .modal-box {
      background: var(--bg-surface); border: 1px solid var(--border); border-radius: var(--radius);
      width: 100%; max-width: 600px; padding: 28px; position: relative; box-shadow: 0 20px 50px rgba(0, 0, 0, 0.7);
    }
    .modal-close {
      position: absolute; top: 18px; right: 18px; background: transparent; border: none;
      color: var(--text-muted); font-size: 20px; cursor: pointer;
    }
    .modal-close:hover { color: #fff; }

    /* Footer */
    .canvas-footer {
      background: var(--bg-surface);
      border-top: 1px solid var(--border-subtle);
      padding: 16px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      color: var(--text-muted);
      font-size: 12px;
      flex-wrap: wrap;
      gap: 12px;
      margin-top: auto;
    }
    .canvas-footer a { color: var(--text-muted); text-decoration: none; }
    .canvas-footer a:hover { color: var(--accent); }

    /* ---------------------------------------------------------------------- */
    /* Mobile / Tablet Responsive Adjustments                                 */
    /* ---------------------------------------------------------------------- */
    @media (max-width: 1024px) {
      .nav-rail { transform: translateX(-100%); }
      .sub-panel { transform: translateX(-100%); left: 0; }
      .app-canvas { margin-left: 0 !important; }
      .btn-mobile-menu { display: inline-flex; }
      .panel-backdrop { display: block; }

      .app-layout.mobile-open .nav-rail {
        transform: translateX(0);
      }
      .app-layout.mobile-open .sub-panel {
        transform: translateX(var(--rail-width));
        opacity: 1;
        pointer-events: auto;
      }
      .app-layout.mobile-open .panel-backdrop {
        opacity: 1;
        pointer-events: auto;
      }
    }
  </style>
</head>
<body>
  <div class="app-layout" id="app-layout">
    <!-- Level 1: Primary Navigation Rail (72px) -->
    <aside class="nav-rail" id="nav-rail">
      <div class="rail-top">
        <a href="/admin" class="brand-glyph" title="${escapeAttr(brandTitle)}">
          <div class="brand-icon">${brandIconSvg || defaultBrandIcon}</div>
        </a>
        <div class="rail-divider"></div>
        <nav class="rail-nav">
          ${railItemsHtml}
        </nav>
      </div>
      <div class="rail-bottom">
        <button class="rail-action-btn" id="btn-toggle-subpanel" title="Toggle Side Panel (Ctrl+B)" data-action="toggle-subpanel">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="15 18 9 12 15 6"></polyline>
          </svg>
        </button>
        <div class="rail-user-avatar" title="${escapeAttr(userMeta?.name || 'Admin')} (${escapeAttr(userMeta?.role || '')})">
          <span>${escapeHtml((userMeta?.name || 'A').slice(0, 1).toUpperCase())}</span>
        </div>
      </div>
    </aside>

    <!-- Level 2: Secondary Context Action Panel (272px, animated & collapsible) -->
    <aside class="sub-panel" id="sub-panel">
      <div class="sub-panel-header">
        <div class="sub-panel-title-wrap">
          <h3 class="sub-panel-title">${escapeHtml(subPanelTitle)}</h3>
          <p class="sub-panel-subtitle">${escapeHtml(subPanelSubtitle)}</p>
        </div>
        <button class="sub-panel-close-btn" id="btn-close-subpanel" data-action="toggle-subpanel" title="Collapse Panel">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="15 18 9 12 15 6"></polyline>
          </svg>
        </button>
      </div>
      <div class="sub-panel-content">
        ${subPanelHtml}
      </div>
    </aside>

    <!-- Backdrop for mobile/tablet drawer -->
    <div class="panel-backdrop" id="panel-backdrop" data-action="toggle-mobile-menu"></div>

    <!-- App Canvas (Fluid Content) -->
    <div class="app-canvas" id="app-canvas">
      <!-- Top Utility Header -->
      <header class="canvas-header">
        <div class="canvas-header-left">
          <button class="btn-mobile-menu" id="btn-mobile-menu" data-action="toggle-mobile-menu" title="Open Menu">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="3" y1="12" x2="21" y2="12"></line>
              <line x1="3" y1="6" x2="21" y2="6"></line>
              <line x1="3" y1="18" x2="21" y2="18"></line>
            </svg>
          </button>
          <div class="canvas-breadcrumb">
            <span class="breadcrumb-school">${escapeHtml(brandTitle)}</span>
            <span class="breadcrumb-sep">/</span>
            <span class="breadcrumb-page">${escapeHtml(activeNavLabel)}</span>
          </div>
        </div>

        ${stats.length ? `<div class="canvas-header-center">${statsHtml}</div>` : ""}

        <div class="canvas-header-right">
          ${
            userMeta
              ? `
            <div class="user-pill">
              <span class="user-name">${escapeHtml(userMeta.name)}</span>
              <span class="user-role">${escapeHtml(userMeta.role)}</span>
            </div>
          `
              : ""
          }
          <form action="${escapeAttr(logoutAction)}" method="POST" style="margin:0;">
            <button type="submit" class="btn-logout">Sign Out</button>
          </form>
        </div>
      </header>

      <!-- Main Content Canvas -->
      <main class="canvas-body">
        ${contentHtml}
      </main>

      <!-- Canvas Footer -->
      <footer class="canvas-footer">
        <div>&copy; 2026 Lab Kiosk OS • Educational Environment Restricted • 100% In-Memory RAM Overlay</div>
        <div style="display: flex; gap: 16px;">
          <a href="/privacy" target="_blank" rel="noopener noreferrer">Privacy Policy (FERPA/COPPA)</a>
          <a href="/terms" target="_blank" rel="noopener noreferrer">Terms of Service</a>
        </div>
      </footer>
    </div>
  </div>

  ${modalsHtml}

  ${scriptsHtml}

  <script nonce="${escapeAttr(nonce)}">
    (function() {
      "use strict";
      const layout = document.getElementById("app-layout");
      const storageKey = "labkiosk_subpanel_collapsed";

      // Restore collapsed state from localStorage
      try {
        if (localStorage.getItem(storageKey) === "1") {
          layout.classList.add("subpanel-collapsed");
        }
      } catch (e) {}

      function toggleSubpanel() {
        layout.classList.toggle("subpanel-collapsed");
        try {
          const isCollapsed = layout.classList.contains("subpanel-collapsed");
          localStorage.setItem(storageKey, isCollapsed ? "1" : "0");
        } catch (e) {}
      }

      function toggleMobileMenu() {
        layout.classList.toggle("mobile-open");
      }

      // Event delegation for actions
      document.addEventListener("click", function(e) {
        const target = e.target && e.target.closest ? e.target.closest("[data-action]") : null;
        if (!target) return;
        const action = target.getAttribute("data-action");
        if (action === "toggle-subpanel") {
          e.preventDefault();
          toggleSubpanel();
        } else if (action === "toggle-mobile-menu") {
          e.preventDefault();
          toggleMobileMenu();
        }
      });

      // Keyboard shortcut: Ctrl+B or Cmd+B to toggle sub-panel
      document.addEventListener("keydown", function(e) {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") {
          e.preventDefault();
          toggleSubpanel();
        }
      });
    })();
  </script>
</body>
</html>`;
}
