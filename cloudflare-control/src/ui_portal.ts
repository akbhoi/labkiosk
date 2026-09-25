/**
 * The User Portal: the app launcher a workstation shows, a card per approved site.
 */

import { Tenant, PortalSite } from "./types";
import { escapeHtml, safeHttpUrl, escapeAttr } from "./escape";
import { FONT_LINKS, rootTokensCss, themeHeadHtml, LEGACY_PORTAL_ALIASES } from "./ui_tokens";

export function renderPortalHtml(tenant: Tenant, sites: PortalSite[], nonce: string): string {
  const FALLBACK_THUMBNAIL = "https://images.unsplash.com/photo-1509228468518-180dd4864904?w=600&q=80";

  // Card content is operator-supplied. Cards are anchors rather than divs with an
  // inline navigation handler, so a hostile URL cannot become executable markup,
  // and a non-http(s) URL is dropped entirely rather than rendered.
  const cardsHtml = sites
    .map((site) => {
      const href = safeHttpUrl(site.url);
      if (!href) return "";
      const thumb = safeHttpUrl(site.thumbnail_url) || FALLBACK_THUMBNAIL;
      return `
    <a class="app-card" href="${escapeHtml(href)}" rel="noopener noreferrer">
      <div class="card-thumb">
        <img class="card-thumb-img" src="${escapeHtml(thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer">
        <span class="card-category">${escapeHtml(site.category)}</span>
      </div>
      <div class="card-body">
        <div class="card-header">
          <span class="card-icon">${escapeHtml(site.icon || "🌐")}</span>
          <h3 class="card-title">${escapeHtml(site.title)}</h3>
        </div>
        <p class="card-domain">${escapeHtml(site.domain)}</p>
        <span class="launch-btn">
          <span>Launch App</span>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
        </span>
      </div>
    </a>
  `;
    })
    .join("");

  const emptyState = `
    <div class="portal-empty">
      <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
      <div>No applications have been added yet.</div>
      <div class="portal-empty-hint">An administrator can add them from the admin console.</div>
    </div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(tenant.name)} - ${escapeHtml(tenant.portal_title || "User Portal")}</title>
${themeHeadHtml(nonce)}
${FONT_LINKS}
  <style>
${rootTokensCss(LEGACY_PORTAL_ALIASES)}
    *, *::before, *::after { box-sizing: border-box; }
    :where(h1, h2, h3, p) { margin: 0; }
    html { accent-color: var(--accent); }
    body {
      margin: 0;
      font-family: var(--font-sans);
      font-feature-settings: "cv11", "ss01";
      background: var(--bg-base);
      color: var(--text-main);
      min-height: 100vh;
      min-height: 100dvh;
      display: flex;
      flex-direction: column;
      user-select: none;
      overflow-x: hidden;
      -webkit-font-smoothing: antialiased;
    }
    :where(a, button):focus-visible { outline: 2px solid var(--border-focus); outline-offset: 2px; }
    header {
      position: sticky;
      top: 0;
      z-index: 10;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 12px 32px;
      background: var(--bg-base);
      background: color-mix(in oklab, var(--bg-base) 85%, transparent);
      -webkit-backdrop-filter: saturate(1.4) blur(12px);
      backdrop-filter: saturate(1.4) blur(12px);
      border-bottom: 1px solid var(--border-subtle);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      min-width: 0;
    }
    .brand-icon {
      width: 36px;
      height: 36px;
      flex-shrink: 0;
      background: var(--accent);
      color: var(--accent-fg);
      border-radius: var(--radius);
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .brand-name {
      font-size: 1rem;
      font-weight: 650;
      letter-spacing: -0.01em;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .brand-sub {
      font-size: 0.75rem;
      color: var(--text-muted);
    }
    .header-meta {
      display: flex;
      align-items: center;
      gap: 14px;
    }
    .status-pill {
      display: flex;
      align-items: center;
      gap: 8px;
      background: var(--success-soft);
      padding: 4px 12px;
      border-radius: 999px;
      font-size: 0.8125rem;
      font-weight: 500;
      color: var(--success-text);
      white-space: nowrap;
    }
    .dot {
      width: 7px;
      height: 7px;
      border-radius: 50%;
      background: var(--success);
      box-shadow: 0 0 0 3px var(--success-glow);
    }
    .clock {
      font-family: var(--font-mono);
      font-size: 0.875rem;
      color: var(--text-muted);
      font-variant-numeric: tabular-nums;
    }
    main {
      flex: 1;
      padding: 48px 32px 64px;
      max-width: 1320px;
      width: 100%;
      margin: 0 auto;
    }
    .portal-hero {
      text-align: center;
      margin-bottom: 40px;
    }
    .portal-title {
      font-size: clamp(1.5rem, 1.1rem + 1.4vw, 2.125rem);
      font-weight: 700;
      letter-spacing: -0.025em;
      line-height: 1.2;
      margin-bottom: 10px;
      text-wrap: balance;
    }
    .portal-desc {
      font-size: 1rem;
      line-height: 1.6;
      color: var(--text-muted);
      max-width: 620px;
      margin: 0 auto;
      text-wrap: pretty;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(min(260px, 100%), 1fr));
      gap: 20px;
    }
    .app-card {
      text-decoration: none;
      color: inherit;
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      overflow: hidden;
      cursor: pointer;
      display: flex;
      flex-direction: column;
      box-shadow: var(--shadow-sm);
      transition: border-color 0.18s ease, box-shadow 0.18s ease, translate 0.22s var(--ease-spring);
    }
    .app-card:hover {
      translate: 0 -3px;
      border-color: var(--border-input);
      box-shadow: var(--shadow-md);
    }
    .card-thumb {
      aspect-ratio: 16 / 9;
      position: relative;
      background-color: var(--bg-subtle);
      overflow: hidden;
      border-bottom: 1px solid var(--border-subtle);
    }
    .card-thumb-img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
      transition: scale 0.4s var(--ease-out);
    }
    .app-card:hover .card-thumb-img { scale: 1.03; }
    .card-category {
      position: absolute;
      top: 10px;
      left: 10px;
      background: var(--bg-surface);
      padding: 2px 9px;
      border-radius: 999px;
      font-size: 0.6875rem;
      font-weight: 600;
      color: var(--text-main);
      box-shadow: var(--shadow-sm);
      z-index: 1;
    }
    .card-body {
      padding: 16px;
      display: flex;
      flex-direction: column;
      flex: 1;
      justify-content: space-between;
      gap: 14px;
    }
    .card-header {
      display: flex;
      align-items: center;
      gap: 10px;
    }
    .card-icon {
      width: 32px;
      height: 32px;
      border-radius: var(--radius-sm);
      background: var(--bg-subtle);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 1.0625rem;
      flex-shrink: 0;
    }
    .card-title {
      font-size: 1rem;
      font-weight: 600;
      letter-spacing: -0.01em;
    }
    .card-domain {
      font-family: var(--font-mono);
      font-size: 0.75rem;
      color: var(--text-muted);
      margin-top: 2px;
    }
    .launch-btn {
      width: 100%;
      min-height: 36px;
      background: var(--bg-subtle);
      border: 1px solid var(--border);
      color: var(--text-main);
      padding: 8px 14px;
      border-radius: var(--radius-sm);
      font-size: 0.8125rem;
      font-weight: 500;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      transition: background-color 0.15s ease, border-color 0.15s ease, color 0.15s ease;
    }
    .app-card:hover .launch-btn {
      background: var(--accent);
      border-color: var(--accent);
      color: var(--accent-fg);
    }
    .portal-empty {
      grid-column: 1 / -1;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 10px;
      padding: 64px 24px;
      background: var(--bg-surface);
      border: 1px dashed var(--border-input);
      border-radius: var(--radius-lg);
      color: var(--text-muted);
      font-size: 0.9375rem;
      text-align: center;
    }
    .portal-empty-hint { font-size: 0.8125rem; color: var(--text-subtle); }
    footer {
      text-align: center;
      padding: 20px 24px;
      border-top: 1px solid var(--border-subtle);
      font-size: 0.75rem;
      color: var(--text-subtle);
    }
    footer a { color: var(--text-muted); }
    footer a:hover { color: var(--text-main); }

    @media (prefers-reduced-motion: reduce) {
      .app-card, .card-thumb-img, .launch-btn { transition: none; }
      .app-card:hover { translate: none; }
      .app-card:hover .card-thumb-img { scale: none; }
    }
    @media (forced-colors: active) {
      .app-card, .launch-btn, .status-pill { border: 1px solid CanvasText; }
    }

    /* Responsive Mobile & Tablet */
    @media (max-width: 768px) {
      header {
        padding: 12px 20px;
        flex-wrap: wrap;
        gap: 10px;
      }
      .header-meta {
        width: 100%;
        justify-content: space-between;
      }
      main {
        padding: 28px 20px 48px;
      }
      .portal-hero {
        margin-bottom: 28px;
      }
      .grid {
        gap: 16px;
      }
    }
    @media (max-width: 480px) {
      header { padding: 10px 16px; }
      .brand { gap: 10px; }
      .status-pill { font-size: 0.6875rem; padding: 3px 10px; }
      .clock { font-size: 0.75rem; }
      main { padding: 20px 14px 36px; }
      .grid { grid-template-columns: 1fr; gap: 14px; }
      .launch-btn { min-height: 44px; }
    }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <div class="brand-icon">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
      </div>
      <div>
        <div class="brand-name">${escapeHtml(tenant.name)}</div>
        <div class="brand-sub">${escapeHtml(tenant.portal_subtitle || "User Portal")}</div>
      </div>
    </div>
    <div class="header-meta">
      <div class="status-pill">
        <div class="dot"></div>
        <span>Protected Kiosk Session</span>
      </div>
      <div class="clock" id="live-clock">--:--:--</div>
    </div>
  </header>

  <main>
    <div class="portal-hero">
      <h1 class="portal-title">${escapeHtml(tenant.portal_title || "Select an Approved Resource")}</h1>
      <p class="portal-desc">${escapeHtml(tenant.portal_description || "Choose an approved application below to get started. Access to every other site is filtered and managed by your organization.")}</p>
    </div>

    <div class="grid">
      ${cardsHtml || emptyState}
    </div>
  </main>

  <footer>
    ${escapeHtml(tenant.portal_footer || "Protected by Lab Kiosk OS • Managed Workstation")} • <a href="/privacy">Privacy</a> • <a href="/terms">Terms</a>
  </footer>

  <script nonce="${escapeAttr(nonce)}">
    function updateClock() {
      const now = new Date();
      const el = document.getElementById('live-clock');
      if (el) el.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    }
    setInterval(updateClock, 1000);
    updateClock();
  </script>
</body>
</html>`;
}
