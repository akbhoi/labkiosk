/**
 * A formal letter to a company: the date, who it is addressed to, a subject
 * line, the text, and who signed it. Written from the console's Mail.
 */

import { Brand, COLOR, esc, layout, paragraphs } from "./layout";

export interface LetterTemplate {
  name: "letter";
  reference: string;
  /** The date as it should read: "9 October 2026". */
  date: string;
  recipientName?: string | null;
  recipientOrganization?: string | null;
  /** The letter's own subject line, without the tracking id. */
  heading: string;
  signatory?: string | null;
  signatoryTitle?: string | null;
}

export function renderLetter(t: LetterTemplate, subject: string, text: string, brand: Brand): string {
  const addressee = [t.recipientName, t.recipientOrganization]
    .map((part) => String(part ?? "").trim())
    .filter(Boolean)
    .map((part, index) => `<div${index === 0 ? ` style="font-weight:600"` : ""}>${esc(part)}</div>`)
    .join("");
  return layout({
    brand,
    subject,
    kind: "Letter",
    preheader: t.heading,
    bodyHtml:
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 22px">
  <tr>
    <td valign="top" class="lk-text" style="font-size:14px;line-height:22px;color:${COLOR.text}">${addressee}</td>
    <td valign="top" align="right" class="lk-muted" style="font-size:13px;line-height:22px;color:${COLOR.muted};white-space:nowrap">${esc(t.date)}<br>Ref. ${esc(t.reference)}</td>
  </tr>
</table>
<p class="lk-heading" style="margin:0 0 18px;font-size:16px;line-height:24px;font-weight:700;color:${COLOR.heading}">${esc(t.heading)}</p>` +
      paragraphs(text) +
      (t.signatory
        ? `<p style="margin:26px 0 16px;font-size:15px;line-height:22px"><span style="font-weight:600">${esc(t.signatory)}</span>${
            t.signatoryTitle ? `<br><span class="lk-muted" style="color:${COLOR.muted};font-size:13px">${esc(t.signatoryTitle)}</span>` : ""
          }<br><span class="lk-muted" style="color:${COLOR.muted};font-size:13px">${esc(brand.name)}</span></p>`
        : ""),
    reason: "This letter was sent to you by Lab Kiosk. Reply to this email to answer it.",
    reference: t.reference
  });
}
