/**
 * Privacy Policy, Terms of Service and the Automatic Bug Report Terms.
 *
 * Educational compliance (FERPA, COPPA) and the RAM overlay privacy guarantee.
 * Both pages share one shell: they used to be two complete HTML documents with
 * their own token block, head, header and footer, which is how they drifted onto
 * a third palette while the consoles were on a fourth.
 */

import { escapeHtml, escapeAttr } from "./escape";
import { BUG_REPORT_TERMS_VERSION } from "./bug_reports";
import { FONT_LINKS, rootTokensCss, LEGACY_LEGAL_ALIASES } from "./ui_tokens";
import { FAVICON_LINK_HTML, canonicalLinkHtml } from "./seo";

/** The chrome both legal pages sit inside. */
function renderLegalShell(options: {
  title: string;
  /** The search-result snippet. */
  description: string;
  /** This page on the canonical host, when it has one. */
  canonicalUrl?: string;
  /** The other legal page, linked from the nav. */
  siblingHref: string;
  siblingLabel: string;
  mainHtml: string;
}): string {
  const { title, description, canonicalUrl, siblingHref, siblingLabel, mainHtml } = options;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeAttr(description)}">
${canonicalLinkHtml(canonicalUrl)}${FAVICON_LINK_HTML}  <meta name="color-scheme" content="light dark">
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
export interface LegalPageOptions {
  /** This page on the canonical host (src/seo.ts). */
  canonicalUrl?: string;
}

export function renderPrivacyPolicyHtml(options: LegalPageOptions = {}): string {
  return renderLegalShell({
    title: "Privacy Policy - Lab Kiosk OS",
    description: "How Lab Kiosk OS handles workstation, operator and website visitor data: an in-memory RAM overlay, minimal fleet telemetry, and the service providers involved.",
    canonicalUrl: options.canonicalUrl,
    siblingHref: "/terms",
    siblingLabel: "Terms of Service",
    mainHtml: `
  <main>
    <div class="legal-card">
      <h1>Privacy &amp; Data Protection Policy</h1>
      <div class="updated-date">Last updated: October 7, 2026 • Effective immediately</div>

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
        <li><strong>Live Screen Frames:</strong> Low-resolution preview frames, taken only while an operator has that workstation on screen and relayed to that operator. They are never saved to storage or shared.</li>
        <li><strong>Errors &amp; Warnings:</strong> Problems a workstation reports about its own system, such as an update that failed and was rolled back, kept for 90 days for the organization's administrators.</li>
        <li><strong>Active Navigation Target:</strong> The current active page URL to reflect whether users are on the designated educational assignment.</li>
      </ul>

      <h2>4. Organization Administrator Accounts</h2>
      <p>Organization administrators and operators provide an email address, organization name, and password for administrative access. Passwords are cryptographically hashed using PBKDF2-HMAC-SHA256 (100,000 iterations). Administrative account details are stored securely in Cloudflare D1 and are never sold or shared.</p>
      <p>To register an organization we also ask for a technical contact's name, email address and phone number, the organization's postal address and, optionally, its legal name, tax identifier and billing email. We use them to verify the request, to decide whether to approve it, to arrange payment where a license requires one, and to reach the organization about its account. The email address is confirmed with a one-time code; the phone number is confirmed by our staff before approval. Messages you send to our support address or through the contact form, and our replies, are kept with your request so the conversation can continue.</p>

      <h2>5. Automatic Bug Reports (Optional)</h2>
      <p>An organization's administrator may turn on Automatic Bug Reports. Only then, the workstation problems listed in Errors &amp; Warnings are sent, with network addresses, host names, e-mail addresses and identifiers masked, to an AI model on Cloudflare Workers AI for triage, and published as issues in a GitHub repository, which may be public. Organization names, workstation names, staff accounts, browsing and screen content are never sent. The <a href="/terms/bug-reports">Automatic Bug Report Terms</a> describe exactly what is sent and how to have a report removed.</p>

      <h2>6. Service Providers</h2>
      <p>The Platform runs on Cloudflare, Inc. ("Cloudflare"), which processes the data described in this policy as our service provider, under the <a href="https://www.cloudflare.com/privacypolicy/">Cloudflare Privacy Policy</a> and the <a href="https://www.cloudflare.com/cloudflare-customer-dpa/">Cloudflare Customer Data Processing Addendum</a>. Cloudflare may process it in its data centers worldwide. The Cloudflare services we use, and what each one handles:</p>
      <ul>
        <li><strong>Cloudflare Workers:</strong> runs the Platform. Every request to the consoles, the User Portal and the workstation interface passes through it, and request logs (including IP addresses) are kept for a sample of about one in ten requests for troubleshooting.</li>
        <li><strong>Cloudflare D1:</strong> the database: organization and staff accounts with hashed passwords, registration details and support conversations, the workstation registry, allowlists, User Portal apps, settings, the audit log, and errors and warnings.</li>
        <li><strong>Durable Objects:</strong> each organization's live state: which workstations are connected, the command queue (commands expire after 60 seconds), the screen frames relayed to a watching operator, and the remote-control sessions an operator opens to a workstation, whose screen, keyboard and mouse traffic is passed through and never stored.</li>
        <li><strong>Queues:</strong> audit log entries on their way to the database.</li>
        <li><strong>R2:</strong> audit log entries older than 180 days, archived.</li>
        <li><strong>Workers Analytics Engine:</strong> counts of workstation connections and disconnections per organization.</li>
        <li><strong>Rate Limiting:</strong> counts of requests per IP address in front of sign-in, registration and workstation enrollment.</li>
        <li><strong>Cloudflare Email Service:</strong> sends registration codes, approval decisions and our replies, and receives mail sent to our support address, which is stored with the conversation it belongs to.</li>
        <li><strong>Workflows and Cloudflare for SaaS:</strong> an organization's custom domain name and its TLS certificate.</li>
        <li><strong>Workers AI:</strong> only for organizations that turned on Automatic Bug Reports, the masked problem reports described in section 5.</li>
        <li><strong>Cloudflare Web Analytics:</strong> counts page views and page load times without cookies or a visitor identifier.</li>
        <li><strong>Cloudflare Zaraz:</strong> runs Google Analytics on the public website pages described in section 8, after the visitor consents.</li>
      </ul>
      <p>Two other providers are involved:</p>
      <ul>
        <li><strong>GitHub, Inc.:</strong> only for organizations that turned on Automatic Bug Reports, the masked reports are published as GitHub issues under GitHub's own terms and privacy statement.</li>
        <li><strong>Google Fonts:</strong> the consoles and public pages load the Inter and JetBrains Mono typefaces from Google, which receives the visitor's IP address and browser details when the fonts are requested.</li>
        <li><strong>Google Analytics:</strong> only on the public website pages described in section 8, and only after the visitor consents.</li>
      </ul>

      <h2>7. Super Administrator Privacy Restriction</h2>
      <p>Platform Super Administrators are architecturally restricted from accessing individual organization consoles, user portal configurations, or live workstation telemetry. Super administrator privileges are restricted strictly to tenant approval, status management, and the platform's own demo organizations used for testing (<code>web-demo</code>, <code>local-demo</code> and <code>docker-demo</code>).</p>

      <h2>8. Visitors to This Website</h2>
      <p>The public pages of this website (the home page with its sign-in, registration, download and contact views, and these legal pages, on the platform's own domain) measure how they are used with Google Analytics, provided by Google LLC and run through Cloudflare Zaraz. A banner at the bottom of the home page asks first, and nothing is sent to Google unless you accept; you can change your choice later with Cookie Settings at the foot of the home page. If you accept, Google receives the address and title of each page you open, the page that referred you, your browser, device and screen size, and a random identifier stored in a cookie, and estimates your approximate location from the request. We use the aggregate reports Google makes from this to understand how the website is found and used. It is not used for advertising, and Google signals are not used to build audiences.</p>
      <p>Google Analytics never runs on workstations, the User Portal, organization homepages, organization subdomains or custom domains, or the consoles: the Platform's Content Security Policy blocks it there.</p>

      <h2>9. Contact Us</h2>
      <p>If you have questions regarding our privacy practices or educational data protection compliance, please contact our data protection team at <a href="mailto:privacy@akbhoi.com">privacy@akbhoi.com</a>.</p>
    </div>
  </main>
`
  });
}

export function renderTermsOfServiceHtml(options: LegalPageOptions = {}): string {
  return renderLegalShell({
    title: "Terms of Service - Lab Kiosk OS",
    description: "The terms for using the Lab Kiosk OS platform: licensing, the 45-computer threshold, organization responsibilities and prohibited uses.",
    canonicalUrl: options.canonicalUrl,
    siblingHref: "/privacy",
    siblingLabel: "Privacy Policy",
    mainHtml: `
  <main>
    <div class="legal-card">
      <h1>Terms of Service</h1>
      <div class="updated-date">Last updated: October 4, 2026 • Effective immediately</div>

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

      <h2>5. Third-Party Services &amp; Optional Features</h2>
      <p>The platform is hosted on Cloudflare and relies on the Cloudflare services listed in section 6 of the <a href="/privacy">Privacy Policy</a>, which Cloudflare provides under the <a href="https://www.cloudflare.com/privacypolicy/">Cloudflare Privacy Policy</a> and the <a href="https://www.cloudflare.com/cloudflare-customer-dpa/">Cloudflare Customer Data Processing Addendum</a>. Automatic Bug Reports are optional and governed by the <a href="/terms/bug-reports">Automatic Bug Report Terms</a>, which an organization administrator accepts before turning them on.</p>

      <h2>6. Disclaimer &amp; Service Availability</h2>
      <p>The platform is provided "as is" and "as available". While we strive for 99.9% uptime via Cloudflare's global edge network, we do not warrant that service will be uninterrupted or error-free.</p>

      <h2>7. Inquiries &amp; Legal Notices</h2>
      <p>For legal inquiries, contact <a href="mailto:legal@akbhoi.com">legal@akbhoi.com</a>.</p>
    </div>
  </main>
`
  });
}

/**
 * The Automatic Bug Report Terms an organization accepts before its
 * workstations' problems are filed as GitHub issues (src/bug_reports.ts).
 * Their version is BUG_REPORT_TERMS_VERSION; any change to the text below is a
 * new version, which pauses reports until an administrator accepts it again.
 */
export function renderBugReportTermsHtml(repository: string | null, options: LegalPageOptions = {}): string {
  const where = repository
    ? `the GitHub repository <a href="https://github.com/${escapeHtml(repository)}">${escapeHtml(repository)}</a>`
    : "the GitHub repository named in Settings &rarr; Errors &amp; Warnings";
  return renderLegalShell({
    title: "Automatic Bug Report Terms - Lab Kiosk OS",
    description: "What the optional Automatic Bug Reports send, how reports are masked and published, and how to turn the option off.",
    canonicalUrl: options.canonicalUrl,
    siblingHref: "/terms",
    siblingLabel: "Terms of Service",
    mainHtml: `
  <main>
    <div class="legal-card">
      <h1>Automatic Bug Report Terms</h1>
      <div class="updated-date">Version ${escapeHtml(BUG_REPORT_TERMS_VERSION)} &bull; Applies from the moment an organization accepts it</div>

      <div class="highlight-box">
        <strong>Off unless you turn it on</strong>
        Automatic bug reports are optional. Nothing described here happens until an administrator of your organization accepts these terms and turns the option on in Settings &rarr; Errors &amp; Warnings. You can turn it off at any time.
      </div>

      <h2>1. What These Terms Cover</h2>
      <p>These terms apply to the Automatic Bug Reports option of Lab Kiosk OS ("Platform", "we", "us", operated by Akbhoi Innovations). They add to the <a href="/terms">Terms of Service</a> and the <a href="/privacy">Privacy Policy</a>; where they differ on bug reports, these terms apply. By turning the option on, the administrator accepts these terms on behalf of their organization ("you").</p>

      <h2>2. What the Option Does</h2>
      <p>When a workstation of yours reports a problem that is listed in Errors &amp; Warnings (for example, a system update that failed its first start and was rolled back), the Platform checks once an hour whether the same problem has already been reported. If it has, the problem is linked to the existing report. If it has not, a new report is published as an issue in ${where}. Your console then shows where each problem stands.</p>

      <h2>3. What Is Sent, and What Is Not</h2>
      <p>A report contains only:</p>
      <ul>
        <li>the kind of problem (for example, "update rolled back");</li>
        <li>the version of the Lab Kiosk system image involved;</li>
        <li>the problem text the workstation recorded, after network addresses, host names, web addresses, e-mail addresses and long identifiers have been automatically replaced with placeholders such as <code>&lt;ip&gt;</code>;</li>
        <li>a short fingerprint of that text, used to recognise repeats.</li>
      </ul>
      <p>A report never contains your organization's name, subdomain or domain, workstation names, staff accounts, the pages users visit, screen images, or anything a user types.</p>

      <h2>4. Masking Is Automatic and Best Effort</h2>
      <p>The masking is done by software before anything leaves the Platform. We designed it to remove identifying details, but no automatic filter can be guaranteed to catch everything. If you find a detail in a published report that identifies your organization or a person, write to <a href="mailto:legal@akbhoi.com">legal@akbhoi.com</a> with a link to the report and we will edit or remove it.</p>

      <h2>5. Where Reports Are Published</h2>
      <p>Reports are published in ${where}, which is operated by GitHub, Inc. under its own terms and privacy statement. If that repository is public, anyone can read, copy and index the reports, and copies may remain elsewhere after a report is edited or removed. Reports from different organizations about the same problem are combined, so a report may reflect problems seen by several organizations.</p>

      <h2>6. Processing by an AI Model</h2>
      <p>To decide whether a problem has already been reported, and to write the title and summary of a new report, the masked report and the masked text of earlier reports are processed by an AI model hosted by Cloudflare, Inc. (Cloudflare Workers AI), under the <a href="https://www.cloudflare.com/privacypolicy/">Cloudflare Privacy Policy</a> and the <a href="https://www.cloudflare.com/cloudflare-customer-dpa/">Cloudflare Customer Data Processing Addendum</a>. The other Cloudflare services the Platform runs on are listed in the <a href="/privacy">Privacy Policy</a>. Only the masked information listed in section 3 is given to the model. AI output can be wrong: a problem may be linked to a report that turns out to be unrelated, or reported twice. The report section of every issue is copied exactly by the Platform, not written by the model. The model is not used to make any decision about a person.</p>

      <h2>7. Status Shown in Your Console</h2>
      <p>For each problem that was sent, your console shows whether it opened a new report or was matched to an existing one, and the report's status on GitHub: open, in progress, pull request created, resolved, or closed. The status is read from GitHub about once an hour and is for information only.</p>

      <h2>8. No Support or Fix Commitment</h2>
      <p>Bug reports are a voluntary contribution to improving Lab Kiosk OS. Sending one does not open a support request, create a service-level commitment, or oblige us to respond, fix the problem, or fix it within any time. Support you are entitled to under a Commercial or Subscriber License is unaffected.</p>

      <h2>9. Permission to Publish</h2>
      <p>You allow Akbhoi Innovations, without charge and without time limit, to publish, edit, combine and use the content of the reports sent under these terms for maintaining and improving Lab Kiosk OS. You confirm that turning the option on does not breach any obligation your organization has to others.</p>

      <h2>10. Turning the Option Off</h2>
      <p>An administrator can turn the option off at any time in Settings &rarr; Errors &amp; Warnings. Problems recorded after that are not sent, and problems still waiting to be sent are dropped. Reports already published stay published; you can ask for one to be edited or removed as described in section 4.</p>

      <h2>11. Who Can Accept These Terms</h2>
      <p>Only an administrator with the Settings permission can turn the option on, and by doing so confirms they have the authority to accept these terms for the organization. The Platform records who accepted which version, and when, in your organization's audit log.</p>

      <h2>12. Changes to These Terms</h2>
      <p>If these terms change, they get a new version and date at the top of this page. Reports stop being sent until an administrator of your organization accepts the new version. Nothing is sent under a version your organization has not accepted.</p>

      <h2>13. Contact</h2>
      <p>For questions about these terms, contact <a href="mailto:legal@akbhoi.com">legal@akbhoi.com</a>.</p>
    </div>
  </main>
`
  });
}
