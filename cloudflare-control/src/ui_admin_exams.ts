/**
 * Exams: schedule an exam, watch it live, and download its report
 * (src/exams.ts). For an account holding the `workstations` permission.
 *
 * Times are entered and shown in the browser's own time zone; the API carries
 * them as Unix seconds.
 */

import { escapeAttr, escapeJson } from "./escape";
import { EXAM_LIMITS, EXAM_RETENTION_DAYS } from "./exams";
import { AdminPageInput, AdminPageParts } from "./ui_admin_shared";

export function buildExamsPage(options: AdminPageInput): AdminPageParts {
  return {
    title: "Exams",
    contentHtml: renderExamsPageHtml(),
    scriptsHtml: renderExamsScript(options.nonce)
  };
}

function renderExamsPageHtml(): string {
  return `
    <div class="page-head">
      <div>
        <h1 class="page-title">Exams</h1>
        <p class="page-desc">Hold workstations on an exam site for a set time, watch them live, and download a report afterwards.</p>
      </div>
    </div>

    <div class="card" id="exam-running" hidden>
      <div class="card-head" style="flex-wrap: wrap; gap: 12px;">
        <div>
          <h2 class="card-title" id="exam-running-title"></h2>
          <p class="card-sub" id="exam-running-sub"></p>
        </div>
        <div class="cell-actions" style="flex-wrap: wrap;">
          <a class="btn btn-secondary btn-sm" id="exam-running-report" href="#">Download report</a>
          <button type="button" class="btn btn-danger btn-sm" id="btn-exam-end">End exam now</button>
        </div>
      </div>
      <p class="callout callout-danger hidden" id="exam-board-error" role="alert"></p>
      <div class="table-container table-scrollable">
        <table>
          <thead><tr><th>Workstation</th><th>Group</th><th>Now</th><th>On the exam site</th><th>Disconnections</th><th>Minutes offline</th></tr></thead>
          <tbody id="exam-board-rows"></tbody>
        </table>
      </div>
      <p class="form-hint" id="exam-board-updated"></p>
    </div>

    <div class="card mt-lg" id="section-exam-form">
      <h2 class="card-title">Schedule an exam</h2>
      <p class="card-sub">While the exam runs, its workstations show only the exam site and the other sites you list, cannot print, and cannot be sent elsewhere by a broadcast. Their browser is cleared when it starts and when it ends, which signs everyone out and empties the clipboard, and afterwards they go back to your portal. Downloads, file uploads and USB drives are blocked on every Lab Kiosk workstation at all times.</p>
      <form id="form-exam" novalidate>
        <div class="form-group">
          <label class="form-label" for="exam-title">Name</label>
          <input type="text" class="form-input" id="exam-title" maxlength="${EXAM_LIMITS.title}" placeholder="Class 10 science, term 1" required>
        </div>
        <div class="form-group">
          <label class="form-label" for="exam-url">Exam address</label>
          <input type="url" class="form-input" id="exam-url" placeholder="https://exam.example.org/test" required>
        </div>
        <div class="form-group">
          <label class="form-label" for="exam-hosts">Other sites the exam needs (optional)</label>
          <textarea class="form-textarea" id="exam-hosts" rows="3" placeholder="accounts.google.com&#10;fonts.gstatic.com"></textarea>
          <p class="form-hint">One domain per line, up to ${EXAM_LIMITS.extraHosts}, such as a sign-in or a file host the exam page loads from. Each allows its subdomains too.</p>
        </div>
        <div class="form-group">
          <label class="form-label" for="exam-scope">Workstations</label>
          <select class="form-select" id="exam-scope"><option value="">All workstations</option></select>
        </div>
        <div class="form-row">
          <div class="form-group" role="group" aria-labelledby="exam-start-label">
            <span class="form-label" id="exam-start-label">Starts</span>
            <label class="form-checkbox-label"><input type="radio" name="exam-start" value="now" checked> <span>Now</span></label>
            <label class="form-checkbox-label"><input type="radio" name="exam-start" value="later"> <span>At</span></label>
            <input type="datetime-local" class="form-input" id="exam-start-at" aria-label="Start date and time" disabled>
          </div>
          <div class="form-group">
            <label class="form-label" for="exam-minutes">Length in minutes</label>
            <input type="number" class="form-input" id="exam-minutes" min="${EXAM_LIMITS.minMinutes}" max="${EXAM_LIMITS.maxMinutes}" step="5" value="60" required>
          </div>
        </div>
        <p class="callout callout-danger hidden" id="exam-error" role="alert"></p>
        <div class="form-actions">
          <button type="submit" class="btn btn-primary" id="btn-exam-save">Schedule exam</button>
        </div>
      </form>
    </div>

    <div class="card mt-lg">
      <h2 class="card-title">All exams</h2>
      <p class="card-sub">Reports are kept for ${EXAM_RETENTION_DAYS} days after an exam ends.</p>
      <div class="table-container table-scrollable">
        <table>
          <thead><tr><th>Name</th><th>Workstations</th><th>When</th><th>Status</th><th class="th-actions"><span class="visually-hidden">Actions</span></th></tr></thead>
          <tbody id="exam-rows"><tr><td colspan="5" class="table-empty">Loading…</td></tr></tbody>
        </table>
      </div>
    </div>
  `;
}

function renderExamsScript(nonce: string): string {
  return `
    <script nonce="${escapeAttr(nonce)}">
      (function () {
        "use strict";
        const LIMITS = ${escapeJson(EXAM_LIMITS)};
        const BOARD_POLL_MS = 5000;
        const rows = document.getElementById("exam-rows");
        const form = document.getElementById("form-exam");
        const scope = document.getElementById("exam-scope");
        const startAt = document.getElementById("exam-start-at");
        const errorBox = document.getElementById("exam-error");
        const saveButton = document.getElementById("btn-exam-save");
        const running = document.getElementById("exam-running");
        const boardRows = document.getElementById("exam-board-rows");
        const boardError = document.getElementById("exam-board-error");
        const boardUpdated = document.getElementById("exam-board-updated");
        let current = null;
        let pollTimer = null;
        let startTimer = null;

        function when(seconds) {
          return new Date(seconds * 1000).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
        }
        function clock(seconds) {
          return new Date(seconds * 1000).toLocaleTimeString([], { timeStyle: "short" });
        }
        function cell(text, className) {
          const td = document.createElement("td");
          td.textContent = text;
          if (className) td.className = className;
          return td;
        }
        function badge(text, tone) {
          const span = document.createElement("span");
          span.className = "badge badge-" + tone;
          span.textContent = text;
          return span;
        }
        function showError(box, text) {
          box.textContent = text;
          box.classList.toggle("hidden", !text);
        }
        async function api(path, init) {
          const res = await fetch(labkioskApi(path), init);
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
          return data;
        }
        function who(exam) {
          return exam.groupName ? "Group: " + exam.groupName : "All workstations";
        }
        function statusOf(exam) {
          if (exam.phase === "running") return badge("Running", "green");
          if (exam.phase === "scheduled") return badge("Scheduled", "blue");
          return exam.cancelled ? badge("Cancelled", "neutral") : badge("Ended", "neutral");
        }

        function renderList(exams) {
          if (!exams.length) {
            const row = document.createElement("tr");
            const td = cell("No exams yet.", "table-empty");
            td.colSpan = 5;
            row.appendChild(td);
            rows.replaceChildren(row);
            return;
          }
          rows.replaceChildren();
          for (const exam of exams) {
            const row = document.createElement("tr");
            const status = document.createElement("td");
            status.appendChild(statusOf(exam));
            const actions = document.createElement("td");
            const wrap = document.createElement("div");
            wrap.className = "cell-actions";
            if (exam.phase === "scheduled") {
              const cancel = document.createElement("button");
              cancel.type = "button";
              cancel.className = "btn btn-ghost btn-sm";
              cancel.textContent = "Cancel";
              cancel.addEventListener("click", () => endExam(exam));
              wrap.appendChild(cancel);
            } else if (!exam.cancelled) {
              const report = document.createElement("a");
              report.className = "btn btn-ghost btn-sm";
              report.href = labkioskApi("/api/exams/" + encodeURIComponent(exam.id) + "/report.csv");
              report.textContent = "Report";
              wrap.appendChild(report);
            }
            actions.appendChild(wrap);
            row.append(
              cell(exam.title, "cell-title"),
              cell(who(exam)),
              cell(when(exam.startsAt) + " to " + clock(exam.endsAt)),
              status,
              actions
            );
            rows.appendChild(row);
          }
        }

        function renderBoard(data) {
          const exam = data.exam;
          document.getElementById("exam-running-title").textContent = exam.title;
          document.getElementById("exam-running-sub").textContent =
            who(exam) + ". Running until " + clock(exam.endsAt) + " on " + exam.url + ".";
          document.getElementById("exam-running-report").href = labkioskApi("/api/exams/" + encodeURIComponent(exam.id) + "/report.csv");
          boardRows.replaceChildren();
          if (!data.workstations.length) {
            const row = document.createElement("tr");
            const td = cell("No workstations are in this exam's group.", "table-empty");
            td.colSpan = 6;
            row.appendChild(td);
            boardRows.appendChild(row);
          }
          // Problems first: offline, then off the exam site, then the rest.
          const rank = (w) => (w.online === false ? 0 : w.onExamSite === false ? 1 : 2);
          const sorted = data.workstations.slice().sort((a, b) => rank(a) - rank(b) || a.clientId.localeCompare(b.clientId));
          for (const w of sorted) {
            const row = document.createElement("tr");
            const now = document.createElement("td");
            now.appendChild(w.online ? badge(w.locked ? "Online, locked" : "Online", "green") : badge("Offline", "red"));
            const site = document.createElement("td");
            site.appendChild(w.onExamSite === null ? badge("Unknown", "neutral") : w.onExamSite ? badge("Yes", "green") : badge("No", "yellow"));
            row.append(
              cell(w.clientId, "cell-title mono"),
              cell(w.groupName || "None"),
              now,
              site,
              cell(String(w.disconnections), w.disconnections ? "" : "text-muted"),
              cell(String(Math.round(w.offlineSeconds / 60)), w.offlineSeconds >= 60 ? "" : "text-muted")
            );
            boardRows.appendChild(row);
          }
          boardUpdated.textContent = "Updated " + clock(data.now) + ". Refreshes every few seconds while this page is open.";
        }

        async function pollBoard() {
          pollTimer = null;
          if (!current) return;
          if (!document.hidden) {
            try {
              const data = await api("/api/exams/" + encodeURIComponent(current.id));
              showError(boardError, "");
              if (data.exam.phase !== "running") {
                await load();
                return;
              }
              renderBoard(data);
            } catch (err) {
              showError(boardError, "Could not refresh the board: " + err.message);
            }
          }
          pollTimer = setTimeout(pollBoard, BOARD_POLL_MS);
        }

        async function load() {
          try {
            const data = await api("/api/exams");
            const chosen = scope.value;
            scope.replaceChildren(new Option("All workstations", ""));
            for (const name of data.groups) scope.appendChild(new Option("Group: " + name, name));
            scope.value = data.groups.includes(chosen) ? chosen : "";
            renderList(data.exams);
            current = data.exams.find((e) => e.phase === "running") || null;
            running.hidden = !current;
            if (pollTimer) clearTimeout(pollTimer);
            pollTimer = null;
            if (current) await pollBoard();
            // Pick up a scheduled exam's start without a reload.
            const next = data.exams.filter((e) => e.phase === "scheduled").map((e) => e.startsAt).sort((a, b) => a - b)[0];
            if (startTimer) clearTimeout(startTimer);
            startTimer = next && !current ? setTimeout(load, Math.max(1000, (next - data.now) * 1000 + 2000)) : null;
          } catch (err) {
            const row = document.createElement("tr");
            const td = cell("Could not load the exams: " + err.message, "table-empty");
            td.colSpan = 5;
            row.appendChild(td);
            rows.replaceChildren(row);
          }
        }

        async function endExam(exam) {
          const started = exam.phase === "running";
          const ok = await lkConfirm({
            title: started ? "End this exam now?" : "Cancel this exam?",
            message: started
              ? exam.title + ": its workstations are cleared and go back to the portal straight away."
              : exam.title + " will not start.",
            confirmLabel: started ? "End exam" : "Cancel exam",
            tone: "danger"
          });
          if (!ok) return;
          try {
            await api("/api/exams/" + encodeURIComponent(exam.id) + "/end", { method: "POST" });
            lkToast(started ? "Exam ended." : "Exam cancelled.", "success");
            await load();
          } catch (err) {
            lkToast("Could not end the exam: " + err.message, "error");
          }
        }

        document.getElementById("btn-exam-end").addEventListener("click", () => { if (current) endExam(current); });
        for (const radio of form.querySelectorAll('input[name="exam-start"]')) {
          radio.addEventListener("change", () => {
            startAt.disabled = form.querySelector('input[name="exam-start"]:checked').value !== "later";
            if (!startAt.disabled) startAt.focus();
          });
        }

        form.addEventListener("submit", async (e) => {
          e.preventDefault();
          const title = document.getElementById("exam-title").value.trim();
          const url = document.getElementById("exam-url").value.trim();
          const minutes = Number(document.getElementById("exam-minutes").value);
          const later = form.querySelector('input[name="exam-start"]:checked').value === "later";
          if (!title) { showError(errorBox, "Give the exam a name."); return; }
          if (!url) { showError(errorBox, "Enter the exam's address."); return; }
          if (!Number.isInteger(minutes) || minutes < LIMITS.minMinutes || minutes > LIMITS.maxMinutes) {
            showError(errorBox, "The length is " + LIMITS.minMinutes + " to " + LIMITS.maxMinutes + " minutes.");
            return;
          }
          let startsAt = null;
          if (later) {
            const at = startAt.value ? new Date(startAt.value).getTime() : NaN;
            if (!Number.isFinite(at)) { showError(errorBox, "Pick the start date and time."); return; }
            startsAt = Math.floor(at / 1000);
          }
          showError(errorBox, "");
          const hosts = document.getElementById("exam-hosts").value.split(/\\s+/).map((h) => h.trim()).filter(Boolean);
          saveButton.disabled = true;
          try {
            const data = await api("/api/exams", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ title, url, hosts, groupName: scope.value || null, startsAt, durationMinutes: minutes })
            });
            lkToast(data.exam.phase === "running" ? "Exam started." : "Exam scheduled for " + when(data.exam.startsAt) + ".", "success");
            form.reset();
            startAt.disabled = true;
            await load();
          } catch (err) {
            showError(errorBox, err.message);
          } finally {
            saveButton.disabled = false;
          }
        });
        document.addEventListener("visibilitychange", () => {
          if (!document.hidden && current && !pollTimer) pollBoard();
        });

        load();
      })();
    </script>`;
}
