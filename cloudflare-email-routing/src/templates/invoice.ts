/**
 * A billing document in the body of a message: the proforma invoice sent
 * before a plan ends (with its payment link and a QR code for it), or the tax
 * invoice issued when a payment arrives. The figures are the document's own,
 * already formatted by the controller; the full document, to view and print,
 * is behind `viewUrl`.
 *
 * The QR code is a table of cells, not an image: images are blocked until a
 * reader asks for them, and a code that needs a click before it shows is no
 * use on a phone. Each row merges its runs of one colour into one cell, which
 * keeps a version-4 code (33 modules) to a few kilobytes.
 */

import { Brand, button, COLOR, esc, FONT, label, layout, MONO, panel, paragraphs, safeUrl } from "./layout";

export interface InvoiceParty {
  name: string;
  gstin: string | null;
  address: string | null;
}

export interface InvoiceDocument {
  kind: "invoice" | "proforma";
  number: string;
  date: string;
  /** Proforma only: pay by this date. */
  validUntil: string | null;
  seller: InvoiceParty;
  buyer: InvoiceParty;
  lines: Array<{ description: string; amount: string }>;
  /** Taxable value and each tax, in order. */
  totals: Array<[string, string]>;
  total: string;
  totalInWords: string;
  /** The payment link's QR code as rows of dark (true) modules, quiet zone included. */
  qr: boolean[][] | null;
}

export interface InvoiceTemplate {
  name: "invoice";
  title: string;
  lead: string;
  document: InvoiceDocument;
  /** Pay, for a proforma; view, for an invoice. */
  action?: { label: string; url: string } | null;
  /** The document's own page, to view and print. */
  viewUrl?: string | null;
  /** A closing paragraph. */
  note?: string | null;
}

/** Largest code drawn: version 4 (33 modules) and its quiet zone. */
const MAX_QR_SIDE = 41;
const MAX_LINES = 50;
const QR_CELL_PX = 4;

function qrRowsOf(value: unknown): boolean[][] | null {
  if (!Array.isArray(value) || value.length < 21 || value.length > MAX_QR_SIDE) return null;
  const side = value.length;
  for (const row of value) {
    if (!Array.isArray(row) || row.length !== side || row.some((c) => typeof c !== "boolean")) return null;
  }
  return value as boolean[][];
}

/** The code as a table; its runs of one colour are one cell each. */
function qrTable(rows: boolean[][]): string {
  const side = rows.length * QR_CELL_PX;
  const body = rows
    .map((row) => {
      let cells = "";
      for (let x = 0; x < row.length; ) {
        let end = x;
        while (end < row.length && row[end] === row[x]) end++;
        const span = end - x;
        const width = span * QR_CELL_PX;
        cells += row[x]
          ? `<td colspan="${span}" width="${width}" bgcolor="#000000" style="width:${width}px;background:#000000"></td>`
          : `<td colspan="${span}" width="${width}" style="width:${width}px"></td>`;
        x = end;
      }
      return `<tr style="height:${QR_CELL_PX}px">${cells}</tr>`;
    })
    .join("");
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="${side}" bgcolor="#ffffff" style="width:${side}px;height:${side}px;border-collapse:collapse;table-layout:fixed;background:#ffffff;font-size:0;line-height:0" aria-label="QR code for the payment link">${body}</table>`;
}

function party(heading: string, p: InvoiceParty | undefined, unregistered: string): string {
  const name = String(p?.name ?? "");
  const address = String(p?.address ?? "").trim();
  const gstin = String(p?.gstin ?? "").trim();
  return `${label(heading)}
<div style="font-size:14px;line-height:21px;font-weight:600;color:${COLOR.heading}" class="lk-heading">${esc(name)}</div>
${address ? `<div class="lk-muted" style="font-size:13px;line-height:19px;color:${COLOR.muted}">${address.split(/\r?\n/).map(esc).join("<br>")}</div>` : ""}
<div class="lk-muted" style="font-size:13px;line-height:19px;color:${COLOR.muted}">${gstin ? `GSTIN <span style="font-family:${MONO}">${esc(gstin)}</span>` : esc(unregistered)}</div>`;
}

export function renderInvoice(t: InvoiceTemplate, subject: string, brand: Brand): string {
  const d = (t.document ?? {}) as Partial<InvoiceDocument>;
  const proforma = d.kind === "proforma";
  const heading = proforma ? "Proforma invoice" : d.seller?.gstin ? "Tax invoice" : "Receipt";
  const lines = (Array.isArray(d.lines) ? d.lines : []).slice(0, MAX_LINES);
  const totals = (Array.isArray(d.totals) ? d.totals : []).filter((r) => Array.isArray(r) && r.length === 2);
  const qr = proforma ? qrRowsOf(d.qr) : null;
  const action = t.action && safeUrl(t.action.url) ? t.action : null;
  const view = safeUrl(t.viewUrl);

  const meta = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
  <td valign="top">${label(heading)}
    <div class="lk-code" style="font-family:${MONO};font-size:18px;line-height:26px;font-weight:700;color:${COLOR.heading}">${esc(d.number)}</div></td>
  <td valign="top" align="right" class="lk-muted" style="font-size:13px;line-height:20px;color:${COLOR.muted}">Date ${esc(d.date)}${proforma && d.validUntil ? `<br>Pay by <strong>${esc(d.validUntil)}</strong>` : ""}</td>
</tr></table>`;

  const parties = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:16px"><tr>
  <td valign="top" width="50%" style="padding-right:12px">${party("From", d.seller, "")}</td>
  <td valign="top" width="50%" style="padding-left:12px">${party("Billed to", d.buyer, "Unregistered (no GSTIN)")}</td>
</tr></table>`;

  const cell = `padding:8px 0;border-top:1px solid ${COLOR.border};font-size:14px;line-height:20px`;
  const lineRows = lines
    .map((l) => `<tr><td class="lk-rule" style="${cell};padding-right:12px">${esc(l?.description)}</td><td class="lk-rule" align="right" style="${cell};white-space:nowrap">${esc(l?.amount)}</td></tr>`)
    .join("");
  const totalRows = totals
    .map(([k, v]) => `<tr><td class="lk-muted lk-rule" align="right" style="${cell};padding-right:12px;color:${COLOR.muted}">${esc(k)}</td><td class="lk-rule" align="right" style="${cell};white-space:nowrap">${esc(v)}</td></tr>`)
    .join("");
  const figures = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:18px">
${lineRows}${totalRows}
<tr><td class="lk-heading lk-rule" align="right" style="padding:10px 12px 4px 0;border-top:2px solid ${COLOR.heading};font-size:16px;line-height:22px;font-weight:700;color:${COLOR.heading}">Total</td><td class="lk-heading lk-rule" align="right" style="padding:10px 0 4px;border-top:2px solid ${COLOR.heading};font-size:16px;line-height:22px;font-weight:700;color:${COLOR.heading};white-space:nowrap">${esc(d.total)}</td></tr>
</table>
<div class="lk-muted" style="font-size:12px;line-height:18px;color:${COLOR.muted};text-align:right">${esc(d.totalInWords)}</div>`;

  const notice = proforma
    ? `<div class="lk-muted" style="margin-top:14px;font-size:12px;line-height:18px;color:${COLOR.muted}">This is a proforma invoice, not a tax invoice. The tax invoice is emailed when the payment arrives.</div>`
    : "";

  const pay =
    qr && action
      ? panel(
          `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
  <td valign="middle" style="padding-right:18px">${qrTable(qr)}</td>
  <td valign="middle" style="font-family:${FONT};font-size:14px;line-height:21px">${label("Pay online")}Scan with any UPI app or phone camera, or use the button below, to pay by UPI, card or netbanking.</td>
</tr></table>`,
          "accent"
        )
      : "";

  return layout({
    brand,
    subject,
    kind: proforma ? "Proforma invoice" : "Invoice",
    preheader: String(t.lead ?? "").slice(0, 140),
    title: t.title,
    bodyHtml:
      paragraphs(t.lead) +
      panel(meta + parties + figures + notice, "neutral") +
      pay +
      (action ? button(action.label, action.url) : "") +
      (view && view !== (action ? safeUrl(action.url) : null)
        ? `<p style="margin:0 0 16px;font-size:13px;line-height:20px">View or print the full ${esc(heading.toLowerCase())}: <a href="${esc(view)}" style="color:${COLOR.accent};text-decoration:underline">open it in your browser</a>.</p>`
        : "") +
      paragraphs(String(t.note ?? "")),
    reason: "You are receiving this because you manage an organization's Lab Kiosk plan."
  });
}
