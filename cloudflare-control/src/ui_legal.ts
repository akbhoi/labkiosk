/**
 * Terms of Service, Content Policy, Privacy Policy, Data Processing Agreement
 * and the Automatic Bug Report Terms.
 *
 * The texts were drafted for review by a lawyer; a change to the Terms, the
 * Content Policy or the Data Processing Agreement (part of the Terms) is a new
 * version in src/legal.ts (LEGAL_DOCUMENTS), which every organization is asked
 * to accept. Every page shares one shell: they used to be
 * complete HTML documents with their own token block, head, header and footer,
 * which is how they drifted onto a third palette while the consoles were on a
 * fourth.
 */

import { escapeHtml, escapeAttr } from "./escape";
import { BUG_REPORT_TERMS_VERSION } from "./bug_reports";
import { FONT_LINKS, rootTokensCss, LEGACY_LEGAL_ALIASES } from "./ui_tokens";
import { FAVICON_LINK_HTML, canonicalLinkHtml } from "./seo";

/** The legal pages every one of them links to, in this order. */
const LEGAL_PAGES: ReadonlyArray<{ path: string; label: string }> = [
  { path: "/terms", label: "Terms of Service" },
  { path: "/content-policy", label: "Content Policy" },
  { path: "/privacy", label: "Privacy Policy" },
  { path: "/dpa", label: "Data Processing Agreement" }
];

/** The chrome every legal page sits inside. */
function renderLegalShell(options: {
  title: string;
  /** The search-result snippet. */
  description: string;
  /** This page on the canonical host, when it has one. */
  canonicalUrl?: string;
  /** This page's path: the nav links the other legal pages. */
  current: string;
  mainHtml: string;
}): string {
  const { title, description, canonicalUrl, current, mainHtml } = options;
  const links = LEGAL_PAGES.filter((page) => page.path !== current)
    .map((page) => `<a href="${escapeAttr(page.path)}">${escapeHtml(page.label)}</a>`)
    .join("\n      ");
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
      ${links}
      <a href="/login">Operator Sign In</a>
    </nav>
  </header>

${mainHtml}

  <footer>
    &copy; 2026 Lab Kiosk OS • ${LEGAL_PAGES.map((page) => `<a href="${escapeAttr(page.path)}">${escapeHtml(page.label)}</a>`).join(" • ")} • <a href="/">Return to Platform Home</a>
  </footer>
</body>
</html>`;
}

/**
 * No legal page carries a script, so none needs a CSP nonce. They
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
    description: "How Lab Kiosk OS handles workstation, staff and website visitor data under the GDPR, the UK GDPR and India's DPDP Act: what is collected, where it is stored, how long it is kept, and your rights.",
    canonicalUrl: options.canonicalUrl,
    current: "/privacy",
    mainHtml: `
  <main>
    <div class="legal-card">
      <h1>Privacy &amp; Data Protection Policy</h1>
      <div class="updated-date">Last updated: October 20, 2026 • Effective immediately</div>

      <div class="highlight-box">
        <strong>100% In-Memory RAM Overlay Guarantee</strong>
        Lab Kiosk OS runs on an immutable read-only root filesystem with <code>overlayroot="tmpfs:recurse=0"</code>. No user personal data, browsing history, downloaded files, or session cookies are ever written to physical disk storage. All transient data is instantly and permanently destroyed upon power-off or reboot.
      </div>

      <h2>1. Introduction</h2>
      <p>Lab Kiosk OS ("Platform", "we", "us", operated by Akbhoi Innovations) turns computers into managed browser workstations for organizations: companies, public bodies, libraries, schools and other institutions. This policy explains the personal data the Platform handles, why, where it is kept and for how long, and the rights people have over it.</p>
      <p><strong>Who decides.</strong> For the data about an organization's workstations, its users and its staff, the organization decides why and how it is processed: it is the <strong>controller</strong> under the EU General Data Protection Regulation (GDPR) and the UK GDPR, and the <strong>Data Fiduciary</strong> under India's Digital Personal Data Protection Act, 2023 (DPDP Act). We process that data on its behalf, as its <strong>processor</strong> (a Data Processor under the DPDP Act), under the <a href="/dpa">Data Processing Agreement</a>, which is part of our <a href="/terms">Terms of Service</a>. For the data we decide about ourselves (registration and account records, billing, the record of accepted legal documents, messages sent to us, the security of the Platform and the analytics on our own website) we are the controller and Data Fiduciary.</p>
      <p>An organization whose users are children or students remains responsible for the laws that protect them, such as the Family Educational Rights and Privacy Act (FERPA) and the Children's Online Privacy Protection Act (COPPA) in the United States, section 9 of the DPDP Act in India, and the GDPR's rules for children in Europe; the Platform is built to collect as little as it can about users, as section 2 describes, and section 12 says more.</p>

      <h2>2. What We Do NOT Collect</h2>
      <p>We believe managed workstations should be safe, distraction-free spaces. Specifically:</p>
      <ul>
        <li><strong>No User Accounts:</strong> Users do not create accounts, enter email addresses, or log into Lab Kiosk OS. Workstations are shared, and the Platform does not know who is using one.</li>
        <li><strong>No Persistent Browsing Profiles:</strong> Browser cookies, local storage, history, and cache exist solely in volatile RAM and are erased upon reboot.</li>
        <li><strong>No Keystroke Logging:</strong> We do not log user keystrokes, personal communications, or search queries. The on-screen keyboard works entirely on the workstation and sends nothing to the Platform.</li>
        <li><strong>No Personal Browsing Record:</strong> usage reports (section 3) count the sites an organization's workstations visit by domain name only, for the organization as a whole, never the full address, the page content, or who visited.</li>
        <li><strong>No Documents You Print:</strong> print jobs go from the workstation straight to the organization's own printers; their content never passes through the Platform.</li>
        <li><strong>No Commercial Profiling:</strong> User activity is never tracked for advertising, profiling, or behavioral analytics.</li>
      </ul>

      <h2>3. Information Collected for Workstation Management</h2>
      <p>So that an organization's staff can oversee its workstations, the Platform receives minimal operational telemetry. Workstation data is about a computer, not a person, but it can be personal data where it can be linked to someone, for example a screen showing a person's work:</p>
      <ul>
        <li><strong>Workstation Identifiers:</strong> Workstation hostname (e.g. <code>PC-01</code>), internal IP address, and connection timestamp.</li>
        <li><strong>Live Screen Frames:</strong> Low-resolution preview frames, taken only while an operator has that workstation on screen and relayed to that operator. They are never saved to storage or shared.</li>
        <li><strong>Errors &amp; Warnings:</strong> Problems a workstation reports about its own system, such as an update that failed and was rolled back, a restart that was not a shutdown, or a disk that is wearing out, kept for 90 days for the organization's administrators.</li>
        <li><strong>Active Page:</strong> the address of the page each workstation shows, so staff can see whether users are on the page they were directed to.</li>
        <li><strong>Remote Control:</strong> when an administrator of the organization takes control of a workstation, its screen, keyboard and mouse traffic passes through the Platform for the length of the session and is never recorded.</li>
        <li><strong>Hardware Report:</strong> once each time a workstation starts, it reports its system manufacturer and model (read from its firmware), its processor model and number of cores, its memory size, whether it started in UEFI or BIOS mode, whether a keyboard and a touchscreen are attached, and the hardware (MAC) addresses of its wired network adapters. This is kept on the workstation's record for the organization. The MAC addresses are used only to wake the workstation over the network.</li>
        <li><strong>Usage Reports:</strong> for each workstation and each local day, how long it was switched on, how long it was in use (someone used its keyboard, mouse or touchscreen within the last minute, as Chromium's idle detection reports it), and how many fresh browsing sessions were started. For the organization as a whole and each day, the domain names of the sites its workstations visited (for example <code>wikipedia.org</code>), with the time in use and the number of visits for each. Never the full address, what was on the page, or who visited. An administrator can turn off the recording of sites in Settings. Usage reports are kept for 400 days and then deleted.</li>
        <li><strong>Power Schedules and Wake-on-LAN:</strong> the times the organization sets for its workstations to switch on and off. To switch on a workstation that is off, the Platform asks another of the organization's workstations that is online on the same local network to send it a Wake-on-LAN packet, addressed by the MAC address from its hardware report.</li>
        <li><strong>Printers:</strong> printing is off until an administrator of the organization turns it on. The Platform then stores the names and network addresses of the organization's own printers that its staff enter, so workstations can print to them over the local network (IPP). Documents go from the workstation to the printer and never pass through the Platform.</li>
      </ul>

      <h2>4. Organization Administrator Accounts</h2>
      <p>Organization administrators and operators provide an email address, organization name, and password for administrative access. Passwords are cryptographically hashed using PBKDF2-HMAC-SHA256 (100,000 iterations) and then keyed with a secret held outside the database. Administrative account details are stored securely in Cloudflare D1 and are never sold or shared.</p>
      <p><strong>Signing in with Google or Microsoft.</strong> An organization can let its staff sign in with their Google Workspace or Microsoft Entra ID account (OpenID Connect). Only when the organization has turned this on and a member of staff chooses it, their browser is sent to Google or Microsoft, which receives the sign-in request and returns the person's email address, name, an identifier for their account with that provider, and the Google Workspace domain or the Microsoft tenant it belongs to. We keep only what we need to match the sign-in to the staff account the organization already created, and we do not store the provider's access or refresh tokens. Google and Microsoft handle the sign-in as independent controllers under their own terms and privacy statements, which the organization agreed to when it set up its Google Workspace or Microsoft Entra ID.</p>
      <p>Signing in sets two cookies, both strictly necessary and never used for tracking: <code>__Host-labkiosk_session</code>, which keeps you signed in on the one address that set it for up to seven days (twelve hours for the platform's own administrators), and <code>labkiosk_device</code>, a random identifier for the browser, sent only to the sign-in service. We keep a hash of that identifier with the browser's user-agent string, so that a sign-in from a browser your account has not used before can be reported to you by email (with the time, IP address and browser), and so that a browser you chose to trust can skip the two-factor code for 30 days. If you turn on two-factor sign-in, we store the authenticator-app secret and hashes of your recovery codes, and a code you ask for by email is sent to your account's address. If you add a passkey, we store its public key, the name you give it, its signature counter and when it was last used; the private key never leaves your device.</p>
      <p>We keep a record of each organization's account: its license plan and end date, its workstation limit, its Remote Control approval and seats, the notifications we send to its console and which members of staff dismissed them, its requests for new major releases and its trial workstation group, and any content we took down with the reason. Actions in the console are kept in the organization's audit log.</p>
      <p>To register an organization we also ask for a technical contact's name, email address and phone number, the organization's postal address and, optionally, its legal name, tax identifier and billing email. We use them to verify the request, to decide whether to approve it, to arrange payment where a license requires one, and to reach the organization about its account. The email address is confirmed with a one-time code; the phone number is confirmed by our staff before approval. When an organization accepts our Terms of Service, with the Content Policy and the Data Processing Agreement that are part of them, at registration or later in its console, we keep a record of which version was accepted, by which account, when, and from which IP address and browser, as evidence of the agreement; that record is kept after the organization's account is closed. The contact form confirms your email address with a one-time code before your message is sent. Messages you send to our addresses or through the contact form, with any attachments, and our replies, are kept with your request so the conversation can continue.</p>

      <h2>5. Automatic Bug Reports (Optional)</h2>
      <p>An organization's administrator may turn on Automatic Bug Reports. Only then, the workstation problems listed in Errors &amp; Warnings are sent, with network addresses, host names, e-mail addresses and identifiers masked, to an AI model on Cloudflare Workers AI for triage, and published as issues in a GitHub repository, which may be public. Organization names, workstation names, staff accounts, browsing and screen content are never sent. The <a href="/terms/bug-reports">Automatic Bug Report Terms</a> describe exactly what is sent and how to have a report removed.</p>

      <h2>6. Service Providers</h2>
      <p>The Platform runs on Cloudflare, Inc. ("Cloudflare"), which processes the data described in this policy as our service provider, under the <a href="https://www.cloudflare.com/privacypolicy/">Cloudflare Privacy Policy</a> and the <a href="https://www.cloudflare.com/cloudflare-customer-dpa/">Cloudflare Customer Data Processing Addendum</a>. Cloudflare may process it in its data centers worldwide. The Cloudflare services we use, and what each one handles:</p>
      <ul>
        <li><strong>Cloudflare Workers:</strong> runs the Platform. Every request to the consoles, the User Portal and the workstation interface passes through it, and request logs (including IP addresses) are kept for a sample of about one in ten requests for troubleshooting.</li>
        <li><strong>Cloudflare D1:</strong> the database: organization and staff accounts with hashed passwords, registration details and support conversations, the workstation registry with each workstation's hardware report, usage reports, power schedules and printers, allowlists, User Portal apps, settings, the audit log, and errors and warnings.</li>
        <li><strong>Durable Objects:</strong> each organization's live state: which workstations are connected, the command queue (commands expire after 60 seconds), the screen frames relayed to a watching operator, and the remote-control sessions an operator opens to a workstation, whose screen, keyboard and mouse traffic is passed through and never stored.</li>
        <li><strong>Queues:</strong> audit log entries on their way to the database.</li>
        <li><strong>R2:</strong> audit log entries older than 180 days, archived, the original of every email sent to our addresses, with its attachments, until we delete the conversation, and the signed system images workstations download as updates. A workstation downloading an update sends its IP address to R2, as any download does.</li>
        <li><strong>Workers Analytics Engine:</strong> counts of workstation connections and disconnections per organization.</li>
        <li><strong>Rate Limiting:</strong> counts of requests per IP address in front of sign-in, registration and workstation enrollment.</li>
        <li><strong>Cloudflare Email Service:</strong> sends registration codes, approval decisions and our replies, and receives mail sent to our addresses, which is stored with the conversation it belongs to.</li>
        <li><strong>Workflows and Cloudflare for SaaS:</strong> an organization's custom domain name and its TLS certificate.</li>
        <li><strong>Workers AI:</strong> only for organizations that turned on Automatic Bug Reports, the masked problem reports described in section 5.</li>
        <li><strong>Cloudflare Turnstile:</strong> when we turn it on, checks that the registration, contact and sign-in forms are being used by a person. Cloudflare reads signals from your browser and its IP address to decide, without a tracking cookie, and tells us only whether the check passed.</li>
        <li><strong>Cloudflare Web Analytics:</strong> counts page views and page load times without cookies or a visitor identifier.</li>
        <li><strong>Cloudflare Zaraz:</strong> runs Google Analytics on the public website pages described in section 8, after the visitor consents.</li>
      </ul>
      <p>Other providers are involved:</p>
      <ul>
        <li><strong>GitHub, Inc.:</strong> only for organizations that turned on Automatic Bug Reports, the masked reports are published as GitHub issues under GitHub's own terms and privacy statement.</li>
        <li><strong>Google Fonts:</strong> the consoles and public pages load the Inter and JetBrains Mono typefaces from Google, which receives the visitor's IP address and browser details when the fonts are requested.</li>
        <li><strong>Google Analytics:</strong> only on the public website pages described in section 8, and only after the visitor consents.</li>
      </ul>
      <p>The <a href="/dpa#subprocessors">Data Processing Agreement</a> lists which of these process an organization's data on our behalf. An organization may also choose services that work under their own terms rather than ours: Google or Microsoft for staff sign-in (section 4), and its own printers on its own network (section 3).</p>

      <h2>7. Super Administrator Privacy Restriction</h2>
      <p>Platform Super Administrators are architecturally restricted from accessing individual organization consoles, User Portal configurations, live workstation telemetry and screens. Their privileges are limited to running the platform: approving organizations and their status, licenses and workstation limits, approving or turning off Remote Control, release policy, notifications to organizations, taking down publicly visible content under the <a href="/content-policy">Content Policy</a>, and the platform's own demo organizations used for testing (<code>web-demo</code>, <code>local-demo</code> and <code>docker-demo</code>).</p>
      <p>To see how the Platform is used and which computers it runs on, Super Administrators see only figures that name no organization: for hardware reports, how many workstations report each hardware model across all organizations; for usage reports, platform-wide daily totals (the number of organizations and workstations, total time switched on and in use, and the number of browsing sessions) and the domain names of sites visited by workstations of at least three organizations. A public hardware compatibility list may show hardware models reported by at least three organizations; it never names an organization or a workstation.</p>

      <h2>8. Visitors to This Website</h2>
      <p>The public pages of this website (the home page with its sign-in, registration, download and contact views, and these legal pages, on the platform's own domain) measure how they are used with Google Analytics, provided by Google LLC and run through Cloudflare Zaraz. A banner at the bottom of the home page asks first, and nothing is sent to Google unless you accept; you can change your choice later with Cookie Settings at the foot of the home page. If you accept, Google receives the address and title of each page you open, the page that referred you, your browser, device and screen size, and a random identifier stored in a cookie, and estimates your approximate location from the request. We use the aggregate reports Google makes from this to understand how the website is found and used. It is not used for advertising, and Google signals are not used to build audiences.</p>
      <p>Google Analytics never runs on workstations, the User Portal, organization homepages, organization subdomains or custom domains, or the consoles: the Platform's Content Security Policy blocks it there.</p>

      <h2>9. Where Data Is Stored</h2>
      <p>The Platform runs on Cloudflare's global network. A request is answered by the Cloudflare data center that receives it, which is usually one near the person or workstation making it, and the live state of an organization (its Durable Object) runs in a data center Cloudflare chooses.</p>
      <p>We have not set a location hint or a data jurisdiction for the Platform's D1 database, its Durable Objects or its R2 buckets. The database's primary location was chosen by Cloudflare when it was created, and we do not promise that data stays in any particular country or region. If your organization needs to know more about where its data is kept, or has a requirement for where it must be kept, write to <a href="mailto:privacy@labkiosk.org">privacy@labkiosk.org</a> before relying on the Platform for that data.</p>

      <h2>10. International Transfers</h2>
      <p>Because the Platform runs on Cloudflare's global network, personal data may be processed in countries other than the one where it was collected. For data protected by the GDPR or the UK GDPR, transfers to Cloudflare are covered by the <a href="https://www.cloudflare.com/cloudflare-customer-dpa/">Cloudflare Customer Data Processing Addendum</a> and the Standard Contractual Clauses it incorporates. For data protected by the DPDP Act, section 16 permits transferring it outside India except to a country the Central Government of India restricts by notification; if a country where the Platform's data is processed is ever restricted, we will tell the organizations affected and work with Cloudflare to comply. The <a href="/dpa">Data Processing Agreement</a> describes transfers in more detail.</p>

      <h2>11. How Long We Keep Data</h2>
      <ul>
        <li><strong>Commands</strong> to workstations expire after 60 seconds; <strong>screen frames</strong> and <strong>Remote Control</strong> traffic are never stored.</li>
        <li><strong>Errors and warnings</strong> are deleted after 90 days, and the system log attached to a restart report after 30 days.</li>
        <li><strong>Usage reports</strong> are deleted after 400 days.</li>
        <li><strong>The audit log</strong> stays in the database for 180 days, then is archived in R2.</li>
        <li><strong>A sign-in session</strong> lasts up to seven days, and a trusted browser skips the two-factor code for 30 days.</li>
        <li><strong>Workstation records</strong>, with their hardware report, power schedule and settings, are kept until the organization removes the workstation or its account is closed; <strong>staff accounts</strong> until they are removed or the account is closed.</li>
        <li><strong>The record of accepted legal documents</strong> is kept after the account is closed, as evidence of the agreement, and messages sent to us are kept with the conversation until we delete it.</li>
      </ul>
      <p>When an organization's account is closed, its data is deleted from the Platform as the <a href="/dpa">Data Processing Agreement</a> describes, except the records this section says are kept.</p>

      <h2>12. Children</h2>
      <p>The Platform does not knowingly collect the identity of anyone who uses a workstation: workstations are shared and have no user accounts. Where an organization lets children use its workstations, it decides whether and how their activity is overseen, and it is responsible as controller and Data Fiduciary for any notice and consent the law requires, including the verifiable consent of a parent or lawful guardian under section 9 of the DPDP Act, and for not using the Platform to track or monitor the behavior of a child in a way the law forbids. Usage reports count sites for the organization as a whole and do not record who visited them.</p>

      <h2>13. Your Rights</h2>
      <p>Depending on where you are, the law may give you rights over your personal data, such as the right to access it, to have it corrected, completed, updated or erased, to restrict or object to its processing, to data portability, to withdraw consent, to nominate someone to exercise your rights (DPDP Act), and to have a grievance addressed. In the European Union and the United Kingdom these are the rights in Articles 15 to 22 of the GDPR and the UK GDPR; in India, the rights of a Data Principal in sections 11 to 14 of the DPDP Act.</p>
      <ul>
        <li><strong>If you use an organization's workstations, or are a member of its staff,</strong> the organization is responsible for your data: send your request to it. If you send it to us, we pass it to the organization, and we help the organization answer it.</li>
        <li><strong>For the data we decide about ourselves</strong> (section 1), write to <a href="mailto:privacy@labkiosk.org">privacy@labkiosk.org</a>. We may ask you to confirm who you are before we act on a request.</li>
      </ul>
      <p>You may also complain to the data protection authority where you live or work: in the European Union, your national supervisory authority; in the United Kingdom, the Information Commissioner's Office; in India, the Data Protection Board of India, once you have first raised the grievance with the Data Fiduciary as the DPDP Act requires.</p>

      <h2>14. Security and Personal Data Breaches</h2>
      <p>We protect the Platform as the <a href="/dpa">Data Processing Agreement</a> describes: each organization's data is logically separated from every other's, passwords are hashed, administrators always confirm sign-in with a second factor and other staff can turn it on, and our own administrators cannot open an organization's console or see its workstations. If we become aware of a personal data breach affecting an organization's data, we tell the organization without undue delay, with what we know, so that it can meet its own duties, such as notifying the supervisory authority under the GDPR or the Data Protection Board of India and the people affected under the DPDP Act. For the data we decide about ourselves, we notify the authorities and people concerned as the law requires.</p>

      <h2>15. Contact Us and Grievances</h2>
      <p>If you have questions about our privacy practices or data protection, a request about your data, or a grievance about how we handle it, please contact our data protection team at <a href="mailto:privacy@labkiosk.org">privacy@labkiosk.org</a>. This address is also the contact for questions about data residency and the <a href="/dpa">Data Processing Agreement</a>.</p>
    </div>
  </main>
`
  });
}

export function renderTermsOfServiceHtml(options: LegalPageOptions = {}): string {
  return renderLegalShell({
    title: "Terms of Service - Lab Kiosk OS",
    description: "The terms for using Lab Kiosk OS: licensing and the 45-computer threshold, the subscriber license, Remote Control, hosted content, personal data and the Data Processing Agreement, updates, and liability.",
    canonicalUrl: options.canonicalUrl,
    current: "/terms",
    mainHtml: `
  <main>
    <div class="legal-card">
      <h1>Terms of Service</h1>
      <div class="updated-date">Last updated: October 20, 2026 &bull; Version 2026-10-20</div>

      <div class="highlight-box">
        <strong>In short</strong>
        These Terms are the agreement between Lab Kiosk OS and the organization that uses it. The <a href="/content-policy">Content Policy</a> and the <a href="/dpa">Data Processing Agreement</a> are part of them. Lab Kiosk OS is free only for accredited educational institutions and non-commercial evaluation on up to 45 computers; every other organization needs a commercial or subscriber license.
      </div>

      <h2>1. Who These Terms Are Between</h2>
      <p>Lab Kiosk OS ("Platform", "we", "us", "our") is operated by Akbhoi Innovations. These Terms of Service ("Terms") govern your organization's use of the Platform: the hosted control plane at labkiosk.org and its subdomains, the consoles, the User Portal, organization homepages, the workstation software and the over-the-air updates we publish. "You" means the organization that registered, whether a company, public body, library, school or other institution.</p>
      <p>By registering an organization, enrolling a workstation, or accepting these Terms in a console, you agree to them. The person who accepts confirms that they have authority to bind the organization. If you do not agree, do not use the Platform.</p>
      <p>These Terms include the <a href="/content-policy">Content Policy</a> and the <a href="/dpa">Data Processing Agreement</a>, so accepting these Terms accepts both. The <a href="/privacy">Privacy Policy</a> explains how we handle personal data. The <a href="/terms/bug-reports">Automatic Bug Report Terms</a> apply as well once an administrator of your organization accepts them.</p>

      <h2>2. Definitions</h2>
      <ul>
        <li><strong>Staff:</strong> the people your organization gives a console account: its owner, administrators, sub-administrators, operators, assistants and content managers.</li>
        <li><strong>Users:</strong> the people who use your workstations. Users have no account on the Platform.</li>
        <li><strong>Workstation:</strong> a computer running Lab Kiosk OS that is enrolled in your organization.</li>
        <li><strong>Organization Data:</strong> the personal data the Platform processes on your behalf: about your workstations and their use, your users and your staff, as the <a href="/dpa">Data Processing Agreement</a> lists it.</li>
        <li><strong>Hosted Content:</strong> anything your staff publish through the Platform: your organization's name, subdomain and custom domain, its homepage, User Portal cards and their links and images, and the addresses you allow on or send to workstations.</li>
      </ul>

      <h2>3. Registration and Accounts</h2>
      <p>You agree to give accurate registration details and to keep them current. We review each registration and may approve or decline it at our discretion. Your organization's owner is responsible for the account and for every action taken by its staff.</p>
      <p>You must keep passwords, recovery codes and your enrollment key confidential, give staff only the permissions they need, and tell us at once at <a href="mailto:security@labkiosk.org">security@labkiosk.org</a> if you suspect that any of them has been compromised. We recommend two-factor sign-in for every staff account.</p>

      <h2>4. Licensing</h2>
      <p>The workstation software and the control plane are source-available under the LabKiosk Software License (the <code>LICENSE</code> file in the source repository). In summary, and subject to that license's full text:</p>
      <ul>
        <li><strong>Free use</strong> is limited to accredited, non-profit educational institutions for their own instruction and lab management, and to personal, non-commercial evaluation and research outside production, in each case on no more than <strong>45 computers</strong>.</li>
        <li><strong>45-computer threshold:</strong> any deployment by anyone, educational and non-profit organizations included, on more than 45 computers is commercial use and needs a paid commercial license or an active subscriber license.</li>
        <li><strong>Every other organization</strong>, including businesses and for-profit training centers, needs a commercial license or an active subscriber license, whatever the number of computers.</li>
        <li>You may not resell, sublicense, white-label or offer the software as a hosted or managed service.</li>
      </ul>
      <p>We record the license your organization holds (education, evaluation, subscriber or commercial) and its end date. When a license end date passes, new workstations can no longer be enrolled and Remote Control stops until the license is renewed; workstations already enrolled keep working. Your organization may enroll up to the number of workstations its account allows, which is 45 unless we set a different limit for your license. To ask for a license or a higher limit, write to <a href="mailto:legal@labkiosk.org">legal@labkiosk.org</a>.</p>

      <h2>5. Subscriber License</h2>
      <p>This section is the Subscriber License the LabKiosk Software License refers to. While your organization holds an active subscription, we grant it a non-exclusive, non-transferable right to use the hosted control plane for its own workstations, up to its workstation limit, for the subscription term. Fees, the term and any service commitments are those in the order, quote or invoice we agree with you in writing; if that document conflicts with these Terms, that document prevails for the subscription. The subscription ends at the end of its term unless renewed, and does not allow you to provide the Platform to others as a service.</p>

      <h2>6. Using the Platform Responsibly</h2>
      <p>Your organization decides how its workstations are used, and is responsible for that use. In particular, you agree to:</p>
      <ul>
        <li>use the Platform only for lawful purposes and in line with your own policies;</li>
        <li>tell users that the workstations are managed, that operators can see which page each one shows and a live picture of its screen, that the Platform records how long each workstation is in use and, unless you turn it off, which sites your workstations visit, and, where you use Remote Control, that an administrator can take control of it;</li>
        <li>obtain any consent and give any notice the law requires for your users, including parental or guardian consent and the duties that apply where users are children or students;</li>
        <li>keep the addresses you allow on workstations suitable for your users, and supervise their use;</li>
        <li>follow the <a href="/content-policy">Content Policy</a> for everything your staff publish.</li>
      </ul>

      <h2>7. Remote Control</h2>
      <p>Remote Control lets an administrator of your organization see and operate a workstation's screen, keyboard and mouse from the console. It is available only after we approve your organization's request, only to the organization's owner and administrators, never to other staff, and only for as many sessions at once as your seats allow. The session passes through the Platform and is never recorded. You must use Remote Control only to support your users and manage your workstations, and in line with section 6. We may turn Remote Control off for your organization, ending any open session, if it is misused, if your license ends, or if security requires it; we tell you in your console when we do.</p>

      <h2>8. Hosted Content</h2>
      <p>You are responsible for your Hosted Content and must have the right to publish it. You grant us a worldwide, non-exclusive, royalty-free license to host, copy, display and transmit it only as needed to run the Platform for you. Hosted Content must follow the <a href="/content-policy">Content Policy</a>. We may refuse a link, take down your homepage or a User Portal card, or block a domain as the Content Policy describes, and we tell you in your console with the reason. To contest a decision, write to <a href="mailto:legal@labkiosk.org">legal@labkiosk.org</a>.</p>

      <h2>9. Prohibited Uses</h2>
      <p>You must not, and must not let anyone else:</p>
      <ul>
        <li>probe, scan or test the Platform's security, or circumvent its access controls, rate limits or the workstation lockdown, except through a responsible disclosure to <a href="mailto:security@labkiosk.org">security@labkiosk.org</a>;</li>
        <li>overload or disrupt the Platform, or access it by automated means other than the interfaces it documents;</li>
        <li>use the Platform to distribute malware, collect credentials, send spam or carry out any unlawful surveillance;</li>
        <li>impersonate another organization or person, or register a subdomain or connect a custom domain you have no right to use;</li>
        <li>copy, resell, sublicense or provide the Platform to third parties, or use it beyond what your license allows.</li>
      </ul>

      <h2>10. Updates and Supported Releases</h2>
      <p>We publish system updates over the air. Security updates for the release a workstation runs install at its next restart, unless your organization has chosen to approve them first; other releases install only when your staff choose. A new major release reaches your workstations only after it is available to your organization and an administrator confirms it, first for a workstation group if they choose.</p>
      <p>Each major release (such as 3.x, covering every 3.x release) is supported, receives security fixes only, or has reached end of life. We announce an end-of-life date in advance, in your console and by email to your organization's owner, and remind you as it approaches. A major release at end of life receives no further updates, security fixes included; keeping workstations on a supported major release is your responsibility.</p>

      <h2>11. Notices</h2>
      <p>We send notices about your account, licenses, releases, legal documents and content decisions to your console, where they stay until each member of staff dismisses them, and by email to the address of your organization's owner. A notice is given when it is shown in your console or sent to that address. You send notices to us at <a href="mailto:legal@labkiosk.org">legal@labkiosk.org</a>.</p>

      <h2>12. Personal Data</h2>
      <p>The <a href="/privacy">Privacy Policy</a> describes the personal data the Platform handles. For Organization Data, your organization is the controller under the GDPR and the UK GDPR and the Data Fiduciary under India's Digital Personal Data Protection Act, 2023, and we are its processor: we process Organization Data only on your behalf, to provide the Platform, as the <a href="/dpa">Data Processing Agreement</a> sets out. Our platform administrators cannot open your consoles or see your workstations' screens or telemetry.</p>
      <p>You are responsible for having a lawful basis for the processing you ask of us, and for the notices and consents section 6 requires. The features that process more data are under your control: you can turn off the recording of sites in usage reports; printing, and staff sign-in with Google or Microsoft, are off until you turn them on; and power schedules apply only when you set them.</p>
      <p><strong>Anonymous statistics.</strong> You allow us to combine hardware reports and usage reports from every organization into statistics that identify no organization, workstation or person, and to use them to run and improve the Platform. We may publish a hardware compatibility list built from them, which shows only hardware models reported by at least three organizations and never names an organization or a workstation.</p>

      <h2>13. Third-Party Services</h2>
      <p>The Platform is hosted on Cloudflare and relies on the Cloudflare services listed in section 6 of the <a href="/privacy">Privacy Policy</a>, which Cloudflare provides under the <a href="https://www.cloudflare.com/privacypolicy/">Cloudflare Privacy Policy</a> and the <a href="https://www.cloudflare.com/cloudflare-customer-dpa/">Cloudflare Customer Data Processing Addendum</a>. Websites your workstations open are provided by their own operators under their own terms; we are not responsible for them. Automatic Bug Reports are optional and governed by the <a href="/terms/bug-reports">Automatic Bug Report Terms</a>.</p>
      <p>If your organization lets its staff sign in with Google Workspace or Microsoft Entra ID, Google or Microsoft provides that sign-in under the terms your organization has with it, as an independent service and not on our behalf. If you turn on printing, workstations print to the printers you name, on your own network; you are responsible for those printers and for what is printed on them. Wake-on-LAN packets are sent by your own workstations on your own network; you are responsible for allowing them there.</p>

      <h2>14. Suspension and Termination</h2>
      <p>We may suspend or close your organization's account, or any feature of it, if you breach these Terms or your license, do not pay fees that are due, or if needed to protect the Platform, its users or the law; where we can, we tell you first and give you a chance to fix the problem. You may close your account at any time by writing to <a href="mailto:legal@labkiosk.org">legal@labkiosk.org</a>. When an account is closed, its workstations stop receiving configuration and updates from the Platform, and we delete Organization Data as the <a href="/dpa">Data Processing Agreement</a> describes. We keep the record of the legal documents your organization accepted, and the archived audit log, as the <a href="/privacy">Privacy Policy</a> describes. Sections 4, 8, 15, 16 and 17 survive termination, and the Data Processing Agreement continues to apply for as long as we hold any Organization Data.</p>

      <h2>15. Disclaimer</h2>
      <p>To the extent the law allows, the Platform and the software are provided "as is" and "as available", without warranties of any kind, express or implied, including merchantability, fitness for a particular purpose and non-infringement. We do not warrant that the Platform will be uninterrupted or error-free, or that it will block every unwanted site or action on a workstation.</p>

      <h2>16. Limitation of Liability</h2>
      <p>To the extent the law allows, we are not liable for any indirect, incidental, special, consequential or punitive damages, or for loss of data, profits, revenue or business, however caused. Our total liability for all claims relating to the Platform is limited to the fees your organization paid us for it in the twelve months before the event giving rise to the claim. Nothing in these Terms limits liability that cannot be limited by law.</p>

      <h2>17. Indemnity</h2>
      <p>You will defend and indemnify us against claims by third parties arising from your Hosted Content, from your use of the Platform in breach of these Terms or the law, or from your failure to obtain the notices and consents section 6 requires.</p>

      <h2>18. Changes to These Terms</h2>
      <p>When we change these Terms, the Content Policy or the Data Processing Agreement, we publish a new version with a new date at the top, and your console asks an administrator of your organization to accept it. After 30 days the console asks before anything else until the new version is accepted. Your workstations, homepage and User Portal keep working in the meantime. We keep a record of which version your organization accepted, by whom and when.</p>

      <h2>19. Contact</h2>
      <p>Legal notices and licensing: <a href="mailto:legal@labkiosk.org">legal@labkiosk.org</a>. Security reports: <a href="mailto:security@labkiosk.org">security@labkiosk.org</a>. Privacy: <a href="mailto:privacy@labkiosk.org">privacy@labkiosk.org</a>.</p>
    </div>
  </main>
`
  });
}

/**
 * The Data Processing Agreement: the terms on which the platform processes an
 * organization's personal data as its processor (GDPR, UK GDPR) and Data
 * Processor (India's DPDP Act), with the subprocessor list. It is part of the
 * Terms of Service, not a document of its own in src/legal.ts: accepting the
 * Terms accepts it, so a change to this text is a new Terms version.
 */
export function renderDataProcessingAgreementHtml(options: LegalPageOptions = {}): string {
  return renderLegalShell({
    title: "Data Processing Agreement - Lab Kiosk OS",
    description: "How Lab Kiosk OS processes an organization's personal data as its processor under the GDPR, the UK GDPR and India's DPDP Act: instructions, security, breaches, transfers, data residency, deletion and subprocessors.",
    canonicalUrl: options.canonicalUrl,
    current: "/dpa",
    mainHtml: `
  <main>
    <div class="legal-card">
      <h1>Data Processing Agreement</h1>
      <div class="updated-date">Last updated: October 20, 2026 &bull; Part of the Terms of Service, Version 2026-10-20</div>

      <div class="highlight-box">
        <strong>Part of the Terms of Service</strong>
        This agreement sets the terms on which Lab Kiosk OS processes personal data for the organizations that use it. It is part of the <a href="/terms">Terms of Service</a>: an organization that accepts the Terms accepts this agreement, and nothing else needs to be signed.
      </div>

      <h2>1. Parties and Scope</h2>
      <p>This Data Processing Agreement ("DPA") is between the organization that accepted the <a href="/terms">Terms of Service</a> ("you") and Akbhoi Innovations, which operates Lab Kiosk OS ("we", "us"). It applies to the personal data we process on your behalf to provide the Platform ("Organization Data"), wherever the law that protects that data applies, and in particular the EU General Data Protection Regulation (GDPR), the UK GDPR and Data Protection Act 2018, and India's Digital Personal Data Protection Act, 2023 and the rules made under it (DPDP Act). Words such as controller, processor, personal data breach, Data Fiduciary, Data Processor and Data Principal have the meaning those laws give them. Where this DPA and the rest of the Terms differ on personal data, this DPA applies.</p>

      <h2>2. Roles</h2>
      <ul>
        <li><strong>Organization Data.</strong> You are the controller and the Data Fiduciary; we are your processor and Data Processor.</li>
        <li><strong>Our own data.</strong> For registration and account records, billing, the record of accepted legal documents, messages sent to us, the security of the Platform and the analytics on our own website, we decide why and how the data is processed, and we are the controller and Data Fiduciary, as the <a href="/privacy">Privacy Policy</a> describes. This DPA does not apply to that data.</li>
        <li><strong>Services you choose.</strong> If you let staff sign in with Google Workspace or Microsoft Entra ID, Google or Microsoft acts as an independent controller under the terms you have with it, not as our subprocessor. Your printers and your network are yours.</li>
      </ul>

      <h2>3. Details of the Processing</h2>
      <ul>
        <li><strong>Subject matter and duration:</strong> providing the Platform to you, for as long as the Terms apply and then until the data is deleted under section 11.</li>
        <li><strong>Nature and purpose:</strong> hosting, storing, relaying and displaying data so that your staff can manage your workstations and what they show; sending and receiving the email the Platform needs; keeping the Platform secure.</li>
        <li><strong>Data subjects:</strong> people who use your workstations; your staff; people your staff name in Hosted Content.</li>
        <li><strong>Categories of personal data:</strong> workstation identifiers (hostname, internal IP address, connection times); the page each workstation shows and live screen frames, which are relayed and never stored; Remote Control traffic, which is relayed and never recorded; errors and warnings a workstation reports, with system logs; hardware reports (system manufacturer and model, processor, memory, boot mode, whether a keyboard and a touchscreen are attached, and the MAC addresses of wired network adapters); usage reports (time switched on and in use and browsing sessions per workstation per day, and the domain names of sites visited by the organization as a whole, with time in use and visit counts, unless you turn site recording off); power schedules; printer names and network addresses; staff accounts (name, email address, role, permissions, hashed password, two-factor settings, sign-in records and, where you use Google or Microsoft sign-in, the identifiers needed to match the account); the audit log of what staff did; Hosted Content.</li>
        <li><strong>Special categories:</strong> the Platform is not designed to process special categories of personal data, data about criminal convictions, or government identity numbers, and you should not put them in Hosted Content or settings. A live screen frame shows whatever is on the screen at that moment.</li>
      </ul>

      <h2>4. Your Instructions</h2>
      <p>We process Organization Data only on your documented instructions, which are the Terms, this DPA and the settings and actions your staff choose in the console, unless the law requires otherwise; in that case we tell you first unless the law forbids it. If we believe an instruction breaks data protection law, we tell you. We do not sell Organization Data, use it for advertising, or use it for our own purposes, except to combine it into anonymous statistics that identify no organization, workstation or person, as section 12 of the Terms allows.</p>

      <h2>5. Confidentiality</h2>
      <p>Only the people who need access to run the Platform have it, and they are bound to keep Organization Data confidential. Our platform administrators cannot open your console or see your workstations' screens or telemetry; they see only figures that name no organization.</p>

      <h2>6. Security</h2>
      <p>We take technical and organizational measures appropriate to the risk, including:</p>
      <ul>
        <li>every request to the Platform is served over HTTPS, with HTTP Strict Transport Security;</li>
        <li>each organization's data is logically separated from every other organization's, and every request for it is checked against the organization it belongs to;</li>
        <li>passwords are hashed with PBKDF2-HMAC-SHA256 (100,000 iterations), workstation tokens are stored only as hashes, administrators always confirm sign-in with a second factor (an emailed code, an authenticator app or a passkey), and other staff can turn it on;</li>
        <li>staff have only the permissions their organization gives them, and what they do is recorded in the organization's audit log;</li>
        <li>requests to sign in, register and enroll workstations are rate limited;</li>
        <li>workstations keep browsing data only in memory, which is erased when they restart, and install only signed system images.</li>
      </ul>
      <p>You are responsible for the security of your staff accounts, enrollment key and workstations, and of your own network and printers, as section 3 of the Terms describes.</p>

      <h2>7. Subprocessors</h2>
      <p>You authorize us to engage the subprocessors listed in section 15. Cloudflare processes Organization Data under the Cloudflare Customer Data Processing Addendum, which binds it to data protection obligations for that data. GitHub receives only masked bug reports, designed to contain no personal data, and only from organizations that turn them on. We remain responsible to you for our subprocessors as data protection law requires. Before a new subprocessor processes Organization Data, we update the list and tell you in your console and by email to your organization's owner at least 30 days in advance, unless a change is needed sooner to keep the Platform secure or running, in which case we tell you as soon as we can. You may object on reasonable data protection grounds by writing to <a href="mailto:privacy@labkiosk.org">privacy@labkiosk.org</a>; if we cannot resolve the objection, you may close your account before the change takes effect.</p>

      <h2>8. Data Residency and International Transfers</h2>
      <p>The Platform runs on Cloudflare's global network: a request is answered by the Cloudflare data center that receives it, and an organization's live state runs in a data center Cloudflare chooses. We have not set a location hint or a data jurisdiction for the Platform's D1 database, its Durable Objects or its R2 buckets; the database's primary location was chosen by Cloudflare when it was created. We therefore do not commit to keeping Organization Data in any particular country or region. If you have a residency requirement, write to <a href="mailto:privacy@labkiosk.org">privacy@labkiosk.org</a> before relying on the Platform for that data.</p>
      <ul>
        <li><strong>GDPR and UK GDPR.</strong> Transfers to Cloudflare are made under the <a href="https://www.cloudflare.com/cloudflare-customer-dpa/">Cloudflare Customer Data Processing Addendum</a> and the Standard Contractual Clauses it incorporates. If your organization needs Standard Contractual Clauses with us for its transfer of Organization Data to us, write to <a href="mailto:privacy@labkiosk.org">privacy@labkiosk.org</a>.</li>
        <li><strong>DPDP Act.</strong> Section 16 permits transferring personal data outside India except to a country the Central Government of India restricts by notification. If a country where Organization Data is processed is ever restricted, we will tell you and work with Cloudflare to comply.</li>
      </ul>

      <h2>9. Helping You Meet Your Duties</h2>
      <p>Taking into account the nature of the processing and the information we have, we help you:</p>
      <ul>
        <li>answer requests from people exercising their rights (Articles 15 to 22 of the GDPR and the UK GDPR; sections 11 to 14 of the DPDP Act). Most can be answered in the console, where your staff can see, change and remove workstations, staff accounts and settings, and turn site recording off. If a request reaches us, we pass it to you without answering it ourselves, unless you ask us to;</li>
        <li>keep the Platform secure, and handle personal data breaches as section 10 describes;</li>
        <li>carry out a data protection impact assessment or consult a supervisory authority where Articles 35 and 36 of the GDPR require it, and meet the additional duties of a Significant Data Fiduciary under section 10 of the DPDP Act if your organization is notified as one;</li>
        <li>erase personal data when consent is withdrawn or the purpose has been served, as section 8(7) of the DPDP Act requires: Organization Data your staff remove in the console is deleted from the Platform's database, except the entries of the audit log, which are kept as the <a href="/privacy">Privacy Policy</a> describes, and section 11 covers the end of this agreement.</li>
      </ul>

      <h2>10. Personal Data Breaches</h2>
      <p>If we become aware of a personal data breach affecting Organization Data, we notify your organization's owner by email, and in your console, without undue delay. We tell you what we know, as it becomes available: what happened, the categories and approximate number of people and records concerned, the likely consequences, and what we have done or propose to do. We take reasonable steps to contain the breach and limit its effects.</p>
      <p>Notifying the authorities and the people affected is your duty as controller and Data Fiduciary: under Articles 33 and 34 of the GDPR and the UK GDPR, and, under section 8(6) of the DPDP Act, notifying the Data Protection Board of India and each Data Principal affected. We give you the information and help you need to do so. Our notice of a breach is not an admission of fault.</p>

      <h2>11. Deletion at the End</h2>
      <p>When your organization's account is closed, we delete Organization Data from the Platform's database, which removes its workstations with their hardware and usage reports, its staff accounts, its settings and its Hosted Content. If you want Organization Data returned rather than deleted, ask before the account is closed and we will give you a copy in a common machine-readable format. We keep only what the law requires us to keep, the record of the legal documents your organization accepted, and the archived audit log, as the <a href="/privacy">Privacy Policy</a> describes; this DPA continues to protect anything we keep. Copies in Cloudflare's backups expire under Cloudflare's own retention.</p>

      <h2>12. Demonstrating Compliance</h2>
      <p>We make available to you the information reasonably needed to show that we meet this DPA and Article 28 of the GDPR, by answering your written questions sent to <a href="mailto:privacy@labkiosk.org">privacy@labkiosk.org</a>. Where that is not enough, and a supervisory authority requires it or there are reasonable grounds to believe we are in breach of this DPA, you or an auditor you appoint who is bound to confidentiality may audit our compliance, on reasonable notice, at a time agreed with us, at your own cost and without access to other organizations' data. For Cloudflare, we rely on the information Cloudflare makes available about its own compliance.</p>

      <h2>13. Liability</h2>
      <p>Each party's liability under this DPA is subject to the limits in the <a href="/terms">Terms of Service</a>, to the extent the law allows. Nothing in this DPA limits a person's rights under data protection law.</p>

      <h2>14. Changes and Contact</h2>
      <p>This DPA changes with the Terms of Service: a change to it is a new version of the Terms, which your console asks an administrator to accept, as section 18 of the <a href="/terms">Terms of Service</a> describes. Questions about this DPA, data residency, subprocessors or a personal data breach: <a href="mailto:privacy@labkiosk.org">privacy@labkiosk.org</a>. Security reports: <a href="mailto:security@labkiosk.org">security@labkiosk.org</a>.</p>

      <h2 id="subprocessors">15. Subprocessors</h2>
      <p>These subprocessors may process Organization Data on our behalf:</p>
      <ul>
        <li><strong>Cloudflare, Inc.</strong> (United States; its data centers worldwide): hosting and running the Platform with Cloudflare Workers, D1, Durable Objects, Queues, R2, Workers Analytics Engine, Rate Limiting, Cloudflare Email Service, Workflows and Cloudflare for SaaS, and Workers AI for organizations that turn on Automatic Bug Reports. Under the <a href="https://www.cloudflare.com/cloudflare-customer-dpa/">Cloudflare Customer Data Processing Addendum</a>. The <a href="/privacy">Privacy Policy</a> says what each service handles.</li>
        <li><strong>GitHub, Inc.</strong> (United States): only for organizations that turn on Automatic Bug Reports, the reports of workstation problems, with addresses, host names and identifiers masked and no organization or workstation name, are published as GitHub issues, as the <a href="/terms/bug-reports">Automatic Bug Report Terms</a> describe.</li>
      </ul>
      <p>These receive data under their own terms and are not our subprocessors:</p>
      <ul>
        <li><strong>Google and Microsoft</strong>, when your organization turns on staff sign-in with Google Workspace or Microsoft Entra ID and a member of staff uses it: the sign-in request, and the person's email address, name, account identifier and Google Workspace domain or Microsoft tenant.</li>
        <li><strong>Google Fonts</strong>: the consoles, the User Portal and the organization homepage load their typefaces from Google, which receives the IP address and browser details of the device that opens them.</li>
        <li><strong>Your printers</strong>, when you turn printing on: print jobs go from your workstations to the printers you name on your own network, without passing through the Platform.</li>
      </ul>
    </div>
  </main>
`
  });
}

/**
 * The Content Policy: what an organization may publish and send to people
 * through the platform. It is part of the Terms of Service and versioned with
 * them (src/legal.ts); src/link_rules.ts enforces its rules for links.
 */
export function renderContentPolicyHtml(options: LegalPageOptions = {}): string {
  return renderLegalShell({
    title: "Content Policy - Lab Kiosk OS",
    description: "What organizations may publish on their homepage and User Portal and send to workstations, the rules for links, and how content is reported and taken down.",
    canonicalUrl: options.canonicalUrl,
    current: "/content-policy",
    mainHtml: `
  <main>
    <div class="legal-card">
      <h1>Content Policy</h1>
      <div class="updated-date">Last updated: October 13, 2026 &bull; Version 2026-10-13</div>

      <div class="highlight-box">
        <strong>Part of the Terms of Service</strong>
        This policy sets what organizations may publish and send to people through Lab Kiosk OS. It is part of the <a href="/terms">Terms of Service</a>, which each organization accepts.
      </div>

      <h2>1. What This Policy Covers</h2>
      <p>This policy applies to everything an organization's staff publish or direct people to through the Platform ("Hosted Content"):</p>
      <ul>
        <li>the organization's name, its subdomain and any custom domain connected to it;</li>
        <li>its homepage: headline, introduction, blocks, links and images;</li>
        <li>its User Portal: each card's name, address and image;</li>
        <li>the addresses it allows on its workstations, and the pages it sends to them.</li>
      </ul>
      <p>The organization is responsible for its Hosted Content, and for checking that the sites it links to or allows are suitable for its users, including age-appropriate where users are children.</p>

      <h2>2. Content That Is Not Allowed</h2>
      <p>Hosted Content must not contain, link to or send workstations to:</p>
      <ul>
        <li><strong>Child sexual abuse material</strong>, or anything that sexualizes minors. We remove it at once, close the account and report it to the authorities.</li>
        <li><strong>Illegal content</strong>, or content that promotes or facilitates illegal activity in the place it is published or viewed.</li>
        <li><strong>Sexually explicit or pornographic material.</strong></li>
        <li><strong>Violence and hate:</strong> threats, incitement to violence, glorification of terrorism or violent extremism, or attacks on people for their race, ethnicity, national origin, religion, caste, sex, gender identity, sexual orientation, age or disability.</li>
        <li><strong>Harassment</strong> of an individual, or publication of someone's private information without a lawful basis.</li>
        <li><strong>Self-harm:</strong> content that encourages suicide, self-harm or eating disorders.</li>
        <li><strong>Malware and deception:</strong> malicious software, phishing, pages that collect passwords or payment details under false pretences, or pages that imitate another organization, a person, or Lab Kiosk OS itself.</li>
        <li><strong>Infringement:</strong> material that infringes copyright, trademarks or other rights, including names and logos the organization has no right to use.</li>
        <li><strong>Spam and fraud:</strong> unsolicited advertising, scams, or misleading claims.</li>
      </ul>

      <h2>3. Rules for Links</h2>
      <p>A link must show where it goes. The Platform refuses, when it is saved, a homepage or User Portal link that:</p>
      <ul>
        <li>is not an <code>http</code> or <code>https</code> address;</li>
        <li>points to a bare IP address instead of a domain name;</li>
        <li>goes through a link shortener;</li>
        <li>contains a user name or password;</li>
        <li>points to a domain, or a subdomain of a domain, on the Platform's blocklist.</li>
      </ul>
      <p>We add a domain to the blocklist when it hosts content this policy does not allow, such as malware or phishing.</p>

      <h2>4. Reporting Content</h2>
      <p>Every organization homepage and User Portal has a <strong>Report this page</strong> link. You can also write to <a href="mailto:abuse@labkiosk.org">abuse@labkiosk.org</a>, naming the address of the page and what is wrong with it. We review every report. If you are reporting an infringement of your rights, tell us which work or mark is infringed and how to reach you.</p>

      <h2>5. What We Do</h2>
      <p>When Hosted Content breaks this policy, we may:</p>
      <ul>
        <li>take down the organization's homepage or a User Portal card, which then shows to visitors as taken down;</li>
        <li>add a domain to the blocklist, which stops new links to it on every organization;</li>
        <li>suspend Remote Control or the organization's account under the <a href="/terms">Terms of Service</a>.</li>
      </ul>
      <p>We tell the organization in its console, and by email to its owner, what we took down and why. We act at once on content that is illegal or puts people at risk; otherwise we may first ask the organization to fix it. Taking content down never stops its workstations: they keep working.</p>

      <h2>6. Contesting a Decision</h2>
      <p>If you think we took something down by mistake, write to <a href="mailto:legal@labkiosk.org">legal@labkiosk.org</a> or reply to our email, explaining why. We review the decision and restore the content if it does not break this policy, and tell you either way.</p>

      <h2>7. Changes to This Policy</h2>
      <p>When we change this policy, we publish a new version with a new date at the top, and each organization's console asks an administrator to accept it, as section 18 of the <a href="/terms">Terms of Service</a> describes.</p>
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
    current: "/terms/bug-reports",
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
      <p>The masking is done by software before anything leaves the Platform. We designed it to remove identifying details, but no automatic filter can be guaranteed to catch everything. If you find a detail in a published report that identifies your organization or a person, write to <a href="mailto:legal@labkiosk.org">legal@labkiosk.org</a> with a link to the report and we will edit or remove it.</p>

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
      <p>For questions about these terms, contact <a href="mailto:legal@labkiosk.org">legal@labkiosk.org</a>.</p>
    </div>
  </main>
`
  });
}
