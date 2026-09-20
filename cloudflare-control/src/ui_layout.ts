/**
 * Modern Responsive Dashboard Shell & Shared Layout
 * Provides navigation, sticky header, theme tokens, and clean layout structure.
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
  stats?: StatItem[];
  userMeta?: { name: string; email?: string; role: string };
  logoutAction?: string;
  contentHtml: string;
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
    stats = [],
    userMeta,
    logoutAction = "/api/auth/logout",
    contentHtml,
    scriptsHtml = "",
    nonce
  } = options;

  const defaultBrandIcon = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`;

  const navHtml = navItems
    .map((item) => {
      const isActive = item.id === activeNavId;
      return `
        <a href="${escapeAttr(item.href)}" class="nav-tab ${isActive ? "active" : ""}">
          <span class="nav-icon">${item.iconSvg}</span>
          <span class="nav-label">${escapeHtml(item.label)}</span>
          ${item.badge !== undefined ? `<span class="nav-badge">${escapeHtml(String(item.badge))}</span>` : ""}
        </a>
      `;
    })
    .join("");

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
      --accent-glow: rgba(59, 130, 246, 0.25);
      --success: #10b981;
      --danger: #ef4444;
      --warning: #f59e0b;
      --radius: 12px;
      --radius-sm: 8px;
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

    header {
      background-color: var(--bg-surface);
      border-bottom: 1px solid var(--border);
      position: sticky;
      top: 0;
      z-index: 1000;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.4);
    }

    .header-top {
      max-width: 1720px;
      margin: 0 auto;
      padding: 12px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      flex-wrap: wrap;
    }

    .brand { display: flex; align-items: center; gap: 12px; text-decoration: none; color: inherit; }
    .brand-icon {
      width: 40px; height: 40px;
      background: linear-gradient(135deg, #3b82f6, #6366f1);
      border-radius: 10px;
      display: flex; align-items: center; justify-content: center;
      box-shadow: 0 0 15px rgba(59, 130, 246, 0.4);
      flex-shrink: 0;
    }
    .brand-title { font-size: 18px; font-weight: 800; letter-spacing: -0.3px; }
    .brand-subtitle { font-size: 12px; color: var(--text-muted); }

    .header-center {
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
    }

    .stat-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      background: var(--bg-base);
      padding: 6px 14px;
      border-radius: 30px;
      border: 1px solid var(--border);
      font-size: 13px;
    }
    .stat-dot { width: 8px; height: 8px; border-radius: 50%; }
    .dot-green { background: var(--success); box-shadow: 0 0 6px var(--success); }
    .dot-red { background: var(--danger); }
    .dot-yellow { background: var(--warning); }
    .dot-blue { background: var(--accent); }

    .header-right {
      display: flex;
      align-items: center;
      gap: 14px;
    }

    .user-pill {
      display: flex;
      align-items: center;
      gap: 8px;
      background: rgba(59, 130, 246, 0.1);
      border: 1px solid rgba(59, 130, 246, 0.3);
      padding: 6px 12px;
      border-radius: 20px;
      font-size: 13px;
    }
    .user-name { font-weight: 700; color: #93c5fd; }
    .user-role {
      font-size: 11px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      background: rgba(59, 130, 246, 0.25);
      padding: 2px 6px;
      border-radius: 10px;
      color: #bfdbfe;
    }

    .btn-logout {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text-muted);
      padding: 6px 12px;
      border-radius: 8px;
      font-size: 12px;
      font-weight: 600;
      cursor: pointer;
      transition: all 0.2s;
    }
    .btn-logout:hover { background: rgba(239, 68, 68, 0.15); color: #fca5a5; border-color: rgba(239, 68, 68, 0.3); }

    /* Secondary Nav Bar (Tabs) */
    .nav-bar {
      max-width: 1720px;
      margin: 0 auto;
      padding: 0 24px;
      display: flex;
      align-items: center;
      gap: 6px;
      overflow-x: auto;
      scrollbar-width: none;
    }
    .nav-bar::-webkit-scrollbar { display: none; }

    .nav-tab {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 12px 16px;
      color: var(--text-muted);
      text-decoration: none;
      font-size: 13px;
      font-weight: 600;
      border-bottom: 2px solid transparent;
      transition: all 0.2s;
      white-space: nowrap;
    }
    .nav-tab:hover { color: var(--text-main); background: rgba(255, 255, 255, 0.02); }
    .nav-tab.active {
      color: var(--accent);
      border-bottom-color: var(--accent);
      background: rgba(59, 130, 246, 0.05);
    }
    .nav-icon { display: flex; align-items: center; }
    .nav-badge {
      background: rgba(59, 130, 246, 0.2);
      color: #93c5fd;
      font-size: 11px;
      padding: 2px 6px;
      border-radius: 10px;
      font-weight: 700;
    }

    /* Main Container */
    main {
      flex: 1;
      max-width: 1720px;
      width: 100%;
      margin: 0 auto;
      padding: 28px 24px 60px;
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
    .page-title { font-size: 24px; font-weight: 800; letter-spacing: -0.4px; }
    .page-desc { font-size: 14px; color: var(--text-muted); margin-top: 4px; }

    .card {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 24px;
      margin-bottom: 24px;
    }
    .card-title {
      font-size: 18px;
      font-weight: 700;
      margin-bottom: 8px;
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .card-sub { font-size: 13px; color: var(--text-muted); margin-bottom: 20px; }

    .grid-2col {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(400px, 1fr));
      gap: 24px;
    }

    /* Buttons */
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      padding: 9px 18px;
      border-radius: var(--radius-sm);
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
    .btn-secondary { background: var(--bg-card); color: var(--text-main); border-color: var(--border); }
    .btn-secondary:hover { background: var(--bg-card-hover); }
    .btn-danger { background: rgba(239, 68, 68, 0.15); color: #fca5a5; border-color: rgba(239, 68, 68, 0.3); }
    .btn-danger:hover { background: var(--danger); color: #fff; }
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
      font-size: 14px;
      font-family: inherit;
      transition: border-color 0.2s;
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
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: var(--bg-surface);
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
    tr:hover td { background: rgba(255, 255, 255, 0.015); }

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

    /* Modal Overlay (used only for VNC remote control & quick confirmation) */
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

    footer {
      background: var(--bg-surface);
      border-top: 1px solid var(--border);
      padding: 18px 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      color: var(--text-muted);
      font-size: 13px;
      flex-wrap: wrap;
      gap: 12px;
    }
    footer a { color: var(--text-muted); text-decoration: none; }
    footer a:hover { color: var(--accent); }
  </style>
</head>
<body>
  <header>
    <div class="header-top">
      <a href="/admin" class="brand">
        <div class="brand-icon">${brandIconSvg || defaultBrandIcon}</div>
        <div>
          <div class="brand-title">${escapeHtml(brandTitle)}</div>
          <div class="brand-subtitle">${escapeHtml(brandSubtitle)}</div>
        </div>
      </a>

      ${stats.length ? `<div class="header-center">${statsHtml}</div>` : ""}

      <div class="header-right">
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
    </div>

    <nav class="nav-bar">
      ${navHtml}
    </nav>
  </header>

  <main>
    ${contentHtml}
  </main>

  <footer>
    <div>&copy; 2026 Lab Kiosk OS • Educational Environment Restricted • 100% In-Memory RAM Overlay</div>
    <div style="display: flex; gap: 16px;">
      <a href="/privacy" target="_blank" rel="noopener noreferrer">Privacy Policy (FERPA/COPPA)</a>
      <a href="/terms" target="_blank" rel="noopener noreferrer">Terms of Service</a>
    </div>
  </footer>

  ${scriptsHtml}
</body>
</html>`;
}
