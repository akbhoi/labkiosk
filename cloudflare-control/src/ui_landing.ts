/**
 * Public SaaS Landing Page
 * Hosted at labkiosk.org
 *
 * Dedicated experiences for:
 *   - IT & operations teams who run the workstations
 *   - The people who use them
 *   - Schools, colleges & universities
 *   - Leadership & finance
 *   - CSR & hardware partners
 *
 * Architectural & Security Invariants:
 *   - 0 runtime npm dependencies
 *   - 100% inline CSS & SVG icons for sub-20ms global edge delivery
 *   - WCAG 2.2 AA accessible (min target size 24px, focus rings, semantic markup)
 *   - Native top-level navigation (never load apps in iframes)
 *   - Escapes all server-rendered values via escapeHtml / escapeJson / safeHttpUrl
 */

import { escapeHtml, escapeJson, safeHttpUrl, escapeAttr } from "./escape";
import { fnv1a } from "./ui_layout";
import { DOCS_NAV, DOCS_PAGES, DocsPage } from "./docs_content.generated";
import { LinkResolver, renderMarkdown } from "./markdown";
import { LATEST_CHECKSUM_URL, LATEST_ISO_URL, RELEASES_URL, RELEASE_CHECKSUM_NAME, RELEASE_ISO_NAME, ReleaseNote, releaseHighlights } from "./release_notes";
import { BUSY_CSS, BUSY_SCRIPT, FONT_LINKS, rootTokensCss, LEGACY_LANDING_ALIASES, PALETTE, THEME_TOGGLE_SCRIPT, themeHeadHtml } from "./ui_tokens";
import { FAVICON_LINK_HTML, FAVICON_PATH, canonicalLinkHtml } from "./seo";
import { TURNSTILE_ORIGIN } from "./turnstile";
import { CONTACT_REASONS } from "./conversations";

/** The public source repository, linked from the navigation and the footer. */
const SOURCE_REPOSITORY_URL = "https://github.com/akbhoi/labkiosk";

const PAGE_TITLE = "Lab Kiosk OS - Secure Browser Workstations for Any Organization";
const PAGE_DESCRIPTION =
  "Turn any computer into a secure browser workstation. Central management for companies, public services, libraries and schools: 100% RAM overlay, one-click screen lock, allowlist-only browsing, zero SSD wear, on Cloudflare's edge.";

/**
 * Social previews and structured data for the canonical landing page. Only the
 * canonical page gets them: the dialog views (/login, /register, ...) are
 * noindex copies of it.
 */
/** The picture a shared link shows (public/social-card.png, 1200 by 630). */
export const SOCIAL_IMAGE_PATH = "/social-card.png";

function landingSeoHeadHtml(canonicalUrl: string, contactEmail: string, nonce: string, title = PAGE_TITLE, description = PAGE_DESCRIPTION): string {
  const origin = new URL(canonicalUrl).origin;
  const structuredData = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        "@id": `${origin}/#organization`,
        name: "Lab Kiosk",
        url: `${origin}/`,
        logo: `${origin}${FAVICON_PATH}`,
        email: contactEmail
      },
      {
        "@type": "WebSite",
        "@id": `${origin}/#website`,
        name: "Lab Kiosk OS",
        url: `${origin}/`,
        description: description,
        inLanguage: "en",
        publisher: { "@id": `${origin}/#organization` }
      }
    ]
  };
  return `${canonicalLinkHtml(canonicalUrl)}  <meta property="og:type" content="website">
  <meta property="og:site_name" content="Lab Kiosk OS">
  <meta property="og:title" content="${escapeAttr(title)}">
  <meta property="og:description" content="${escapeAttr(description)}">
  <meta property="og:url" content="${escapeAttr(canonicalUrl)}">
  <meta property="og:locale" content="en_US">
  <meta property="og:image" content="${escapeAttr(new URL(SOCIAL_IMAGE_PATH, canonicalUrl).toString())}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:image:alt" content="Lab Kiosk: turn any computer into a secure browser workstation">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:image" content="${escapeAttr(new URL(SOCIAL_IMAGE_PATH, canonicalUrl).toString())}">
  <meta name="twitter:title" content="${escapeAttr(title)}">
  <meta name="twitter:description" content="${escapeAttr(description)}">
  <script type="application/ld+json" nonce="${escapeAttr(nonce)}">${escapeJson(structuredData)}</script>
`;
}

export interface LandingOptions {
  /** Message shown in a banner above the hero, e.g. after a rejected redirect. */
  error?: string;
  /** Modal to open on load, used by /login, /register, /iso and redirects. */
  openModal?: "login" | "register" | "iso";
  /** Public download URL for the built ISO, if configured. */
  isoDownloadUrl?: string;
  /** The newest releases, for /download (src/release_notes.ts); empty until the hourly run has read them. */
  releases?: ReleaseNote[];
  /** Apex / base domain for organization subdomains (defaults to labkiosk.org). */
  baseDomain?: string;
  /** Primary contact email (defaults to contact@labkiosk.org). */
  contactEmail?: string;
  /** This page on the canonical host; set only where the page may be indexed (src/seo.ts). */
  canonicalUrl?: string;
  /** Per-response CSP nonce; the page's single <script> must carry it. */
  nonce: string;
  /** Turnstile's public site key when it is on (src/turnstile.ts); the registration code, the contact code and sign-in then carry a check. */
  turnstileSiteKey?: string | null;
  /** False on an organization's own domain, where the sign-in form carries no check (the router says why). */
  loginTurnstile?: boolean;
}

function renderPublicShell(
  data: LandingOptions,
  meta: { title: string; description: string; activeNav?: string; mainHtml: string }
): string {
  const baseDomain = (data.baseDomain || "labkiosk.org").toLowerCase().replace(/^\./, "");
  const contactEmail = (data.contactEmail || "contact@labkiosk.org").toLowerCase();
  const turnstileKey = data.turnstileSiteKey || null;
  const turnstileSlot = (id: string) => (turnstileKey ? `<div class="form-group turnstile-slot" id="${id}"></div>` : "");
  const loginTurnstileSlot = data.loginTurnstile === false ? "" : turnstileSlot("login-turnstile");

  const banner = data.error
    ? `<div class="page-alert" role="alert" aria-live="polite">${escapeHtml(data.error)}</div>`
    : "";

  // ISO_DOWNLOAD_URL names a mirror; without one the newest GitHub release is the download.
  const isoUrl = (data.isoDownloadUrl ? safeHttpUrl(data.isoDownloadUrl) : null) || LATEST_ISO_URL;
  const isoAction = `<a href="${escapeHtml(isoUrl)}" target="_blank" rel="noopener noreferrer" class="btn btn-primary btn-block">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        Download Latest Release (.ISO)
      </a>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(meta.title)}</title>
  <meta name="description" content="${escapeAttr(meta.description)}">
${FAVICON_LINK_HTML}${data.canonicalUrl ? landingSeoHeadHtml(data.canonicalUrl, contactEmail, data.nonce, meta.title, meta.description) : ""}  <meta name="theme-color" media="(prefers-color-scheme: light)" content="${PALETTE["--bg-base"][0]}">
  <meta name="theme-color" media="(prefers-color-scheme: dark)" content="${PALETTE["--bg-base"][1]}">
${themeHeadHtml(data.nonce)}
${FONT_LINKS}
  <link rel="stylesheet" href="${SITE_STYLESHEET_PATH}">
</head>
<body>
  <header>
    <a class="brand" href="/" aria-label="Lab Kiosk home">
      <div class="brand-logo" aria-hidden="true">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
      </div>
      <div class="brand-title">
        Lab Kiosk
        <span>OS &amp; Edge SaaS</span>
      </div>
    </a>

    <nav class="nav-links" aria-label="Main Navigation">
      <a href="/"${meta.activeNav ? "" : ' class="active"'}>Home</a>
      <a href="/features"${meta.activeNav === "features" ? ' class="active"' : ""}>Features</a>
      <a href="/specs"${meta.activeNav === "specs" ? ' class="active"' : ""}>Specs</a>
      <a href="/pricing"${meta.activeNav === "pricing" ? ' class="active"' : ""}>Pricing</a>
      <a href="/download"${meta.activeNav === "download" ? ' class="active"' : ""}>Download</a>
      <a href="/docs"${meta.activeNav === "docs" ? ' class="active"' : ""}>Docs</a>
      <a href="/contact"${meta.activeNav === "contact" ? ' class="active"' : ""}>Contact</a>
    </nav>

    <div class="nav-actions">
      <a class="icon-link" href="${SOURCE_REPOSITORY_URL}" target="_blank" rel="noopener" aria-label="Lab Kiosk source code on GitHub" title="Source code on GitHub">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0 0 16 8c0-4.42-3.58-8-8-8z"/></svg>
      </a>
      <button type="button" class="theme-toggle" data-action="toggle-theme" aria-label="Switch theme" title="Switch between light and dark">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor"/></svg>
      </button>
      <button class="btn btn-ghost nav-signin-btn" data-action="open-modal" data-modal="login">Sign In</button>
      <button class="btn btn-primary nav-register-btn" data-action="open-modal" data-modal="register">Get Started</button>
      <button class="mobile-menu-btn" id="mobile-toggle" aria-label="Toggle navigation menu" aria-expanded="false" data-action="toggle-drawer">
        <svg class="icon-menu" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
        <svg class="icon-close" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" style="display: none;"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
  </header>

  <!-- Mobile Drawer & Backdrop -->
  <div class="mobile-drawer-backdrop" id="mobile-drawer-backdrop" data-action="close-drawer"></div>
  <div class="mobile-drawer" id="mobile-drawer" aria-label="Mobile Navigation" role="dialog" aria-modal="true">
    <div class="mobile-drawer-header">
      <div class="brand">
        <div class="brand-logo">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
        </div>
        <div class="brand-title">Lab Kiosk</div>
      </div>
      <button class="drawer-close-btn" data-action="close-drawer" aria-label="Close menu">&times;</button>
    </div>
    <nav class="mobile-drawer-nav">
      <a href="/" data-action="close-drawer">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/></svg>
        Home
      </a>
      <a href="/features" data-action="close-drawer">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
        Features
      </a>
      <a href="/specs" data-action="close-drawer">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/></svg>
        Hardware Specs
      </a>
      <a href="/pricing" data-action="close-drawer">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
        Pricing
      </a>
      <a href="/download" data-action="close-drawer">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        Download ISO
      </a>
      <a href="/docs" data-action="close-drawer">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
        Documentation
      </a>
      <a href="/#simulator" data-action="close-drawer">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><polyline points="8 21 16 21 12 17"/></svg>
        Live Simulator
      </a>
      <a href="/contact" data-action="close-drawer">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        Contact
      </a>
      <a href="${SOURCE_REPOSITORY_URL}" target="_blank" rel="noopener" data-action="close-drawer">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
        Source code on GitHub
      </a>
    </nav>
    <div class="mobile-drawer-actions">
      <button class="btn btn-primary btn-block" data-action="drawer-open-modal" data-modal="register">Register Organization</button>
      <button class="btn btn-ghost btn-block" data-action="drawer-open-modal" data-modal="login">Operator Sign In</button>
    </div>
  </div>

  <main>
    ${banner}
    ${meta.mainHtml}
  </main>

  <!-- Login Modal -->
  <div class="modal-overlay" id="login-modal" role="dialog" aria-modal="true" aria-labelledby="login-modal-title">
    <div class="modal-box">
      <button class="modal-close" data-action="close-modal" data-modal="login" aria-label="Close dialog">✕</button>
      <h2 class="modal-title" id="login-modal-title">Admin &amp; Staff Sign In</h2>
      <p class="modal-sub">Sign in to manage your organization's workstations.</p>
      <div class="alert-box" id="login-alert" role="alert"></div>
      <form id="login-form">
        <div class="form-group">
          <label class="form-label" for="login-email">Email Address</label>
          <input type="email" class="form-input" id="login-email" required placeholder="you@example.com" autocomplete="email">
        </div>
        <div class="form-group">
          <label class="form-label" for="login-password">Password</label>
          <input type="password" class="form-input" id="login-password" required placeholder="••••••••" autocomplete="current-password">
        </div>
        ${loginTurnstileSlot}
        <button type="submit" class="btn btn-primary btn-block" style="margin-top: 10px;">Sign In to Admin Console</button>
      </form>
      <form id="login-2fa-form" hidden>
        <div class="notice-box" id="login-2fa-notice" role="status"></div>
        <div class="form-group">
          <label class="form-label" for="login-2fa-code" id="login-2fa-label">Sign-in code</label>
          <input type="text" class="form-input" id="login-2fa-code" required inputmode="numeric" autocomplete="one-time-code" maxlength="11" placeholder="123456" style="font-family: var(--font-mono); letter-spacing: 0.2em;">
        </div>
        <div class="form-group">
          <label class="check-row"><input type="checkbox" id="login-2fa-trust"> <span>Trust this browser for 30 days</span></label>
        </div>
        <button type="submit" class="btn btn-primary btn-block">Verify and sign in</button>
        <div class="code-row" style="margin-top: 10px;">
          <button type="button" class="btn btn-ghost" id="login-2fa-email">Email me a code instead</button>
          <button type="button" class="btn btn-ghost" id="login-2fa-back">Start over</button>
        </div>
        <p class="modal-sub" id="login-2fa-recovery" style="margin: 12px 0 0;">Lost your phone? Enter one of your recovery codes instead of the six digits.</p>
      </form>
      <div class="modal-switch">
        New organization? <a href="/register" data-action="switch-modal" data-close="login" data-modal="register">Register your organization</a>
      </div>
    </div>
  </div>

  <!-- Register Modal -->
  <div class="modal-overlay" id="register-modal" role="dialog" aria-modal="true" aria-labelledby="reg-modal-title">
    <div class="modal-box modal-wide">
      <button class="modal-close" data-action="close-modal" data-modal="register" aria-label="Close dialog">✕</button>
      <h2 class="modal-title" id="reg-modal-title">Register Your Organization</h2>
      <p class="modal-sub">We review every registration and email you when your console is active.</p>
      <div class="alert-box" id="register-alert" role="alert"></div>
      <div class="notice-box" id="register-done" role="status"></div>
      <form id="register-form">
        <div class="form-legend">Organization</div>
        <div class="form-split">
          <div class="form-group">
            <label class="form-label" for="reg-name">Organization name</label>
            <input type="text" class="form-input" id="reg-name" required maxlength="120" placeholder="Greenwood Holdings" autocomplete="organization">
          </div>
          <div class="form-group">
            <label class="form-label" for="reg-legal-name">Legal or billing name <span class="input-hint">(optional)</span></label>
            <input type="text" class="form-input" id="reg-legal-name" maxlength="160" placeholder="Greenwood Holdings Pvt Ltd">
          </div>
        </div>
        <div class="form-split">
          <div class="form-group">
            <label class="form-label" for="reg-type">Type</label>
            <select class="form-input" id="reg-type">
              <option value="business">Business</option>
              <option value="government">Government or public body</option>
              <option value="library">Library</option>
              <option value="education">Education</option>
              <option value="nonprofit">Non-profit</option>
              <option value="other">Other</option>
            </select>
          </div>
          <div class="form-group">
            <label class="form-label" for="reg-workstations">Expected workstations</label>
            <input type="number" class="form-input" id="reg-workstations" min="1" max="100000" placeholder="40" inputmode="numeric">
          </div>
        </div>
        <div class="form-group">
          <label class="form-label" for="reg-subdomain">Console address</label>
          <div class="code-row">
            <input type="text" class="form-input" id="reg-subdomain" required placeholder="greenwood" pattern="[a-z0-9\\-]+" style="font-family: var(--font-mono);">
            <span style="font-family: var(--font-mono); font-size: 13px; color: var(--muted); white-space: nowrap; align-self: center;">.${escapeHtml(baseDomain)}</span>
          </div>
          <div class="input-hint">Lowercase letters, numbers and hyphens.</div>
        </div>

        <div class="form-legend">Technical contact</div>
        <div class="form-split">
          <div class="form-group">
            <label class="form-label" for="reg-contact-name">Full name</label>
            <input type="text" class="form-input" id="reg-contact-name" required maxlength="120" placeholder="Jane Smith" autocomplete="name">
          </div>
          <div class="form-group">
            <label class="form-label" for="reg-phone">Phone, with country code</label>
            <input type="tel" class="form-input" id="reg-phone" required placeholder="+91 98765 43210" autocomplete="tel">
            <div class="input-hint">We call or message this number to confirm it before approval.</div>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label" for="reg-email">Work email (your sign-in)</label>
          <div class="code-row">
            <input type="email" class="form-input" id="reg-email" required placeholder="jane@greenwood.example" autocomplete="email">
            <button type="button" class="btn btn-ghost" id="reg-send-code">Send code</button>
          </div>
        </div>
        ${turnstileSlot("reg-turnstile")}
        <div class="form-group">
          <label class="form-label" for="reg-code">Six-digit code from that email</label>
          <input type="text" class="form-input" id="reg-code" required inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" placeholder="123456" style="font-family: var(--font-mono); letter-spacing: 0.2em;">
        </div>
        <div class="form-group">
          <label class="form-label" for="reg-password">Password</label>
          <input type="password" class="form-input" id="reg-password" required minlength="12" placeholder="••••••••" autocomplete="new-password">
          <div class="input-hint">At least 12 characters, with letters and numbers.</div>
        </div>

        <div class="form-legend">Address &amp; billing</div>
        <div class="form-group">
          <label class="form-label" for="reg-address1">Street address</label>
          <input type="text" class="form-input" id="reg-address1" required maxlength="200" autocomplete="address-line1">
        </div>
        <div class="form-group">
          <label class="form-label" for="reg-address2">Address line 2 <span class="input-hint">(optional)</span></label>
          <input type="text" class="form-input" id="reg-address2" maxlength="200" autocomplete="address-line2">
        </div>
        <div class="form-split">
          <div class="form-group">
            <label class="form-label" for="reg-city">City</label>
            <input type="text" class="form-input" id="reg-city" required maxlength="100" autocomplete="address-level2">
          </div>
          <div class="form-group">
            <label class="form-label" for="reg-region">State or region</label>
            <input type="text" class="form-input" id="reg-region" maxlength="100" autocomplete="address-level1">
          </div>
        </div>
        <div class="form-split">
          <div class="form-group">
            <label class="form-label" for="reg-postal">Postal code</label>
            <input type="text" class="form-input" id="reg-postal" required maxlength="20" autocomplete="postal-code">
          </div>
          <div class="form-group">
            <label class="form-label" for="reg-country">Country</label>
            <input type="text" class="form-input" id="reg-country" required maxlength="80" autocomplete="country-name" placeholder="India">
          </div>
        </div>
        <div class="form-split">
          <div class="form-group">
            <label class="form-label" for="reg-tax-id">Tax ID, e.g. GSTIN <span class="input-hint">(optional)</span></label>
            <input type="text" class="form-input" id="reg-tax-id" maxlength="40">
          </div>
          <div class="form-group">
            <label class="form-label" for="reg-billing-email">Billing email <span class="input-hint">(optional)</span></label>
            <input type="email" class="form-input" id="reg-billing-email" autocomplete="email">
          </div>
        </div>
        <div class="form-group">
          <label class="form-label" for="reg-notes">Anything we should know? <span class="input-hint">(optional)</span></label>
          <textarea class="form-input" id="reg-notes" rows="3" maxlength="1000" placeholder="Where the workstations are, when you want to start, licensing questions..."></textarea>
        </div>
        <div class="form-group">
          <label class="check-row"><input type="checkbox" id="reg-terms" required> <span>I accept the <a href="/terms" target="_blank" rel="noopener">Terms of Service</a> and the <a href="/privacy" target="_blank" rel="noopener">Privacy Policy</a>.</span></label>
        </div>
        <button type="submit" class="btn btn-primary btn-block" style="margin-top: 10px;">Submit Registration</button>
      </form>
      <div class="modal-switch">
        Already registered? <a href="/login" data-action="switch-modal" data-close="register" data-modal="login">Sign in</a>
      </div>
    </div>
  </div>

  <!-- The home page demo's dialog: what a demo button would do, and the address to broadcast -->
  <div class="modal-overlay" id="sim-modal" role="dialog" aria-modal="true" aria-labelledby="sim-modal-title">
    <div class="modal-box">
      <button class="modal-close" data-action="close-modal" data-modal="sim" aria-label="Close dialog">✕</button>
      <h2 class="modal-title" id="sim-modal-title">Demo</h2>
      <p class="modal-sub" id="sim-modal-text" aria-live="polite"></p>
      <form id="sim-broadcast-form" hidden>
        <div class="form-group">
          <label class="form-label" for="sim-broadcast-url">Page address</label>
          <input type="url" class="form-input" id="sim-broadcast-url" required value="https://intranet.example.com" placeholder="https://intranet.example.com">
        </div>
        <button type="submit" class="btn btn-primary btn-block">Broadcast to Every Screen</button>
      </form>
      <button type="button" class="btn btn-primary btn-block" id="sim-modal-ok" data-action="close-modal" data-modal="sim">OK</button>
    </div>
  </div>

  <!-- ISO Download Modal -->
  <div class="modal-overlay" id="iso-modal" role="dialog" aria-modal="true" aria-labelledby="iso-modal-title">
    <div class="modal-box" style="max-width: 540px;">
      <button class="modal-close" data-action="close-modal" data-modal="iso" aria-label="Close dialog">✕</button>
      <h2 class="modal-title" id="iso-modal-title">Download Lab Kiosk ISO</h2>
      <p class="modal-sub">Flash to a USB drive and boot any PC or Thin Client.</p>
      <div style="background: var(--bg-surface); border: 1px solid var(--border); border-radius: 12px; padding: 20px; margin-bottom: 20px; text-align: left;">
        <h4 style="font-size: 14px; margin-bottom: 8px; color: var(--accent-text);">Step 1: Write ISO to USB Drive</h4>
        <p style="font-size: 13px; color: var(--muted); line-height: 1.5; margin-bottom: 14px;">
          Download <code>labkiosk-debian12-amd64.iso</code> and flash it to a 2 GB+ USB drive using <strong>Rufus</strong> (Windows, DD image mode) or <strong>balenaEtcher</strong> (Mac/Linux).
        </p>
        <h4 style="font-size: 14px; margin-bottom: 8px; color: var(--accent-text);">Step 2: Boot Client &amp; First-Boot Wizard</h4>
        <p style="font-size: 13px; color: var(--muted); line-height: 1.5;">
          Boot your PC from USB. On first boot, the setup wizard prompts for your <strong>Organization Subdomain</strong>, <strong>PC Identifier (e.g. PC-01)</strong>, and <strong>Enrollment Key</strong>. Once verified, the workstation permanently links to your cloud dashboard!
        </p>
      </div>
      ${isoAction}
    </div>
  </div>

  <footer>
    <div class="footer-content">
      <div class="footer-col">
        <div class="brand" style="margin-bottom: 12px;">
          <div class="brand-logo">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
          </div>
          <span style="font-weight: 800; font-size: 16px; color: var(--text-main);">Lab Kiosk OS</span>
        </div>
        <p style="font-size: 13px; line-height: 1.6; margin-bottom: 12px;">
          Secure browser workstations for any organization. 100% RAM overlay, zero SSD degradation, and central control from Cloudflare's serverless edge.
        </p>
        <p style="font-size: 12px; color: var(--text-subtle);">
          Hosted globally at <code>${escapeHtml(baseDomain)}</code>
        </p>
      </div>

      <div class="footer-col">
        <h5>Stakeholders</h5>
        <ul>
          <li><a href="/#audiences" data-action="audience-tab" data-tab="tab-operators">For IT &amp; Operations</a></li>
          <li><a href="/#audiences" data-action="audience-tab" data-tab="tab-users">For End Users</a></li>
          <li><a href="/#audiences" data-action="audience-tab" data-tab="tab-universities">For Education</a></li>
          <li><a href="/#audiences" data-action="audience-tab" data-tab="tab-smc">For Leadership &amp; Finance</a></li>
          <li><a href="/#audiences" data-action="audience-tab" data-tab="tab-corporate">For CSR Donors</a></li>
        </ul>
      </div>

      <div class="footer-col">
        <h5>Platform</h5>
        <ul>
          <li><a href="/features">Core Features</a></li>
          <li><a href="/specs">Hardware Specs</a></li>
          <li><a href="/pricing">Pricing</a></li>
          <li><a href="/download">Download ISO</a></li>
          <li><a href="/docs">Documentation</a></li>
          <li><a href="${SOURCE_REPOSITORY_URL}" target="_blank" rel="noopener">Source code on GitHub</a></li>
          <li><a href="/#faq">FAQ</a></li>
        </ul>
      </div>

      <div class="footer-col">
        <h5>Global Contact</h5>
        <ul>
          <li><span style="color: var(--text-muted); font-size: 13px;">General:</span> <a href="mailto:${escapeHtml(contactEmail)}">${escapeHtml(contactEmail)}</a></li>
          <li><span style="color: var(--text-muted); font-size: 13px;">Support:</span> <a href="mailto:support@labkiosk.org">support@labkiosk.org</a></li>
          <li><span style="color: var(--text-muted); font-size: 13px;">Partners:</span> <a href="mailto:partners@labkiosk.org">partners@labkiosk.org</a></li>
          <li><a href="/contact" style="color: var(--accent-text); font-weight: 600; margin-top: 6px; display: inline-block;">Contact form &rarr;</a></li>
        </ul>
      </div>
    </div>

    <div class="footer-bottom">
      <div>&copy; 2026 Lab Kiosk OS • Free for accredited schools up to 45 PCs • Commercial license for businesses &amp; resale</div>
      <div style="display: flex; gap: 16px; flex-wrap: wrap;">
        <a href="/login" data-action="open-modal" data-modal="login">Sign In</a>
        <a href="/register" data-action="open-modal" data-modal="register">Register Organization</a>
        <a href="/privacy">Privacy Policy</a>
        <a href="/terms">Terms of Service</a>
        <button type="button" class="footer-link-button" id="cookie-settings-link" data-action="cookie-settings" hidden>Cookie Settings</button>
        <a href="/#security">Security</a>
      </div>
    </div>
  </footer>

  <div class="cookie-banner" id="cookie-banner" role="region" aria-label="Cookie choice" hidden>
    <p>We use Google Analytics to count visits to these pages. Nothing is sent to Google unless you accept. See our <a href="/privacy">Privacy Policy</a>.</p>
    <div class="cookie-banner-actions">
      <button type="button" class="btn btn-ghost btn-sm" data-action="cookie-reject">Reject</button>
      <button type="button" class="btn btn-primary btn-sm" data-action="cookie-accept">Accept</button>
    </div>
  </div>

  <script nonce="${escapeAttr(data.nonce)}">
    function openModal(id) {
      const el = document.getElementById(id);
      if (el) el.classList.add('active');
    }
    function closeModal(id) {
      const el = document.getElementById(id);
      if (el) el.classList.remove('active');
    }
    function switchModal(closeId, openId) {
      closeModal(closeId);
      openModal(openId);
    }

    // Mobile Navigation Drawer Toggle
    function toggleMobileNav(force) {
      const drawer = document.getElementById('mobile-drawer');
      const backdrop = document.getElementById('mobile-drawer-backdrop');
      const toggleBtn = document.getElementById('mobile-toggle');
      const iconMenu = toggleBtn ? toggleBtn.querySelector('.icon-menu') : null;
      const iconClose = toggleBtn ? toggleBtn.querySelector('.icon-close') : null;

      const isOpen = drawer ? drawer.classList.contains('active') : false;
      const willOpen = typeof force === 'boolean' ? force : !isOpen;

      if (drawer) drawer.classList.toggle('active', willOpen);
      if (backdrop) backdrop.classList.toggle('active', willOpen);
      if (toggleBtn) toggleBtn.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
      if (iconMenu) iconMenu.style.display = willOpen ? 'none' : 'block';
      if (iconClose) iconClose.style.display = willOpen ? 'block' : 'none';
      document.body.style.overflow = willOpen ? 'hidden' : '';
    }

    // One delegated listener replaces inline handlers: the Content-Security-Policy
    // allows only nonce-carrying script blocks, never on*= attributes.
    document.addEventListener('click', (event) => {
      const target = event.target.closest('[data-action]');
      if (!target) return;
      const action = target.dataset.action;
      if (action === 'open-modal') {
        event.preventDefault();
        openModal(target.dataset.modal + '-modal');
      } else if (action === 'close-modal') {
        closeModal(target.dataset.modal + '-modal');
      } else if (action === 'switch-modal') {
        event.preventDefault();
        switchModal(target.dataset.close + '-modal', target.dataset.modal + '-modal');
      } else if (action === 'drawer-open-modal') {
        toggleMobileNav(false);
        openModal(target.dataset.modal + '-modal');
      } else if (action === 'close-drawer') {
        toggleMobileNav(false);
      } else if (action === 'toggle-drawer') {
        toggleMobileNav();
      } else if (action === 'audience-tab') {
        switchAudienceTab(target.dataset.tab);
      } else if (action === 'sim-view') {
        setSimView(target.dataset.view);
      } else if (action === 'sim-broadcast') {
        simulateBroadcast();
      } else if (action === 'sim-app') {
        showSimMessage('User Portal demo', target.dataset.message);
      } else if (action === 'toggle-faq') {
        toggleFaq(target);
      } else if (action === 'cookie-accept') {
        recordCookieChoice(true);
      } else if (action === 'cookie-reject') {
        recordCookieChoice(false);
      } else if (action === 'cookie-settings') {
        document.getElementById('cookie-banner').hidden = false;
      }
    });

    // Website analytics consent. Zaraz is injected only on the public pages
    // (src/seo.ts) and its own modal is turned off in the dashboard, so this
    // bar asks instead, through the Zaraz Consent API, without blocking the
    // page. Where Zaraz is absent the bar and its footer link stay hidden.
    function zarazConsent() {
      const consent = window.zaraz && window.zaraz.consent;
      return consent && consent.APIReady ? consent : null;
    }
    function recordCookieChoice(accepted) {
      const consent = zarazConsent();
      if (!consent) return;
      consent.setAll(accepted);
      consent.sendQueuedEvents();
      document.getElementById('cookie-banner').hidden = true;
    }
    function initCookieConsent() {
      const consent = zarazConsent();
      if (!consent) return;
      document.getElementById('cookie-settings-link').hidden = false;
      // consent.getAll() reports false for an undecided purpose, so the
      // choice cookie (named in Zaraz's consent settings) says whether one was made.
      const decided = document.cookie.split('; ').some((c) => c.startsWith('zaraz-consent='));
      if (!decided && !consent.modal) document.getElementById('cookie-banner').hidden = false;
    }
    if (zarazConsent()) initCookieConsent();
    else document.addEventListener('zarazConsentAPIReady', initCookieConsent, { once: true });

    // Escape key closes modals and mobile drawer
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        document.querySelectorAll('.modal-overlay.active').forEach(m => m.classList.remove('active'));
        toggleMobileNav(false);
      }
    });

    // Close on backdrop click
    document.querySelectorAll('.modal-overlay').forEach(m => {
      m.addEventListener('click', (e) => {
        if (e.target === m) m.classList.remove('active');
      });
    });

    // Open the modal requested by the server
    const requestedModal = ${escapeJson(data.openModal || null)};
    if (requestedModal === 'login' || requestedModal === 'register' || requestedModal === 'iso') {
      openModal(requestedModal + '-modal');
    }

    // Stakeholder tab switcher
    function switchAudienceTab(tabId) {
      document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
      const activeContent = document.getElementById(tabId);
      if (activeContent) activeContent.classList.add('active');
      const buttons = document.querySelectorAll('.tab-btn');
      const tabMap = {
        'tab-operators': 0,
        'tab-users': 1,
        'tab-universities': 2,
        'tab-smc': 3,
        'tab-corporate': 4
      };
      if (buttons[tabMap[tabId]]) buttons[tabMap[tabId]].classList.add('active');
    }

    // Simulator view switcher
    function setSimView(view) {
      const p = document.getElementById('sim-view-portal');
      const t = document.getElementById('sim-view-operator');
      const c = document.getElementById('sim-view-curtain');
      const bp = document.getElementById('sim-btn-portal');
      const bt = document.getElementById('sim-btn-operator');
      const bc = document.getElementById('sim-btn-curtain');
      
      p.style.display = view === 'portal' ? 'block' : 'none';
      t.style.display = view === 'operator' ? 'block' : 'none';
      c.style.display = view === 'curtain' ? 'block' : 'none';

      bp.classList.toggle('active', view === 'portal');
      bt.classList.toggle('active', view === 'operator');
      bc.classList.toggle('active', view === 'curtain');
    }

    // The demo's dialog. It used to be the browser's own alert and prompt
    // boxes, which carry the browser's wording and look like nothing else here.
    function showSimMessage(title, text) {
      document.getElementById('sim-modal-title').textContent = title;
      document.getElementById('sim-modal-text').textContent = text;
      document.getElementById('sim-broadcast-form').hidden = true;
      const ok = document.getElementById('sim-modal-ok');
      ok.hidden = false;
      openModal('sim-modal');
      ok.focus();
    }

    function simulateBroadcast() {
      document.getElementById('sim-modal-title').textContent = 'Broadcast a page';
      document.getElementById('sim-modal-text').textContent = 'Enter the address to open on every workstation screen.';
      document.getElementById('sim-broadcast-form').hidden = false;
      document.getElementById('sim-modal-ok').hidden = true;
      openModal('sim-modal');
      const field = document.getElementById('sim-broadcast-url');
      field.focus();
      field.select();
    }

    document.getElementById('sim-broadcast-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const url = document.getElementById('sim-broadcast-url').value.trim();
      if (url) showSimMessage('Broadcast sent', 'Every workstation screen is navigating to ' + url);
    });

    // FAQ Accordion Toggle
    function toggleFaq(el) {
      const item = el.parentElement;
      item.classList.toggle('open');
    }

    // Cloudflare Turnstile, when the platform turned it on: one widget in front of
    // the registration code, one in front of the contact form's code and one in
    // front of sign-in. A token works once, so each widget is reset after every attempt.
    const TURNSTILE_SITE_KEY = ${escapeJson(turnstileKey)};
    const turnstileWidgets = {};
    window.lkTurnstileReady = function () {
      const actions = { 'reg-turnstile': 'signup', 'contact-turnstile': 'contact', 'login-turnstile': 'login' };
      Object.keys(actions).forEach((id) => {
        if (document.getElementById(id) && window.turnstile) {
          turnstileWidgets[id] = window.turnstile.render('#' + id, {
            sitekey: TURNSTILE_SITE_KEY,
            action: actions[id]
          });
        }
      });
    };
    function turnstileToken(id) {
      if (!TURNSTILE_SITE_KEY) return '';
      return window.turnstile && turnstileWidgets[id] !== undefined ? (window.turnstile.getResponse(turnstileWidgets[id]) || '') : '';
    }
    function turnstileReset(id) {
      if (window.turnstile && turnstileWidgets[id] !== undefined) window.turnstile.reset(turnstileWidgets[id]);
    }

    // The contact page: a code proves the sender's address, then the message is
    // filed into the platform's mail and answered by email.
    const contactForm = document.getElementById('contact-form');
    if (contactForm) {
      const contactAlert = document.getElementById('contact-alert');
      const contactDone = document.getElementById('contact-done');
      const contactSend = document.getElementById('contact-send-code');
      const contactMessage = document.getElementById('contact-message');
      const contactCount = document.getElementById('contact-count');
      function contactError(message) {
        contactAlert.textContent = message;
        contactAlert.style.display = 'block';
        contactAlert.scrollIntoView({ block: 'nearest' });
      }
      function contactCountShow() {
        contactCount.textContent = contactMessage.value.length + ' / ' + contactMessage.maxLength;
      }
      contactMessage.addEventListener('input', contactCountShow);
      contactCountShow();
      // A link such as /contact?reason=sales arrives with that reason chosen.
      const wantedReason = new URLSearchParams(window.location.search).get('reason');
      const reasonSelect = document.getElementById('contact-reason');
      if (wantedReason && Array.from(reasonSelect.options).some((o) => o.value === wantedReason)) reasonSelect.value = wantedReason;

      contactSend.addEventListener('click', async () => {
        const emailInput = document.getElementById('contact-email');
        const email = emailInput.value.trim();
        contactAlert.style.display = 'none';
        if (!email || !emailInput.checkValidity()) {
          contactError('Enter your email address first.');
          return;
        }
        const token = turnstileToken('contact-turnstile');
        if (TURNSTILE_SITE_KEY && !token) {
          contactError('Complete the check under your email address first.');
          return;
        }
        contactSend.disabled = true;
        try {
          const res = await fetch('/api/contact/email-code', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, turnstileToken: token })
          });
          turnstileReset('contact-turnstile');
          const data = await res.json();
          if (res.ok && data.status === 'ok') {
            contactSend.textContent = 'Code sent';
            document.getElementById('contact-code').focus();
            // A new code may be asked for after a minute.
            setTimeout(() => { contactSend.disabled = false; contactSend.textContent = 'Resend code'; }, 60000);
            return;
          }
          contactError(data.error || 'The code could not be sent.');
        } catch (err) {
          contactError('Network error while sending the code.');
        }
        contactSend.disabled = false;
      });

      contactForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        contactAlert.style.display = 'none';
        const payload = {
          name: document.getElementById('contact-name').value.trim(),
          organization: document.getElementById('contact-org').value.trim(),
          email: document.getElementById('contact-email').value.trim(),
          emailCode: document.getElementById('contact-code').value.trim(),
          reason: reasonSelect.value,
          message: contactMessage.value.trim()
        };
        if (!payload.name || !payload.email || !payload.message) {
          contactError('Your name, email address and a message are required.');
          return;
        }
        if (!/^[0-9]{6}$/.test(payload.emailCode)) {
          contactError('Enter the six-digit code we emailed you. Use Send code if you do not have one.');
          return;
        }
        const submit = document.getElementById('contact-submit');
        submit.disabled = true;
        try {
          const res = await fetch('/api/contact', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
          });
          const data = await res.json();
          if (res.ok && data.status === 'ok') {
            contactForm.hidden = true;
            contactDone.textContent = 'Thank you. Your message is with us under reference ' + data.reference + '. We sent a receipt to ' + payload.email + ' and will reply there.';
            contactDone.style.display = 'block';
            contactDone.scrollIntoView({ block: 'nearest' });
            return;
          }
          contactError(data.error || 'Your message could not be sent.');
        } catch (err) {
          contactError('Network error. Please try again.');
        }
        submit.disabled = false;
      });
    }

    const BASE_DOMAIN = ${escapeJson(baseDomain)};

    /**
     * Which organization this page is showing, if any.
     *
     * The sign-in POST goes to /api/auth/login with no query string, so the
     * server cannot see the ?tenant= that put this page on screen. On a real
     * subdomain the Host header carries it; on a dev host, and on the apex
     * with ?tenant=, nothing did -- which is why signing in to reach the demo
     * console still landed on /super.
     *
     * This is a hint for where to go next, not a claim of access: the server
     * decides what to do with it, and every console is guarded on arrival.
     */
    function currentTenantSlug() {
      const named = new URLSearchParams(window.location.search).get('tenant');
      if (named) return named;
      const host = window.location.hostname;
      const suffix = '.' + BASE_DOMAIN;
      if (host.endsWith(suffix)) {
        const prefix = host.slice(0, -suffix.length);
        if (prefix && prefix.indexOf('.') === -1) return prefix;
      }
      return '';
    }

    // Login Form Submission
    document.getElementById('login-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const email = document.getElementById('login-email').value.trim();
      const password = document.getElementById('login-password').value;
      const alertBox = document.getElementById('login-alert');
      alertBox.style.display = 'none';
      const token = turnstileToken('login-turnstile');
      if (TURNSTILE_SITE_KEY && document.getElementById('login-turnstile') && !token) {
        alertBox.textContent = 'Complete the check above the button first.';
        alertBox.style.display = 'block';
        return;
      }

      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password, tenant: currentTenantSlug(), turnstileToken: token })
        });
        turnstileReset('login-turnstile');
        const data = await res.json();
        if (data.status === 'ok') {
          // The server decides. It is the only side that knows which host this
          // request arrived on and which consoles the account may open. This used
          // to be worked out here, and sent every super admin to /super whatever
          // subdomain they had signed in on.
          window.location.href = data.redirect || '/admin';
        } else if (data.status === 'two_factor') {
          showSecondStep(data);
        } else {
          alertBox.textContent = data.error || 'Login failed';
          alertBox.style.display = 'block';
        }
      } catch (err) {
        alertBox.textContent = 'Network error during login';
        alertBox.style.display = 'block';
      }
    });

    // The second step of a two-factor sign-in: the app's code, an emailed one, or a recovery code.
    const loginForm = document.getElementById('login-form');
    const secondForm = document.getElementById('login-2fa-form');
    const secondNotice = document.getElementById('login-2fa-notice');
    let loginChallenge = '';
    function loginError(message) {
      const alertBox = document.getElementById('login-alert');
      alertBox.textContent = message;
      alertBox.style.display = 'block';
    }
    // The second step is an emailed code unless the account added an authenticator app.
    function showSecondStep(data) {
      const byEmail = data.method === 'email';
      loginChallenge = data.challenge;
      loginForm.hidden = true;
      secondForm.hidden = false;
      secondNotice.textContent = byEmail
        ? 'We emailed a six-digit code to ' + data.sentTo + '. Enter it below.'
        : 'Your account uses two-factor sign-in. Enter the six-digit code from your authenticator app.';
      document.getElementById('login-2fa-label').textContent = byEmail ? 'Code from the email' : 'Code from your authenticator app';
      document.getElementById('login-2fa-email').textContent = byEmail ? 'Send a new code' : 'Email me a code instead';
      document.getElementById('login-2fa-recovery').hidden = byEmail;
      secondNotice.style.display = 'block';
      document.getElementById('login-2fa-code').value = '';
      document.getElementById('login-2fa-code').focus();
    }
    function startOver() {
      loginChallenge = '';
      secondForm.hidden = true;
      loginForm.hidden = false;
      document.getElementById('login-password').value = '';
      document.getElementById('login-password').focus();
    }
    document.getElementById('login-2fa-back').addEventListener('click', () => {
      document.getElementById('login-alert').style.display = 'none';
      startOver();
    });
    secondForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      document.getElementById('login-alert').style.display = 'none';
      try {
        const res = await fetch('/api/auth/login/verify', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            challenge: loginChallenge,
            code: document.getElementById('login-2fa-code').value.trim(),
            trustBrowser: document.getElementById('login-2fa-trust').checked
          })
        });
        const data = await res.json();
        if (data.status === 'ok') {
          window.location.href = data.redirect || '/admin';
          return;
        }
        loginError(data.error || 'That code is not right.');
        // An expired or exhausted sign-in needs the password again.
        if (res.status === 401) startOver();
      } catch (err) {
        loginError('Network error during sign-in');
      }
    });
    document.getElementById('login-2fa-email').addEventListener('click', async () => {
      document.getElementById('login-alert').style.display = 'none';
      try {
        const res = await fetch('/api/auth/login/email-code', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ challenge: loginChallenge })
        });
        const data = await res.json();
        if (res.ok && data.status === 'ok') {
          secondNotice.textContent = 'We emailed a six-digit code to ' + data.sentTo + '. Enter it below.';
          document.getElementById('login-2fa-code').focus();
          return;
        }
        loginError(data.error || 'The code could not be sent.');
        if (res.status === 401) startOver();
      } catch (err) {
        loginError('Network error while sending the code');
      }
    });

    // Registration: confirm the email with a code, then submit the request.
    // The organization is reviewed before it is activated, so no session follows.
    const registerAlert = document.getElementById('register-alert');
    function registerError(message) {
      registerAlert.textContent = message;
      registerAlert.style.display = 'block';
      registerAlert.scrollIntoView({ block: 'nearest' });
    }

    const sendCodeButton = document.getElementById('reg-send-code');
    sendCodeButton.addEventListener('click', async () => {
      const email = document.getElementById('reg-email').value.trim();
      registerAlert.style.display = 'none';
      if (!email) {
        registerError('Enter your work email first.');
        return;
      }
      const token = turnstileToken('reg-turnstile');
      if (TURNSTILE_SITE_KEY && !token) {
        registerError('Complete the check under your email address first.');
        return;
      }
      sendCodeButton.disabled = true;
      try {
        const res = await fetch('/api/auth/register/email-code', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, turnstileToken: token })
        });
        turnstileReset('reg-turnstile');
        const data = await res.json();
        if (res.ok && data.status === 'ok') {
          sendCodeButton.textContent = 'Code sent';
          document.getElementById('reg-code').focus();
          // A new code may be asked for after a minute.
          setTimeout(() => { sendCodeButton.disabled = false; sendCodeButton.textContent = 'Resend code'; }, 60000);
          return;
        }
        registerError(data.error || 'The code could not be sent.');
      } catch (err) {
        registerError('Network error while sending the code.');
      }
      sendCodeButton.disabled = false;
    });

    document.getElementById('register-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      registerAlert.style.display = 'none';
      const value = (id) => document.getElementById(id).value.trim();
      const workstations = parseInt(value('reg-workstations'), 10);
      const payload = {
        name: value('reg-name'),
        legalName: value('reg-legal-name'),
        organizationType: value('reg-type'),
        workstationEstimate: Number.isFinite(workstations) ? workstations : null,
        subdomain: value('reg-subdomain').toLowerCase(),
        contactName: value('reg-contact-name'),
        phone: value('reg-phone'),
        email: value('reg-email'),
        emailCode: value('reg-code'),
        password: document.getElementById('reg-password').value,
        addressLine1: value('reg-address1'),
        addressLine2: value('reg-address2'),
        city: value('reg-city'),
        region: value('reg-region'),
        postalCode: value('reg-postal'),
        country: value('reg-country'),
        taxId: value('reg-tax-id'),
        billingEmail: value('reg-billing-email'),
        notes: value('reg-notes'),
        acceptTerms: document.getElementById('reg-terms').checked
      };

      try {
        const res = await fetch('/api/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
        const data = await res.json();
        if (res.ok && data.status === 'ok') {
          document.getElementById('register-form').style.display = 'none';
          const done = document.getElementById('register-done');
          done.textContent = 'Thank you. Your registration (reference ' + data.reference + ') is waiting for review. ' +
            'We have emailed ' + payload.email + ' and will write again as soon as your console is active.';
          done.style.display = 'block';
          return;
        }
        registerError(data.error || 'Registration failed');
      } catch (err) {
        registerError('Network error during registration');
      }
    });
  </script>
  <script nonce="${escapeAttr(data.nonce)}">${THEME_TOGGLE_SCRIPT}</script>
  <script nonce="${escapeAttr(data.nonce)}">${BUSY_SCRIPT}</script>
  ${
    turnstileKey
      ? `<script nonce="${escapeAttr(data.nonce)}" src="${TURNSTILE_ORIGIN}/turnstile/v0/api.js?render=explicit&amp;onload=lkTurnstileReady" async defer></script>`
      : ""
  }
</body>
</html>`;
}

function landingMainHtml(baseDomain: string, contactEmail: string): string {
  return `
    <!-- Hero Section -->
    <section class="hero">
      <div class="hero-badge-container">
        <span class="badge badge-blue">Source-Available &bull; Free for Education up to 45 PCs</span>
        <span class="badge badge-green">Debian 12 + Cloudflare Edge</span>
      </div>
      <h1 class="hero-title">Turn Any Computer Into a <span>Secure Browser Workstation</span></h1>
      <p class="hero-desc">
        For companies, public services, retail, libraries, schools and anyone who puts shared computers in front of people: manage every screen remotely, lock them in one click, allow only the sites you approve, and wipe every session clean. Runs on any PC or thin client, with zero SSD wear.
      </p>
      <div class="hero-ctas">
        <button class="btn btn-primary btn-lg" data-action="open-modal" data-modal="register">
          Register Your Organization
        </button>
        <button class="btn btn-ghost btn-lg" data-action="open-modal" data-modal="iso">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Download Kiosk ISO
        </button>
        <a href="#simulator" class="btn btn-ghost btn-lg">
          Try Live Simulator &rarr;
        </a>
      </div>

      <!-- Trust Metrics Bar -->
      <div class="metrics-bar">
        <div class="metric-item">
          <div class="metric-value">0 KB</div>
          <div class="metric-label">SSD Write Cycles (100% RAM Overlay)</div>
        </div>
        <div class="metric-item">
          <div class="metric-value">3 s</div>
          <div class="metric-label">Live Screen Refresh While You Watch</div>
        </div>
        <div class="metric-item">
          <div class="metric-value">1-Click</div>
          <div class="metric-label">Lock Every Screen</div>
        </div>
        <div class="metric-item">
          <div class="metric-value">Any PC</div>
          <div class="metric-label">Old Desktops, Thin Clients &amp; New Hardware</div>
        </div>
      </div>
    </section>

    <!-- Stakeholder Solutions Matrix -->
    <section class="section-wrap" id="audiences">
      <div class="section-header">
        <h2 class="section-title">Built for Everyone Who Runs Shared Computers</h2>
        <p class="section-sub">From the IT team and the people at the screens to leadership, educators and hardware partners.</p>
      </div>

      <div class="tabs-nav" role="tablist">
        <button class="tab-btn active" data-action="audience-tab" data-tab="tab-operators" role="tab">For IT &amp; Operations</button>
        <button class="tab-btn" data-action="audience-tab" data-tab="tab-users" role="tab">For End Users</button>
        <button class="tab-btn" data-action="audience-tab" data-tab="tab-universities" role="tab">For Education</button>
        <button class="tab-btn" data-action="audience-tab" data-tab="tab-smc" role="tab">For Leadership &amp; Finance</button>
        <button class="tab-btn" data-action="audience-tab" data-tab="tab-corporate" role="tab">For CSR &amp; Partners</button>
      </div>

      <!-- Operators Tab -->
      <div class="tab-content active" id="tab-operators">
        <div class="audience-card">
          <div class="audience-info">
            <span class="badge badge-blue" style="margin-bottom: 12px;">One Console for Every Screen</span>
            <h3>Run Every Workstation From One Place</h3>
            <p>Looking after dozens of shared computers across a floor, a branch or a campus used to mean walking from desk to desk. With Lab Kiosk you manage all of them from a laptop, tablet or phone, with nothing to install.</p>
            <ul class="audience-bullets">
              <li>
                <span class="bullet-icon">✓</span>
                <span><strong>One-Click Screen Lock:</strong> Cover every selected screen with a message, for a briefing, a maintenance window or the end of a shift.</span>
              </li>
              <li>
                <span class="bullet-icon">✓</span>
                <span><strong>Live Screen Thumbnails:</strong> Previews refresh every 3 seconds, so you can see at a glance what every workstation is showing.</span>
              </li>
              <li>
                <span class="bullet-icon">✓</span>
                <span><strong>Remote Assist:</strong> Take over the keyboard and mouse of any workstation to help someone without leaving your desk.</span>
              </li>
              <li>
                <span class="bullet-icon">✓</span>
                <span><strong>Broadcast Pages:</strong> Open the same approved page on every selected workstation at once.</span>
              </li>
            </ul>
          </div>
          <div class="audience-preview">
            <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border); padding-bottom: 12px;">
              <span style="font-weight: 700; font-size: 14px;">Admin Console • Front Office</span>
              <span class="badge badge-green">38 Workstations Online</span>
            </div>
            <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px;">
              <div style="background: var(--bg-surface); border-radius: 8px; padding: 10px; text-align: center; border: 1px solid var(--border);">
                <div style="font-size: 11px; color: var(--muted);">PC-01</div>
                <div style="height: 48px; background: var(--bg-subtle); border-radius: 4px; margin: 6px 0; display: flex; align-items: center; justify-content: center; font-size: 11px; color: var(--accent-text);">Intranet</div>
                <div style="font-size: 10px; color: var(--success-text);">● Active</div>
              </div>
              <div style="background: var(--bg-surface); border-radius: 8px; padding: 10px; text-align: center; border: 1px solid var(--border);">
                <div style="font-size: 11px; color: var(--muted);">PC-02</div>
                <div style="height: 48px; background: var(--bg-subtle); border-radius: 4px; margin: 6px 0; display: flex; align-items: center; justify-content: center; font-size: 11px; color: var(--accent-text);">Service Portal</div>
                <div style="font-size: 10px; color: var(--success-text);">● Active</div>
              </div>
              <div style="background: var(--bg-surface); border-radius: 8px; padding: 10px; text-align: center; border: 1px solid var(--danger);">
                <div style="font-size: 11px; color: var(--muted);">PC-03</div>
                <div style="height: 48px; background: var(--bg-subtle); border-radius: 4px; margin: 6px 0; display: flex; align-items: center; justify-content: center; font-size: 11px; color: var(--danger-text);">Blocked Site</div>
                <div style="font-size: 10px; color: var(--danger-text);">● Intercepted</div>
              </div>
            </div>
            <button class="btn btn-primary btn-block" style="margin-top: 8px;" data-action="open-modal" data-modal="register">Register Your Organization</button>
          </div>
        </div>
      </div>

      <!-- Users Tab -->
      <div class="tab-content" id="tab-users">
        <div class="audience-card">
          <div class="audience-info">
            <span class="badge badge-green" style="margin-bottom: 12px;">Safe &amp; Distraction-Free</span>
            <h3>A Fast, Focused Browser Station</h3>
            <p>People get a smooth, full-screen browser with only the sites they need: no malware, no pop-ups, no leftover sign-ins from the person before them.</p>
            <ul class="audience-bullets">
              <li>
                <span class="bullet-icon">✓</span>
                <span><strong>Visual App Launcher:</strong> One-click cards for the approved apps and sites your organization chooses.</span>
              </li>
              <li>
                <span class="bullet-icon">✓</span>
                <span><strong>Zero-Lag Native Browsing:</strong> Full-screen high-performance Chromium rendering without restrictive or laggy iframes.</span>
              </li>
              <li>
                <span class="bullet-icon">✓</span>
                <span><strong>Clean Sessions:</strong> No browsing history, cookies, sign-ins or files are kept. Clear Session wipes them on demand; a restart wipes everything.</span>
              </li>
              <li>
                <span class="bullet-icon">✓</span>
                <span><strong>Auto-Hiding Navigation Bar:</strong> The top bar glides off-screen, leaving the whole display to the page.</span>
              </li>
            </ul>
          </div>
          <div class="audience-preview">
            <div style="background: var(--bg-subtle); border: 1px solid var(--border); border-radius: 10px; padding: 16px;">
              <h4 style="font-size: 14px; margin-bottom: 10px; color: var(--accent-text);">User Portal Launcher</h4>
              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
                <div style="background: var(--bg-surface); padding: 12px; border-radius: 8px; border: 1px solid var(--border); text-align: center;">
                  <div style="font-size: 20px; margin-bottom: 4px;">🗂️</div>
                  <div style="font-weight: 700; font-size: 12px;">Document Library</div>
                </div>
                <div style="background: var(--bg-surface); padding: 12px; border-radius: 8px; border: 1px solid var(--border); text-align: center;">
                  <div style="font-size: 20px; margin-bottom: 4px;">🧾</div>
                  <div style="font-weight: 700; font-size: 12px;">Self-Service Forms</div>
                </div>
              </div>
            </div>
            <div style="font-size: 12px; color: var(--muted); text-align: center;">All sessions reset upon computer shutdown.</div>
          </div>
        </div>
      </div>

      <!-- Universities Tab -->
      <div class="tab-content" id="tab-universities">
        <div class="audience-card">
          <div class="audience-info">
            <span class="badge badge-blue" style="margin-bottom: 12px;">Schools, Colleges &amp; Universities</span>
            <h3>Computer Labs and Secure Assessments</h3>
            <p>Run school computer labs, coding practicals and invigilated assessments on the same locked-down image, across one room or hundreds of campus workstations. Free for accredited educational institutions up to 45 computers.</p>
            <ul class="audience-bullets">
              <li>
                <span class="bullet-icon">✓</span>
                <span><strong>Examination Lockdown Browser:</strong> Enforce strict whitelists for midterms, coding practicals, and aptitude assessments.</span>
              </li>
              <li>
                <span class="bullet-icon">✓</span>
                <span><strong>Web IDE &amp; Jupyter Ready:</strong> Supports WebAssembly compilers, JupyterLite, and VS Code Web with zero client install.</span>
              </li>
              <li>
                <span class="bullet-icon">✓</span>
                <span><strong>Global Edge Scalability:</strong> Powered by Cloudflare Workers and D1, easily handling simultaneous lab traffic across multiple campus buildings.</span>
              </li>
              <li>
                <span class="bullet-icon">✓</span>
                <span><strong>Hardware Independence:</strong> Run the exact same secure image on legacy Intel Core 2 Duos, modern i7 desktops, or thin clients.</span>
              </li>
            </ul>
          </div>
          <div class="audience-preview">
            <h4 style="font-size: 15px; margin-bottom: 12px;">Campus Examination Mode</h4>
            <div style="background: var(--bg-surface); border-radius: 8px; padding: 16px; border: 1px solid var(--border); font-size: 13px; line-height: 1.6;">
              <p><strong>Status:</strong> Strict Examination Lockdown Active</p>
              <p><strong>DevTools &amp; Extensions:</strong> Disabled</p>
              <p><strong>Domain Allowlist:</strong> <code>assessments.university.edu</code> only</p>
              <p><strong>External USB / TTY:</strong> Blocked</p>
            </div>
            <a href="mailto:${escapeHtml(contactEmail)}?subject=Education%20Deployment" class="btn btn-primary btn-block">Inquire About Education Deployments</a>
          </div>
        </div>
      </div>

      <!-- SMC / Organization Board Tab -->
      <div class="tab-content" id="tab-smc">
        <div class="audience-card">
          <div class="audience-info">
            <span class="badge badge-green" style="margin-bottom: 12px;">Budget &amp; TCO Optimization</span>
            <h3>Lower Running Costs &amp; Zero SSD Wear</h3>
            <p>Leadership and finance teams can retire per-seat desktop OS and antivirus licenses on shared machines and keep existing hardware in service for years longer.</p>
            <ul class="audience-bullets">
              <li>
                <span class="bullet-icon">✓</span>
                <span><strong>Zero SSD Wear:</strong> Thin client flash drives (16GB-32GB) degrade rapidly under Windows. Lab Kiosk diverts session writes to volatile RAM (<code>tmpfs</code>), so the drive is not worn by everyday use.</span>
              </li>
              <li>
                <span class="bullet-icon">✓</span>
                <span><strong>Hardware Resurrection:</strong> Put older desktop PCs (Core 2 Duo class, 2 GB RAM) back to work as browser workstations.</span>
              </li>
              <li>
                <span class="bullet-icon">✓</span>
                <span><strong>No Desktop OS Licenses:</strong> A Debian-based, source-available stack replaces Windows and antivirus licenses on every shared seat.</span>
              </li>
              <li>
                <span class="bullet-icon">✓</span>
                <span><strong>Allowlist-Only Browsing:</strong> Every site is blocked unless you approve its domain, enforced by the browser's managed policy.</span>
              </li>
            </ul>
          </div>
          <div class="audience-preview">
            <h4 style="font-size: 15px; margin-bottom: 12px;">What a Shared Seat Costs</h4>
            <table style="width: 100%; font-size: 13px; border-collapse: collapse; margin-bottom: 16px;">
              <tr style="border-bottom: 1px solid var(--border);">
                <td style="padding: 8px 0; color: var(--muted);">OS &amp; Antivirus Licenses</td>
                <td style="padding: 8px 0; text-align: right; color: var(--muted);">Per seat, every year</td>
              </tr>
              <tr style="border-bottom: 1px solid var(--border);">
                <td style="padding: 8px 0; color: var(--muted);">SSD Replacements</td>
                <td style="padding: 8px 0; text-align: right; color: var(--muted);">As drives wear out</td>
              </tr>
              <tr style="border-bottom: 1px solid var(--border);">
                <td style="padding: 8px 0; font-weight: 700; color: var(--text-main);">Lab Kiosk</td>
                <td style="padding: 8px 0; text-align: right; font-weight: 800; color: var(--success-text); font-size: 13px;">Free for education &le; 45 PCs; commercial license otherwise</td>
              </tr>
            </table>
            <button class="btn btn-primary btn-block" data-action="open-modal" data-modal="register">Register Your Organization</button>
          </div>
        </div>
      </div>

      <!-- Corporate / CSR Tab -->
      <div class="tab-content" id="tab-corporate">
        <div class="audience-card">
          <div class="audience-info">
            <span class="badge badge-blue" style="margin-bottom: 12px;">Corporate CSR &amp; EdTech</span>
            <h3>Turn Corporate E-Waste into Community Workstations</h3>
            <p>Companies and donors can partner with Lab Kiosk to refurbish off-lease computers into turnkey, secure workstations for schools, libraries and community centers in underserved areas.</p>
            <ul class="audience-bullets">
              <li>
                <span class="bullet-icon">✓</span>
                <span><strong>Circular Economy &amp; ESG:</strong> Divert functional e-waste from landfill and put it to work in high-need communities.</span>
              </li>
              <li>
                <span class="bullet-icon">✓</span>
                <span><strong>Turnkey Flash-and-Go:</strong> Write the Lab Kiosk ISO onto a batch of USB keys. Each computer boots into an enrollment screen in seconds.</span>
              </li>
              <li>
                <span class="bullet-icon">✓</span>
                <span><strong>Ready-Made Launchers:</strong> Pre-configure the approved platforms each site needs directly into the user launcher.</span>
              </li>
              <li>
                <span class="bullet-icon">✓</span>
                <span><strong>Verifiable Impact:</strong> Real-time telemetry lets donors see workstation usage and uptime transparently.</span>
              </li>
            </ul>
          </div>
          <div class="audience-preview">
            <h4 style="font-size: 15px; margin-bottom: 12px;">CSR Sponsorship &amp; Partnerships</h4>
            <p style="font-size: 13px; color: var(--muted); margin-bottom: 16px;">
              Whether your enterprise has 50 or 5,000 PCs to donate, we provide the operating system, cloud control plane, and training materials.
            </p>
            <a href="mailto:partners@labkiosk.org?subject=CSR%20Hardware%20Donation%20Inquiry" class="btn btn-primary btn-block">Contact CSR &amp; Partner Team</a>
          </div>
        </div>
      </div>
    </section>

    <!-- Live In-Page Interactive Simulator -->
    <section class="section-wrap" id="simulator">
      <div class="section-header">
        <h2 class="section-title">Experience the Platform Live</h2>
        <p class="section-sub">Try the user portal, the admin console, and the screen lock.</p>
      </div>

      <div class="simulator-wrap">
        <div class="simulator-bar">
          <div class="window-dots">
            <span class="window-dot"></span>
            <span class="window-dot"></span>
            <span class="window-dot"></span>
            <span class="window-url">https://web-demo.${escapeHtml(baseDomain)}</span>
          </div>
          <div class="sim-controls">
            <button class="sim-tab-btn active" id="sim-btn-portal" data-action="sim-view" data-view="portal">User Portal</button>
            <button class="sim-tab-btn" id="sim-btn-operator" data-action="sim-view" data-view="operator">Admin Console</button>
            <button class="sim-tab-btn" id="sim-btn-curtain" data-action="sim-view" data-view="curtain">Screen Lock</button>
          </div>
        </div>

        <div class="simulator-body" id="sim-body">
          <!-- User Portal Simulation -->
          <div id="sim-view-portal" style="display: block;">
            <div style="text-align: center; margin-bottom: 24px;">
              <h3 style="font-size: 22px; font-weight: 800; color: var(--text-main);">Select an Approved Resource</h3>
              <p style="font-size: 14px; color: var(--muted);">Click any approved application below to open it.</p>
            </div>
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; max-width: 800px; margin: 0 auto;">
              <div class="sim-app-card" style="background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 20px; text-align: center; cursor: pointer;" data-action="sim-app" data-message="Opening the Company Intranet as a full, native page.">
                <div style="font-size: 32px; margin-bottom: 8px;">🏢</div>
                <div style="font-weight: 700; font-size: 14px;">Company Intranet</div>
                <div style="font-size: 11px; color: var(--muted); margin-top: 4px;">News &amp; Policies</div>
              </div>
              <div class="sim-app-card" style="background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 20px; text-align: center; cursor: pointer;" data-action="sim-app" data-message="Opening the Service Desk.">
                <div style="font-size: 32px; margin-bottom: 8px;">🎧</div>
                <div style="font-weight: 700; font-size: 14px;">Service Desk</div>
                <div style="font-size: 11px; color: var(--muted); margin-top: 4px;">Tickets &amp; Requests</div>
              </div>
              <div class="sim-app-card" style="background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 20px; text-align: center; cursor: pointer;" data-action="sim-app" data-message="Opening the Training Portal.">
                <div style="font-size: 32px; margin-bottom: 8px;">📚</div>
                <div style="font-weight: 700; font-size: 14px;">Training Portal</div>
                <div style="font-size: 11px; color: var(--muted); margin-top: 4px;">Courses &amp; Guides</div>
              </div>
              <div class="sim-app-card" style="background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 20px; text-align: center; cursor: pointer;" data-action="sim-app" data-message="Opening Self-Service Forms.">
                <div style="font-size: 32px; margin-bottom: 8px;">🧾</div>
                <div style="font-weight: 700; font-size: 14px;">Self-Service Forms</div>
                <div style="font-size: 11px; color: var(--muted); margin-top: 4px;">Applications &amp; Requests</div>
              </div>
            </div>
          </div>

          <!-- Admin Console Simulation -->
          <div id="sim-view-operator" style="display: none;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 18px; flex-wrap: wrap; gap: 12px;">
              <div>
                <h4 style="font-size: 18px; font-weight: 700;">Workstation Grid • Front Office</h4>
                <p style="font-size: 13px; color: var(--muted);">Click 'Lock Screens' to pause every screen, or broadcast a URL.</p>
              </div>
              <div style="display: flex; gap: 10px;">
                <button class="btn btn-ghost btn-sm" data-action="sim-broadcast">Broadcast URL</button>
                <button class="btn btn-danger-solid btn-sm" data-action="sim-view" data-view="curtain">Lock Screens 🔒</button>
              </div>
            </div>
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 12px;">
              <div style="background: var(--bg-surface); border-radius: 8px; padding: 12px; text-align: center; border: 1px solid var(--border);">
                <div style="font-size: 12px; font-weight: 700;">PC-01</div>
                <div style="height: 50px; background: var(--bg-subtle); border-radius: 4px; margin: 8px 0; display: flex; align-items: center; justify-content: center; font-size: 11px; color: var(--accent-text);">Intranet</div>
                <span style="font-size: 10px; color: var(--success-text);">● Online</span>
              </div>
              <div style="background: var(--bg-surface); border-radius: 8px; padding: 12px; text-align: center; border: 1px solid var(--border);">
                <div style="font-size: 12px; font-weight: 700;">PC-02</div>
                <div style="height: 50px; background: var(--bg-subtle); border-radius: 4px; margin: 8px 0; display: flex; align-items: center; justify-content: center; font-size: 11px; color: var(--accent-text);">Service Desk</div>
                <span style="font-size: 10px; color: var(--success-text);">● Online</span>
              </div>
              <div style="background: var(--bg-surface); border-radius: 8px; padding: 12px; text-align: center; border: 1px solid var(--border);">
                <div style="font-size: 12px; font-weight: 700;">PC-03</div>
                <div style="height: 50px; background: var(--bg-subtle); border-radius: 4px; margin: 8px 0; display: flex; align-items: center; justify-content: center; font-size: 11px; color: var(--accent-text);">Training Portal</div>
                <span style="font-size: 10px; color: var(--success-text);">● Online</span>
              </div>
              <div style="background: var(--bg-surface); border-radius: 8px; padding: 12px; text-align: center; border: 1px solid var(--border);">
                <div style="font-size: 12px; font-weight: 700;">PC-04</div>
                <div style="height: 50px; background: var(--bg-subtle); border-radius: 4px; margin: 8px 0; display: flex; align-items: center; justify-content: center; font-size: 11px; color: var(--accent-text);">Self-Service Forms</div>
                <span style="font-size: 10px; color: var(--success-text);">● Online</span>
              </div>
            </div>
          </div>

          <!-- Screen Lock Simulation -->
          <div id="sim-view-curtain" style="display: none; background: var(--bg-base); border: 2px dashed var(--danger); border-radius: 12px; padding: 48px 24px; text-align: center;">
            <div style="font-size: 48px; margin-bottom: 16px;">🔒</div>
            <h3 style="font-size: 26px; font-weight: 800; color: var(--danger-text); margin-bottom: 8px;">Screens Paused</h3>
            <p style="font-size: 16px; color: var(--text-muted); max-width: 500px; margin: 0 auto 24px;">
              "This workstation has been paused by an administrator. Please wait."
            </p>
            <div style="font-size: 12px; color: var(--muted); margin-bottom: 20px;">All keyboard input and clicks are blocked until an administrator unlocks.</div>
            <button class="btn btn-primary" data-action="sim-view" data-view="operator">Unlock Screens</button>
          </div>
        </div>
      </div>
    </section>

    <!-- Detailed Features Grid -->
    <section class="section-wrap" id="features">
      <div class="section-header">
        <h2 class="section-title">Engineered for Shared Workstations</h2>
        <p class="section-sub">Zero maintenance, central control, and tamper-proof by design.</p>
      </div>

      <div class="features-grid">
        <div class="feature-card">
          <div class="feature-icon" aria-hidden="true">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          </div>
          <h3 class="feature-title">Zero SSD Wear (RAM Overlay)</h3>
          <p class="feature-desc">All disk writes are strictly directed to volatile RAM via <code>overlayroot="tmpfs:recurse=0"</code>. Protects thin-client SSDs from wearing out and erases user files on every reboot.</p>
        </div>

        <div class="feature-card">
          <div class="feature-icon" aria-hidden="true">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          </div>
          <h3 class="feature-title">Instant Screen Lock</h3>
          <p class="feature-desc">One click covers the selected screens with a fullscreen message. Unlocks instantly when you are ready.</p>
        </div>

        <div class="feature-card">
          <div class="feature-icon" aria-hidden="true">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><polyline points="8 21 16 21 12 17"/></svg>
          </div>
          <h3 class="feature-title">Live Grid &amp; Remote Control</h3>
          <p class="feature-desc">Live screen thumbnails update every 3 seconds on your dashboard. Click any workstation to instantly take interactive keyboard and mouse control via noVNC.</p>
        </div>

        <div class="feature-card">
          <div class="feature-icon" aria-hidden="true">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/></svg>
          </div>
          <h3 class="feature-title">Custom Organization Subdomains</h3>
          <p class="feature-desc">Every organization gets its own custom subdomain (e.g. <code>greenwood.${escapeHtml(baseDomain)}</code>). Thin clients connect separately and remain 100% isolated to your organization's private dashboard.</p>
        </div>

        <div class="feature-card">
          <div class="feature-icon" aria-hidden="true">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
          </div>
          <h3 class="feature-title">Visual User App Launcher</h3>
          <p class="feature-desc">Admins configure cards with custom thumbnails for the websites they approve. Users launch them in one click.</p>
        </div>

        <div class="feature-card">
          <div class="feature-icon" aria-hidden="true">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
          </div>
          <h3 class="feature-title">Auto-Hiding Floating Navigation</h3>
          <p class="feature-desc">The 4-button locked navigation bar hides off-screen and smoothly slides down only when moving the mouse to the top edge, ensuring zero webpage overflow.</p>
        </div>

        <div class="feature-card">
          <div class="feature-icon" aria-hidden="true">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
          </div>
          <h3 class="feature-title">Runs in Your Language</h3>
          <p class="feature-desc">The workstation interface itself is translatable, with right-to-left layout where a language needs it. New languages reach workstations over the air, without a new ISO.</p>
        </div>

        <div class="feature-card">
          <div class="feature-icon" aria-hidden="true">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
          </div>
          <h3 class="feature-title">A Record of Every Change</h3>
          <p class="feature-desc">Subdomain changes, staff accounts, allowlist edits and key rotations are recorded and readable from your console, including anything the platform did to your organization.</p>
        </div>
      </div>
    </section>

    <!-- Hardware Compatibility & Specs Section -->
    <section class="section-wrap" id="specs">
      <div class="section-header">
        <h2 class="section-title">Hardware Specs &amp; Compatibility</h2>
        <p class="section-sub">Bring older desktops back into service or run on modern thin clients, without hardware upgrades.</p>
      </div>

      <div class="specs-table-container">
        <table class="specs-table">
          <thead>
            <tr>
              <th>Component</th>
              <th>Minimum Requirement</th>
              <th>Recommended Specification</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><strong>Processor (CPU)</strong></td>
              <td>64-bit x86-64 (Intel Core 2 Duo, AMD Athlon 64, or newer)</td>
              <td>Intel Core i3/i5/i7 (2nd gen+), Celeron J4105, or modern AMD Ryzen</td>
            </tr>
            <tr>
              <td><strong>System Memory (RAM)</strong></td>
              <td>2 GB RAM (the system and the browser run from RAM)</td>
              <td>4 GB or 8 GB RAM for ultra-smooth multi-app switching</td>
            </tr>
            <tr>
              <td><strong>Storage Drive</strong></td>
              <td>2 GB+ USB flash drive (USB 2.0 or 3.0); internal disk not required</td>
              <td>Fast USB 3.0/3.1 Thumb Drive or Internal M.2 / SATA SSD</td>
            </tr>
            <tr>
              <td><strong>Network</strong></td>
              <td>10/100 Mbps Fast Ethernet or 802.11n Wi-Fi</td>
              <td>Gigabit Ethernet (1000 Mbps) or 802.11ac Wi-Fi</td>
            </tr>
            <tr>
              <td><strong>Display Output</strong></td>
              <td>VGA / DVI / HDMI supporting 1024x768 resolution</td>
              <td>1080p Full HD (1920x1080) or higher via HDMI/DisplayPort</td>
            </tr>
            <tr>
              <td><strong>Compatibility</strong></td>
              <td colspan="2">Any 64-bit x86 desktop, laptop or thin client that can start from a USB drive, with legacy BIOS or UEFI firmware (Secure Boot supported).</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- Security & Architecture Section -->
    <section class="section-wrap" id="security">
      <div class="section-header">
        <h2 class="section-title">Tamper-Proof Architecture</h2>
        <p class="section-sub">Engineered defense-in-depth from the Linux kernel up to Cloudflare's serverless edge.</p>
      </div>

      <div style="background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 36px;">
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 24px;">
          <div>
            <h4 style="font-size: 16px; font-weight: 700; color: var(--accent-text); margin-bottom: 8px;">1. Client OS Lockdown</h4>
            <p style="font-size: 14px; color: var(--muted); line-height: 1.6;">
              Virtual TTY consoles (TTY1-6) and X11 VT-switching keys are masked. Openbox runs without window border escape keybindings. The root filesystem is mounted strictly read-only.
            </p>
          </div>
          <div>
            <h4 style="font-size: 16px; font-weight: 700; color: var(--accent-text); margin-bottom: 8px;">2. Managed Enterprise Chromium</h4>
            <p style="font-size: 14px; color: var(--muted); line-height: 1.6;">
              <code>URLBlocklist</code> denies every <code>http</code> and <code>https</code> address by default. The local agent applies the organization's approved list to <code>URLAllowlist</code> as soon as it changes.
            </p>
          </div>
          <div>
            <h4 style="font-size: 16px; font-weight: 700; color: var(--accent-text); margin-bottom: 8px;">3. Cloudflare Edge &amp; Web Crypto</h4>
            <p style="font-size: 14px; color: var(--muted); line-height: 1.6;">
              Control plane runs across 300+ edge colocations. Passwords are protected using native Web Crypto <code>PBKDF2-HMAC-SHA256</code> with 100,000 iterations. Workstations communicate via cryptographically hashed device tokens.
            </p>
          </div>
        </div>
      </div>
    </section>

    <!-- FAQ Section -->
    <section class="section-wrap" id="faq">
      <div class="section-header">
        <h2 class="section-title">Frequently Asked Questions</h2>
        <p class="section-sub">Common questions from IT administrators, operations managers and education leads.</p>
      </div>

      <div class="faq-list">
        <div class="faq-item">
          <div class="faq-question" data-action="toggle-faq">
            <span>Does Lab Kiosk work with weak or intermittent internet?</span>
            <span class="faq-chevron">▼</span>
          </div>
          <div class="faq-answer">
            Yes! Unlike streaming thin-client OS solutions that download their rootfs over the internet, the entire Lab Kiosk operating system resides in the computer's local RAM. Once booted, thin clients only transmit lightweight JSON telemetry heartbeats (&lt; 2 KB). If the internet drops temporarily, running approved tools and local web pages continue to function.
          </div>
        </div>

        <div class="faq-item">
          <div class="faq-question" data-action="toggle-faq">
            <span>What happens if a user tries to open other websites or download software?</span>
            <span class="faq-chevron">▼</span>
          </div>
          <div class="faq-answer">
            All unauthorized browsing is immediately denied by Chromium's enterprise managed policy (<code>URLBlocklist</code> covers every web address that is not on your allowlist). Downloads, print menus, bookmarks, extension installations, and DevTools (<code>F12</code>) are permanently disabled. In addition, USB thumb drive automounting is blocked, preventing users from running unauthorized scripts.
          </div>
        </div>

        <div class="faq-item">
          <div class="faq-question" data-action="toggle-faq">
            <span>How does the 100% RAM Overlay protect our thin-client hardware?</span>
            <span class="faq-chevron">▼</span>
          </div>
          <div class="faq-answer">
            Thin clients typically ship with small eMMC or flash SSDs (16 GB–32 GB) that burn through limited write endurance cycles under Windows logging and pagefiles. Lab Kiosk mounts the root filesystem as read-only and redirects all file creation and browser caches to volatile system RAM (<code>tmpfs</code>). Flash storage is not written to during user sessions.
          </div>
        </div>

        <div class="faq-item">
          <div class="faq-question" data-action="toggle-faq">
            <span>Is Lab Kiosk free to use?</span>
            <span class="faq-chevron">▼</span>
          </div>
          <div class="faq-answer">
            Free for schools up to 45 computers, yes. The operating system build pipeline (Debian 12 Live-Build), agent daemon, and Cloudflare Worker control plane are source-available under the LabKiosk Software License: free for non-profit, accredited schools, colleges and universities, and for non-commercial evaluation and research, on up to 45 computers. Any deployment with more than 45 computers, or by a business, needs a commercial or subscriber license.
          </div>
        </div>

        <div class="faq-item">
          <div class="faq-question" data-action="toggle-faq">
            <span>How do we deploy this across many sites?</span>
            <span class="faq-chevron">▼</span>
          </div>
          <div class="faq-answer">
            Register on this website and we review the request. Once it is approved you receive your organization subdomain (e.g. <code>yourorganization.${escapeHtml(baseDomain)}</code>) and an enrollment key. Write the ISO to a USB flash drive, boot your lab computers, and complete the 3-step setup wizard on each machine. They immediately link to your private cloud dashboard.
          </div>
        </div>
      </div>
    </section>

    <!-- Global Contact & Deployment Support -->
    <section class="section-wrap" id="contact">
      <div class="section-header">
        <h2 class="section-title">Global Contact &amp; Support</h2>
        <p class="section-sub">Questions about onboarding, large deployments, education licensing or CSR hardware donations? Get in touch with our team.</p>
      </div>

      <div class="contact-grid">
        <div class="contact-card">
          <div class="feature-icon" aria-hidden="true" style="margin-bottom: 12px;">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
          </div>
          <h4>General &amp; Sales Inquiries</h4>
          <p>For organizations evaluating Lab Kiosk, commercial licensing, and general questions.</p>
          <a href="mailto:${escapeHtml(contactEmail)}" class="contact-link">${escapeHtml(contactEmail)}</a>
        </div>

        <div class="contact-card">
          <div class="feature-icon" aria-hidden="true" style="margin-bottom: 12px;">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
          </div>
          <h4>Technical &amp; Deployment Support</h4>
          <p>Assistance with ISO flashing, thin client hardware compatibility, and network setup.</p>
          <a href="mailto:support@labkiosk.org" class="contact-link">support@labkiosk.org</a>
        </div>

        <div class="contact-card">
          <div class="feature-icon" aria-hidden="true" style="margin-bottom: 12px;">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
          </div>
          <h4>Education, CSR &amp; Partners</h4>
          <p>Education deployments, hardware donation partnerships, and platform allowlisting.</p>
          <a href="mailto:partners@labkiosk.org" class="contact-link">partners@labkiosk.org</a>
        </div>
      </div>

      <div style="text-align: center; margin-top: 36px;">
        <a class="btn btn-ghost" href="/contact">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          Write to Us With the Contact Form
        </a>
      </div>
    </section>`;
}

export function renderLandingHtml(data: LandingOptions): string {
  const baseDomain = (data.baseDomain || "labkiosk.org").toLowerCase().replace(/^\./, "");
  const contactEmail = (data.contactEmail || "contact@labkiosk.org").toLowerCase();
  return renderPublicShell(data, {
    title: PAGE_TITLE,
    description: PAGE_DESCRIPTION,
    mainHtml: landingMainHtml(baseDomain, contactEmail)
  });
}

function featuresMainHtml(): string {
  return `
    <section class="page-hero">
      <div class="hero-badge-container">
        <span class="badge badge-blue">Built for Central Management</span>
        <span class="badge badge-green">Debian 12 + Cloudflare Edge</span>
      </div>
      <h1 class="page-hero-title">Enterprise Kiosk <span>Capabilities</span></h1>
      <p class="page-hero-desc">
        Defense-in-depth from the Linux kernel to the serverless edge. Everything needed to secure public terminals, shared workstations, and thin-client fleets without hardware wear.
      </p>
    </section>

    <section class="section-wrap" style="padding-top: 0;">
      <div class="features-deep-grid">
        <div class="feature-deep-card">
          <div class="feature-deep-header">
            <div class="feature-icon" aria-hidden="true">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
            </div>
            <h2 class="feature-deep-title">Tamper-Proof OS Lockdown</h2>
          </div>
          <p class="feature-deep-text">
            Virtual TTY consoles (TTY1-6) and X11 VT-switching shortcuts (Ctrl+Alt+F1-F7) are permanently masked. Openbox window manager runs without escape keybindings. USB storage automounting is blocked, preventing unauthorized execution.
          </p>
          <div class="feature-badge-list">
            <span class="feature-tag">Read-Only Root</span>
            <span class="feature-tag">Masked TTYs</span>
            <span class="feature-tag">Openbox Lockdown</span>
            <span class="feature-tag">No USB Mount</span>
          </div>
        </div>

        <div class="feature-deep-card">
          <div class="feature-deep-header">
            <div class="feature-icon" aria-hidden="true">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
            </div>
            <h2 class="feature-deep-title">Managed Enterprise Chromium</h2>
          </div>
          <p class="feature-deep-text">
            A system-level <code>URLBlocklist</code> covers every <code>http</code> and <code>https</code> address. Workstations access only the domains explicitly approved in your organization console. DevTools, downloads, extensions, and print dialogs are permanently disabled.
          </p>
          <div class="feature-badge-list">
            <span class="feature-tag">URL Allowlisting</span>
            <span class="feature-tag">F12 Blocked</span>
            <span class="feature-tag">Zero Extensions</span>
            <span class="feature-tag">Managed Policy</span>
          </div>
        </div>

        <div class="feature-deep-card">
          <div class="feature-deep-header">
            <div class="feature-icon" aria-hidden="true">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>
            </div>
            <h2 class="feature-deep-title">100% RAM Overlay (Zero SSD Wear)</h2>
          </div>
          <p class="feature-deep-text">
            The root filesystem mounts read-only with a volatile tmpfs overlay (<code>overlayroot="tmpfs:recurse=0"</code>). Browser caches, temporary logs, and session files live strictly in RAM. Thin clients with small flash SSDs experience zero write cycles.
          </p>
          <div class="feature-badge-list">
            <span class="feature-tag">0 KB Flash Writes</span>
            <span class="feature-tag">tmpfs Overlay</span>
            <span class="feature-tag">Stateless Boot</span>
            <span class="feature-tag">Hardware Longevity</span>
          </div>
        </div>

        <div class="feature-deep-card">
          <div class="feature-deep-header">
            <div class="feature-icon" aria-hidden="true">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
            </div>
            <h2 class="feature-deep-title">Real-Time OrgHub WebSockets</h2>
          </div>
          <p class="feature-deep-text">
            Every workstation maintains an authenticated WebSocket connection to its organization's dedicated Cloudflare Durable Object (OrgHub). Remote commands (lock, navigate, reload, reboot, shutdown) are pushed to connected workstations the moment you send them.
          </p>
          <div class="feature-badge-list">
            <span class="feature-tag">Durable Objects</span>
            <span class="feature-tag">WebSockets</span>
            <span class="feature-tag">Instant Push</span>
            <span class="feature-tag">HTTP Fallback</span>
          </div>
        </div>

        <div class="feature-deep-card">
          <div class="feature-deep-header">
            <div class="feature-icon" aria-hidden="true">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><polyline points="8 21 16 21 12 17"/></svg>
            </div>
            <h2 class="feature-deep-title">VNC Remote Control Relay</h2>
          </div>
          <p class="feature-deep-text">
            Assist users directly from your browser without opening firewall ports. RemoteRelay pairs the operator console's browser with the workstation's loopback x11vnc session over WebSockets encrypted with TLS, relayed through Cloudflare.
          </p>
          <div class="feature-badge-list">
            <span class="feature-tag">noVNC In-Browser</span>
            <span class="feature-tag">Zero Port Forwarding</span>
            <span class="feature-tag">RemoteRelay</span>
            <span class="feature-tag">TLS Encrypted</span>
          </div>
        </div>

        <div class="feature-deep-card">
          <div class="feature-deep-header">
            <div class="feature-icon" aria-hidden="true">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>
            </div>
            <h2 class="feature-deep-title">Multi-Lingual Interface (i18n)</h2>
          </div>
          <p class="feature-deep-text">
            Complete internationalization support for workstation UI, top bar, lock curtain, and setup wizard. Full right-to-left (RTL) layout switching for Arabic, Hebrew, and Urdu. Translation catalogs synchronize over the air.
          </p>
          <div class="feature-badge-list">
            <span class="feature-tag">OTA Translation</span>
            <span class="feature-tag">RTL Support</span>
            <span class="feature-tag">Multi-Lingual</span>
            <span class="feature-tag">JSON Catalogs</span>
          </div>
        </div>

        <div class="feature-deep-card">
          <div class="feature-deep-header">
            <div class="feature-icon" aria-hidden="true">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
            </div>
            <h2 class="feature-deep-title">Anti-Escalation Staff Delegation</h2>
          </div>
          <p class="feature-deep-text">
            Delegate operational tasks without risking security. Pre-defined roles (Operator, Assistant, Content Manager, Sub-Admin) enforce strict permission boundaries. Staff can never escalate permissions beyond what their creator holds.
          </p>
          <div class="feature-badge-list">
            <span class="feature-tag">Least Privilege</span>
            <span class="feature-tag">5 Staff Roles</span>
            <span class="feature-tag">No Wildcards</span>
            <span class="feature-tag">Audit Log</span>
          </div>
        </div>

        <div class="feature-deep-card">
          <div class="feature-deep-header">
            <div class="feature-icon" aria-hidden="true">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
            </div>
            <h2 class="feature-deep-title">Curated User Portal Launcher</h2>
          </div>
          <p class="feature-deep-text">
            Provide end users with an intuitive, clean grid of approved services. Administrators configure app tiles with high-resolution thumbnails, descriptions, and categories. Users click to launch without typing complex URLs.
          </p>
          <div class="feature-badge-list">
            <span class="feature-tag">One-Click Launch</span>
            <span class="feature-tag">Visual Grid</span>
            <span class="feature-tag">Category Filter</span>
            <span class="feature-tag">Responsive Cards</span>
          </div>
        </div>
      </div>

      <div style="text-align: center; margin-top: 48px;">
        <button class="btn btn-primary btn-lg" data-action="open-modal" data-modal="register">Register Your Organization</button>
        <a href="/download" class="btn btn-ghost btn-lg" style="margin-left: 12px;">Download Kiosk ISO &rarr;</a>
      </div>
    </section>`;
}

function specsMainHtml(): string {
  return `
    <section class="page-hero">
      <div class="hero-badge-container">
        <span class="badge badge-blue">Hardware Compatibility</span>
        <span class="badge badge-green">Linux 6.1 LTS Kernel</span>
      </div>
      <h1 class="page-hero-title">Technical Specifications &amp; <span>Hardware Requirements</span></h1>
      <p class="page-hero-desc">
        Engineered to give existing computers a second life and run lightning-fast on modern x86-64 thin clients without costly storage or RAM upgrades.
      </p>
    </section>

    <section class="section-wrap" style="padding-top: 0;">
      <div class="specs-table-container">
        <table class="specs-table">
          <thead>
            <tr>
              <th>Component</th>
              <th>Minimum Requirement</th>
              <th>Recommended Specification</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td><strong>Processor (CPU)</strong></td>
              <td>64-bit x86-64 (Intel Core 2 Duo, AMD Athlon 64, or newer)</td>
              <td>Intel Core i3/i5/i7 (2nd gen+), Celeron J4105, or modern AMD Ryzen</td>
            </tr>
            <tr>
              <td><strong>System Memory (RAM)</strong></td>
              <td>2 GB RAM (the system and the browser run from RAM)</td>
              <td>4 GB or 8 GB RAM for ultra-smooth multi-app switching</td>
            </tr>
            <tr>
              <td><strong>Storage Drive</strong></td>
              <td>2 GB+ USB flash drive (USB 2.0 or 3.0); internal disk not required</td>
              <td>Fast USB 3.0/3.1 Thumb Drive or Internal M.2 / SATA SSD</td>
            </tr>
            <tr>
              <td><strong>Network</strong></td>
              <td>10/100 Mbps Fast Ethernet or 802.11n Wi-Fi</td>
              <td>Gigabit Ethernet (1000 Mbps) or 802.11ac Wi-Fi</td>
            </tr>
            <tr>
              <td><strong>Display Output</strong></td>
              <td>VGA / DVI / HDMI supporting 1024x768 resolution</td>
              <td>1080p Full HD (1920x1080) or higher via HDMI/DisplayPort</td>
            </tr>
            <tr>
              <td><strong>Compatibility</strong></td>
              <td colspan="2">Any 64-bit x86 desktop, laptop or thin client that can start from a USB drive, with legacy BIOS or UEFI firmware (Secure Boot supported).</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div style="margin-top: 48px; background: var(--bg-surface); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 36px;">
        <h2 style="font-size: 1.5rem; font-weight: 700; margin-bottom: 16px; color: var(--text-main);">Edge &amp; Software Architecture</h2>
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 24px;">
          <div>
            <h3 style="font-size: 1.0625rem; font-weight: 650; margin-bottom: 8px; color: var(--accent-text);">Workstation Client Stack</h3>
            <ul style="list-style: disc; padding-left: 20px; font-size: 0.875rem; color: var(--text-muted); line-height: 1.6;">
              <li>Debian 12 (Bookworm) Live-Build distribution</li>
              <li>nodm display manager starting the kiosk session without a login prompt</li>
              <li>Openbox minimal window manager with disabled keybindings</li>
              <li>Loopback Agent Daemon (Python 3.11, bound strictly to 127.0.0.1:8888)</li>
              <li>MV3 Browser Extension with shadow-DOM navigation &amp; lock curtain</li>
            </ul>
          </div>
          <div>
            <h3 style="font-size: 1.0625rem; font-weight: 650; margin-bottom: 8px; color: var(--accent-text);">Cloudflare Edge Controller</h3>
            <ul style="list-style: disc; padding-left: 20px; font-size: 0.875rem; color: var(--text-muted); line-height: 1.6;">
              <li>Serverless Cloudflare Worker deployed across 300+ edge locations</li>
              <li>D1 distributed SQLite database for configuration and audit trails</li>
              <li>OrgHub Durable Objects for real-time WebSocket state distribution</li>
              <li>RemoteRelay Durable Objects for in-browser VNC bridging</li>
              <li>Zero runtime npm dependencies, 100% Web Crypto PBKDF2-HMAC-SHA256</li>
            </ul>
          </div>
        </div>
      </div>
    </section>`;
}

function pricingMainHtml(): string {
  return `
    <section class="page-hero">
      <div class="hero-badge-container">
        <span class="badge badge-blue">Licensing &amp; Deployment</span>
        <span class="badge badge-green">Accredited Education Grant</span>
      </div>
      <h1 class="page-hero-title">Transparent Licensing &amp; <span>Deployment Tiers</span></h1>
      <p class="page-hero-desc">
        Source-available software with grants for accredited education and transparent commercial terms for enterprise fleets.
      </p>
    </section>

    <section class="section-wrap" style="padding-top: 0;">
      <div class="pricing-grid">
        <div class="pricing-card">
          <h2 class="pricing-tier">Accredited Education Grant</h2>
          <div class="pricing-sub">For accredited educational institutions and non-commercial evaluation.</div>
          <div class="pricing-price">Grant / Free <small>up to 45 computers</small></div>
          <ul class="pricing-features">
            <li>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
              <span>Up to 45 managed workstations</span>
            </li>
            <li>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
              <span>Accredited educational institutions &amp; non-commercial evaluation</span>
            </li>
            <li>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
              <span>Tamper-proof OS &amp; managed Chromium</span>
            </li>
            <li>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
              <span>Central web management console</span>
            </li>
            <li>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
              <span>Dedicated organization subdomain</span>
            </li>
          </ul>
          <button class="btn btn-primary btn-block" data-action="open-modal" data-modal="register">Apply for Education Grant</button>
        </div>

        <div class="pricing-card featured">
          <div class="pricing-card-badge">Production Standard</div>
          <h2 class="pricing-tier">Commercial &amp; Large Fleet</h2>
          <div class="pricing-sub">For companies, public services, libraries, and deployments of 46+ computers.</div>
          <div class="pricing-price">Commercial License <small>per workstation fleet</small></div>
          <ul class="pricing-features">
            <li>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
              <span>Unlimited workstations across multiple facilities</span>
            </li>
            <li>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
              <span>Real-time thumbnail grid &amp; VNC remote control</span>
            </li>
            <li>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
              <span>Granular staff delegation &amp; audit logging</span>
            </li>
            <li>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
              <span>Custom domain support (e.g. kiosk.yourdomain.com)</span>
            </li>
            <li>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
              <span>Priority onboarding &amp; dedicated support SLA</span>
            </li>
          </ul>
          <button class="btn btn-primary btn-block" data-action="open-modal" data-modal="contact">Contact Sales &amp; Licensing</button>
        </div>

        <div class="pricing-card">
          <h2 class="pricing-tier">Self-Hosted Infrastructure</h2>
          <div class="pricing-sub">For air-gapped facilities or internal infrastructure mandates.</div>
          <div class="pricing-price">Source-Available <small>self-deployed</small></div>
          <ul class="pricing-features">
            <li>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
              <span>Deploy control plane on your Cloudflare account</span>
            </li>
            <li>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
              <span>Build customized Debian 12 ISOs via Docker</span>
            </li>
            <li>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
              <span>Full control over D1 data and telemetry retention</span>
            </li>
            <li>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
              <span>Commercial or subscriber license required for commercial use</span>
            </li>
            <li>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>
              <span>Technical architecture documentation &amp; guides</span>
            </li>
          </ul>
          <a href="/docs" class="btn btn-ghost btn-block">Read Self-Host Docs</a>
        </div>
      </div>

      <div class="docs-callout" style="margin-top: 48px; border-left-color: var(--accent);">
        <strong>Licensing Notice:</strong> Free only for accredited educational institutions and non-commercial evaluation up to 45 computers; commercial or subscriber license for everyone else. Any deployment with 46 or more computers, or utilized by commercial entities, requires a commercial or subscriber license.
      </div>
    </section>`;
}

/** "7 October 2026": a release's date as people write one. */
const RELEASE_DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

/** "~720 MB", from the size GitHub reports for the ISO. */
function isoSizeLabel(bytes: number | null | undefined): string {
  const mb = Math.round((Number(bytes) || 0) / (1024 * 1024) / 10) * 10;
  return mb > 0 ? `~${mb} MB` : "";
}

/** One release in the version history: what changed, and where its files are. */
function releaseCardHtml(note: ReleaseNote, newest: boolean): string {
  const { items, writtenByAi } = releaseHighlights(note);
  const releaseUrl = safeHttpUrl(note.url);
  const isoUrl = note.iso_url ? safeHttpUrl(note.iso_url) : null;
  const checksumUrl = note.checksum_url ? safeHttpUrl(note.checksum_url) : null;
  const size = isoSizeLabel(note.iso_bytes);
  return `
          <div class="changelog-card">
            <div class="changelog-head">
              <span class="changelog-version">${escapeHtml(note.tag)}</span>
              <span class="changelog-date">${newest ? `<span class="badge badge-green">Latest</span> ` : ""}${escapeHtml(RELEASE_DATE.format(new Date(note.published_at * 1000)))}</span>
            </div>
            ${
              items.length
                ? `<ul class="changelog-bullets">${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
                : `<p class="changelog-note">The changes in this release are listed in its notes on GitHub.</p>`
            }
            ${writtenByAi ? `<p class="changelog-note">Summary written by AI from this release\u2019s change list. The full list is in the release notes.</p>` : ""}
            <div style="margin-top: 16px; display: flex; align-items: center; flex-wrap: wrap; gap: 12px;">
              ${releaseUrl ? `<a href="${escapeHtml(releaseUrl)}" target="_blank" rel="noopener noreferrer" class="btn btn-secondary btn-sm">Release notes</a>` : ""}
              ${isoUrl ? `<a href="${escapeHtml(isoUrl)}" class="btn btn-secondary btn-sm">Download ${escapeHtml(note.tag)} ISO${size ? ` (${escapeHtml(size)})` : ""}</a>` : ""}
              ${checksumUrl ? `<a href="${escapeHtml(checksumUrl)}" target="_blank" rel="noopener noreferrer" class="btn btn-ghost btn-sm">SHA256</a>` : ""}
            </div>
          </div>`;
}

function downloadMainHtml(mirrorUrl: string | null, releases: ReleaseNote[]): string {
  // Everything about a release on this page is what GitHub published for it:
  // nothing here names a version, a size or a checksum of its own.
  const latest = releases[0] || null;
  const isoUrl = mirrorUrl || (latest?.iso_url ? safeHttpUrl(latest.iso_url) : null) || LATEST_ISO_URL;
  const checksumUrl = (latest?.checksum_url ? safeHttpUrl(latest.checksum_url) : null) || LATEST_CHECKSUM_URL;
  const size = isoSizeLabel(latest?.iso_bytes) || "~720 MB";
  const downloadAction = `<a href="${escapeHtml(isoUrl)}" target="_blank" rel="noopener noreferrer" class="btn btn-primary btn-lg btn-block">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        Download ${latest ? escapeHtml(latest.tag) : "the latest release"} (.ISO)
      </a>`;
  const historyHtml = releases.length
    ? releases.map((note, index) => releaseCardHtml(note, index === 0)).join("")
    : `
          <div class="changelog-card">
            <div class="changelog-head">
              <span class="changelog-version">Release notes</span>
              <span class="badge badge-blue">x86-64 Hybrid ISO</span>
            </div>
            <ul class="changelog-bullets">
              <li>Every release is published on GitHub with its notes, its ISO and the ISO's SHA256 checksum.</li>
              <li>The newest release is always at the same address, so a bookmark or a script keeps working.</li>
            </ul>
            <div style="margin-top: 16px; display: flex; align-items: center; flex-wrap: wrap; gap: 12px;">
              <a href="${RELEASES_URL}/latest" target="_blank" rel="noopener noreferrer" class="btn btn-secondary btn-sm">Latest release notes</a>
              <a href="${LATEST_ISO_URL}" class="btn btn-secondary btn-sm">Download the latest ISO (~720 MB)</a>
            </div>
          </div>`;

  return `
    <section class="page-hero">
      <div class="hero-badge-container">
        <span class="badge badge-blue">Official Distribution</span>
        <span class="badge badge-green">${latest ? `Latest Release ${escapeHtml(latest.tag)}` : "Latest Release"}</span>
      </div>
      <h1 class="page-hero-title">Download <span>Lab Kiosk OS</span></h1>
      <p class="page-hero-desc">
        Lightweight, immutable Debian 12 live-build image. Flash to a USB flash drive and turn any computer into a managed browser workstation.
      </p>
    </section>

    <section class="section-wrap" style="padding-top: 0;">
      <div class="download-hero-card">
        <div style="display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: 12px; margin-bottom: 8px;">
          <h2 style="font-size: 1.375rem; font-weight: 700; color: var(--text-main);">Lab Kiosk OS${latest ? ` ${escapeHtml(latest.tag)}` : ""} (x86-64)</h2>
          <span class="badge badge-green">Stable Release</span>
        </div>
        <p style="font-size: 0.9375rem; color: var(--text-muted); margin-bottom: 20px;">
          Includes Linux 6.1 LTS kernel, Chromium enterprise policy, loopback agent daemon, and tmpfs RAM overlay.
        </p>

        <div class="download-meta-grid">
          <div class="download-meta-item">
            <span class="download-meta-label">Architecture</span>
            <span class="download-meta-val">x86-64 (AMD64)</span>
          </div>
          <div class="download-meta-item">
            <span class="download-meta-label">Format</span>
            <span class="download-meta-val">Hybrid ISO (BIOS + UEFI)</span>
          </div>
          <div class="download-meta-item">
            <span class="download-meta-label">Size</span>
            <span class="download-meta-val">${escapeHtml(size)}</span>
          </div>
          <div class="download-meta-item">
            <span class="download-meta-label">Base OS</span>
            <span class="download-meta-val">Debian 12 Bookworm</span>
          </div>
        </div>

        <div style="margin: 24px 0;">
          ${downloadAction}
        </div>

        <div class="checksum-box">
          <strong>SHA256 Checksum:</strong><br>
          Published with every release as
          <a href="${escapeHtml(checksumUrl)}" target="_blank" rel="noopener noreferrer">${RELEASE_CHECKSUM_NAME}</a>.
          Compare it with the output of <code>sha256sum ${RELEASE_ISO_NAME}</code> before writing the image.
        </div>
      </div>

      <div style="max-width: 840px; margin: 0 auto 56px;">
        <h2 style="font-size: 1.5rem; font-weight: 700; color: var(--text-main); margin-bottom: 6px;">3-Step Deployment Guide</h2>
        <p style="font-size: 0.9375rem; color: var(--text-muted); margin-bottom: 20px;">
          Get your first workstation booted and enrolled in under five minutes.
        </p>

        <div class="steps-grid">
          <div class="step-card">
            <div class="step-num">1</div>
            <h3 class="step-title">Write to USB</h3>
            <p class="step-desc">
              Flash the ISO onto a 2 GB+ USB flash drive using Rufus (choose 'DD Image' mode) on Windows or BalenaEtcher on Mac/Linux.
            </p>
          </div>
          <div class="step-card">
            <div class="step-num">2</div>
            <h3 class="step-title">Boot Hardware</h3>
            <p class="step-desc">
              Insert the USB into the computer, turn it on, and press F12, F10 or Esc to select the USB boot device. It boots directly into RAM.
            </p>
          </div>
          <div class="step-card">
            <div class="step-num">3</div>
            <h3 class="step-title">Complete Wizard</h3>
            <p class="step-desc">
              The setup wizard appears on first launch. Connect to Wi-Fi or Ethernet, enter your organization's enrollment key, and you're live.
            </p>
          </div>
        </div>
      </div>

      <div style="max-width: 840px; margin: 0 auto;">
        <h2 style="font-size: 1.5rem; font-weight: 700; color: var(--text-main); margin-bottom: 6px;">Version History &amp; Changelog</h2>
        <div class="changelog-list">${historyHtml}
        </div>

        <div style="margin-top: 32px; padding: 18px 24px; background: var(--bg-surface); border: 1px solid var(--border); border-radius: var(--radius); text-align: center;">
          <p style="font-size: 0.9375rem; color: var(--text-muted); margin: 0;">
            Looking for historical releases, commit logs, or container builder tags? Browse the
            <a href="https://github.com/akbhoi/labkiosk/releases" target="_blank" rel="noopener noreferrer" style="color: var(--accent-text); text-decoration: underline; font-weight: 600;">GitHub Releases Archive &rarr;</a>
          </p>
        </div>
      </div>
    </section>`;
}

/** The documentation's address for a page: "/docs" for the index, "/docs/<slug>" otherwise. */
export function docsPath(slug: string): string {
  return slug ? `/docs/${slug}` : "/docs";
}

/** The documentation page at a path, or null. */
export function findDocsPage(path: string): DocsPage | null {
  if (path === "/docs") return DOCS_PAGES.find((page) => page.slug === "") || null;
  if (!path.startsWith("/docs/")) return null;
  const slug = path.slice("/docs/".length);
  return slug ? DOCS_PAGES.find((page) => page.slug === slug) || null : null;
}

/** Every documentation address, for the sitemap and the indexing rules. */
export const DOCS_PATHS: readonly string[] = DOCS_PAGES.map((page) => docsPath(page.slug));

const DOCS_BY_FILE = new Map(DOCS_PAGES.map((page) => [page.file.slice(0, -3).toLowerCase(), page]));
const DOCS_SOURCE_URL = `${SOURCE_REPOSITORY_URL}/blob/main`;

/**
 * Where a link in a wiki page leads on the site: another page of the wiki is
 * its /docs address, a file of the repository is that file on GitHub, an
 * http(s) address is itself. Anything else is shown as text.
 */
const resolveDocsLink: LinkResolver = (target) => {
  if (target.startsWith("#")) return { href: target, external: false };
  if (target.startsWith("https://") || target.startsWith("http://")) {
    const url = safeHttpUrl(target);
    return url ? { href: url, external: true } : null;
  }
  const hash = target.indexOf("#");
  const name = (hash < 0 ? target : target.slice(0, hash)).toLowerCase();
  const fragment = hash < 0 ? "" : target.slice(hash);
  const page = DOCS_BY_FILE.get(name);
  if (page) return { href: docsPath(page.slug) + fragment, external: false };
  if (target.startsWith("../") && !target.includes("..", 3)) return { href: `${DOCS_SOURCE_URL}/${target.slice(3)}`, external: true };
  return null;
};

function docsMainHtml(page: DocsPage): string {
  const { html, headings } = renderMarkdown(page.markdown, resolveDocsLink);
  const navHtml = DOCS_NAV.map(
    (group) => `
        <div class="docs-sidebar-section">
          <div class="docs-sidebar-title">${escapeHtml(group.title)}</div>
          <ul class="docs-sidebar-links">${group.pages
            .map((slug) => {
              const item = DOCS_PAGES.find((candidate) => candidate.slug === slug);
              return item
                ? `
            <li><a href="${escapeAttr(docsPath(slug))}"${slug === page.slug ? ' class="active" aria-current="page"' : ""}>${escapeHtml(item.title)}</a></li>`
                : "";
            })
            .join("")}
          </ul>
        </div>`
  ).join("");
  // The sections of this page, when it is long enough to need a way around it.
  const sections = headings.filter((h) => h.level === 2);
  const onThisPage =
    sections.length >= 3
      ? `
        <div class="docs-sidebar-section">
          <div class="docs-sidebar-title">On this page</div>
          <ul class="docs-sidebar-links">${sections.map((h) => `
            <li><a href="#${escapeAttr(h.id)}">${escapeHtml(h.text)}</a></li>`).join("")}
          </ul>
        </div>`
      : "";
  return `
    <div class="docs-container">
      <aside class="docs-sidebar" aria-label="Documentation">
        <div class="docs-sidebar-section">
          <ul class="docs-sidebar-links">
            <li><a href="/docs"${page.slug === "" ? ' class="active" aria-current="page"' : ""}>Overview</a></li>
          </ul>
        </div>${navHtml}${onThisPage}
      </aside>
      <main class="docs-content">
        <article class="docs-article docs-page">
${html}
        </article>
        <p class="docs-source">
          This page is <a href="${escapeAttr(`${DOCS_SOURCE_URL}/wiki/${page.file}`)}" target="_blank" rel="noopener noreferrer">wiki/${escapeHtml(page.file)}</a> in the repository.
        </p>
      </main>
    </div>`;
}

/** The first paragraph of a page, as plain text, for its description. */
function docsDescription(page: DocsPage): string {
  for (const block of page.markdown.split("\n\n")) {
    const text = block.trim();
    if (!text || text.startsWith("#") || text.startsWith("|") || text.startsWith("```") || text.startsWith("-") || text.startsWith(">")) continue;
    const plain = text.split("**").join("").split("`").join("").replace(/\s+/g, " ");
    return plain.length > 200 ? `${plain.slice(0, 197)}...` : plain;
  }
  return "Lab Kiosk documentation.";
}

export function renderFeaturesHtml(data: LandingOptions): string {
  return renderPublicShell(data, {
    title: "Lab Kiosk OS - Features & Technical Capabilities",
    description: "Deep dive into Lab Kiosk capabilities: 100% RAM overlay, instant screen lock, interactive VNC remote control, managed Chromium policies, and granular staff delegation.",
    activeNav: "features",
    mainHtml: featuresMainHtml()
  });
}

export function renderSpecsHtml(data: LandingOptions): string {
  return renderPublicShell(data, {
    title: "Lab Kiosk OS - Hardware Specifications & System Requirements",
    description: "Technical specifications, hardware requirements, and edge architecture for Lab Kiosk OS and Cloudflare control plane.",
    activeNav: "specs",
    mainHtml: specsMainHtml()
  });
}

export function renderPricingHtml(data: LandingOptions): string {
  return renderPublicShell(data, {
    title: "Lab Kiosk OS - Transparent Licensing & Deployment Tiers",
    description: "Transparent licensing: grants for accredited educational institutions and non-commercial evaluation up to 45 computers; commercial and subscriber licensing for organizations.",
    activeNav: "pricing",
    mainHtml: pricingMainHtml()
  });
}

function contactMainHtml(data: LandingOptions): string {
  const contactEmail = (data.contactEmail || "contact@labkiosk.org").toLowerCase();
  const turnstileSlot = data.turnstileSiteKey ? `<div class="form-group turnstile-slot" id="contact-turnstile"></div>` : "";
  return `
    <section class="page-hero">
      <h1 class="page-hero-title">Contact <span>Lab Kiosk</span></h1>
      <p class="page-hero-desc">
        Write to us about licensing, a deployment, a problem or anything else. Your message goes straight to the people who run Lab Kiosk, and the reply comes to your email.
      </p>
    </section>

    <section class="section-wrap contact-page">
      <div class="contact-layout">
        <div class="contact-form-card">
          <div class="alert-box" id="contact-alert" role="alert"></div>
          <div class="notice-box" id="contact-done" role="status"></div>
          <form id="contact-form" novalidate>
            <div class="form-row">
              <div class="form-group">
                <label class="form-label" for="contact-name">Your name</label>
                <input type="text" class="form-input" id="contact-name" required maxlength="120" placeholder="Jane Smith" autocomplete="name">
              </div>
              <div class="form-group">
                <label class="form-label" for="contact-org">Organization <span class="form-optional">(optional)</span></label>
                <input type="text" class="form-input" id="contact-org" maxlength="160" placeholder="City Library" autocomplete="organization">
              </div>
            </div>
            <div class="form-group">
              <label class="form-label" for="contact-reason">What is it about?</label>
              <select class="form-input" id="contact-reason" required>${CONTACT_REASONS.map(
                (reason) => `
                <option value="${escapeAttr(reason.value)}">${escapeHtml(reason.label)}</option>`
              ).join("")}
              </select>
            </div>
            <div class="form-group">
              <label class="form-label" for="contact-email">Your email address</label>
              <div class="code-row">
                <input type="email" class="form-input" id="contact-email" required maxlength="254" placeholder="jane@example.org" autocomplete="email">
                <button type="button" class="btn btn-ghost" id="contact-send-code">Send code</button>
              </div>
              <div class="input-hint">We email a six-digit code to this address to confirm it is yours, so our reply reaches you.</div>
            </div>
            ${turnstileSlot}
            <div class="form-group">
              <label class="form-label" for="contact-code">Six-digit code from that email</label>
              <input type="text" class="form-input contact-code-input" id="contact-code" required inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" maxlength="6" placeholder="123456">
            </div>
            <div class="form-group">
              <label class="form-label" for="contact-message">Your message</label>
              <textarea class="form-input" id="contact-message" rows="7" required maxlength="5000" placeholder="Tell us what you need. For a deployment: how many computers, where, and by when."></textarea>
              <div class="input-hint contact-count" id="contact-count" aria-live="off"></div>
            </div>
            <button type="submit" class="btn btn-primary btn-block" id="contact-submit">Send message</button>
            <p class="input-hint contact-privacy">We use what you write here only to answer you. See the <a href="/privacy">privacy policy</a>.</p>
          </form>
        </div>

        <aside class="contact-aside" aria-label="Other ways to reach us">
          <h2>Prefer email?</h2>
          <p>Write to the address that fits. Each one reaches the same team.</p>
          <ul>
            <li><span>General and sales</span><a href="mailto:${escapeAttr(contactEmail)}">${escapeHtml(contactEmail)}</a></li>
            <li><span>Technical support</span><a href="mailto:support@labkiosk.org">support@labkiosk.org</a></li>
            <li><span>Education and partners</span><a href="mailto:partners@labkiosk.org">partners@labkiosk.org</a></li>
          </ul>
          <h2>Before you write</h2>
          <ul>
            <li><a href="/docs/troubleshooting">Troubleshooting</a></li>
            <li><a href="/docs/installation-guide">Installation guide</a></li>
            <li><a href="/pricing">Licensing and pricing</a></li>
            <li><a href="${SOURCE_REPOSITORY_URL}/issues" target="_blank" rel="noopener noreferrer">Report a bug on GitHub</a></li>
          </ul>
        </aside>
      </div>
    </section>`;
}

/** /contact: a message to the platform, from an address proved with an emailed code. */
export function renderContactHtml(data: LandingOptions): string {
  return renderPublicShell(data, {
    title: "Contact Lab Kiosk",
    description: "Write to the Lab Kiosk team about licensing, a deployment or a problem. Your message is answered by email.",
    activeNav: "contact",
    mainHtml: contactMainHtml(data)
  });
}

export function renderDownloadHtml(data: LandingOptions): string {
  const mirrorUrl = data.isoDownloadUrl ? safeHttpUrl(data.isoDownloadUrl) : null;
  return renderPublicShell(data, {
    title: "Lab Kiosk OS - Download Bootable ISO & Flashing Guide",
    description: "Download the latest Lab Kiosk Debian 12 live-build ISO image, SHA256 checksums, 3-step flashing instructions, and Docker build commands.",
    activeNav: "download",
    mainHtml: downloadMainHtml(mirrorUrl, data.releases || [])
  });
}

/** A documentation page: a page of the repository's wiki, rendered (src/markdown.ts). */
export function renderDocsHtml(data: LandingOptions, page: DocsPage): string {
  return renderPublicShell(data, {
    title: page.slug ? `${page.title} - Lab Kiosk Documentation` : "Lab Kiosk Documentation",
    description: docsDescription(page),
    activeNav: "docs",
    mainHtml: docsMainHtml(page)
  });
}

/**
 * The stylesheet of the public pages. It used to be written into every one of
 * them, about 60 KB that no browser could keep; it is one file now, named by
 * its own hash and cached for a year, as the consoles' is.
 */
const SITE_CSS = `${rootTokensCss(LEGACY_LANDING_ALIASES)}
    *, *::before, *::after { box-sizing: border-box; }
    :where(h1, h2, h3, h4, h5, p, ul, ol, li, figure) { margin: 0; }
    :where(ul, ol) { padding: 0; }
    html { scroll-behavior: smooth; accent-color: var(--accent); scroll-padding-top: 72px; }
    @media (prefers-reduced-motion: reduce) { html { scroll-behavior: auto; } }
    body {
      margin: 0;
      font-family: var(--font-sans);
      font-feature-settings: "cv11", "ss01";
      background: var(--bg-base);
      color: var(--text-main);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      overflow-x: hidden;
      line-height: 1.6;
      -webkit-font-smoothing: antialiased;
    }
    :where(a, button, input, select, textarea, summary, [tabindex]):focus-visible {
      outline: 2px solid var(--border-focus);
      outline-offset: 2px;
    }
    ::selection { background: var(--accent-glow); }

    /* Typography & Utilities */
    a { color: inherit; text-decoration: none; }
    code {
      font-family: var(--font-mono);
      font-size: 0.8125em;
      color: var(--text-main);
      background: var(--bg-subtle);
      border: 1px solid var(--border-subtle);
      padding: 1px 6px;
      border-radius: var(--radius-xs);
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 3px 12px;
      border-radius: 999px;
      font-size: 0.75rem;
      font-weight: 500;
      line-height: 1.5;
      border: 1px solid var(--border);
      background: var(--bg-surface);
      color: var(--text-muted);
    }
    .badge-blue { background: var(--accent-soft); color: var(--accent-text); border-color: transparent; }
    .badge-green { background: var(--success-soft); color: var(--success-text); border-color: transparent; }

    /* Header & Navigation */
    header {
      padding: 12px 32px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      border-bottom: 1px solid var(--border-subtle);
      background: var(--bg-base);
      background: color-mix(in oklab, var(--bg-base) 82%, transparent);
      -webkit-backdrop-filter: saturate(1.4) blur(14px);
      backdrop-filter: saturate(1.4) blur(14px);
      position: sticky;
      top: 0;
      z-index: 100;
    }
    .brand { display: flex; align-items: center; gap: 10px; }
    a.brand { color: inherit; text-decoration: none; }
    .brand-logo {
      width: 34px;
      height: 34px;
      background: var(--accent);
      color: var(--accent-fg);
      border-radius: var(--radius);
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    }
    .brand-logo svg { width: 19px; height: 19px; }
    .brand-title { font-size: 1rem; font-weight: 650; letter-spacing: -0.01em; display: flex; align-items: center; gap: 8px; }
    .brand-title span {
      font-size: 0.6875rem;
      font-weight: 500;
      color: var(--text-muted);
      background: var(--bg-subtle);
      padding: 1px 7px;
      border-radius: 999px;
      border: 1px solid var(--border-subtle);
    }

    .nav-links { display: flex; align-items: center; gap: 4px; list-style: none; }
    .nav-links a {
      font-size: 0.875rem;
      font-weight: 500;
      color: var(--text-muted);
      transition: color 0.15s, background-color 0.15s;
      padding: 6px 10px;
      border-radius: var(--radius-sm);
    }
    .nav-links a:hover { color: var(--text-main); background: var(--hover); }

    .nav-actions { display: flex; align-items: center; gap: 8px; }
    .btn {
      padding: 0 16px;
      border-radius: var(--radius-sm);
      font-size: 0.875rem;
      font-weight: 500;
      font-family: inherit;
      cursor: pointer;
      transition: background-color 0.15s ease, border-color 0.15s ease, color 0.15s ease;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      min-height: 36px;
      border: 1px solid transparent;
      white-space: nowrap;
    }
${BUSY_CSS}    .btn.is-loading::before { margin-inline-end: 0; }
    .btn-ghost { background: var(--bg-surface); color: var(--text-main); border-color: var(--border); box-shadow: var(--shadow-sm); }
    .btn-ghost:hover { background: var(--bg-card-hover); border-color: var(--border-input); }
    .btn-primary { background: var(--accent); color: var(--accent-fg); box-shadow: var(--shadow-sm); }
    .btn-primary:hover { background: var(--accent-hover); }
    .btn-lg { min-height: 44px; padding: 0 22px; font-size: 0.9375rem; }
    .btn-sm { min-height: 32px; padding: 0 12px; font-size: 0.8125rem; }
    .btn-danger-solid { background: var(--danger); color: var(--on-solid); }
    .btn-danger-solid:hover { filter: brightness(0.92); }
    .btn-block { width: 100%; }
    .theme-toggle, .icon-link {
      width: 36px;
      height: 36px;
      border-radius: var(--radius-sm);
      border: 1px solid var(--border);
      background: var(--bg-surface);
      color: var(--text-muted);
      display: inline-flex;
      align-items: center;
      justify-content: center;
      cursor: pointer;
    }
    .theme-toggle:hover, .icon-link:hover { color: var(--text-main); background: var(--bg-card-hover); }

    /* Edge Status Indicator */
    .edge-status {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 4px 12px;
      background: var(--success-soft);
      border-radius: 999px;
      font-size: 0.75rem;
      font-weight: 500;
      color: var(--success-text);
      white-space: nowrap;
    }
    .status-dot { width: 7px; height: 7px; background: var(--success); border-radius: 50%; box-shadow: 0 0 0 3px var(--success-glow); animation: pulse 2s infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }
    @media (prefers-reduced-motion: reduce) { .status-dot { animation: none; } }

    /* Hero Section */
    .hero {
      padding: clamp(56px, 10vw, 112px) 24px 64px;
      text-align: center;
      max-width: 1080px;
      margin: 0 auto;
      position: relative;
    }
    .hero-badge-container { display: flex; align-items: center; justify-content: center; gap: 8px; margin-bottom: 24px; flex-wrap: wrap; }
    .hero-title {
      font-size: clamp(2.25rem, 1.4rem + 4vw, 4rem);
      font-weight: 700;
      line-height: 1.08;
      letter-spacing: -0.035em;
      margin-bottom: 22px;
      text-wrap: balance;
    }
    .hero-title span { color: var(--accent-text); }
    .hero-desc {
      font-size: clamp(1rem, 0.9rem + 0.45vw, 1.1875rem);
      color: var(--text-muted);
      line-height: 1.65;
      max-width: 760px;
      margin: 0 auto 36px;
      text-wrap: pretty;
    }
    .hero-ctas { display: flex; align-items: center; justify-content: center; gap: 12px; flex-wrap: wrap; margin-bottom: 56px; }

    /* Metrics Trust Bar */
    .metrics-bar {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(min(200px, 100%), 1fr));
      max-width: 1000px;
      margin: 0 auto;
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-sm);
      overflow: hidden;
    }
    .metric-item { text-align: center; padding: 22px 16px; }
    .metric-item + .metric-item { border-left: 1px solid var(--border-subtle); }
    .metric-value { font-size: 1.625rem; font-weight: 700; letter-spacing: -0.02em; color: var(--text-main); font-variant-numeric: tabular-nums; }
    .metric-label { font-size: 0.8125rem; color: var(--text-muted); margin-top: 4px; }

    /* Sections */
    .section-wrap { padding: clamp(56px, 8vw, 96px) 24px; max-width: 1200px; margin: 0 auto; width: 100%; }
    .section-header { text-align: center; margin: 0 auto 48px; max-width: 720px; }
    .section-title { font-size: clamp(1.75rem, 1.2rem + 2vw, 2.5rem); font-weight: 700; letter-spacing: -0.03em; line-height: 1.15; margin-bottom: 12px; text-wrap: balance; }
    .section-sub { font-size: 1.0625rem; color: var(--text-muted); text-wrap: pretty; }

    /* Stakeholder Tabs */
    .tabs-nav {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 2px;
      margin: 0 auto 32px;
      flex-wrap: wrap;
      width: fit-content;
      max-width: 100%;
      padding: 4px;
      background: var(--bg-subtle);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius);
    }
    .tab-btn {
      background: transparent;
      border: none;
      color: var(--text-muted);
      padding: 7px 14px;
      border-radius: var(--radius-sm);
      font-size: 0.875rem;
      font-weight: 500;
      font-family: inherit;
      cursor: pointer;
      transition: color 0.15s, background-color 0.15s;
    }
    .tab-btn:hover { color: var(--text-main); }
    .tab-btn.active { background: var(--bg-surface); color: var(--text-main); box-shadow: var(--shadow-sm), 0 0 0 1px var(--border); }

    .tab-content { display: none; }
    .tab-content.active { display: block; animation: fadeIn 0.3s ease; }
    @keyframes fadeIn { from { opacity: 0; translate: 0 6px; } to { opacity: 1; translate: 0 0; } }
    @media (prefers-reduced-motion: reduce) { .tab-content.active { animation: none; } }

    .audience-card {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-sm);
      padding: 40px;
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 40px;
      align-items: center;
    }
    @media (max-width: 900px) { .audience-card { grid-template-columns: 1fr; padding: 24px; } }
    .audience-info h3 { font-size: 1.625rem; font-weight: 700; letter-spacing: -0.02em; line-height: 1.2; margin-bottom: 14px; color: var(--text-main); text-wrap: balance; }
    .audience-info p { font-size: 1rem; color: var(--text-muted); margin-bottom: 24px; line-height: 1.65; }
    .audience-bullets { list-style: none; display: flex; flex-direction: column; gap: 12px; }
    .audience-bullets li { display: flex; align-items: flex-start; gap: 12px; font-size: 0.9375rem; color: var(--text-muted); }
    .audience-bullets strong { color: var(--text-main); font-weight: 600; }
    .bullet-icon {
      color: var(--success-text);
      background: var(--success-soft);
      flex-shrink: 0;
      width: 20px;
      height: 20px;
      border-radius: 50%;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 0.6875rem;
      font-weight: 700;
      margin-top: 2px;
    }

    .audience-preview {
      background: var(--bg-base);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 14px;
      box-shadow: var(--shadow-md);
    }

    /* Live Interactive Simulator */
    .simulator-wrap {
      background: var(--bg-base);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      overflow: hidden;
      box-shadow: var(--shadow-lg);
    }
    .simulator-bar {
      background: var(--bg-surface);
      padding: 10px 16px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid var(--border);
      flex-wrap: wrap;
      gap: 12px;
    }
    .sim-controls { display: flex; align-items: center; gap: 2px; padding: 3px; background: var(--bg-subtle); border-radius: var(--radius); }
    .sim-app-card { transition: translate 0.2s var(--ease-spring), border-color 0.15s; }
    .sim-app-card:hover { translate: 0 -2px; border-color: var(--border-input); }
    .sim-tab-btn {
      padding: 5px 12px;
      border-radius: var(--radius-sm);
      font-size: 0.8125rem;
      font-weight: 500;
      font-family: inherit;
      cursor: pointer;
      background: transparent;
      color: var(--text-muted);
      border: none;
      transition: color 0.15s, background-color 0.15s;
    }
    .sim-tab-btn:hover { color: var(--text-main); }
    .sim-tab-btn.active { background: var(--bg-surface); color: var(--text-main); box-shadow: var(--shadow-sm), 0 0 0 1px var(--border); }
    .simulator-body { padding: 32px; min-height: 440px; display: flex; flex-direction: column; justify-content: center; }

    /* Features Grid */
    .features-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(min(300px, 100%), 1fr));
      gap: 16px;
    }
    .feature-card {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: 28px;
      box-shadow: var(--shadow-sm);
      transition: border-color 0.15s ease, box-shadow 0.2s ease;
      display: flex;
      flex-direction: column;
    }
    .feature-card:hover { border-color: var(--border-input); box-shadow: var(--shadow-md); }
    .feature-icon {
      width: 40px;
      height: 40px;
      background: var(--accent-soft);
      border-radius: var(--radius);
      display: flex;
      align-items: center;
      justify-content: center;
      color: var(--accent-text);
      margin-bottom: 18px;
    }
    .feature-title { font-size: 1.0625rem; font-weight: 600; letter-spacing: -0.01em; margin-bottom: 8px; color: var(--text-main); }
    .feature-desc { font-size: 0.875rem; color: var(--text-muted); line-height: 1.65; }

    /* Hardware Specs Table */
    .specs-table-container {
      width: 100%;
      overflow-x: auto;
      border-radius: var(--radius-lg);
      border: 1px solid var(--border);
      box-shadow: var(--shadow-sm);
      margin-top: 24px;
      scrollbar-width: thin;
      scrollbar-color: var(--border-input) transparent;
      -webkit-overflow-scrolling: touch;
    }
    .specs-table {
      width: 100%;
      border-collapse: collapse;
      background: var(--bg-surface);
      font-variant-numeric: tabular-nums;
    }
    .specs-table th, .specs-table td { padding: 14px 20px; text-align: left; border-bottom: 1px solid var(--border-subtle); font-size: 0.875rem; }
    .specs-table th { background: var(--bg-subtle); color: var(--text-muted); font-weight: 500; font-size: 0.8125rem; }
    .specs-table td { color: var(--text-muted); }
    .specs-table td:first-child { color: var(--text-main); font-weight: 500; }
    .specs-table tr:last-child td { border-bottom: none; }

    /* FAQ Accordion */
    .faq-list { max-width: 820px; margin: 0 auto; display: flex; flex-direction: column; gap: 8px; }
    .faq-item {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      overflow: hidden;
    }
    .faq-question {
      padding: 16px 20px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      font-weight: 600;
      font-size: 0.9375rem;
      user-select: none;
      color: var(--text-main);
    }
    .faq-question:hover { background: var(--hover); }
    .faq-chevron { transition: transform 0.2s; color: var(--text-subtle); flex-shrink: 0; }
    .faq-item.open .faq-chevron { transform: rotate(180deg); }
    .faq-answer { padding: 0 20px 18px; font-size: 0.875rem; color: var(--text-muted); line-height: 1.7; display: none; }
    .faq-item.open .faq-answer { display: block; }

    /* Contact Section Cards */
    .contact-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(min(260px, 100%), 1fr));
      gap: 16px;
    }
    .contact-card {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-sm);
      padding: 28px;
      text-align: center;
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    .contact-card h4 { font-size: 1.0625rem; font-weight: 600; margin: 14px 0 8px; color: var(--text-main); }
    .contact-card p { font-size: 0.875rem; color: var(--text-muted); margin-bottom: 18px; line-height: 1.55; }
    .contact-link {
      color: var(--accent-text);
      font-family: var(--font-mono);
      font-size: 0.875rem;
      font-weight: 500;
      text-decoration: underline;
      text-underline-offset: 4px;
      overflow-wrap: anywhere;
    }
    .contact-link:hover { text-decoration-thickness: 2px; }

    /* Modals */
    .modal-overlay {
      position: fixed;
      inset: 0;
      background: var(--overlay);
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 1000;
      padding: 20px;
    }
    .modal-overlay.active { display: flex; }
    .modal-box {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: 32px;
      max-width: 460px;
      width: 100%;
      box-shadow: var(--shadow-lg);
      position: relative;
      max-height: 90vh;
      overflow-y: auto;
      opacity: 1;
      scale: 1;
      transition: opacity 0.16s ease, scale 0.2s var(--ease-out);
    }
    @starting-style {
      .modal-overlay.active .modal-box { opacity: 0; scale: 0.97; }
    }
    .modal-close {
      position: absolute;
      top: 16px;
      right: 16px;
      background: transparent;
      border: none;
      color: var(--text-muted);
      cursor: pointer;
      font-size: 1.25rem;
      width: 32px;
      height: 32px;
      display: flex;
      align-items: center;
      justify-content: center;
      border-radius: var(--radius-sm);
    }
    .modal-close:hover { color: var(--text-main); background: var(--hover); }
    .modal-title { font-size: 1.375rem; font-weight: 700; letter-spacing: -0.02em; margin-bottom: 6px; color: var(--text-main); padding-right: 36px; }
    .modal-sub { font-size: 0.875rem; color: var(--text-muted); margin-bottom: 24px; }
    .form-group { margin-bottom: 16px; text-align: left; }
    .turnstile-slot { min-height: 65px; }
    .form-label { display: block; font-size: 0.8125rem; font-weight: 500; margin-bottom: 6px; color: var(--text-main); }
    .form-input {
      width: 100%;
      min-height: 40px;
      background: var(--bg-card);
      border: 1px solid var(--border-input);
      border-radius: var(--radius-sm);
      padding: 8px 12px;
      color: var(--text-main);
      font-size: 0.875rem;
      font-family: inherit;
      transition: border-color 0.12s ease, box-shadow 0.12s ease;
    }
    .form-input::placeholder { color: var(--text-subtle); opacity: 1; }
    .form-input:focus-visible { outline: none; border-color: var(--border-focus); box-shadow: var(--focus-ring); }
    .form-input:user-invalid { border-color: var(--danger); }
    .input-hint { font-size: 0.75rem; color: var(--text-muted); margin-top: 6px; line-height: 1.45; }
    .modal-switch { text-align: center; margin-top: 18px; font-size: 0.8125rem; color: var(--text-muted); }
    .modal-switch a { color: var(--accent-text); text-decoration: none; cursor: pointer; font-weight: 600; }
    .modal-switch a:hover { text-decoration: underline; }
    .modal-wide { max-width: 640px; }
    .form-split { display: grid; grid-template-columns: 1fr 1fr; gap: 0 12px; }
    .form-legend { font-size: 0.75rem; font-weight: 600; letter-spacing: 0.04em; text-transform: uppercase; color: var(--text-muted); margin: 20px 0 10px; text-align: left; }
    .form-legend:first-of-type { margin-top: 0; }
    .code-row { display: flex; gap: 8px; align-items: stretch; }
    .code-row .form-input { flex: 1; min-width: 0; }
    .code-row .btn { white-space: nowrap; }
    .check-row { display: flex; gap: 10px; align-items: flex-start; font-size: 0.8125rem; color: var(--text-muted); text-align: left; line-height: 1.5; }
    .check-row input { margin-top: 3px; }
    #login-form[hidden], #login-2fa-form[hidden] { display: none; }
    #sim-broadcast-form[hidden], #sim-modal-ok[hidden] { display: none; }
    #sim-modal-text { overflow-wrap: anywhere; }
    .check-row a { color: var(--accent-text); }
    .notice-box {
      background: var(--success-soft);
      border: 1px solid var(--border);
      border-left: 3px solid var(--success);
      color: var(--text-main);
      padding: 12px 14px;
      border-radius: var(--radius-sm);
      font-size: 0.875rem;
      line-height: 1.55;
      margin-bottom: 18px;
      text-align: left;
      display: none;
    }
    .alert-box {
      background: var(--danger-soft);
      border: 1px solid var(--border);
      border-left: 3px solid var(--danger);
      color: var(--danger-text);
      padding: 10px 14px;
      border-radius: var(--radius-sm);
      font-size: 0.8125rem;
      margin-bottom: 18px;
      display: none;
    }
    .iso-build-note {
      background: var(--bg-subtle);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 16px;
      font-size: 0.8125rem;
      color: var(--text-muted);
      line-height: 1.6;
      text-align: left;
    }
    .iso-build-note strong { color: var(--text-main); }
    .iso-build-note code { display: block; margin: 8px 0; padding: 8px 12px; background: var(--bg-base); overflow-x: auto; }
    .page-alert {
      max-width: 900px;
      margin: 24px auto -12px;
      background: var(--danger-soft);
      border: 1px solid var(--border);
      border-left: 3px solid var(--danger);
      color: var(--danger-text);
      padding: 12px 18px;
      border-radius: var(--radius);
      font-size: 0.875rem;
      font-weight: 500;
      text-align: center;
    }

    /*
     * Website analytics consent: a bar along the bottom that leaves the page
     * usable while the visitor decides, unlike Zaraz's own modal dialog.
     */
    .cookie-banner {
      position: fixed;
      left: 16px;
      right: 16px;
      bottom: 16px;
      z-index: 900;
      max-width: 960px;
      margin: 0 auto;
      display: flex;
      align-items: center;
      gap: 12px 20px;
      flex-wrap: wrap;
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-lg);
      padding: 14px 18px;
      font-size: 0.875rem;
      line-height: 1.5;
      color: var(--text-muted);
    }
    .cookie-banner[hidden] { display: none; }
    .cookie-banner p { flex: 1 1 320px; min-width: 0; }
    .cookie-banner a { color: var(--accent-text); text-decoration: underline; text-underline-offset: 3px; }
    .cookie-banner-actions { display: flex; gap: 8px; flex-wrap: wrap; }
    .footer-link-button {
      background: none;
      border: none;
      padding: 0;
      font: inherit;
      color: inherit;
      cursor: pointer;
    }
    .footer-link-button[hidden] { display: none; }
    .footer-link-button:hover { color: var(--text-main); }

    /* The small illustrations inside the audience and simulator panels. */
    .demo-row { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
    .demo-row-head { border-bottom: 1px solid var(--border); padding-bottom: 12px; }
    .demo-title { font-weight: 600; font-size: 0.875rem; }
    .demo-grid-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
    .demo-pc {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-sm);
      padding: 10px;
      text-align: center;
    }
    .demo-pc.is-blocked { border-color: var(--danger); }
    .demo-pc-name { font-size: 0.6875rem; color: var(--text-muted); font-family: var(--font-mono); }
    .demo-screen {
      height: 48px;
      background: var(--bg-subtle);
      border-radius: var(--radius-xs);
      margin: 6px 0;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 0.6875rem;
      color: var(--accent-text);
    }
    .demo-pc.is-blocked .demo-screen { color: var(--danger-text); }
    .demo-status { font-size: 0.625rem; color: var(--success-text); }
    .demo-pc.is-blocked .demo-status { color: var(--danger-text); }
    .window-dots { display: flex; align-items: center; gap: 6px; }
    .window-dot { width: 10px; height: 10px; border-radius: 50%; background: var(--border-input); }
    .window-url { font-size: 0.75rem; color: var(--text-muted); font-family: var(--font-mono); margin-left: 8px; }

    /* Footer */
    footer {
      background: var(--bg-surface);
      border-top: 1px solid var(--border-subtle);
      padding: 56px 24px 32px;
      margin-top: auto;
      font-size: 0.875rem;
      color: var(--text-muted);
    }
    .footer-content {
      max-width: 1200px;
      margin: 0 auto 36px;
      display: grid;
      grid-template-columns: 2fr 1fr 1fr 1.5fr;
      gap: 36px;
    }
    @media (max-width: 800px) { .footer-content { grid-template-columns: 1fr 1fr; } }
    @media (max-width: 500px) { .footer-content { grid-template-columns: 1fr; } }
    .footer-col h5 { font-size: 0.8125rem; font-weight: 600; color: var(--text-main); margin-bottom: 14px; }
    .footer-col ul { list-style: none; display: flex; flex-direction: column; gap: 10px; }
    .footer-col ul a { color: var(--text-muted); font-size: 0.8125rem; }
    .footer-col ul a:hover { color: var(--text-main); }
    .footer-bottom {
      max-width: 1200px;
      margin: 0 auto;
      padding-top: 24px;
      border-top: 1px solid var(--border-subtle);
      display: flex;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
      gap: 12px;
      font-size: 0.8125rem;
      color: var(--text-subtle);
    }

    /* Mobile Drawer */
    .mobile-drawer-backdrop {
      position: fixed;
      inset: 0;
      background: var(--overlay);
      z-index: 998;
      opacity: 0;
      pointer-events: none;
      transition: opacity 0.25s ease;
    }
    .mobile-drawer-backdrop.active { opacity: 1; pointer-events: auto; }
    .mobile-drawer {
      position: fixed;
      top: 0;
      right: 0;
      bottom: 0;
      width: 300px;
      max-width: 85vw;
      background: var(--bg-surface);
      border-left: 1px solid var(--border);
      z-index: 999;
      transform: translateX(100%);
      /* Hidden, not just off-screen, while closed: its links would otherwise sit
         in the Tab order and be read out by screen readers. Visibility flips
         after the slide-out and before the slide-in. */
      visibility: hidden;
      transition: transform 0.25s cubic-bezier(0.16, 1, 0.3, 1), visibility 0s linear 0.25s;
      display: flex;
      flex-direction: column;
      box-shadow: var(--shadow-lg);
    }
    .mobile-drawer.active {
      transform: translateX(0);
      visibility: visible;
      transition: transform 0.25s cubic-bezier(0.16, 1, 0.3, 1), visibility 0s;
    }
    .mobile-drawer-header {
      padding: 14px 16px 14px 20px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      border-bottom: 1px solid var(--border-subtle);
    }
    .drawer-close-btn {
      background: transparent;
      border: none;
      color: var(--text-muted);
      font-size: 1.5rem;
      line-height: 1;
      cursor: pointer;
      width: 36px;
      height: 36px;
      border-radius: var(--radius-sm);
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .drawer-close-btn:hover { color: var(--text-main); background: var(--hover); }
    .mobile-drawer-nav { flex: 1; padding: 12px; display: flex; flex-direction: column; gap: 2px; overflow-y: auto; }
    .mobile-drawer-nav a {
      display: flex;
      align-items: center;
      gap: 12px;
      padding: 10px 12px;
      border-radius: var(--radius-sm);
      font-size: 0.9375rem;
      font-weight: 500;
      color: var(--text-main);
      transition: background-color 0.15s;
    }
    .mobile-drawer-nav a svg { color: var(--text-muted); }
    .mobile-drawer-nav a:hover, .mobile-drawer-nav a:focus-visible { background: var(--hover); }
    .mobile-drawer-actions {
      padding: 16px 20px;
      border-top: 1px solid var(--border-subtle);
      display: flex;
      flex-direction: column;
      gap: 10px;
    }

    /* Mobile Nav Toggle Button */
    .mobile-menu-btn {
      display: none;
      background: var(--bg-surface);
      border: 1px solid var(--border);
      color: var(--text-main);
      cursor: pointer;
      padding: 0;
      border-radius: var(--radius-sm);
      align-items: center;
      justify-content: center;
      width: 36px;
      height: 36px;
    }
    .mobile-menu-btn:hover { background: var(--bg-card-hover); }

    @media (forced-colors: active) {
      .btn, .badge, .feature-card, .faq-item, .contact-card, .audience-card, .metrics-bar, .form-input, .tab-btn.active, .sim-tab-btn.active {
        border: 1px solid CanvasText;
      }
    }

    /* Responsive Breakpoints */
    /* The decorative status badge gives way before the brand name has to wrap. */
    @media (max-width: 1360px) { .edge-status { display: none; } }
    @media (max-width: 1080px) {
      .nav-links { display: none; }
      .mobile-menu-btn { display: inline-flex; }
    }
    @media (max-width: 768px) {
      header { padding: 10px 16px; }
      .edge-status { display: none; }
      .nav-register-btn { display: none; }
      .section-wrap { padding: 56px 16px; }
      .tabs-nav {
        overflow-x: auto;
        flex-wrap: nowrap;
        justify-content: flex-start;
        width: 100%;
        margin-bottom: 24px;
        scrollbar-width: none;
      }
      .tab-btn { flex-shrink: 0; white-space: nowrap; }
      .metric-item + .metric-item { border-left: none; }
    }
    @media (max-width: 640px) {
      .brand-title span { display: none; }
      .hero { padding: 44px 14px 32px; }
      .hero-desc { margin-bottom: 24px; }
      .hero-ctas { flex-direction: column; width: 100%; gap: 10px; }
      .hero-ctas .btn { width: 100%; min-height: 48px; }

      .metrics-bar { grid-template-columns: 1fr 1fr; }
      .metric-item { padding: 16px 10px; }
      .metric-value { font-size: 1.25rem; }
      .metric-label { font-size: 0.6875rem; }

      .audience-card { padding: 18px 14px; gap: 20px; }
      .audience-info h3 { font-size: 1.25rem; }
      .audience-info p { font-size: 0.875rem; }

      .simulator-bar { flex-direction: column; align-items: stretch; gap: 10px; padding: 12px 14px; }
      .sim-controls { width: 100%; }
      .sim-tab-btn { flex: 1; text-align: center; padding: 7px 6px; font-size: 0.75rem; }
      .simulator-body { min-height: auto; padding: 18px 14px; }

      .feature-card { padding: 20px 16px; }
      .specs-table { min-width: 540px; }

      .faq-question { padding: 14px 16px; font-size: 0.9375rem; }
      .faq-answer { padding: 0 16px 16px; }

      .contact-card { padding: 20px 16px; }

      .modal-box {
        padding: 22px 16px;
        margin: 10px;
        max-width: calc(100vw - 20px);
        max-height: 92vh;
      }
      .modal-title { font-size: 1.25rem; }
      .form-input { font-size: 1rem; }
      .form-split { grid-template-columns: 1fr; }
    }

    /* Sub-page Navigation & Hero */
    .nav-links a.active { color: var(--text-main); background: var(--hover); font-weight: 600; }
    .page-hero {
      padding: clamp(48px, 7vw, 84px) 24px 36px;
      text-align: center;
      max-width: 900px;
      margin: 0 auto;
    }
    .page-hero-title {
      font-size: clamp(2rem, 1.5rem + 3vw, 3.25rem);
      font-weight: 700;
      letter-spacing: -0.035em;
      line-height: 1.12;
      margin-bottom: 18px;
      text-wrap: balance;
    }
    .page-hero-title span { color: var(--accent-text); }
    .page-hero-desc {
      font-size: clamp(1rem, 0.95rem + 0.3vw, 1.125rem);
      color: var(--text-muted);
      line-height: 1.65;
      max-width: 720px;
      margin: 0 auto 28px;
      text-wrap: pretty;
    }

    /* Features Grid (Deep Dive) */
    .features-deep-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(min(340px, 100%), 1fr));
      gap: 24px;
      margin-top: 32px;
    }
    .feature-deep-card {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: 32px;
      display: flex;
      flex-direction: column;
      gap: 16px;
      transition: border-color 0.15s ease, box-shadow 0.15s ease;
    }
    .feature-deep-card:hover {
      border-color: var(--border-hover);
      box-shadow: var(--shadow-md);
    }
    .feature-deep-header { display: flex; align-items: center; gap: 14px; }
    .feature-deep-title { font-size: 1.25rem; font-weight: 700; letter-spacing: -0.01em; color: var(--text-main); }
    .feature-deep-text { font-size: 0.9375rem; color: var(--text-muted); line-height: 1.65; }
    .feature-badge-list { display: flex; flex-wrap: wrap; gap: 6px; margin-top: auto; padding-top: 12px; }
    .feature-tag { font-size: 0.75rem; font-family: var(--font-mono); background: var(--bg-subtle); color: var(--text-muted); padding: 2px 8px; border-radius: var(--radius-xs); border: 1px solid var(--border-subtle); }

    /* Pricing Grid */
    .pricing-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(min(300px, 100%), 1fr));
      gap: 24px;
      align-items: stretch;
      margin-top: 36px;
    }
    .pricing-card {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: 36px 28px;
      display: flex;
      flex-direction: column;
      position: relative;
    }
    .pricing-card.featured {
      border-color: var(--accent);
      box-shadow: 0 0 0 1px var(--accent), var(--shadow-md);
    }
    .pricing-card-badge {
      position: absolute;
      top: -12px;
      right: 24px;
      background: var(--accent);
      color: var(--accent-fg);
      font-size: 0.75rem;
      font-weight: 600;
      padding: 3px 12px;
      border-radius: 999px;
      letter-spacing: 0.02em;
    }
    .pricing-tier { font-size: 1.375rem; font-weight: 700; letter-spacing: -0.02em; margin-bottom: 6px; color: var(--text-main); }
    .pricing-sub { font-size: 0.875rem; color: var(--text-muted); min-height: 40px; margin-bottom: 20px; line-height: 1.45; }
    .pricing-price { font-size: 2rem; font-weight: 800; letter-spacing: -0.03em; color: var(--text-main); margin-bottom: 24px; font-variant-numeric: tabular-nums; }
    .pricing-price small { font-size: 0.875rem; font-weight: 500; color: var(--text-muted); }
    .pricing-features { list-style: none; display: flex; flex-direction: column; gap: 12px; margin-bottom: 32px; flex: 1; }
    .pricing-features li { display: flex; align-items: flex-start; gap: 10px; font-size: 0.875rem; color: var(--text-main); line-height: 1.5; }
    .pricing-features li svg { color: var(--success-text); flex-shrink: 0; margin-top: 2px; }

    /* Download Page Cards */
    .download-hero-card {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      padding: 36px;
      max-width: 840px;
      margin: 0 auto 48px;
      box-shadow: var(--shadow-sm);
    }
    .download-meta-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
      gap: 16px;
      margin: 24px 0;
      padding: 16px;
      background: var(--bg-subtle);
      border-radius: var(--radius);
      border: 1px solid var(--border-subtle);
    }
    .download-meta-item { display: flex; flex-direction: column; gap: 4px; }
    .download-meta-label { font-size: 0.75rem; color: var(--text-muted); font-weight: 500; text-transform: uppercase; letter-spacing: 0.04em; }
    .download-meta-val { font-size: 0.9375rem; font-weight: 600; color: var(--text-main); font-family: var(--font-mono); }
    .checksum-box {
      margin-top: 16px;
      padding: 12px 16px;
      background: var(--bg-subtle);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-sm);
      font-size: 0.8125rem;
      font-family: var(--font-mono);
      color: var(--text-muted);
      word-break: break-all;
    }
    .steps-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(min(260px, 100%), 1fr));
      gap: 20px;
      margin-top: 24px;
    }
    .step-card {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 24px;
    }
    .step-num {
      width: 28px;
      height: 28px;
      border-radius: 50%;
      background: var(--accent-soft);
      color: var(--accent-text);
      font-weight: 700;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      font-size: 0.875rem;
      margin-bottom: 12px;
    }
    .step-title { font-size: 1rem; font-weight: 650; margin-bottom: 8px; color: var(--text-main); }
    .step-desc { font-size: 0.875rem; color: var(--text-muted); line-height: 1.55; }

    /* Changelog */
    .changelog-list { display: flex; flex-direction: column; gap: 16px; margin-top: 24px; }
    .changelog-card {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 20px 24px;
    }
    .changelog-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin-bottom: 10px; flex-wrap: wrap; }
    .changelog-version { font-size: 1.0625rem; font-weight: 700; font-family: var(--font-mono); color: var(--text-main); }
    .changelog-date { font-size: 0.8125rem; color: var(--text-muted); }
    .changelog-note { margin-top: 10px; font-size: 0.75rem; color: var(--text-subtle); }
    .changelog-bullets { list-style: disc; padding-left: 20px; font-size: 0.875rem; color: var(--text-muted); line-height: 1.6; }

    /* Documentation Layout */
    .docs-container {
      display: grid;
      grid-template-columns: 260px 1fr;
      gap: 40px;
      max-width: 1280px;
      margin: 0 auto;
      padding: 36px 24px 80px;
      align-items: flex-start;
    }
    @media (max-width: 900px) {
      .docs-container { grid-template-columns: 1fr; gap: 24px; padding: 24px 16px 60px; }
      .docs-sidebar { position: static !important; max-height: none !important; order: 2; border-top: 1px solid var(--border); padding-top: 20px; }
    }
    .docs-sidebar {
      position: sticky;
      top: 80px;
      max-height: calc(100vh - 100px);
      overflow-y: auto;
      padding-right: 12px;
    }
    .docs-sidebar-section { margin-bottom: 24px; }
    .docs-sidebar-title {
      font-size: 0.75rem;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--text-muted);
      margin-bottom: 8px;
    }
    .docs-sidebar-links { list-style: none; display: flex; flex-direction: column; gap: 4px; }
    .docs-sidebar-links a {
      display: block;
      padding: 6px 10px;
      border-radius: var(--radius-sm);
      font-size: 0.875rem;
      color: var(--text-muted);
      transition: color 0.15s, background-color 0.15s;
    }
    .docs-sidebar-links a:hover { color: var(--text-main); background: var(--hover); }
    .docs-sidebar-links a.active { color: var(--accent-text); background: var(--accent-soft); font-weight: 600; }
    .docs-content { min-width: 0; }
    .docs-article { margin-bottom: 48px; scroll-margin-top: 90px; }
    .docs-article h2 { font-size: 1.75rem; font-weight: 700; letter-spacing: -0.02em; margin-bottom: 14px; color: var(--text-main); padding-bottom: 8px; border-bottom: 1px solid var(--border-subtle); }
    .docs-article h3 { font-size: 1.25rem; font-weight: 650; margin: 24px 0 10px; color: var(--text-main); }
    .docs-article p { font-size: 0.9375rem; color: var(--text-muted); line-height: 1.7; margin-bottom: 16px; }
    .docs-article ul { list-style: disc; padding-left: 24px; margin-bottom: 16px; font-size: 0.9375rem; color: var(--text-muted); line-height: 1.65; }
    .docs-article li { margin-bottom: 6px; }
    .docs-article pre {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 16px;
      overflow-x: auto;
      margin: 16px 0 24px;
    }
    .docs-article pre code { background: none; border: none; padding: 0; font-size: 0.875rem; color: var(--text-main); }
    .docs-callout {
      background: var(--bg-surface);
      border-left: 3px solid var(--accent);
      border-radius: 0 var(--radius) var(--radius) 0;
      padding: 16px 20px;
      margin: 20px 0;
      font-size: 0.875rem;
      color: var(--text-muted);
      line-height: 1.6;
    }
    .docs-callout strong { color: var(--text-main); }
    /* The contact page. */
    .contact-layout { display: grid; grid-template-columns: minmax(0, 1.6fr) minmax(0, 1fr); gap: 32px; align-items: start; max-width: 1040px; margin: 0 auto; }
    .contact-form-card { background: var(--bg-surface); border: 1px solid var(--border); border-radius: var(--radius-lg, 14px); padding: 28px; text-align: left; }
    .contact-form-card .form-row { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
    .contact-form-card select.form-input { background: var(--bg-surface); color: var(--text-main); }
    .contact-form-card textarea.form-input { resize: vertical; min-height: 140px; line-height: 1.55; }
    .contact-code-input { font-family: var(--font-mono); letter-spacing: 0.3em; max-width: 220px; }
    .contact-count { text-align: right; }
    .contact-privacy { text-align: center; margin-top: 14px; }
    .contact-privacy a { color: var(--accent-text); }
    .form-optional { color: var(--text-subtle); font-weight: 400; }
    .contact-aside { text-align: left; }
    .contact-aside h2 { font-size: 1rem; font-weight: 650; color: var(--text-main); margin: 0 0 8px; }
    .contact-aside h2:not(:first-child) { margin-top: 28px; }
    .contact-aside p { font-size: 0.875rem; color: var(--text-muted); line-height: 1.55; margin-bottom: 12px; }
    .contact-aside ul { list-style: none; padding: 0; margin: 0; }
    .contact-aside li { padding: 9px 0; border-bottom: 1px solid var(--border-subtle); font-size: 0.875rem; }
    .contact-aside li:last-child { border-bottom: 0; }
    .contact-aside li span { display: block; color: var(--text-muted); font-size: 0.75rem; margin-bottom: 2px; }
    .contact-aside a { color: var(--accent-text); text-decoration: none; overflow-wrap: anywhere; }
    .contact-aside a:hover { text-decoration: underline; }
    @media (max-width: 860px) {
      .contact-layout { grid-template-columns: 1fr; }
      .contact-form-card { padding: 20px 16px; }
      .contact-form-card .form-row { grid-template-columns: 1fr; gap: 0; }
    }
    /* A wiki page rendered from markdown: everything the renderer can emit. */
    .docs-page h1 { font-size: 2rem; font-weight: 750; letter-spacing: -0.03em; line-height: 1.2; margin-bottom: 18px; color: var(--text-main); }
    .docs-page h2 { margin-top: 40px; scroll-margin-top: 90px; }
    .docs-page h3, .docs-page h4 { scroll-margin-top: 90px; }
    .docs-page h4 { font-size: 1rem; font-weight: 650; margin: 20px 0 8px; color: var(--text-main); }
    .docs-page ol { list-style: decimal; padding-left: 24px; margin-bottom: 16px; font-size: 0.9375rem; color: var(--text-muted); line-height: 1.7; }
    .docs-page li > ul, .docs-page li > ol { margin: 6px 0 0; }
    .docs-page a { color: var(--accent-text); text-decoration: underline; text-underline-offset: 2px; }
    .docs-page strong { color: var(--text-main); font-weight: 600; }
    .docs-page code { font-family: var(--font-mono); font-size: 0.8125em; background: var(--bg-surface); border: 1px solid var(--border-subtle); border-radius: 4px; padding: 1px 5px; overflow-wrap: anywhere; }
    .docs-page hr { border: 0; border-top: 1px solid var(--border-subtle); margin: 32px 0; }
    .docs-page blockquote { margin: 20px 0; padding: 14px 18px; background: var(--bg-surface); border-left: 3px solid var(--accent); border-radius: 0 var(--radius) var(--radius) 0; }
    .docs-page blockquote p { margin-bottom: 8px; }
    .docs-page blockquote p:last-child { margin-bottom: 0; }
    .docs-table { overflow-x: auto; margin: 16px 0 24px; border: 1px solid var(--border); border-radius: var(--radius); }
    .docs-table table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
    .docs-table th, .docs-table td { padding: 9px 12px; text-align: left; vertical-align: top; border-bottom: 1px solid var(--border-subtle); color: var(--text-muted); line-height: 1.55; }
    .docs-table th { color: var(--text-main); font-weight: 600; background: var(--bg-surface); white-space: nowrap; }
    .docs-table tr:last-child td { border-bottom: 0; }
    .docs-source { font-size: 0.8125rem; color: var(--text-subtle); border-top: 1px solid var(--border-subtle); padding-top: 16px; }
    .docs-source a { color: var(--text-muted); text-decoration: underline; }
`;

export const SITE_STYLESHEET_PATH = `/assets/site-${fnv1a(SITE_CSS)}.css`;

export function siteStylesheet(): string {
  return SITE_CSS;
}
