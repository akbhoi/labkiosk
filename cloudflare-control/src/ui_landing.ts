/**
 * Public SaaS Landing Page & Global Educational Portal UI
 * Hosted at labkiosk.akbhoi.com
 *
 * Dedicated experiences for:
 *   - Students & Parents
 *   - Teachers & Lab Instructors
 *   - Universities & Higher Education
 *   - School Management Committees (SMC) & Trustees
 *   - Companies, EdTech & CSR Donors
 *
 * Architectural & Security Invariants:
 *   - 0 runtime npm dependencies
 *   - 100% inline CSS & SVG icons for sub-20ms global edge delivery
 *   - WCAG 2.2 AA accessible (min target size 24px, focus rings, semantic markup)
 *   - Native top-level navigation (never load apps in iframes)
 *   - Escapes all server-rendered values via escapeHtml / escapeJson / safeHttpUrl
 */

import { escapeHtml, escapeJson, safeHttpUrl, escapeAttr } from "./escape";
import { FONT_LINKS, rootTokensCss, LEGACY_LANDING_ALIASES } from "./ui_tokens";

export interface LandingOptions {
  /** Message shown in a banner above the hero, e.g. after a rejected redirect. */
  error?: string;
  /** Modal to open on load, used by /login, /register, /iso, /contact and redirects. */
  openModal?: "login" | "register" | "iso" | "contact";
  /** Public download URL for the built ISO, if configured. */
  isoDownloadUrl?: string;
  /** Apex / base domain for school subdomains (defaults to labkiosk.akbhoi.com). */
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
  <title>Lab Kiosk OS - Centralized School & University Computer Lab Management</title>
  <meta name="description" content="Centralized Computer Lab Kiosk Operating System for schools, universities, and training labs. 100% RAM overlay, Eyes-Front screen lock, zero SSD wear, and global Cloudflare Edge management.">
  <meta name="theme-color" content="#090d16">
${FONT_LINKS}
  <style>
${rootTokensCss(LEGACY_LANDING_ALIASES)}
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Plus Jakarta Sans', system-ui, -apple-system, sans-serif; }
    html { scroll-behavior: smooth; color-scheme: dark; }
    body { background: var(--bg); color: var(--text); min-height: 100vh; display: flex; flex-direction: column; overflow-x: hidden; line-height: 1.6; }
    
    /* Typography & Utilities */
    a { color: inherit; text-decoration: none; }
    code { font-family: 'JetBrains Mono', monospace; font-size: 13px; color: #93c5fd; background: rgba(59, 130, 246, 0.1); padding: 2px 6px; border-radius: 6px; }
    .badge { display: inline-flex; align-items: center; gap: 6px; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; }
    .badge-blue { background: rgba(59, 130, 246, 0.15); color: #93c5fd; border: 1px solid rgba(59, 130, 246, 0.3); }
    .badge-green { background: rgba(16, 185, 129, 0.15); color: #6ee7b7; border: 1px solid rgba(16, 185, 129, 0.3); }
    
    /* Header & Navigation */
    header {
      padding: 16px 32px; display: flex; align-items: center; justify-content: space-between;
      border-bottom: 1px solid rgba(51, 65, 85, 0.6); background: rgba(15, 23, 42, 0.85); backdrop-filter: blur(16px);
      position: sticky; top: 0; z-index: 100;
    }
    .brand { display: flex; align-items: center; gap: 14px; }
    .brand-logo {
      width: 42px; height: 42px; background: linear-gradient(135deg, #3b82f6 0%, #1d4ed8 100%);
      border-radius: 11px; display: flex; align-items: center; justify-content: center;
      box-shadow: 0 4px 16px var(--accent-glow);
    }
    .brand-title { font-size: 20px; font-weight: 800; letter-spacing: -0.3px; display: flex; align-items: center; gap: 8px; }
    .brand-title span { font-size: 12px; font-weight: 600; color: var(--muted); background: var(--card); padding: 2px 8px; border-radius: 6px; border: 1px solid var(--border); }
    
    .nav-links { display: flex; align-items: center; gap: 24px; list-style: none; }
    .nav-links a { font-size: 14px; font-weight: 600; color: var(--muted); transition: color 0.2s; padding: 6px 0; }
    .nav-links a:hover, .nav-links a:focus-visible { color: var(--text); outline: none; }
    
    .nav-actions { display: flex; align-items: center; gap: 12px; }
    .btn {
      padding: 10px 20px; border-radius: 8px; font-size: 14px; font-weight: 700; cursor: pointer;
      transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1); display: inline-flex; align-items: center; justify-content: center; gap: 8px;
      min-height: 40px; border: none; outline: none;
    }
    .btn:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 2px; }
    .btn-ghost { background: transparent; color: var(--text); border: 1px solid var(--border); }
    .btn-ghost:hover { background: rgba(255, 255, 255, 0.06); border-color: #475569; }
    .btn-primary { background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%); color: #fff; box-shadow: 0 4px 14px var(--accent-glow); }
    .btn-primary:hover { background: linear-gradient(135deg, #2563eb 0%, #1d4ed8 100%); transform: translateY(-1px); }
    .btn-block { width: 100%; }

    /* Edge Status Indicator */
    .edge-status {
      display: inline-flex; align-items: center; gap: 8px; padding: 6px 12px; background: rgba(16, 185, 129, 0.08);
      border: 1px solid rgba(16, 185, 129, 0.25); border-radius: 20px; font-size: 12px; font-weight: 600; color: #a7f3d0;
    }
    .status-dot { width: 8px; height: 8px; background: var(--green); border-radius: 50%; box-shadow: 0 0 8px var(--green); animation: pulse 2s infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

    /* Hero Section */
    .hero {
      padding: 90px 24px 60px; text-align: center; max-width: 1080px; margin: 0 auto; position: relative;
    }
    .hero-badge-container { display: flex; align-items: center; justify-content: center; gap: 12px; margin-bottom: 24px; flex-wrap: wrap; }
    .hero-title {
      font-size: clamp(34px, 6vw, 62px); font-weight: 800; line-height: 1.15; letter-spacing: -1.5px; margin-bottom: 24px;
    }
    .hero-title span {
      background: linear-gradient(135deg, #60a5fa 0%, #c084fc 100%);
      -webkit-background-clip: text; -webkit-text-fill-color: transparent;
    }
    .hero-desc {
      font-size: clamp(16px, 2.2vw, 20px); color: var(--muted); line-height: 1.6; max-width: 820px; margin: 0 auto 36px;
    }
    .hero-ctas { display: flex; align-items: center; justify-content: center; gap: 16px; flex-wrap: wrap; margin-bottom: 48px; }
    
    /* Metrics Trust Bar */
    .metrics-bar {
      display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; max-width: 1000px; margin: 0 auto;
      padding: 24px; background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius);
    }
    .metric-item { text-align: center; }
    .metric-value { font-size: 26px; font-weight: 800; color: #fff; }
    .metric-label { font-size: 13px; color: var(--muted); margin-top: 4px; font-weight: 500; }

    /* Stakeholders Audiences Section */
    .section-wrap { padding: 80px 24px; max-width: 1240px; margin: 0 auto; width: 100%; }
    .section-header { text-align: center; margin-bottom: 50px; max-width: 760px; margin-left: auto; margin-right: auto; }
    .section-title { font-size: clamp(28px, 4vw, 40px); font-weight: 800; letter-spacing: -0.5px; margin-bottom: 12px; }
    .section-sub { font-size: 17px; color: var(--muted); }

    /* Stakeholder Tabs */
    .tabs-nav {
      display: flex; align-items: center; justify-content: center; gap: 10px; margin-bottom: 36px; flex-wrap: wrap;
    }
    .tab-btn {
      background: var(--panel); border: 1px solid var(--border); color: var(--muted); padding: 10px 20px;
      border-radius: 10px; font-size: 14px; font-weight: 700; cursor: pointer; transition: all 0.2s;
    }
    .tab-btn:hover { color: #fff; border-color: #475569; }
    .tab-btn.active { background: var(--accent); color: #fff; border-color: var(--accent); box-shadow: 0 4px 14px var(--accent-glow); }
    
    .tab-content { display: none; }
    .tab-content.active { display: block; animation: fadeIn 0.3s ease; }
    @keyframes fadeIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }

    .audience-card {
      background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 40px;
      display: grid; grid-template-columns: 1fr 1fr; gap: 40px; align-items: center;
    }
    @media (max-width: 900px) { .audience-card { grid-template-columns: 1fr; padding: 24px; } }
    .audience-info h3 { font-size: 28px; font-weight: 800; margin-bottom: 16px; color: #fff; }
    .audience-info p { font-size: 16px; color: var(--muted); margin-bottom: 24px; line-height: 1.65; }
    .audience-bullets { list-style: none; display: flex; flex-direction: column; gap: 14px; }
    .audience-bullets li { display: flex; align-items: flex-start; gap: 12px; font-size: 15px; color: #cbd5e1; }
    .bullet-icon { color: var(--green); flex-shrink: 0; margin-top: 2px; }

    .audience-preview {
      background: #020617; border: 1px solid var(--border); border-radius: 14px; padding: 24px;
      display: flex; flex-direction: column; gap: 16px; box-shadow: 0 20px 40px rgba(0,0,0,0.5);
    }

    /* Live Interactive Simulator */
    .simulator-wrap {
      background: #020617; border: 1px solid var(--border); border-radius: var(--radius-lg); overflow: hidden;
      box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.7);
    }
    .simulator-bar {
      background: var(--panel); padding: 14px 20px; display: flex; align-items: center; justify-content: space-between;
      border-bottom: 1px solid var(--border); flex-wrap: wrap; gap: 12px;
    }
    .sim-controls { display: flex; align-items: center; gap: 10px; }
    .sim-app-card { transition: transform 0.2s; }
    .sim-app-card:hover { transform: scale(1.03); }
    .sim-tab-btn {
      padding: 6px 14px; border-radius: 6px; font-size: 13px; font-weight: 700; cursor: pointer;
      background: transparent; color: var(--muted); border: 1px solid transparent; transition: all 0.15s;
    }
    .sim-tab-btn.active { background: var(--card); color: #fff; border-color: var(--border); }
    .simulator-body { padding: 32px; min-height: 440px; display: flex; flex-direction: column; justify-content: center; }

    /* Features Grid */
    .features-grid {
      display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 24px;
    }
    .feature-card {
      background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); padding: 32px;
      transition: all 0.2s ease; display: flex; flex-direction: column;
    }
    .feature-card:hover { border-color: #3b82f6; transform: translateY(-4px); background: var(--card-hover); }
    .feature-icon {
      width: 48px; height: 48px; background: rgba(59, 130, 246, 0.12); border-radius: 12px;
      display: flex; align-items: center; justify-content: center; color: #60a5fa; margin-bottom: 20px;
    }
    .feature-title { font-size: 19px; font-weight: 700; margin-bottom: 10px; color: #fff; }
    .feature-desc { font-size: 14px; color: var(--muted); line-height: 1.6; }

    /* Hardware Specs Table */
    .specs-table {
      width: 100%; border-collapse: collapse; background: var(--panel); border: 1px solid var(--border);
      border-radius: var(--radius); overflow: hidden; margin-top: 24px;
    }
    .specs-table th, .specs-table td { padding: 16px 20px; text-align: left; border-bottom: 1px solid var(--border); font-size: 14px; }
    .specs-table th { background: #1e293b; color: #fff; font-weight: 700; }
    .specs-table tr:last-child td { border-bottom: none; }

    /* FAQ Accordion */
    .faq-list { max-width: 840px; margin: 0 auto; display: flex; flex-direction: column; gap: 14px; }
    .faq-item {
      background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); overflow: hidden;
    }
    .faq-question {
      padding: 18px 24px; cursor: pointer; display: flex; align-items: center; justify-content: space-between;
      font-weight: 700; font-size: 16px; user-select: none; color: #f1f5f9;
    }
    .faq-question:hover { background: rgba(255, 255, 255, 0.02); }
    .faq-chevron { transition: transform 0.2s; color: var(--muted); }
    .faq-item.open .faq-chevron { transform: rotate(180deg); }
    .faq-answer {
      padding: 0 24px 20px; font-size: 14px; color: var(--muted); line-height: 1.65; display: none;
    }
    .faq-item.open .faq-answer { display: block; }

    /* Contact Section Cards */
    .contact-grid {
      display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 24px;
    }
    .contact-card {
      background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); padding: 28px;
      text-align: center; display: flex; flex-direction: column; align-items: center;
    }
    .contact-card h4 { font-size: 18px; font-weight: 700; margin: 14px 0 8px; color: #fff; }
    .contact-card p { font-size: 14px; color: var(--muted); margin-bottom: 18px; line-height: 1.5; }
    .contact-link {
      color: #60a5fa; font-family: 'JetBrains Mono', monospace; font-size: 14px; font-weight: 600;
      text-decoration: underline; text-underline-offset: 4px;
    }
    .contact-link:hover { color: #93c5fd; }

    /* Modals */
    .modal-overlay {
      position: fixed; inset: 0; background: rgba(9, 13, 22, 0.88); backdrop-filter: blur(10px);
      display: none; align-items: center; justify-content: center; z-index: 1000; padding: 20px;
    }
    .modal-overlay.active { display: flex; }
    .modal-box {
      background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 36px;
      max-width: 480px; width: 100%; box-shadow: 0 25px 60px -12px rgba(0, 0, 0, 0.9);
      position: relative; max-height: 90vh; overflow-y: auto;
    }
    .modal-close {
      position: absolute; top: 20px; right: 20px; background: transparent; border: none;
      color: var(--muted); cursor: pointer; font-size: 22px; width: 32px; height: 32px; display: flex; align-items: center; justify-content: center;
      border-radius: 6px;
    }
    .modal-close:hover { color: #fff; background: var(--card); }
    .modal-title { font-size: 24px; font-weight: 800; margin-bottom: 8px; color: #fff; }
    .modal-sub { font-size: 14px; color: var(--muted); margin-bottom: 24px; }
    .form-group { margin-bottom: 18px; text-align: left; }
    .form-label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; color: #cbd5e1; }
    .form-input {
      width: 100%; background: #1e293b; border: 1px solid var(--border); border-radius: 8px;
      padding: 11px 14px; color: #fff; font-size: 14px; outline: none; transition: border 0.15s ease;
    }
    .form-input:focus { border-color: var(--accent); }
    .input-hint { font-size: 11px; color: var(--muted); margin-top: 5px; line-height: 1.4; }
    .modal-switch { text-align: center; margin-top: 18px; font-size: 13px; color: var(--muted); }
    .modal-switch a { color: #60a5fa; text-decoration: none; cursor: pointer; font-weight: 600; }
    .alert-box {
      background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.3); color: #f87171;
      padding: 10px 14px; border-radius: 8px; font-size: 13px; margin-bottom: 18px; display: none;
    }
    .iso-build-note {
      background: #1e293b; border: 1px solid var(--border); border-radius: 10px; padding: 16px;
      font-size: 13px; color: var(--muted); line-height: 1.6; text-align: left;
    }
    .iso-build-note code { display: block; margin: 8px 0; color: #93c5fd; background: #0b1120; padding: 8px 12px; }
    .page-alert {
      max-width: 900px; margin: 24px auto -12px; background: rgba(239, 68, 68, 0.12);
      border: 1px solid rgba(239, 68, 68, 0.35); color: #fca5a5; padding: 12px 18px;
      border-radius: 10px; font-size: 14px; font-weight: 600; text-align: center;
    }

    /* Footer */
    footer {
      background: #020617; border-top: 1px solid var(--border); padding: 48px 24px 32px;
      margin-top: auto; font-size: 14px; color: var(--muted);
    }
    .footer-content {
      max-width: 1200px; margin: 0 auto; display: grid; grid-template-columns: 2fr 1fr 1fr 1.5fr; gap: 36px;
      margin-bottom: 36px;
    }
    @media (max-width: 800px) { .footer-content { grid-template-columns: 1fr 1fr; } }
    @media (max-width: 500px) { .footer-content { grid-template-columns: 1fr; } }
    .footer-col h5 { font-size: 15px; font-weight: 700; color: #fff; margin-bottom: 16px; }
    .footer-col ul { list-style: none; display: flex; flex-direction: column; gap: 10px; }
    .footer-col ul a { color: var(--muted); font-size: 13px; }
    .footer-col ul a:hover { color: #fff; }
    .footer-bottom {
      max-width: 1200px; margin: 0 auto; padding-top: 24px; border-top: 1px solid rgba(51, 65, 85, 0.4);
      display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px; font-size: 13px;
    }

    /* Mobile Drawer */
    .mobile-drawer-backdrop {
      position: fixed; inset: 0; background: rgba(9, 13, 22, 0.7); backdrop-filter: blur(4px);
      z-index: 998; opacity: 0; pointer-events: none; transition: opacity 0.25s ease;
    }
    .mobile-drawer-backdrop.active { opacity: 1; pointer-events: auto; }
    .mobile-drawer {
      position: fixed; top: 0; right: 0; bottom: 0; width: 300px; max-width: 85vw;
      background: #0f172a; border-left: 1px solid var(--border); z-index: 999;
      transform: translateX(100%); transition: transform 0.25s cubic-bezier(0.16, 1, 0.3, 1);
      display: flex; flex-direction: column; box-shadow: -10px 0 30px rgba(0, 0, 0, 0.5);
    }
    .mobile-drawer.active { transform: translateX(0); }
    .mobile-drawer-header {
      padding: 16px 20px; display: flex; align-items: center; justify-content: space-between;
      border-bottom: 1px solid var(--border);
    }
    .drawer-close-btn {
      background: transparent; border: none; color: var(--muted); font-size: 26px;
      line-height: 1; cursor: pointer; padding: 4px; display: flex; align-items: center;
    }
    .drawer-close-btn:hover { color: #fff; }
    .mobile-drawer-nav {
      flex: 1; padding: 16px 12px; display: flex; flex-direction: column; gap: 4px; overflow-y: auto;
    }
    .mobile-drawer-nav a {
      display: flex; align-items: center; gap: 12px; padding: 12px 16px; border-radius: 8px;
      font-size: 15px; font-weight: 600; color: #cbd5e1; transition: all 0.15s;
    }
    .mobile-drawer-nav a:hover, .mobile-drawer-nav a:focus {
      background: rgba(59, 130, 246, 0.12); color: #93c5fd;
    }
    .mobile-drawer-actions {
      padding: 16px 20px; border-top: 1px solid var(--border); display: flex; flex-direction: column; gap: 10px;
    }

    /* Mobile Nav Toggle Button */
    .mobile-menu-btn {
      display: none; background: rgba(255, 255, 255, 0.05); border: 1px solid var(--border);
      color: #fff; cursor: pointer; padding: 8px; border-radius: 8px;
      align-items: center; justify-content: center; min-width: 40px; min-height: 40px;
    }
    .mobile-menu-btn:hover { background: rgba(255, 255, 255, 0.1); border-color: #475569; }

    /* Responsive Breakpoints */
    @media (max-width: 900px) {
      .nav-links { display: none; }
      .mobile-menu-btn { display: inline-flex; }
    }
    @media (max-width: 768px) {
      header { padding: 12px 20px; }
      .edge-status { display: none; }
      .nav-register-btn { display: none; }
      .section-wrap { padding: 50px 16px; }
      .tabs-nav {
        overflow-x: auto; flex-wrap: nowrap; justify-content: flex-start;
        gap: 8px; padding-bottom: 8px; margin-bottom: 24px;
        -webkit-overflow-scrolling: touch; scrollbar-width: none;
      }
      .tabs-nav::-webkit-scrollbar { display: none; }
      .tab-btn { flex-shrink: 0; white-space: nowrap; padding: 8px 16px; font-size: 13px; }
    }
    @media (max-width: 640px) {
      header { padding: 10px 14px; }
      .brand { gap: 10px; }
      .brand-logo { width: 34px; height: 34px; }
      .brand-title { font-size: 17px; }
      .brand-title span { display: none; }
      .nav-signin-btn { padding: 6px 12px; font-size: 13px; min-height: 36px; }

      .hero { padding: 44px 14px 32px; }
      .hero-title { font-size: clamp(26px, 7.5vw, 38px); letter-spacing: -0.5px; margin-bottom: 16px; }
      .hero-desc { font-size: 15px; margin-bottom: 24px; }
      .hero-ctas { flex-direction: column; width: 100%; gap: 10px; }
      .hero-ctas .btn { width: 100%; min-height: 48px; }

      .metrics-bar { grid-template-columns: 1fr 1fr; gap: 10px; padding: 14px; }
      .metric-value { font-size: 20px; }
      .metric-label { font-size: 11px; }

      .audience-card { padding: 18px 14px; border-radius: 16px; gap: 20px; }
      .audience-info h3 { font-size: 20px; margin-bottom: 12px; }
      .audience-info p { font-size: 14px; margin-bottom: 18px; }
      .audience-bullets li { font-size: 13.5px; }

      .simulator-bar { flex-direction: column; align-items: stretch; gap: 10px; padding: 12px 14px; }
      .sim-controls { width: 100%; display: flex; flex-wrap: wrap; gap: 6px; }
      .sim-tab-btn { flex: 1; text-align: center; padding: 7px 6px; font-size: 12px; }
      .simulator-body { min-height: auto; padding: 18px 14px; }

      .features-grid { grid-template-columns: 1fr; gap: 16px; }
      .feature-card { padding: 20px 16px; }

      .specs-table-container {
        width: 100%; overflow-x: auto; -webkit-overflow-scrolling: touch;
        border-radius: var(--radius); border: 1px solid var(--border); margin-top: 20px;
      }
      .specs-table { margin-top: 0; border: none; min-width: 540px; }

      .faq-question { padding: 14px 16px; font-size: 15px; }
      .faq-answer { padding: 0 16px 16px; font-size: 13.5px; }

      .contact-grid { grid-template-columns: 1fr; gap: 16px; }
      .contact-card { padding: 20px 16px; }

      .modal-box {
        padding: 22px 16px; border-radius: 16px; margin: 10px;
        max-width: calc(100vw - 20px); max-height: 92vh;
      }
      .modal-title { font-size: 20px; }
      .modal-sub { font-size: 13px; margin-bottom: 16px; }
      .form-input { font-size: 16px; padding: 10px 12px; }
    }
  </style>
</head>
<body>
  <header>
    <div class="brand">
      <div class="brand-logo" aria-hidden="true">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
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
      <button class="btn btn-ghost nav-signin-btn" data-action="open-modal" data-modal="login">Sign In</button>
      <button class="btn btn-primary nav-register-btn" data-action="open-modal" data-modal="register">Register School Lab</button>
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
        <div class="brand-logo" style="width: 34px; height: 34px;">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
        </div>
        <div class="brand-title" style="font-size: 18px;">Lab Kiosk</div>
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
      <button class="btn btn-primary btn-block" data-action="drawer-open-modal" data-modal="register">Register School Lab</button>
      <button class="btn btn-ghost btn-block" data-action="drawer-open-modal" data-modal="login">Teacher Sign In</button>
    </div>
  </div>

  <main>
    ${banner}

    <!-- Hero Section -->
    <section class="hero">
      <div class="hero-badge-container">
        <span class="badge badge-blue">100% Free &amp; Open Source Platform</span>
        <span class="badge badge-green">Production Ready (Debian 12 + Cloudflare Edge)</span>
      </div>
      <h1 class="hero-title">Centralized School Computer Lab <span>Kiosk Operating System</span></h1>
      <p class="hero-desc">
        Empower teachers, universities, and school management with 100% remote lab management, 1-click Eyes-Front screen lock, zero SSD wear, and instant educational website deployment. Designed to resurrect any PC or thin client into an unhackable terminal.
      </p>
      <div class="hero-ctas">
        <button class="btn btn-primary" style="padding: 12px 28px; font-size: 16px;" data-action="open-modal" data-modal="register">
          Register School Lab
        </button>
        <button class="btn btn-ghost" style="padding: 12px 28px; font-size: 16px;" data-action="open-modal" data-modal="iso">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" aria-hidden="true"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          Download Kiosk ISO
        </button>
        <a href="#simulator" class="btn btn-ghost" style="padding: 12px 24px; font-size: 15px;">
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
          <div class="metric-label">Classroom Eyes-Front Lockout</div>
        </div>
        <div class="metric-item">
          <div class="metric-value">$0 / Free</div>
          <div class="metric-label">No OS or Per-Seat Licensing Fees</div>
        </div>
      </div>
    </section>

    <!-- Stakeholder Solutions Matrix -->
    <section class="section-wrap" id="audiences">
      <div class="section-header">
        <h2 class="section-title">Built for Every Lab Stakeholder</h2>
        <p class="section-sub">From students and teachers to principals, universities, and CSR donors, Lab Kiosk solves the modern digital lab challenge.</p>
      </div>

      <div class="tabs-nav" role="tablist">
        <button class="tab-btn active" data-action="audience-tab" data-tab="tab-teachers" role="tab">For Teachers</button>
        <button class="tab-btn" data-action="audience-tab" data-tab="tab-students" role="tab">For Students</button>
        <button class="tab-btn" data-action="audience-tab" data-tab="tab-universities" role="tab">For Universities</button>
        <button class="tab-btn" data-action="audience-tab" data-tab="tab-smc" role="tab">For School Boards (SMC)</button>
        <button class="tab-btn" data-action="audience-tab" data-tab="tab-corporate" role="tab">For CSR &amp; Partners</button>
      </div>

      <!-- Teachers Tab -->
      <div class="tab-content active" id="tab-teachers">
        <div class="audience-card">
          <div class="audience-info">
            <span class="badge badge-blue" style="margin-bottom: 12px;">Instant Classroom Control</span>
            <h3>Teach Without Distractions</h3>
            <p>Managing 40 students on computer screens used to be exhausting. With Lab Kiosk, you command the entire room from your laptop, tablet, or phone with zero installation required.</p>
            <ul class="audience-bullets">
              <li>
                <span class="bullet-icon">✓</span>
                <span><strong>Instant Eyes-Front Curtain:</strong> Freeze all workstation screens with a single tap so students listen to your instructions.</span>
              </li>
              <li>
                <span class="bullet-icon">✓</span>
                <span><strong>Live Screen Thumbnails:</strong> Live screen previews update every 3 seconds, spotting off-task students instantly.</span>
              </li>
              <li>
                <span class="bullet-icon">✓</span>
                <span><strong>Embedded noVNC Remote Assist:</strong> Take over keyboard and mouse on any desk to unblock stuck students without leaving your chair.</span>
              </li>
              <li>
                <span class="bullet-icon">✓</span>
                <span><strong>Broadcast URLs:</strong> Open educational resources (e.g. Khan Academy, Scratch) simultaneously on all PCs.</span>
              </li>
            </ul>
          </div>
          <div class="audience-preview">
            <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border); padding-bottom: 12px;">
              <span style="font-weight: 700; font-size: 14px;">Teacher Console • Active Lab</span>
              <span class="badge badge-green">38 Workstations Online</span>
            </div>
            <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px;">
              <div style="background: #1e293b; border-radius: 8px; padding: 10px; text-align: center; border: 1px solid var(--border);">
                <div style="font-size: 11px; color: var(--muted);">PC-01</div>
                <div style="height: 48px; background: #0f172a; border-radius: 4px; margin: 6px 0; display: flex; align-items: center; justify-content: center; font-size: 11px; color: #60a5fa;">Khan Academy</div>
                <div style="font-size: 10px; color: var(--green);">● Active</div>
              </div>
              <div style="background: #1e293b; border-radius: 8px; padding: 10px; text-align: center; border: 1px solid var(--border);">
                <div style="font-size: 11px; color: var(--muted);">PC-02</div>
                <div style="height: 48px; background: #0f172a; border-radius: 4px; margin: 6px 0; display: flex; align-items: center; justify-content: center; font-size: 11px; color: #a78bfa;">Scratch 3.0</div>
                <div style="font-size: 10px; color: var(--green);">● Active</div>
              </div>
              <div style="background: #1e293b; border-radius: 8px; padding: 10px; text-align: center; border: 1px solid #ef4444;">
                <div style="font-size: 11px; color: var(--muted);">PC-03</div>
                <div style="height: 48px; background: #0f172a; border-radius: 4px; margin: 6px 0; display: flex; align-items: center; justify-content: center; font-size: 11px; color: #f87171;">Blocked Site</div>
                <div style="font-size: 10px; color: #ef4444;">● Intercepted</div>
              </div>
            </div>
            <button class="btn btn-primary btn-block" style="margin-top: 8px;" data-action="open-modal" data-modal="register">Open Free Teacher Account</button>
          </div>
        </div>
      </div>

      <!-- Students Tab -->
      <div class="tab-content" id="tab-students">
        <div class="audience-card">
          <div class="audience-info">
            <span class="badge badge-green" style="margin-bottom: 12px;">Safe &amp; Distraction-Free</span>
            <h3>Focused, High-Speed Learning</h3>
            <p>Students enjoy a smooth, lag-free terminal designed for curiosity and creation, free from malware, pop-up ads, or social media rabbit holes.</p>
            <ul class="audience-bullets">
              <li>
                <span class="bullet-icon">✓</span>
                <span><strong>Visual App Launcher:</strong> Easily launch curated learning tools (Python, Scratch, CK-12, GeoGebra, Wikipedia) with single-click cards.</span>
              </li>
              <li>
                <span class="bullet-icon">✓</span>
                <span><strong>Zero-Lag Native Browsing:</strong> Full-screen high-performance Chromium rendering without restrictive or laggy iframes.</span>
              </li>
              <li>
                <span class="bullet-icon">✓</span>
                <span><strong>100% Privacy Guarantee:</strong> No student browsing history, cookies, or files are kept. Everything evaporates on restart.</span>
              </li>
              <li>
                <span class="bullet-icon">✓</span>
                <span><strong>Auto-Hiding Navigation Bar:</strong> Top bar glides off-screen automatically, maximizing coding canvases and reading space.</span>
              </li>
            </ul>
          </div>
          <div class="audience-preview">
            <div style="background: #0f172a; border: 1px solid var(--border); border-radius: 10px; padding: 16px;">
              <h4 style="font-size: 14px; margin-bottom: 10px; color: #93c5fd;">Student Portal Launcher</h4>
              <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
                <div style="background: #1e293b; padding: 12px; border-radius: 8px; border: 1px solid var(--border); text-align: center;">
                  <div style="font-size: 20px; margin-bottom: 4px;">🐍</div>
                  <div style="font-weight: 700; font-size: 12px;">Python Playground</div>
                </div>
                <div style="background: #1e293b; padding: 12px; border-radius: 8px; border: 1px solid var(--border); text-align: center;">
                  <div style="font-size: 20px; margin-bottom: 4px;">📐</div>
                  <div style="font-weight: 700; font-size: 12px;">GeoGebra Geometry</div>
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
            <span class="badge badge-blue" style="margin-bottom: 12px;">Higher Education &amp; Exams</span>
            <h3>Scalable Infrastructure for Higher Ed</h3>
            <p>Deploy secure coding labs, computer science practicals, and invigilated university entrance exams across hundreds of campus workstations.</p>
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
            <div style="background: #1e293b; border-radius: 8px; padding: 16px; border: 1px solid var(--border); font-size: 13px; line-height: 1.6;">
              <p><strong>Status:</strong> Strict Examination Lockdown Active</p>
              <p><strong>DevTools &amp; Extensions:</strong> Disabled</p>
              <p><strong>Domain Allowlist:</strong> <code>exams.university.edu</code> only</p>
              <p><strong>External USB / TTY:</strong> Blocked</p>
            </div>
            <a href="mailto:${escapeHtml(contactEmail)}?subject=University%20Campus%20Deployment" class="btn btn-primary btn-block">Inquire for University Deployments</a>
          </div>
        </div>
      </div>

      <!-- SMC / School Board Tab -->
      <div class="tab-content" id="tab-smc">
        <div class="audience-card">
          <div class="audience-info">
            <span class="badge badge-green" style="margin-bottom: 12px;">Budget &amp; TCO Optimization</span>
            <h3>90% Cost Savings &amp; Zero SSD Wear</h3>
            <p>School management committees and trustees can eliminate costly annual Windows and antivirus licenses while tripling the lifespan of existing school hardware.</p>
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
                <span><strong>Zero Licensing Fees:</strong> 100% open-source software stack saves thousands of dollars per lab annually.</span>
              </li>
              <li>
                <span class="bullet-icon">✓</span>
                <span><strong>CIPA / COPPA Compliant:</strong> Granular domain whitelisting blocks adult material, gambling, and unapproved web domains at kernel and browser level.</span>
              </li>
            </ul>
          </div>
          <div class="audience-preview">
            <h4 style="font-size: 15px; margin-bottom: 12px;">School Lab Cost Comparison</h4>
            <table style="width: 100%; font-size: 13px; border-collapse: collapse; margin-bottom: 16px;">
              <tr style="border-bottom: 1px solid var(--border);">
                <td style="padding: 8px 0; color: var(--muted);">OS &amp; Antivirus Licenses</td>
                <td style="padding: 8px 0; text-align: right; color: #ef4444; text-decoration: line-through;">$2,400/yr</td>
              </tr>
              <tr style="border-bottom: 1px solid var(--border);">
                <td style="padding: 8px 0; color: var(--muted);">SSD Replacements</td>
                <td style="padding: 8px 0; text-align: right; color: #ef4444; text-decoration: line-through;">$800/yr</td>
              </tr>
              <tr style="border-bottom: 1px solid var(--border);">
                <td style="padding: 8px 0; font-weight: 700; color: #fff;">Lab Kiosk Total Cost</td>
                <td style="padding: 8px 0; text-align: right; font-weight: 800; color: var(--green); font-size: 16px;">$0.00</td>
              </tr>
            </table>
            <button class="btn btn-primary btn-block" data-action="open-modal" data-modal="register">Register School Lab Today</button>
          </div>
        </div>
      </div>

      <!-- Corporate / CSR Tab -->
      <div class="tab-content" id="tab-corporate">
        <div class="audience-card">
          <div class="audience-info">
            <span class="badge badge-blue" style="margin-bottom: 12px;">Corporate CSR &amp; EdTech</span>
            <h3>Turn Corporate E-Waste into Schools Labs</h3>
            <p>Corporates and donors can partner with Lab Kiosk to refurbish off-lease enterprise computers into turnkey educational computer labs for underserved rural schools.</p>
            <ul class="audience-bullets">
              <li>
                <span class="bullet-icon">✓</span>
                <span><strong>Circular Economy &amp; ESG:</strong> Divert tons of functional e-waste from landfills and directly empower students in high-need districts.</span>
              </li>
              <li>
                <span class="bullet-icon">✓</span>
                <span><strong>Turnkey Flash-and-Go:</strong> Write the Lab Kiosk ISO onto a batch of USB keys. Labs boot into an enrollment screen in seconds.</span>
              </li>
              <li>
                <span class="bullet-icon">✓</span>
                <span><strong>EdTech Integration:</strong> Pre-configure educational platforms and curriculum tools directly into the student launcher.</span>
              </li>
              <li>
                <span class="bullet-icon">✓</span>
                <span><strong>Verifiable Impact:</strong> Real-time telemetry lets donors track student lab engagement and uptime metrics transparently.</span>
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
        <p class="section-sub">Try the student portal, test teacher screen controls, or see how the Eyes-Front lock grabs student attention.</p>
      </div>

      <div class="simulator-wrap">
        <div class="simulator-bar">
          <div style="display: flex; align-items: center; gap: 10px;">
            <div style="width: 10px; height: 10px; border-radius: 50%; background: #ef4444;"></div>
            <div style="width: 10px; height: 10px; border-radius: 50%; background: #f59e0b;"></div>
            <div style="width: 10px; height: 10px; border-radius: 50%; background: #10b981;"></div>
            <span style="font-size: 12px; color: var(--muted); font-family: monospace; margin-left: 8px;">https://demo.${escapeHtml(baseDomain)}</span>
          </div>
          <div class="sim-controls">
            <button class="sim-tab-btn active" id="sim-btn-portal" data-action="sim-view" data-view="portal">Student Portal</button>
            <button class="sim-tab-btn" id="sim-btn-teacher" data-action="sim-view" data-view="teacher">Teacher Console</button>
            <button class="sim-tab-btn" id="sim-btn-curtain" data-action="sim-view" data-view="curtain">Eyes-Front Curtain</button>
          </div>
        </div>

        <div class="simulator-body" id="sim-body">
          <!-- Student Portal Simulation -->
          <div id="sim-view-portal" style="display: block;">
            <div style="text-align: center; margin-bottom: 24px;">
              <h3 style="font-size: 22px; font-weight: 800; color: #fff;">Select an Educational Resource</h3>
              <p style="font-size: 14px; color: var(--muted);">Click any approved application below to open your learning session.</p>
            </div>
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; max-width: 800px; margin: 0 auto;">
              <div class="sim-app-card" style="background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 20px; text-align: center; cursor: pointer;" data-action="sim-app" data-message="Student Portal Demo: Opening Khan Academy in top-level native viewport!">
                <div style="font-size: 32px; margin-bottom: 8px;">📚</div>
                <div style="font-weight: 700; font-size: 14px;">Khan Academy</div>
                <div style="font-size: 11px; color: var(--muted); margin-top: 4px;">Mathematics &amp; Science</div>
              </div>
              <div class="sim-app-card" style="background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 20px; text-align: center; cursor: pointer;" data-action="sim-app" data-message="Student Portal Demo: Launching Scratch 3.0 visual block coding!">
                <div style="font-size: 32px; margin-bottom: 8px;">🐱</div>
                <div style="font-weight: 700; font-size: 14px;">Scratch 3.0</div>
                <div style="font-size: 11px; color: var(--muted); margin-top: 4px;">Creative Coding</div>
              </div>
              <div class="sim-app-card" style="background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 20px; text-align: center; cursor: pointer;" data-action="sim-app" data-message="Student Portal Demo: Launching GeoGebra interactive math graphing!">
                <div style="font-size: 32px; margin-bottom: 8px;">📐</div>
                <div style="font-weight: 700; font-size: 14px;">GeoGebra</div>
                <div style="font-size: 11px; color: var(--muted); margin-top: 4px;">Geometry &amp; Algebra</div>
              </div>
              <div class="sim-app-card" style="background: var(--panel); border: 1px solid var(--border); border-radius: 12px; padding: 20px; text-align: center; cursor: pointer;" data-action="sim-app" data-message="Student Portal Demo: Launching Python browser sandbox!">
                <div style="font-size: 32px; margin-bottom: 8px;">🐍</div>
                <div style="font-weight: 700; font-size: 14px;">Python Lab</div>
                <div style="font-size: 11px; color: var(--muted); margin-top: 4px;">Programming Practice</div>
              </div>
            </div>
          </div>

          <!-- Teacher Console Simulation -->
          <div id="sim-view-teacher" style="display: none;">
            <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 18px; flex-wrap: wrap; gap: 12px;">
              <div>
                <h4 style="font-size: 18px; font-weight: 700;">Classroom Grid • Room 104</h4>
                <p style="font-size: 13px; color: var(--muted);">Click 'Eyes Front Lock' to pause all screens or broadcast a URL.</p>
              </div>
              <div style="display: flex; gap: 10px;">
                <button class="btn btn-ghost" style="font-size: 13px; padding: 8px 14px;" data-action="sim-broadcast">Broadcast URL</button>
                <button class="btn btn-primary" style="font-size: 13px; padding: 8px 14px; background: #ef4444;" data-action="sim-view" data-view="curtain">Eyes Front Lock 🔒</button>
              </div>
            </div>
            <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 12px;">
              <div style="background: #1e293b; border-radius: 8px; padding: 12px; text-align: center; border: 1px solid var(--border);">
                <div style="font-size: 12px; font-weight: 700;">PC-01</div>
                <div style="height: 50px; background: #0b1120; border-radius: 4px; margin: 8px 0; display: flex; align-items: center; justify-content: center; font-size: 11px; color: #38bdf8;">Scratch</div>
                <span style="font-size: 10px; color: var(--green);">● Online</span>
              </div>
              <div style="background: #1e293b; border-radius: 8px; padding: 12px; text-align: center; border: 1px solid var(--border);">
                <div style="font-size: 12px; font-weight: 700;">PC-02</div>
                <div style="height: 50px; background: #0b1120; border-radius: 4px; margin: 8px 0; display: flex; align-items: center; justify-content: center; font-size: 11px; color: #38bdf8;">Khan Academy</div>
                <span style="font-size: 10px; color: var(--green);">● Online</span>
              </div>
              <div style="background: #1e293b; border-radius: 8px; padding: 12px; text-align: center; border: 1px solid var(--border);">
                <div style="font-size: 12px; font-weight: 700;">PC-03</div>
                <div style="height: 50px; background: #0b1120; border-radius: 4px; margin: 8px 0; display: flex; align-items: center; justify-content: center; font-size: 11px; color: #38bdf8;">Python Lab</div>
                <span style="font-size: 10px; color: var(--green);">● Online</span>
              </div>
              <div style="background: #1e293b; border-radius: 8px; padding: 12px; text-align: center; border: 1px solid var(--border);">
                <div style="font-size: 12px; font-weight: 700;">PC-04</div>
                <div style="height: 50px; background: #0b1120; border-radius: 4px; margin: 8px 0; display: flex; align-items: center; justify-content: center; font-size: 11px; color: #38bdf8;">CK-12 Science</div>
                <span style="font-size: 10px; color: var(--green);">● Online</span>
              </div>
            </div>
          </div>

          <!-- Eyes-Front Lock Curtain Simulation -->
          <div id="sim-view-curtain" style="display: none; background: #090d16; border: 2px dashed #ef4444; border-radius: 12px; padding: 48px 24px; text-align: center;">
            <div style="font-size: 48px; margin-bottom: 16px;">🔒</div>
            <h3 style="font-size: 26px; font-weight: 800; color: #f87171; margin-bottom: 8px;">Class Attention, Please!</h3>
            <p style="font-size: 16px; color: #cbd5e1; max-width: 500px; margin: 0 auto 24px;">
              "Eyes to the front of the classroom. The teacher has paused workstation interactions."
            </p>
            <div style="font-size: 12px; color: var(--muted); margin-bottom: 20px;">All keyboard inputs and clicks are swallowed until teacher unlocks.</div>
            <button class="btn btn-primary" data-action="sim-view" data-view="teacher">Resume Teaching (Unlock Screens)</button>
          </div>
        </div>
      </div>
    </section>

    <!-- Detailed Features Grid -->
    <section class="section-wrap" id="features">
      <div class="section-header">
        <h2 class="section-title">Engineered for School Computer Labs</h2>
        <p class="section-sub">Zero maintenance, total teacher command, and foolproof tamper prevention.</p>
      </div>

      <div class="features-grid">
        <div class="feature-card">
          <div class="feature-icon" aria-hidden="true">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
          </div>
          <h3 class="feature-title">Zero SSD Wear (RAM Overlay)</h3>
          <p class="feature-desc">All disk writes are strictly directed to volatile RAM via <code>overlayroot="tmpfs:recurse=0"</code>. Protects thin-client SSDs from wearing out and erases student files on every reboot.</p>
        </div>

        <div class="feature-card">
          <div class="feature-icon" aria-hidden="true">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          </div>
          <h3 class="feature-title">Instant Eyes-Front Lock</h3>
          <p class="feature-desc">One click covers all classroom screens with a fullscreen curtain requiring student attention. Unlocks instantly when you are ready to resume teaching.</p>
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
          <h3 class="feature-title">Custom School Subdomains</h3>
          <p class="feature-desc">Every school gets its own custom subdomain (e.g. <code>greenwood.${escapeHtml(baseDomain)}</code>). Thin clients connect separately and remain 100% isolated to your school's private dashboard.</p>
        </div>

        <div class="feature-card">
          <div class="feature-icon" aria-hidden="true">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
          </div>
          <h3 class="feature-title">Visual Student App Launcher</h3>
          <p class="feature-desc">Admins configure cards with custom thumbnails for allowed educational websites (Khan Academy, Scratch, CK-12, GeoGebra). Students easily launch approved apps.</p>
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
          <p class="feature-desc">Subdomain changes, staff accounts, allowlist edits and key rotations are recorded and readable from your console, including anything the platform did to your school.</p>
        </div>
      </div>
    </section>

    <!-- Hardware Compatibility & Specs Section -->
    <section class="section-wrap" id="specs">
      <div class="section-header">
        <h2 class="section-title">Hardware Specs &amp; Compatibility</h2>
        <p class="section-sub">Resurrect your legacy lab machines or run on modern thin clients without hardware upgrades.</p>
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
            <h4 style="font-size: 16px; font-weight: 700; color: #93c5fd; margin-bottom: 8px;">1. Client OS Lockdown</h4>
            <p style="font-size: 14px; color: var(--muted); line-height: 1.6;">
              Virtual TTY consoles (TTY1-6) and X11 VT-switching keys are masked. Openbox runs without window border escape keybindings. The root filesystem is mounted strictly read-only.
            </p>
          </div>
          <div>
            <h4 style="font-size: 16px; font-weight: 700; color: #93c5fd; margin-bottom: 8px;">2. Managed Enterprise Chromium</h4>
            <p style="font-size: 14px; color: var(--muted); line-height: 1.6;">
              <code>URLBlocklist: ["*"]</code> denies all internet browsing by default. The local Python agent dynamically reconciles the school's approved whitelist on every heartbeat.
            </p>
          </div>
          <div>
            <h4 style="font-size: 16px; font-weight: 700; color: #93c5fd; margin-bottom: 8px;">3. Cloudflare Edge &amp; Web Crypto</h4>
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
        <p class="section-sub">Common questions from school IT coordinators, principals, and university administrators.</p>
      </div>

      <div class="faq-list">
        <div class="faq-item">
          <div class="faq-question" data-action="toggle-faq">
            <span>Does Lab Kiosk work in schools with weak or intermittent internet?</span>
            <span class="faq-chevron">▼</span>
          </div>
          <div class="faq-answer">
            Yes! Unlike streaming thin-client OS solutions that download their rootfs over the internet, the entire Lab Kiosk operating system resides in the computer's local RAM. Once booted, thin clients only transmit lightweight JSON telemetry heartbeats (&lt; 2 KB). If the internet drops temporarily, running educational tools and local web pages continue to function.
          </div>
        </div>

        <div class="faq-item">
          <div class="faq-question" data-action="toggle-faq">
            <span>What happens if a student attempts to open other websites or download games?</span>
            <span class="faq-chevron">▼</span>
          </div>
          <div class="faq-answer">
            All unauthorized browsing is immediately denied by Chromium's enterprise managed policy (<code>URLBlocklist: ["*"]</code>). Downloads, print menus, bookmarks, extension installations, and DevTools (<code>F12</code>) are permanently disabled. In addition, USB thumb drive automounting is blocked, preventing students from running unauthorized scripts.
          </div>
        </div>

        <div class="faq-item">
          <div class="faq-question" data-action="toggle-faq">
            <span>How does the 100% RAM Overlay protect our thin-client hardware?</span>
            <span class="faq-chevron">▼</span>
          </div>
          <div class="faq-answer">
            Thin clients typically ship with small eMMC or flash SSDs (16 GB–32 GB) that burn through limited write endurance cycles under Windows logging and pagefiles. Lab Kiosk mounts the root filesystem as read-only and redirects all file creation and browser caches to volatile system RAM (<code>tmpfs</code>). Flash storage is never written to during student sessions, prolonging hardware life by 5 to 10 years.
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
            <span>How do we deploy this across an entire district or campus?</span>
            <span class="faq-chevron">▼</span>
          </div>
          <div class="faq-answer">
            Registration takes less than 60 seconds on this website. You receive your school subdomain (e.g. <code>yourschool.${escapeHtml(baseDomain)}</code>) and an enrollment key. Write the ISO to a USB flash drive, boot your lab computers, and complete the 3-step setup wizard on each machine. They immediately link to your private cloud dashboard.
          </div>
        </div>
      </div>
    </section>

    <!-- Global Contact & Deployment Support -->
    <section class="section-wrap" id="contact">
      <div class="section-header">
        <h2 class="section-title">Global Contact &amp; Support</h2>
        <p class="section-sub">Have questions about school onboarding, university campus deployments, or corporate CSR hardware donations? Get in touch with our team.</p>
      </div>

      <div class="contact-grid">
        <div class="contact-card">
          <div class="feature-icon" aria-hidden="true" style="margin-bottom: 12px;">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
          </div>
          <h4>General Inquiries &amp; School Boards</h4>
          <p>For school principals, management committees, and general questions about Lab Kiosk.</p>
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
          <h4>Universities, CSR &amp; Partners</h4>
          <p>Hardware donation partnerships, EdTech platform whitelisting, and campus exam licensing.</p>
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
      <h2 class="modal-title" id="login-modal-title">Teacher &amp; Admin Sign In</h2>
      <p class="modal-sub">Log in to manage your school computer lab.</p>
      <div class="alert-box" id="login-alert" role="alert"></div>
      <form id="login-form">
        <div class="form-group">
          <label class="form-label" for="login-email">Email Address</label>
          <input type="email" class="form-input" id="login-email" required placeholder="teacher@school.edu" autocomplete="email">
        </div>
        <div class="form-group">
          <label class="form-label" for="login-password">Password</label>
          <input type="password" class="form-input" id="login-password" required placeholder="••••••••" autocomplete="current-password">
        </div>
        <button type="submit" class="btn btn-primary btn-block" style="margin-top: 10px;">Sign In to Lab Console</button>
      </form>
      <div class="modal-switch">
        New school? <a href="/register" data-action="switch-modal" data-close="login" data-modal="register">Register your lab</a>
      </div>
    </div>
  </div>

  <!-- Register Modal -->
  <div class="modal-overlay" id="register-modal" role="dialog" aria-modal="true" aria-labelledby="reg-modal-title">
    <div class="modal-box">
      <button class="modal-close" data-action="close-modal" data-modal="register" aria-label="Close dialog">✕</button>
      <h2 class="modal-title" id="reg-modal-title">Register School Lab</h2>
      <p class="modal-sub">Claim your free custom subdomain and cloud console.</p>
      <div class="alert-box" id="register-alert" role="alert"></div>
      <form id="register-form">
        <div class="form-group">
          <label class="form-label" for="reg-name">School / Organization Name</label>
          <input type="text" class="form-input" id="reg-name" required placeholder="Greenwood High School">
        </div>
        <div class="form-group">
          <label class="form-label" for="reg-email">Teacher / Admin Email</label>
          <input type="email" class="form-input" id="reg-email" required placeholder="teacher@greenwood.edu" autocomplete="email">
        </div>
        <div class="form-group">
          <label class="form-label" for="reg-password">Password</label>
          <input type="password" class="form-input" id="reg-password" required minlength="12" placeholder="••••••••" autocomplete="new-password">
          <div class="input-hint">Must be at least 12 characters.</div>
        </div>
        <div class="form-group">
          <label class="form-label" for="reg-subdomain">Requested Subdomain Slug</label>
          <div style="display: flex; align-items: center; gap: 6px;">
            <input type="text" class="form-input" id="reg-subdomain" required placeholder="greenwood" pattern="[a-z0-9\-]+" style="font-family: monospace;">
            <span style="font-family: monospace; font-size: 13px; color: var(--muted); white-space: nowrap;">.${escapeHtml(baseDomain)}</span>
          </div>
          <div class="input-hint">Lowercase letters, numbers, hyphens only. Your lab is active as soon as you register.</div>
        </div>
        <button type="submit" class="btn btn-primary btn-block" style="margin-top: 10px;">Register Lab &amp; Claim Subdomain</button>
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
      <div style="background: #1e293b; border: 1px solid var(--border); border-radius: 12px; padding: 20px; margin-bottom: 20px; text-align: left;">
        <h4 style="font-size: 14px; margin-bottom: 8px; color: #60a5fa;">Step 1: Write ISO to USB Drive</h4>
        <p style="font-size: 13px; color: var(--muted); line-height: 1.5; margin-bottom: 14px;">
          Download <code>labkiosk-debian12-amd64.iso</code> and flash it to a 2 GB+ USB drive using <strong>Rufus</strong> (Windows, DD image mode) or <strong>balenaEtcher</strong> (Mac/Linux).
        </p>
        <h4 style="font-size: 14px; margin-bottom: 8px; color: #60a5fa;">Step 2: Boot Client &amp; First-Boot Wizard</h4>
        <p style="font-size: 13px; color: var(--muted); line-height: 1.5;">
          Boot your PC from USB. On first boot, the setup wizard prompts for your <strong>School Subdomain</strong>, <strong>PC Identifier (e.g. PC-01)</strong>, and <strong>Enrollment Key</strong>. Once verified, the workstation permanently links to your cloud dashboard!
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
      <p class="modal-sub">Our global team responds to schools, universities, and partners within 24 hours.</p>
      <form id="contact-form">
        <div class="form-group">
          <label class="form-label" for="contact-name">Your Full Name</label>
          <input type="text" class="form-input" id="contact-name" required placeholder="Dr. Jane Smith">
        </div>
        <div class="form-group">
          <label class="form-label" for="contact-org">School, University or Company</label>
          <input type="text" class="form-input" id="contact-org" required placeholder="Lincoln High School / State University">
        </div>
        <div class="form-group">
          <label class="form-label" for="contact-sender-email">Email Address</label>
          <input type="email" class="form-input" id="contact-sender-email" required placeholder="jane@lincoln.edu">
        </div>
        <div class="form-group">
          <label class="form-label" for="contact-type">Inquiry Type</label>
          <select class="form-input" id="contact-type" style="background:#1e293b; color:#fff;">
            <option value="School Computer Lab Deployment">School Computer Lab Deployment</option>
            <option value="University Campus / Exam Lab">University Campus / Exam Lab</option>
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
          <div class="brand-logo" style="width: 32px; height: 32px;">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.5"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
          </div>
          <span style="font-weight: 800; font-size: 16px; color: #fff;">Lab Kiosk OS</span>
        </div>
        <p style="font-size: 13px; line-height: 1.6; margin-bottom: 12px;">
          The Centralized School &amp; University Computer Lab Kiosk Operating System. 100% RAM Overlay, zero SSD degradation, and instant classroom command from Cloudflare's serverless edge.
        </p>
        <p style="font-size: 12px; color: #64748b;">
          Hosted globally at <code>${escapeHtml(baseDomain)}</code>
        </p>
      </div>

      <div class="footer-col">
        <h5>Stakeholders</h5>
        <ul>
          <li><a href="#audiences" data-action="audience-tab" data-tab="tab-teachers">For Teachers</a></li>
          <li><a href="#audiences" data-action="audience-tab" data-tab="tab-students">For Students</a></li>
          <li><a href="#audiences" data-action="audience-tab" data-tab="tab-universities">For Universities</a></li>
          <li><a href="#audiences" data-action="audience-tab" data-tab="tab-smc">For School Boards (SMC)</a></li>
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
          <li><span style="color: #cbd5e1; font-size: 13px;">General:</span> <a href="mailto:${escapeHtml(contactEmail)}">${escapeHtml(contactEmail)}</a></li>
          <li><span style="color: #cbd5e1; font-size: 13px;">Support:</span> <a href="mailto:support@akbhoi.com">support@akbhoi.com</a></li>
          <li><span style="color: #cbd5e1; font-size: 13px;">Partners:</span> <a href="mailto:partners@akbhoi.com">partners@akbhoi.com</a></li>
          <li><a href="/contact" data-action="open-modal" data-modal="contact" style="color: #60a5fa; font-weight: 600; margin-top: 6px; display: inline-block;">Send Deployment Form &rarr;</a></li>
        </ul>
      </div>
    </div>

    <div class="footer-bottom">
      <div>&copy; 2026 Lab Kiosk OS • Akbhoi Innovations • Free for accredited schools, commercial license required for resale</div>
      <div style="display: flex; gap: 16px; flex-wrap: wrap;">
        <a href="/login" data-action="open-modal" data-modal="login">Sign In</a>
        <a href="/register" data-action="open-modal" data-modal="register">Register School</a>
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
        'tab-teachers': 0,
        'tab-students': 1,
        'tab-universities': 2,
        'tab-smc': 3,
        'tab-corporate': 4
      };
      if (buttons[tabMap[tabId]]) buttons[tabMap[tabId]].classList.add('active');
    }

    // Simulator view switcher
    function setSimView(view) {
      const p = document.getElementById('sim-view-portal');
      const t = document.getElementById('sim-view-teacher');
      const c = document.getElementById('sim-view-curtain');
      const bp = document.getElementById('sim-btn-portal');
      const bt = document.getElementById('sim-btn-teacher');
      const bc = document.getElementById('sim-btn-curtain');
      
      p.style.display = view === 'portal' ? 'block' : 'none';
      t.style.display = view === 'teacher' ? 'block' : 'none';
      c.style.display = view === 'curtain' ? 'block' : 'none';

      bp.classList.toggle('active', view === 'portal');
      bt.classList.toggle('active', view === 'teacher');
      bc.classList.toggle('active', view === 'curtain');
    }

    function simulateBroadcast() {
      const url = prompt('Enter URL to broadcast to all lab workstation screens:', 'https://scratch.mit.edu');
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
     * Which school this page is showing, if any.
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
</body>
</html>`;
}
