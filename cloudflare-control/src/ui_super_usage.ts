/**
 * Super Admin -> System -> Usage and Hardware: the platform's anonymous daily
 * totals and the machines organizations run it on (GET /api/super/usage).
 * Nothing here names an organization: the totals count them, a site shows
 * only once three organizations visited it on a day, and the hardware list
 * counts workstations per model (src/usage.ts, src/hardware.ts).
 */

import { escapeAttr } from "./escape";
import { WHEN_PANE_SHOWN_JS } from "./ui_admin_shared";
import { PUBLIC_MODEL_MIN_ORGANIZATIONS } from "./hardware";
import { PLATFORM_SITE_MIN_ORGANIZATIONS } from "./usage";

export function renderPlatformUsagePaneHtml(): string {
  return `
        <div class="card" id="platform-usage">
          <div class="row-between">
            <h2 class="card-title">Platform usage</h2>
            <div class="form-group">
              <label class="form-label visually-hidden" for="platform-usage-period">Period</label>
              <select class="form-select" id="platform-usage-period">
                <option value="7">Last 7 days</option>
                <option value="30" selected>Last 30 days</option>
                <option value="90">Last 90 days</option>
                <option value="365">Last 12 months</option>
              </select>
            </div>
          </div>
          <p class="card-sub">Totals across every organization, without naming any, leaving out the platform's demos. Rebuilt every hour. A workstation is in use while someone used its keyboard, mouse or touchscreen in the last minute.</p>
          <div class="stat-grid">
            <div class="stat-tile"><div class="stat-tile-label">Organizations reporting (busiest day)</div><div class="stat-tile-value" id="platform-usage-orgs">—</div></div>
            <div class="stat-tile"><div class="stat-tile-label">Workstations reporting (busiest day)</div><div class="stat-tile-value" id="platform-usage-workstations">—</div></div>
            <div class="stat-tile"><div class="stat-tile-label">Hours in use</div><div class="stat-tile-value" id="platform-usage-active">—</div></div>
            <div class="stat-tile"><div class="stat-tile-label">Hours switched on</div><div class="stat-tile-value" id="platform-usage-on">—</div></div>
            <div class="stat-tile"><div class="stat-tile-label">Sessions</div><div class="stat-tile-value" id="platform-usage-sessions">—</div></div>
          </div>
          <div class="table-container table-scrollable mt-md">
            <table>
              <thead><tr><th>Day</th><th>Organizations</th><th>Workstations</th><th>Hours on</th><th>Hours in use</th><th>Sessions</th></tr></thead>
              <tbody id="platform-usage-days"><tr><td colspan="6" class="table-empty">Loading…</td></tr></tbody>
            </table>
          </div>
        </div>
        <div class="card">
          <h2 class="card-title">Sites many organizations use</h2>
          <p class="card-sub">A site appears once at least ${PLATFORM_SITE_MIN_ORGANIZATIONS} organizations that record sites visited it on the same day. Organizations is the most on any one day.</p>
          <div class="table-container table-scrollable">
            <table>
              <thead><tr><th>Site</th><th>Organizations</th><th>Hours in use</th><th>Visits</th></tr></thead>
              <tbody id="platform-usage-sites"><tr><td colspan="4" class="table-empty">Loading…</td></tr></tbody>
            </table>
          </div>
        </div>`;
}

export function renderPlatformHardwarePaneHtml(): string {
  return `
        <div class="card" id="platform-hardware">
          <h2 class="card-title">Hardware</h2>
          <p class="card-sub">Every model workstations reported at their latest start, by maker and model, leaving out the platform's demos and machines whose firmware names no model. Rebuilt every hour. Models at least ${PUBLIC_MODEL_MIN_ORGANIZATIONS} organizations run are listed publicly at <a href="/hardware">/hardware</a>.</p>
          <p class="form-hint" id="platform-hardware-at"></p>
          <div class="table-container table-scrollable">
            <table>
              <thead><tr><th>Maker</th><th>Model</th><th>Organizations</th><th>Workstations</th><th>UEFI</th><th>Touchscreen</th><th>Least memory</th><th>Public</th><th class="th-actions"><span class="visually-hidden">Actions</span></th></tr></thead>
              <tbody id="platform-hardware-rows"><tr><td colspan="9" class="table-empty">Loading…</td></tr></tbody>
            </table>
          </div>
        </div>

        <div class="card mt-lg" id="platform-certified">
          <h2 class="card-title">Certified models</h2>
          <p class="card-sub">Shown first on <a href="/hardware">/hardware</a> with the date, whether or not ${PUBLIC_MODEL_MIN_ORGANIZATIONS} organizations run them. Certify a model once it starts, plays video with hardware decoding and stays on the network on the current release. Use Certify in the table above, or type the maker and model as workstations report them.</p>
          <div class="table-container table-scrollable">
            <table>
              <thead><tr><th>Maker</th><th>Model</th><th>Certified on</th><th>Note</th><th class="th-actions"><span class="visually-hidden">Actions</span></th></tr></thead>
              <tbody id="platform-certified-rows"><tr><td colspan="5" class="table-empty">Loading…</td></tr></tbody>
            </table>
          </div>
          <form id="form-certify" class="mt-lg" novalidate>
            <div class="form-row">
              <div class="form-group">
                <label class="form-label" for="certify-vendor">Maker</label>
                <input type="text" class="form-input" id="certify-vendor" maxlength="120" required>
              </div>
              <div class="form-group">
                <label class="form-label" for="certify-model">Model</label>
                <input type="text" class="form-input" id="certify-model" maxlength="160" required>
              </div>
            </div>
            <div class="form-group">
              <label class="form-label" for="certify-note">Note (optional, public)</label>
              <input type="text" class="form-input" id="certify-note" maxlength="300" placeholder="Needs BIOS 1.20 or later for UEFI boot">
            </div>
            <div class="form-actions"><button type="submit" class="btn btn-primary">Certify model</button></div>
          </form>
        </div>

        <div class="card mt-lg" id="platform-resellers">
          <h2 class="card-title">Resellers</h2>
          <p class="card-sub">Companies apply with the contact form ("Become a reseller"); the message is in Mail under Sales. Approved resellers are listed on <a href="/hardware#resellers">/hardware</a> by state and city, and the directory appears there with the first one. Approving emails them.</p>
          <div class="table-container table-scrollable">
            <table>
              <thead><tr><th>Company</th><th>Place</th><th>Contact</th><th>Stocks</th><th>Status</th><th class="th-actions"><span class="visually-hidden">Actions</span></th></tr></thead>
              <tbody id="platform-reseller-rows"><tr><td colspan="6" class="table-empty">Loading…</td></tr></tbody>
            </table>
          </div>
        </div>`;
}

/** Super Admin -> System -> Hardware: certified models and reseller applications (src/partners.ts). */
export function renderPartnersScript(nonce: string): string {
  return `
    <script nonce="${escapeAttr(nonce)}">
${WHEN_PANE_SHOWN_JS}
      (function () {
        const card = document.getElementById("platform-certified");
        if (!card) return;
        const certifiedRows = document.getElementById("platform-certified-rows");
        const resellerRows = document.getElementById("platform-reseller-rows");
        const form = document.getElementById("form-certify");
        const vendor = document.getElementById("certify-vendor");
        const model = document.getElementById("certify-model");
        const note = document.getElementById("certify-note");
        const STATUS = { pending: ["Waiting", "badge-yellow"], approved: ["Listed", "badge-green"], rejected: ["Not listed", "badge-neutral"] };

        function cell(text, className) {
          const td = document.createElement("td");
          td.textContent = text;
          if (className) td.className = className;
          return td;
        }
        function empty(body, columns, text) {
          const row = document.createElement("tr");
          const td = cell(text, "table-empty");
          td.colSpan = columns;
          row.appendChild(td);
          body.replaceChildren(row);
        }
        function button(label, className, onClick) {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "btn btn-sm " + className;
          b.textContent = label;
          b.addEventListener("click", onClick);
          return b;
        }
        async function post(path, body) {
          const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
          return data;
        }

        function renderCertified(list) {
          if (!list.length) {
            empty(certifiedRows, 5, "No model is certified yet.");
            return;
          }
          certifiedRows.replaceChildren();
          for (const c of list) {
            const row = document.createElement("tr");
            const actions = document.createElement("td");
            actions.appendChild(button("Remove", "btn-ghost", async () => {
              const ok = await lkConfirm({ title: "Remove the certification?", message: c.vendor + " " + c.model + " stops showing as certified on /hardware.", confirmLabel: "Remove", tone: "danger" });
              if (!ok) return;
              try {
                await post("/api/super/hardware/uncertify", { vendor: c.vendor, model: c.model });
                lkToast("Certification removed.", "success");
                load();
              } catch (err) {
                lkToast("Could not remove it: " + err.message, "error");
              }
            }));
            row.append(
              cell(c.vendor, "cell-title"),
              cell(c.model),
              cell(new Date(c.certifiedAt * 1000).toLocaleDateString()),
              cell(c.note || "\\u2014", c.note ? "" : "text-muted"),
              actions
            );
            certifiedRows.appendChild(row);
          }
        }

        function renderResellers(list) {
          if (!list.length) {
            empty(resellerRows, 6, "No reseller has applied yet.");
            return;
          }
          resellerRows.replaceChildren();
          for (const r of list) {
            const row = document.createElement("tr");
            const status = document.createElement("td");
            const badge = document.createElement("span");
            badge.className = "badge " + STATUS[r.status][1];
            badge.textContent = STATUS[r.status][0];
            status.appendChild(badge);
            const actions = document.createElement("td");
            const wrap = document.createElement("div");
            wrap.className = "cell-actions";
            const decide = (decision) => async () => {
              const approve = decision === "approve";
              const ok = await lkConfirm({
                title: approve ? "List " + r.company + "?" : r.status === "approved" ? "Take " + r.company + " off the directory?" : "Reject " + r.company + "?",
                message: approve
                  ? "It appears on /hardware under " + r.city + ", " + r.state + ", and we email " + r.email + "."
                  : "Nothing is emailed; reply from Mail if you want to explain.",
                confirmLabel: approve ? "Approve" : r.status === "approved" ? "Take off" : "Reject",
                tone: approve ? "primary" : "danger"
              });
              if (!ok) return;
              try {
                const result = await post("/api/super/resellers/decide", { id: r.id, decision });
                if (approve && !result.emailed) lkToast("Listed. The email did not go out; reply from Mail.", "warning");
                else lkToast(approve ? "Listed, and emailed." : "Done.", "success");
                load();
              } catch (err) {
                lkToast("Could not save: " + err.message, "error");
              }
            };
            if (r.status !== "approved") wrap.appendChild(button("Approve", "btn-primary", decide("approve")));
            if (r.status !== "rejected") wrap.appendChild(button(r.status === "approved" ? "Take off" : "Reject", "btn-ghost", decide("reject")));
            actions.appendChild(wrap);
            row.append(
              cell(r.company + (r.website ? " (" + r.website + ")" : ""), "cell-title"),
              cell(r.city + ", " + r.state),
              cell(r.contact_name + ", " + r.email + ", " + r.phone),
              cell(r.stocks || "\\u2014", r.stocks ? "" : "text-muted"),
              status,
              actions
            );
            resellerRows.appendChild(row);
          }
        }

        async function load() {
          try {
            const res = await fetch("/api/super/partners");
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
            renderCertified(data.certified);
            renderResellers(data.resellers);
          } catch (err) {
            empty(certifiedRows, 5, "Could not load: " + err.message);
            empty(resellerRows, 6, "Could not load: " + err.message);
          }
        }

        document.addEventListener("lk-certify", (e) => {
          vendor.value = e.detail.vendor;
          model.value = e.detail.model;
          note.focus();
          form.scrollIntoView({ block: "nearest", behavior: "smooth" });
        });
        form.addEventListener("submit", async (e) => {
          e.preventDefault();
          if (!vendor.value.trim() || !model.value.trim()) {
            lkToast("Name the maker and the model.", "error");
            return;
          }
          try {
            await post("/api/super/hardware/certify", { vendor: vendor.value, model: model.value, note: note.value });
            lkToast("Model certified.", "success");
            form.reset();
            load();
          } catch (err) {
            lkToast("Could not certify: " + err.message, "error");
          }
        });
        let loaded = false;
        whenPaneShown(card, () => {
          if (loaded) return;
          loaded = true;
          load();
        });
      })();
    </script>`;
}

export function renderPlatformUsageScript(nonce: string): string {
  return `
    <script nonce="${escapeAttr(nonce)}">
${WHEN_PANE_SHOWN_JS}
      (function () {
        const period = document.getElementById("platform-usage-period");
        const usageCard = document.getElementById("platform-usage");
        const hardwareCard = document.getElementById("platform-hardware");
        if (!period || !usageCard || !hardwareCard) return;
        const hours = (seconds) => (seconds / 3600).toFixed(seconds >= 36000 ? 0 : 1);
        const whole = (n) => Number(n).toLocaleString();
        const percent = (part, all) => (all ? Math.round((part / all) * 100) + "%" : "\\u2014");

        function fill(id, columns, rows, empty) {
          const body = document.getElementById(id);
          body.replaceChildren();
          if (!rows.length) {
            const row = document.createElement("tr");
            const cell = document.createElement("td");
            cell.colSpan = columns;
            cell.className = "table-empty";
            cell.textContent = empty;
            row.appendChild(cell);
            body.appendChild(row);
            return;
          }
          for (const values of rows) {
            const row = document.createElement("tr");
            for (const value of values) {
              const cell = document.createElement("td");
              cell.textContent = value;
              row.appendChild(cell);
            }
            body.appendChild(row);
          }
        }

        let loaded = false;
        async function load() {
          try {
            const res = await fetch("/api/super/usage?days=" + encodeURIComponent(period.value));
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
            const sum = (key) => data.days.reduce((s, d) => s + d[key], 0);
            const peak = (key) => data.days.reduce((m, d) => Math.max(m, d[key]), 0);
            document.getElementById("platform-usage-orgs").textContent = whole(peak("organizations"));
            document.getElementById("platform-usage-workstations").textContent = whole(peak("workstations"));
            document.getElementById("platform-usage-active").textContent = hours(sum("activeSeconds"));
            document.getElementById("platform-usage-on").textContent = hours(sum("onSeconds"));
            document.getElementById("platform-usage-sessions").textContent = whole(sum("sessions"));
            fill("platform-usage-days", 6, data.days.slice().reverse().map((d) => [
              d.day, whole(d.organizations), whole(d.workstations), hours(d.onSeconds), hours(d.activeSeconds), whole(d.sessions)
            ]), "No usage reported in this period.");
            fill("platform-usage-sites", 4, data.sites.map((s) => [s.domain, whole(s.organizations), hours(s.activeSeconds), whole(s.visits)]),
              "No site was visited by enough organizations in this period.");
            const models = data.hardware.models;
            fill("platform-hardware-rows", 9, models.map((m) => [
              m.vendor, m.model, whole(m.organizations), whole(m.workstations), percent(m.uefi, m.workstations),
              percent(m.touch, m.workstations), m.minMemoryMb === null ? "\\u2014" : Math.round(m.minMemoryMb / 1024 * 10) / 10 + " GB",
              m.organizations >= ${PUBLIC_MODEL_MIN_ORGANIZATIONS} ? "Yes" : "No", ""
            ]), "No workstation has reported its hardware yet.");
            // Certify: hands the model to the Certified models form (renderPartnersScript).
            const hardwareRows = document.getElementById("platform-hardware-rows").children;
            models.forEach((m, i) => {
              const cell = hardwareRows[i] && hardwareRows[i].lastElementChild;
              if (!cell) return;
              const button = document.createElement("button");
              button.type = "button";
              button.className = "btn btn-ghost btn-sm";
              button.textContent = "Certify";
              button.addEventListener("click", () => document.dispatchEvent(new CustomEvent("lk-certify", { detail: { vendor: m.vendor, model: m.model } })));
              cell.appendChild(button);
            });
            document.getElementById("platform-hardware-at").textContent = data.hardware.computedAt
              ? "Counted " + new Date(data.hardware.computedAt * 1000).toLocaleString() + "."
              : "Not counted yet: the hourly job builds it.";
          } catch (err) {
            for (const [id, columns] of [["platform-usage-days", 6], ["platform-usage-sites", 4], ["platform-hardware-rows", 9]]) {
              fill(id, columns, [], "Could not load: " + err.message);
            }
          }
        }
        function loadOnce() {
          if (loaded) return;
          loaded = true;
          load();
        }
        period.addEventListener("change", load);
        whenPaneShown(usageCard, loadOnce);
        whenPaneShown(hardwareCard, loadOnce);
      })();
    </script>`;
}
