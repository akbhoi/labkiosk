/**
 * Plan & billing: what the organization runs under and pays for, and how to
 * change it. The current plan and its renewal, usage against the plan's
 * limits, the tiers with a live price (src/billing_routes.ts), Remote Control
 * seats, staff over the cap, billing details and GST invoices; the free trial
 * and the Education application (src/plan_routes.ts); and which workstations
 * keep their licence when more are enrolled than the plan covers. For an
 * account holding the `settings` permission.
 */

import { escapeAttr, escapeHtml, escapeJson } from "./escape";
import { EDUCATION_LIMITS } from "./education";
import { CUSTOM_PLAN_LIMITS } from "./custom_plans";
import { MAX_REMOTE_CONTROL_SEATS, MAX_WORKSTATION_LIMIT } from "./db";
import { CATALOGUE, PAID_TIERS, PRICING, STAFF_LIMITS } from "./plans";
import { AdminPageInput, AdminPageParts } from "./ui_admin_shared";

export function buildPlanPage(options: AdminPageInput): AdminPageParts {
  const contactHref = options.tenantParam ? "/contact?reason=sales" : `https://${options.baseDomain}/contact?reason=sales`;
  return {
    title: "Plan & billing",
    contentHtml: renderPlanPageHtml(contactHref),
    scriptsHtml: renderPlanScript(options.nonce, contactHref)
  };
}

const BOARDS = ["CBSE", "CISCE (ICSE / ISC)", "State board", "NIOS", "IB", "Cambridge (CAIE)", "UGC", "AICTE", "State university"];

/** What each tier adds beyond its limits; the same words as /pricing, where every console feature is in every plan. */
const TIER_POINTS: Record<string, string[]> = {
  starter: ["Every console feature, including exams and usage reports", "Remote Control as an add-on", "Email support"],
  standard: ["Every console feature, including exams and usage reports", "Remote Control as an add-on", "Email support"],
  pro: [`Remote Control on ${CATALOGUE.pro.includedRemoteSeats} workstations included`, "Priority support"]
};

function tierCard(tier: (typeof PAID_TIERS)[number]): string {
  const t = CATALOGUE[tier];
  const points = [
    `${t.includedWorkstations} workstations, then ₹${t.extraMonthly} a month each`,
    `${t.staff} staff accounts`,
    ...TIER_POINTS[tier]
  ];
  return `
        <div class="card tier-card${tier === "standard" ? " tier-featured" : ""}" data-tier-card="${escapeAttr(tier)}">
          <div class="tier-head">
            <h3 class="card-title mb-0">${escapeHtml(t.label)}</h3>
            ${tier === "standard" ? '<span class="badge badge-blue">Most chosen</span>' : ""}
            <span class="badge badge-green hidden" data-tier-current>Current plan</span>
          </div>
          <div class="plan-price"><span data-tier-price="${escapeAttr(tier)}">₹${t.monthly.toLocaleString("en-IN")}</span> <small data-tier-per>a month</small></div>
          <p class="tier-note" data-tier-note="${escapeAttr(tier)}">Billed monthly, before GST</p>
          <ul class="plan-list">${points.map((p) => `<li>${escapeHtml(p)}</li>`).join("")}</ul>
          <div class="plan-foot">
            <button type="button" class="btn btn-secondary btn-block" data-choose-tier="${escapeAttr(tier)}">Choose ${escapeHtml(t.label)}</button>
          </div>
        </div>`;
}

function renderPlanPageHtml(contactHref: string): string {
  const p = PRICING;
  return `
    <style>
      .plan-grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(min(260px, 100%), 1fr)); }
      .plan-grid > .card { margin: 0; display: flex; flex-direction: column; }
      .plan-price { font-size: 1.75rem; font-weight: 700; letter-spacing: -0.02em; margin: 8px 0 2px; }
      .plan-price small { font-size: 0.875rem; font-weight: 500; color: var(--text-muted); }
      .plan-list { margin: 12px 0 16px; padding-left: 18px; color: var(--text-muted); font-size: 0.875rem; line-height: 1.7; }
      .plan-foot { margin-top: auto; }
      .plan-period { display: inline-flex; gap: 4px; padding: 3px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-subtle); }
      .plan-period button { border: 0; background: transparent; color: var(--text-muted); padding: 6px 12px; border-radius: var(--radius-xs); font: inherit; font-size: 0.8125rem; cursor: pointer; }
      .plan-period button[aria-pressed="true"] { background: var(--bg-surface); color: var(--text-main); font-weight: 600; box-shadow: var(--shadow-sm); }
      .tier-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
      .tier-note { font-size: 0.8125rem; color: var(--text-muted); margin: 0; }
      .tier-featured { border-color: var(--accent); }
      .tier-card.is-current { border-color: var(--success); }
      .btn-block { width: 100%; justify-content: center; }
      #form-details .form-row { margin-bottom: 16px; }
      .section-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; margin: 32px 0 12px; }
      .section-head h2 { font-size: 1.0625rem; margin: 0; }
      .overview { display: grid; gap: 16px; grid-template-columns: minmax(0, 1fr) auto; align-items: start; }
      .overview-name { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
      .overview-name h2 { font-size: 1.375rem; margin: 0; }
      .overview-lines { margin: 8px 0 0; color: var(--text-muted); font-size: 0.875rem; line-height: 1.7; }
      .overview-lines strong { color: var(--text-main); }
      .overview-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
      .usage-meter { height: 6px; border-radius: 999px; background: var(--bg-subtle); overflow: hidden; margin-top: 10px; }
      .usage-meter > span { display: block; height: 100%; width: 0; background: var(--accent); border-radius: inherit; transition: width 200ms var(--ease-out, ease); }
      .usage-meter.is-near > span { background: var(--warning); }
      .usage-meter.is-full > span { background: var(--danger); }
      .config-grid { display: grid; gap: 24px; grid-template-columns: minmax(0, 1fr) minmax(min(300px, 100%), 360px); }
      .stepper { display: inline-flex; align-items: stretch; border: 1px solid var(--border-input); border-radius: var(--radius-sm); overflow: hidden; }
      .stepper button { border: 0; background: var(--bg-subtle); color: var(--text-main); width: 36px; font: inherit; font-size: 1rem; cursor: pointer; }
      .stepper input { width: 72px; border: 0; text-align: center; font: inherit; background: var(--bg-surface); color: var(--text-main); }
      .summary { border: 1px solid var(--border); border-radius: var(--radius-md); padding: 16px; background: var(--bg-subtle); }
      .summary-row { display: flex; justify-content: space-between; gap: 12px; font-size: 0.875rem; padding: 4px 0; color: var(--text-muted); }
      .summary-row strong { color: var(--text-main); font-variant-numeric: tabular-nums; }
      .summary-total { border-top: 1px solid var(--border); margin-top: 8px; padding-top: 10px; font-size: 1rem; color: var(--text-main); }
      .summary-now { font-size: 0.875rem; margin: 12px 0; }
      .money { font-variant-numeric: tabular-nums; white-space: nowrap; }
      .doc-actions { display: flex; gap: 6px; justify-content: flex-end; flex-wrap: wrap; }
      @container canvas (max-width: 760px) {
        .overview, .config-grid { grid-template-columns: minmax(0, 1fr); }
        .overview-actions { justify-content: flex-start; }
      }
    </style>
    <div class="page-head">
      <div>
        <h1 class="page-title">Plan &amp; billing</h1>
        <p class="page-desc">Your plan, what it covers, what it costs and when it renews. Change or cancel it here at any time.</p>
      </div>
    </div>

    <div id="billing-banners"></div>

    <div class="card" id="plan-current">
      <div class="overview">
        <div>
          <div class="overview-name">
            <h2 id="plan-name">Loading…</h2>
            <span class="badge badge-neutral hidden" id="plan-status"></span>
          </div>
          <p class="overview-lines" id="plan-lines"></p>
        </div>
        <div class="overview-actions">
          <button type="button" class="btn btn-secondary hidden" id="btn-change">Change plan</button>
          <button type="button" class="btn btn-secondary hidden" id="btn-resume">Resume subscription</button>
          <button type="button" class="btn btn-ghost hidden" id="btn-cancel">Cancel subscription</button>
        </div>
      </div>
    </div>

    <div class="stat-grid mt-lg" id="usage">
      <div class="stat-tile"><div class="stat-tile-label">Workstations</div><div class="stat-tile-value" id="use-ws">–</div><div class="usage-meter" id="meter-ws"><span></span></div></div>
      <div class="stat-tile"><div class="stat-tile-label">Staff accounts</div><div class="stat-tile-value" id="use-staff">–</div><div class="usage-meter" id="meter-staff"><span></span></div></div>
      <div class="stat-tile"><div class="stat-tile-label">Remote Control seats</div><div class="stat-tile-value" id="use-rc">–</div><div class="usage-meter" id="meter-rc"><span></span></div></div>
    </div>

    <div class="section-head" id="plans">
      <h2>Plans</h2>
      <div class="plan-period" role="group" aria-label="Billing period">
        <button type="button" data-period="month" aria-pressed="false">Monthly</button>
        <button type="button" data-period="year" aria-pressed="true">Yearly, 2 months free</button>
      </div>
    </div>
    <div class="plan-grid">${PAID_TIERS.map(tierCard).join("")}
    </div>
    <p class="form-hint">Prices are before GST where it applies. More than ${p.salesAbove} workstations or several sites? Ask for a <a href="#custom-status">Custom plan</a>, or <a href="${escapeAttr(contactHref)}" target="_blank" rel="noopener">talk to sales</a>.</p>

    <div class="card mt-lg hidden" id="plan-config">
      <h2 class="card-title" id="config-title">Your plan</h2>
      <p class="card-sub">Choose how many workstations and Remote Control seats you need. The price updates as you go.</p>
      <div class="config-grid">
        <div>
          <div class="form-group">
            <label class="form-label" for="cfg-extra">Workstations beyond the <span id="cfg-included">0</span> included</label>
            <div class="stepper"><button type="button" data-step="cfg-extra" data-by="-1" aria-label="Fewer workstations">−</button><input type="number" id="cfg-extra" min="0" step="1" value="0" inputmode="numeric"><button type="button" data-step="cfg-extra" data-by="1" aria-label="More workstations">+</button></div>
            <p class="form-hint" id="cfg-extra-hint"></p>
          </div>
          <div class="form-group">
            <label class="form-label" for="cfg-seats">Remote Control seats</label>
            <div class="stepper"><button type="button" data-step="cfg-seats" data-by="-1" aria-label="Fewer seats">−</button><input type="number" id="cfg-seats" min="0" step="1" value="0" inputmode="numeric"><button type="button" data-step="cfg-seats" data-by="1" aria-label="More seats">+</button></div>
            <p class="form-hint" id="cfg-seats-hint">Each seat lets an administrator see and control one workstation's screen. Move a seat to another workstation at any time.</p>
          </div>
          <div class="callout callout-warning hidden" id="cfg-losses" role="status"></div>
        </div>
        <div class="summary" aria-live="polite">
          <div class="summary-row"><span id="sum-base-label">Plan</span><strong class="money" id="sum-base">–</strong></div>
          <div class="summary-row hidden" id="row-extras"><span id="sum-extras-label">Extra workstations</span><strong class="money" id="sum-extras">–</strong></div>
          <div class="summary-row hidden" id="row-remote"><span id="sum-remote-label">Remote Control</span><strong class="money" id="sum-remote">–</strong></div>
          <div class="summary-row hidden" id="row-gst"><span id="sum-gst-label">GST</span><strong class="money" id="sum-gst">–</strong></div>
          <div class="summary-row summary-total"><span id="sum-total-label">Total</span><strong class="money" id="sum-total">–</strong></div>
          <p class="summary-now" id="sum-now"></p>
          <button type="button" class="btn btn-primary btn-block" id="btn-checkout">Continue to payment</button>
          <p class="form-hint">Payments go through Razorpay by card, UPI or netbanking. Renews automatically until you cancel; <a href="/refunds" target="_blank" rel="noopener">refund policy</a>.</p>
        </div>
      </div>
    </div>

    <div class="section-head"><h2>Other ways to run Lab Kiosk</h2></div>
    <div class="plan-grid">
      <div class="card" id="plan-trial">
        <h3 class="card-title">Free trial</h3>
        <div class="plan-price">₹0 <small>for ${p.trialDays} days</small></div>
        <ul class="plan-list">
          <li>Standard on ${p.includedWorkstations} workstations, no card needed</li>
          <li>Once per organization; afterwards Free (${p.freeWorkstations} workstations) unless you subscribe</li>
        </ul>
        <div class="plan-foot">
          <button type="button" class="btn btn-secondary" id="btn-trial">Start the ${p.trialDays}-day trial</button>
          <p class="form-hint hidden" id="trial-note"></p>
        </div>
      </div>
      <div class="card" id="plan-education">
        <h3 class="card-title">Education</h3>
        <div class="plan-price">₹0 <small>for verified institutions</small></div>
        <ul class="plan-list">
          <li>${p.educationWorkstations} workstations and ${CATALOGUE.education.staff} staff, for a year at a time</li>
          <li>Remote Control at half price; we check every application by hand</li>
        </ul>
        <div class="plan-foot" id="edu-status"></div>
      </div>
      <div class="card">
        <h3 class="card-title">Custom</h3>
        <div class="plan-price"><small>For large or multi-site deployments</small></div>
        <ul class="plan-list">
          <li>More than ${p.salesAbove} workstations, invoicing and purchase orders</li>
          <li>Your own domain for the console and homepage</li>
          <li>Priced by Lab Kiosk and paid by a payment link we email you</li>
        </ul>
        <div class="plan-foot" id="custom-status"></div>
      </div>
    </div>

    <div class="card mt-lg hidden" id="section-custom-form">
      <h2 class="card-title">Ask for a Custom plan</h2>
      <p class="card-sub">Tell us what you need. We email a payment link with the price, usually within two working days, and the plan starts as soon as it is paid.</p>
      <form id="form-custom" novalidate>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label" for="cp-workstations">Workstations</label>
            <input type="number" class="form-input" id="cp-workstations" min="1" max="${MAX_WORKSTATION_LIMIT}" step="1" inputmode="numeric" required>
          </div>
          <div class="form-group">
            <label class="form-label" for="cp-seats">Remote Control seats</label>
            <input type="number" class="form-input" id="cp-seats" min="0" max="${MAX_REMOTE_CONTROL_SEATS}" step="1" value="0" inputmode="numeric">
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label" for="cp-staff">Staff accounts (optional)</label>
            <input type="number" class="form-input" id="cp-staff" min="1" max="${CUSTOM_PLAN_LIMITS.staff}" step="1" inputmode="numeric" placeholder="${STAFF_LIMITS.custom}">
          </div>
          <div class="form-group">
            <label class="form-label" for="cp-period">Billing</label>
            <select class="form-select" id="cp-period"><option value="year">Yearly</option><option value="month">Monthly</option></select>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label" for="cp-notes">Anything else (optional)</label>
          <textarea class="form-textarea" id="cp-notes" rows="3" maxlength="${CUSTOM_PLAN_LIMITS.notes}" placeholder="Sites, purchase orders, invoicing needs"></textarea>
        </div>
        <p class="callout callout-danger hidden" id="cp-error" role="alert"></p>
        <div class="form-actions">
          <button type="button" class="btn btn-ghost" id="btn-cp-cancel">Cancel</button>
          <button type="submit" class="btn btn-primary">Send request</button>
        </div>
      </form>
    </div>

    <div class="card mt-lg hidden" id="section-education-form">
      <h2 class="card-title">Apply for Education</h2>
      <p class="card-sub">We email a code to the address you give, which must be on your institution website's own domain, then read your certificate and decide within a few working days.</p>
      <form id="form-education" novalidate>
        <div class="form-group">
          <label class="form-label" for="edu-institution">Institution</label>
          <input type="text" class="form-input" id="edu-institution" name="institution" maxlength="${EDUCATION_LIMITS.institution}" autocomplete="organization" required>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label" for="edu-board">Affiliated with</label>
            <input type="text" class="form-input" id="edu-board" name="board" maxlength="${EDUCATION_LIMITS.board}" list="edu-boards" placeholder="CBSE" required>
            <datalist id="edu-boards">${BOARDS.map((b) => `<option value="${escapeAttr(b)}"></option>`).join("")}</datalist>
          </div>
          <div class="form-group">
            <label class="form-label" for="edu-affiliation">Affiliation or recognition number</label>
            <input type="text" class="form-input" id="edu-affiliation" name="affiliationNumber" maxlength="${EDUCATION_LIMITS.affiliation}" required>
          </div>
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label" for="edu-website">Institution website</label>
            <input type="url" class="form-input" id="edu-website" name="website" maxlength="${EDUCATION_LIMITS.website}" placeholder="https://institute.edu.in" required>
          </div>
          <div class="form-group">
            <label class="form-label" for="edu-email">Official email on that website's domain</label>
            <input type="email" class="form-input" id="edu-email" name="email" maxlength="${EDUCATION_LIMITS.email}" placeholder="principal@institute.edu.in" autocomplete="email" required>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label" for="edu-certificate">Affiliation or recognition certificate</label>
          <input type="file" class="form-input" id="edu-certificate" name="certificate" accept="application/pdf,image/jpeg,image/png" required>
          <p class="form-hint">A PDF, JPEG or PNG of up to 5 MB.</p>
        </div>
        <p class="callout callout-danger hidden" id="edu-error" role="alert"></p>
        <div class="form-actions">
          <button type="button" class="btn btn-ghost" id="btn-edu-cancel">Cancel</button>
          <button type="submit" class="btn btn-primary" id="btn-edu-send">Send and email the code</button>
        </div>
      </form>
      <form id="form-education-code" class="hidden" novalidate>
        <div class="form-group">
          <label class="form-label" for="edu-code">Code emailed to <span id="edu-code-to"></span></label>
          <input type="text" class="form-input" id="edu-code" inputmode="numeric" autocomplete="one-time-code" maxlength="6" pattern="[0-9]{6}" required>
          <p class="form-hint">It works for ${EDUCATION_LIMITS.codeMinutes} minutes. No email? Check the spam folder, or send the application again.</p>
        </div>
        <p class="callout callout-danger hidden" id="edu-code-error" role="alert"></p>
        <div class="form-actions"><button type="submit" class="btn btn-primary">Confirm and send for review</button></div>
      </form>
    </div>

    <div class="card mt-lg hidden" id="section-unlicensed">
      <h2 class="card-title">Workstations without a licence</h2>
      <p class="card-sub">More workstations are enrolled than the plan covers. These show a licence notice instead of your portal. Move a licence to one, and the licensed workstation seen least recently takes its place; removing a workstation you no longer use frees one too.</p>
      <div class="table-container table-scrollable">
        <table>
          <thead><tr><th>Workstation</th><th>Last seen</th><th>Without a licence since</th><th class="th-actions"><span class="visually-hidden">Actions</span></th></tr></thead>
          <tbody id="unlicensed-rows"></tbody>
        </table>
      </div>
    </div>

    <div class="card mt-lg hidden" id="section-seats">
      <div class="card-head">
        <div>
          <h2 class="card-title">Remote Control seats</h2>
          <p class="card-sub" id="seats-sub"></p>
        </div>
      </div>
      <div class="table-container table-scrollable">
        <table>
          <thead><tr><th>Workstation</th><th>Last seen</th><th>Remote Control</th></tr></thead>
          <tbody id="seat-rows"></tbody>
        </table>
      </div>
    </div>

    <div class="card mt-lg hidden" id="section-staff">
      <div class="card-head">
        <div>
          <h2 class="card-title">Staff on this plan</h2>
          <p class="card-sub" id="staff-sub"></p>
        </div>
      </div>
      <div class="table-container table-scrollable">
        <table>
          <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th class="th-actions"><span class="visually-hidden">Actions</span></th></tr></thead>
          <tbody id="staff-rows"></tbody>
        </table>
      </div>
    </div>

    <div class="grid-2col mt-lg">
      <div class="card" id="section-details">
        <h2 class="card-title">Billing details</h2>
        <p class="card-sub">Printed on your invoices. Add your GSTIN to claim input tax credit.</p>
        <form id="form-details" novalidate>
          <div class="form-group">
            <label class="form-label" for="bd-name">Legal name</label>
            <input type="text" class="form-input" id="bd-name" maxlength="200" autocomplete="organization">
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label" for="bd-gstin">GSTIN (optional)</label>
              <input type="text" class="form-input mono" id="bd-gstin" maxlength="15" autocapitalize="characters" spellcheck="false" placeholder="22AAAAA0000A1Z5">
            </div>
            <div class="form-group">
              <label class="form-label" for="bd-state">State</label>
              <select class="form-select" id="bd-state"><option value="">Choose…</option></select>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label" for="bd-address">Billing address</label>
            <textarea class="form-textarea" id="bd-address" rows="3" maxlength="500" autocomplete="street-address"></textarea>
          </div>
          <div class="form-actions"><button type="submit" class="btn btn-secondary">Save details</button></div>
        </form>
      </div>
      <div class="card" id="section-invoices">
        <h2 class="card-title">Invoices</h2>
        <div class="callout callout-warning mb-md hidden" id="proformas-due">
          <strong>Payment due</strong>
          <div class="table-container">
            <table>
              <thead><tr><th>Proforma</th><th>Pay by</th><th>Amount</th><th class="th-actions"><span class="visually-hidden">Actions</span></th></tr></thead>
              <tbody id="proforma-rows"></tbody>
            </table>
          </div>
        </div>
        <p class="card-sub" id="invoices-empty">No payments yet.</p>
        <div class="table-container table-scrollable hidden" id="invoices-table">
          <table>
            <thead><tr><th>Number</th><th>Date</th><th>Amount</th><th class="th-actions"><span class="visually-hidden">Actions</span></th></tr></thead>
            <tbody id="invoice-rows"></tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="card mt-lg hidden" id="section-payments">
      <h2 class="card-title">Earlier payments</h2>
      <div class="table-container table-scrollable">
        <table>
          <thead><tr><th>Paid on</th><th>Period</th><th>Workstations</th><th>Amount</th><th>Covers until</th><th>Razorpay reference</th></tr></thead>
          <tbody id="payment-rows"></tbody>
        </table>
      </div>
    </div>
  `;
}

function renderPlanScript(nonce: string, contactHref: string): string {
  return `
    <script nonce="${escapeAttr(nonce)}">
      (function () {
        "use strict";
        const CONTACT = ${escapeJson(contactHref)};
        const $ = (id) => document.getElementById(id);
        let plan = null;
        let bill = null;
        let period = "year";
        let chosen = null;
        let previewTimer = 0;
        let previewSeq = 0;

        const day = (s) => new Date(s * 1000).toLocaleDateString([], { dateStyle: "medium" });
        const when = (s) => (s ? new Date(s * 1000).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "Never");
        function money(paise) {
          const r = paise / 100;
          return "₹" + r.toLocaleString("en-IN", { minimumFractionDigits: paise % 100 ? 2 : 0, maximumFractionDigits: 2 });
        }
        const rupees = (n) => "₹" + Math.round(n).toLocaleString("en-IN");
        function el(tag, className, text) {
          const node = document.createElement(tag);
          if (className) node.className = className;
          if (text !== undefined && text !== null) node.textContent = text;
          return node;
        }
        function cell(text, className) {
          return el("td", className, text);
        }
        const show = (node, on) => node.classList.toggle("hidden", !on);
        async function api(path, body) {
          const init = body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
          const res = await fetch(labkioskApi(path), init);
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            const err = new Error(data.error || "HTTP " + res.status);
            err.status = res.status;
            err.data = data;
            throw err;
          }
          return data;
        }
        function tierLabel(tier) {
          const t = bill && bill.catalogue.tiers.find((x) => x.tier === tier);
          return t ? t.label : tier;
        }

        // ------------------------------------------------------------ overview
        function statusBadge(sub) {
          const badge = $("plan-status");
          const now = Date.now() / 1000;
          let text = "";
          let tone = "badge-neutral";
          if (sub) {
            if (sub.status === "active" || sub.status === "authenticated") { text = sub.legacy ? "Paid" : "Active"; tone = "badge-green"; }
            else if (sub.status === "pending") { text = "Payment retrying"; tone = "badge-yellow"; }
            else if (sub.status === "halted") { text = "Payment failed"; tone = "badge-red"; }
            else if (sub.status === "cancelled" && sub.currentEnd > now) { text = "Cancelling"; tone = "badge-yellow"; }
          } else if (bill.plan.kind === "trial") { text = "Trial"; tone = "badge-blue"; }
          else if (bill.plan.lapsed) { text = "Ended"; tone = "badge-yellow"; }
          badge.textContent = text;
          badge.className = "badge " + tone + (text ? "" : " hidden");
        }

        function banner(tone, text, actionLabel, action) {
          const box = el("div", "callout callout-" + tone + " mb-0");
          box.setAttribute("role", "status");
          box.append(el("span", null, text + " "));
          if (actionLabel) {
            const b = el("button", "btn btn-sm btn-secondary", actionLabel);
            b.type = "button";
            b.addEventListener("click", action);
            box.append(b);
          }
          const wrap = el("div", "mb-0");
          wrap.style.marginBottom = "16px";
          wrap.append(box);
          return wrap;
        }

        function renderBanners() {
          const box = $("billing-banners");
          box.replaceChildren();
          const sub = bill.subscription;
          const now = Date.now() / 1000;
          if (!bill.enabled) box.append(banner("warning", "Online payment is not set up yet. Talk to sales to change your plan.", "Talk to sales", () => window.open(CONTACT, "_blank", "noopener")));
          const waiting = bill.waitingCheckout || (bill.replacement && bill.replacement.authoriseUrl ? bill.replacement : null);
          if (waiting && waiting.authoriseUrl) {
            box.append(banner("warning", "A payment for " + waiting.tierLabel + " is waiting for you to authorise it on Razorpay.", "Open Razorpay", () => openCheckout(waiting.authoriseUrl)));
          } else if (bill.replacement) {
            box.append(banner("success", "Your change to " + bill.replacement.tierLabel + " starts on " + day(bill.replacement.startsAt || bill.replacement.currentStart || now) + "."));
          }
          if (sub && sub.status === "pending") box.append(banner("warning", "Razorpay could not charge your renewal and will try again. Check the card or UPI mandate in the Razorpay email."));
          if (bill.plan.graceEndsAt && bill.plan.graceEndsAt > now) {
            box.append(banner("danger", "Your renewal payment failed. The plan stays as it is until " + day(bill.plan.graceEndsAt) + "; subscribe again to keep it.", "Renew now", () => chooseTier(sub ? sub.tier : "standard", sub)));
          }
          if (bill.plan.lapsed) box.append(banner("warning", "Your plan ended on " + day(bill.plan.expiresAt) + ". You are on Free, which covers " + bill.catalogue.freeWorkstations + " workstations and " + bill.catalogue.freeStaff + " staff."));
        }

        function renderOverview() {
          const sub = bill.subscription;
          const p = bill.plan;
          const now = Date.now() / 1000;
          $("plan-name").textContent = (sub ? sub.tierLabel : p.label) + " plan";
          statusBadge(sub);
          const lines = $("plan-lines");
          lines.replaceChildren();
          const line = (label, value) => {
            const s = el("span");
            s.append(label + " ", el("strong", null, value));
            lines.append(s, el("br"));
          };
          if (sub) {
            line("Billing:", (sub.period === "year" ? "Yearly" : "Monthly") + ", " + money(sub.total) + (sub.gst ? " including GST" : ""));
            if (sub.status === "cancelled") line("Ends on:", day(sub.currentEnd));
            else if (sub.legacy) line("Paid until:", day(sub.currentEnd) + " (renews by payment link; switch to automatic renewal below)");
            else if (sub.currentEnd) line("Renews on:", day(sub.currentEnd));
            else if (sub.startsAt) line("Starts on:", day(sub.startsAt));
          } else if (p.kind === "trial") {
            line("Trial ends:", day(p.expiresAt));
          } else if (p.kind === "free") {
            line("Free:", p.workstations + " workstations and " + p.staff + " staff, with no end date");
          } else if (p.expiresAt) {
            line("Runs until:", day(p.expiresAt));
          } else {
            line("Plan:", "no end date");
          }
          line("Covers:", p.workstations + " workstations, " + p.staff + " staff, " + p.remoteSeats + " Remote Control seat" + (p.remoteSeats === 1 ? "" : "s"));
          const live = sub && !sub.legacy && sub.status !== "cancelled";
          show($("btn-change"), true);
          $("btn-change").textContent = sub ? "Change plan" : "Choose a plan";
          show($("btn-cancel"), Boolean(bill.isOwner && live));
          show($("btn-resume"), Boolean(bill.isOwner && bill.enabled && sub && sub.status === "cancelled" && sub.currentEnd > now && !bill.replacement));
        }

        function meter(id, used, limit) {
          const m = $(id);
          const ratio = limit > 0 ? Math.min(used / limit, 1) : used > 0 ? 1 : 0;
          m.firstElementChild.style.width = Math.round(ratio * 100) + "%";
          m.classList.toggle("is-near", ratio >= 0.8 && ratio < 1);
          m.classList.toggle("is-full", ratio >= 1 && limit >= 0 && used >= limit && used > 0);
        }
        function renderUsage() {
          const u = bill.usage;
          const p = bill.plan;
          $("use-ws").textContent = u.workstations + " of " + p.workstations;
          $("use-staff").textContent = u.staff + " of " + p.staff;
          $("use-rc").textContent = u.remoteSeats + " of " + p.remoteSeats;
          meter("meter-ws", u.workstations, p.workstations);
          meter("meter-staff", u.staff, p.staff);
          meter("meter-rc", u.remoteSeats, p.remoteSeats);
        }

        // --------------------------------------------------------------- tiers
        function renderTiers() {
          document.querySelectorAll(".plan-period button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.period === period)));
          const sub = bill.subscription;
          for (const t of bill.catalogue.tiers) {
            const card = document.querySelector('[data-tier-card="' + t.tier + '"]');
            if (!card) continue;
            const yearly = period === "year";
            card.querySelector("[data-tier-price]").textContent = rupees(yearly ? t.yearly / 12 : t.monthly);
            card.querySelector("[data-tier-per]").textContent = "a month";
            card.querySelector("[data-tier-note]").textContent = yearly ? "Billed " + rupees(t.yearly) + " yearly, before GST" : "Billed monthly, before GST";
            const current = Boolean(sub && sub.tier === t.tier && sub.status !== "cancelled");
            card.classList.toggle("is-current", current);
            show(card.querySelector("[data-tier-current]"), current);
            const btn = card.querySelector("[data-choose-tier]");
            btn.textContent = current ? "Change " + t.label : "Choose " + t.label;
          }
        }

        function chooseTier(tier, from) {
          chosen = tier;
          const t = bill.catalogue.tiers.find((x) => x.tier === tier);
          const sub = from || (bill.subscription && bill.subscription.tier === tier ? bill.subscription : null);
          $("config-title").textContent = t.label + ", " + (period === "year" ? "yearly" : "monthly");
          $("cfg-included").textContent = String(t.includedWorkstations);
          $("cfg-extra").max = String(Math.max(0, bill.catalogue.salesAbove - t.includedWorkstations));
          $("cfg-seats").max = String(bill.catalogue.maxRemoteSeats);
          const enrolled = bill.usage.workstations;
          $("cfg-extra").value = String(sub ? sub.extraWorkstations : Math.max(0, enrolled - t.includedWorkstations));
          $("cfg-seats").value = String(sub ? sub.remoteSeats : Math.max(0, bill.usage.remoteSeats - t.includedRemoteSeats));
          $("cfg-extra-hint").textContent = rupees(period === "year" ? t.extraYearly : t.extraMonthly) + " a " + (period === "year" ? "year" : "month") + " each, up to " + bill.catalogue.salesAbove + " in all. You have " + enrolled + " enrolled.";
          $("cfg-seats-hint").textContent =
            (t.includedRemoteSeats ? t.includedRemoteSeats + " included; more at " : "") +
            rupees(period === "year" ? t.remoteYearly : t.remoteMonthly) + " a " + (period === "year" ? "year" : "month") + " per workstation. Each seat lets an administrator see and control one workstation's screen.";
          show($("plan-config"), true);
          $("plan-config").scrollIntoView({ behavior: "smooth", block: "start" });
          schedulePreview(0);
        }

        function counts() {
          const clamp = (input) => {
            const max = parseInt(input.max, 10);
            let v = parseInt(input.value, 10);
            if (!Number.isFinite(v) || v < 0) v = 0;
            if (Number.isFinite(max) && v > max) v = max;
            return v;
          };
          return { extra: clamp($("cfg-extra")), seats: clamp($("cfg-seats")) };
        }

        function schedulePreview(delay) {
          clearTimeout(previewTimer);
          previewTimer = setTimeout(preview, delay === undefined ? 250 : delay);
        }

        async function preview() {
          if (!chosen) return;
          const c = counts();
          const seq = ++previewSeq;
          const btn = $("btn-checkout");
          btn.disabled = true;
          try {
            const data = await api("/api/billing/preview", { tier: chosen, period, extraWorkstations: c.extra, remoteSeats: c.seats });
            if (seq !== previewSeq) return;
            const q = data.quote;
            const per = period === "year" ? " a year" : " a month";
            $("sum-base-label").textContent = tierLabel(q.tier) + " (" + (q.workstations - q.extraWorkstations) + " workstations)";
            $("sum-base").textContent = money(q.base);
            show($("row-extras"), q.extras > 0);
            $("sum-extras-label").textContent = q.extraWorkstations + " more workstation" + (q.extraWorkstations === 1 ? "" : "s");
            $("sum-extras").textContent = money(q.extras);
            show($("row-remote"), q.remote > 0);
            $("sum-remote-label").textContent = "Remote Control, " + q.remoteSeats + " seat" + (q.remoteSeats === 1 ? "" : "s");
            $("sum-remote").textContent = money(q.remote);
            show($("row-gst"), q.gst > 0);
            $("sum-gst-label").textContent = "GST " + q.gstPercent + "%";
            $("sum-gst").textContent = money(q.gst);
            $("sum-total-label").textContent = "Total" + per;
            $("sum-total").textContent = money(q.total);
            const now = $("sum-now");
            now.replaceChildren();
            if (data.same) {
              now.textContent = "This is the plan you have.";
            } else if (data.immediate) {
              now.append("Pay ", el("strong", null, money(q.total)), " now, then " + money(q.total) + per + " until you cancel.");
            } else if (data.upfront) {
              now.append("Pay ", el("strong", null, money(data.upfront.total)), " now for the rest of this period; the change applies at once. From " + day(data.startsAt) + ", " + money(q.total) + per + ".");
            } else {
              now.append("Nothing to pay now. From ", el("strong", null, day(data.startsAt)), ", " + money(q.total) + per + ".");
            }
            const losses = [];
            if (data.losses.workstations) losses.push(data.losses.workstations + " workstation" + (data.losses.workstations === 1 ? "" : "s") + " will show a licence notice");
            if (data.losses.staff) losses.push(data.losses.staff + " staff account" + (data.losses.staff === 1 ? "" : "s") + " will be suspended");
            if (data.losses.remoteSeats) losses.push(data.losses.remoteSeats + " Remote Control seat" + (data.losses.remoteSeats === 1 ? "" : "s") + " will be released");
            $("cfg-losses").textContent = losses.length ? "With this plan, " + losses.join(", ") + ". You choose which under this page." : "";
            show($("cfg-losses"), losses.length > 0);
            btn.textContent = !bill.enabled ? "Talk to sales" : data.immediate || data.upfront ? "Continue to payment" : "Authorise the change";
            btn.disabled = data.same;
          } catch (err) {
            if (seq !== previewSeq) return;
            $("sum-now").textContent = err.message;
            btn.disabled = true;
          }
        }

        function openCheckout(url) {
          const tab = window.open(url, "_blank", "noopener");
          if (!tab) window.location.assign(url);
          lkToast("Finish on Razorpay; this page updates when you come back.", "info", 6000);
        }

        // ---------------------------------------------------------- add-ons
        function renderSeats() {
          const list = bill.remote.workstations;
          const limit = bill.plan.remoteSeats;
          show($("section-seats"), limit > 0 || bill.usage.remoteSeats > 0);
          $("seats-sub").textContent = bill.usage.remoteSeats + " of " + limit + " seats assigned. A workstation takes a free seat the first time an administrator opens it; switch one off here to move its seat.";
          const body = $("seat-rows");
          body.replaceChildren();
          for (const w of list) {
            const row = document.createElement("tr");
            const td = document.createElement("td");
            const label = el("label", "form-checkbox-label");
            const box = document.createElement("input");
            box.type = "checkbox";
            box.className = "form-checkbox";
            box.checked = w.assigned;
            box.disabled = !w.assigned && bill.usage.remoteSeats >= limit;
            box.addEventListener("change", async () => {
              box.disabled = true;
              try {
                await api("/api/billing/remote-seats", { clientId: w.clientId, assigned: box.checked });
                lkToast(box.checked ? w.clientId + " has a Remote Control seat." : "Seat released from " + w.clientId + ".", "success");
              } catch (err) {
                box.checked = !box.checked;
                lkToast(err.message, "error");
              }
              load();
            });
            label.append(box, el("span", null, w.assigned ? "Seat assigned" : "No seat"));
            td.append(label);
            row.append(cell(w.clientId, "cell-title mono"), cell(when(w.lastSeen)), td);
            body.append(row);
          }
        }

        function renderStaff() {
          const staff = bill.staff;
          if (!staff) return show($("section-staff"), false);
          const suspended = staff.filter((s) => s.suspended).length;
          show($("section-staff"), suspended > 0 || bill.usage.staff >= bill.plan.staff);
          $("staff-sub").textContent =
            "Your plan allows " + bill.plan.staff + " staff accounts besides you; " + bill.usage.staff + " are active" + (suspended ? " and " + suspended + " suspended. Suspend someone to restore someone else, or upgrade." : ".");
          const body = $("staff-rows");
          body.replaceChildren();
          for (const s of staff) {
            const row = document.createElement("tr");
            const actions = document.createElement("td");
            const b = el("button", "btn btn-sm " + (s.suspended ? "btn-secondary" : "btn-ghost"), s.suspended ? "Restore" : "Suspend");
            b.type = "button";
            b.addEventListener("click", async () => {
              try {
                await api("/api/billing/staff", { userId: s.userId, suspended: !s.suspended });
                lkToast(s.name + (s.suspended ? " can sign in again." : " is suspended."), "success");
                load();
              } catch (err) {
                lkToast(err.message, "error");
              }
            });
            actions.append(b);
            const status = el("span", "badge " + (s.suspended ? "badge-yellow" : "badge-green"), s.suspended ? "Suspended" : "Active");
            const statusCell = document.createElement("td");
            statusCell.append(status);
            row.append(cell(s.name, "cell-title"), cell(s.email, "text-muted"), cell(s.role.replace(/_/g, " ")), statusCell, actions);
            body.append(row);
          }
        }

        // ------------------------------------------------------- details, invoices
        function renderDetails() {
          const select = $("bd-state");
          if (select.options.length <= 1) {
            for (const [code, name] of Object.entries(bill.states).sort((x, y) => x[0].localeCompare(y[0]))) select.add(new Option(code + " " + name, code));
          }
          $("bd-name").value = bill.details.legalName;
          $("bd-gstin").value = bill.details.gstin;
          $("bd-address").value = bill.details.address;
          select.value = bill.details.state;
        }

        /** A document opens as its own page, to read, print or save as PDF. */
        function docLink(kind, id, label) {
          const a = el("a", "btn btn-sm btn-ghost", label);
          a.href = window.labkioskApi("/api/billing/documents/" + kind + "/" + encodeURIComponent(id));
          a.target = "_blank";
          a.rel = "noopener";
          return a;
        }

        function renderInvoices() {
          const list = bill.invoices;
          show($("invoices-empty"), list.length === 0);
          show($("invoices-table"), list.length > 0);
          const body = $("invoice-rows");
          body.replaceChildren();
          for (const inv of list) {
            const row = document.createElement("tr");
            const actions = document.createElement("td");
            actions.append(docLink("invoice", inv.id, "View"));
            row.append(cell(inv.number, "mono"), cell(day(inv.issuedAt)), cell(money(inv.total), "money"), actions);
            body.append(row);
          }
          const due = (bill.proformas || []).filter((p) => p.status === "open");
          show($("proformas-due"), due.length > 0);
          const rows = $("proforma-rows");
          rows.replaceChildren();
          for (const p of due) {
            const row = document.createElement("tr");
            const actions = document.createElement("td");
            const box = el("div", "doc-actions");
            if (p.payUrl) {
              const pay = el("a", "btn btn-sm btn-primary", "Pay");
              pay.href = p.payUrl;
              pay.target = "_blank";
              pay.rel = "noopener";
              box.append(pay);
            }
            box.append(docLink("proforma", p.id, "View"));
            actions.append(box);
            row.append(cell(p.number, "mono"), cell(day(p.validUntil)), cell(money(p.total), "money"), actions);
            rows.append(row);
          }
        }

        // ------------------------------------------------- trial, education, licences
        function renderTrial() {
          const btn = $("btn-trial");
          const note = $("trial-note");
          btn.disabled = Boolean(plan.trial.refusal);
          show(note, Boolean(plan.trial.refusal));
          note.textContent = plan.trial.refusal ? plan.trial.refusal + "." : "";
        }

        let pendingId = null;
        function showCode(a) {
          pendingId = a.id;
          $("edu-code-to").textContent = a.email;
          show($("section-education-form"), true);
          show($("form-education"), false);
          show($("form-education-code"), true);
        }
        function renderEducation() {
          const box = $("edu-status");
          box.replaceChildren();
          const a = plan.education;
          const p = el("p", "form-hint");
          const apply = el("button", "btn btn-secondary", a && a.status === "approved" ? "Apply again to renew" : "Apply for Education");
          apply.type = "button";
          apply.addEventListener("click", () => {
            show($("section-education-form"), true);
            show($("form-education"), true);
            show($("form-education-code"), false);
            $("edu-institution").focus();
          });
          if (!a) box.append(apply);
          else if (a.status === "verifying") { p.textContent = "Waiting for the code we emailed to " + a.email + "."; box.append(p); showCode(a); }
          else if (a.status === "pending") { p.textContent = "Sent for review on " + day(a.submittedAt) + ". We email you when it is decided."; box.append(p); }
          else if (a.status === "approved") { p.textContent = "Approved on " + day(a.decidedAt) + "."; box.append(p, apply); }
          else { p.textContent = "Not approved: " + (a.reason || "no reason given") + " You can fix it and apply again."; box.append(p, apply); }
        }

        let customRequest = null;
        function renderCustom() {
          const box = $("custom-status");
          box.replaceChildren();
          const r = customRequest;
          const p = el("p", "form-hint");
          const ask = el("button", "btn btn-secondary", r && r.status === "paid" ? "Ask for a new Custom plan" : "Ask for a Custom plan");
          ask.type = "button";
          ask.addEventListener("click", () => {
            show($("section-custom-form"), true);
            if (!$("cp-workstations").value) $("cp-workstations").value = String(Math.max(${PRICING.salesAbove + 1}, plan.workstations.length));
            $("cp-workstations").focus();
          });
          if (!r) box.append(ask);
          else if (r.status === "open") { p.textContent = "Asked for on " + day(r.createdAt) + ". We email you a payment link with the price."; box.append(p); }
          else if (r.status === "sent") { p.textContent = "Approved on " + day(r.decidedAt) + " at " + r.total + ". The payment link is in your email; the plan starts when it is paid."; box.append(p); }
          else if (r.status === "paid") { p.textContent = "Paid. Your Custom plan is in force."; box.append(p, ask); }
          else { p.textContent = "Not offered: " + (r.decisionNote || "no reason given") + " You can ask again."; box.append(p, ask); }
        }

        function renderUnlicensed() {
          const waiting = plan.workstations.filter((w) => !w.licensed);
          show($("section-unlicensed"), waiting.length > 0);
          const body = $("unlicensed-rows");
          body.replaceChildren();
          for (const w of waiting) {
            const row = document.createElement("tr");
            const actions = document.createElement("td");
            const b = el("button", "btn btn-sm btn-secondary", "Move a licence here");
            b.type = "button";
            b.addEventListener("click", async () => {
              try {
                const data = await api("/api/plan/licence", { clientId: w.clientId });
                lkToast(data.displaced ? w.clientId + " is licensed; " + data.displaced + " shows the notice now." : w.clientId + " is licensed.", "success");
                load();
              } catch (err) {
                lkToast("Could not move the licence: " + err.message, "error");
              }
            });
            actions.append(b);
            row.append(cell(w.clientId, "cell-title"), cell(when(w.lastSeen)), cell(when(w.since)), actions);
            body.append(row);
          }
        }

        function renderPayments() {
          show($("section-payments"), plan.payments.length > 0);
          const body = $("payment-rows");
          body.replaceChildren();
          for (const pay of plan.payments) {
            const row = document.createElement("tr");
            row.append(cell(day(pay.paidAt)), cell(pay.period === "year" ? "1 year" : "1 month"), cell(String(pay.workstations)), cell(pay.total), cell(pay.endsAt ? day(pay.endsAt) : "\\u2014"), cell(pay.paymentId || "\\u2014", "text-muted"));
            body.append(row);
          }
        }

        // ---------------------------------------------------------------- load
        async function load() {
          try {
            const [b, p, c] = await Promise.all([api("/api/billing"), api("/api/plan"), api("/api/plan/custom")]);
            bill = b;
            plan = p;
            customRequest = c.request;
            renderBanners();
            renderOverview();
            renderUsage();
            renderTiers();
            renderSeats();
            renderStaff();
            renderDetails();
            renderInvoices();
            renderTrial();
            renderEducation();
            renderCustom();
            renderUnlicensed();
            renderPayments();
            if (chosen) schedulePreview(0);
          } catch (err) {
            $("plan-name").textContent = "Could not load the plan";
            $("plan-lines").textContent = err.message;
          }
        }

        let refreshing = false;
        async function refreshFromRazorpay() {
          if (refreshing || !bill) return;
          const waiting = bill.waitingCheckout || bill.replacement || (bill.subscription && !bill.subscription.legacy && bill.subscription.status !== "active");
          if (!waiting) return;
          refreshing = true;
          try {
            const data = await api("/api/billing/refresh", {});
            if (data.changed) {
              lkToast("Your plan is updated. Thank you.", "success");
              await load();
            }
          } catch (err) {
            console.warn("[Plan] Could not check Razorpay:", err.message);
          } finally {
            refreshing = false;
          }
        }

        // ------------------------------------------------------------- wiring
        document.querySelectorAll(".plan-period button").forEach((b) =>
          b.addEventListener("click", () => {
            period = b.dataset.period;
            renderTiers();
            if (chosen) chooseTier(chosen);
          })
        );
        document.querySelectorAll("[data-choose-tier]").forEach((b) => b.addEventListener("click", () => chooseTier(b.dataset.chooseTier)));
        document.querySelectorAll("[data-step]").forEach((b) =>
          b.addEventListener("click", () => {
            const input = $(b.dataset.step);
            input.value = String(Math.max(0, (parseInt(input.value, 10) || 0) + Number(b.dataset.by)));
            schedulePreview();
          })
        );
        ["cfg-extra", "cfg-seats"].forEach((id) => $(id).addEventListener("input", () => schedulePreview()));
        $("btn-change").addEventListener("click", () => {
          if (bill.subscription) chooseTier(bill.subscription.tier, bill.subscription);
          else document.getElementById("plans").scrollIntoView({ behavior: "smooth" });
        });

        $("btn-checkout").addEventListener("click", async () => {
          if (!bill.enabled) {
            window.open(CONTACT, "_blank", "noopener");
            return;
          }
          const c = counts();
          try {
            const data = await api("/api/billing/checkout", { tier: chosen, period, extraWorkstations: c.extra, remoteSeats: c.seats });
            openCheckout(data.url);
            await load();
          } catch (err) {
            lkToast("Could not start the payment: " + err.message, "error");
          }
        });

        $("btn-cancel").addEventListener("click", async () => {
          const sub = bill.subscription;
          const reason = await lkPrompt({
            title: "Cancel the subscription?",
            message: "Nothing more will be charged. " + (sub.currentEnd ? "Your plan stays until " + day(sub.currentEnd) + ", then the organization moves to Free (" + bill.catalogue.freeWorkstations + " workstations, " + bill.catalogue.freeStaff + " staff). " : "") + "You can resume before then.",
            label: "Why are you cancelling? (optional)",
            choices: ["Too expensive", "Missing a feature", "Switching to another product", "Only needed it for a while", "Other"],
            confirmLabel: "Cancel subscription",
            tone: "danger"
          });
          if (reason === null) return;
          try {
            const data = await api("/api/billing/cancel", { reason });
            lkToast(data.endsAt ? "Cancelled. Your plan stays until " + day(data.endsAt) + "." : "Cancelled.", "success");
            load();
          } catch (err) {
            lkToast("Could not cancel: " + err.message, "error");
          }
        });

        $("btn-resume").addEventListener("click", async () => {
          try {
            const data = await api("/api/billing/resume", {});
            openCheckout(data.url);
            load();
          } catch (err) {
            lkToast("Could not resume: " + err.message, "error");
          }
        });

        $("form-details").addEventListener("submit", async (e) => {
          e.preventDefault();
          try {
            await api("/api/billing/details", {
              legalName: $("bd-name").value,
              gstin: $("bd-gstin").value,
              address: $("bd-address").value,
              state: $("bd-state").value
            });
            lkToast("Billing details saved. New invoices use them.", "success");
            load();
          } catch (err) {
            lkToast(err.message, "error");
          }
        });

        $("btn-trial").addEventListener("click", async () => {
          const ok = await lkConfirm({
            title: "Start the free trial?",
            message: "You get Standard on " + plan.pricing.includedWorkstations + " workstations for " + plan.pricing.trialDays + " days, once. Afterwards you are back on Free unless you subscribe.",
            confirmLabel: "Start trial",
            tone: "primary"
          });
          if (!ok) return;
          try {
            const data = await api("/api/plan/trial", {});
            lkToast("Trial started. It ends on " + day(data.endsAt) + ".", "success");
            load();
          } catch (err) {
            lkToast("Could not start the trial: " + err.message, "error");
          }
        });

        $("btn-cp-cancel").addEventListener("click", () => show($("section-custom-form"), false));
        $("form-custom").addEventListener("submit", async (e) => {
          e.preventDefault();
          const errorBox = $("cp-error");
          show(errorBox, false);
          if (!e.target.reportValidity()) return;
          const staff = $("cp-staff").value.trim();
          try {
            const data = await api("/api/plan/custom", {
              workstations: Number($("cp-workstations").value),
              remoteSeats: Number($("cp-seats").value || 0),
              staff: staff ? Number(staff) : null,
              period: $("cp-period").value,
              notes: $("cp-notes").value
            });
            customRequest = data.request;
            show($("section-custom-form"), false);
            renderCustom();
            lkToast("Request sent. We email you a payment link with the price.", "success");
          } catch (err) {
            errorBox.textContent = err.message;
            show(errorBox, true);
          }
        });
        $("btn-edu-cancel").addEventListener("click", () => show($("section-education-form"), false));
        $("form-education").addEventListener("submit", async (e) => {
          e.preventDefault();
          const errorBox = $("edu-error");
          show(errorBox, false);
          const form = e.target;
          if (!form.reportValidity()) return;
          try {
            const res = await fetch(labkioskApi("/api/plan/education"), { method: "POST", body: new FormData(form) });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
            plan.education = data.application;
            renderEducation();
            $("edu-code").focus();
            lkToast("Code sent to " + data.application.email + ".", "success");
          } catch (err) {
            errorBox.textContent = err.message;
            show(errorBox, true);
          }
        });
        $("form-education-code").addEventListener("submit", async (e) => {
          e.preventDefault();
          const errorBox = $("edu-code-error");
          show(errorBox, false);
          try {
            const data = await api("/api/plan/education/verify", { id: pendingId, code: $("edu-code").value.trim() });
            plan.education = data.application;
            show($("section-education-form"), false);
            renderEducation();
            lkToast("Sent for review. We email you when it is decided.", "success");
          } catch (err) {
            errorBox.textContent = err.message;
            show(errorBox, true);
          }
        });

        // Back from Razorpay in this tab or another: look at Razorpay once more.
        document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") refreshFromRazorpay(); });
        window.addEventListener("focus", refreshFromRazorpay);

        const outcome = new URLSearchParams(window.location.search).get("payment");
        if (outcome === "paid") lkToast("Payment received. Thank you.", "success");
        else if (outcome === "cancelled") lkToast("The payment was not completed.", "warning");
        else if (outcome === "unverified") lkToast("We could not confirm the payment yet. If you paid, it appears here within a few minutes.", "warning");
        load().then(refreshFromRazorpay);
      })();
    </script>`;
}
