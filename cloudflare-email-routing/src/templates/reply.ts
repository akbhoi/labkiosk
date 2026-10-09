/**
 * A reply written by a person in the console's Mail or Tasks: their words,
 * who wrote them, and the conversation's tracking id underneath.
 */

import { Brand, COLOR, esc, label, layout, MONO, paragraphs } from "./layout";

export interface ReplyTemplate {
  name: "reply";
  reference: string;
  /** What the conversation is about, beside the wordmark: "Support", "Sales". */
  category: string;
  /** Who wrote it, under the message; left out when not known. */
  author?: string | null;
}

export function renderReply(t: ReplyTemplate, subject: string, text: string, brand: Brand): string {
  const first = String(text || "").trim().split("\n")[0] || subject;
  return layout({
    brand,
    subject,
    kind: t.category,
    preheader: first.slice(0, 140),
    bodyHtml:
      paragraphs(text) +
      `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 18px">
  <tr>
    <td valign="top" class="lk-muted" style="font-size:13px;line-height:20px;color:${COLOR.muted}">${
      t.author ? `<span class="lk-text" style="color:${COLOR.text};font-weight:600">${esc(t.author)}</span><br>${esc(brand.name)}` : esc(brand.name)
    }</td>
    <td valign="top" align="right">${label("Tracking ID")}<div class="lk-code" style="font-family:${MONO};font-size:14px;line-height:20px;font-weight:700;color:${COLOR.heading}">${esc(t.reference)}</div></td>
  </tr>
</table>`,
    reason: "You are receiving this because of a conversation with us. Reply to this email to continue it.",
    reference: t.reference
  });
}
