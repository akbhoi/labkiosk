/**
 * Every email the platform sends, as HTML: one scaffold (`layout.ts`) and one
 * template per kind of message.
 *
 *   code      a one-time code (registration, sign-in)
 *   receipt   "we received it", with the tracking id
 *   reply     a reply a person wrote in the console
 *   decision  a request approved or declined
 *   letter    a formal letter to a company
 *   alert     a security notice about the recipient's account
 *   notice    plain text in the scaffold (the fallback)
 *
 * The plain-text part is written by the sender and is the body of the
 * templates that carry prose (receipt, reply, decision, letter, notice), so
 * the two parts of a message never say different things.
 *
 * This module has no bindings and no state: the email Worker renders with it
 * when it sends (`src/send.ts`), and labkiosk-controller imports it to render
 * the same HTML where it sends by itself (local development, and its fallback).
 */

import { AlertTemplate, renderAlert } from "./alert";
import { CodeTemplate, renderCode } from "./code";
import { DecisionTemplate, renderDecision } from "./decision";
import { Brand } from "./layout";
import { LetterTemplate, renderLetter } from "./letter";
import { NoticeTemplate, renderNotice } from "./notice";
import { ReceiptTemplate, renderReceipt } from "./receipt";
import { ReplyTemplate, renderReply } from "./reply";

export type { Brand } from "./layout";
export type { AlertTemplate, CodeTemplate, DecisionTemplate, LetterTemplate, NoticeTemplate, ReceiptTemplate, ReplyTemplate };

export type MailTemplate =
  | AlertTemplate
  | CodeTemplate
  | DecisionTemplate
  | LetterTemplate
  | NoticeTemplate
  | ReceiptTemplate
  | ReplyTemplate;

export const TEMPLATE_NAMES = ["alert", "code", "decision", "letter", "notice", "receipt", "reply"] as const;

export interface RenderInput {
  template: MailTemplate;
  subject: string;
  /** The message's plain-text part. */
  text: string;
  brand: Brand;
}

/** The HTML part of a message. */
export function renderMailHtml(input: RenderInput): string {
  const { template, subject, text, brand } = input;
  switch (template.name) {
    case "alert":
      return renderAlert(template, subject, brand);
    case "code":
      return renderCode(template, subject, brand);
    case "decision":
      return renderDecision(template, subject, text, brand);
    case "letter":
      return renderLetter(template, subject, text, brand);
    case "receipt":
      return renderReceipt(template, subject, text, brand);
    case "reply":
      return renderReply(template, subject, text, brand);
    case "notice":
      return renderNotice(template, subject, text, brand);
  }
}
