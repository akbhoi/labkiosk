/**
 * The outcome of a request: a registration or Remote Control approved or
 * declined. The outcome is the first thing read, then the explanation, then
 * the one thing to do next.
 */

import { Brand, button, COLOR, esc, layout, panel, paragraphs } from "./layout";

export interface DecisionTemplate {
  name: "decision";
  reference: string;
  outcome: "approved" | "declined";
  /** The heading: "Your organization is active". */
  title: string;
  /** What was decided, beside the wordmark: "Registration", "Remote Control". */
  category: string;
  /** The next step for an approval, e.g. opening the console. */
  action?: { label: string; url: string } | null;
}

export function renderDecision(t: DecisionTemplate, subject: string, text: string, brand: Brand): string {
  const approved = t.outcome === "approved";
  const banner = panel(
    `<div style="font-size:14px;line-height:21px;font-weight:700;color:${approved ? COLOR.success : COLOR.warning}">${approved ? "Approved" : "Not approved"}</div>
<div class="lk-text" style="font-size:14px;line-height:21px;color:${COLOR.text}">${esc(t.category)} request ${esc(t.reference)}</div>`,
    approved ? "success" : "warning"
  );
  return layout({
    brand,
    subject,
    kind: t.category,
    preheader: `${approved ? "Approved" : "Not approved"}: ${t.title}`,
    title: t.title,
    bodyHtml: banner + paragraphs(text) + (t.action ? button(t.action.label, t.action.url) : ""),
    reason: "You are receiving this because you sent us this request.",
    reference: t.reference
  });
}
