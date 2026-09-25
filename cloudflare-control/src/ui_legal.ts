/**
 * Privacy Policy & Terms of Service.
 *
 * Educational compliance (FERPA, COPPA) and the RAM overlay privacy guarantee.
 * Both pages share one shell: they used to be two complete HTML documents with
 * their own token block, head, header and footer, which is how they drifted onto
 * a third palette while the consoles were on a fourth.
 */

import { escapeHtml } from "./escape";
import { FONT_LINKS, rootTokensCss, LEGACY_LEGAL_ALIASES } from "./ui_tokens";

/** The chrome both legal pages sit inside. */
function renderLegalShell(options: {
  title: string;
  /** The other legal page, linked from the nav. */
  siblingHref: string;
  siblingLabel: string;
  mainHtml: string;
}): string {
  const { title, siblingHref, siblingLabel, mainHtml } = options;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <meta name="color-scheme" content="light dark">
${FONT_LINKS}
  <style>
${rootTokensCss(LEGACY_LEGAL_ALIASES)}
    *, *::before, *::after { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: var(--font-sans);
      font-feature-settings: "cv11", "ss01";
      background: var(--bg-base);
      color: var(--text-main);
      min-height: 100vh;
      display: flex;
      flex-direction: column;
      line-height: 1.7;
      -webkit-font-smoothing: antialiased;
    }
    :where(a):focus-visible { outline: 2px solid var(--border-focus); outline-offset: 2px; }
    header {
      background: var(--bg-base);
      border-bottom: 1px solid var(--border-subtle);
      padding: 12px 32px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
      flex-wrap: wrap;
    }
    .brand { display: flex; align-items: center; gap: 10px; text-decoration: none; color: inherit; }
    .brand-icon {
      width: 32px; height: 32px; background: var(--accent); color: var(--accent-fg);
      border-radius: var(--radius-sm); display: flex; align-items: center; justify-content: center;
    }
    .brand-title { font-size: 0.9375rem; font-weight: 650; letter-spacing: -0.01em; }
    .nav-links { display: flex; align-items: center; gap: 20px; font-size: 0.875rem; flex-wrap: wrap; }
    .nav-links a { color: var(--text-muted); text-decoration: none; transition: color 0.15s; }
    .nav-links a:hover { color: var(--text-main); }
    main {
      flex: 1;
      max-width: 820px;
      width: 100%;
      margin: 48px auto;
      padding: 0 24px 64px;
    }
    .legal-card {
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-sm);
      padding: clamp(24px, 5vw, 48px);
    }
    h1 { font-size: clamp(1.75rem, 1.3rem + 1.6vw, 2.25rem); font-weight: 700; margin: 0 0 6px; letter-spacing: -0.025em; line-height: 1.2; text-wrap: balance; }
    .updated-date { color: var(--text-muted); font-size: 0.8125rem; margin: 0 0 28px; }
    .highlight-box {
      background: var(--success-soft);
      border: 1px solid var(--border);
      border-left: 3px solid var(--success);
      border-radius: var(--radius-sm);
      padding: 16px 20px;
      margin: 24px 0 32px;
      color: var(--text-main);
      font-size: 0.875rem;
    }
    .highlight-box strong { color: var(--success-text); display: block; margin-bottom: 4px; font-size: 0.9375rem; }
    h2 {
      font-size: 1.125rem;
      font-weight: 650;
      letter-spacing: -0.01em;
      margin: 36px 0 10px;
      color: var(--text-main);
      padding-top: 20px;
      border-top: 1px solid var(--border-subtle);
    }
    p { margin: 0 0 16px; color: var(--text-muted); font-size: 0.9375rem; text-wrap: pretty; }
    ul { margin: 0 0 20px 22px; padding: 0; color: var(--text-muted); font-size: 0.9375rem; }
    li { margin-bottom: 8px; }
    strong { color: var(--text-main); font-weight: 600; }
    footer {
      border-top: 1px solid var(--border-subtle);
      padding: 20px 32px;
      text-align: center;
      color: var(--text-subtle);
      font-size: 0.8125rem;
    }
    .legal-card a { color: var(--accent-text); text-underline-offset: 2px; }
    footer a { color: var(--accent-text); text-decoration: none; }
    footer a:hover { text-decoration: underline; }
    @media (max-width: 640px) {
      header { padding: 12px 16px; }
      main { margin: 24px auto; padding: 0 12px 40px; }
    }
  </style>
</head>
<body>
  <header>
    <a href="/" class="brand">
      <div class="brand-icon">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>
      </div>
      <div class="brand-title">Lab Kiosk OS</div>
    </a>
    <nav class="nav-links">
      <a href="/">Home</a>
      <a href="${escapeHtml(siblingHref)}">${escapeHtml(siblingLabel)}</a>
      <a href="/login">Operator Sign In</a>
    </nav>
  </header>

${mainHtml}

  <footer>
    &copy; 2026 Lab Kiosk OS • Akbhoi Innovations • <a href="/">Return to Platform Home</a>
  </footer>
</body>
</html>`;
}

/**
 * Neither legal page carries a script, so neither needs a CSP nonce. They
 * used to take one anyway, which implied a contract the pages do not have.
 * The response still gets its nonce-based CSP from buildHtmlHeaders.
 */
export function renderPrivacyPolicyHtml(): string {
  return renderLegalShell({
    title: "Privacy Policy - Lab Kiosk OS",
    siblingHref: "/terms",
    siblingLabel: "Terms of Service",
    mainHtml: `
  <main>
    <div class="legal-card">
      <h1>Privacy &amp; Data Protection Policy</h1>
      <div class="updated-date">Last updated: September 20, 2026 • Effective immediately</div>

      <div class="highlight-box">
        <strong>100% In-Memory RAM Overlay Guarantee</strong>
        Lab Kiosk OS runs on an immutable read-only root filesystem with <code>overlayroot="tmpfs:recurse=0"</code>. No user personal data, browsing history, downloaded files, or session cookies are ever written to physical disk storage. All transient data is instantly and permanently destroyed upon power-off or reboot.
      </div>

      <h2>1. Introduction &amp; Educational Commitment</h2>
      <p>Lab Kiosk OS ("Platform", "we", "us") is architected specifically for organizations, universities, and educational training laboratories. We strictly adhere to user data privacy standards, including the Family Educational Rights and Privacy Act (FERPA) and the Children's Online Privacy Protection Act (COPPA).</p>

      <h2>2. What We Do NOT Collect</h2>
      <p>We believe workstation fleets should be safe, distraction-free educational spaces. Specifically:</p>
      <ul>
        <li><strong>No User Accounts:</strong> Users do not create accounts, enter email addresses, or log into Lab Kiosk OS.</li>
        <li><strong>No Persistent Browsing Profiles:</strong> Browser cookies, local storage, history, and cache exist solely in volatile RAM and are erased upon reboot.</li>
        <li><strong>No Keystroke Logging:</strong> We do not log user keystrokes, personal communications, or search queries.</li>
        <li><strong>No Commercial Profiling:</strong> User activity is never tracked for advertising, profiling, or behavioral analytics.</li>
      </ul>

      <h2>3. Information Collected for Lab Management</h2>
      <p>To enable operators and lab administrators to oversee room learning, the platform ingests minimal operational telemetry:</p>
      <ul>
        <li><strong>Workstation Identifiers:</strong> Workstation hostname (e.g. <code>PC-01</code>), internal IP address, and connection timestamp.</li>
        <li><strong>Live Screen Thumbnails:</strong> Low-resolution preview frames captured at 3-second intervals solely for real-time room monitoring by the operator. These frames are held in memory during the active session and are never saved to long-term storage or shared.</li>
        <li><strong>Active Navigation Target:</strong> The current active page URL to reflect whether users are on the designated educational assignment.</li>
      </ul>

      <h2>4. Organization Administrator Accounts</h2>
      <p>Organization administrators and operators provide an email address, organization name, and password for administrative access. Passwords are cryptographically hashed using PBKDF2-HMAC-SHA256 (100,000 iterations). Administrative account details are stored securely in Cloudflare D1 and are never sold or shared.</p>

      <h2>5. Super Administrator Privacy Restriction</h2>
      <p>Platform Super Administrators are architecturally restricted from accessing individual organization consoles, user portal configurations, or live workstation telemetry. Super administrator privileges are restricted strictly to tenant approval, status management, and the platform's own demo organizations used for testing (<code>web-demo</code>, <code>local-demo</code> and <code>docker-demo</code>).</p>

      <h2>6. Contact Us</h2>
      <p>If you have questions regarding our privacy practices or educational data protection compliance, please contact our data protection team at <a href="mailto:privacy@akbhoi.com">privacy@akbhoi.com</a>.</p>
    </div>
  </main>
`
  });
}

export function renderTermsOfServiceHtml(): string {
  return renderLegalShell({
    title: "Terms of Service - Lab Kiosk OS",
    siblingHref: "/privacy",
    siblingLabel: "Privacy Policy",
    mainHtml: `
  <main>
    <div class="legal-card">
      <h1>Terms of Service</h1>
      <div class="updated-date">Last updated: September 20, 2026 • Effective immediately</div>

      <h2>1. Acceptance of Terms</h2>
      <p>By registering an organization workstation fleet, enrolling workstations, or accessing the Lab Kiosk OS platform, you agree to be bound by these Terms of Service. If you are entering into this agreement on behalf of an educational organization, you represent that you have the authority to bind such organization.</p>

      <h2>2. Educational Use, 45-Computer Threshold &amp; Subscriber Licensing</h2>
      <p>Lab Kiosk OS is source-available software licensed under the LabKiosk Software License. The software is provided free of charge strictly for accredited, non-profit K-12 schools, colleges, and educational institutions for internal classroom instruction up to a maximum limit of <strong>45 computers</strong>.</p>
      <p><strong>45-Computer Commercial Threshold:</strong> Any deployment by any party (including educational or non-profit organizations) utilizing more than forty-five (45) computers is legally viewed and classified as commercial use, requiring a separate paid Commercial License or active Subscription License.</p>
      <p><strong>Software License vs. Subscriber License:</strong> The LabKiosk Software License governs the underlying source code and self-hosted software. Subscribers utilizing the hosted Cloudflare Worker control plane and priority support are supported in accordance with the <strong>Subscriber License</strong> available within this control plane.</p>

      <h2>3. Organization Responsibilities</h2>
      <p>As an organization administrator or operator using the platform, you agree to:</p>
      <ul>
        <li>Maintain the confidentiality of your organization enrollment key and administrative credentials.</li>
        <li>Curate and maintain the approved approved domain allowlist in accordance with organization policies and local regulations.</li>
        <li>Supervise user workstation use responsibly during lab sessions.</li>
        <li>Notify the platform immediately if any unauthorized access or credential compromise is detected.</li>
      </ul>

      <h2>4. Prohibited Uses</h2>
      <p>You may not use the platform to:</p>
      <ul>
        <li>Circumvent security controls, launch denial-of-service attacks, or scan platform infrastructure.</li>
        <li>Distribute malicious software or configure domain allowlists to direct users to harmful or illegal material.</li>
        <li>Impersonate another educational organization or claim subdomains without authorization.</li>
      </ul>

      <h2>5. Disclaimer &amp; Service Availability</h2>
      <p>The platform is provided "as is" and "as available". While we strive for 99.9% uptime via Cloudflare's global edge network, we do not warrant that service will be uninterrupted or error-free.</p>

      <h2>6. Inquiries &amp; Legal Notices</h2>
      <p>For legal inquiries, contact <a href="mailto:legal@akbhoi.com">legal@akbhoi.com</a>.</p>
    </div>
  </main>
`
  });
}
