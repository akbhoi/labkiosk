/**
 * A one-time code: confirming an email address at registration, or the second
 * step of a sign-in. The code is the message; everything else says what it is
 * for, how long it works and what to do if it was not asked for.
 *
 * The code is never in the subject or the preview line: those show on a locked
 * phone's notifications and in every inbox list. Gmail's apps and Apple Mail
 * find the code in the body and offer to copy or fill it, so the body names it
 * plainly, the way the messages Gmail shows its "Copy code" chip on do: one
 * sentence that says what the number is and gives it, "Your Lab Kiosk
 * verification code is <strong>482913</strong>.", then the same digits large,
 * as one unbroken run. The subject says what the mail is: an OTP from this sender.
 */

import { Brand, COLOR, esc, MONO, label, layout, panel, paragraphs } from "./layout";

export interface CodeTemplate {
  name: "code";
  code: string;
  purpose: "signup" | "sign-in" | "contact";
  /** How long the code works. */
  minutes: number;
  /** Who it is for, for the greeting. */
  recipientName?: string | null;
}

const COPY = {
  signup: {
    kind: "Verification",
    caption: "Verification code",
    subject: "verification OTP",
    title: "Confirm your email address",
    lead: "Enter it in the registration form to confirm this email address.",
    unexpected: "If you did not ask to register an organization, ignore this message. Nothing happens without the code.",
    reason: "You are receiving this because this address was entered in a Lab Kiosk registration form."
  },
  contact: {
    kind: "Verification",
    caption: "Verification code",
    subject: "verification OTP",
    title: "Confirm your email address",
    lead: "Enter it in the contact form to confirm this email address. Your message is sent once you do.",
    unexpected: "If you did not start a message to Lab Kiosk, ignore this one. Nothing is sent without the code.",
    reason: "You are receiving this because this address was entered in the Lab Kiosk contact form."
  },
  "sign-in": {
    kind: "Sign-in",
    caption: "Sign-in code",
    subject: "sign-in OTP",
    title: "Your sign-in code",
    lead: "Enter it to finish signing in. It works for this sign-in only.",
    unexpected: "If you did not just enter your password, someone else knows it. Change it now, and keep this code to yourself.",
    reason: "You are receiving this because your password was just entered on the sign-in page."
  }
} as const;

/** The subject of a code message, without the code: "Your Lab Kiosk sign-in OTP". */
export function codeSubject(t: CodeTemplate, brand: Brand): string {
  return `Your ${brand.name} ${COPY[t.purpose].subject}`;
}

export function renderCode(t: CodeTemplate, subject: string, brand: Brand): string {
  const copy = COPY[t.purpose];
  const digits = String(t.code).replace(/\D/g, "").slice(0, 8);
  const minutes = Math.max(1, Math.round(t.minutes));
  const greeting = t.recipientName ? `Hello ${t.recipientName},\n\n` : "";
  return layout({
    brand,
    subject,
    kind: copy.kind,
    preheader: `${copy.caption} for ${brand.name}. It works for ${minutes} minutes.`,
    title: copy.title,
    bodyHtml:
      (greeting ? paragraphs(greeting) : "") +
      // The sentence a mail client reads the code from: what it is, then the digits, in one line.
      `<p style="margin:0 0 16px">Your ${esc(brand.name)} ${esc(copy.caption.toLowerCase())} is <strong>${digits}</strong>. ${esc(copy.lead)}</p>` +
      panel(
        // One text node of digits: a double-click or a long press selects all of it, and
        // `user-select: all` makes one click do it where the client keeps the style (Apple Mail).
        `${label(copy.caption)}
<div class="lk-code" style="font-family:${MONO};font-size:34px;line-height:46px;font-weight:700;letter-spacing:0.32em;padding-left:0.32em;color:${COLOR.heading};-webkit-user-select:all;user-select:all">${digits}</div>
<div class="lk-muted" style="font-size:13px;line-height:19px;color:${COLOR.muted}">Works for ${minutes} minutes</div>`,
        "accent",
        "center"
      ) +
      paragraphs(copy.unexpected, `font-size:14px;line-height:22px;color:${COLOR.muted}`),
    reason: copy.reason
  });
}
