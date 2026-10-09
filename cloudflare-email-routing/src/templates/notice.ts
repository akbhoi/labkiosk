/**
 * Plain text in the scaffold: what any message without a template of its own
 * goes out as, so nothing the platform sends is ever bare text.
 */

import { Brand, layout, paragraphs } from "./layout";

export interface NoticeTemplate {
  name: "notice";
  /** A heading above the text; left out when the text speaks for itself. */
  title?: string | null;
}

export function renderNotice(t: NoticeTemplate, subject: string, text: string, brand: Brand): string {
  const first = String(text || "").trim().split("\n")[0] || subject;
  return layout({
    brand,
    subject,
    kind: "Notice",
    preheader: first.slice(0, 140),
    title: t.title || undefined,
    bodyHtml: paragraphs(text),
    reason: "You are receiving this message from Lab Kiosk."
  });
}
