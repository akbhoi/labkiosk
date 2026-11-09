/**
 * Super Admin -> Tasks -> Custom plans: organizations' requests for a Custom
 * plan (src/custom_plans.ts). Approving one sets the plan's terms and its price
 * and emails the organization a Razorpay payment link; the plan starts when the
 * link is paid. Declining needs a reason the organization is told.
 */

import { CUSTOM_PLAN_LIMITS } from "./custom_plans";
import { MAX_REMOTE_CONTROL_SEATS, MAX_WORKSTATION_LIMIT } from "./db";
import { escapeAttr } from "./escape";
import { STAFF_LIMITS } from "./plans";

export function renderCustomPlansPaneHtml(): string {
  const days = CUSTOM_PLAN_LIMITS.linkDays;
  return `
      <div class="card" id="custom-plan-requests">
        <h2 class="card-title">Custom plan requests</h2>
        <p class="card-sub">Set what the plan holds and its price. Sending emails the organization's owner a Razorpay payment link; the plan starts when it is paid and runs one billing period.</p>
        <p class="callout callout-warning hidden" id="custom-plan-billing" role="status">Razorpay is not set up, so no payment link can be sent.</p>
        <div class="table-container table-scrollable">
          <table>
            <thead><tr><th>Organization</th><th>Asked for</th><th>Notes</th><th>Sent</th><th>Status</th><th class="th-actions"><span class="visually-hidden">Actions</span></th></tr></thead>
            <tbody id="custom-plan-rows"><tr><td colspan="6" class="table-empty">Loading…</td></tr></tbody>
          </table>
        </div>
      </div>

      <div class="card mt-lg hidden" id="custom-plan-offer">
        <h2 class="card-title" id="cpo-title">Send a payment link</h2>
        <p class="card-sub" id="cpo-sub"></p>
        <form id="form-custom-offer" novalidate>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label" for="cpo-workstations">Workstations</label>
              <input type="number" class="form-input" id="cpo-workstations" min="1" max="${MAX_WORKSTATION_LIMIT}" step="1" required>
            </div>
            <div class="form-group">
              <label class="form-label" for="cpo-seats">Remote Control seats</label>
              <input type="number" class="form-input" id="cpo-seats" min="0" max="${MAX_REMOTE_CONTROL_SEATS}" step="1" required>
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label" for="cpo-staff">Staff accounts (empty for ${STAFF_LIMITS.custom})</label>
              <input type="number" class="form-input" id="cpo-staff" min="1" max="${CUSTOM_PLAN_LIMITS.staff}" step="1" placeholder="${STAFF_LIMITS.custom}">
            </div>
            <div class="form-group">
              <label class="form-label" for="cpo-period">Billing period</label>
              <select class="form-select" id="cpo-period"><option value="year">1 year</option><option value="month">1 month</option></select>
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label" for="cpo-price">Price for the period, in rupees before GST</label>
              <input type="number" class="form-input" id="cpo-price" min="1" max="${CUSTOM_PLAN_LIMITS.price}" step="1" required>
              <p class="form-hint" id="cpo-gst"></p>
            </div>
            <div class="form-group">
              <label class="form-label" for="cpo-days">The link stays open for (days)</label>
              <input type="number" class="form-input" id="cpo-days" min="${days.min}" max="${days.max}" step="1" value="${days.default}" required>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label" for="cpo-note">Note for the organization (optional)</label>
            <textarea class="form-textarea" id="cpo-note" rows="2" maxlength="${CUSTOM_PLAN_LIMITS.reason}"></textarea>
          </div>
          <p class="callout callout-danger hidden" id="cpo-error" role="alert"></p>
          <div class="form-actions">
            <button type="button" class="btn btn-ghost" id="btn-cpo-cancel">Cancel</button>
            <button type="submit" class="btn btn-primary" id="btn-cpo-send">Approve and send the link</button>
          </div>
        </form>
      </div>`;
}

export function renderCustomPlansScript(nonce: string): string {
  return `
    <script nonce="${escapeAttr(nonce)}">
      (function () {
        const rows = document.getElementById("custom-plan-rows");
        if (!rows) return;
        const $ = (id) => document.getElementById(id);
        const STATUS = { open: ["Waiting", "badge-yellow"], sent: ["Link sent", "badge-blue"], paid: ["Paid", "badge-green"], declined: ["Declined", "badge-neutral"] };
        let gstPercent = 0;
        let billing = false;
        let current = null;
        function cell(text, className) {
          const td = document.createElement("td");
          td.textContent = text;
          if (className) td.className = className;
          return td;
        }
        function sub(text) {
          const div = document.createElement("div");
          div.className = "cell-sub";
          div.textContent = text;
          return div;
        }
        function empty(text) {
          const row = document.createElement("tr");
          const td = cell(text, "table-empty");
          td.colSpan = 6;
          row.appendChild(td);
          rows.replaceChildren(row);
        }
        function day(seconds) {
          return seconds ? new Date(seconds * 1000).toLocaleDateString() : "\\u2014";
        }
        function terms(r) {
          return r.workstations + " workstations, " + r.remoteSeats + " Remote Control seats, " + (r.staff === null ? "${STAFF_LIMITS.custom} (default)" : r.staff) + " staff, " + (r.period === "year" ? "yearly" : "monthly");
        }
        async function post(path, body) {
          const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
          return data;
        }
        function showGst() {
          const price = Number($("cpo-price").value);
          $("cpo-gst").textContent = price > 0 && gstPercent ? "With GST at " + gstPercent + "%: \\u20b9" + Math.round(price * (100 + gstPercent)) / 100 + "." : "";
        }
        function offer(r) {
          current = r;
          $("cpo-title").textContent = "Send " + r.organization + " a payment link";
          $("cpo-sub").textContent = "Asked for: " + terms(r) + ". The link goes to the owner" + (r.requester ? "; asked by " + r.requester.name + " <" + r.requester.email + ">" : "") + ".";
          $("cpo-workstations").value = String(r.workstations);
          $("cpo-seats").value = String(r.remoteSeats);
          $("cpo-staff").value = r.staff === null ? "" : String(r.staff);
          $("cpo-period").value = r.period;
          $("cpo-price").value = "";
          $("cpo-note").value = "";
          $("cpo-error").classList.add("hidden");
          showGst();
          $("custom-plan-offer").classList.remove("hidden");
          $("cpo-price").focus();
        }
        async function decline(r) {
          const reason = await lkPrompt({
            title: "Decline " + r.organization + "'s request?",
            message: "The organization is told this reason by email and in its console, and can ask again.",
            label: "Reason",
            value: "",
            hint: "Such as: we cannot support more than 2,000 workstations at one site yet.",
            confirmLabel: "Decline"
          });
          if (!reason) return;
          try {
            const data = await post("/api/super/custom-plans/decline", { id: r.id, reason });
            lkToast(data.emailed ? "Declined, and the owner was emailed." : "Declined. The email did not go out.", data.emailed ? "success" : "warning");
            load();
          } catch (err) {
            lkToast("Could not save: " + err.message, "error");
          }
        }
        function render(list) {
          if (!list.length) return empty("No organization has asked for a Custom plan yet.");
          rows.replaceChildren();
          for (const r of list) {
            const row = document.createElement("tr");
            const org = cell(r.organization, "cell-title");
            org.appendChild(sub(r.subdomain + (r.requester ? ", " + r.requester.email : "")));
            const asked = cell(terms(r));
            if (r.total) asked.appendChild(sub(r.total + " with GST"));
            const status = document.createElement("td");
            const badge = document.createElement("span");
            badge.className = "badge " + STATUS[r.status][1];
            badge.textContent = STATUS[r.status][0];
            status.appendChild(badge);
            if (r.decisionNote) status.appendChild(sub(r.decisionNote));
            const actions = document.createElement("td");
            const wrap = document.createElement("div");
            wrap.className = "cell-actions";
            if (r.status === "open") {
              const send = document.createElement("button");
              send.type = "button";
              send.className = "btn btn-sm btn-primary";
              send.textContent = "Set price";
              send.disabled = !billing;
              send.addEventListener("click", () => offer(r));
              const no = document.createElement("button");
              no.type = "button";
              no.className = "btn btn-sm btn-ghost";
              no.textContent = "Decline";
              no.addEventListener("click", () => decline(r));
              wrap.append(send, no);
            }
            actions.appendChild(wrap);
            row.append(org, asked, cell(r.notes || "\\u2014", "text-muted"), cell(day(r.createdAt)), status, actions);
            rows.appendChild(row);
          }
        }
        async function load() {
          try {
            const res = await fetch("/api/super/custom-plans");
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
            gstPercent = Number(data.gstPercent) || 0;
            billing = Boolean(data.billingEnabled);
            $("custom-plan-billing").classList.toggle("hidden", billing);
            render(data.requests);
          } catch (err) {
            empty("Could not load: " + err.message);
          }
        }
        $("cpo-price").addEventListener("input", showGst);
        $("btn-cpo-cancel").addEventListener("click", () => $("custom-plan-offer").classList.add("hidden"));
        $("form-custom-offer").addEventListener("submit", async (e) => {
          e.preventDefault();
          const errorBox = $("cpo-error");
          errorBox.classList.add("hidden");
          if (!current || !e.target.reportValidity()) return;
          const button = $("btn-cpo-send");
          button.disabled = true;
          const staff = $("cpo-staff").value.trim();
          try {
            const data = await post("/api/super/custom-plans/approve", {
              id: current.id,
              workstations: Number($("cpo-workstations").value),
              remoteSeats: Number($("cpo-seats").value),
              staff: staff ? Number(staff) : null,
              period: $("cpo-period").value,
              price: Number($("cpo-price").value),
              validDays: Number($("cpo-days").value),
              note: $("cpo-note").value
            });
            $("custom-plan-offer").classList.add("hidden");
            lkToast(data.emailed ? "Link for " + data.total + " sent to the owner." : "Link created, but the email did not go out: " + data.url, data.emailed ? "success" : "warning");
            load();
          } catch (err) {
            errorBox.textContent = err.message;
            errorBox.classList.remove("hidden");
          } finally {
            button.disabled = false;
          }
        });
        load();
      })();
    </script>`;
}
