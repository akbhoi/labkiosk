/**
 * The Super Admin console's Billing tab (/super/billing): recurring revenue,
 * every subscription with its status and next charge, what needs attention
 * (a paid amount that did not match, a webhook that could not be applied),
 * one organization's billing history, and the platform's actions: look at
 * Razorpay again, cancel, extend, and send an organization a payment link.
 * Everything is read from and done through /api/super/billing
 * (src/billing_routes.ts).
 */

import { escapeAttr, escapeHtml, escapeJson } from "./escape";
import { CATALOGUE, PAID_TIERS } from "./plans";

export interface BillingPaneOrganization {
  id: string;
  name: string;
  subdomain: string;
}

export function renderBillingPaneHtml(organizations: BillingPaneOrganization[]): string {
  const tierOptions = [...PAID_TIERS, "education" as const]
    .map((t) => `<option value="${escapeAttr(t)}"${t === "standard" ? " selected" : ""}>${escapeHtml(CATALOGUE[t].label)}</option>`)
    .join("");
  return `
      <style>
        .billing-row { cursor: pointer; }
        .billing-row:hover td { background: var(--bg-subtle); }
        .billing-detail-head { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; align-items: flex-start; }
        .billing-actions { display: flex; gap: 8px; flex-wrap: wrap; }
      </style>
      <div class="tab-pane active" id="pane-billing">
        <div class="callout callout-warning hidden" id="billing-setup" role="status"></div>
        <div class="stat-grid">
          <div class="stat-tile"><div class="stat-tile-label">Monthly recurring revenue</div><div class="stat-tile-value" id="tile-mrr">–</div><div class="stat-tile-hint">Before GST; yearly plans divided by 12</div></div>
          <div class="stat-tile"><div class="stat-tile-label">Active</div><div class="stat-tile-value" id="tile-active">–</div></div>
          <div class="stat-tile"><div class="stat-tile-label">Past due</div><div class="stat-tile-value" id="tile-pastdue">–</div></div>
          <div class="stat-tile"><div class="stat-tile-label">Cancelling</div><div class="stat-tile-value" id="tile-cancelling">–</div></div>
          <div class="stat-tile"><div class="stat-tile-label">Failed charges, 30 days</div><div class="stat-tile-value" id="tile-failed">–</div></div>
        </div>

        <div class="card mt-lg hidden" id="billing-attention">
          <h2 class="card-title">Needs attention</h2>
          <p class="card-sub">A paid amount that did not match what was sold grants nothing until you look; a webhook that could not be applied is retried by Razorpay and by the hourly reconciliation.</p>
          <div class="table-container table-scrollable">
            <table>
              <thead><tr><th>When</th><th>Organization</th><th>Event</th><th>Detail</th></tr></thead>
              <tbody id="attention-rows"></tbody>
            </table>
          </div>
        </div>

        <div class="card mt-lg">
          <div class="card-head">
            <div>
              <h2 class="card-title">Subscriptions</h2>
              <p class="card-sub">Select a row for the organization's billing history and actions.</p>
            </div>
            <button type="button" class="btn btn-primary" id="btn-new-link">Send payment link</button>
          </div>
          <div class="chip-row" role="group" aria-label="Filter by status">
            <div class="filter-chips" id="billing-filters">
              <button type="button" class="filter-chip active" data-billing-filter="all">All</button>
              <button type="button" class="filter-chip" data-billing-filter="active">Active</button>
              <button type="button" class="filter-chip" data-billing-filter="pastdue">Past due</button>
              <button type="button" class="filter-chip" data-billing-filter="cancelled">Cancelled</button>
              <button type="button" class="filter-chip" data-billing-filter="created">Waiting</button>
            </div>
          </div>
          <div class="table-container table-scrollable">
            <table>
              <thead><tr><th>Organization</th><th>Plan</th><th>Status</th><th>Amount</th><th>Next charge or end</th></tr></thead>
              <tbody id="billing-rows"><tr><td colspan="5" class="text-muted">Loading…</td></tr></tbody>
            </table>
          </div>
        </div>

        <div class="card mt-lg hidden" id="billing-detail">
          <div class="billing-detail-head">
            <div>
              <h2 class="card-title" id="detail-name"></h2>
              <p class="card-sub" id="detail-plan"></p>
            </div>
            <div class="billing-actions">
              <button type="button" class="btn btn-secondary" id="btn-detail-sync">Look at Razorpay again</button>
              <button type="button" class="btn btn-secondary" id="btn-detail-extend">Extend</button>
              <button type="button" class="btn btn-secondary" id="btn-detail-link">Send payment link</button>
              <button type="button" class="btn btn-danger" id="btn-detail-cancel">Cancel</button>
            </div>
          </div>
          <h3 class="card-subtitle mt-lg">Subscriptions</h3>
          <div class="table-container"><table><thead><tr><th>Created</th><th>Plan</th><th>Status</th><th>Amount</th><th>Period</th><th>Razorpay</th></tr></thead><tbody id="detail-subs"></tbody></table></div>
          <h3 class="card-subtitle mt-lg">Invoices</h3>
          <div class="table-container"><table><thead><tr><th>Number</th><th>Date</th><th>Amount</th><th>GST</th></tr></thead><tbody id="detail-invoices"></tbody></table></div>
          <h3 class="card-subtitle mt-lg">Payment links</h3>
          <div class="table-container"><table><thead><tr><th>Created</th><th>Kind</th><th>Amount</th><th>Status</th><th>Sent to</th></tr></thead><tbody id="detail-payments"></tbody></table></div>
          <h3 class="card-subtitle mt-lg">Events</h3>
          <div class="table-container table-scrollable"><table><thead><tr><th>Received</th><th>Event</th><th>Outcome</th></tr></thead><tbody id="detail-events"></tbody></table></div>
        </div>

        <div class="card mt-lg hidden" id="billing-link">
          <h2 class="card-title">Send a payment link</h2>
          <p class="card-sub">For an organization that registered before online payment, or one you agreed a plan with. Lab Kiosk emails the link to the organization's owner; the plan applies when they pay.</p>
          <form id="form-link" novalidate>
            <div class="form-row">
              <div class="form-group">
                <label class="form-label" for="link-org">Organization</label>
                <input class="form-input" id="link-org" list="link-orgs" placeholder="Type a name or address" required>
                <datalist id="link-orgs">${organizations
                  .map((o) => `<option value="${escapeAttr(o.subdomain)}">${escapeHtml(o.name)}</option>`)
                  .join("")}</datalist>
              </div>
              <div class="form-group">
                <label class="form-label" for="link-mode">Payment</label>
                <select class="form-select" id="link-mode">
                  <option value="subscription">Subscription that renews by itself</option>
                  <option value="once">One payment for one period, sent as a proforma invoice</option>
                </select>
              </div>
            </div>
            <div class="form-row">
              <div class="form-group">
                <label class="form-label" for="link-tier">Plan</label>
                <select class="form-select" id="link-tier">${tierOptions}</select>
              </div>
              <div class="form-group">
                <label class="form-label" for="link-period">Period</label>
                <select class="form-select" id="link-period"><option value="year">Yearly</option><option value="month">Monthly</option></select>
              </div>
              <div class="form-group">
                <label class="form-label" for="link-extra">Extra workstations</label>
                <input type="number" class="form-input" id="link-extra" min="0" step="1" value="0">
              </div>
              <div class="form-group">
                <label class="form-label" for="link-seats">Remote Control seats</label>
                <input type="number" class="form-input" id="link-seats" min="0" step="1" value="0">
              </div>
            </div>
            <div class="form-group">
              <label class="form-checkbox-label">
                <input type="checkbox" class="form-checkbox" id="link-domain">
                <span>Custom domain add-on (included in Pro)</span>
              </label>
            </div>
            <div class="form-group">
              <label class="form-label" for="link-note">Note to the organization (optional)</label>
              <textarea class="form-textarea" id="link-note" rows="2" maxlength="500"></textarea>
            </div>
            <div class="form-actions">
              <button type="button" class="btn btn-ghost" id="btn-link-close">Close</button>
              <button type="submit" class="btn btn-secondary">Create and email the link</button>
            </div>
            <p class="form-hint" id="link-result"></p>
          </form>
        </div>

        <div class="card mt-lg" id="billing-gstr1">
          <h2 class="card-title">GSTR-1 export</h2>
          <p class="card-sub">A month's tax invoices, by their date in India, as the CSV files the GST portal's offline tool imports. Proformas are not invoices and are never included. Check the figures before you file.</p>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label" for="gstr1-month">Month</label>
              <input type="month" class="form-input" id="gstr1-month" required>
            </div>
            <div class="form-group">
              <label class="form-label" for="gstr1-section">Section</label>
              <select class="form-select" id="gstr1-section">
                <option value="b2b">B2B: buyers with a GSTIN</option>
                <option value="b2cl">B2C (Large): other states, above ₹1,00,000</option>
                <option value="b2cs">B2C (Small): every other sale, by state</option>
                <option value="hsn">HSN/SAC summary</option>
                <option value="docs">Documents issued</option>
              </select>
            </div>
          </div>
          <div class="form-actions"><a class="btn btn-secondary" id="gstr1-download" href="/api/super/billing/gstr1" download>Download CSV</a></div>
        </div>
      </div>`;
}

export function renderBillingScript(nonce: string, organizations: BillingPaneOrganization[]): string {
  const bySubdomain = Object.fromEntries(organizations.map((o) => [o.subdomain, o.id]));
  return `
    <script nonce="${escapeAttr(nonce)}">
      (function () {
        "use strict";
        const ORGS = ${escapeJson(bySubdomain)};
        const $ = (id) => document.getElementById(id);
        let data = null;
        let filter = "all";
        let detailTenant = null;
        let detailCurrent = null;

        const day = (s) => (s ? new Date(s * 1000).toLocaleDateString([], { dateStyle: "medium" }) : "\\u2014");
        const when = (s) => (s ? new Date(s * 1000).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "\\u2014");
        const money = (p) => "₹" + (p / 100).toLocaleString("en-IN", { minimumFractionDigits: p % 100 ? 2 : 0, maximumFractionDigits: 2 });
        function cell(text, className) {
          const td = document.createElement("td");
          td.textContent = text;
          if (className) td.className = className;
          return td;
        }
        // GSTR-1 is filed for the month before.
        (function gstr1() {
          const month = $("gstr1-month");
          const section = $("gstr1-section");
          const link = $("gstr1-download");
          const d = new Date();
          d.setDate(1);
          d.setMonth(d.getMonth() - 1);
          month.value = d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
          const update = () => {
            link.href = "/api/super/billing/gstr1?month=" + encodeURIComponent(month.value) + "&section=" + encodeURIComponent(section.value);
            link.setAttribute("download", "gstr1-" + month.value + "-" + section.value + ".csv");
          };
          month.addEventListener("change", update);
          section.addEventListener("change", update);
          update();
        })();

        function empty(body, cols, text) {
          const row = document.createElement("tr");
          const td = cell(text, "text-muted");
          td.colSpan = cols;
          row.append(td);
          body.replaceChildren(row);
        }
        async function api(path, body) {
          const init = body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
          const res = await fetch(path, init);
          const out = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(out.error || "HTTP " + res.status);
          return out;
        }
        const STATUS = { created: "Waiting", authenticated: "Authorised", active: "Active", pending: "Retrying", halted: "Failed", cancelled: "Cancelled", completed: "Completed", paused: "Paused", expired: "Expired" };
        const TONE = { active: "badge-green", authenticated: "badge-blue", pending: "badge-yellow", halted: "badge-red", cancelled: "badge-neutral", created: "badge-neutral" };
        function badge(status) {
          const td = document.createElement("td");
          const b = document.createElement("span");
          b.className = "badge " + (TONE[status] || "badge-neutral");
          b.textContent = STATUS[status] || status;
          td.append(b);
          return td;
        }
        const planText = (s) => s.tierLabel + ", " + (s.period === "year" ? "yearly" : "monthly") + ", " + s.workstations + " ws" + (s.remoteSeatsTotal ? ", " + s.remoteSeatsTotal + " RC" : "");
        function matches(s) {
          if (filter === "all") return true;
          if (filter === "pastdue") return s.status === "pending" || s.status === "halted";
          return s.status === filter;
        }

        function render() {
          const t = data.tiles;
          $("tile-mrr").textContent = money(t.mrr);
          $("tile-active").textContent = String(t.active);
          $("tile-pastdue").textContent = String(t.pastDue);
          $("tile-cancelling").textContent = String(t.cancelling);
          $("tile-failed").textContent = String(t.failedLast30Days);
          const setup = [];
          if (!data.enabled) setup.push("Razorpay keys are not set: organizations cannot pay online.");
          if (!data.gstRegistered) setup.push("SELLER_GSTIN is not set to a valid GSTIN: no GST is charged and invoices are receipts.");
          $("billing-setup").textContent = setup.join(" ");
          $("billing-setup").classList.toggle("hidden", setup.length === 0);

          $("billing-attention").classList.toggle("hidden", data.attention.length === 0);
          const att = $("attention-rows");
          att.replaceChildren();
          for (const a of data.attention) {
            const row = document.createElement("tr");
            row.append(cell(when(a.received_at)), cell(a.tenant_name || "\\u2014"), cell(a.event), cell(a.error || a.outcome || "Not applied yet", "text-muted"));
            att.append(row);
          }

          const body = $("billing-rows");
          const rows = data.subscriptions.filter(matches);
          if (!rows.length) return empty(body, 5, "No subscriptions here.");
          body.replaceChildren();
          for (const s of rows) {
            const row = document.createElement("tr");
            row.className = "billing-row";
            row.tabIndex = 0;
            const org = cell(s.organization, "cell-title");
            const sub = document.createElement("div");
            sub.className = "text-muted mono";
            sub.textContent = s.subdomain;
            org.append(sub);
            const next = s.status === "cancelled" ? "Ends " + day(s.currentEnd) : s.currentEnd ? day(s.currentEnd) : s.startsAt ? "Starts " + day(s.startsAt) : "\\u2014";
            row.append(org, cell(planText(s)), badge(s.status), cell(money(s.total), "money"), cell(next));
            const open = () => openDetail(s.tenantId);
            row.addEventListener("click", open);
            row.addEventListener("keydown", (e) => { if (e.key === "Enter") open(); });
            body.append(row);
          }
        }

        async function load() {
          try {
            data = await api("/api/super/billing");
            render();
          } catch (err) {
            empty($("billing-rows"), 5, "Could not load subscriptions: " + err.message);
          }
        }

        async function openDetail(tenantId) {
          try {
            const d = await api("/api/super/billing/tenants/" + encodeURIComponent(tenantId));
            detailTenant = d.organization;
            detailCurrent = d.subscriptions.find((s) => ["active", "authenticated", "pending", "halted"].includes(s.status)) || d.subscriptions[0] || null;
            $("detail-name").textContent = d.organization.name;
            $("detail-plan").textContent = d.plan.label + ": " + d.plan.workstations + " workstations, " + d.plan.staff + " staff, " + d.plan.remoteSeats + " Remote Control seats" + (d.plan.expiresAt ? ", until " + day(d.plan.expiresAt) : ", no end date") + (d.plan.graceEndsAt ? " (grace until " + day(d.plan.graceEndsAt) + ")" : "");
            const subs = $("detail-subs");
            if (!d.subscriptions.length) empty(subs, 6, "None yet.");
            else {
              subs.replaceChildren();
              for (const s of d.subscriptions) {
                const row = document.createElement("tr");
                row.append(cell(day(s.createdAt)), cell(planText(s)), badge(s.status), cell(money(s.total), "money"), cell(s.currentStart ? day(s.currentStart) + " to " + day(s.currentEnd) : s.startsAt ? "from " + day(s.startsAt) : "\\u2014"), cell(s.razorpayId || "\\u2014", "mono text-muted"));
                subs.append(row);
              }
            }
            const inv = $("detail-invoices");
            if (!d.invoices.length) empty(inv, 4, "None yet.");
            else {
              inv.replaceChildren();
              for (const i of d.invoices) {
                const row = document.createElement("tr");
                row.append(cell(i.number, "mono"), cell(day(i.issuedAt)), cell(money(i.total), "money"), cell(money(i.cgst + i.sgst + i.igst), "money"));
                inv.append(row);
              }
            }
            const pays = $("detail-payments");
            if (!d.payments.length) empty(pays, 5, "None.");
            else {
              pays.replaceChildren();
              for (const p of d.payments) {
                const row = document.createElement("tr");
                row.append(cell(day(p.created_at)), cell(p.kind), cell(money(p.total_paise), "money"), cell(p.status), cell(p.sent_to || "\\u2014", "text-muted"));
                pays.append(row);
              }
            }
            const ev = $("detail-events");
            if (!d.events.length) empty(ev, 3, "None.");
            else {
              ev.replaceChildren();
              for (const e of d.events) {
                const row = document.createElement("tr");
                row.append(cell(when(e.received_at)), cell(e.event), cell(e.error || e.outcome || "\\u2014", "text-muted"));
                ev.append(row);
              }
            }
            $("btn-detail-sync").disabled = !detailCurrent || !detailCurrent.razorpayId;
            $("btn-detail-cancel").disabled = !detailCurrent || ["cancelled", "completed", "expired"].includes(detailCurrent.status);
            $("billing-detail").classList.remove("hidden");
            $("billing-detail").scrollIntoView({ behavior: "smooth", block: "start" });
          } catch (err) {
            lkToast("Could not open the organization: " + err.message, "error");
          }
        }

        document.querySelectorAll("[data-billing-filter]").forEach((chip) =>
          chip.addEventListener("click", () => {
            filter = chip.dataset.billingFilter;
            document.querySelectorAll("[data-billing-filter]").forEach((c) => c.classList.toggle("active", c === chip));
            if (data) render();
          })
        );

        $("btn-detail-sync").addEventListener("click", async () => {
          try {
            const out = await api("/api/super/billing/sync", { subscriptionId: detailCurrent.id });
            lkToast("Razorpay says " + out.result.status + (out.result.granted ? "; " + out.result.granted + " payment(s) applied." : "."), "success");
            await load();
            openDetail(detailTenant.id);
          } catch (err) {
            lkToast(err.message, "error");
          }
        });
        $("btn-detail-extend").addEventListener("click", async () => {
          const value = await lkPrompt({ title: "Extend the plan", message: "Add days to " + detailTenant.name + "'s current plan, at no charge.", label: "Days", value: "7", confirmLabel: "Extend" });
          if (value === null) return;
          const days = parseInt(value, 10);
          try {
            const out = await api("/api/super/billing/extend", { tenantId: detailTenant.id, days });
            lkToast("Extended to " + day(out.expiresAt) + ".", "success");
            openDetail(detailTenant.id);
          } catch (err) {
            lkToast(err.message, "error");
          }
        });
        $("btn-detail-cancel").addEventListener("click", async () => {
          const choice = await lkPrompt({
            title: "Cancel " + detailTenant.name + "'s subscription?",
            message: "Razorpay charges nothing more either way.",
            label: "When does the plan end?",
            choices: ["At the end of the paid period", "Now (the organization moves to Free at once)"],
            confirmLabel: "Cancel subscription",
            tone: "danger"
          });
          if (choice === null) return;
          try {
            await api("/api/super/billing/cancel", { subscriptionId: detailCurrent.id, immediately: choice.indexOf("Now") === 0 });
            lkToast("Cancelled.", "success");
            await load();
            openDetail(detailTenant.id);
          } catch (err) {
            lkToast(err.message, "error");
          }
        });

        function openLinkForm(subdomain) {
          $("billing-link").classList.remove("hidden");
          if (subdomain) $("link-org").value = subdomain;
          $("link-result").textContent = "";
          $("billing-link").scrollIntoView({ behavior: "smooth", block: "start" });
          $("link-org").focus();
        }
        $("btn-new-link").addEventListener("click", () => openLinkForm(""));
        $("btn-detail-link").addEventListener("click", () => openLinkForm(detailTenant && detailTenant.subdomain));
        $("btn-link-close").addEventListener("click", () => $("billing-link").classList.add("hidden"));
        $("form-link").addEventListener("submit", async (e) => {
          e.preventDefault();
          const tenantId = ORGS[$("link-org").value.trim()];
          if (!tenantId) return lkToast("Choose an organization from the list.", "error");
          try {
            const out = await api("/api/super/billing/payment-link", {
              tenantId,
              mode: $("link-mode").value,
              tier: $("link-tier").value,
              period: $("link-period").value,
              extraWorkstations: parseInt($("link-extra").value, 10) || 0,
              remoteSeats: parseInt($("link-seats").value, 10) || 0,
              customDomain: $("link-domain").checked,
              note: $("link-note").value
            });
            $("link-result").textContent = (out.emailed ? "Emailed to the owner. " : "Email could not be sent; share this link yourself: ") + out.url;
            lkToast(out.emailed ? "Payment link emailed." : "Link created; the email was not sent.", out.emailed ? "success" : "warning");
            load();
          } catch (err) {
            lkToast(err.message, "error");
          }
        });

        load();
      })();
    </script>`;
}
