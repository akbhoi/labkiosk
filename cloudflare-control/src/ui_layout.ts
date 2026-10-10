/**
 * The console shell: an icon-only navigation rail (names on hover, a labelled
 * drawer on a phone), the canvas header and footer, toasts, dialogs and the
 * primitives every console page is built from.
 */

import { escapeHtml, escapeAttr } from "./escape";
import { BUSY_CSS, BUSY_SCRIPT, FONT_LINKS, THEME_TOGGLE_SCRIPT, rootTokensCss, themeHeadHtml } from "./ui_tokens";

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
  return `<span class="sidebar-badge rail-badge${tone}">${escapeHtml(text)}</span>`;
}

/**
 * The console stylesheet (both consoles, every page), served as one immutable
 * file whose name carries a hash of its content, instead of ~50 KB inlined into
 * every console response. A new version is a new file name, so a deploy never
 * leaves a browser on stale styles.
 */
const CONSOLE_CSS = `${rootTokensCss()}

    /* ---------------------------------------------------------------------- */
    /* Base                                                                   */
    /* ---------------------------------------------------------------------- */
    *, *::before, *::after { box-sizing: border-box; }
    :where(h1, h2, h3, h4, h5, h6, p, ul, ol, li, dl, dd, figure, blockquote, pre, form) { margin: 0; }
    :where(ul, ol) { padding: 0; }
    html {
      accent-color: var(--accent);
      scrollbar-color: var(--border-input) transparent;
      /* A page that scrolls and one that does not are the same width, so the
         header's counters do not shift between them. */
      scrollbar-gutter: stable;
      -webkit-text-size-adjust: 100%;
    }
    body {
      margin: 0;
      font-family: var(--font-sans);
      font-size: 0.875rem;
      line-height: 1.5;
      font-feature-settings: "cv11", "ss01";
      background-color: var(--bg-base);
      color: var(--text-main);
      min-height: 100vh;
      min-height: 100dvh;
      overflow-x: hidden;
      -webkit-font-smoothing: antialiased;
      -moz-osx-font-smoothing: grayscale;
    }
    ::selection { background: var(--accent-glow); }
    :where(h1, h2, h3) { text-wrap: balance; }
    :where(a, button, input, select, textarea, summary, [tabindex]):focus-visible {
      outline: 2px solid var(--border-focus);
      outline-offset: 2px;
    }
    :where(.canvas-body) a:not([class]) { color: var(--accent-text); text-underline-offset: 2px; }
    code, kbd, samp, .mono { font-family: var(--font-mono); font-size: 0.92em; }

    /* Small helpers for page markup, so a page never needs an inline colour. */
    .text-muted { color: var(--text-muted); }
    .text-subtle { color: var(--text-subtle); }
    .text-success { color: var(--success-text); }
    .text-warning { color: var(--warning-text); }
    .text-danger { color: var(--danger-text); }
    .text-accent { color: var(--accent-text); }
    .text-sm { font-size: 0.8125rem; }
    .text-xs { font-size: 0.75rem; }
    .nowrap { white-space: nowrap; }
    .truncate { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
    .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
    .row-between { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; }
    .stack { display: flex; flex-direction: column; gap: 12px; }
    .stack-sm { display: flex; flex-direction: column; gap: 6px; }
    .mt-0 { margin-top: 0; }
    .mt-sm { margin-top: 8px; }
    .mt-md { margin-top: 16px; }
    .mt-lg { margin-top: 24px; }
    .mb-0 { margin-bottom: 0; }
    .mb-sm { margin-bottom: 8px; }
    .mb-md { margin-bottom: 16px; }
    .flex-1 { flex: 1; min-width: 0; }
    .is-hidden { display: none; }

    /* Outer App Layout with Left-Side Multi-Level Panels */
    .app-layout {
      display: flex;
      min-height: 100vh;
      min-height: 100dvh;
      width: 100%;
      position: relative;
    }

    /* ---------------------------------------------------------------------- */
    /* Navigation rail (68px; a 240px labelled drawer on a phone)             */
    /* ---------------------------------------------------------------------- */
    .nav-sidebar,
    .nav-rail {
      width: var(--sidebar-width);
      background-color: var(--bg-rail);
      border-right: 1px solid var(--border-subtle);
      display: flex;
      flex-direction: column;
      position: fixed;
      top: 0;
      bottom: 0;
      left: 0;
      z-index: 1020;
      padding: 0;
      transition: transform 0.28s var(--ease-spring);
      view-transition-name: lk-sidebar;
      overflow-x: hidden;
      overflow-y: auto;
      scrollbar-width: thin;
      scrollbar-color: var(--border-input) transparent;
    }

    .sidebar-header {
      padding: 16px 14px 12px;
      display: flex;
      align-items: center;
      border-bottom: 1px solid var(--border-subtle);
    }

    .sidebar-brand {
      display: flex;
      align-items: center;
      gap: 10px;
      text-decoration: none;
      min-width: 0;
      width: 100%;
    }

    .brand-meta {
      display: flex;
      flex-direction: column;
      min-width: 0;
      flex: 1;
    }

    .brand-name {
      font-size: 0.875rem;
      font-weight: 700;
      color: var(--text-main);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      line-height: 1.25;
    }

    .brand-sub {
      font-size: 0.6875rem;
      color: var(--text-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      font-family: var(--font-mono);
      margin-top: 2px;
    }

    .sidebar-nav {
      display: flex;
      flex-direction: column;
      gap: 2px;
      padding: 10px 10px 8px;
    }

    .sidebar-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 7px 10px;
      border-radius: var(--radius-sm);
      color: var(--text-muted);
      text-decoration: none;
      font-size: 0.8125rem;
      font-weight: 500;
      position: relative;
      transition: color 0.15s ease, background-color 0.15s ease;
      white-space: nowrap;
    }

    .sidebar-item:hover {
      color: var(--text-main);
      background-color: var(--hover);
    }

    .sidebar-item.active {
      color: var(--accent-text);
      background-color: var(--accent-soft);
      font-weight: 600;
    }

    .sidebar-icon {
      display: flex;
      align-items: center;
      justify-content: center;
      width: 20px;
      height: 20px;
      flex-shrink: 0;
    }
    .sidebar-icon svg { width: 18px; height: 18px; }

    .sidebar-label {
      flex: 1;
      min-width: 0;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }

    .sidebar-badge {
      font-size: 0.625rem;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
      padding: 1px 6px;
      border-radius: 999px;
      background: var(--bg-surface);
      color: var(--text-muted);
      border: 1px solid var(--border);
      line-height: 1.4;
      flex-shrink: 0;
    }

    .sidebar-footer {
      margin-top: auto;
      padding: 10px 12px;
      border-top: 1px solid var(--border-subtle);
      background: var(--bg-rail);
    }

    .sidebar-profile-wrap {
      position: relative;
      width: 100%;
    }

    .sidebar-user-btn {
      width: 100%;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 6px 8px;
      border-radius: var(--radius-sm);
      background: transparent;
      border: 1px solid transparent;
      cursor: pointer;
      text-align: left;
      transition: background-color 0.15s ease, border-color 0.15s ease;
    }

    .sidebar-user-btn:hover {
      background: var(--hover);
      border-color: var(--border-subtle);
    }

    .sidebar-user-avatar {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: var(--accent-soft);
      color: var(--accent-text);
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-size: 0.8125rem;
      flex-shrink: 0;
    }

    .sidebar-user-info,
    .user-meta {
      display: flex;
      flex-direction: column;
      min-width: 0;
      flex: 1;
    }

    .sidebar-user-name,
    .user-name {
      font-size: 0.8125rem;
      font-weight: 600;
      color: var(--text-main);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      line-height: 1.25;
    }

    .sidebar-user-role,
    .user-role {
      font-size: 0.6875rem;
      color: var(--text-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      text-transform: capitalize;
    }

    /* ---------------------------------------------------------------------- */
    .rail-top {
      display: flex;
      flex-direction: column;
      gap: 10px;
      width: 100%;
    }

    .brand-glyph {
      display: flex;
      align-items: center;
      text-decoration: none;
      border-radius: var(--radius);
    }

    .brand-icon {
      width: 38px;
      height: 38px;
      background: var(--accent);
      color: var(--accent-fg);
      border-radius: var(--radius);
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: var(--shadow-sm);
      transition: background-color 0.15s ease;
    }
    .brand-icon svg { width: 20px; height: 20px; }
    .brand-glyph:hover .brand-icon { background: var(--accent-hover); }

    .rail-divider {
      width: 100%;
      height: 1px;
      background: var(--border-subtle);
      margin: 4px 0;
    }

    .rail-nav {
      display: flex;
      flex-direction: column;
      gap: 2px;
      width: 100%;
      padding: 10px 10px 8px;
    }

    .rail-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 7px 10px;
      border-radius: var(--radius-sm);
      color: var(--text-muted);
      text-decoration: none;
      font-size: 0.8125rem;
      font-weight: 500;
      position: relative;
      transition: color 0.15s ease, background-color 0.15s ease;
      white-space: nowrap;
    }
    .rail-item svg { width: 18px; height: 18px; }
    .rail-item:hover {
      color: var(--text-main);
      background: var(--hover);
    }
    .rail-item.active {
      color: var(--accent-text);
      background: var(--accent-soft);
      font-weight: 600;
    }

    .rail-icon { display: flex; align-items: center; justify-content: center; width: 20px; height: 20px; flex-shrink: 0; }

    /* The name of a rail item, shown beside it on hover or keyboard focus.
       The phone drawer writes the names out instead. */
    .rail-tooltip {
      display: none;
      position: absolute;
      left: calc(100% + 12px);
      top: 50%;
      translate: -4px -50%;
      padding: 5px 10px;
      border-radius: var(--radius-sm);
      background: var(--bg-surface);
      color: var(--text-main);
      border: 1px solid var(--border);
      box-shadow: var(--shadow-lg);
      font-size: 0.75rem;
      font-weight: 600;
      line-height: 1.3;
      white-space: nowrap;
      text-transform: none;
      pointer-events: none;
      opacity: 0;
      z-index: 1070;
      transition: opacity 0.12s ease, translate 0.16s var(--ease-out);
    }

    /* ---------------------------------------------------------------------- */
    /* The rail: icons only, wherever there is a pointer to hover with        */
    /* ---------------------------------------------------------------------- */
    @media (min-width: 1025px) {
      /* Nothing in the rail scrolls, so its tooltips and the profile menu may
         reach over the canvas. */
      .nav-sidebar,
      .nav-rail { overflow: visible; }

      .sidebar-header { padding: 14px 0 12px; justify-content: center; }
      .sidebar-brand { width: auto; }
      .brand-meta,
      .sidebar-label,
      .sidebar-user-info { display: none; }

      .sidebar-nav,
      .rail-nav { align-items: center; gap: 6px; padding: 12px 0; }

      .sidebar-item,
      .rail-item {
        width: 48px;
        height: 48px;
        padding: 0;
        gap: 0;
        justify-content: center;
        border-radius: var(--radius);
      }
      .sidebar-icon,
      .rail-icon { width: 26px; height: 26px; }
      .sidebar-icon svg,
      .rail-item svg { width: 24px; height: 24px; }

      .rail-tooltip { display: block; }
      .rail-item:hover > .rail-tooltip,
      .rail-item:focus-visible > .rail-tooltip,
      .rail-user-btn:hover > .rail-tooltip,
      .rail-user-btn:focus-visible > .rail-tooltip {
        opacity: 1;
        translate: 0 -50%;
      }
      /* The open menu already says who is signed in. */
      .rail-user-btn[aria-expanded="true"] > .rail-tooltip { opacity: 0; }

      .rail-item > .rail-badge {
        position: absolute;
        top: 3px;
        right: 3px;
        margin-left: 0;
        min-width: 17px;
        padding: 0 4px;
        text-align: center;
      }

      .sidebar-footer,
      .rail-bottom { padding: 10px 0 12px; align-items: center; }
      .sidebar-user-btn,
      .rail-user-btn {
        width: 48px;
        height: 48px;
        padding: 0;
        justify-content: center;
        border-radius: var(--radius);
        position: relative;
      }
      .sidebar-user-avatar,
      .rail-user-avatar { width: 36px; height: 36px; font-size: 0.875rem; }

      .rail-profile-menu {
        left: calc(100% + 10px);
        right: auto;
        bottom: 0;
        width: 260px;
      }
    }

    .rail-badge {
      font-size: 0.625rem;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
      padding: 1px 6px;
      border-radius: 999px;
      background: var(--bg-surface);
      color: var(--text-muted);
      border: 1px solid var(--border);
      line-height: 1.4;
      flex-shrink: 0;
      position: static;
      margin-left: auto;
    }
    .rail-badge.attention {
      background: var(--danger);
      color: var(--on-solid);
      border-color: var(--danger);
    }

    .rail-bottom {
      margin-top: auto;
      padding: 10px 12px;
      border-top: 1px solid var(--border-subtle);
      background: var(--bg-rail);
      width: 100%;
      display: flex;
      flex-direction: column;
    }

    .rail-action-btn {
      width: 36px;
      height: 36px;
      border-radius: var(--radius-sm);
      background: transparent;
      border: none;
      color: var(--text-subtle);
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: color 0.15s ease, background-color 0.15s ease;
    }
    .rail-action-btn:hover {
      color: var(--text-main);
      background: var(--hover);
    }
    .rail-action-btn svg {
      width: 18px;
      height: 18px;
      transition: transform 0.28s var(--ease-spring);
    }

    .rail-user-avatar {
      width: 32px;
      height: 32px;
      border-radius: 50%;
      background: var(--accent-soft);
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-size: 0.8125rem;
      color: var(--accent-text);
      flex-shrink: 0;
    }

    .rail-profile-wrap {
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
      width: 100%;
    }

    .rail-user-btn {
      width: 100%;
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 6px 8px;
      border-radius: var(--radius-sm);
      background: transparent;
      border: 1px solid transparent;
      cursor: pointer;
      text-align: left;
      transition: background-color 0.15s ease, border-color 0.15s ease;
    }
    .rail-user-btn:hover {
      background: var(--hover);
      border-color: var(--border-subtle);
    }

    /* Opens upward, inside the sidebar: the sidebar scrolls (overflow), so a
       menu placed beside it is clipped away entirely. */
    .rail-profile-menu {
      position: absolute;
      left: 0;
      right: 0;
      bottom: calc(100% + 8px);
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: var(--shadow-lg);
      padding: 6px;
      z-index: 1060;
      display: flex;
      flex-direction: column;
      gap: 2px;
      opacity: 0;
      visibility: hidden;
      pointer-events: none;
      translate: 0 6px;
      scale: 0.98;
      transform-origin: bottom left;
      transition: opacity 0.14s ease, translate 0.18s var(--ease-out), scale 0.18s var(--ease-out), visibility 0s linear 0.18s;
    }
    .rail-profile-menu.active {
      opacity: 1;
      visibility: visible;
      pointer-events: auto;
      translate: 0 0;
      scale: 1;
      transition: opacity 0.14s ease, translate 0.18s var(--ease-out), scale 0.18s var(--ease-out), visibility 0s;
    }

    .profile-menu-header {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 8px 10px;
    }
    .profile-menu-avatar {
      width: 36px;
      height: 36px;
      border-radius: 50%;
      background: var(--accent-soft);
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 600;
      font-size: 0.875rem;
      color: var(--accent-text);
      flex-shrink: 0;
    }
    .profile-menu-info {
      flex: 1;
      min-width: 0;
      display: flex;
      flex-direction: column;
      gap: 1px;
    }
    .profile-menu-name {
      font-size: 0.875rem;
      font-weight: 600;
      color: var(--text-main);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .profile-menu-email {
      font-size: 0.75rem;
      color: var(--text-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .profile-menu-role {
      font-size: 0.6875rem;
      font-weight: 500;
      color: var(--accent-text);
      background: var(--accent-soft);
      padding: 1px 7px;
      border-radius: 999px;
      align-self: flex-start;
      margin-top: 4px;
    }

    .profile-menu-divider {
      height: 1px;
      background: var(--border-subtle);
      margin: 2px -6px 4px;
    }

    .profile-menu-actions {
      display: flex;
      flex-direction: column;
      gap: 1px;
    }

    .profile-menu-link,
    .profile-menu-item {
      display: flex;
      align-items: center;
      gap: 10px;
      min-height: 34px;
      padding: 6px 8px;
      border-radius: var(--radius-sm);
      font-size: 0.8125rem;
      font-weight: 500;
      color: var(--text-main);
      text-decoration: none;
      background: transparent;
      border: none;
      width: 100%;
      cursor: pointer;
      text-align: left;
      font-family: inherit;
      transition: background-color 0.12s ease, color 0.12s ease;
    }
    .profile-menu-link svg,
    .profile-menu-item svg { color: var(--text-muted); flex-shrink: 0; }
    .profile-menu-link:hover,
    .profile-menu-item:hover {
      background: var(--hover);
    }
    .profile-logout-btn,
    .profile-logout-btn svg {
      color: var(--danger-text);
    }
    .profile-logout-btn:hover {
      background: var(--danger-soft);
    }

    /* ---------------------------------------------------------------------- */
    /* App Canvas (Fluid Content)                                             */
    /* ---------------------------------------------------------------------- */
    .app-canvas {
      flex: 1;
      margin-left: var(--sidebar-width);
      transition: margin-left 0.28s var(--ease-spring);
      min-width: 0;
      display: flex;
      flex-direction: column;
      background-color: var(--bg-base);
      container-type: inline-size;
      container-name: canvas;
    }


    /* Top Utility Header */
    .canvas-header {
      background-color: var(--bg-base);
      background-color: color-mix(in oklab, var(--bg-base) 82%, transparent);
      -webkit-backdrop-filter: saturate(1.4) blur(14px);
      backdrop-filter: saturate(1.4) blur(14px);
      border-bottom: 1px solid var(--border-subtle);
      position: sticky;
      top: 0;
      z-index: 1000;
      min-height: 56px;
      padding: 8px 28px;
      /* Three columns with equal outer tracks: the counters sit at the centre of
         the header on every page, whatever the breadcrumb beside them says. As a
         wrapping flex row they started where the breadcrumb ended, so they moved
         with the length of each page's name. */
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
      align-items: center;
      gap: 16px;
      view-transition-name: lk-header;
    }

    /* A #section-... link (the profile menu's Change Password) lands below the
       sticky header rather than under it; the header wraps to ~100px when narrow. */
    [id^="section-"] {
      scroll-margin-top: 120px;
    }

    .canvas-header-left {
      display: flex;
      align-items: center;
      gap: 12px;
      /* Lets the breadcrumb shrink so the host line ellipsizes; without it that
         nowrap line set the header's minimum width and a phone rendered every
         console page zoomed out. */
      min-width: 0;
      max-width: 100%;
    }

    .btn-mobile-menu {
      display: none;
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text-main);
      width: 36px;
      height: 36px;
      align-items: center;
      justify-content: center;
      border-radius: var(--radius-sm);
      cursor: pointer;
    }

    .canvas-breadcrumb {
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 0;
      min-width: 0;
    }
    .breadcrumb-trail {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 0.875rem;
      max-width: 100%;
      white-space: nowrap;
    }
    .breadcrumb-organization { font-weight: 600; color: var(--text-main); overflow: hidden; text-overflow: ellipsis; }
    .breadcrumb-sep { color: var(--text-subtle); }
    .breadcrumb-page { color: var(--text-muted); font-weight: 500; flex-shrink: 0; }
    /* The console's own address. */
    .breadcrumb-host {
      font-family: var(--font-mono);
      font-size: 0.6875rem;
      color: var(--text-subtle);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      max-width: 100%;
    }

    /* The live counters: one quiet segmented readout rather than three pills. */
    .canvas-header-center {
      grid-column: 2;
      display: flex;
      align-items: center;
      flex-wrap: nowrap;
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: 999px;
      padding: 2px;
      box-shadow: var(--shadow-sm);
    }

    .stat-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 3px 12px;
      font-size: 0.75rem;
      line-height: 1.4;
    }
    .stat-pill + .stat-pill { border-left: 1px solid var(--border-subtle); }
    .stat-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
    .stat-label { color: var(--text-muted); }
    .stat-val { color: var(--text-main); font-weight: 600; font-variant-numeric: tabular-nums; white-space: nowrap; }
    @keyframes stat-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.6; }
    }
    .dot-green { background: var(--success); box-shadow: 0 0 0 3px var(--success-glow); animation: stat-pulse 3s infinite ease-in-out; }
    .dot-red { background: var(--danger); }
    .dot-yellow { background: var(--warning); }
    .dot-blue { background: var(--accent); }
    .dot-neutral { background: var(--neutral); }

    .canvas-header-right {
      grid-column: 3;
      display: flex;
      align-items: center;
      justify-content: flex-end;
      gap: 12px;
    }

    .user-pill {
      display: flex;
      align-items: center;
      gap: 8px;
      background: var(--bg-surface);
      border: 1px solid var(--border);
      padding: 4px 10px;
      border-radius: 999px;
      font-size: 0.75rem;
    }
    .user-name { font-weight: 600; color: var(--text-main); }
    .user-role {
      font-size: 0.6875rem;
      background: var(--accent-soft);
      padding: 1px 7px;
      border-radius: 999px;
      color: var(--accent-text);
      font-weight: 500;
    }

    .btn-logout {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text-muted);
      padding: 6px 12px;
      border-radius: var(--radius-sm);
      font-size: 0.75rem;
      font-weight: 500;
      cursor: pointer;
      transition: background-color 0.15s ease, color 0.15s ease;
    }
    .btn-logout:hover {
      background: var(--danger-soft);
      color: var(--danger-text);
    }

    /* Main Body */
    .canvas-body {
      flex: 1;
      padding: 28px 28px 48px;
      max-width: 1600px;
      width: 100%;
      margin: 0 auto;
    }

    /* Backdrop for mobile drawer */
    .panel-backdrop {
      display: none;
      position: fixed;
      inset: 0;
      background: var(--overlay);
      z-index: 1005;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.25s ease;
    }

    /* Shared Page Header & Card Layout */
    .page-head {
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      gap: 16px;
      margin-bottom: 20px;
      flex-wrap: wrap;
    }
    .page-title {
      font-size: 1.375rem;
      font-weight: 650;
      letter-spacing: -0.02em;
      line-height: 1.25;
    }
    .page-desc {
      font-size: 0.8125rem;
      color: var(--text-muted);
      margin-top: 4px;
      max-width: 72ch;
      text-wrap: pretty;
    }

    .card {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: clamp(16px, 2.2vw, 24px);
      margin-bottom: 20px;
      box-shadow: var(--shadow-sm);
      transition: border-color 0.15s ease, box-shadow 0.15s ease;
    }
    .card:hover {
      border-color: var(--border-input);
    }
    .card-title {
      font-size: 0.9375rem;
      font-weight: 650;
      letter-spacing: -0.01em;
      margin-bottom: 4px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .card-sub {
      font-size: 0.8125rem;
      color: var(--text-muted);
      margin-bottom: 18px;
      text-wrap: pretty;
    }

    /* In-canvas filter chips and controls bar */
    .controls-bar {
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-bottom: 16px;
    }
    .filter-chips { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
    .card-head .filter-chips { margin-bottom: 0; }
    .filter-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      min-height: 28px;
      padding: 2px 10px;
      border-radius: var(--radius-pill);
      font-size: 0.75rem;
      font-weight: 500;
      color: var(--text-muted);
      background: var(--bg-surface);
      border: 1px solid var(--border);
      cursor: pointer;
      font-family: inherit;
      transition: color 0.12s ease, border-color 0.12s ease, background-color 0.12s ease;
    }
    .filter-chip:hover { color: var(--text-main); border-color: var(--border-input); background: var(--hover); }
    .filter-chip.active { color: var(--accent-text); background: var(--accent-soft); border-color: var(--accent); font-weight: 600; }
    .chip-badge {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-width: 18px;
      height: 18px;
      padding: 0 5px;
      border-radius: var(--radius-pill);
      font-size: 0.6875rem;
      font-weight: 600;
      line-height: 1;
      background: var(--bg-subtle);
      color: var(--text-muted);
    }
    .filter-chip.active .chip-badge,
    .segmented-tab.active .chip-badge {
      background: var(--accent);
      color: var(--accent-fg);
    }

    /* Grid density toggle */
    .density-toggle {
      display: inline-flex;
      align-items: center;
      background: var(--bg-subtle);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 2px;
      gap: 2px;
    }
    .density-btn {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      min-height: 26px;
      padding: 2px 8px;
      border-radius: var(--radius-xs);
      font-size: 0.75rem;
      font-weight: 500;
      color: var(--text-muted);
      background: transparent;
      border: none;
      cursor: pointer;
      font-family: inherit;
      transition: color 0.12s ease, background-color 0.12s ease, box-shadow 0.12s ease;
      user-select: none;
    }
    .density-btn:hover { color: var(--text-main); background: var(--hover); }
    .density-btn.active { color: var(--text-main); background: var(--bg-surface); font-weight: 600; box-shadow: var(--shadow-sm); }

    .hidden { display: none !important; }

    /* A tinted note inside a page: information, a warning, or a confirmation. */
    .callout {
      display: flex;
      align-items: flex-start;
      gap: 10px;
      background: var(--accent-soft);
      border: 1px solid var(--border);
      border-left: 3px solid var(--accent);
      border-radius: var(--radius-sm);
      padding: 10px 14px;
      font-size: 0.8125rem;
      line-height: 1.55;
      color: var(--text-main);
      margin-bottom: 16px;
    }
    .callout > svg { flex-shrink: 0; margin-top: 2px; color: var(--accent-text); }
    .callout-success { background: var(--success-soft); border-left-color: var(--success); }
    .callout-success > svg { color: var(--success-text); }
    .callout-warning { background: var(--warning-soft); border-left-color: var(--warning); }
    .callout-warning > svg { color: var(--warning-text); }
    .callout-danger { background: var(--danger-soft); border-left-color: var(--danger); }
    .callout-danger > svg { color: var(--danger-text); }
    .callout strong { font-weight: 600; }

    /* Key figures: a row of neutral tiles. */
    .stat-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(min(200px, 100%), 1fr));
      gap: 12px;
    }
    .stat-tile {
      background: var(--bg-subtle);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
      padding: 12px 14px;
      min-width: 0;
    }
    .stat-tile-label {
      font-size: 0.75rem;
      font-weight: 500;
      color: var(--text-muted);
    }
    .stat-tile-value {
      font-size: 1.0625rem;
      font-weight: 600;
      margin-top: 2px;
      font-variant-numeric: tabular-nums;
      overflow-wrap: anywhere;
    }
    .stat-tile-hint { font-size: 0.75rem; color: var(--text-subtle); margin-top: 2px; }

    /* Key-value list (panel summaries, detail blocks). */
    .kv-list { display: flex; flex-direction: column; gap: 6px; padding: 0 8px; font-size: 0.8125rem; }
    .kv-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; color: var(--text-muted); }
    .kv-row strong { color: var(--text-main); font-weight: 600; font-variant-numeric: tabular-nums; }
    .panel-note {
      font-size: 0.75rem;
      line-height: 1.55;
      color: var(--text-muted);
      padding: 0 8px;
      text-wrap: pretty;
    }

    /* The batch command bar above the workstation grid. */
    .toolbar {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 6px;
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: var(--shadow-sm);
      padding: 6px;
      margin-bottom: 20px;
      position: sticky;
      top: 64px;
      z-index: 20;
    }
    .toolbar-group { display: flex; align-items: center; gap: 4px; flex-wrap: wrap; }
    .toolbar-group > .btn { padding: 0 10px; }
    .toolbar-divider { width: 1px; align-self: stretch; min-height: 24px; background: var(--border); margin: 0 1px; }
    .toolbar-count {
      font-size: 0.75rem;
      color: var(--text-muted);
      font-weight: 500;
      font-variant-numeric: tabular-nums;
      padding: 0 6px;
      white-space: nowrap;
    }
    .toolbar-spacer { flex: 1; }
    @media (max-width: 640px) { .toolbar-divider, .toolbar-spacer { display: none; } }
    .btn-chevron { width: 12px; height: 12px; margin-right: -2px; color: var(--text-subtle); }

    /* A menu opened from a button (the popover API): positioned under its
       trigger by the shell script, light-dismissed by the browser. */
    .menu-popover {
      position: fixed;
      inset: auto;
      margin: 0;
      min-width: 232px;
      padding: 4px;
      background: var(--bg-surface);
      color: var(--text-main);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: var(--shadow-lg);
    }
    .menu-popover:popover-open { display: flex; flex-direction: column; gap: 1px; }
    .menu-item {
      display: flex;
      align-items: center;
      gap: 10px;
      min-height: 34px;
      padding: 6px 10px;
      border-radius: var(--radius-sm);
      background: transparent;
      border: none;
      width: 100%;
      text-align: left;
      font: inherit;
      font-size: 0.8125rem;
      font-weight: 500;
      color: var(--text-main);
      cursor: pointer;
    }
    .menu-item > svg { width: 15px; height: 15px; flex-shrink: 0; color: var(--text-muted); }
    .menu-item:hover:not(:disabled) { background: var(--hover); }
    .menu-item:disabled { opacity: 0.5; cursor: not-allowed; }
    .menu-item-text { display: flex; flex-direction: column; min-width: 0; }
    .menu-item-hint { font-size: 0.75rem; font-weight: 400; color: var(--text-muted); }
    .menu-item-danger, .menu-item-danger > svg { color: var(--danger-text); }
    .menu-item-danger:hover:not(:disabled) { background: var(--danger-soft); }
    .menu-separator { height: 1px; background: var(--border-subtle); margin: 4px -4px; }

    /* Workstation grid, and the placeholder it shows while telemetry is empty. */
    .kiosk-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(min(280px, 100%), 1fr));
      gap: 16px;
    }
    /* A workstation card. */
    .kiosk-card {
      display: flex;
      flex-direction: column;
      gap: 10px;
      padding: 12px;
      margin-bottom: 0;
      border-radius: var(--radius);
      transition: border-color 0.15s ease, box-shadow 0.15s ease, transform 0.15s ease;
    }
    .kiosk-card:hover { border-color: var(--border-input); transform: translateY(-2px); box-shadow: var(--shadow-md); }
    .kc-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; min-width: 0; }
    .kc-id {
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 600;
      font-size: 0.8125rem;
      font-family: var(--font-mono);
      min-width: 0;
    }
    .kc-badges { display: flex; align-items: center; gap: 4px; }
    .kc-thumb-box {
      position: relative;
      width: 100%;
      aspect-ratio: 16 / 10;
      background: var(--thumb-scrim);
      border-radius: var(--radius-sm);
      overflow: hidden;
      border: 1px solid var(--border-subtle);
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .kc-thumb { width: 100%; height: 100%; object-fit: cover; display: none; }
    .kc-thumb.live { display: block; }
    .kc-placeholder { color: var(--text-subtle); font-size: 0.75rem; font-weight: 500; }
    .kc-actions { display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
    .kc-actions > .btn:first-child { grid-column: 1 / -1; }
    .kc-footer {
      display: flex;
      justify-content: space-between;
      gap: 10px;
      font-size: 0.75rem;
      color: var(--text-subtle);
      padding-top: 8px;
      border-top: 1px solid var(--border-subtle);
      min-width: 0;
    }
    .kc-url { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1; }
    .kc-ip { font-family: var(--font-mono); font-size: 0.6875rem; white-space: nowrap; }
    .kc-update { font-size: 0.6875rem; color: var(--text-subtle); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
    .kc-update-ready { color: var(--accent-text); }
    .kc-update-error { color: var(--danger-text); }
    .kc-update-warn { color: var(--warning-text); }

    /* Compact density: one line per machine and no thumbnails at all. */
    .kiosk-grid.compact { grid-template-columns: 1fr; gap: 6px; }
    .kiosk-grid.compact .kiosk-card {
      flex-direction: row;
      align-items: center;
      gap: 16px;
      padding: 8px 12px;
    }
    .kiosk-grid.compact .kc-thumb-box { display: none; }
    .kiosk-grid.compact .kc-update { flex: 0 1 auto; }
    .kiosk-grid.compact .kc-head { flex: 0 0 auto; min-width: 190px; }
    .kiosk-grid.compact .kc-footer {
      flex: 1;
      justify-content: flex-start;
      gap: 18px;
      border-top: none;
      padding-top: 0;
    }
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
      background: var(--bg-surface);
      border: 1px dashed var(--border-input);
      border-radius: var(--radius);
      padding: 56px 24px;
      text-align: center;
      color: var(--text-muted);
      font-size: 0.8125rem;
    }
    .empty-lab-title {
      font-size: 0.9375rem;
      font-weight: 600;
      color: var(--text-main);
      margin-bottom: 6px;
    }

    /* Workstation Groups and Section Dividers */
    .group-section {
      grid-column: 1 / -1;
      width: 100%;
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: var(--shadow-sm);
      overflow: hidden;
      margin-bottom: 4px;
    }
    .group-section-header {
      display: flex;
      align-items: center;
      gap: 10px;
      min-height: 44px;
      padding: 6px 14px;
      border-bottom: 1px solid var(--border-subtle);
      cursor: pointer;
      user-select: none;
    }
    .group-section-header:hover { background: var(--hover); }
    .group-section.collapsed .group-section-header {
      border-bottom: none;
    }
    .group-collapse-btn {
      background: transparent;
      border: none;
      color: var(--text-muted);
      cursor: pointer;
      width: 24px;
      height: 24px;
      border-radius: var(--radius-xs);
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
      font-size: 0.875rem;
      font-weight: 600;
      color: var(--text-main);
    }
    .group-count-badge {
      font-size: 0.75rem;
      font-weight: 500;
      color: var(--text-muted);
      background: var(--bg-subtle);
      padding: 1px 8px;
      border-radius: 999px;
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    .group-cards-grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(min(280px, 100%), 1fr));
      gap: 12px;
      padding: 12px;
      background: var(--bg-base);
    }
    .group-section.collapsed .group-cards-grid {
      display: none;
    }
    .kiosk-grid.compact .group-cards-grid {
      grid-template-columns: 1fr;
      gap: 6px;
      padding: 8px;
    }
    .kc-select-checkbox {
      width: 16px;
      height: 16px;
      cursor: pointer;
      accent-color: var(--accent);
      margin: 0 2px 0 0;
    }
    .kiosk-card.selected {
      border-color: var(--accent);
      box-shadow: 0 0 0 1px var(--accent), var(--shadow-sm);
    }
    /* A row of chips with its own name in front: workstation groups, mail types. */
    .chip-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px 10px; margin-bottom: 14px; }
    .chip-row-label {
      font-size: 0.6875rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      color: var(--text-subtle);
    }
    .filter-chip > .truncate { max-width: 180px; }
    /* A chip with its own remove button: the pair reads as one pill. */
    .chip-group { display: inline-flex; align-items: center; gap: 1px; }
    .panel-link-btn {
      background: transparent;
      border: none;
      color: var(--accent-text);
      cursor: pointer;
      padding: 2px 6px;
      border-radius: var(--radius-xs);
      font: inherit;
      font-size: 0.75rem;
      font-weight: 600;
      letter-spacing: normal;
      text-transform: none;
    }
    .panel-link-btn:hover { background: var(--hover); }
    .icon-btn {
      background: transparent;
      border: none;
      color: var(--text-subtle);
      cursor: pointer;
      width: 26px;
      height: 26px;
      border-radius: var(--radius-xs);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      font-size: 0.75rem;
      transition: color 0.12s ease, background-color 0.12s ease;
    }
    .icon-btn:hover { color: var(--danger-text); background: var(--danger-soft); }

    /* A saved broadcast preset, and one allowed domain. */
    .preset-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 10px 14px;
      margin-bottom: 8px;
    }
    .domain-tag {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: var(--bg-subtle);
      border: 1px solid var(--border);
      border-radius: 999px;
      padding: 3px 6px 3px 12px;
      font-size: 0.8125rem;
      font-family: var(--font-mono);
    }
    .chip-list { display: flex; flex-wrap: wrap; gap: 8px; }
    .empty-note { color: var(--text-muted); font-size: 0.8125rem; }
    .section-label { font-size: 0.8125rem; font-weight: 600; margin-bottom: 10px; }
    .form-section { padding-bottom: 20px; margin-bottom: 20px; border-bottom: 1px solid var(--border-subtle); }
    .code-chip {
      display: inline-block;
      margin-top: 6px;
      padding: 2px 8px;
      border-radius: var(--radius-xs);
      background: var(--bg-subtle);
      border: 1px solid var(--border-subtle);
      color: var(--text-main);
      overflow-wrap: anywhere;
    }

    /* A User Portal app as the console lists it. */
    .app-tile-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(260px, 100%), 1fr)); gap: 12px; }
    .app-tile {
      display: flex;
      flex-direction: column;
      gap: 12px;
      padding: 14px;
      background: var(--bg-card);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      min-width: 0;
    }
    .app-tile-head { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .app-tile-icon {
      width: 36px;
      height: 36px;
      border-radius: var(--radius-sm);
      background: var(--bg-subtle);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 1.125rem;
      flex-shrink: 0;
    }
    .app-tile-actions { display: flex; align-items: center; gap: 6px; padding-top: 10px; border-top: 1px solid var(--border-subtle); }

    /* Segmented Navigation Tabs */
    .segmented-nav {
      display: inline-flex;
      align-items: center;
      background: var(--bg-subtle);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius);
      padding: 3px;
      gap: 3px;
      max-width: 100%;
      overflow-x: auto;
      scrollbar-width: none;
      margin-bottom: 20px;
    }
    .segmented-tab {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      min-height: 32px;
      padding: 5px 14px;
      border-radius: var(--radius-sm);
      font-size: 0.8125rem;
      font-weight: 500;
      color: var(--text-muted);
      background: transparent;
      border: none;
      cursor: pointer;
      font-family: inherit;
      white-space: nowrap;
      transition: color 0.14s ease, background-color 0.14s ease, box-shadow 0.14s ease;
      text-decoration: none;
      user-select: none;
    }
    .segmented-tab:hover {
      color: var(--text-main);
      background: var(--hover);
    }
    .segmented-tab.active {
      color: var(--text-main);
      background: var(--bg-surface);
      font-weight: 600;
      box-shadow: var(--shadow-sm), 0 0 0 1px var(--border);
    }
    /* A row of view tabs with the view's one action at its end. */
    .view-bar {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      flex-wrap: wrap;
      margin-bottom: 20px;
    }
    .view-bar > .segmented-nav { margin-bottom: 0; }
    .tab-pane {
      display: none;
    }
    .tab-pane.active {
      display: block;
    }

    .grid-2col {
      display: grid;
      /* min(): a 320px floor allows 2-column cards to fit gracefully on laptop screens */
      grid-template-columns: repeat(auto-fit, minmax(min(320px, 100%), 1fr));
      gap: 20px;
      align-items: start;
    }
    /* A wide table scrolls inside its card instead of widening the column. */
    .grid-2col > * { min-width: 0; }
    /* A narrow form beside a wide list (the staff page). */
    .grid-sidebar {
      display: grid;
      grid-template-columns: minmax(0, 360px) minmax(0, 1fr);
      gap: 20px;
      align-items: start;
    }
    @media (max-width: 980px) { .grid-sidebar { grid-template-columns: minmax(0, 1fr); } }

    /* Buttons: one neutral family, one solid accent for the primary action, and
       red only where the action is destructive. */
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      min-height: 34px;
      padding: 0 14px;
      border-radius: var(--radius-sm);
      font-size: 0.8125rem;
      font-weight: 500;
      line-height: 1.2;
      cursor: pointer;
      border: 1px solid transparent;
      background: transparent;
      color: var(--text-main);
      transition: background-color 0.12s ease, border-color 0.12s ease, color 0.12s ease, box-shadow 0.12s ease, transform 0.08s ease;
      font-family: inherit;
      text-decoration: none;
      white-space: nowrap;
      user-select: none;
    }
    .btn:active:not(:disabled) { transform: scale(0.98); }
    .btn svg { flex-shrink: 0; width: 15px; height: 15px; }
    .btn:disabled { opacity: 0.5; cursor: not-allowed; }
${BUSY_CSS}    .btn.is-loading::before, .menu-item.is-loading::before, .profile-menu-item.is-loading::before { margin-inline-end: 0; }
    .btn-primary { background: var(--accent); color: var(--accent-fg); box-shadow: var(--shadow-sm); }
    .btn-primary:hover:not(:disabled) { background: var(--accent-hover); }
    .btn-secondary {
      background: var(--bg-surface);
      color: var(--text-main);
      border-color: var(--border);
      box-shadow: var(--shadow-sm);
    }
    .btn-secondary:hover:not(:disabled) { background: var(--bg-card-hover); border-color: var(--border-input); }
    .btn-ghost { color: var(--text-muted); }
    .btn-ghost:hover:not(:disabled) { background: var(--hover); color: var(--text-main); }
    .btn-danger {
      background: var(--bg-surface);
      color: var(--danger-text);
      border-color: var(--border);
      box-shadow: var(--shadow-sm);
    }
    .btn-danger:hover:not(:disabled) { background: var(--danger); color: var(--on-solid); border-color: var(--danger); }
    .btn-warning {
      background: var(--bg-surface);
      color: var(--text-main);
      border-color: var(--border);
      box-shadow: var(--shadow-sm);
    }
    .btn-warning svg { color: var(--warning); }
    .btn-warning:hover:not(:disabled) { background: var(--warning-soft); border-color: var(--warning); }
    .btn-success {
      background: var(--bg-surface);
      color: var(--text-main);
      border-color: var(--border);
      box-shadow: var(--shadow-sm);
    }
    .btn-success svg { color: var(--success); }
    .btn-success:hover:not(:disabled) { background: var(--success-soft); border-color: var(--success); }
    .btn-sm { min-height: 28px; padding: 0 10px; font-size: 0.75rem; }
    .btn-sm svg { width: 13px; height: 13px; }
    .btn-block { width: 100%; }
    .btn-icon { padding: 0; width: 28px; }

    /* Form Controls */
    .form-group { margin-bottom: 16px; }
    .form-label {
      display: block;
      font-size: 0.8125rem;
      font-weight: 500;
      margin-bottom: 6px;
      color: var(--text-main);
    }
    .form-hint { font-size: 0.75rem; color: var(--text-muted); margin-top: 6px; line-height: 1.5; text-wrap: pretty; }
    .form-input, .form-select, .form-textarea {
      width: 100%;
      min-height: 36px;
      background: var(--bg-card);
      border: 1px solid var(--border-input);
      border-radius: var(--radius-sm);
      padding: 7px 11px;
      color: var(--text-main);
      font-size: 0.875rem;
      line-height: 1.4;
      font-family: inherit;
      transition: border-color 0.12s ease, box-shadow 0.12s ease;
    }
    .form-input::placeholder, .form-textarea::placeholder { color: var(--text-subtle); opacity: 1; }
    .form-input:hover:not(:focus):not(:disabled),
    .form-select:hover:not(:focus):not(:disabled),
    .form-textarea:hover:not(:focus):not(:disabled) { border-color: var(--text-subtle); }
    .form-input:focus-visible, .form-select:focus-visible, .form-textarea:focus-visible {
      outline: none;
      border-color: var(--border-focus);
      box-shadow: var(--focus-ring);
    }
    .form-input:user-invalid, .form-textarea:user-invalid, .form-select:user-invalid { border-color: var(--danger); }
    .form-input:disabled, .form-select:disabled, .form-textarea:disabled { background: var(--bg-subtle); color: var(--text-muted); cursor: not-allowed; }
    .form-input[readonly] { background: var(--bg-subtle); }
    .form-select {
      appearance: none;
      -webkit-appearance: none;
      padding-right: 34px;
      cursor: pointer;
      background-image:
        linear-gradient(45deg, transparent 50%, var(--text-muted) 50%),
        linear-gradient(135deg, var(--text-muted) 50%, transparent 50%);
      background-position: calc(100% - 17px) 55%, calc(100% - 12px) 55%;
      background-size: 5px 5px, 5px 5px;
      background-repeat: no-repeat;
    }
    .form-textarea { min-height: 88px; resize: vertical; line-height: 1.5; }
    .form-row { display: flex; gap: 10px; align-items: flex-end; }
    .form-row > .form-group { flex: 1; min-width: 0; margin-bottom: 0; }
    .form-actions { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; margin-top: 4px; }
    .form-checkbox {
      appearance: none;
      -webkit-appearance: none;
      width: 16px;
      height: 16px;
      border: 1px solid var(--border-input);
      border-radius: var(--radius-xs);
      background: var(--bg-card);
      cursor: pointer;
      display: inline-grid;
      place-content: center;
      margin: 0;
      vertical-align: middle;
      transition: background-color 0.12s ease, border-color 0.12s ease;
      flex-shrink: 0;
    }
    .form-checkbox:hover { border-color: var(--accent); }
    .form-checkbox:checked {
      background-color: var(--accent);
      border-color: var(--accent);
      background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 16 16' fill='none' stroke='white' stroke-width='2.2' stroke-linecap='round' stroke-linejoin='round' xmlns='http://www.w3.org/2000/svg'%3E%3Cpolyline points='3.5 8.5 6.5 11.5 12.5 4.5'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: center;
      background-size: 12px 12px;
    }
    .form-checkbox-label {
      display: flex;
      align-items: center;
      gap: 10px;
      min-height: 28px;
      font-size: 0.8125rem;
      color: var(--text-main);
      cursor: pointer;
      user-select: none;
    }
    .checkbox-list { display: flex; flex-direction: column; gap: 2px; }

    /* One editable block on the organization homepage. */
    .homepage-block-row {
      display: grid;
      grid-template-columns: 1fr auto;
      gap: 8px;
      align-items: start;
      background: var(--bg-subtle);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
      padding: 12px;
      margin-bottom: 10px;
    }
    #homepage-blocks:not(:empty) { margin-bottom: 12px; }
    .homepage-block-row > textarea,
    .homepage-block-row > input { grid-column: 1; }
    .homepage-block-row > .btn { grid-column: 2; grid-row: 1; }
    @media (max-width: 620px) {
      .homepage-block-row { grid-template-columns: 1fr; }
      .homepage-block-row > .btn { grid-column: 1; grid-row: auto; justify-self: start; }
    }

    /* Tables */
    .table-container {
      /* Positioned, so an absolutely placed descendant (the visually hidden
         "Actions" header) is clipped by this scroller instead of widening the
         page: a phone would otherwise render the whole console zoomed out. */
      position: relative;
      overflow-x: auto;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: var(--bg-surface);
      box-shadow: var(--shadow-sm);
    }
    .card > .table-container { box-shadow: none; }
    .table-scrollable {
      max-height: 480px;
      overflow-y: auto;
      scrollbar-width: thin;
      scrollbar-color: var(--border-input) transparent;
    }
    .table-scrollable th {
      position: sticky;
      top: 0;
      z-index: 2;
      box-shadow: inset 0 -1px 0 var(--border);
    }
    @supports not (scrollbar-color: auto) {
      .table-scrollable::-webkit-scrollbar { width: 8px; height: 8px; }
      .table-scrollable::-webkit-scrollbar-thumb { background: var(--border-input); border-radius: 4px; }
      .table-scrollable::-webkit-scrollbar-track { background: transparent; }
    }
    table {
      width: 100%;
      border-collapse: collapse;
      text-align: left;
      font-size: 0.8125rem;
      font-variant-numeric: tabular-nums;
    }
    th {
      background: var(--bg-subtle);
      padding: 9px 16px;
      font-weight: 500;
      font-size: 0.75rem;
      color: var(--text-muted);
      border-bottom: 1px solid var(--border);
      white-space: nowrap;
      text-align: left;
    }
    td { padding: 11px 16px; border-bottom: 1px solid var(--border-subtle); vertical-align: middle; }
    tbody tr:last-child td { border-bottom: none; }
    tbody tr:hover td { background: var(--hover); }
    .cell-title { font-weight: 600; color: var(--text-main); }
    .cell-sub { font-size: 0.75rem; color: var(--text-muted); margin-top: 1px; }
    .cell-actions { display: flex; align-items: center; justify-content: flex-end; gap: 6px; flex-wrap: nowrap; }
    .table-empty { text-align: center; color: var(--text-muted); padding: 32px 16px; }
    .cell-detail { overflow-wrap: anywhere; }
    .cell-org { min-width: 180px; max-width: 280px; }
    .cell-clamp {
      display: -webkit-box;
      -webkit-line-clamp: 2;
      -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .restricted-note {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      font-size: 0.75rem;
      color: var(--text-subtle);
      white-space: nowrap;
      padding: 0 6px;
    }
    .form-narrow { max-width: 640px; }
    .form-grid-2 { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(220px, 100%), 1fr)); gap: 0 12px; }
    /* Super Admin Tasks and Support: a list of conversations beside the open one. */
    .inbox-layout { display: grid; grid-template-columns: minmax(260px, 340px) minmax(0, 1fr); gap: 20px; align-items: start; }
    .inbox-list {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: var(--shadow-sm);
      max-height: calc(100dvh - 220px);
      overflow-y: auto;
    }
    .inbox-item {
      display: block;
      width: 100%;
      text-align: left;
      padding: 12px 14px;
      border: 0;
      border-bottom: 1px solid var(--border-subtle);
      background: transparent;
      color: var(--text-main);
      font: inherit;
      cursor: pointer;
    }
    .inbox-item:last-child { border-bottom: 0; }
    .inbox-item:hover { background: var(--hover); }
    .inbox-item:focus-visible { outline: 2px solid var(--border-focus); outline-offset: -2px; }
    .inbox-item[aria-current="true"] { background: var(--accent-soft); }
    .inbox-item-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
    .inbox-item-title { font-size: 0.875rem; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .inbox-item-unread .inbox-item-title::before { content: ""; display: inline-block; width: 7px; height: 7px; margin-right: 6px; border-radius: 50%; background: var(--accent); vertical-align: middle; }
    .inbox-item-meta { margin-top: 4px; font-size: 0.75rem; color: var(--text-muted); display: flex; gap: 8px; flex-wrap: wrap; }
    .inbox-empty { padding: 28px 16px; text-align: center; color: var(--text-muted); font-size: 0.8125rem; }
    .inbox-detail { min-width: 0; }
    .detail-grid { display: grid; grid-template-columns: minmax(120px, max-content) minmax(0, 1fr); gap: 6px 16px; font-size: 0.8125rem; }
    .detail-grid dt { color: var(--text-muted); }
    .detail-grid dd { margin: 0; overflow-wrap: anywhere; }
    .msg-thread { display: flex; flex-direction: column; gap: 10px; }
    .msg { border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 10px 14px; background: var(--bg-surface); }
    .msg-inbound { border-left: 3px solid var(--accent); }
    .msg-outbound { border-left: 3px solid var(--success); background: var(--bg-subtle); }
    .msg-note { border-left: 3px solid var(--warning); background: var(--warning-soft); }
    .msg-event { border-style: dashed; background: transparent; }
    .msg-meta { display: flex; justify-content: space-between; gap: 8px; flex-wrap: wrap; font-size: 0.75rem; color: var(--text-muted); margin-bottom: 6px; }
    .msg-body { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 0.875rem; line-height: 1.55; margin: 0; font-family: var(--font-sans); }
    .msg-attachments { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
    .msg-attachment {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      max-width: 100%;
      padding: 3px 10px;
      border: 1px solid var(--border);
      border-radius: 999px;
      background: var(--bg-subtle);
      color: var(--text-main);
      font-size: 0.75rem;
      text-decoration: none;
      overflow-wrap: anywhere;
    }
    .msg-attachment:hover { background: var(--hover); }
    .msg-attachment:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 2px; }
    @media (max-width: 900px) {
      .inbox-layout { grid-template-columns: 1fr; }
      .inbox-list { max-height: 320px; }
    }
    .stack-cards { display: flex; flex-direction: column; gap: 20px; }
    .stack-cards > .card { margin-bottom: 0; }
    .input-suffix { font-size: 0.875rem; color: var(--text-muted); white-space: nowrap; align-self: center; }
    .callout-value { font-size: 0.9375rem; font-weight: 600; margin-top: 6px; overflow-wrap: anywhere; }
    .secret-box {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      background: var(--bg-subtle);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 10px 12px 10px 16px;
      margin-bottom: 16px;
    }
    .secret-value { font-size: 0.9375rem; font-weight: 600; letter-spacing: 0.06em; color: var(--text-main); overflow-wrap: anywhere; }
    .th-actions { width: 1%; }
    .badge-list { display: flex; flex-wrap: wrap; gap: 4px; }
    .visually-hidden {
      position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px;
      overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0;
    }

    /* A card whose body is a table edge to edge. */
    .card-flush { padding: 0; overflow: hidden; }
    .card-flush > .table-container { border: none; border-radius: 0; box-shadow: none; }
    .card-head {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
      padding: 16px 20px;
      border-bottom: 1px solid var(--border);
    }
    .card-head > .card-title { margin-bottom: 0; white-space: nowrap; }
    .card-head > .filter-chips { justify-content: flex-end; }
    .card-head .card-sub { margin-bottom: 0; }

    /* Badges: soft tints, sentence case. */
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 1px 8px;
      border-radius: 999px;
      font-size: 0.75rem;
      font-weight: 500;
      line-height: 1.5;
      white-space: nowrap;
      background: var(--bg-subtle);
      color: var(--text-muted);
      border: 1px solid transparent;
    }
    .badge-green { background: var(--success-soft); color: var(--success-text); }
    .badge-blue { background: var(--accent-soft); color: var(--accent-text); }
    .badge-yellow { background: var(--warning-soft); color: var(--warning-text); }
    .badge-red { background: var(--danger-soft); color: var(--danger-text); }
    .badge-neutral { background: var(--bg-subtle); color: var(--text-muted); border-color: var(--border-subtle); }

    /* ---------------------------------------------------------------------- */
    /* Toasts and dialogs                                                     */
    /* ---------------------------------------------------------------------- */
    .lk-toast-stack {
      position: fixed;
      bottom: 18px;
      right: 18px;
      z-index: 3000;
      display: flex;
      flex-direction: column;
      gap: 8px;
      max-width: min(400px, calc(100vw - 36px));
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
      padding: 11px 12px 11px 14px;
      font-size: 0.8125rem;
      line-height: 1.45;
      color: var(--text-main);
      box-shadow: var(--shadow-lg);
      pointer-events: auto;
      opacity: 0;
      translate: 0 10px;
      transition: opacity 0.2s ease, translate 0.24s var(--ease-spring);
    }
    .lk-toast.visible { opacity: 1; translate: 0 0; }
    .lk-toast.success { border-left-color: var(--success); }
    .lk-toast.error { border-left-color: var(--danger); }
    .lk-toast.warning { border-left-color: var(--warning); }
    .lk-toast-text { flex: 1; min-width: 0; overflow-wrap: anywhere; }
    .lk-toast-close {
      background: transparent;
      border: none;
      color: var(--text-subtle);
      cursor: pointer;
      font-size: 0.875rem;
      line-height: 1;
      width: 22px;
      height: 22px;
      border-radius: var(--radius-xs);
    }
    .lk-toast-close:hover { color: var(--text-main); background: var(--hover); }

    .lk-dialog-overlay {
      position: fixed;
      inset: 0;
      background: var(--overlay);
      z-index: 3100;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
      opacity: 1;
      transition: opacity 0.15s ease;
    }
    .lk-dialog {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      width: 100%;
      max-width: 440px;
      padding: 20px;
      box-shadow: var(--shadow-lg);
      opacity: 1;
      scale: 1;
      transition: opacity 0.16s ease, scale 0.2s var(--ease-out);
    }
    @starting-style {
      .lk-dialog-overlay { opacity: 0; }
      .lk-dialog { opacity: 0; scale: 0.97; }
    }
    .lk-dialog-title { font-size: 1rem; font-weight: 600; margin-bottom: 6px; }
    .lk-dialog-message {
      font-size: 0.8125rem;
      color: var(--text-muted);
      line-height: 1.6;
      margin-bottom: 18px;
      overflow-wrap: anywhere;
    }
    .lk-dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }

    /* Modal Overlay (VNC remote control & quick confirmation) */
    .modal-overlay {
      position: fixed; inset: 0; background: var(--overlay);
      z-index: 2000; display: none; align-items: center; justify-content: center; padding: 20px;
    }
    .modal-overlay.active { display: flex; }
    .modal-box {
      background: var(--bg-surface); border: 1px solid var(--border); border-radius: var(--radius-lg);
      width: 100%; max-width: 560px; max-height: calc(100dvh - 40px); overflow-y: auto;
      padding: 24px; position: relative; box-shadow: var(--shadow-lg);
      opacity: 1; scale: 1; transition: opacity 0.16s ease, scale 0.2s var(--ease-out);
    }
    @starting-style {
      .modal-overlay.active .modal-box { opacity: 0; scale: 0.97; }
    }
    .modal-close {
      position: absolute; top: 14px; right: 14px; background: transparent; border: none;
      color: var(--text-muted); font-size: 1.125rem; cursor: pointer; width: 32px; height: 32px;
      border-radius: var(--radius-sm); display: inline-flex; align-items: center; justify-content: center;
    }
    .modal-close:hover { color: var(--text-main); background: var(--hover); }
    .modal-title { font-size: 1.0625rem; font-weight: 600; margin-bottom: 4px; padding-right: 36px; }
    .modal-desc { font-size: 0.8125rem; color: var(--text-muted); margin-bottom: 18px; }
    .modal-actions { display: flex; justify-content: flex-end; gap: 8px; flex-wrap: wrap; margin-top: 20px; }
    .modal-sm { max-width: 480px; }
    .numbered-steps { margin: 0; padding-left: 20px; font-size: 0.875rem; }
    .recovery-codes {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 6px 16px;
      padding: 12px 14px;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      background: var(--bg-subtle);
      font-family: var(--font-mono);
      font-size: 0.875rem;
    }
    .modal-vnc {
      max-width: 1100px;
      width: 96%;
      height: 86vh;
      height: 86dvh;
      display: flex;
      flex-direction: column;
      padding: 16px;
    }
    .vnc-frame {
      flex: 1;
      width: 100%;
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      background: var(--thumb-scrim);
    }
    .form-error { color: var(--danger-text); font-size: 0.75rem; min-height: 18px; }

    /* Footer */
    .canvas-footer {
      border-top: 1px solid var(--border-subtle);
      padding: 14px 28px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      color: var(--text-subtle);
      font-size: 0.75rem;
      flex-wrap: wrap;
      gap: 12px;
      margin-top: auto;
    }
    .canvas-footer a { color: var(--text-muted); text-decoration: none; }
    .canvas-footer a:hover { color: var(--text-main); text-decoration: underline; }
    .canvas-footer-links { display: flex; gap: 16px; }

    /* ---------------------------------------------------------------------- */
    /* Mobile / Tablet Responsive Adjustments & Container Queries             */
    /* ---------------------------------------------------------------------- */
    @container canvas (max-width: 760px) {
      .controls-bar { flex-direction: column; align-items: stretch; }
    }
    @container canvas (max-width: 680px) {
      .grid-2col { grid-template-columns: 1fr; }
      .kc-actions { grid-template-columns: 1fr 1fr; }
      .kc-actions > .btn:first-child { grid-column: 1 / -1; }
    }
    @container canvas (max-width: 440px) {
      .kc-actions { grid-template-columns: 1fr; }
    }

    @media (max-width: 1024px) {
      .nav-sidebar,
      .nav-rail { width: var(--drawer-width); transform: translateX(-100%); }
      .app-canvas { margin-left: 0 !important; }
      .btn-mobile-menu { display: inline-flex; }
      .panel-backdrop { display: block; }
      .canvas-header { padding: 8px 16px; }
      .canvas-body { padding: 20px 16px 40px; }
      .canvas-footer { padding: 14px 16px; }
      .toolbar { position: static; }

      .app-layout.mobile-open .nav-sidebar,
      .app-layout.mobile-open .nav-rail {
        transform: translateX(0);
        box-shadow: var(--shadow-lg);
      }
      .app-layout.mobile-open .panel-backdrop {
        opacity: 1;
        pointer-events: auto;
      }
    }

    @media (max-width: 768px) {
      /* One column: the counters take their own full-width row under the breadcrumb. */
      .canvas-header {
        padding: 8px 14px;
        min-height: 52px;
        gap: 10px;
        grid-template-columns: minmax(0, 1fr);
      }
      .canvas-header-center { grid-column: 1; }
      .canvas-header-right { display: none; }
      .breadcrumb-trail {
        font-size: 0.8125rem;
      }
      .breadcrumb-organization {
        max-width: 140px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .canvas-header-center {
        width: 100%;
        overflow-x: auto;
        scrollbar-width: none;
        flex-wrap: nowrap;
        justify-content: flex-start;
        padding: 3px 6px;
        border-radius: var(--radius-sm);
        -webkit-overflow-scrolling: touch;
      }
      .stat-pill {
        flex-shrink: 0;
        padding: 2px 8px;
        font-size: 0.6875rem;
      }
      .canvas-body {
        padding: 16px 12px 36px;
      }
      .page-head {
        margin-bottom: 14px;
        gap: 10px;
      }
      .page-title {
        font-size: 1.25rem;
      }
      .card {
        padding: 14px 12px;
        margin-bottom: 14px;
      }
      .card-head {
        padding: 12px 14px;
      }
      .segmented-nav {
        width: 100%;
        overflow-x: auto;
        scrollbar-width: none;
        padding: 3px;
        -webkit-overflow-scrolling: touch;
      }
      .segmented-tab {
        flex-shrink: 0;
        min-height: 32px;
        padding: 4px 10px;
        font-size: 0.75rem;
      }
      .toolbar {
        padding: 6px 8px;
        gap: 6px;
        margin-bottom: 14px;
      }
      .form-row {
        flex-direction: column;
        align-items: stretch;
      }
      .form-actions {
        flex-direction: column;
        align-items: stretch;
      }
      .form-actions > .btn {
        width: 100%;
      }
    }

    @media (max-width: 640px) {
      .modal-box {
        padding: 18px 14px;
        max-width: calc(100vw - 20px);
        margin: 10px;
      }
      .lk-dialog {
        padding: 16px 14px;
        max-width: calc(100vw - 20px);
        margin: 10px;
      }
      .lk-toast-stack {
        left: 12px;
        right: 12px;
        bottom: 12px;
        max-width: calc(100vw - 24px);
      }
    }

    /* ---------------------------------------------------------------------- */
    /* Motion, page transitions and high-contrast mode                        */
    /* ---------------------------------------------------------------------- */
    @media (prefers-reduced-motion: no-preference) {
      @view-transition { navigation: auto; }
      ::view-transition-group(*) { animation-duration: 0.18s; }
    }
    @media (prefers-reduced-motion: reduce) {
      .nav-sidebar, .nav-rail, .rail-tooltip, .app-canvas, .rail-profile-menu, .lk-toast, .lk-dialog,
      .lk-dialog-overlay, .modal-box, .group-chevron, .rail-action-btn svg, .panel-backdrop {
        transition: none;
      }
    }
    @media (forced-colors: active) {
      .btn, .card, .kiosk-card, .toolbar, .callout, .badge, .segmented-nav, .canvas-header-center,
      .form-input, .form-select, .form-textarea, .form-checkbox, .lk-dialog, .modal-box, .rail-profile-menu {
        border: 1px solid CanvasText;
      }
      .rail-item.active, .segmented-tab.active, .filter-chip.active {
        outline: 2px solid Highlight;
        outline-offset: -2px;
      }
      .kiosk-card.selected { outline: 2px solid Highlight; }
      .stat-dot { forced-color-adjust: none; }
    }
`;

export function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

export const CONSOLE_STYLESHEET_PATH = `/assets/console-${fnv1a(CONSOLE_CSS)}.css`;

export function consoleStylesheet(): string {
  return CONSOLE_CSS;
}

export function renderLayoutHtml(options: LayoutOptions): string {
  const {
    title,
    brandTitle,
    brandSubtitle,
    brandIconSvg,
    navItems,
    activeNavId,
    stats = [],
    userMeta,
    logoutAction = "/api/auth/logout",
    contentHtml,
    modalsHtml = "",
    scriptsHtml = "",
    nonce
  } = options;

  const defaultBrandIcon = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`;

  const brandHref = options.brandHref || "/admin";
  const activeItem = navItems.find((item) => item.id === activeNavId) || navItems[0];
  const activeNavLabel = activeItem ? activeItem.label : "Dashboard";

  // Primary Navigation items
  const railItemsHtml = navItems
    .map((item) => {
      const isActive = item.id === activeNavId;
      return `
        <a href="${escapeAttr(item.href)}" class="sidebar-item rail-item ${isActive ? "active" : ""}" data-nav="${escapeAttr(item.id)}" aria-label="${escapeAttr(item.label)}"${isActive ? ' aria-current="page"' : ""}>
          <span class="sidebar-icon rail-icon">${item.iconSvg}</span>
          <span class="sidebar-label">${escapeHtml(item.label)}</span>
          <span class="rail-tooltip" aria-hidden="true">${escapeHtml(item.label)}</span>
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
${themeHeadHtml(nonce)}
${FONT_LINKS}
  <link rel="stylesheet" href="${CONSOLE_STYLESHEET_PATH}">
</head>
<body>
  <div class="app-layout" id="app-layout">
    <!-- Navigation rail: icons, named on hover; a labelled drawer on a phone -->
    <aside class="nav-sidebar nav-rail" id="nav-sidebar">
      <div class="sidebar-header">
        <a href="${escapeAttr(brandHref)}" class="sidebar-brand brand-glyph" title="${escapeAttr(brandTitle)}">
          <div class="brand-icon">${brandIconSvg || defaultBrandIcon}</div>
          <div class="brand-meta">
            <span class="brand-name">${escapeHtml(brandTitle)}</span>
            ${brandSubtitle ? `<span class="brand-sub">${escapeHtml(brandSubtitle)}</span>` : ""}
          </div>
        </a>
      </div>

      <nav class="sidebar-nav rail-nav" aria-label="Main Navigation">
        ${railItemsHtml}
      </nav>

      <div class="sidebar-footer rail-bottom">
        <div class="sidebar-profile-wrap rail-profile-wrap">
          <button type="button" class="sidebar-user-btn rail-user-btn" id="btn-user-profile" aria-expanded="false" aria-haspopup="true" aria-label="${escapeAttr(userMeta?.name || 'User Profile')} (${escapeAttr(userMeta?.role || 'Admin')}): account menu">
            <div class="sidebar-user-avatar rail-user-avatar">
              <span>${escapeHtml((userMeta?.name || 'A').slice(0, 1).toUpperCase())}</span>
            </div>
            <div class="sidebar-user-info user-meta">
              <span class="sidebar-user-name user-name">${escapeHtml(userMeta?.name || 'Administrator')}</span>
              <span class="sidebar-user-role user-role">${escapeHtml(userMeta?.role || 'Admin')}</span>
            </div>
            <span class="rail-tooltip" aria-hidden="true">${escapeHtml(userMeta?.name || 'Account')}</span>
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
              <a href="${escapeAttr(
                brandHref.startsWith("/super")
                  ? "/super/system?tab=system-two-factor"
                  : brandHref.includes("?")
                    ? "/admin/settings?" + brandHref.split("?")[1] + "&tab=two-factor"
                    : "/admin/settings?tab=two-factor"
              )}" class="profile-menu-link">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>
                <span>Two-factor sign-in</span>
              </a>
              <button type="button" class="profile-menu-item" data-action="toggle-theme">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor"/></svg>
                <span data-theme-label>Dark theme</span>
              </button>
              <div class="profile-menu-divider"></div>
              <form action="${escapeAttr(logoutAction)}" method="POST">
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
        <div>&copy; 2026 Lab Kiosk OS &middot; Managed browser workstations</div>
        <div class="canvas-footer-links">
          <a href="/privacy" target="_blank" rel="noopener noreferrer">Privacy Policy</a>
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
      function toggleMobileMenu() {
        layout.classList.toggle("mobile-open");
      }

      // Event delegation for actions
      document.addEventListener("click", function(e) {
        const target = e.target && e.target.closest ? e.target.closest("[data-action]") : null;
        if (!target) return;
        const action = target.getAttribute("data-action");
        if (action === "toggle-mobile-menu") {
          e.preventDefault();
          toggleMobileMenu();
        } else if (action && action.startsWith("tab-")) {
          if (typeof window.labkioskSwitchTab === "function") {
            e.preventDefault();
            window.labkioskSwitchTab(action.slice(4));
          }
        }

        // Close mobile drawer on navigation click
        if (layout.classList.contains("mobile-open")) {
          const navClick = target.closest(".sidebar-item, .rail-item, .segmented-tab, .filter-chip, .density-btn");
          if (navClick) layout.classList.remove("mobile-open");
        }
      });

      // A [popovertarget] menu opens under its trigger, right-aligned to it and
      // kept inside the viewport, and closes once one of its items is chosen.
      document.addEventListener("toggle", function(e) {
        const menu = e.target;
        if (!menu || !menu.classList || !menu.classList.contains("menu-popover") || e.newState !== "open") return;
        const trigger = document.querySelector('[popovertarget="' + menu.id + '"]');
        if (!trigger) return;
        const rect = trigger.getBoundingClientRect();
        const width = menu.offsetWidth;
        const height = menu.offsetHeight;
        const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
        const below = rect.bottom + 6;
        const top = below + height > window.innerHeight - 8 ? Math.max(8, rect.top - height - 6) : below;
        menu.style.left = left + "px";
        menu.style.top = top + "px";
      }, true);
      document.addEventListener("click", function(e) {
        const item = e.target && e.target.closest ? e.target.closest(".menu-popover .menu-item") : null;
        if (!item) return;
        const menu = item.closest(".menu-popover");
        if (menu && menu.hidePopover && menu.matches(":popover-open")) menu.hidePopover();
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
  <script nonce="${escapeAttr(nonce)}">${THEME_TOGGLE_SCRIPT}</script>
  <script nonce="${escapeAttr(nonce)}">${BUSY_SCRIPT}</script>
</body>
</html>`;
}
