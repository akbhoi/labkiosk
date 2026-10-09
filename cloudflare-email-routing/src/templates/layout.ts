/**
 * The one scaffold every email the platform sends is built on: a header with
 * the wordmark and what kind of message this is, a title, the body, and a
 * footer that says who sent it, where answers go and why it arrived.
 *
 * Email clients are not browsers. So: tables for layout, every style inline,
 * no images (most clients block them until asked, and a letter that needs
 * them looks broken), no scripts, and a width of 600px. A small `<style>`
 * block adds the dark theme and the phone layout where a client honours one;
 * the message reads correctly without it.
 *
 * Everything a template is handed is text a person typed (a name, a subject,
 * a reply), so every value goes through `esc()` on the way in, and a link is
 * written only for an http(s) address (`safeUrl()`).
 */

/** Who the mail is from, for the header and footer. */
export interface Brand {
  /** "Lab Kiosk". */
  name: string;
  /** The platform's site, e.g. `https://labkiosk.org`; null leaves the link out. */
  siteUrl: string | null;
  /** The address answers go to; null leaves it out. */
  replyAddress: string | null;
}

/** The colours of the light theme, inline in every element. The dark theme is in `STYLE`. */
export const COLOR = {
  page: "#f3f5f9",
  card: "#ffffff",
  border: "#e3e8ef",
  text: "#1f2937",
  heading: "#0f172a",
  muted: "#64748b",
  accent: "#2563eb",
  accentSoft: "#eff4ff",
  accentBorder: "#c7d7fe",
  success: "#15803d",
  successSoft: "#ecfdf3",
  successBorder: "#bbf7d0",
  warning: "#b45309",
  warningSoft: "#fffbeb",
  warningBorder: "#fde68a",
  neutralSoft: "#f8fafc"
} as const;

export const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
export const MONO = "'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace";

const STYLE = `
  body { margin: 0; padding: 0; width: 100% !important; -webkit-text-size-adjust: 100%; -ms-text-size-adjust: 100%; }
  table { border-collapse: collapse; }
  a { color: ${COLOR.accent}; }
  @media (max-width: 620px) {
    .lk-card { width: 100% !important; border-radius: 0 !important; }
    .lk-pad { padding-left: 20px !important; padding-right: 20px !important; }
    .lk-kind { display: none !important; }
  }
  @media (prefers-color-scheme: dark) {
    .lk-page { background: #0b1120 !important; }
    .lk-card { background: #111827 !important; border-color: #1f2937 !important; }
    .lk-text, .lk-text p, .lk-text td { color: #e5e7eb !important; }
    .lk-heading { color: #f8fafc !important; }
    .lk-muted, .lk-muted a { color: #94a3b8 !important; }
    .lk-rule { border-color: #1f2937 !important; }
    .lk-panel { background: #172036 !important; border-color: #263354 !important; }
    .lk-panel-neutral { background: #0f172a !important; border-color: #1f2937 !important; }
    .lk-panel-success { background: #0f2a1c !important; border-color: #14532d !important; }
    .lk-panel-warning { background: #2a1f0a !important; border-color: #713f12 !important; }
    .lk-code { color: #f8fafc !important; }
    a { color: #93b4ff !important; }
  }
`;

/** Text for an HTML element or a quoted attribute. */
export function esc(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** An http(s) address as written, or null: nothing else is ever made a link. */
export function safeUrl(value: unknown): string | null {
  const text = String(value ?? "").trim();
  if (!text || text.length > 2000 || /[\s<>"'`]/.test(text)) return null;
  try {
    const url = new URL(text);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

/** One line of text, its http(s) addresses made links. */
function line(text: string): string {
  let out = "";
  let rest = text;
  for (;;) {
    const at = rest.search(/https?:\/\//);
    if (at < 0) return out + esc(rest);
    let end = at;
    while (end < rest.length && !/[\s<>"]/.test(rest[end])) end++;
    // A full stop or a bracket after an address belongs to the sentence.
    while (end > at && /[.,;:!?)\]]/.test(rest[end - 1])) end--;
    const url = safeUrl(rest.slice(at, end));
    out += esc(rest.slice(0, at)) + (url ? `<a href="${esc(url)}" style="color:${COLOR.accent};text-decoration:underline">${esc(rest.slice(at, end))}</a>` : esc(rest.slice(at, end)));
    rest = rest.slice(end);
  }
}

/** Plain text as paragraphs: a blank line starts a new one, a line break is kept. */
export function paragraphs(text: string, style = ""): string {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p style="margin:0 0 16px;${style}">${p.split("\n").map(line).join("<br>")}</p>`)
    .join("");
}

type Tone = "accent" | "neutral" | "success" | "warning";

const PANEL: Record<Tone, { background: string; border: string; className: string }> = {
  accent: { background: COLOR.accentSoft, border: COLOR.accentBorder, className: "lk-panel" },
  neutral: { background: COLOR.neutralSoft, border: COLOR.border, className: "lk-panel lk-panel-neutral" },
  success: { background: COLOR.successSoft, border: COLOR.successBorder, className: "lk-panel lk-panel-success" },
  warning: { background: COLOR.warningSoft, border: COLOR.warningBorder, className: "lk-panel lk-panel-warning" }
};

/** A bordered box across the body; `html` is already markup. */
export function panel(html: string, tone: Tone = "accent", align: "left" | "center" = "left"): string {
  const p = PANEL[tone];
  // `separate`: a collapsed table drops the rounded corners of its cell.
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 20px;border-collapse:separate">
  <tr><td class="${p.className}" align="${align}" style="background:${p.background};border:1px solid ${p.border};border-radius:10px;padding:16px 20px;text-align:${align}">${html}</td></tr>
</table>`;
}

/** A small uppercase caption above a value. */
export function label(text: string): string {
  return `<div class="lk-muted" style="font-size:11px;line-height:16px;letter-spacing:0.08em;text-transform:uppercase;font-weight:600;color:${COLOR.muted}">${esc(text)}</div>`;
}

/** The tracking id of a conversation, with what to do with it. */
export function trackingPanel(reference: string, hint: string): string {
  return panel(
    `${label("Tracking ID")}
<div class="lk-code" style="font-family:${MONO};font-size:20px;line-height:30px;font-weight:700;letter-spacing:0.06em;color:${COLOR.heading}">${esc(reference)}</div>
<div class="lk-muted" style="font-size:13px;line-height:19px;color:${COLOR.muted};margin-top:2px">${esc(hint)}</div>`
  );
}

/** The one action of a message. Nothing is written for anything but an http(s) address. */
export function button(text: string, href: string): string {
  const url = safeUrl(href);
  if (!url) return "";
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 24px;border-collapse:separate">
  <tr><td align="center" bgcolor="${COLOR.accent}" style="background:${COLOR.accent};border-radius:8px">
    <a href="${esc(url)}" style="display:inline-block;padding:12px 22px;font-family:${FONT};font-size:15px;line-height:20px;font-weight:600;color:#ffffff;text-decoration:none">${esc(text)}</a>
  </td></tr>
</table>`;
}

/** Rows of a name and its value: the details of a sign-in, of a request. */
export function details(rows: ReadonlyArray<readonly [string, string]>): string {
  const body = rows
    .filter(([, value]) => String(value ?? "").trim())
    .map(
      ([name, value]) => `<tr>
    <td class="lk-muted" valign="top" style="padding:6px 16px 6px 0;font-size:13px;line-height:20px;color:${COLOR.muted};white-space:nowrap">${esc(name)}</td>
    <td valign="top" style="padding:6px 0;font-size:14px;line-height:20px;color:${COLOR.text};word-break:break-word">${esc(value)}</td>
  </tr>`
    )
    .join("");
  return body ? panel(`<table role="presentation" cellpadding="0" cellspacing="0" border="0" class="lk-text">${body}</table>`, "neutral") : "";
}

export interface LayoutParts {
  brand: Brand;
  /** The browser-tab title and the fallback for the preview line. */
  subject: string;
  /** What kind of message this is, beside the wordmark: "Verification", "Support". */
  kind: string;
  /** The line a mail client shows after the subject. */
  preheader: string;
  /** The heading; left out for a letter, which carries its own. */
  title?: string;
  /** The body, already markup. */
  bodyHtml: string;
  /** Why this arrived, the last line of the footer. */
  reason: string;
  /** The conversation's tracking id, repeated in the footer. */
  reference?: string | null;
}

/** A whole message: the scaffold around one template's body. */
export function layout(parts: LayoutParts): string {
  const { brand } = parts;
  const site = safeUrl(brand.siteUrl);
  const host = site ? new URL(site).host : null;
  const reply = brand.replyAddress && /^[^\s<>"']+@[^\s<>"']+$/.test(brand.replyAddress) ? brand.replyAddress : null;
  const initials = brand.name
    .split(/\s+/)
    .map((word) => word[0] || "")
    .join("")
    .slice(0, 2)
    .toUpperCase();
  const footerLinks = [
    reply ? `<a href="mailto:${esc(reply)}" style="color:${COLOR.muted};text-decoration:underline">${esc(reply)}</a>` : "",
    site && host ? `<a href="${esc(site)}" style="color:${COLOR.muted};text-decoration:underline">${esc(host)}</a>` : ""
  ]
    .filter(Boolean)
    .join(" &nbsp;&middot;&nbsp; ");

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<title>${esc(parts.subject)}</title>
<style>${STYLE}</style>
</head>
<body class="lk-page" style="margin:0;padding:0;background:${COLOR.page}">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;mso-hide:all">${esc(parts.preheader)}</div>
<table role="presentation" class="lk-page" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${COLOR.page}">
  <tr><td align="center" style="padding:32px 12px">
    <table role="presentation" class="lk-card" width="600" cellpadding="0" cellspacing="0" border="0" style="width:600px;max-width:600px;border-collapse:separate;background:${COLOR.card};border:1px solid ${COLOR.border};border-radius:14px;overflow:hidden">
      <tr><td height="4" style="height:4px;line-height:4px;font-size:0;background:${COLOR.accent}">&nbsp;</td></tr>
      <tr><td class="lk-pad" style="padding:22px 36px 0">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td valign="middle">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
                <td width="34" height="34" align="center" valign="middle" bgcolor="${COLOR.accent}" style="width:34px;height:34px;background:${COLOR.accent};border-radius:9px;font-family:${FONT};font-size:13px;line-height:34px;font-weight:700;letter-spacing:0.02em;color:#ffffff">${esc(initials)}</td>
                <td class="lk-heading" valign="middle" style="padding-left:11px;font-family:${FONT};font-size:17px;line-height:24px;font-weight:700;letter-spacing:-0.01em;color:${COLOR.heading}">${esc(brand.name)}</td>
              </tr></table>
            </td>
            <td class="lk-kind lk-muted" align="right" valign="middle" style="font-family:${FONT};font-size:11px;line-height:16px;font-weight:600;letter-spacing:0.08em;text-transform:uppercase;color:${COLOR.muted}">${esc(parts.kind)}</td>
          </tr>
        </table>
      </td></tr>
      <tr><td class="lk-pad" style="padding:18px 36px 0"><div class="lk-rule" style="border-top:1px solid ${COLOR.border};font-size:0;line-height:0">&nbsp;</div></td></tr>
      <tr><td class="lk-pad lk-text" style="padding:26px 36px 12px;font-family:${FONT};font-size:15px;line-height:24px;color:${COLOR.text}">
        ${parts.title ? `<h1 class="lk-heading" style="margin:0 0 16px;font-family:${FONT};font-size:22px;line-height:30px;font-weight:700;letter-spacing:-0.02em;color:${COLOR.heading}">${esc(parts.title)}</h1>` : ""}
        ${parts.bodyHtml}
      </td></tr>
      <tr><td class="lk-pad" style="padding:0 36px"><div class="lk-rule" style="border-top:1px solid ${COLOR.border};font-size:0;line-height:0">&nbsp;</div></td></tr>
      <tr><td class="lk-pad lk-muted" style="padding:18px 36px 26px;font-family:${FONT};font-size:12px;line-height:19px;color:${COLOR.muted}">
        <div><strong class="lk-muted" style="color:${COLOR.muted}">${esc(brand.name)}</strong> &nbsp;&middot;&nbsp; Managed browser workstations</div>
        ${footerLinks ? `<div>${footerLinks}</div>` : ""}
        <div style="margin-top:10px">${esc(parts.reason)}${parts.reference ? ` Tracking ID <span style="font-family:${MONO}">${esc(parts.reference)}</span>.` : ""}</div>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}
