/**
 * Plan: what the organization runs under, and how to change it (src/plans.ts).
 * Start the free trial, pay for a subscription (src/billing.ts), apply for the
 * free Education plan (src/education.ts), and choose which workstations keep
 * their licence when more are enrolled than the plan covers. For an account
 * holding the `settings` permission.
 */

import { escapeAttr, escapeJson } from "./escape";
import { EDUCATION_LIMITS } from "./education";
import { PRICING } from "./plans";
import { AdminPageInput, AdminPageParts } from "./ui_admin_shared";

export function buildPlanPage(options: AdminPageInput): AdminPageParts {
  const contactHref = options.tenantParam ? "/contact?reason=sales" : `https://${options.baseDomain}/contact?reason=sales`;
  return {
    title: "Plan",
    contentHtml: renderPlanPageHtml(contactHref),
    scriptsHtml: renderPlanScript(options.nonce, contactHref)
  };
}

const BOARDS = ["CBSE", "CISCE (ICSE / ISC)", "State board", "NIOS", "IB", "Cambridge (CAIE)", "UGC", "AICTE", "State university"];

function renderPlanPageHtml(contactHref: string): string {
  const p = PRICING;
  return `
    <style>
      .plan-grid { display: grid; gap: 16px; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); }
      .plan-grid > .card { margin: 0; display: flex; flex-direction: column; }
      .plan-price { font-size: 1.5rem; font-weight: 700; letter-spacing: -0.02em; margin: 4px 0 2px; }
      .plan-price small { font-size: 0.875rem; font-weight: 500; color: var(--text-muted); }
      .plan-list { margin: 12px 0 16px; padding-left: 18px; color: var(--text-muted); font-size: 0.875rem; line-height: 1.6; }
      .plan-foot { margin-top: auto; }
      .plan-period { display: inline-flex; gap: 4px; padding: 3px; border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg-subtle); }
      .plan-period button { border: 0; background: transparent; color: var(--text-muted); padding: 6px 12px; border-radius: var(--radius-xs); font: inherit; font-size: 0.8125rem; cursor: pointer; }
      .plan-period button[aria-pressed="true"] { background: var(--bg-surface); color: var(--text-main); font-weight: 600; box-shadow: var(--shadow-sm); }
      .plan-total { font-size: 0.875rem; color: var(--text-muted); margin: 8px 0 12px; }
      .plan-total strong { color: var(--text-main); }
      .plan-now { display: flex; flex-wrap: wrap; gap: 8px 24px; align-items: baseline; }
    </style>
    <div class="page-head">
      <div>
        <h1 class="page-title">Plan</h1>
        <p class="page-desc">What your organization runs under, how many workstations it covers, and how to change it.</p>
      </div>
    </div>

    <div class="card" id="plan-current">
      <div class="plan-now">
        <h2 class="card-title mb-0" id="plan-name">Loading…</h2>
        <span class="text-muted" id="plan-detail"></span>
      </div>
      <p class="card-sub mb-0" id="plan-sub"></p>
    </div>

    <div class="plan-grid mt-lg">
      <div class="card" id="plan-trial">
        <h2 class="card-title">Free trial</h2>
        <div class="plan-price">₹0 <small>for ${p.trialDays} days</small></div>
        <ul class="plan-list">
          <li>Everything in the subscription, on ${p.includedWorkstations} workstations</li>
          <li>No card needed; once per organization</li>
          <li>Afterwards you are back on Free (${p.freeWorkstations} workstations) unless you subscribe</li>
        </ul>
        <div class="plan-foot">
          <button type="button" class="btn btn-secondary" id="btn-trial">Start the ${p.trialDays}-day trial</button>
          <p class="form-hint hidden" id="trial-note"></p>
        </div>
      </div>

      <div class="card" id="plan-subscribe">
        <h2 class="card-title">Subscription</h2>
        <div class="plan-period" role="group" aria-label="Billing period">
          <button type="button" data-period="month" aria-pressed="false">Monthly</button>
          <button type="button" data-period="year" aria-pressed="true">Yearly, 2 months free</button>
        </div>
        <div class="plan-price" id="sub-price"></div>
        <ul class="plan-list">
          <li>${p.includedWorkstations} workstations included</li>
          <li>₹${p.extraMonthly} a month (₹${p.extraYearly} a year) for each one more, up to ${p.salesAbove}</li>
          <li>Prices are before ${p.gstPercent}% GST</li>
        </ul>
        <div class="form-group">
          <label class="form-label" for="sub-extra">Extra workstations</label>
          <input type="number" class="form-input" id="sub-extra" min="0" max="${p.salesAbove - p.includedWorkstations}" step="1" value="0" inputmode="numeric">
        </div>
        <p class="plan-total" id="sub-total"></p>
        <div class="plan-foot">
          <button type="button" class="btn btn-primary" id="btn-pay">Pay with Razorpay</button>
          <p class="form-hint">More than ${p.salesAbove} workstations or several sites? <a href="${escapeAttr(contactHref)}" target="_blank" rel="noopener">Contact sales</a>.</p>
        </div>
      </div>

      <div class="card" id="plan-education">
        <h2 class="card-title">Education</h2>
        <div class="plan-price">₹0 <small>for verified institutions</small></div>
        <ul class="plan-list">
          <li>${p.educationWorkstations} workstations, for a year at a time</li>
          <li>For institutions recognised by an education board, university or regulator</li>
          <li>We check every application by hand</li>
        </ul>
        <div class="plan-foot" id="edu-status"></div>
      </div>
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

    <div class="card mt-lg hidden" id="section-payments">
      <h2 class="card-title">Payments</h2>
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
        let state = null;
        let period = "year";

        function day(seconds) {
          return new Date(seconds * 1000).toLocaleDateString([], { dateStyle: "medium" });
        }
        function when(seconds) {
          return seconds ? new Date(seconds * 1000).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "Never";
        }
        function inr(rupees) {
          return "₹" + Math.round(rupees).toLocaleString("en-IN");
        }
        function cell(text, className) {
          const td = document.createElement("td");
          td.textContent = text;
          if (className) td.className = className;
          return td;
        }
        async function post(path, body) {
          const res = await fetch(labkioskApi(path), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            const err = new Error(data.error || "HTTP " + res.status);
            err.data = data;
            throw err;
          }
          return data;
        }
        function show(el, on) {
          el.classList.toggle("hidden", !on);
        }

        function renderCurrent() {
          const plan = state.plan;
          const enrolled = state.workstations.length;
          const waiting = state.workstations.filter((w) => !w.licensed).length;
          $("plan-name").textContent = plan.label + " plan";
          $("plan-detail").textContent = enrolled + " of " + plan.limit + " workstations" + (waiting ? ", " + waiting + " without a licence" : "");
          let sub;
          if (plan.lapsed) sub = "Your " + plan.lapsedFrom + " plan ended on " + day(plan.expiresAt) + ". Free covers " + plan.limit + " workstations.";
          else if (plan.expiresAt) sub = (plan.kind === "trial" ? "The trial ends on " : "Runs until ") + day(plan.expiresAt) + ".";
          else if (plan.kind === "free") sub = "Free covers " + plan.limit + " workstations with no end date. Start the trial, subscribe, or apply for Education for more.";
          else sub = "No end date.";
          $("plan-sub").textContent = sub;
        }

        function renderTrial() {
          const btn = $("btn-trial");
          const note = $("trial-note");
          btn.disabled = Boolean(state.trial.refusal);
          show(note, Boolean(state.trial.refusal));
          note.textContent = state.trial.refusal ? state.trial.refusal + "." : "";
        }

        function renderPrice() {
          const p = state.pricing;
          const extra = Math.max(0, Math.min(state.maxOnlineExtra, parseInt($("sub-extra").value, 10) || 0));
          const yearly = period === "year";
          const base = yearly ? p.yearly : p.monthly;
          const subtotal = base + extra * (yearly ? p.extraYearly : p.extraMonthly);
          const gst = Math.round(subtotal * p.gstPercent) / 100;
          $("sub-price").innerHTML = "";
          $("sub-price").append(inr(base) + " ");
          const small = document.createElement("small");
          small.textContent = yearly ? "a year (" + inr(p.yearly / 12) + " a month)" : "a month";
          $("sub-price").appendChild(small);
          $("sub-total").innerHTML = "";
          const strong = document.createElement("strong");
          strong.textContent = inr(subtotal + gst);
          $("sub-total").append((p.includedWorkstations + extra) + " workstations: " + inr(subtotal) + " + " + p.gstPercent + "% GST = ", strong);
          document.querySelectorAll(".plan-period button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.period === period)));
          $("btn-pay").textContent = state.online ? "Pay with Razorpay" : "Ask sales to subscribe";
        }

        function renderEducation() {
          const box = $("edu-status");
          box.replaceChildren();
          const a = state.education;
          const p = document.createElement("p");
          p.className = "form-hint";
          const apply = document.createElement("button");
          apply.type = "button";
          apply.className = "btn btn-secondary";
          apply.textContent = a && a.status === "approved" ? "Apply again to renew" : "Apply for Education";
          apply.addEventListener("click", () => {
            show($("section-education-form"), true);
            show($("form-education"), true);
            show($("form-education-code"), false);
            $("edu-institution").focus();
          });
          if (!a) {
            box.append(apply);
          } else if (a.status === "verifying") {
            p.textContent = "Waiting for the code we emailed to " + a.email + ".";
            box.append(p);
            showCode(a);
          } else if (a.status === "pending") {
            p.textContent = "Sent for review on " + day(a.submittedAt) + ". We email you when it is decided.";
            box.append(p);
          } else if (a.status === "approved") {
            p.textContent = "Approved on " + day(a.decidedAt) + ".";
            box.append(p, apply);
          } else {
            p.textContent = "Not approved: " + (a.reason || "no reason given") + " You can fix it and apply again.";
            box.append(p, apply);
          }
        }

        let pendingId = null;
        function showCode(a) {
          pendingId = a.id;
          $("edu-code-to").textContent = a.email;
          show($("section-education-form"), true);
          show($("form-education"), false);
          show($("form-education-code"), true);
        }

        function renderUnlicensed() {
          const waiting = state.workstations.filter((w) => !w.licensed);
          show($("section-unlicensed"), waiting.length > 0);
          const body = $("unlicensed-rows");
          body.replaceChildren();
          for (const w of waiting) {
            const row = document.createElement("tr");
            const actions = document.createElement("td");
            const b = document.createElement("button");
            b.type = "button";
            b.className = "btn btn-sm btn-secondary";
            b.textContent = "Move a licence here";
            b.addEventListener("click", async () => {
              b.disabled = true;
              try {
                const data = await post("/api/plan/licence", { clientId: w.clientId });
                lkToast(data.displaced ? w.clientId + " is licensed; " + data.displaced + " shows the notice now." : w.clientId + " is licensed.", "success");
                load();
              } catch (err) {
                b.disabled = false;
                lkToast("Could not move the licence: " + err.message, "error");
              }
            });
            actions.appendChild(b);
            row.append(cell(w.clientId, "cell-title"), cell(when(w.lastSeen)), cell(when(w.since)), actions);
            body.appendChild(row);
          }
        }

        function renderPayments() {
          show($("section-payments"), state.payments.length > 0);
          const body = $("payment-rows");
          body.replaceChildren();
          for (const pay of state.payments) {
            const row = document.createElement("tr");
            row.append(
              cell(day(pay.paidAt)),
              cell(pay.period === "year" ? "1 year" : "1 month"),
              cell(String(pay.workstations)),
              cell(pay.total),
              cell(pay.endsAt ? day(pay.endsAt) : "\\u2014"),
              cell(pay.paymentId || "\\u2014", "text-muted")
            );
            body.appendChild(row);
          }
        }

        async function load() {
          try {
            const res = await fetch(labkioskApi("/api/plan"));
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
            state = data;
            $("sub-extra").max = String(data.maxOnlineExtra);
            renderCurrent();
            renderTrial();
            renderPrice();
            renderEducation();
            renderUnlicensed();
            renderPayments();
          } catch (err) {
            $("plan-name").textContent = "Could not load the plan";
            $("plan-sub").textContent = err.message;
          }
        }

        $("btn-trial").addEventListener("click", async () => {
          const ok = await lkConfirm({
            title: "Start the free trial?",
            message: "You get " + state.pricing.includedWorkstations + " workstations for " + state.pricing.trialDays + " days, once. Afterwards you are back on Free unless you subscribe.",
            confirmLabel: "Start trial",
            tone: "primary"
          });
          if (!ok) return;
          try {
            const data = await post("/api/plan/trial", {});
            lkToast("Trial started. It ends on " + day(data.endsAt) + ".", "success");
            load();
          } catch (err) {
            lkToast("Could not start the trial: " + err.message, "error");
          }
        });

        document.querySelectorAll(".plan-period button").forEach((b) =>
          b.addEventListener("click", () => {
            period = b.dataset.period;
            renderPrice();
          })
        );
        $("sub-extra").addEventListener("input", () => state && renderPrice());

        $("btn-pay").addEventListener("click", async () => {
          if (!state.online) {
            window.open(CONTACT, "_blank", "noopener");
            return;
          }
          const extra = parseInt($("sub-extra").value, 10) || 0;
          const btn = $("btn-pay");
          btn.disabled = true;
          try {
            const data = await post("/api/plan/checkout", { period, extraWorkstations: extra });
            window.location.assign(data.url);
          } catch (err) {
            btn.disabled = false;
            if (err.data && err.data.contactSales) window.open(CONTACT, "_blank", "noopener");
            else lkToast("Could not open the payment: " + err.message, "error");
          }
        });

        $("btn-edu-cancel").addEventListener("click", () => show($("section-education-form"), false));
        $("form-education").addEventListener("submit", async (e) => {
          e.preventDefault();
          const errorBox = $("edu-error");
          show(errorBox, false);
          const form = e.target;
          if (!form.reportValidity()) return;
          const btn = $("btn-edu-send");
          btn.disabled = true;
          try {
            const res = await fetch(labkioskApi("/api/plan/education"), { method: "POST", body: new FormData(form) });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
            state.education = data.application;
            renderEducation();
            $("edu-code").focus();
            lkToast("Code sent to " + data.application.email + ".", "success");
          } catch (err) {
            errorBox.textContent = err.message;
            show(errorBox, true);
          } finally {
            btn.disabled = false;
          }
        });
        $("form-education-code").addEventListener("submit", async (e) => {
          e.preventDefault();
          const errorBox = $("edu-code-error");
          show(errorBox, false);
          try {
            const data = await post("/api/plan/education/verify", { id: pendingId, code: $("edu-code").value.trim() });
            state.education = data.application;
            show($("section-education-form"), false);
            renderEducation();
            lkToast("Sent for review. We email you when it is decided.", "success");
          } catch (err) {
            errorBox.textContent = err.message;
            show(errorBox, true);
          }
        });

        const outcome = new URLSearchParams(window.location.search).get("payment");
        if (outcome === "paid") lkToast("Payment received. Thank you.", "success");
        else if (outcome === "cancelled") lkToast("The payment was not completed.", "warning");
        else if (outcome === "unverified") lkToast("We could not confirm the payment yet. If you paid, it appears here within a few minutes.", "warning");
        load();
      })();
    </script>`;
}
