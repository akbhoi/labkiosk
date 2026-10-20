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
              <thead><tr><th>Maker</th><th>Model</th><th>Organizations</th><th>Workstations</th><th>UEFI</th><th>Touchscreen</th><th>Least memory</th><th>Public</th></tr></thead>
              <tbody id="platform-hardware-rows"><tr><td colspan="8" class="table-empty">Loading…</td></tr></tbody>
            </table>
          </div>
        </div>`;
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
            fill("platform-hardware-rows", 8, models.map((m) => [
              m.vendor, m.model, whole(m.organizations), whole(m.workstations), percent(m.uefi, m.workstations),
              percent(m.touch, m.workstations), m.minMemoryMb === null ? "\\u2014" : Math.round(m.minMemoryMb / 1024 * 10) / 10 + " GB",
              m.organizations >= ${PUBLIC_MODEL_MIN_ORGANIZATIONS} ? "Yes" : "No"
            ]), "No workstation has reported its hardware yet.");
            document.getElementById("platform-hardware-at").textContent = data.hardware.computedAt
              ? "Counted " + new Date(data.hardware.computedAt * 1000).toLocaleString() + "."
              : "Not counted yet: the hourly job builds it.";
          } catch (err) {
            for (const [id, columns] of [["platform-usage-days", 6], ["platform-usage-sites", 4], ["platform-hardware-rows", 8]]) {
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
