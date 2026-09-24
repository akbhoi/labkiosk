/**
 * Modern Responsive Dashboard Shell & Left-Side Multi-Level Panels Layout
 * Provides Level 1 primary navigation rail (72px), Level 2 context action panel (272px),
 * seamless hardware-accelerated transitions, fluid content canvas, and 2026 design tokens.
 */

import { escapeHtml, escapeAttr } from "./escape";
import { FONT_LINKS, rootTokensCss } from "./ui_tokens";

export interface NavItem {
  id: string;
  label: string;
  href: string;
  iconSvg: string;
  badge?: string | number;
  /**
   * How the badge reads. "count" (the default) is a neutral tally -- six portal
   * apps is not a problem. "attention" is the red one, for a queue that is
   * waiting on the person looking at it.
   */
  badgeTone?: "count" | "attention";
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
  /**
   * Where the brand glyph links. It used to be hardcoded to "/admin", which on
   * the super-admin console is a route super admins are refused (HTTP 400), and
   * on a dev host silently dropped the ?tenant= parameter.
   */
  brandHref?: string;
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

/**
 * A rail badge, or nothing. A zero count is omitted: an empty allowlist is
 * already legible from the page, and a badge reading "0" only adds noise.
 */
function renderRailBadge(item: NavItem): string {
  if (item.badge === undefined) return "";
  const text = String(item.badge);
  if (text === "" || text === "0") return "";
  const tone = item.badgeTone === "attention" ? " attention" : "";
  return `<span class="rail-badge${tone}">${escapeHtml(text)}</span>`;
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

  const brandHref = options.brandHref || "/admin";
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
          ${renderRailBadge(item)}
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
${FONT_LINKS}
  <style>
${rootTokensCss()}

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
      background: var(--bg-card-hover);
      color: var(--text-main);
      border: 1px solid var(--border);
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
    .rail-badge.attention {
      background: var(--danger);
      color: #fff;
      border-color: var(--danger);
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
      cursor: pointer;
      transition: transform 0.2s ease, border-color 0.2s ease, box-shadow 0.2s ease;
    }

    .rail-profile-wrap {
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
      width: 100%;
    }

    .rail-user-btn {
      background: transparent;
      border: none;
      padding: 0;
      cursor: pointer;
      border-radius: 50%;
      outline: none;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .rail-user-btn:hover .rail-user-avatar {
      border-color: var(--accent);
      transform: scale(1.05);
      box-shadow: 0 0 14px var(--accent-glow);
    }
    .rail-user-btn:focus-visible .rail-user-avatar {
      outline: 2px solid var(--accent);
      outline-offset: 2px;
    }

    .rail-profile-menu {
      position: absolute;
      left: calc(var(--rail-width) + 8px);
      bottom: 0;
      width: 260px;
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: 0 12px 36px rgba(0, 0, 0, 0.6);
      padding: 14px;
      z-index: 1060;
      display: flex;
      flex-direction: column;
      gap: 12px;
      opacity: 0;
      pointer-events: none;
      transform: translateY(8px) scale(0.96);
      transform-origin: bottom left;
      transition: opacity 0.18s ease, transform 0.2s var(--ease-spring);
      backdrop-filter: blur(12px);
    }
    .rail-profile-menu.active {
      opacity: 1;
      pointer-events: auto;
      transform: translateY(0) scale(1);
    }

    .profile-menu-header {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .profile-menu-avatar {
      width: 38px;
      height: 38px;
      border-radius: 50%;
      background: linear-gradient(135deg, #1e293b, #334155);
      border: 2px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-size: 14px;
      color: #93c5fd;
      flex-shrink: 0;
    }
    .profile-menu-info {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 2px;
    }
    .profile-menu-name {
      font-size: 14px;
      font-weight: 700;
      color: var(--text-main);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .profile-menu-email {
      font-size: 11px;
      color: var(--text-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      font-family: 'JetBrains Mono', monospace;
    }
    .profile-menu-role {
      font-size: 10px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: #93c5fd;
      background: rgba(59, 130, 246, 0.15);
      padding: 2px 6px;
      border-radius: 6px;
      align-self: flex-start;
      margin-top: 2px;
    }

    .profile-menu-divider {
      height: 1px;
      background: var(--border-subtle);
      margin: 0 -4px;
    }

    .profile-menu-actions {
      display: flex;
      flex-direction: column;
      gap: 4px;
    }

    .profile-menu-link,
    .profile-menu-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 10px;
      border-radius: var(--radius-sm);
      font-size: 13px;
      font-weight: 500;
      color: var(--text-muted);
      text-decoration: none;
      background: transparent;
      border: none;
      width: 100%;
      cursor: pointer;
      text-align: left;
      font-family: inherit;
      transition: color 0.15s ease, background 0.15s ease;
    }
    .profile-menu-link:hover,
    .profile-menu-item:hover {
      color: var(--text-main);
      background: rgba(255, 255, 255, 0.05);
    }
    .profile-logout-btn {
      color: #fca5a5;
    }
    .profile-logout-btn:hover {
      color: #fff;
      background: rgba(239, 68, 68, 0.2);
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
    .sub-action-item:disabled {
      opacity: 0.45;
      cursor: default;
    }
    .sub-action-item:disabled:hover {
      color: var(--text-muted);
      background: transparent;
      border-color: transparent;
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
      flex-direction: column;
      align-items: flex-start;
      gap: 1px;
      min-width: 0;
    }
    .breadcrumb-trail {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 14px;
    }
    .breadcrumb-organization { font-weight: 700; color: var(--text-main); }
    .breadcrumb-sep { color: var(--text-subtle); }
    .breadcrumb-page { color: var(--text-muted); font-weight: 500; }
    /* The console's own address. Passed in as brandSubtitle since the shell
       was written, but until now never rendered anywhere. */
    .breadcrumb-host {
      font-family: 'JetBrains Mono', monospace;
      font-size: 11px;
      color: var(--text-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 100%;
    }

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
    .stat-label { color: var(--text-muted); }
    .stat-val { color: var(--text-main); font-variant-numeric: tabular-nums; }
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

    /* Workstation grid, and the placeholder it shows while telemetry is empty.
       These carried their whole appearance in inline style attributes, so the
       class names on them described nothing. */
    .kiosk-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
      gap: 20px;
    }
    /* A workstation card. Every part of this used to be an inline cssText
       string set from JavaScript, which meant a compact layout could not
       override any of it without !important. */
    .kiosk-card {
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 16px;
      margin-bottom: 0;
      transition: transform 0.2s ease, border-color 0.2s ease;
    }
    .kc-head { display: flex; justify-content: space-between; align-items: center; gap: 10px; }
    .kc-id { display: flex; align-items: center; gap: 8px; font-weight: 700; font-size: 15px; }
    .kc-badges { display: flex; align-items: center; gap: 6px; }
    .kc-thumb-box {
      position: relative;
      width: 100%;
      aspect-ratio: 16 / 10;
      background: #000;
      border-radius: 8px;
      overflow: hidden;
      border: 1px solid var(--border-subtle);
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .kc-thumb { width: 100%; height: 100%; object-fit: cover; display: none; }
    .kc-thumb.live { display: block; }
    .kc-placeholder { color: var(--text-muted); font-size: 12px; font-weight: 600; }
    .kc-actions { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
    .kc-footer {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      font-size: 11px;
      color: var(--text-muted);
      padding-top: 4px;
      border-top: 1px solid var(--border-subtle);
    }
    .kc-url { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 180px; }
    .kc-ip { font-family: 'JetBrains Mono', monospace; }

    /* Compact density. A 40-workstation lab is four rows of scrolling and 40
       JPEG decodes every three seconds before an operator finds PC-37; this is
       one line per machine and no thumbnails at all. */
    .kiosk-grid.compact { grid-template-columns: 1fr; gap: 8px; }
    .kiosk-grid.compact .kiosk-card {
      flex-direction: row;
      align-items: center;
      gap: 16px;
      padding: 10px 14px;
    }
    .kiosk-grid.compact .kc-thumb-box { display: none; }
    .kiosk-grid.compact .kc-head { flex: 0 0 auto; min-width: 190px; }
    .kiosk-grid.compact .kc-footer {
      flex: 1;
      justify-content: flex-start;
      gap: 18px;
      border-top: none;
      padding-top: 0;
    }
    .kiosk-grid.compact .kc-url { max-width: none; }
    .kiosk-grid.compact .kc-actions {
      display: flex;
      flex-wrap: wrap;
      justify-content: flex-end;
      gap: 6px;
      margin-left: auto;
    }
    @media (max-width: 760px) {
      .kiosk-grid.compact .kiosk-card { flex-wrap: wrap; }
      .kiosk-grid.compact .kc-actions { margin-left: 0; }
    }

    .empty-lab-state {
      grid-column: 1 / -1;
      background: var(--bg-card);
      border: 1px dashed var(--border);
      border-radius: var(--radius);
      padding: 60px 24px;
      text-align: center;
      color: var(--text-muted);
      font-size: 13px;
    }
    .empty-lab-title {
      font-size: 16px;
      font-weight: 700;
      color: var(--text-main);
      margin-bottom: 8px;
    }

    /* Workstation Groups and Section Dividers */
    .group-section {
      grid-column: 1 / -1;
      width: 100%;
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius);
      overflow: hidden;
      margin-bottom: 8px;
    }
    .group-section-header {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 10px 16px;
      background: var(--bg-card);
      border-bottom: 1px solid var(--border-subtle);
      cursor: pointer;
      user-select: none;
    }
    .group-section.collapsed .group-section-header {
      border-bottom: none;
    }
    .group-collapse-btn {
      background: transparent;
      border: none;
      color: var(--text-muted);
      cursor: pointer;
      padding: 2px 4px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .group-chevron {
      transition: transform 0.2s ease;
    }
    .group-section.collapsed .group-chevron {
      transform: rotate(-90deg);
    }
    .group-select-checkbox {
      width: 16px;
      height: 16px;
      cursor: pointer;
      accent-color: var(--accent);
    }
    .group-title {
      font-size: 14px;
      font-weight: 700;
      color: var(--text-main);
    }
    .group-count-badge {
      font-size: 11px;
      font-weight: 600;
      color: var(--text-muted);
      background: var(--bg-base);
      padding: 2px 8px;
      border-radius: 10px;
      border: 1px solid var(--border-subtle);
    }
    .group-cards-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
      gap: 16px;
      padding: 16px;
    }
    .group-section.collapsed .group-cards-grid {
      display: none;
    }
    .kiosk-grid.compact .group-cards-grid {
      grid-template-columns: 1fr;
      gap: 8px;
      padding: 10px;
    }
    .kc-select-checkbox {
      width: 16px;
      height: 16px;
      cursor: pointer;
      accent-color: var(--accent);
      margin-right: 4px;
    }
    .kiosk-card.selected {
      border-color: var(--accent);
      box-shadow: 0 0 14px var(--accent-glow);
    }
    .sub-action-group-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 4px;
    }

    /* A saved broadcast preset, and one allowed domain. */
    .preset-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 12px 16px;
      margin-bottom: 10px;
    }
    .domain-tag {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: 20px;
      padding: 6px 14px;
      font-size: 13px;
      font-family: 'JetBrains Mono', monospace;
    }

    /* Segmented Navigation Tabs */
    .segmented-nav {
      display: inline-flex;
      align-items: center;
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
      padding: 3px;
      gap: 3px;
    }
    .segmented-tab {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      padding: 7px 14px;
      border-radius: 6px;
      font-size: 13px;
      font-weight: 600;
      color: var(--text-muted);
      background: transparent;
      border: none;
      cursor: pointer;
      font-family: inherit;
      transition: all 0.15s ease;
      text-decoration: none;
    }
    .segmented-tab:hover {
      color: var(--text-main);
      background: rgba(255, 255, 255, 0.04);
    }
    .segmented-tab.active {
      color: #fff;
      background: var(--accent);
      box-shadow: 0 2px 8px var(--accent-glow);
    }
    .tab-pane {
      display: none;
    }
    .tab-pane.active {
      display: block;
    }

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
    .form-checkbox {
      appearance: none;
      -webkit-appearance: none;
      width: 18px;
      height: 18px;
      border: 1.5px solid var(--border);
      border-radius: var(--radius-xs);
      background: var(--bg-card);
      cursor: pointer;
      display: inline-grid;
      place-content: center;
      margin: 0;
      vertical-align: middle;
      transition: background-color 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
      flex-shrink: 0;
    }
    .form-checkbox:hover {
      border-color: var(--accent);
    }
    .form-checkbox:checked {
      background-color: var(--accent);
      border-color: var(--accent);
      background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 16 16' fill='none' stroke='white' stroke-width='2' stroke-linecap='round' stroke-linejoin='round' xmlns='http://www.w3.org/2000/svg'%3E%3Cpolyline points='3.5 8.5 6.5 11.5 12.5 4.5'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: center;
      background-size: 12px 12px;
    }
    .form-checkbox:focus-visible {
      outline: none;
      box-shadow: 0 0 0 3px var(--accent-glow);
    }
    .form-checkbox-label {
      display: flex;
      align-items: center;
      gap: 10px;
      font-size: 13px;
      color: var(--text-main);
      cursor: pointer;
      user-select: none;
    }
    .form-checkbox-label:hover {
      color: #fff;
    }

    /* One editable block on the organization homepage: title, body, optional link,
       and the button that removes it. */
    .homepage-block-row {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 8px;
      align-items: start;
      background: var(--bg-card);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
      padding: 12px;
      margin-bottom: 10px;
    }
    .homepage-block-row > textarea,
    .homepage-block-row > input { grid-column: 1; }
    .homepage-block-row > .btn { grid-column: 2; grid-row: 1; }
    @media (max-width: 620px) {
      .homepage-block-row { grid-template-columns: 1fr; }
      .homepage-block-row > .btn { grid-column: 1; grid-row: auto; justify-self: start; }
    }

    /* Tables */
    .table-container {
      overflow-x: auto;
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius);
      background: var(--bg-surface);
      box-shadow: 0 4px 18px rgba(0, 0, 0, 0.2);
    }
    .table-scrollable {
      max-height: 480px;
      overflow-y: auto;
      scrollbar-width: thin;
      scrollbar-color: var(--border) transparent;
    }
    .table-scrollable th {
      position: sticky;
      top: 0;
      z-index: 2;
      background: var(--bg-card);
      box-shadow: 0 1px 0 var(--border);
    }
    .table-scrollable::-webkit-scrollbar {
      width: 6px;
      height: 6px;
    }
    .table-scrollable::-webkit-scrollbar-track {
      background: transparent;
    }
    .table-scrollable::-webkit-scrollbar-thumb {
      background: var(--border);
      border-radius: 3px;
    }
    .table-scrollable::-webkit-scrollbar-thumb:hover {
      background: var(--border-subtle);
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

    /* ---------------------------------------------------------------------- */
    /* Toasts and dialogs                                                     */
    /* ---------------------------------------------------------------------- */
    /* The consoles used to speak through window.alert/confirm/prompt: 77
       native boxes that cannot be styled, that stop the 3-second telemetry
       poll dead while they are up, and that made the platform console feel
       like a different product from the organization one. These are the shell
       replacements, available on every page that uses this layout. */
    .lk-toast-stack {
      position: fixed;
      bottom: 18px;
      right: 18px;
      z-index: 3000;
      display: flex;
      flex-direction: column;
      gap: 10px;
      max-width: min(420px, calc(100vw - 36px));
      pointer-events: none;
    }
    .lk-toast {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-left: 3px solid var(--accent);
      border-radius: var(--radius-sm);
      padding: 12px 14px;
      font-size: 13px;
      line-height: 1.45;
      color: var(--text-main);
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.5);
      pointer-events: auto;
      opacity: 0;
      transform: translateY(12px);
      transition: opacity 0.2s ease, transform 0.24s var(--ease-spring);
    }
    .lk-toast.visible { opacity: 1; transform: translateY(0); }
    .lk-toast.success { border-left-color: var(--success); }
    .lk-toast.error { border-left-color: var(--danger); }
    .lk-toast.warning { border-left-color: var(--warning); }
    .lk-toast-text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
    .lk-toast-close {
      background: transparent;
      border: none;
      color: var(--text-subtle);
      cursor: pointer;
      font-size: 15px;
      line-height: 1;
      padding: 0 2px;
    }
    .lk-toast-close:hover { color: var(--text-main); }

    .lk-dialog-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0, 0, 0, 0.78);
      backdrop-filter: blur(6px);
      z-index: 3100;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .lk-dialog {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      width: 100%;
      max-width: 460px;
      padding: 24px;
      box-shadow: 0 24px 60px rgba(0, 0, 0, 0.7);
    }
    .lk-dialog-title { font-size: 17px; font-weight: 700; margin-bottom: 8px; }
    .lk-dialog-message {
      font-size: 13px;
      color: var(--text-muted);
      line-height: 1.6;
      margin-bottom: 18px;
      overflow-wrap: anywhere;
    }
    .lk-dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }

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
        <a href="${escapeAttr(brandHref)}" class="brand-glyph" title="${escapeAttr(brandTitle)}">
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
        <div class="rail-profile-wrap">
          <button type="button" class="rail-user-btn" id="btn-user-profile" aria-expanded="false" aria-haspopup="true" title="${escapeAttr(userMeta?.name || 'User Profile')} (${escapeAttr(userMeta?.role || 'Admin')})">
            <div class="rail-user-avatar">
              <span>${escapeHtml((userMeta?.name || 'A').slice(0, 1).toUpperCase())}</span>
            </div>
          </button>
          <div class="rail-profile-menu" id="rail-profile-menu" role="menu" aria-label="User profile menu">
            <div class="profile-menu-header">
              <div class="profile-menu-avatar">
                <span>${escapeHtml((userMeta?.name || 'A').slice(0, 1).toUpperCase())}</span>
              </div>
              <div class="profile-menu-info">
                <div class="profile-menu-name">${escapeHtml(userMeta?.name || 'Administrator')}</div>
                ${userMeta?.email ? `<div class="profile-menu-email">${escapeHtml(userMeta.email)}</div>` : ""}
                <div class="profile-menu-role">${escapeHtml(userMeta?.role || 'Admin')}</div>
              </div>
            </div>
            <div class="profile-menu-divider"></div>
            <div class="profile-menu-actions">
              ${
                brandHref.startsWith("/super")
                  ? `<a href="/super/system" class="profile-menu-link">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>
                      <span>System Settings</span>
                    </a>`
                  : `<a href="${escapeAttr(brandHref.includes("?") ? "/admin/settings?" + brandHref.split("?")[1] + "#section-password" : "/admin/settings#section-password")}" class="profile-menu-link">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                      <span>Change Password</span>
                    </a>`
              }
              <form action="${escapeAttr(logoutAction)}" method="POST" style="margin:0;">
                <button type="submit" class="profile-menu-item profile-logout-btn">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
                  <span>Sign Out</span>
                </button>
              </form>
            </div>
          </div>
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
            <div class="breadcrumb-trail">
              <span class="breadcrumb-organization">${escapeHtml(brandTitle)}</span>
              <span class="breadcrumb-sep">/</span>
              <span class="breadcrumb-page">${escapeHtml(activeNavLabel)}</span>
            </div>
            ${brandSubtitle ? `<div class="breadcrumb-host">${escapeHtml(brandSubtitle)}</div>` : ""}
          </div>
        </div>

        ${stats.length ? `<div class="canvas-header-center">${statsHtml}</div>` : ""}

        <div class="canvas-header-right"></div>
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

  <div class="lk-toast-stack" id="lk-toast-stack" aria-live="polite" role="status"></div>

  <script nonce="${escapeAttr(nonce)}">
    (function () {
      "use strict";

      var stack = document.getElementById("lk-toast-stack");

      /**
       * Announce something without stopping the page.
       * Tone is one of "info" (the default), "success", "error", "warning".
       */
      window.lkToast = function (message, tone, holdMs) {
        if (!stack || !message) return;
        var toast = document.createElement("div");
        toast.className = "lk-toast " + (tone || "info");

        var text = document.createElement("div");
        text.className = "lk-toast-text";
        // textContent, never innerHTML: these carry organization names, domains and
        // error strings that came back from the server.
        text.textContent = String(message);
        toast.appendChild(text);

        var close = document.createElement("button");
        close.type = "button";
        close.className = "lk-toast-close";
        close.setAttribute("aria-label", "Dismiss");
        close.textContent = "\u2715";
        toast.appendChild(close);

        stack.appendChild(toast);
        // A batch command that fails per workstation can raise a dozen of these
        // at once; keep the newest few rather than filling the viewport.
        while (stack.children.length > 4) stack.removeChild(stack.firstChild);
        requestAnimationFrame(function () { toast.classList.add("visible"); });

        var timer = null;
        function dismiss() {
          if (timer) clearTimeout(timer);
          toast.classList.remove("visible");
          setTimeout(function () { if (toast.parentNode) toast.remove(); }, 240);
        }
        close.addEventListener("click", dismiss);
        // An error stays up longer: it is the one a person actually needs to read.
        timer = setTimeout(dismiss, holdMs || (tone === "error" ? 7000 : 4000));
        return dismiss;
      };

      var HANDOFF_KEY = "labkiosk_toast_handoff";

      /**
       * Say something that has to survive the navigation it triggers.
       *
       * A blocking browser alert used to hold the page open long enough to be
       * read; a toast is destroyed by the reload that follows it. This parks the
       * message and the next page picks it up.
       */
      window.lkToastAfterReload = function (message, tone) {
        try {
          sessionStorage.setItem(HANDOFF_KEY, JSON.stringify({ message: String(message), tone: tone || "success" }));
        } catch (err) {
          // Private browsing, or storage denied. The navigation still matters
          // more than the message, so fall back to saying it now.
          window.lkToast(message, tone);
        }
      };

      (function drainHandoff() {
        var raw = null;
        try {
          raw = sessionStorage.getItem(HANDOFF_KEY);
          if (raw) sessionStorage.removeItem(HANDOFF_KEY);
        } catch (err) {
          return;
        }
        if (!raw) return;
        try {
          var parked = JSON.parse(raw);
          if (parked && parked.message) window.lkToast(parked.message, parked.tone);
        } catch (err) {
          // A malformed entry is not worth failing the page load over.
        }
      })();

      /** Shared chrome for the confirm and prompt dialogs. */
      function buildDialog(options, buildBody) {
        var overlay = document.createElement("div");
        overlay.className = "lk-dialog-overlay";

        var box = document.createElement("div");
        box.className = "lk-dialog";
        box.setAttribute("role", "dialog");
        box.setAttribute("aria-modal", "true");
        overlay.appendChild(box);

        var title = document.createElement("h3");
        title.className = "lk-dialog-title";
        title.textContent = options.title || "Please confirm";
        box.appendChild(title);

        if (options.message) {
          var message = document.createElement("p");
          message.className = "lk-dialog-message";
          message.textContent = options.message;
          box.appendChild(message);
        }

        var field = buildBody ? buildBody(box) : null;

        var actions = document.createElement("div");
        actions.className = "lk-dialog-actions";
        var cancel = document.createElement("button");
        cancel.type = "button";
        cancel.className = "btn btn-secondary";
        cancel.textContent = options.cancelLabel || "Cancel";
        var accept = document.createElement("button");
        accept.type = "button";
        accept.className = "btn " + (options.tone === "danger" ? "btn-danger" : "btn-primary");
        accept.textContent = options.confirmLabel || "Confirm";
        actions.appendChild(cancel);
        actions.appendChild(accept);
        box.appendChild(actions);

        document.body.appendChild(overlay);
        return { overlay: overlay, cancel: cancel, accept: accept, field: field };
      }

      /** Resolve once, tear the dialog down, hand focus back where it was. */
      function settleWith(parts, resolve) {
        var previous = document.activeElement;
        var done = false;
        return function settle(value) {
          if (done) return;
          done = true;
          parts.overlay.remove();
          if (previous && previous.focus) previous.focus();
          resolve(value);
        };
      }

      function wire(parts, settle, outcome) {
        parts.cancel.addEventListener("click", function () { settle(outcome.cancelled); });
        parts.accept.addEventListener("click", function () { settle(outcome.accepted()); });
        parts.overlay.addEventListener("click", function (event) {
          if (event.target === parts.overlay) settle(outcome.cancelled);
        });
        parts.overlay.addEventListener("keydown", function (event) {
          if (event.key === "Escape") {
            settle(outcome.cancelled);
          } else if (event.key === "Enter" && event.target !== parts.cancel) {
            event.preventDefault();
            settle(outcome.accepted());
          }
        });
      }

      /** Ask a yes/no question. Resolves true only on an explicit yes. */
      window.lkConfirm = function (options) {
        var opts = typeof options === "string" ? { message: options } : (options || {});
        return new Promise(function (resolve) {
          var parts = buildDialog(opts, null);
          var settle = settleWith(parts, resolve);
          wire(parts, settle, { cancelled: false, accepted: function () { return true; } });
          parts.accept.focus();
        });
      };

      /** Ask for a value. Resolves null when dismissed or left empty. */
      window.lkPrompt = function (options) {
        var opts = options || {};
        return new Promise(function (resolve) {
          var parts = buildDialog(opts, function (box) {
            var group = document.createElement("div");
            group.className = "form-group";
            if (opts.label) {
              var label = document.createElement("label");
              label.className = "form-label";
              label.textContent = opts.label;
              group.appendChild(label);
            }
            var input = document.createElement("input");
            input.type = "text";
            input.className = "form-input";
            input.value = opts.value || "";
            input.placeholder = opts.placeholder || "";
            group.appendChild(input);
            if (opts.hint) {
              var hint = document.createElement("p");
              hint.className = "form-hint";
              hint.textContent = opts.hint;
              group.appendChild(hint);
            }
            box.appendChild(group);
            return input;
          });
          var settle = settleWith(parts, resolve);
          wire(parts, settle, {
            cancelled: null,
            accepted: function () {
              var value = parts.field ? parts.field.value.trim() : "";
              return value || null;
            }
          });
          if (parts.field) { parts.field.focus(); parts.field.select(); }
        });
      };
    })();
  <\/script>

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

      // Bottom-left profile menu toggle and outside-click dismiss
      const profileBtn = document.getElementById("btn-user-profile");
      const profileMenu = document.getElementById("rail-profile-menu");
      if (profileBtn && profileMenu) {
        profileBtn.addEventListener("click", function(e) {
          e.stopPropagation();
          const isOpen = profileMenu.classList.toggle("active");
          profileBtn.setAttribute("aria-expanded", isOpen ? "true" : "false");
        });

        document.addEventListener("click", function(e) {
          if (!profileMenu.contains(e.target) && !profileBtn.contains(e.target)) {
            profileMenu.classList.remove("active");
            profileBtn.setAttribute("aria-expanded", "false");
          }
        });

        document.addEventListener("keydown", function(e) {
          if (e.key === "Escape" && profileMenu.classList.contains("active")) {
            profileMenu.classList.remove("active");
            profileBtn.setAttribute("aria-expanded", "false");
            profileBtn.focus();
          }
        });
      }
    })();
  </script>
</body>
</html>`;
}
