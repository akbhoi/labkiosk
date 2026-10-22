/**
 * Settings -> Power: when the organization's workstations switch themselves
 * off and on (src/power.ts). Shown to an account holding the `settings`
 * permission, which both reads and changes the schedules.
 *
 * Times are each workstation's own clock. For each day a workstation follows
 * its group's schedule when its group has one that day, otherwise the
 * all-workstations schedule; two schedules for the same workstations never
 * share a day, and the route says so when they would.
 */

import { escapeAttr } from "./escape";
import { WHEN_PANE_SHOWN_JS } from "./ui_admin_shared";
import { MIN_ON_OFF_GAP_MINUTES, POWER_WARNING_MINUTES } from "./power";

/** Monday first, as people read a week; the values are getDay()'s. */
const WEEK = [
  [1, "Mon"],
  [2, "Tue"],
  [3, "Wed"],
  [4, "Thu"],
  [5, "Fri"],
  [6, "Sat"],
  [0, "Sun"]
] as const;

export function renderPowerPaneHtml(): string {
  const dayBoxes = WEEK.map(
    ([value, label]) => `
              <label class="form-checkbox-label">
                <input type="checkbox" class="form-checkbox" name="power-day" value="${value}">
                <span>${label}</span>
              </label>`
  ).join("");
  return `
      <div class="card" id="section-power">
        <h2 class="card-title">Power schedules</h2>
        <p class="card-sub">Workstations switch themselves off at the time you set, after a ${POWER_WARNING_MINUTES}-minute warning on screen, and can switch themselves on again. Times are each workstation's own clock. On any day a workstation follows its group's schedule if its group has one, and the schedule for all workstations otherwise. A workstation switched on by hand after its switch-off time stays on until the next one, and one installing a system update shuts down when the update is done.</p>
        <div class="table-container table-scrollable">
          <table>
            <thead><tr><th>Applies to</th><th>Days</th><th>Switch off</th><th>Switch on</th><th class="th-actions"><span class="visually-hidden">Actions</span></th></tr></thead>
            <tbody id="power-rows"><tr><td colspan="5" class="table-empty">Loading…</td></tr></tbody>
          </table>
        </div>
      </div>

      <div class="card mt-lg">
        <h2 class="card-title" id="power-form-title">Add a schedule</h2>
        <form id="form-power-schedule" novalidate>
          <div class="form-group">
            <label class="form-label" for="power-scope">Applies to</label>
            <select class="form-select" id="power-scope">
              <option value="">All workstations</option>
            </select>
          </div>
          <div class="form-group" role="group" aria-labelledby="power-days-label">
            <span class="form-label" id="power-days-label">Days</span>
            <div class="power-days">${dayBoxes}
            </div>
          </div>
          <div class="form-row">
            <div class="form-group">
              <label class="form-label" for="power-off">Switch off at</label>
              <input type="time" class="form-input" id="power-off" required>
            </div>
            <div class="form-group">
              <label class="form-label" for="power-on">Switch on at (optional)</label>
              <input type="time" class="form-input" id="power-on">
            </div>
          </div>
          <p class="form-hint">Switching on uses the workstation's hardware clock, set before it shuts down; one whose firmware ignores it is listed under Errors &amp; Warnings, and can be woken from the Workstations page with Wake-on-LAN. Switch-on and switch-off are at least ${MIN_ON_OFF_GAP_MINUTES} minutes apart.</p>
          <p class="callout callout-danger hidden" id="power-error" role="alert"></p>
          <div class="form-actions">
            <button type="submit" class="btn btn-primary" id="btn-power-save">Add schedule</button>
            <button type="button" class="btn btn-secondary hidden" id="btn-power-cancel">Cancel</button>
          </div>
        </form>
      </div>
  `;
}

export function renderPowerScript(nonce: string): string {
  return `
    <script nonce="${escapeAttr(nonce)}">
${WHEN_PANE_SHOWN_JS}
      (function () {
        const section = document.getElementById("section-power");
        if (!section) return;
        const rows = document.getElementById("power-rows");
        const form = document.getElementById("form-power-schedule");
        const scope = document.getElementById("power-scope");
        const offInput = document.getElementById("power-off");
        const onInput = document.getElementById("power-on");
        const errorBox = document.getElementById("power-error");
        const saveButton = document.getElementById("btn-power-save");
        const cancelButton = document.getElementById("btn-power-cancel");
        const formTitle = document.getElementById("power-form-title");
        const dayBoxes = Array.from(form.querySelectorAll('input[name="power-day"]'));
        const DAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
        let editing = null;
        let schedules = [];

        // "Mon–Fri", "Sat, Sun", "Every day": Monday first, runs joined.
        function describeDays(days) {
          if (days.length === 7) return "Every day";
          const order = [1, 2, 3, 4, 5, 6, 0].filter((d) => days.includes(d));
          const parts = [];
          let run = [];
          const flush = () => {
            if (run.length >= 3) parts.push(DAY_SHORT[run[0]] + "\\u2013" + DAY_SHORT[run[run.length - 1]]);
            else parts.push(...run.map((d) => DAY_SHORT[d]));
            run = [];
          };
          const position = (d) => (d + 6) % 7;
          for (const d of order) {
            if (run.length && position(d) !== position(run[run.length - 1]) + 1) flush();
            run.push(d);
          }
          flush();
          return parts.join(", ");
        }

        function showError(text) {
          errorBox.textContent = text;
          errorBox.classList.toggle("hidden", !text);
        }

        function resetForm() {
          editing = null;
          form.reset();
          scope.value = "";
          formTitle.textContent = "Add a schedule";
          saveButton.textContent = "Add schedule";
          cancelButton.classList.add("hidden");
          showError("");
        }

        function startEdit(schedule) {
          editing = schedule.id;
          scope.value = schedule.groupId || "";
          for (const box of dayBoxes) box.checked = schedule.days.includes(Number(box.value));
          offInput.value = schedule.off;
          onInput.value = schedule.on || "";
          formTitle.textContent = "Edit schedule";
          saveButton.textContent = "Save schedule";
          cancelButton.classList.remove("hidden");
          showError("");
          form.scrollIntoView({ block: "nearest", behavior: "smooth" });
        }

        function cell(text, className) {
          const td = document.createElement("td");
          td.textContent = text;
          if (className) td.className = className;
          return td;
        }

        function render() {
          if (!schedules.length) {
            const row = document.createElement("tr");
            const td = cell("No power schedule yet: workstations stay on until someone switches them off.", "table-empty");
            td.colSpan = 5;
            row.appendChild(td);
            rows.replaceChildren(row);
            return;
          }
          rows.replaceChildren();
          for (const schedule of schedules) {
            const row = document.createElement("tr");
            const who = cell(schedule.groupName ? schedule.groupName : "All workstations", "cell-title");
            const actions = document.createElement("td");
            const wrap = document.createElement("div");
            wrap.className = "cell-actions";
            const edit = document.createElement("button");
            edit.type = "button";
            edit.className = "btn btn-ghost btn-sm";
            edit.textContent = "Edit";
            edit.addEventListener("click", () => startEdit(schedule));
            const remove = document.createElement("button");
            remove.type = "button";
            remove.className = "btn btn-danger btn-sm";
            remove.textContent = "Delete";
            remove.addEventListener("click", () => removeSchedule(schedule));
            wrap.append(edit, remove);
            actions.appendChild(wrap);
            row.append(who, cell(describeDays(schedule.days)), cell(schedule.off, "mono"), cell(schedule.on || "By hand", schedule.on ? "mono" : "text-muted"), actions);
            rows.appendChild(row);
          }
        }

        async function load() {
          try {
            const res = await fetch(labkioskApi("/api/power-schedules"));
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
            schedules = data.schedules;
            const chosen = scope.value;
            scope.replaceChildren(new Option("All workstations", ""));
            for (const group of data.groups) scope.appendChild(new Option("Group: " + group.name, group.id));
            scope.value = data.groups.some((g) => g.id === chosen) ? chosen : "";
            render();
          } catch (err) {
            const row = document.createElement("tr");
            const td = cell("Could not load the power schedules: " + err.message, "table-empty");
            td.colSpan = 5;
            row.appendChild(td);
            rows.replaceChildren(row);
          }
        }

        async function removeSchedule(schedule) {
          const ok = await lkConfirm({
            title: "Delete this power schedule?",
            message: (schedule.groupName || "All workstations") + ", " + describeDays(schedule.days) + ": its workstations stop switching off at " + schedule.off + ".",
            confirmLabel: "Delete",
            tone: "danger"
          });
          if (!ok) return;
          try {
            const res = await fetch(labkioskApi("/api/power-schedules/" + encodeURIComponent(schedule.id)), { method: "DELETE" });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
            if (editing === schedule.id) resetForm();
            lkToast("Power schedule deleted.", "success");
            await load();
          } catch (err) {
            lkToast("Could not delete: " + err.message, "error");
          }
        }

        form.addEventListener("submit", async (e) => {
          e.preventDefault();
          const days = dayBoxes.filter((b) => b.checked).map((b) => Number(b.value));
          if (!days.length) { showError("Pick at least one day."); return; }
          if (!offInput.value) { showError("Set the time workstations switch off."); return; }
          showError("");
          const body = { days, off: offInput.value, on: onInput.value || null, groupId: scope.value || null };
          if (editing) body.id = editing;
          try {
            const res = await fetch(labkioskApi("/api/power-schedules"), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body)
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
            lkToast(editing ? "Power schedule saved." : "Power schedule added.", "success");
            resetForm();
            await load();
          } catch (err) {
            showError(err.message);
          }
        });
        cancelButton.addEventListener("click", resetForm);

        whenPaneShown(section, load);
      })();
    </script>`;
}
