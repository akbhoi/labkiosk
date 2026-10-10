/**
 * A security notice about the recipient's own account, such as a sign-in from
 * a browser it has not used before: what happened, the details, and what to
 * do if it was not them.
 */

import { Brand, details, layout, paragraphs } from "./layout";

export interface AlertTemplate {
  name: "alert";
  /** The heading: "New sign-in to your account". */
  title: string;
  /** What happened, in a sentence or two. */
  lead: string;
  /** When, where and with what. */
  details: Array<[string, string]>;
  /** What to do about it. */
  advice: string;
}

export function renderAlert(t: AlertTemplate, subject: string, brand: Brand): string {
  return layout({
    brand,
    subject,
    kind: "Security",
    preheader: t.lead,
    title: t.title,
    bodyHtml: paragraphs(t.lead) + details(t.details) + paragraphs(t.advice),
    reason: "You are receiving this because it concerns the security of your Lab Kiosk account."
  });
}
