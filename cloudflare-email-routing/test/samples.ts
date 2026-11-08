/**
 * One realistic message per template: what the tests render and what
 * `pnpm run preview` writes out to look at in a browser.
 */

import { encodeQr, qrRows } from "../../cloudflare-control/src/qr";
import { Brand, MailTemplate } from "../src/templates";

export const BRAND: Brand = { name: "Lab Kiosk", siteUrl: "https://labkiosk.org", replyAddress: "support@labkiosk.org" };

export interface Sample {
  file: string;
  subject: string;
  text: string;
  template: MailTemplate;
}

export const SAMPLES: Sample[] = [
  {
    file: "code-signup",
    subject: "Your Lab Kiosk verification OTP",
    text: "Your Lab Kiosk verification code is 482913.\n\nEnter it in the registration form to confirm this email address. It expires in 15 minutes.",
    template: { name: "code", code: "482913", purpose: "signup", minutes: 15 }
  },
  {
    file: "code-sign-in",
    subject: "Your Lab Kiosk sign-in OTP",
    text: "Hello Asha Rao,\n\nYour sign-in code is 730164. It works for this sign-in only, for the next ten minutes.",
    template: { name: "code", code: "730164", purpose: "sign-in", minutes: 10, recipientName: "Asha Rao" }
  },
  {
    file: "receipt",
    subject: "[SUP-7Q2M9X] We received your message",
    text:
      "Hello Pat Morgan,\n\nThank you for writing to Lab Kiosk. Your message \"Cannot enrol a workstation\" has reached our support team, and a person will answer it.\n\n" +
      "We usually reply within one working day.\n\nLab Kiosk",
    template: { name: "receipt", reference: "SUP-7Q2M9X", category: "Support", title: "We received your message" }
  },
  {
    file: "reply",
    subject: "Re: [SAL-K4T8WN] Quote for 120 seats",
    text:
      "Hello Jordan,\n\nThank you for the details. For 120 workstations across three sites the subscriber license is the right fit, and I have attached nothing here on purpose: the quote is at https://labkiosk.org/pricing with your reference filled in.\n\n" +
      "Two things would help me finish it:\n- the country each site is in\n- whether you need Remote Control from day one\n\nBest regards",
    template: { name: "reply", reference: "SAL-K4T8WN", category: "Sales", author: "Asha Rao" }
  },
  {
    file: "decision-approved",
    subject: "[REG-M3X7QA] Your organization is active",
    text:
      "Hello Sam Lee,\n\nGreenwood Public Library is now active on Lab Kiosk.\n\n" +
      "Sign in to your console with the email address and password you registered with. Your enrollment key and the setup steps for your workstations are under Settings.\n\nLab Kiosk",
    template: {
      name: "decision",
      reference: "REG-M3X7QA",
      outcome: "approved",
      title: "Your organization is active",
      category: "Registration",
      action: { label: "Open your console", url: "https://greenwood.labkiosk.org/admin" }
    }
  },
  {
    file: "decision-declined",
    subject: "[RMT-B8N2YH] About your Remote Control request",
    text:
      "Hello Sam Lee,\n\nWe are not able to turn on Remote Control for Greenwood Public Library at this time.\n\n" +
      "We need a signed data processing agreement first.\n\nReply to this email if you would like to discuss it.\n\nLab Kiosk",
    template: {
      name: "decision",
      reference: "RMT-B8N2YH",
      outcome: "declined",
      title: "About your Remote Control request",
      category: "Remote Control"
    }
  },
  {
    file: "letter",
    subject: "[LTR-H6V9ZC] Renewal of your subscriber license",
    text:
      "Dear Ms Okafor,\n\nYour organization's subscriber license for 80 workstations ends on 30 November 2026. This letter confirms the terms on which we would be glad to renew it.\n\n" +
      "The price per workstation is unchanged for the coming year, and the license continues to cover every update released in that time. No action is needed on your workstations: they keep working throughout.\n\n" +
      "Please reply to this letter by 15 November to confirm the renewal, or to tell us of any change in the number of workstations.\n\nYours sincerely,",
    template: {
      name: "letter",
      reference: "LTR-H6V9ZC",
      date: "9 October 2026",
      recipientName: "Ngozi Okafor",
      recipientOrganization: "Northfield Learning Trust",
      heading: "Renewal of your subscriber license",
      signatory: "Asha Rao",
      signatoryTitle: "Customer Accounts"
    }
  },
  {
    file: "alert",
    subject: "New sign-in to your Lab Kiosk account",
    text: "Hello Asha Rao,\n\nYour Lab Kiosk account was just signed in to from a browser it has not used before.",
    template: {
      name: "alert",
      title: "New sign-in to your account",
      lead: "Hello Asha Rao, your Lab Kiosk account was just signed in to from a browser it has not used before.",
      details: [
        ["When", "2026-10-09 03:14 UTC"],
        ["IP address", "203.0.113.24"],
        ["Browser", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/141.0"]
      ],
      advice: "If this was you, there is nothing to do. If it was not, change your password now. Changing the password signs every other browser out."
    }
  },
  {
    file: "billing",
    subject: "Payment received: Lab Kiosk Standard",
    text: "Your GST invoice is attached to your account under Plan & billing.",
    template: {
      name: "billing",
      title: "Payment received",
      lead: "Thank you. Greenwood Public Library's Standard plan is paid until 8 December 2026.",
      details: [
        ["Plan", "Standard, monthly, 45 workstations"],
        ["Amount", "₹2,358.82 (GST ₹359.82)"],
        ["Invoice", "LK/26-27/000012"]
      ],
      action: { label: "View invoice", url: "https://greenwood.labkiosk.org/admin/plan" },
      tone: "success"
    }
  },
  {
    file: "invoice-proforma",
    subject: "Proforma invoice PI/26-27/000004: renew Lab Kiosk before 15 Nov 2026",
    text: "Greenwood Public Library's plan ends on 15 Nov 2026. Pay this proforma before then to keep it for another month.",
    template: {
      name: "invoice",
      title: "Your plan is ending",
      lead: "Greenwood Public Library's plan ends on 15 Nov 2026. Pay this proforma before then to keep it for another month.",
      document: {
        kind: "proforma",
        number: "PI/26-27/000004",
        date: "08 Nov 2026",
        validUntil: "15 Nov 2026",
        seller: { name: "Lab Kiosk", gstin: "21CWZPB0039H2ZO", address: "Bhubaneswar, Odisha" },
        buyer: { name: "Greenwood Public Library", gstin: null, address: "12 Park Road\nPune, Maharashtra" },
        lines: [
          { description: "Lab Kiosk Standard, monthly, 40 workstations", amount: "₹1,999.00" },
          { description: "Remote Control, 5 workstations", amount: "₹250.00" }
        ],
        totals: [
          ["Taxable value", "₹2,249.00"],
          ["IGST @ 18%", "₹404.82"]
        ],
        total: "₹2,653.82",
        totalInWords: "Rupees Two Thousand Six Hundred Fifty Three and Eighty Two Paise Only",
        qr: qrRows(encodeQr("https://rzp.io/rzp/AbC123xy", "M"))
      },
      action: { label: "Pay ₹2,653.82", url: "https://rzp.io/rzp/AbC123xy" },
      viewUrl: "https://labkiosk.org/billing/document/0f1e2d3c",
      note: "Prefer automatic renewal? Choose a plan under Plan & billing in your console."
    }
  },
  {
    file: "invoice-tax",
    subject: "Payment received: tax invoice LK/26-27/000012",
    text: "Thank you. Greenwood Public Library's Standard plan is paid until 15 Dec 2026.",
    template: {
      name: "invoice",
      title: "Payment received",
      lead: "Thank you. Greenwood Public Library's Standard plan is paid until 15 Dec 2026.",
      document: {
        kind: "invoice",
        number: "LK/26-27/000012",
        date: "14 Nov 2026",
        validUntil: null,
        seller: { name: "Lab Kiosk", gstin: "21CWZPB0039H2ZO", address: "Bhubaneswar, Odisha" },
        buyer: { name: "Greenwood Public Library", gstin: "27AAPFU0939F1ZV", address: "12 Park Road\nPune, Maharashtra" },
        lines: [{ description: "Lab Kiosk Standard, monthly, 40 workstations", amount: "₹1,999.00" }],
        totals: [
          ["Taxable value", "₹1,999.00"],
          ["IGST @ 18%", "₹359.82"]
        ],
        total: "₹2,358.82",
        totalInWords: "Rupees Two Thousand Three Hundred Fifty Eight and Eighty Two Paise Only",
        qr: null
      },
      action: { label: "View invoice", url: "https://labkiosk.org/billing/document/0f1e2d3c" },
      viewUrl: "https://labkiosk.org/billing/document/0f1e2d3c"
    }
  },
  {
    file: "notice",
    subject: "[REG-M3X7QA] New registration: Greenwood Public Library",
    text:
      "Organization: Greenwood Public Library\nAddress: greenwood.labkiosk.org\nContact: Sam Lee <sam@greenwood.example>\nWorkstations expected: 40\n\nReview it under Tasks in the Super Admin console.",
    template: { name: "notice", title: "New registration" }
  }
];
