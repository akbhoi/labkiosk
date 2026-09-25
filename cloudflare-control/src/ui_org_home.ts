/**
 * The organization homepage, served at the root of an organization's subdomain.
 *
 * The subdomain root used to render the user app grid, the same page as
 * /home. This is the page an organization puts its own name on: a headline, a short
 * introduction, whatever notices and links it wants to publish, and a way
 * through to the lab itself.
 *
 * Everything on it is organization-supplied and everything is escaped. A block's
 * link has already been through safeHttpUrl on the way into the database and
 * goes through it again here, because neither side may assume the other did.
 */

import { Tenant, HomepageBlock } from "./types";
import { escapeHtml, escapeAttr, safeHttpUrl } from "./escape";
import { FONT_LINKS, rootTokensCss, LEGACY_PORTAL_ALIASES } from "./ui_tokens";

export interface OrgHomeOptions {
  tenant: Tenant;
  blocks: HomepageBlock[];
  /** Where the app grid lives. Always /home; passed so the route owns the path. */
  portalPath: string;
}

export function renderOrgHomeHtml(options: OrgHomeOptions): string {
  const { tenant, blocks, portalPath } = options;

  const headline = tenant.homepage_headline || tenant.name;
  const intro =
    tenant.homepage_intro ||
    "Welcome. Everything on this workstation is chosen and managed by your organization's administrators.";

  const blocksHtml = blocks
    .map((block) => {
      const href = safeHttpUrl(block.url);
      const link = href
        ? `<a class="block-link" href="${escapeAttr(href)}" rel="noopener noreferrer">
             <span>Open</span>
             <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
           </a>`
        : "";
      return `
      <article class="block">
        ${block.title ? `<h3 class="block-title">${escapeHtml(block.title)}</h3>` : ""}
        ${block.body ? `<p class="block-body">${escapeHtml(block.body)}</p>` : ""}
        ${link}
      </article>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(tenant.name)}</title>
  <meta name="description" content="${escapeAttr(intro)}">
  <meta name="color-scheme" content="light dark">
${FONT_LINKS}
  <style>
${rootTokensCss(LEGACY_PORTAL_ALIASES)}
    *, *::before, *::after { box-sizing: border-box; }
    :where(h1, h2, h3, p) { margin: 0; }
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
      line-height: 1.6;
      -webkit-font-smoothing: antialiased;
    }
    :where(a):focus-visible { outline: 2px solid var(--border-focus); outline-offset: 2px; }

    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 12px 28px;
      background: var(--bg-base);
      border-bottom: 1px solid var(--border-subtle);
      flex-wrap: wrap;
    }
    .brand { display: flex; align-items: center; gap: 12px; min-width: 0; }
    .brand-mark {
      width: 36px; height: 36px; border-radius: var(--radius); flex-shrink: 0;
      background: var(--accent);
      display: flex; align-items: center; justify-content: center;
      font-weight: 700; font-size: 1rem; color: var(--accent-fg);
    }
    .brand-name { font-size: 0.9375rem; font-weight: 650; letter-spacing: -0.01em; line-height: 1.3; }
    .brand-sub { font-size: 0.75rem; color: var(--text-muted); line-height: 1.3; }
    .header-link {
      font-size: 0.8125rem; font-weight: 500; color: var(--text-main);
      text-decoration: none; padding: 7px 14px; border-radius: var(--radius-sm);
      border: 1px solid var(--border); background: var(--bg-surface);
      box-shadow: var(--shadow-sm);
      transition: background-color 0.15s ease;
    }
    .header-link:hover { background: var(--bg-card-hover); }

    main { flex: 1; width: 100%; max-width: 980px; margin: 0 auto; padding: clamp(40px, 8vw, 88px) 24px 72px; }

    .hero { text-align: center; margin-bottom: 48px; }
    .hero-title {
      font-size: clamp(1.875rem, 1.2rem + 3vw, 3rem);
      font-weight: 700;
      letter-spacing: -0.03em;
      line-height: 1.12;
      margin-bottom: 16px;
      overflow-wrap: anywhere;
      text-wrap: balance;
    }
    .hero-intro {
      font-size: 1.0625rem;
      color: var(--text-muted);
      max-width: 620px;
      margin: 0 auto 28px;
      overflow-wrap: anywhere;
      text-wrap: pretty;
    }
    .hero-cta {
      display: inline-flex; align-items: center; gap: 8px;
      background: var(--accent); color: var(--accent-fg); text-decoration: none;
      font-size: 0.9375rem; font-weight: 600;
      min-height: 44px; padding: 0 22px; border-radius: var(--radius);
      box-shadow: var(--shadow-sm);
      transition: background-color 0.15s ease;
    }
    .hero-cta:hover { background: var(--accent-hover); }

    .blocks { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(280px, 100%), 1fr)); gap: 16px; }
    .block {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-sm);
      padding: 20px;
      display: flex; flex-direction: column; gap: 8px;
    }
    .block-title { font-size: 1rem; font-weight: 600; overflow-wrap: anywhere; }
    .block-body { font-size: 0.875rem; color: var(--text-muted); white-space: pre-line; overflow-wrap: anywhere; }
    .block-link {
      align-self: flex-start;
      display: inline-flex; align-items: center; gap: 6px;
      font-size: 0.8125rem; font-weight: 600; color: var(--accent-text); text-decoration: none;
      margin-top: 4px;
    }
    .block-link:hover { text-decoration: underline; }

    footer {
      border-top: 1px solid var(--border-subtle);
      padding: 20px 28px;
      text-align: center;
      color: var(--text-subtle);
      font-size: 0.75rem;
    }
    footer a { color: var(--text-muted); text-decoration: underline; }

    @media (forced-colors: active) {
      .block, .header-link, .hero-cta { border: 1px solid CanvasText; }
    }
    @media (max-width: 640px) {
      header { padding: 12px 16px; }
      main { padding: 36px 16px 52px; }
    }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <div class="brand-mark">${escapeHtml((tenant.name || "O").slice(0, 1).toUpperCase())}</div>
      <div>
        <div class="brand-name">${escapeHtml(tenant.name)}</div>
        <div class="brand-sub">${escapeHtml(tenant.portal_subtitle || "Workstations")}</div>
      </div>
    </div>
    <a class="header-link" href="${escapeAttr(portalPath)}">Open User Portal &rarr;</a>
  </header>

  <main>
    <section class="hero">
      <h1 class="hero-title">${escapeHtml(headline)}</h1>
      <p class="hero-intro">${escapeHtml(intro)}</p>
      <a class="hero-cta" href="${escapeAttr(portalPath)}">
        <span>Open User Portal</span>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
      </a>
    </section>

    ${blocks.length ? `<section class="blocks">${blocksHtml}</section>` : ""}
  </main>

  <footer>
    ${escapeHtml(tenant.portal_footer || "Protected by Lab Kiosk OS • Managed Workstation")}
    • <a href="/privacy">Privacy</a>
    • <a href="/terms">Terms</a>
  </footer>
</body>
</html>`;
}
