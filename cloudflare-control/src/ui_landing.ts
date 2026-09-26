/**
 * Public SaaS Landing Page
 * Hosted at labkiosk.akbhoi.com
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
import { FONT_LINKS, rootTokensCss, LEGACY_LANDING_ALIASES, PALETTE, THEME_TOGGLE_SCRIPT, themeHeadHtml } from "./ui_tokens";

export interface LandingOptions {
  /** Message shown in a banner above the hero, e.g. after a rejected redirect. */
  error?: string;
  /** Modal to open on load, used by /login, /register, /iso, /contact and redirects. */
  openModal?: "login" | "register" | "iso" | "contact";
  /** Public download URL for the built ISO, if configured. */
  isoDownloadUrl?: string;
  /** Apex / base domain for organization subdomains (defaults to labkiosk.akbhoi.com). */
  baseDomain?: string;
  /** Primary contact email (defaults to contact@akbhoi.com). */
  contactEmail?: string;
  /** Per-response CSP nonce; the page's single <script> must carry it. */
  nonce: string;
}

export function renderLandingHtml(data: LandingOptions): string {
  const baseDomain = (data.baseDomain || "labkiosk.akbhoi.com").toLowerCase().replace(/^\./, "");
  const contactEmail = (data.contactEmail || "contact@akbhoi.com").toLowerCase();

  const banner = data.error
    ? `<div class="page-alert" role="alert" aria-live="polite">${escapeHtml(data.error)}</div>`
    : "";

  const isoUrl = data.isoDownloadUrl ? safeHttpUrl(data.isoDownloadUrl) : null;
  const isoAction = isoUrl
    ? `<a href="${escapeHtml(isoUrl)}" target="_blank" rel="noopener noreferrer" class="btn btn-primary btn-block">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
        Download Latest Release (.ISO)
      </a>`
    : `<div class="iso-build-note">
        <p><strong>Deployment Note:</strong> No pre-built release ISO is linked for this cluster yet.</p>
        <p style="margin-top: 6px;">Build a bootable USB image in minutes using Docker:</p>
        <code>docker build -t labkiosk-builder distro-builder</code>
        <p style="margin-top: 8px; font-size: 12px; color: var(--muted);">Or configure the <code>ISO_DOWNLOAD_URL</code> worker secret to publish direct mirrors here.</p>
      </div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Lab Kiosk OS - Secure Browser Workstations for Any Organization</title>
  <meta name="description" content="Turn any computer into a secure browser workstation. Central management for companies, public services, libraries and schools: 100% RAM overlay, one-click screen lock, allowlist-only browsing, zero SSD wear, on Cloudflare's edge.">
  <meta name="theme-color" media="(prefers-color-scheme: light)" content="${PALETTE["--bg-base"][0]}">
  <meta name="theme-color" media="(prefers-color-scheme: dark)" content="${PALETTE["--bg-base"][1]}">
${themeHeadHtml(data.nonce)}
${FONT_LINKS}
  <style>
${rootTokensCss(LEGACY_LANDING_ALIASES)}
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
    .btn-ghost { background: var(--bg-surface); color: var(--text-main); border-color: var(--border); box-shadow: var(--shadow-sm); }
    .btn-ghost:hover { background: var(--bg-card-hover); border-color: var(--border-input); }
    .btn-primary { background: var(--accent); color: var(--accent-fg); box-shadow: var(--shadow-sm); }
    .btn-primary:hover { background: var(--accent-hover); }
    .btn-lg { min-height: 44px; padding: 0 22px; font-size: 0.9375rem; }
    .btn-sm { min-height: 32px; padding: 0 12px; font-size: 0.8125rem; }
    .btn-danger-solid { background: var(--danger); color: var(--on-solid); }
    .btn-danger-solid:hover { filter: brightness(0.92); }
    .btn-block { width: 100%; }
    .theme-toggle {
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
    .theme-toggle:hover { color: var(--text-main); background: var(--bg-card-hover); }

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
    }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <div class="brand-logo" aria-hidden="true">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
      </div>
      <div class="brand-title">
        Lab Kiosk
        <span>OS &amp; Edge SaaS</span>
      </div>
    </div>

    <nav class="nav-links" aria-label="Main Navigation">
      <a href="#features">Features</a>
      <a href="#audiences">Audiences</a>
      <a href="#simulator">Simulator</a>
      <a href="#specs">Specs</a>
      <a href="#security">Architecture</a>
      <a href="#faq">FAQ</a>
      <a href="#contact">Contact</a>
    </nav>

    <div class="nav-actions">
      <div class="edge-status" title="Worker Edge routing active">
        <div class="status-dot"></div>
        <span>Edge Active</span>
      </div>
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
      <a href="#features" data-action="close-drawer">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
        Features
      </a>
      <a href="#audiences" data-action="close-drawer">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
        Stakeholder Solutions
      </a>
      <a href="#simulator" data-action="close-drawer">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><polyline points="8 21 16 21 12 17"/></svg>
        Live Simulator
      </a>
      <a href="#specs" data-action="close-drawer">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><line x1="9" y1="1" x2="9" y2="4"/><line x1="15" y1="1" x2="15" y2="4"/><line x1="9" y1="20" x2="9" y2="23"/><line x1="15" y1="20" x2="15" y2="23"/><line x1="20" y1="9" x2="23" y2="9"/><line x1="20" y1="14" x2="23" y2="14"/><line x1="1" y1="9" x2="4" y2="9"/><line x1="1" y1="14" x2="4" y2="14"/></svg>
        Hardware Specs
      </a>
      <a href="#security" data-action="close-drawer">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="m4.93 4.93 4.24 4.24"/><path d="m14.83 9.17 4.24-4.24"/><path d="m14.83 14.83 4.24 4.24"/><path d="m9.17 14.83-4.24 4.24"/></svg>
        Architecture &amp; Security
      </a>
      <a href="#faq" data-action="close-drawer">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        FAQ
      </a>
      <a href="#contact" data-action="close-drawer">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
        Contact
      </a>
    </nav>
    <div class="mobile-drawer-actions">
      <button class="btn btn-primary btn-block" data-action="drawer-open-modal" data-modal="register">Register Organization</button>
      <button class="btn btn-ghost btn-block" data-action="drawer-open-modal" data-modal="login">Operator Sign In</button>
    </div>
  </div>

  <main>
    ${banner}

    <!-- Hero Section -->
    <section class="hero">
      <div class="hero-badge-container">
        <span class="badge badge-blue">Source-Available &bull; Free for Education up to 45 PCs</span>
        <span class="badge badge-green">Production Ready (Debian 12 + Cloudflare Edge)</span>
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
          <div class="metric-value">&lt; 10 ms</div>
          <div class="metric-label">Cloudflare Edge Telemetry Latency</div>
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
                <span><strong>Zero SSD Wear:</strong> Thin client flash drives (16GB-32GB) degrade rapidly under Windows. Lab Kiosk diverts 100% of writes to volatile RAM (<code>tmpfs</code>), preserving hardware for 10+ years.</span>
              </li>
              <li>
                <span class="bullet-icon">✓</span>
                <span><strong>Hardware Resurrection:</strong> Transform 12-year-old discarded desktop PCs (Core 2 Duo, 2GB RAM) into snappy, modern terminals.</span>
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
            <h4 style="font-size: 15px; margin-bottom: 12px;">Per-Site Cost Comparison</h4>
            <table style="width: 100%; font-size: 13px; border-collapse: collapse; margin-bottom: 16px;">
              <tr style="border-bottom: 1px solid var(--border);">
                <td style="padding: 8px 0; color: var(--muted);">OS &amp; Antivirus Licenses</td>
                <td style="padding: 8px 0; text-align: right; color: var(--danger-text); text-decoration: line-through;">$2,400/yr</td>
              </tr>
              <tr style="border-bottom: 1px solid var(--border);">
                <td style="padding: 8px 0; color: var(--muted);">SSD Replacements</td>
                <td style="padding: 8px 0; text-align: right; color: var(--danger-text); text-decoration: line-through;">$800/yr</td>
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
            <a href="mailto:partners@akbhoi.com?subject=CSR%20Hardware%20Donation%20Inquiry" class="btn btn-primary btn-block">Contact CSR &amp; Partner Team</a>
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
              <div class="sim-app-card" style="background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 20px; text-align: center; cursor: pointer;" data-action="sim-app" data-message="User Portal demo: opening the Company Intranet as a full, native page.">
                <div style="font-size: 32px; margin-bottom: 8px;">🏢</div>
                <div style="font-weight: 700; font-size: 14px;">Company Intranet</div>
                <div style="font-size: 11px; color: var(--muted); margin-top: 4px;">News &amp; Policies</div>
              </div>
              <div class="sim-app-card" style="background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 20px; text-align: center; cursor: pointer;" data-action="sim-app" data-message="User Portal demo: opening the Service Desk.">
                <div style="font-size: 32px; margin-bottom: 8px;">🎧</div>
                <div style="font-weight: 700; font-size: 14px;">Service Desk</div>
                <div style="font-size: 11px; color: var(--muted); margin-top: 4px;">Tickets &amp; Requests</div>
              </div>
              <div class="sim-app-card" style="background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 20px; text-align: center; cursor: pointer;" data-action="sim-app" data-message="User Portal demo: opening the Training Portal.">
                <div style="font-size: 32px; margin-bottom: 8px;">📚</div>
                <div style="font-weight: 700; font-size: 14px;">Training Portal</div>
                <div style="font-size: 11px; color: var(--muted); margin-top: 4px;">Courses &amp; Guides</div>
              </div>
              <div class="sim-app-card" style="background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 20px; text-align: center; cursor: pointer;" data-action="sim-app" data-message="User Portal demo: opening Self-Service Forms.">
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
              <td>4 GB RAM (the full OS and Chromium run from RAM)</td>
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
              <td><strong>Verified Hardware</strong></td>
              <td colspan="2">Tested on HP Thin Clients (t520/t620/t630), Dell OptiPlex (780/790/3020/7040), Lenovo ThinkCentre (M72e/M93p), Intel NUCs, Acer Veriton, and standard assembled desktop towers.</td>
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
              <code>URLBlocklist: ["*"]</code> denies all internet browsing by default. The local Python agent dynamically reconciles the organization's approved whitelist on every heartbeat.
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
            All unauthorized browsing is immediately denied by Chromium's enterprise managed policy (<code>URLBlocklist: ["*"]</code>). Downloads, print menus, bookmarks, extension installations, and DevTools (<code>F12</code>) are permanently disabled. In addition, USB thumb drive automounting is blocked, preventing users from running unauthorized scripts.
          </div>
        </div>

        <div class="faq-item">
          <div class="faq-question" data-action="toggle-faq">
            <span>How does the 100% RAM Overlay protect our thin-client hardware?</span>
            <span class="faq-chevron">▼</span>
          </div>
          <div class="faq-answer">
            Thin clients typically ship with small eMMC or flash SSDs (16 GB–32 GB) that burn through limited write endurance cycles under Windows logging and pagefiles. Lab Kiosk mounts the root filesystem as read-only and redirects all file creation and browser caches to volatile system RAM (<code>tmpfs</code>). Flash storage is never written to during user sessions, prolonging hardware life by 5 to 10 years.
          </div>
        </div>

        <div class="faq-item">
          <div class="faq-question" data-action="toggle-faq">
            <span>Is Lab Kiosk free to use?</span>
            <span class="faq-chevron">▼</span>
          </div>
          <div class="faq-answer">
            Free for schools up to 45 computers, yes. The operating system build pipeline (Debian 12 Live-Build), agent daemon, and Cloudflare Worker control plane are source-available under the LabKiosk Software License: free and unrestricted for accredited schools, universities, non-profits, and personal non-commercial use on up to 45 workstations. Any deployment with more than 45 computers is viewed as commercial and requires a commercial or subscriber license. Paid subscribers utilizing the Cloudflare Worker platform are supported per the Subscriber License.
          </div>
        </div>

        <div class="faq-item">
          <div class="faq-question" data-action="toggle-faq">
            <span>How do we deploy this across many sites?</span>
            <span class="faq-chevron">▼</span>
          </div>
          <div class="faq-answer">
            Registration takes less than 60 seconds on this website. You receive your organization subdomain (e.g. <code>yourorganization.${escapeHtml(baseDomain)}</code>) and an enrollment key. Write the ISO to a USB flash drive, boot your lab computers, and complete the 3-step setup wizard on each machine. They immediately link to your private cloud dashboard.
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
          <a href="mailto:support@akbhoi.com" class="contact-link">support@akbhoi.com</a>
        </div>

        <div class="contact-card">
          <div class="feature-icon" aria-hidden="true" style="margin-bottom: 12px;">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
          </div>
          <h4>Education, CSR &amp; Partners</h4>
          <p>Education deployments, hardware donation partnerships, and platform allowlisting.</p>
          <a href="mailto:partners@akbhoi.com" class="contact-link">partners@akbhoi.com</a>
        </div>
      </div>

      <div style="text-align: center; margin-top: 36px;">
        <button class="btn btn-ghost" data-action="open-modal" data-modal="contact">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          Send Deployment Inquiry Directly
        </button>
      </div>
    </section>
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
        <button type="submit" class="btn btn-primary btn-block" style="margin-top: 10px;">Sign In to Admin Console</button>
      </form>
      <div class="modal-switch">
        New organization? <a href="/register" data-action="switch-modal" data-close="login" data-modal="register">Register your organization</a>
      </div>
    </div>
  </div>

  <!-- Register Modal -->
  <div class="modal-overlay" id="register-modal" role="dialog" aria-modal="true" aria-labelledby="reg-modal-title">
    <div class="modal-box">
      <button class="modal-close" data-action="close-modal" data-modal="register" aria-label="Close dialog">✕</button>
      <h2 class="modal-title" id="reg-modal-title">Register Your Organization</h2>
      <p class="modal-sub">Claim your custom subdomain and cloud console.</p>
      <div class="alert-box" id="register-alert" role="alert"></div>
      <form id="register-form">
        <div class="form-group">
          <label class="form-label" for="reg-name">Organization Name</label>
          <input type="text" class="form-input" id="reg-name" required placeholder="Greenwood Holdings">
        </div>
        <div class="form-group">
          <label class="form-label" for="reg-email">Admin Email</label>
          <input type="email" class="form-input" id="reg-email" required placeholder="admin@greenwood.example" autocomplete="email">
        </div>
        <div class="form-group">
          <label class="form-label" for="reg-password">Password</label>
          <input type="password" class="form-input" id="reg-password" required minlength="12" placeholder="••••••••" autocomplete="new-password">
          <div class="input-hint">Must be at least 12 characters.</div>
        </div>
        <div class="form-group">
          <label class="form-label" for="reg-subdomain">Requested Subdomain Slug</label>
          <div style="display: flex; align-items: center; gap: 6px;">
            <input type="text" class="form-input" id="reg-subdomain" required placeholder="greenwood" pattern="[a-z0-9\-]+" style="font-family: var(--font-mono);">
            <span style="font-family: var(--font-mono); font-size: 13px; color: var(--muted); white-space: nowrap;">.${escapeHtml(baseDomain)}</span>
          </div>
          <div class="input-hint">Lowercase letters, numbers, hyphens only. Your organization is active as soon as you register.</div>
        </div>
        <button type="submit" class="btn btn-primary btn-block" style="margin-top: 10px;">Register &amp; Claim Subdomain</button>
      </form>
      <div class="modal-switch">
        Already registered? <a href="/login" data-action="switch-modal" data-close="register" data-modal="login">Sign in</a>
      </div>
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

  <!-- Contact Modal -->
  <div class="modal-overlay" id="contact-modal" role="dialog" aria-modal="true" aria-labelledby="contact-modal-title">
    <div class="modal-box" style="max-width: 500px;">
      <button class="modal-close" data-action="close-modal" data-modal="contact" aria-label="Close dialog">✕</button>
      <h2 class="modal-title" id="contact-modal-title">Send Deployment Inquiry</h2>
      <p class="modal-sub">Our team responds to organizations and partners within 24 hours.</p>
      <form id="contact-form">
        <div class="form-group">
          <label class="form-label" for="contact-name">Your Full Name</label>
          <input type="text" class="form-input" id="contact-name" required placeholder="Dr. Jane Smith">
        </div>
        <div class="form-group">
          <label class="form-label" for="contact-org">Organization</label>
          <input type="text" class="form-input" id="contact-org" required placeholder="Acme Corp / City Library / State University">
        </div>
        <div class="form-group">
          <label class="form-label" for="contact-sender-email">Email Address</label>
          <input type="email" class="form-input" id="contact-sender-email" required placeholder="jane@lincoln.edu">
        </div>
        <div class="form-group">
          <label class="form-label" for="contact-type">Inquiry Type</label>
          <select class="form-input" id="contact-type" style="background: var(--bg-surface); color: var(--text-main);">
            <option value="Organization Deployment">Organization Deployment</option>
            <option value="Education Deployment / Assessments">Education Deployment / Assessments</option>
            <option value="Corporate CSR Hardware Donation">Corporate CSR Hardware Donation</option>
            <option value="Technical Support Inquiry">Technical Support Inquiry</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label" for="contact-message">Message / Details</label>
          <textarea class="form-input" id="contact-message" rows="4" required placeholder="Tell us about the number of computers, location, and timeline..."></textarea>
        </div>
        <button type="submit" class="btn btn-primary btn-block">Send Inquiry &rarr;</button>
      </form>
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
          <li><a href="#audiences" data-action="audience-tab" data-tab="tab-operators">For IT &amp; Operations</a></li>
          <li><a href="#audiences" data-action="audience-tab" data-tab="tab-users">For End Users</a></li>
          <li><a href="#audiences" data-action="audience-tab" data-tab="tab-universities">For Education</a></li>
          <li><a href="#audiences" data-action="audience-tab" data-tab="tab-smc">For Leadership &amp; Finance</a></li>
          <li><a href="#audiences" data-action="audience-tab" data-tab="tab-corporate">For CSR Donors</a></li>
        </ul>
      </div>

      <div class="footer-col">
        <h5>Platform</h5>
        <ul>
          <li><a href="#features">Core Features</a></li>
          <li><a href="#simulator">Live Simulator</a></li>
          <li><a href="#specs">Hardware Specs</a></li>
          <li><a href="#security">Architecture</a></li>
          <li><a href="#faq">FAQ</a></li>
          <li><a href="/iso" data-action="open-modal" data-modal="iso">Download ISO</a></li>
        </ul>
      </div>

      <div class="footer-col">
        <h5>Global Contact</h5>
        <ul>
          <li><span style="color: var(--text-muted); font-size: 13px;">General:</span> <a href="mailto:${escapeHtml(contactEmail)}">${escapeHtml(contactEmail)}</a></li>
          <li><span style="color: var(--text-muted); font-size: 13px;">Support:</span> <a href="mailto:support@akbhoi.com">support@akbhoi.com</a></li>
          <li><span style="color: var(--text-muted); font-size: 13px;">Partners:</span> <a href="mailto:partners@akbhoi.com">partners@akbhoi.com</a></li>
          <li><a href="/contact" data-action="open-modal" data-modal="contact" style="color: var(--accent-text); font-weight: 600; margin-top: 6px; display: inline-block;">Send Deployment Form &rarr;</a></li>
        </ul>
      </div>
    </div>

    <div class="footer-bottom">
      <div>&copy; 2026 Lab Kiosk OS • Akbhoi Innovations • Free for accredited schools up to 45 PCs • Commercial license for businesses &amp; resale</div>
      <div style="display: flex; gap: 16px; flex-wrap: wrap;">
        <a href="/login" data-action="open-modal" data-modal="login">Sign In</a>
        <a href="/register" data-action="open-modal" data-modal="register">Register Organization</a>
        <a href="/privacy">Privacy Policy</a>
        <a href="/terms">Terms of Service</a>
        <a href="#security">Security</a>
      </div>
    </div>
  </footer>

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
        alert(target.dataset.message);
      } else if (action === 'toggle-faq') {
        toggleFaq(target);
      }
    });
    document.getElementById('contact-form').addEventListener('submit', handleContactSubmit);

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
    if (requestedModal === 'login' || requestedModal === 'register' || requestedModal === 'iso' || requestedModal === 'contact') {
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

    function simulateBroadcast() {
      const url = prompt('Enter a URL to broadcast to every workstation screen:', 'https://intranet.example.com');
      if (url) {
        alert('Broadcast Sent! All thin client screens are navigating to: ' + url);
      }
    }

    // FAQ Accordion Toggle
    function toggleFaq(el) {
      const item = el.parentElement;
      item.classList.toggle('open');
    }

    // Contact Form submission (generates prefilled mailto)
    function handleContactSubmit(e) {
      e.preventDefault();
      const name = document.getElementById('contact-name').value.trim();
      const org = document.getElementById('contact-org').value.trim();
      const email = document.getElementById('contact-sender-email').value.trim();
      const type = document.getElementById('contact-type').value;
      const message = document.getElementById('contact-message').value.trim();
      const target = ${escapeJson(contactEmail)};

      const subject = encodeURIComponent('[' + type + '] Inquiry from ' + name + ' (' + org + ')');
      const body = encodeURIComponent(
        'Name: ' + name + '\\n' +
        'Organization: ' + org + '\\n' +
        'Email: ' + email + '\\n' +
        'Inquiry Type: ' + type + '\\n\\n' +
        'Message:\\n' + message
      );

      closeModal('contact-modal');
      window.location.href = 'mailto:' + target + '?subject=' + subject + '&body=' + body;
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

      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password, tenant: currentTenantSlug() })
        });
        const data = await res.json();
        if (data.status === 'ok') {
          // The server decides. It is the only side that knows which host this
          // request arrived on and which consoles the account may open. This used
          // to be worked out here, and sent every super admin to /super whatever
          // subdomain they had signed in on.
          window.location.href = data.redirect || '/admin';
        } else {
          alertBox.textContent = data.error || 'Login failed';
          alertBox.style.display = 'block';
        }
      } catch (err) {
        alertBox.textContent = 'Network error during login';
        alertBox.style.display = 'block';
      }
    });

    // Registration Form Submission
    document.getElementById('register-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const name = document.getElementById('reg-name').value.trim();
      const email = document.getElementById('reg-email').value.trim();
      const password = document.getElementById('reg-password').value;
      const subdomain = document.getElementById('reg-subdomain').value.trim().toLowerCase();
      const alertBox = document.getElementById('register-alert');
      alertBox.style.display = 'none';

      try {
        const res = await fetch('/api/auth/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, email, password, subdomain })
        });
        const data = await res.json();
        if (data.status === 'ok') {
          if (data.subdomain) {
            const host = window.location.hostname;
            if (host === 'localhost' || host === '127.0.0.1' || host.includes('docker')) {
              window.location.href = '/admin?tenant=' + encodeURIComponent(data.subdomain);
            } else {
              window.location.href = 'https://' + encodeURIComponent(data.subdomain) + '.' + BASE_DOMAIN + '/admin';
            }
          } else {
            window.location.href = '/admin';
          }
        } else {
          alertBox.textContent = data.error || 'Registration failed';
          alertBox.style.display = 'block';
        }
      } catch (err) {
        alertBox.textContent = 'Network error during registration';
        alertBox.style.display = 'block';
      }
    });
  </script>
  <script nonce="${escapeAttr(data.nonce)}">${THEME_TOGGLE_SCRIPT}</script>
</body>
</html>`;
}
