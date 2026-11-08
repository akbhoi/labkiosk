/**
 * A message about an organization's plan and payments: a payment received, a
 * renewal coming, a payment that failed, a cancellation, a payment link sent
 * by Lab Kiosk. What happened, the figures, and one button to act on it.
 */

import { Brand, button, details, layout, panel, paragraphs, safeUrl, type Tone } from "./layout";

export interface BillingTemplate {
  name: "billing";
  /** The heading: "Payment received". */
  title: string;
  /** What happened, in a sentence or two. */
  lead: string;
  /** Plan, amount, invoice number, dates. */
  details: Array<[string, string]>;
  /** The one thing to do next, when there is one. */
  action?: { label: string; url: string } | null;
  /** How the message reads: good news, something to do, or something wrong. */
  tone?: "success" | "warning" | "danger" | null;
}

// The scaffold has no red panel: a failure reads as a warning, its words say how serious.
const TONES: Record<NonNullable<BillingTemplate["tone"]>, Tone> = { success: "success", warning: "warning", danger: "warning" };

export function renderBilling(t: BillingTemplate, subject: string, text: string, brand: Brand): string {
  const url = t.action ? safeUrl(t.action.url) : null;
  const lead = t.tone ? panel(paragraphs(t.lead), TONES[t.tone]) : paragraphs(t.lead);
  return layout({
    brand,
    subject,
    kind: "Billing",
    preheader: t.lead.slice(0, 140),
    title: t.title,
    bodyHtml: lead + details(t.details) + (url && t.action ? button(t.action.label, url) : "") + paragraphs(text),
    reason: "You are receiving this because you manage an organization's Lab Kiosk plan."
  });
}
