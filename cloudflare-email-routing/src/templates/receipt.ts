/**
 * "We have it": the receipt for a request or a message, carrying the tracking
 * id the customer quotes from then on. Sent when a registration or a Remote
 * Control request is filed, and automatically when a new email arrives.
 */

import { Brand, layout, paragraphs, trackingPanel } from "./layout";

export interface ReceiptTemplate {
  name: "receipt";
  reference: string;
  /** What was received, beside the wordmark: "Support", "Registration". */
  category: string;
  /** The heading: "We received your message". */
  title: string;
}

export function renderReceipt(t: ReceiptTemplate, subject: string, text: string, brand: Brand): string {
  return layout({
    brand,
    subject,
    kind: t.category,
    preheader: `${t.title}. Your tracking ID is ${t.reference}.`,
    title: t.title,
    bodyHtml:
      trackingPanel(t.reference, "Reply to this email to add to your request. Keep the tracking ID in the subject.") + paragraphs(text),
    reason: "You are receiving this because you wrote to us or sent us a request.",
    reference: t.reference
  });
}
