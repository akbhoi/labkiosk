/**
 * Billing documents an organization receives: the tax invoice issued for every
 * payment (src/invoices.ts), and the proforma invoice sent before a plan that
 * will not renew by itself ends, with a payment link and a QR code for it.
 *
 * A proforma is not a tax invoice: it takes a number from its own series
 * ("PI/26-27/000001"), counts as no revenue, and is never in a GSTR-1 export.
 * Paying it goes through the ordinary payment-link path, which checks the
 * amount, extends the plan and issues the tax invoice (src/billing.ts).
 *
 * Both are shown by one renderer: on a private link that needs no sign-in
 * (/billing/document/<token>; only the token's SHA-256 is stored), from the
 * console, and printed. Seller details come from settings (sellerFrom).
 *
 * The GSTR-1 export turns a month's tax invoices into the CSV files the GST
 * portal's offline tool imports.
 */

import { createPaymentLink, rupees } from "./billing";
import { findTenantById, findUserById, writeAuditLog } from "./db";
import { escapeAttr, escapeHtml } from "./escape";
import { financialYear, GST_STATES, gstPercentFor, sellerFrom, sellerLegalLine, sellerName, shortFinancialYear, splitGst, type Invoice, type InvoiceLine, type Seller } from "./invoices";
import { mailConfigProblem, sendMail } from "./mail";
import { CATALOGUE, entitlement, quoteTier, type BillingPeriod, type SoldTier, type TierQuoteInput } from "./plans";
import { encodeQr, qrRows, qrSvg } from "./qr";
import { invoiceLines } from "./subscriptions";
import type { Env, Tenant } from "./types";
import { FONT_LINKS, rootTokensCss } from "./ui_tokens";

const DAY = 86_400;
/** A private link works this long; an organization's own console always shows its documents. */
const LINK_DAYS = 400;
/** Proformas go out this long before a plan ends, and a reminder this long before. */
const PROFORMA_LEAD_DAYS = 7;
const REMINDER_LEAD_DAYS = 1;
const PROFORMA_PREFIX = "PI";
/** Inter-state sales to unregistered buyers above this (paise) are B2C (Large) in GSTR-1. */
export const B2CL_LIMIT_PAISE = 100_000 * 100;
const IST_OFFSET_SECONDS = 19_800;

// ------------------------------------------------------------ amount in words

const ONES = ["", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight", "Nine", "Ten", "Eleven", "Twelve", "Thirteen", "Fourteen", "Fifteen", "Sixteen", "Seventeen", "Eighteen", "Nineteen"];
const TENS = ["", "", "Twenty", "Thirty", "Forty", "Fifty", "Sixty", "Seventy", "Eighty", "Ninety"];

function belowHundred(n: number): string {
  if (n < 20) return ONES[n];
  return TENS[Math.floor(n / 10)] + (n % 10 ? ` ${ONES[n % 10]}` : "");
}

function belowThousand(n: number): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  return [hundreds ? `${ONES[hundreds]} Hundred` : "", rest ? belowHundred(rest) : ""].filter(Boolean).join(" ");
}

/** A whole number in words, in the Indian system: thousand, lakh, crore. */
export function indianWords(n: number): string {
  if (!Number.isInteger(n) || n < 0) throw new Error("A whole number of zero or more is needed");
  if (n === 0) return "Zero";
  const parts: string[] = [];
  const crore = Math.floor(n / 10_000_000);
  const lakh = Math.floor((n % 10_000_000) / 100_000);
  const thousand = Math.floor((n % 100_000) / 1000);
  const rest = n % 1000;
  if (crore) parts.push(`${indianWords(crore)} Crore`);
  if (lakh) parts.push(`${belowHundred(lakh)} Lakh`);
  if (thousand) parts.push(`${belowHundred(thousand)} Thousand`);
  if (rest) parts.push(belowThousand(rest));
  return parts.join(" ");
}

/** "Rupees Two Thousand Three Hundred Fifty Eight and Eighty Two Paise Only". */
export function amountInWords(paise: number): string {
  const rupeesPart = Math.floor(paise / 100);
  const paisePart = paise % 100;
  return `Rupees ${indianWords(rupeesPart)}${paisePart ? ` and ${belowHundred(paisePart)} Paise` : ""} Only`;
}

// ------------------------------------------------------------ private links

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export type DocumentKind = "invoice" | "proforma";

/** A new private link to one document; the token is returned once and only its hash is kept. */
export async function createDocumentLink(db: D1Database, tenantId: string, kind: DocumentKind, documentId: string, now: number): Promise<string> {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const token = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  await db
    .prepare("INSERT INTO document_links (token_hash, tenant_id, kind, document_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(await sha256Hex(token), tenantId, kind, documentId, now, now + LINK_DAYS * DAY)
    .run();
  return token;
}

export async function resolveDocumentLink(db: D1Database, token: string, now: number): Promise<{ tenantId: string; kind: DocumentKind; documentId: string } | null> {
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  const row = await db
    .prepare("SELECT tenant_id, kind, document_id, expires_at FROM document_links WHERE token_hash = ?")
    .bind(await sha256Hex(token))
    .first<{ tenant_id: string; kind: DocumentKind; document_id: string; expires_at: number }>();
  if (!row || Number(row.expires_at) <= now) return null;
  return { tenantId: row.tenant_id, kind: row.kind, documentId: row.document_id };
}

/** Where a private link opens: the platform's own host, or the dev host it was made on. */
export function documentUrl(env: Env, origin: string | null, token: string): string {
  const base = env.DEFAULT_DOMAIN && !isDevOrigin(origin) ? `https://${env.DEFAULT_DOMAIN}` : origin || "";
  return `${base}/billing/document/${token}`;
}

function isDevOrigin(origin: string | null): boolean {
  if (!origin) return false;
  try {
    const host = new URL(origin).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || /^(10|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(host);
  } catch {
    return false;
  }
}

// ------------------------------------------------------------ the documents

export interface Proforma {
  id: string;
  number: string;
  tenant_id: string;
  reason: "renewal" | "cancelled" | "platform";
  tier: SoldTier;
  period: BillingPeriod;
  extra_workstations: number;
  remote_seats: number;
  subtotal_paise: number;
  cgst_paise: number;
  sgst_paise: number;
  igst_paise: number;
  total_paise: number;
  seller_gstin: string | null;
  buyer_name: string;
  buyer_gstin: string | null;
  buyer_address: string | null;
  place_of_supply: string | null;
  lines_json: string;
  covers_from: number | null;
  covers_to: number | null;
  valid_until: number;
  payment_id: string | null;
  status: "open" | "paid" | "expired" | "void";
  created_by: string | null;
  created_at: number;
  emailed_at: number | null;
  reminded_at: number | null;
}

/** What the renderer shows, for either kind. */
export interface DocumentView {
  kind: DocumentKind;
  number: string;
  issuedAt: number;
  buyer: { name: string; gstin: string | null; address: string | null; stateCode: string | null };
  placeOfSupply: string | null;
  lines: InvoiceLine[];
  subtotal: number;
  cgst: number;
  sgst: number;
  igst: number;
  total: number;
  sellerGstin: string | null;
  /** Tax invoice: the Razorpay payment. Proforma: none. */
  paymentReference: string | null;
  /** Proforma only. */
  validUntil: number | null;
  coversFrom: number | null;
  coversTo: number | null;
  status: string;
  payUrl: string | null;
}

function parseLines(json: string): InvoiceLine[] {
  try {
    const lines = JSON.parse(json) as unknown;
    return Array.isArray(lines)
      ? lines.filter((l): l is InvoiceLine => Boolean(l) && typeof (l as InvoiceLine).description === "string" && Number.isFinite((l as InvoiceLine).amount))
      : [];
  } catch (err) {
    console.error("[Billing] A document's lines are unreadable:", err);
    return [];
  }
}

export async function invoiceView(db: D1Database, tenantId: string, id: string): Promise<DocumentView | null> {
  const i = await db.prepare("SELECT * FROM invoices WHERE tenant_id = ? AND id = ?").bind(tenantId, id).first<Invoice>();
  if (!i) return null;
  return {
    kind: "invoice",
    number: i.number,
    issuedAt: Number(i.issued_at),
    buyer: { name: i.buyer_name, gstin: i.buyer_gstin, address: i.buyer_address, stateCode: i.place_of_supply },
    placeOfSupply: i.place_of_supply,
    lines: parseLines(i.lines_json),
    subtotal: Number(i.subtotal_paise),
    cgst: Number(i.cgst_paise),
    sgst: Number(i.sgst_paise),
    igst: Number(i.igst_paise),
    total: Number(i.total_paise),
    sellerGstin: i.seller_gstin,
    paymentReference: i.razorpay_payment_id,
    validUntil: null,
    coversFrom: null,
    coversTo: null,
    status: "paid",
    payUrl: null
  };
}

export async function proformaView(db: D1Database, tenantId: string, id: string): Promise<DocumentView | null> {
  const p = await db.prepare("SELECT * FROM proformas WHERE tenant_id = ? AND id = ?").bind(tenantId, id).first<Proforma>();
  if (!p) return null;
  const pay = p.payment_id
    ? await db.prepare("SELECT short_url FROM payments WHERE id = ? AND tenant_id = ?").bind(p.payment_id, tenantId).first<{ short_url: string | null }>()
    : null;
  return {
    kind: "proforma",
    number: p.number,
    issuedAt: Number(p.created_at),
    buyer: { name: p.buyer_name, gstin: p.buyer_gstin, address: p.buyer_address, stateCode: p.place_of_supply },
    placeOfSupply: p.place_of_supply,
    lines: parseLines(p.lines_json),
    subtotal: Number(p.subtotal_paise),
    cgst: Number(p.cgst_paise),
    sgst: Number(p.sgst_paise),
    igst: Number(p.igst_paise),
    total: Number(p.total_paise),
    sellerGstin: p.seller_gstin,
    paymentReference: null,
    validUntil: Number(p.valid_until),
    coversFrom: p.covers_from === null ? null : Number(p.covers_from),
    coversTo: p.covers_to === null ? null : Number(p.covers_to),
    status: p.status,
    payUrl: p.status === "open" ? (pay?.short_url ?? null) : null
  };
}

export async function documentView(db: D1Database, tenantId: string, kind: DocumentKind, id: string): Promise<DocumentView | null> {
  return kind === "invoice" ? invoiceView(db, tenantId, id) : proformaView(db, tenantId, id);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A date in India as day, month and year: "08 Nov 2026". Written by hand, so "Sep" never becomes "Sept". */
function istParts(seconds: number): [string, string, number] {
  const d = new Date((seconds + IST_OFFSET_SECONDS) * 1000);
  return [String(d.getUTCDate()).padStart(2, "0"), MONTHS[d.getUTCMonth()], d.getUTCFullYear()];
}

export function documentDate(seconds: number): string {
  return istParts(seconds).join(" ");
}

function stateLabel(code: string | null): string {
  return code ? `${code} - ${GST_STATES[code] ?? "Unknown state"}` : "Not given";
}

/** The document as a page: for the private link, the console and print. */
export function renderDocumentPage(view: DocumentView, seller: Seller, nonce: string, options: { signatory?: string | null } = {}): string {
  const tax = Boolean(view.sellerGstin);
  const title =
    view.kind === "proforma" ? "Proforma Invoice" : tax ? "Tax Invoice" : "Receipt";
  const qr = view.payUrl ? qrSvg(encodeQr(view.payUrl, "M"), `QR code to pay ${view.number}`) : "";
  const money = (p: number) => escapeHtml(rupees(p));
  const sac = seller.sac;
  const rows = view.lines
    .map(
      (l, i) => `
          <tr><td>${i + 1}</td><td>${escapeHtml(l.description)}${view.coversFrom && view.coversTo ? `<div class="doc-sub">Period ${escapeHtml(documentDate(view.coversFrom))} to ${escapeHtml(documentDate(view.coversTo))}</div>` : ""}</td><td>${sac ? escapeHtml(sac) : "&ndash;"}</td><td class="num col-opt">1</td><td class="num col-opt">${money(l.amount)}</td><td class="num">${money(l.amount)}</td></tr>`
    )
    .join("");
  // The totals sit under the table, not in it, so a phone can drop columns without losing them.
  const sumRow = (label: string, paise: number, total = false) => `<div class="doc-sum-row${total ? " is-total" : ""}"><span>${label}</span><span class="num">${money(paise)}</span></div>`;
  const totals = [
    sumRow("Taxable value", view.subtotal),
    view.cgst ? sumRow("CGST @ 9%", view.cgst) : "",
    view.sgst ? sumRow("SGST @ 9%", view.sgst) : "",
    view.igst ? sumRow("IGST @ 18%", view.igst) : "",
    sumRow("Total", view.total, true)
  ].join("");
  const statusBadge =
    view.kind === "proforma"
      ? view.status === "paid"
        ? `<span class="doc-badge is-paid">Paid</span>`
        : view.status === "open"
          ? `<span class="doc-badge">Payment due by ${escapeHtml(documentDate(view.validUntil ?? view.issuedAt))}</span>`
          : `<span class="doc-badge is-closed">${view.status === "expired" ? "Expired" : "Withdrawn"}</span>`
      : `<span class="doc-badge is-paid">Paid</span>`;
  return `<!DOCTYPE html>
<html lang="en" data-theme="light">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex, nofollow">
  <title>${escapeHtml(`${title} ${view.number}`)}</title>
  <meta name="color-scheme" content="light">
${FONT_LINKS}
  <style nonce="${escapeAttr(nonce)}">
${rootTokensCss()}
    *, *::before, *::after { box-sizing: border-box; }
    body { margin: 0; font-family: var(--font-sans); background: var(--bg-base); color: var(--text-main); }
    a { color: var(--accent-text); }
    .doc-pay p { margin: 4px 0 0; overflow-wrap: anywhere; }
    .doc-actions { max-width: 860px; margin: 24px auto 0; padding: 0 16px; display: flex; justify-content: flex-end; gap: 8px; }
    .doc-btn { font: inherit; font-size: 0.875rem; font-weight: 600; padding: 9px 16px; border-radius: var(--radius-sm); border: 1px solid var(--border); background: var(--bg-surface); color: var(--text-main); cursor: pointer; text-decoration: none; }
    .doc-btn.is-primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); }
    .doc { max-width: 860px; margin: 16px auto 40px; padding: 40px; background: var(--bg-surface); border: 1px solid var(--border); border-radius: var(--radius-lg); }
    .doc-top { display: flex; justify-content: space-between; gap: 24px; flex-wrap: wrap; border-bottom: 2px solid var(--text-main); padding-bottom: 20px; }
    .doc-title { font-size: 1.75rem; font-weight: 800; letter-spacing: -0.02em; margin: 0 0 6px; }
    .doc-meta { font-size: 0.875rem; color: var(--text-muted); line-height: 1.7; }
    .doc-meta strong { color: var(--text-main); font-family: var(--font-mono); }
    .doc-seller { text-align: right; font-size: 0.875rem; line-height: 1.6; }
    .doc-seller .name { font-size: 1.125rem; font-weight: 700; }
    .doc-badge { display: inline-block; margin-top: 8px; padding: 3px 10px; border-radius: 999px; font-size: 0.75rem; font-weight: 700; background: var(--warning-soft); color: var(--warning-text); }
    .doc-badge.is-paid { background: var(--success-soft); color: var(--success-text); }
    .doc-badge.is-closed { background: var(--bg-subtle); color: var(--text-muted); }
    .doc-parties { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(240px, 100%), 1fr)); gap: 24px; margin: 24px 0; font-size: 0.875rem; line-height: 1.6; }
    .doc-label { font-size: 0.6875rem; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 700; color: var(--text-muted); margin-bottom: 4px; }
    .doc-addr { white-space: pre-line; }
    .doc-table { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 0.875rem; }
    th, td { padding: 10px 8px; border-bottom: 1px solid var(--border-subtle); text-align: left; vertical-align: top; }
    thead th { background: var(--bg-subtle); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-muted); }
    .doc-sum { margin-left: auto; max-width: 340px; font-size: 0.875rem; }
    .doc-sum-row { display: flex; justify-content: space-between; gap: 16px; padding: 8px; border-bottom: 1px solid var(--border-subtle); color: var(--text-muted); }
    .doc-sum-row .num { color: var(--text-main); }
    .doc-sum-row.is-total { border-top: 2px solid var(--text-main); border-bottom: 0; font-size: 1rem; font-weight: 800; color: var(--text-main); }
    .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .doc-sub { font-size: 0.75rem; color: var(--text-muted); margin-top: 2px; }
    .doc-words { margin: 16px 0; font-size: 0.875rem; }
    .doc-pay { display: grid; grid-template-columns: auto 1fr; gap: 20px; align-items: center; margin: 24px 0; padding: 20px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--bg-subtle); }
    .qr-box { width: 148px; height: 148px; padding: 0; background: var(--bg-surface); color: var(--text-main); border-radius: var(--radius-sm); }
    .qr-code { width: 100%; height: 100%; display: block; }
    .doc-foot { margin-top: 28px; padding-top: 16px; border-top: 1px solid var(--border-subtle); font-size: 0.8125rem; color: var(--text-muted); line-height: 1.6; display: flex; justify-content: space-between; gap: 24px; flex-wrap: wrap; }
    .doc-sign { text-align: right; }
    @media (max-width: 640px) {
      .doc { padding: 20px 16px; margin: 12px 8px 32px; }
      .doc-seller { text-align: left; }
      .doc-pay { grid-template-columns: 1fr; justify-items: start; }
      th, td { padding: 8px 5px; }
      table { font-size: 0.8125rem; }
      .col-opt { display: none; }
      .doc-sum { max-width: none; }
      .doc-sign { text-align: left; }
    }
    @media print {
      body { background: none; }
      .doc-actions { display: none; }
      .doc { border: 0; margin: 0; padding: 0; max-width: none; }
    }
  </style>
</head>
<body>
  <div class="doc-actions">
    ${view.payUrl ? `<a class="doc-btn is-primary" href="${escapeAttr(view.payUrl)}" rel="noopener">Pay ${money(view.total)} now</a>` : ""}
    <button type="button" class="doc-btn" id="doc-print">Print or save as PDF</button>
  </div>
  <main class="doc">
    <div class="doc-top">
      <div>
        <h1 class="doc-title">${escapeHtml(title)}</h1>
        <div class="doc-meta">
          ${view.kind === "proforma" ? "Proforma number" : "Invoice number"} <strong>${escapeHtml(view.number)}</strong><br>
          Date ${escapeHtml(documentDate(view.issuedAt))}${view.kind === "proforma" && view.validUntil ? `<br>Valid until ${escapeHtml(documentDate(view.validUntil))}` : ""}
        </div>
        ${statusBadge}
      </div>
      <div class="doc-seller">
        <div class="name">${escapeHtml(sellerName(seller))}</div>
        ${sellerLegalLine(seller) ? `<div>Legal name: ${escapeHtml(sellerLegalLine(seller)!)}</div>` : ""}
        ${seller.address ? `<div class="doc-addr">${escapeHtml(seller.address)}</div>` : ""}
        ${view.sellerGstin ? `<div>GSTIN <strong>${escapeHtml(view.sellerGstin)}</strong></div>` : ""}
        ${seller.state ? `<div>State ${escapeHtml(stateLabel(seller.state))}</div>` : ""}
      </div>
    </div>

    <div class="doc-parties">
      <div>
        <div class="doc-label">Billed to</div>
        <div><strong>${escapeHtml(view.buyer.name)}</strong></div>
        ${view.buyer.address ? `<div class="doc-addr">${escapeHtml(view.buyer.address)}</div>` : ""}
        ${view.buyer.gstin ? `<div>GSTIN ${escapeHtml(view.buyer.gstin)}</div>` : `<div>Unregistered (no GSTIN)</div>`}
      </div>
      <div>
        <div class="doc-label">Supply</div>
        <div>Place of supply: ${escapeHtml(stateLabel(view.placeOfSupply))}</div>
        <div>Tax payable on reverse charge: No</div>
        ${view.paymentReference ? `<div>Paid through Razorpay, payment ${escapeHtml(view.paymentReference)}</div>` : ""}
      </div>
    </div>

    <div class="doc-table">
    <table>
      <thead><tr><th>#</th><th>Description</th><th>SAC</th><th class="num col-opt">Qty</th><th class="num col-opt">Rate</th><th class="num">Taxable value</th></tr></thead>
      <tbody>${rows}
      </tbody>
    </table>
    </div>
    <div class="doc-sum">${totals}</div>
    <p class="doc-words"><strong>Amount in words:</strong> ${escapeHtml(amountInWords(view.total))}</p>

    ${
      view.payUrl
        ? `<div class="doc-pay">
      <div class="qr-box">${qr}</div>
      <div>
        <div class="doc-label">Pay online</div>
        <p>Scan the code with any UPI app or phone camera, or open <a href="${escapeAttr(view.payUrl)}" rel="noopener">${escapeHtml(view.payUrl)}</a>, to pay ${money(view.total)} by UPI, card or netbanking through Razorpay. The plan is extended and the tax invoice is emailed as soon as the payment arrives.</p>
      </div>
    </div>`
        : ""
    }

    <div class="doc-foot">
      <div>
        ${
          view.kind === "proforma"
            ? "This is a proforma invoice, not a tax invoice. The tax invoice is issued when the payment is received."
            : tax
              ? "This is a computer-generated tax invoice."
              : "This is a computer-generated receipt. No GST was charged: the seller was not registered for GST when it was issued."
        }
      </div>
      <div class="doc-sign">For ${escapeHtml(sellerName(seller))}<br>${options.signatory ? `${escapeHtml(options.signatory)}, ` : ""}Authorised signatory</div>
    </div>
  </main>
  <script nonce="${escapeAttr(nonce)}">
    document.getElementById("doc-print").addEventListener("click", function () { window.print(); });
  </script>
</body>
</html>`;
}

/**
 * Headers for a document page: nothing but its own nonced script and style and
 * the interface fonts, never framed, never stored, never indexed, and the
 * private link in its address never sent on as a referrer.
 */
export function documentHeaders(nonce: string, https: boolean): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": [
      "default-src 'none'",
      `script-src 'nonce-${nonce}'`,
      `style-src 'nonce-${nonce}' https://fonts.googleapis.com`,
      "font-src https://fonts.gstatic.com",
      "img-src 'self'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'"
    ].join("; "),
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "no-referrer",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cache-Control": "no-store",
    "X-Robots-Tag": "noindex, nofollow"
  };
  if (https) headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
  return headers;
}

// ------------------------------------------------------------ proformas

async function nextProformaNumber(db: D1Database, now: number): Promise<string> {
  const key = `PI:${financialYear(now)}`;
  const row = await db
    .prepare("INSERT INTO invoice_counters (fy, next) VALUES (?, 1) ON CONFLICT(fy) DO UPDATE SET next = next + 1 RETURNING next")
    .bind(key)
    .first<{ next: number }>();
  if (!row) throw new Error("The proforma counter did not answer");
  return `${PROFORMA_PREFIX}/${shortFinancialYear(now)}/${String(row.next).padStart(6, "0")}`;
}

export interface NewProforma {
  tenant: Tenant;
  input: TierQuoteInput;
  reason: Proforma["reason"];
  validUntil: number;
  coversFrom: number | null;
  coversTo: number | null;
  userId: string | null;
  /** Where the payer is sent back to after paying. */
  callbackUrl: string;
  note?: string;
  now: number;
}

/**
 * Write a proforma and the Razorpay payment link it is paid through. The
 * payment row carries the tier and counts, so paying it applies exactly what
 * the proforma lists (src/billing.ts recordPayment).
 */
export async function createProforma(env: Env, db: D1Database, p: NewProforma): Promise<Proforma> {
  const gstPercent = gstPercentFor(env);
  const quote = quoteTier(p.input, gstPercent);
  const seller = sellerFrom(env);
  const split = splitGst(quote.gst, seller.state, p.tenant.billing_state ?? null);
  const owner = p.tenant.user_id ? await findUserById(db, p.tenant.user_id) : null;
  if (!owner) throw new Error("The organization has no owner to bill");
  const number = await nextProformaNumber(db, p.now);
  const hours = Math.max(1, Math.ceil((p.validUntil - p.now) / 3600));
  const payment = await createPaymentLink(env, db, {
    tenantId: p.tenant.id,
    organization: p.tenant.name,
    userId: p.userId ?? owner.id,
    email: owner.email,
    name: owner.name,
    quote,
    callbackUrl: p.callbackUrl,
    nowSeconds: p.now,
    platform: { tier: p.input.tier, remoteSeats: p.input.remoteSeats, note: `Proforma ${number}${p.note ? `: ${p.note}` : ""}`, hours }
  });
  const id = `pf${crypto.randomUUID().replace(/-/g, "")}`;
  await db
    .prepare(
      `INSERT INTO proformas (id, number, tenant_id, reason, tier, period, extra_workstations, remote_seats, subtotal_paise, cgst_paise, sgst_paise,
                              igst_paise, total_paise, seller_gstin, buyer_name, buyer_gstin, buyer_address, place_of_supply, lines_json, covers_from,
                              covers_to, valid_until, payment_id, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`
    )
    .bind(
      id,
      number,
      p.tenant.id,
      p.reason,
      p.input.tier,
      p.input.period,
      p.input.extraWorkstations,
      p.input.remoteSeats,
      quote.subtotal,
      split.cgst,
      split.sgst,
      split.igst,
      quote.total,
      seller.gstin,
      (p.tenant.billing_legal_name || p.tenant.name).slice(0, 200),
      p.tenant.billing_gstin ?? null,
      p.tenant.billing_address ?? null,
      split.placeOfSupply,
      JSON.stringify(invoiceLines(quote)),
      p.coversFrom,
      p.coversTo,
      p.validUntil,
      payment.id,
      p.userId,
      p.now
    )
    .run();
  await writeAuditLog(db, { tenantId: p.tenant.id, userId: p.userId, action: "billing.proforma", details: `number=${number} reason=${p.reason} total=${quote.total} payment=${payment.id}` });
  return (await db.prepare("SELECT * FROM proformas WHERE id = ?").bind(id).first<Proforma>())!;
}

export async function listProformas(db: D1Database, tenantId: string, limit = 20): Promise<Proforma[]> {
  const { results } = await db.prepare("SELECT * FROM proformas WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?").bind(tenantId, limit).all<Proforma>();
  return results ?? [];
}

// ------------------------------------------------------------ email

/** The document as the email template's fields. */
export function documentMailFields(view: DocumentView, seller: Seller) {
  const pay = view.payUrl ? encodeQr(view.payUrl, "M") : null;
  return {
    kind: view.kind,
    number: view.number,
    date: documentDate(view.issuedAt),
    validUntil: view.validUntil ? documentDate(view.validUntil) : null,
    seller: {
      name: sellerLegalLine(seller) ? `${sellerName(seller)} (${sellerLegalLine(seller)})` : sellerName(seller),
      gstin: view.sellerGstin,
      address: seller.address || null
    },
    buyer: { name: view.buyer.name, gstin: view.buyer.gstin, address: view.buyer.address },
    lines: view.lines.map((l) => ({ description: l.description, amount: rupees(l.amount) })),
    totals: [
      ["Taxable value", rupees(view.subtotal)] as [string, string],
      ...(view.cgst ? [["CGST @ 9%", rupees(view.cgst)] as [string, string]] : []),
      ...(view.sgst ? [["SGST @ 9%", rupees(view.sgst)] as [string, string]] : []),
      ...(view.igst ? [["IGST @ 18%", rupees(view.igst)] as [string, string]] : [])
    ],
    total: rupees(view.total),
    totalInWords: amountInWords(view.total),
    qr: pay && pay.version <= 4 ? qrRows(pay) : null
  };
}

/** Email a document to the organization's owner, with a private link to it. Best effort. */
export async function emailDocument(
  env: Env,
  db: D1Database,
  tenant: Tenant,
  kind: DocumentKind,
  documentId: string,
  now: number,
  origin: string | null,
  wording: { subject: string; title: string; lead: string; text: string }
): Promise<boolean> {
  if (mailConfigProblem(env)) return false;
  const owner = tenant.user_id ? await findUserById(db, tenant.user_id) : null;
  const view = await documentView(db, tenant.id, kind, documentId);
  if (!owner || !view) return false;
  const seller = sellerFrom(env);
  const link = documentUrl(env, origin, await createDocumentLink(db, tenant.id, kind, documentId, now));
  const fields = documentMailFields(view, seller);
  try {
    await sendMail(env, {
      to: owner.email,
      toName: owner.name,
      subject: wording.subject,
      text:
        `${wording.lead}\n\n${fields.lines.map((l) => `${l.description}: ${l.amount}`).join("\n")}\n` +
        `${fields.totals.map(([k, v]) => `${k}: ${v}`).join("\n")}\nTotal: ${fields.total} (${fields.totalInWords})\n\n` +
        `${view.payUrl ? `Pay online: ${view.payUrl}\n` : ""}View or print: ${link}\n\n${wording.text}`,
      template: {
        name: "invoice",
        title: wording.title,
        lead: wording.lead,
        document: fields,
        action: view.payUrl ? { label: `Pay ${fields.total}`, url: view.payUrl } : { label: kind === "invoice" ? "View invoice" : "View proforma", url: link },
        viewUrl: link,
        note: wording.text
      }
    });
    return true;
  } catch (err) {
    console.error(`[Billing] Could not email ${kind} ${documentId} to the owner of ${tenant.id}:`, err);
    return false;
  }
}

// ------------------------------------------------------------ the hourly run

interface Candidate {
  tenant: Tenant;
  input: TierQuoteInput;
  reason: Proforma["reason"];
  endsAt: number;
}

/** Plans paid by payment link, and subscriptions cancelled, that end within the lead time and have no open proforma. */
async function proformaCandidates(db: D1Database, now: number): Promise<Candidate[]> {
  const until = now + PROFORMA_LEAD_DAYS * DAY;
  const out: Candidate[] = [];
  const noOpenProforma = "NOT EXISTS (SELECT 1 FROM proformas f WHERE f.tenant_id = t.id AND f.status = 'open')";
  const live = "NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.tenant_id = t.id AND s.status IN ('created', 'authenticated', 'active', 'pending', 'halted'))";
  const { results: legacy } = await db
    .prepare(
      `SELECT t.* FROM tenants t
        WHERE t.status = 'active' AND t.license_plan = 'subscriber' AND t.license_expires_at > ? AND t.license_expires_at <= ?
          AND ${live} AND ${noOpenProforma}
          AND NOT EXISTS (SELECT 1 FROM subscriptions s WHERE s.tenant_id = t.id AND s.status = 'cancelled' AND COALESCE(s.current_end, 0) > ?)
        LIMIT 50`
    )
    .bind(now, until, now)
    .all<Tenant>();
  for (const tenant of legacy ?? []) {
    const last = await db
      .prepare("SELECT tier, period, extra_workstations, remote_seats FROM payments WHERE tenant_id = ? AND status = 'paid' ORDER BY paid_at DESC LIMIT 1")
      .bind(tenant.id)
      .first<{ tier: SoldTier | null; period: BillingPeriod; extra_workstations: number; remote_seats: number }>();
    const tier = last?.tier ?? tenant.plan_tier ?? "standard";
    out.push({
      tenant,
      input: {
        tier,
        period: last?.period ?? "month",
        extraWorkstations: last ? Number(last.extra_workstations) : Math.max(0, (Number(tenant.workstation_limit) || 0) - CATALOGUE[tier].includedWorkstations),
        remoteSeats: last ? Number(last.remote_seats) || 0 : Number(tenant.remote_seats_paid) || 0
      },
      reason: "renewal",
      endsAt: Number(tenant.license_expires_at)
    });
  }
  const { results: cancelled } = await db
    .prepare(
      `SELECT t.*, s.tier AS s_tier, s.period AS s_period, s.extra_workstations AS s_extra, s.remote_seats AS s_seats, s.current_end AS s_end
         FROM subscriptions s JOIN tenants t ON t.id = s.tenant_id
        WHERE s.status = 'cancelled' AND COALESCE(s.cancel_reason, '') != 'replaced' AND s.current_end > ? AND s.current_end <= ?
          AND t.status = 'active' AND ${live} AND ${noOpenProforma}
        LIMIT 50`
    )
    .bind(now, until)
    .all<Tenant & { s_tier: SoldTier; s_period: BillingPeriod; s_extra: number; s_seats: number; s_end: number }>();
  for (const row of cancelled ?? []) {
    out.push({
      tenant: row,
      input: { tier: row.s_tier, period: row.s_period, extraWorkstations: Number(row.s_extra), remoteSeats: Number(row.s_seats) },
      reason: "cancelled",
      endsAt: Number(row.s_end)
    });
  }
  return out;
}

function periodAfter(from: number, period: BillingPeriod): number {
  const d = new Date(from * 1000);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + (period === "month" ? 1 : 12), 1, d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d.getUTCDate(), lastDay));
  return Math.floor(target.getTime() / 1000);
}

/**
 * The hourly run: a proforma for each plan about to end that will not renew
 * by itself, a reminder the day before, and open proformas past their date
 * closed. Returns how many emails went out.
 */
export async function runProformas(env: Env, db: D1Database, now: number, origin: string | null): Promise<number> {
  let sent = 0;
  await db.prepare("UPDATE proformas SET status = 'expired' WHERE status = 'open' AND valid_until <= ?").bind(now).run();
  for (const c of await proformaCandidates(db, now)) {
    try {
      // Education plans renew by application, not by payment: they get no proforma.
      if (entitlement(c.tenant, now).kind !== "subscription") continue;
      const proforma = await createProforma(env, db, {
        tenant: c.tenant,
        input: c.input,
        reason: c.reason,
        validUntil: c.endsAt,
        coversFrom: c.endsAt,
        coversTo: periodAfter(c.endsAt, c.input.period),
        userId: null,
        callbackUrl: `${origin || (env.DEFAULT_DOMAIN ? `https://${env.DEFAULT_DOMAIN}` : "")}/api/billing/return`,
        now
      });
      const ok = await emailDocument(env, db, c.tenant, "proforma", proforma.id, now, origin, {
        subject: `Proforma invoice ${proforma.number}: renew Lab Kiosk before ${documentDate(c.endsAt)}`,
        title: "Your plan is ending",
        lead:
          c.reason === "cancelled"
            ? `${c.tenant.name}'s subscription was cancelled and ends on ${documentDate(c.endsAt)}. To keep the plan, pay this proforma before then.`
            : `${c.tenant.name}'s plan ends on ${documentDate(c.endsAt)}. Pay this proforma before then to keep it for another ${c.input.period === "year" ? "year" : "month"}.`,
        text: "This is a proforma invoice, not a tax invoice: the tax invoice is emailed when the payment arrives. Prefer automatic renewal? Choose a plan under Plan & billing in your console."
      });
      if (ok) {
        sent++;
        await db.prepare("UPDATE proformas SET emailed_at = ? WHERE id = ?").bind(now, proforma.id).run();
      }
    } catch (err) {
      console.error(`[Billing] Could not prepare a proforma for ${c.tenant.id}:`, err instanceof Error ? err.message : err);
    }
  }
  const { results: due } = await db
    .prepare("SELECT * FROM proformas WHERE status = 'open' AND reminded_at IS NULL AND emailed_at IS NOT NULL AND valid_until <= ? LIMIT 50")
    .bind(now + REMINDER_LEAD_DAYS * DAY)
    .all<Proforma>();
  for (const p of due ?? []) {
    const tenant = await findTenantById(db, p.tenant_id);
    if (!tenant) continue;
    // Claim it first, so two runs never remind twice.
    const claimed = await db.prepare("UPDATE proformas SET reminded_at = ? WHERE id = ? AND reminded_at IS NULL").bind(now, p.id).run();
    if (!claimed.meta.changes) continue;
    if (
      await emailDocument(env, db, tenant, "proforma", p.id, now, origin, {
        subject: `Reminder: proforma ${p.number} is due by ${documentDate(Number(p.valid_until))}`,
        title: "Your plan ends tomorrow",
        lead: `${tenant.name}'s plan ends on ${documentDate(Number(p.valid_until))}. Pay this proforma to keep it without a break.`,
        text: "After that date the organization moves to the Free plan; nothing is deleted, and paying later restores the plan."
      })
    ) {
      sent++;
    }
  }
  return sent;
}

// ------------------------------------------------------------ GSTR-1

function csvCell(v: string | number): string {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const csv = (rows: Array<Array<string | number>>) => rows.map((r) => r.map(csvCell).join(",")).join("\r\n") + "\r\n";
const rs = (paise: number) => (paise / 100).toFixed(2);
const pos = (code: string | null, fallback: string | null) => {
  const c = code || fallback || "";
  return c ? `${c}-${GST_STATES[c] ?? ""}` : "";
};
/** The offline tool's dd-mmm-yyyy. */
const gstrDate = (seconds: number) => istParts(seconds).join("-");

export type Gstr1Section = "b2b" | "b2cl" | "b2cs" | "hsn" | "docs";
export const GSTR1_SECTIONS: readonly Gstr1Section[] = ["b2b", "b2cl", "b2cs", "hsn", "docs"];

/** The month's tax invoices (by their date in India) as one GSTR-1 section, in the offline tool's CSV columns. */
export async function gstr1Csv(env: Env, db: D1Database, month: string, section: Gstr1Section): Promise<string> {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) throw new Error("The month is YYYY-MM");
  const start = Date.UTC(Number(m[1]), Number(m[2]) - 1, 1) / 1000 - IST_OFFSET_SECONDS;
  const end = Date.UTC(Number(m[1]), Number(m[2]), 1) / 1000 - IST_OFFSET_SECONDS;
  const { results } = await db
    .prepare("SELECT * FROM invoices WHERE issued_at >= ? AND issued_at < ? AND seller_gstin IS NOT NULL ORDER BY number")
    .bind(start, end)
    .all<Invoice>();
  const invoices = results ?? [];
  const seller = sellerFrom(env);
  const rate = 18;
  const interState = (i: Invoice) => Number(i.igst_paise) > 0;
  const b2b = invoices.filter((i) => i.buyer_gstin);
  const unregistered = invoices.filter((i) => !i.buyer_gstin);
  const b2cl = unregistered.filter((i) => interState(i) && Number(i.total_paise) > B2CL_LIMIT_PAISE);
  const b2cs = unregistered.filter((i) => !b2cl.includes(i));
  switch (section) {
    case "b2b":
      return csv([
        ["GSTIN/UIN of Recipient", "Receiver Name", "Invoice Number", "Invoice date", "Invoice Value", "Place Of Supply", "Reverse Charge", "Applicable % of Tax Rate", "Invoice Type", "E-Commerce GSTIN", "Rate", "Taxable Value", "Cess Amount"],
        ...b2b.map((i) => [i.buyer_gstin!, i.buyer_name, i.number, gstrDate(Number(i.issued_at)), rs(Number(i.total_paise)), pos(i.place_of_supply, seller.state), "N", "", "Regular B2B", "", rate, rs(Number(i.subtotal_paise)), "0.00"])
      ]);
    case "b2cl":
      return csv([
        ["Invoice Number", "Invoice date", "Invoice Value", "Place Of Supply", "Applicable % of Tax Rate", "Rate", "Taxable Value", "Cess Amount", "E-Commerce GSTIN"],
        ...b2cl.map((i) => [i.number, gstrDate(Number(i.issued_at)), rs(Number(i.total_paise)), pos(i.place_of_supply, seller.state), "", rate, rs(Number(i.subtotal_paise)), "0.00", ""])
      ]);
    case "b2cs": {
      const byState = new Map<string, number>();
      for (const i of b2cs) {
        const key = pos(i.place_of_supply, seller.state);
        byState.set(key, (byState.get(key) ?? 0) + Number(i.subtotal_paise));
      }
      return csv([
        ["Type", "Place Of Supply", "Applicable % of Tax Rate", "Rate", "Taxable Value", "Cess Amount", "E-Commerce GSTIN"],
        ...[...byState.entries()].sort().map(([state, value]) => ["OE", state, "", rate, rs(value), "0.00", ""])
      ]);
    }
    case "hsn": {
      const sum = (f: (i: Invoice) => number) => invoices.reduce((a, i) => a + f(i), 0);
      return csv([
        ["HSN", "Description", "UQC", "Total Quantity", "Total Value", "Rate", "Taxable Value", "Integrated Tax Amount", "Central Tax Amount", "State/UT Tax Amount", "Cess Amount"],
        ...(invoices.length
          ? [[seller.sac ?? "", "Lab Kiosk subscription", "NA", invoices.length, rs(sum((i) => Number(i.total_paise))), rate, rs(sum((i) => Number(i.subtotal_paise))), rs(sum((i) => Number(i.igst_paise))), rs(sum((i) => Number(i.cgst_paise))), rs(sum((i) => Number(i.sgst_paise))), "0.00"]]
          : [])
      ]);
    }
    case "docs": {
      const numbers = invoices.map((i) => i.number).sort();
      return csv([
        ["Nature of Document", "Sr. No. From", "Sr. No. To", "Total Number", "Cancelled"],
        ...(numbers.length ? [["Invoices for outward supply", numbers[0], numbers.at(-1)!, numbers.length, 0]] : [])
      ]);
    }
  }
}

/**
 * "Payment received", with the tax invoice the payment was given: after a
 * subscription charge and after a payment link (a proforma's or the
 * platform's). Best effort; false when there is no invoice or no mail.
 */
export async function emailPaidInvoice(
  env: Env,
  db: D1Database,
  tenant: Tenant,
  sourceId: string,
  now: number,
  origin: string | null,
  summary: { plan: string; paidUntil: string | null }
): Promise<boolean> {
  const invoice = await db
    .prepare("SELECT id, number FROM invoices WHERE tenant_id = ? AND source_id = ? ORDER BY issued_at DESC, number DESC LIMIT 1")
    .bind(tenant.id, sourceId)
    .first<{ id: string; number: string }>();
  if (!invoice) return false;
  const tax = Boolean(sellerFrom(env).gstin);
  return emailDocument(env, db, tenant, "invoice", invoice.id, now, origin, {
    subject: `Payment received: ${tax ? "tax invoice" : "receipt"} ${invoice.number}`,
    title: "Payment received",
    lead: `Thank you. ${tenant.name} is on ${summary.plan}${summary.paidUntil ? `, paid until ${summary.paidUntil}` : ""}.`,
    text: "Every invoice is also under Plan & billing in your console."
  });
}
