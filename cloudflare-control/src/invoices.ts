/**
 * Tax invoices for what organizations pay: one per captured Razorpay charge,
 * numbered without gaps per Indian financial year ("LK/26-27/000001").
 *
 * The figures are copied from what was sold (a subscriptions or payments row),
 * never recomputed. GST is charged only once the seller is registered: until
 * SELLER_GSTIN holds a valid GSTIN, gstPercentFor() is 0 and an invoice is a
 * receipt with no tax lines. With a GSTIN, a buyer in the seller's state
 * (SELLER_STATE) pays CGST + SGST, anyone else IGST; a buyer with no state on
 * record is taxed as in the seller's state, the place of supply for a
 * service whose recipient's address is unknown.
 */

import type { Env, Tenant } from "./types";

export const GST_PERCENT = 18;
const INVOICE_PREFIX = "LK";
/** Indian Standard Time, for the financial year an invoice falls in. */
const IST_OFFSET_SECONDS = 19_800;

/** GST state codes and names, for the place of supply. */
export const GST_STATES: Readonly<Record<string, string>> = Object.freeze({
  "01": "Jammu and Kashmir",
  "02": "Himachal Pradesh",
  "03": "Punjab",
  "04": "Chandigarh",
  "05": "Uttarakhand",
  "06": "Haryana",
  "07": "Delhi",
  "08": "Rajasthan",
  "09": "Uttar Pradesh",
  "10": "Bihar",
  "11": "Sikkim",
  "12": "Arunachal Pradesh",
  "13": "Nagaland",
  "14": "Manipur",
  "15": "Mizoram",
  "16": "Tripura",
  "17": "Meghalaya",
  "18": "Assam",
  "19": "West Bengal",
  "20": "Jharkhand",
  "21": "Odisha",
  "22": "Chhattisgarh",
  "23": "Madhya Pradesh",
  "24": "Gujarat",
  "26": "Dadra and Nagar Haveli and Daman and Diu",
  "27": "Maharashtra",
  "29": "Karnataka",
  "30": "Goa",
  "31": "Lakshadweep",
  "32": "Kerala",
  "33": "Tamil Nadu",
  "34": "Puducherry",
  "35": "Andaman and Nicobar Islands",
  "36": "Telangana",
  "37": "Andhra Pradesh",
  "38": "Ladakh"
});

const GSTIN_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * Whether a GSTIN is well formed: two digits of a known state, a PAN, the
 * entity number, "Z" and the check character of the GST Network's mod-36 sum.
 */
export function validGstin(value: string): boolean {
  if (!/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/.test(value)) return false;
  if (!GST_STATES[value.slice(0, 2)]) return false;
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    const product = GSTIN_CHARS.indexOf(value.charAt(i)) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return GSTIN_CHARS.charAt((36 - (sum % 36)) % 36) === value.charAt(14);
}

export interface Seller {
  legalName: string;
  /** The trade name on the registration, or null; a proprietorship's legal name is the proprietor's own. */
  tradeName: string | null;
  address: string;
  state: string | null;
  gstin: string | null;
  sac: string | null;
}

/** The seller as configured; a GSTIN that is not valid counts as none. */
export function sellerFrom(env: Env): Seller {
  const gstin = (env.SELLER_GSTIN || "").trim().toUpperCase();
  const state = (env.SELLER_STATE || "").trim();
  const sac = (env.SELLER_SAC || "").trim();
  return {
    legalName: (env.SELLER_LEGAL_NAME || "").trim() || "Lab Kiosk",
    tradeName: (env.SELLER_TRADE_NAME || "").trim() || null,
    address: (env.SELLER_ADDRESS || "").trim(),
    state: GST_STATES[state] ? state : null,
    gstin: gstin && validGstin(gstin) ? gstin : null,
    sac: /^\d{4,8}$/.test(sac) ? sac : null
  };
}

/** The name a document leads with: the trade name, else the legal name. */
export function sellerName(seller: Seller): string {
  return seller.tradeName || seller.legalName;
}

/** The legal name, when the document leads with a different trade name. */
export function sellerLegalLine(seller: Seller): string | null {
  return seller.tradeName && seller.tradeName.toUpperCase() !== seller.legalName.toUpperCase() ? seller.legalName : null;
}

/** The GST rate to charge: 18% once the seller has a valid GSTIN, else none. */
export function gstPercentFor(env: Env): number {
  return sellerFrom(env).gstin ? GST_PERCENT : 0;
}

/**
 * GST Rule 46 caps an invoice's serial number at 16 characters: "LK/26-27/000001"
 * is 15. The counter is kept per financial year under its long name.
 */
export function shortFinancialYear(unixSeconds: number): string {
  return financialYear(unixSeconds).slice(2);
}

/** "2026-27" for any moment from 1 April 2026 to 31 March 2027, in IST. */
export function financialYear(unixSeconds: number): string {
  const d = new Date((unixSeconds + IST_OFFSET_SECONDS) * 1000);
  const start = d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

export interface TaxSplit {
  cgst: number;
  sgst: number;
  igst: number;
  placeOfSupply: string | null;
}

/** How a GST amount (paise) splits between the centre and the states. */
export function splitGst(gst: number, sellerState: string | null, buyerState: string | null): TaxSplit {
  const place = buyerState && GST_STATES[buyerState] ? buyerState : sellerState;
  if (gst === 0) return { cgst: 0, sgst: 0, igst: 0, placeOfSupply: place };
  if (!sellerState || place === sellerState) {
    const cgst = Math.floor(gst / 2);
    return { cgst, sgst: gst - cgst, igst: 0, placeOfSupply: place };
  }
  return { cgst: 0, sgst: 0, igst: gst, placeOfSupply: place };
}

export interface InvoiceLine {
  description: string;
  /** Paise, before GST. */
  amount: number;
}

export interface Invoice {
  id: string;
  number: string;
  tenant_id: string;
  source: "subscription" | "payment";
  source_id: string;
  razorpay_payment_id: string;
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
  issued_at: number;
}

/**
 * The two statements that issue an invoice for a captured charge, to run in
 * one batch (one transaction) with whatever the charge grants. Both do
 * nothing when the payment already has an invoice, so the counter never skips
 * a number and a payment is never invoiced twice.
 */
export function invoiceStatements(
  db: D1Database,
  env: Env,
  input: {
    id: string;
    tenant: Pick<Tenant, "id" | "name" | "billing_legal_name" | "billing_gstin" | "billing_address" | "billing_state">;
    source: "subscription" | "payment";
    sourceId: string;
    razorpayPaymentId: string;
    subtotal: number;
    gst: number;
    total: number;
    lines: InvoiceLine[];
    issuedAt: number;
  }
): D1PreparedStatement[] {
  const seller = sellerFrom(env);
  const fy = financialYear(input.issuedAt);
  const split = splitGst(input.gst, seller.state, input.tenant.billing_state ?? null);
  const prefix = `${INVOICE_PREFIX}/${shortFinancialYear(input.issuedAt)}/`;
  return [
    db
      .prepare(
        `INSERT INTO invoice_counters (fy, next)
           SELECT ?, 1 WHERE NOT EXISTS (SELECT 1 FROM invoices WHERE razorpay_payment_id = ?)
         ON CONFLICT(fy) DO UPDATE SET next = next + 1`
      )
      .bind(fy, input.razorpayPaymentId),
    db
      .prepare(
        `INSERT INTO invoices (id, number, tenant_id, source, source_id, razorpay_payment_id, subtotal_paise, cgst_paise, sgst_paise,
                               igst_paise, total_paise, seller_gstin, buyer_name, buyer_gstin, buyer_address, place_of_supply, lines_json, issued_at)
         SELECT ?, ? || printf('%06d', next), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           FROM invoice_counters
          WHERE fy = ? AND NOT EXISTS (SELECT 1 FROM invoices WHERE razorpay_payment_id = ?)`
      )
      .bind(
        input.id,
        prefix,
        input.tenant.id,
        input.source,
        input.sourceId,
        input.razorpayPaymentId,
        input.subtotal,
        split.cgst,
        split.sgst,
        split.igst,
        input.total,
        seller.gstin,
        (input.tenant.billing_legal_name || input.tenant.name).slice(0, 200),
        input.tenant.billing_gstin ?? null,
        input.tenant.billing_address ?? null,
        split.placeOfSupply,
        JSON.stringify(input.lines),
        input.issuedAt,
        fy,
        input.razorpayPaymentId
      )
  ];
}

export async function listInvoices(db: D1Database, tenantId: string, limit = 100): Promise<Invoice[]> {
  const { results } = await db
    .prepare("SELECT * FROM invoices WHERE tenant_id = ? ORDER BY issued_at DESC, number DESC LIMIT ?")
    .bind(tenantId, Math.min(Math.max(limit, 1), 500))
    .all<Invoice>();
  return results ?? [];
}

export async function findInvoice(db: D1Database, tenantId: string, id: string): Promise<Invoice | null> {
  return db.prepare("SELECT * FROM invoices WHERE tenant_id = ? AND id = ?").bind(tenantId, id).first<Invoice>();
}
