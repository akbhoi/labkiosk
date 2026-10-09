/**
 * A one-time code: confirming an email address at registration, or the second
 * step of a sign-in. The code is the message; everything else says what it is
 * for, how long it works and what to do if it was not asked for.
 */

import { Brand, COLOR, MONO, label, layout, panel, paragraphs } from "./layout";

export interface CodeTemplate {
  name: "code";
  code: string;
  purpose: "signup" | "sign-in";
  /** How long the code works. */
  minutes: number;
  /** Who it is for, for the greeting. */
  recipientName?: string | null;
}

const COPY = {
  signup: {
    kind: "Verification",
    title: "Confirm your email address",
    lead: "Enter this code in the registration form to confirm this email address.",
    unexpected: "If you did not ask to register an organization, ignore this message. Nothing happens without the code.",
    reason: "You are receiving this because this address was entered in a Lab Kiosk registration form."
  },
  "sign-in": {
    kind: "Sign-in",
    title: "Your sign-in code",
    lead: "Enter this code to finish signing in. It works for this sign-in only.",
    unexpected: "If you did not just enter your password, someone else knows it. Change it now, and keep this code to yourself.",
    reason: "You are receiving this because your password was just entered on the sign-in page."
  }
} as const;

export function renderCode(t: CodeTemplate, subject: string, brand: Brand): string {
  const copy = COPY[t.purpose];
  const digits = String(t.code).replace(/\D/g, "").slice(0, 8);
  const greeting = t.recipientName ? `Hello ${t.recipientName},\n\n` : "";
  return layout({
    brand,
    subject,
    kind: copy.kind,
    preheader: `${digits} is your code. It works for ${t.minutes} minutes.`,
    title: copy.title,
    bodyHtml:
      paragraphs(greeting + copy.lead) +
      panel(
        `${label("Your code")}
<div class="lk-code" style="font-family:${MONO};font-size:34px;line-height:46px;font-weight:700;letter-spacing:0.32em;padding-left:0.32em;color:${COLOR.heading}">${digits}</div>
<div class="lk-muted" style="font-size:13px;line-height:19px;color:${COLOR.muted}">Works for ${Math.max(1, Math.round(t.minutes))} minutes</div>`,
        "accent",
        "center"
      ) +
      paragraphs(copy.unexpected, `font-size:14px;line-height:22px;color:${COLOR.muted}`),
    reason: copy.reason
  });
}
