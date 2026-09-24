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
${FONT_LINKS}
  <style>
${rootTokensCss(LEGACY_PORTAL_ALIASES)}
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Plus Jakarta Sans', sans-serif; }
    body {
      background: var(--bg-base);
      color: var(--text-main);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      line-height: 1.6;
    }

    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      padding: 16px 28px;
      background: var(--bg-surface);
      border-bottom: 1px solid var(--border-subtle);
      flex-wrap: wrap;
    }
    .brand { display: flex; align-items: center; gap: 12px; }
    .brand-mark {
      width: 40px; height: 40px; border-radius: 10px;
      background: var(--accent-gradient);
      display: flex; align-items: center; justify-content: center;
      font-weight: 800; font-size: 17px; color: #fff;
    }
    .brand-name { font-size: 16px; font-weight: 800; letter-spacing: -0.2px; }
    .brand-sub { font-size: 12px; color: var(--text-muted); }
    .header-link {
      font-size: 13px; font-weight: 600; color: #93c5fd;
      text-decoration: none; padding: 8px 14px; border-radius: var(--radius-sm);
      border: 1px solid rgba(59, 130, 246, 0.3); background: rgba(59, 130, 246, 0.08);
    }
    .header-link:hover { background: rgba(59, 130, 246, 0.16); }

    main { flex: 1; width: 100%; max-width: 980px; margin: 0 auto; padding: 56px 24px 72px; }

    .hero { text-align: center; margin-bottom: 44px; }
    .hero-title {
      font-size: clamp(28px, 5vw, 44px);
      font-weight: 800;
      letter-spacing: -1px;
      margin-bottom: 14px;
      overflow-wrap: anywhere;
    }
    .hero-intro {
      font-size: 16px;
      color: var(--text-muted);
      max-width: 620px;
      margin: 0 auto 28px;
      overflow-wrap: anywhere;
    }
    .hero-cta {
      display: inline-flex; align-items: center; gap: 9px;
      background: var(--accent); color: #fff; text-decoration: none;
      font-size: 15px; font-weight: 700;
      padding: 13px 26px; border-radius: var(--radius-sm);
      box-shadow: 0 6px 20px var(--accent-glow);
      transition: background 0.2s ease, transform 0.2s ease;
    }
    .hero-cta:hover { background: var(--accent-hover); transform: translateY(-1px); }

    .blocks { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 18px; }
    .block {
      background: var(--bg-surface);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius);
      padding: 22px;
      display: flex; flex-direction: column; gap: 10px;
    }
    .block-title { font-size: 16px; font-weight: 700; overflow-wrap: anywhere; }
    .block-body { font-size: 14px; color: var(--text-muted); white-space: pre-line; overflow-wrap: anywhere; }
    .block-link {
      align-self: flex-start;
      display: inline-flex; align-items: center; gap: 6px;
      font-size: 13px; font-weight: 600; color: #93c5fd; text-decoration: none;
      margin-top: 2px;
    }
    .block-link:hover { text-decoration: underline; }

    footer {
      background: var(--bg-surface);
      border-top: 1px solid var(--border-subtle);
      padding: 20px 28px;
      text-align: center;
      color: var(--text-muted);
      font-size: 12px;
    }
    footer a { color: var(--text-muted); text-decoration: underline; }

    @media (max-width: 640px) {
      header { padding: 14px 16px; }
      main { padding: 36px 16px 52px; }
    }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <div class="brand-mark">${escapeHtml((tenant.name || "S").slice(0, 1).toUpperCase())}</div>
      <div>
        <div class="brand-name">${escapeHtml(tenant.name)}</div>
        <div class="brand-sub">${escapeHtml(tenant.portal_subtitle || "Workstations")}</div>
      </div>
    </div>
    <a class="header-link" href="${escapeAttr(portalPath)}">Enter the Lab &rarr;</a>
  </header>

  <main>
    <section class="hero">
      <h1 class="hero-title">${escapeHtml(headline)}</h1>
      <p class="hero-intro">${escapeHtml(intro)}</p>
      <a class="hero-cta" href="${escapeAttr(portalPath)}">
        <span>Enter the Lab</span>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M5 12h14M12 5l7 7-7 7"/></svg>
      </a>
    </section>

    ${blocks.length ? `<section class="blocks">${blocksHtml}</section>` : ""}
  </main>

  <footer>
    ${escapeHtml(tenant.portal_footer || "Protected by Lab Kiosk OS • Educational Environment Restricted")}
    • <a href="/privacy">Privacy</a>
    • <a href="/terms">Terms</a>
  </footer>
</body>
</html>`;
}
