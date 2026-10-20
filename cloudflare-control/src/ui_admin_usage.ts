/**
 * Settings -> Usage: how much the organization's workstations are on and in
 * use, day by day, per workstation and per site (src/usage.ts), with a CSV of
 * each table. Shown to an account holding the `settings` permission.
 *
 * "In use" is time someone used the keyboard, mouse or touchscreen in the
 * last minute; "on" is time the workstation was running. Sites are recorded
 * by hostname only, and the organization can turn that off or delete what was
 * recorded here.
 */

import { escapeAttr } from "./escape";
import { WHEN_PANE_SHOWN_JS } from "./ui_admin_shared";
import { USAGE_RETENTION_DAYS } from "./usage";

export function renderUsagePaneHtml(): string {
  return `
      <div class="card" id="section-usage">
        <div class="row-between">
          <h2 class="card-title">Usage reports</h2>
          <div class="form-group">
            <label class="form-label visually-hidden" for="usage-period">Period</label>
            <select class="form-select" id="usage-period">
              <option value="7">Last 7 days</option>
              <option value="30" selected>Last 30 days</option>
              <option value="90">Last 90 days</option>
              <option value="365">Last 12 months</option>
            </select>
          </div>
        </div>
        <p class="card-sub">How much your workstations are switched on and in use. A workstation is in use while someone has used its keyboard, mouse or touchscreen in the last minute. Days are each workstation's own calendar days. Kept for ${USAGE_RETENTION_DAYS} days.</p>
        <div class="stat-grid" id="usage-tiles">
          <div class="stat-tile"><div class="stat-tile-label">Workstations used</div><div class="stat-tile-value" id="usage-workstations">—</div></div>
          <div class="stat-tile"><div class="stat-tile-label">Hours in use</div><div class="stat-tile-value" id="usage-active">—</div></div>
          <div class="stat-tile"><div class="stat-tile-label">Hours switched on</div><div class="stat-tile-value" id="usage-on">—</div></div>
          <div class="stat-tile"><div class="stat-tile-label">In use while on</div><div class="stat-tile-value" id="usage-share">—</div></div>
          <div class="stat-tile"><div class="stat-tile-label">Sessions</div><div class="stat-tile-value" id="usage-sessions">—</div><div class="stat-tile-hint">Each start and each fresh session</div></div>
        </div>
        <h3 class="card-subtitle mt-lg">Hours in use per day</h3>
        <div class="usage-chart" id="usage-chart" role="img" aria-label="Hours in use per day"></div>
        <p class="form-hint" id="usage-chart-empty">No usage reported in this period yet. Workstations report every 15 minutes once they run the current release.</p>
      </div>

      <div class="card mt-lg">
        <div class="row-between">
          <h2 class="card-title">Workstations</h2>
          <button type="button" class="btn btn-secondary btn-sm" data-usage-csv="workstations">Download CSV</button>
        </div>
        <div class="table-container table-scrollable">
          <table>
            <thead><tr><th>Workstation</th><th>Group</th><th>Days on</th><th>Hours on</th><th>Hours in use</th><th>Sessions</th><th>Last day</th></tr></thead>
            <tbody id="usage-workstation-rows"><tr><td colspan="7" class="table-empty">Loading…</td></tr></tbody>
          </table>
        </div>
      </div>

      <div class="card mt-lg">
        <div class="row-between">
          <h2 class="card-title">Sites</h2>
          <button type="button" class="btn btn-secondary btn-sm" data-usage-csv="sites">Download CSV</button>
        </div>
        <p class="card-sub">The sites your workstations spent time in use on, by hostname: never the full address, the page, or who was at the workstation.</p>
        <div class="table-container table-scrollable">
          <table>
            <thead><tr><th>Site</th><th>Hours in use</th><th>Visits</th></tr></thead>
            <tbody id="usage-site-rows"><tr><td colspan="3" class="table-empty">Loading…</td></tr></tbody>
          </table>
        </div>
        <form id="form-usage-settings" class="mt-md">
          <div class="form-group">
            <label class="form-checkbox-label">
              <input type="checkbox" class="form-checkbox" id="usage-sites">
              <span>Record the sites workstations visit</span>
            </label>
            <p class="form-hint">Turned off, workstations stop sending site names and only the time on and in use is kept. What was already recorded stays until you delete it or it is ${USAGE_RETENTION_DAYS} days old.</p>
          </div>
          <div class="form-actions">
            <button type="submit" class="btn btn-primary">Save</button>
            <button type="button" class="btn btn-danger" id="btn-usage-delete-sites">Delete recorded sites</button>
          </div>
        </form>
      </div>

      <div class="card mt-lg">
        <div class="row-between">
          <h2 class="card-title">By day</h2>
          <button type="button" class="btn btn-secondary btn-sm" data-usage-csv="days">Download CSV</button>
        </div>
        <div class="table-container table-scrollable">
          <table>
            <thead><tr><th>Day</th><th>Workstations</th><th>Hours on</th><th>Hours in use</th><th>Sessions</th></tr></thead>
            <tbody id="usage-day-rows"><tr><td colspan="5" class="table-empty">Loading…</td></tr></tbody>
          </table>
        </div>
      </div>
  `;
}

export function renderUsageScript(nonce: string): string {
  return `
    <script nonce="${escapeAttr(nonce)}">
${WHEN_PANE_SHOWN_JS}
      (function () {
        const section = document.getElementById("section-usage");
        if (!section) return;
        const period = document.getElementById("usage-period");
        const chart = document.getElementById("usage-chart");
        const chartEmpty = document.getElementById("usage-chart-empty");
        const sitesBox = document.getElementById("usage-sites");
        let report = null;

        const hours = (seconds) => (seconds / 3600).toFixed(seconds >= 36000 ? 0 : 1);
        const whole = (n) => Number(n).toLocaleString();

        function placeholder(body, columns, text) {
          const row = document.createElement("tr");
          const cell = document.createElement("td");
          cell.colSpan = columns;
          cell.className = "table-empty";
          cell.textContent = text;
          row.appendChild(cell);
          body.replaceChildren(row);
        }

        function fillRows(id, columns, rows, empty) {
          const body = document.getElementById(id);
          if (!rows.length) { placeholder(body, columns, empty); return; }
          body.replaceChildren();
          for (const values of rows) {
            const row = document.createElement("tr");
            values.forEach((value, index) => {
              const cell = document.createElement("td");
              cell.textContent = value;
              if (index === 0) cell.className = "mono";
              row.appendChild(cell);
            });
            body.appendChild(row);
          }
        }

        // One bar per day of the period, a day with no report at zero, so gaps read as gaps.
        function drawChart(data) {
          const svgNs = "http://www.w3.org/2000/svg";
          const byDay = new Map(data.days.map((d) => [d.day, d]));
          const days = [];
          for (let t = Date.parse(data.from + "T00:00:00Z"); t <= Date.parse(data.to + "T00:00:00Z"); t += 86400000) {
            days.push(new Date(t).toISOString().slice(0, 10));
          }
          chart.replaceChildren();
          chartEmpty.classList.toggle("hidden", data.days.length > 0);
          chart.classList.toggle("hidden", data.days.length === 0);
          if (!data.days.length) return;
          const max = Math.max(1, ...data.days.map((d) => d.activeSeconds));
          // Drawn at the box's own width, so the labels keep their shape.
          const width = Math.max(280, Math.round(chart.clientWidth || 720)), height = 160, top = 14, bottom = 20;
          const slot = width / days.length;
          const bar = Math.max(1, Math.min(18, slot - 2));
          const svg = document.createElementNS(svgNs, "svg");
          svg.setAttribute("viewBox", "0 0 " + width + " " + height);
          svg.setAttribute("class", "usage-chart-svg");
          const base = document.createElementNS(svgNs, "line");
          base.setAttribute("x1", "0"); base.setAttribute("x2", String(width));
          base.setAttribute("y1", String(height - bottom)); base.setAttribute("y2", String(height - bottom));
          base.setAttribute("class", "usage-chart-axis");
          svg.appendChild(base);
          days.forEach((day, i) => {
            const d = byDay.get(day);
            const value = d ? d.activeSeconds : 0;
            const h = Math.round((value / max) * (height - top - bottom));
            // The hit target is the whole column, so a short bar is still easy to point at.
            const hit = document.createElementNS(svgNs, "rect");
            hit.setAttribute("x", String(i * slot)); hit.setAttribute("y", "0");
            hit.setAttribute("width", String(slot)); hit.setAttribute("height", String(height - bottom));
            hit.setAttribute("class", "usage-chart-hit");
            const title = document.createElementNS(svgNs, "title");
            title.textContent = day + ": " + hours(value) + " h in use" + (d ? ", " + d.workstations + " workstations, " + hours(d.onSeconds) + " h on" : "");
            hit.appendChild(title);
            svg.appendChild(hit);
            if (h > 0) {
              const rect = document.createElementNS(svgNs, "rect");
              rect.setAttribute("x", String(i * slot + (slot - bar) / 2));
              rect.setAttribute("y", String(height - bottom - h));
              rect.setAttribute("width", String(bar));
              rect.setAttribute("height", String(h));
              rect.setAttribute("rx", "2");
              rect.setAttribute("class", "usage-chart-bar");
              svg.appendChild(rect);
            }
          });
          for (const i of [0, days.length - 1]) {
            const label = document.createElementNS(svgNs, "text");
            label.setAttribute("x", String(i === 0 ? 0 : width));
            label.setAttribute("y", String(height - 4));
            label.setAttribute("text-anchor", i === 0 ? "start" : "end");
            label.setAttribute("class", "usage-chart-label");
            label.textContent = days[i];
            svg.appendChild(label);
          }
          const peak = document.createElementNS(svgNs, "text");
          peak.setAttribute("x", "0"); peak.setAttribute("y", "10");
          peak.setAttribute("class", "usage-chart-label");
          peak.textContent = "Peak " + hours(max) + " h";
          svg.appendChild(peak);
          chart.appendChild(svg);
        }

        function show(data) {
          report = data;
          const active = data.days.reduce((s, d) => s + d.activeSeconds, 0);
          const on = data.days.reduce((s, d) => s + d.onSeconds, 0);
          document.getElementById("usage-workstations").textContent = whole(data.workstations.length);
          document.getElementById("usage-active").textContent = hours(active);
          document.getElementById("usage-on").textContent = hours(on);
          document.getElementById("usage-share").textContent = on ? Math.round((active / on) * 100) + "%" : "—";
          document.getElementById("usage-sessions").textContent = whole(data.days.reduce((s, d) => s + d.sessions, 0));
          drawChart(data);
          fillRows("usage-workstation-rows", 7, data.workstations.map((w) => [
            w.clientId, w.groupName || "—", whole(w.daysOn), hours(w.onSeconds), hours(w.activeSeconds), whole(w.sessions), w.lastDay
          ]), "No workstation reported usage in this period.");
          fillRows("usage-site-rows", 3, data.sites.map((s) => [s.domain, hours(s.activeSeconds), whole(s.visits)]),
            data.recordSites ? "No sites recorded in this period." : "Sites are not being recorded.");
          fillRows("usage-day-rows", 5, data.days.slice().reverse().map((d) => [
            d.day, whole(d.workstations), hours(d.onSeconds), hours(d.activeSeconds), whole(d.sessions)
          ]), "No usage reported in this period.");
          sitesBox.checked = data.recordSites === true;
        }

        async function load() {
          try {
            const res = await fetch(labkioskApi("/api/usage?days=" + encodeURIComponent(period.value)));
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
            show(data);
          } catch (err) {
            for (const [id, columns] of [["usage-workstation-rows", 7], ["usage-site-rows", 3], ["usage-day-rows", 5]]) {
              placeholder(document.getElementById(id), columns, "Could not load usage: " + err.message);
            }
          }
        }

        // CSV built here from what is shown: a cell starting with = + - @ is
        // prefixed so a spreadsheet does not run it as a formula.
        function csvCell(value) {
          let text = String(value);
          if (/^[=+\\-@]/.test(text)) text = "'" + text;
          return /[",\\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
        }
        function download(kind) {
          if (!report) return;
          const tables = {
            days: [["day", "workstations", "seconds_on", "seconds_in_use", "sessions"],
              ...report.days.map((d) => [d.day, d.workstations, d.onSeconds, d.activeSeconds, d.sessions])],
            workstations: [["workstation", "group", "days_on", "seconds_on", "seconds_in_use", "sessions", "last_day"],
              ...report.workstations.map((w) => [w.clientId, w.groupName || "", w.daysOn, w.onSeconds, w.activeSeconds, w.sessions, w.lastDay])],
            sites: [["site", "seconds_in_use", "visits"], ...report.sites.map((s) => [s.domain, s.activeSeconds, s.visits])]
          };
          const csv = tables[kind].map((row) => row.map(csvCell).join(",")).join("\\r\\n") + "\\r\\n";
          const link = document.createElement("a");
          link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
          link.download = "usage-" + kind + "-" + report.from + "-to-" + report.to + ".csv";
          document.body.appendChild(link);
          link.click();
          link.remove();
          setTimeout(() => URL.revokeObjectURL(link.href), 1000);
        }
        document.querySelectorAll("[data-usage-csv]").forEach((button) => {
          button.addEventListener("click", () => download(button.dataset.usageCsv));
        });

        period.addEventListener("change", load);
        let resizeTimer = 0;
        window.addEventListener("resize", () => {
          clearTimeout(resizeTimer);
          resizeTimer = setTimeout(() => { if (report) drawChart(report); }, 150);
        });

        document.getElementById("form-usage-settings").addEventListener("submit", async (e) => {
          e.preventDefault();
          try {
            const res = await fetch(labkioskApi("/api/usage/settings"), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ recordSites: sitesBox.checked })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
            lkToast(data.recordSites ? "Sites are recorded." : "Sites are no longer recorded.", "success");
            await load();
          } catch (err) {
            lkToast("Could not save: " + err.message, "error");
          }
        });

        document.getElementById("btn-usage-delete-sites").addEventListener("click", async () => {
          const ok = await lkConfirm({
            title: "Delete every recorded site?",
            message: "The site lists of every day are deleted for good. Time on and in use is kept.",
            confirmLabel: "Delete",
            tone: "danger"
          });
          if (!ok) return;
          try {
            const res = await fetch(labkioskApi("/api/usage/sites/delete"), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: "{}"
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
            lkToast("Recorded sites deleted.", "success");
            await load();
          } catch (err) {
            lkToast("Could not delete: " + err.message, "error");
          }
        });

        whenPaneShown(section, load);
      })();
    </script>`;
}
