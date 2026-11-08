/**
 * Reports: what the organization's workstations and people did, to read rather
 * than configure. Usage (src/ui_admin_usage.ts), Errors & Warnings
 * (GET /api/workstation-issues) and the Activity log (GET /api/audit-logs),
 * which used to be tabs of Settings. For an account holding `settings`.
 */

import { escapeAttr } from "./escape";
import { AdminPageInput, AdminPageParts, WHEN_PANE_SHOWN_JS, tabSwitchScript } from "./ui_admin_shared";
import { renderUsagePaneHtml, renderUsageScript } from "./ui_admin_usage";

export function buildReportsPage(options: AdminPageInput): AdminPageParts {
  return {
    title: "Reports",
    contentHtml: `
    <div class="page-head">
      <div>
        <h1 class="page-title">Reports</h1>
        <p class="page-desc">How your workstations are used, the problems they reported, and every change made to this organization.</p>
      </div>
    </div>

    <nav class="segmented-nav" aria-label="Reports">
      <button type="button" class="segmented-tab active" data-action="tab-usage">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>
        <span>Usage</span>
      </button>
      <button type="button" class="segmented-tab" data-action="tab-issues">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
        <span>Errors &amp; Warnings</span>
      </button>
      <button type="button" class="segmented-tab" data-action="tab-activity">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
        <span>Activity log</span>
      </button>
    </nav>

    <div class="tab-pane active" id="pane-usage">
${renderUsagePaneHtml()}
    </div>

    <div class="tab-pane" id="pane-issues">
      <div class="card" id="section-issues">
        <h2 class="card-title">Errors &amp; Warnings</h2>
        <p class="card-sub">Problems workstations reported, such as a system update that failed its first start, or a restart without a shutdown. Kept for 90 days; a restart's log for 30.</p>
        <div class="form-group" id="bug-report-optin" hidden>
          <label class="form-checkbox-label">
            <input type="checkbox" class="form-checkbox" id="bug-reports-enabled">
            <span>Send automatic bug reports</span>
          </label>
          <div id="bug-reports-terms-row" hidden>
            <label class="form-checkbox-label">
              <input type="checkbox" class="form-checkbox" id="bug-reports-terms">
              <span>I accept the <a href="/terms/bug-reports" target="_blank" rel="noopener noreferrer">Automatic Bug Report Terms</a> for this organization</span>
            </label>
          </div>
          <p class="form-hint" id="bug-reports-hint"></p>
        </div>
        <div class="table-container table-scrollable">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Workstation</th>
                <th>Problem</th>
              </tr>
            </thead>
            <tbody id="workstation-issue-rows">
              <tr><td colspan="3" class="table-empty">Loading\u2026</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="tab-pane" id="pane-activity">
          <div class="card" id="section-activity">
            <h2 class="card-title">Activity log</h2>
            <p class="card-sub">Privileged changes to this organization, including anything the platform did to it.</p>
            <div class="table-container table-scrollable">
              <table>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Action</th>
                  </tr>
                </thead>
                <tbody id="lab-audit-rows">
                  <tr><td colspan="2" class="table-empty">Loading\u2026</td></tr>
                </tbody>
              </table>
            </div>
          </div>
    </div>
  `,
    scriptsHtml: renderReportsScript(options.nonce) + renderUsageScript(options.nonce)
  };
}

function renderReportsScript(nonce: string): string {
  return `
    <script nonce="${escapeAttr(nonce)}">
${tabSwitchScript("usage")}
${WHEN_PANE_SHOWN_JS}
      const issueRows = document.getElementById("workstation-issue-rows");
      if (issueRows) {
        whenPaneShown(issueRows, async function loadWorkstationIssues() {
          function placeholder(text) {
            const row = document.createElement("tr");
            const cell = document.createElement("td");
            cell.colSpan = 3;
            cell.className = "table-empty";
            cell.textContent = text;
            row.appendChild(cell);
            return row;
          }
          const labels = {
            update_failed: "Update failed",
            update_rolled_back: "Update rolled back",
            boot_fallback: "Started a fallback image",
            boot_error: "Boot record error",
            unexpected_restart: "Restarted without shutting down",
            watchdog_reset: "Stopped responding",
            disk_health: "Disk wearing out or failing",
            wake_alarm: "Cannot switch itself on"
          };
          // The end of the journal a workstation sent with a restart, fetched
          // when someone asks for it: a log can be 16 KiB, the list is 100 rows.
          function issueLogToggle(issue) {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "btn btn-ghost btn-sm issue-log-toggle";
            button.textContent = "Show log";
            let view = null;
            button.addEventListener("click", async () => {
              if (view) {
                view.hidden = !view.hidden;
                button.textContent = view.hidden ? "Show log" : "Hide log";
                return;
              }
              button.disabled = true;
              try {
                const res = await fetch(labkioskApi("/api/workstation-issues/log?id=" + encodeURIComponent(issue.id)));
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
                view = document.createElement("pre");
                view.className = "issue-log";
                view.textContent = typeof data.log === "string" && data.log
                  ? data.log
                  : "The log is no longer kept; logs are cleared 30 days after a restart.";
                button.after(view);
                button.textContent = "Hide log";
              } catch (err) {
                console.warn("Could not load the log:", err);
                lkToast("Could not load the log: " + err.message, "error");
              } finally {
                button.disabled = false;
              }
            });
            return button;
          }
          const pad = (n) => String(n).padStart(2, "0");
          // Where a sent problem stands: the issue it opened or joined, and that issue's status on GitHub.
          const reportStatus = {
            open: null,
            in_progress: ["In progress", "badge-blue"],
            pr_open: ["PR created", "badge-blue"],
            resolved: ["Resolved", "badge-green"],
            closed: ["Closed", "badge-neutral"]
          };
          function externalLink(href, text) {
            const link = document.createElement("a");
            link.href = href;
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            link.textContent = text;
            return link;
          }
          function bugReportLine(issue) {
            const line = document.createElement("div");
            line.className = "cell-sub";
            const number = typeof issue.issue_number === "number" ? " #" + issue.issue_number : "";
            line.appendChild(externalLink(issue.issue_url,
              (issue.report_match === "existing" ? "Already reported" : "New bug report") + number));
            const status = reportStatus[issue.report_status];
            if (status) {
              line.appendChild(document.createTextNode(" "));
              const badge = document.createElement("span");
              badge.className = "badge " + status[1];
              badge.textContent = status[0];
              line.appendChild(badge);
            }
            if (issue.report_status === "pr_open" && typeof issue.pr_url === "string" &&
                issue.pr_url.startsWith("https://github.com/")) {
              line.appendChild(document.createTextNode(" "));
              line.appendChild(externalLink(issue.pr_url, "View PR"));
            }
            return line;
          }
          const optIn = document.getElementById("bug-report-optin");
          const optInBox = document.getElementById("bug-reports-enabled");
          const termsRow = document.getElementById("bug-reports-terms-row");
          const termsBox = document.getElementById("bug-reports-terms");
          const optInHint = document.getElementById("bug-reports-hint");
          let bugState = null;
          function bugReportsAvailable() {
            return !!bugState && bugState.available === true && typeof bugState.repository === "string";
          }
          function termsCurrent() {
            return !!bugState && bugState.acceptedTermsVersion === bugState.termsVersion;
          }
          function showBugReportOptIn(state) {
            if (!optIn || !optInBox || !termsRow || !termsBox || !optInHint || !state) return;
            bugState = state;
            optIn.hidden = false;
            optInBox.checked = state.enabled === true;
            // Turning it off stays possible; turning it on needs the platform set up.
            optInBox.disabled = !bugReportsAvailable() && !optInBox.checked;
            const needsTerms = bugReportsAvailable() && !(state.enabled === true && termsCurrent());
            termsRow.hidden = !needsTerms;
            termsBox.checked = false;
            if (!bugReportsAvailable()) {
              optInHint.textContent = "Automatic bug reports are not set up on this platform.";
            } else if (state.enabled === true && !termsCurrent()) {
              optInHint.textContent = "The Automatic Bug Report Terms have changed. Nothing is sent until you accept version " +
                state.termsVersion + ".";
            } else if (state.enabled === true) {
              const accepted = state.termsAcceptedAt ? new Date(state.termsAcceptedAt * 1000) : null;
              optInHint.textContent = "Problems are filed as GitHub issues in " + state.repository +
                ", where anyone may be able to read them. Terms version " + state.acceptedTermsVersion +
                (!accepted || isNaN(accepted.getTime()) ? "" : " accepted on " + accepted.toLocaleDateString()) + ".";
            } else {
              optInHint.textContent = "New errors and warnings are filed as GitHub issues in " + state.repository +
                ", where anyone may be able to read them. A report carries the kind of problem, the system image version " +
                "and the problem text with network addresses, host names and identifiers removed; never this organization's " +
                "or its workstations' names. Problems listed before you turn this on are not sent.";
            }
          }
          async function saveBugReports(enabled) {
            const body = enabled ? { enabled, acceptTerms: bugState.termsVersion } : { enabled };
            const res = await fetch(labkioskApi("/api/settings/bug-reports"), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body)
            });
            const data = await res.json();
            if (!res.ok || data.status !== "ok") throw new Error(data.error || ("HTTP " + res.status));
            bugState.enabled = enabled;
            if (enabled) {
              bugState.acceptedTermsVersion = bugState.termsVersion;
              bugState.termsAcceptedAt = Math.floor(Date.now() / 1000);
            }
          }
          if (optInBox && termsBox) {
            optInBox.addEventListener("change", async () => {
              const enabled = optInBox.checked;
              if (enabled && !termsBox.checked) {
                optInBox.checked = false;
                lkToast("Accept the Automatic Bug Report Terms first.", "error");
                return;
              }
              optInBox.disabled = true;
              try {
                await saveBugReports(enabled);
                lkToast(enabled ? "Automatic bug reports turned on." : "Automatic bug reports turned off.", "success");
              } catch (err) {
                console.warn("Could not change automatic bug reports:", err);
                bugState.enabled = !enabled;
                lkToast("Could not change automatic bug reports: " + err.message, "error");
              } finally {
                showBugReportOptIn(bugState);
              }
            });
            termsBox.addEventListener("change", async () => {
              // Already on under older terms: ticking the box accepts the current ones.
              if (!termsBox.checked || !bugState || bugState.enabled !== true) return;
              termsBox.disabled = true;
              try {
                await saveBugReports(true);
                lkToast("Automatic Bug Report Terms accepted.", "success");
              } catch (err) {
                console.warn("Could not accept the Automatic Bug Report Terms:", err);
                lkToast("Could not accept the terms: " + err.message, "error");
              } finally {
                termsBox.disabled = false;
                showBugReportOptIn(bugState);
              }
            });
          }
          try {
            const res = await fetch(labkioskApi("/api/workstation-issues?limit=100"));
            if (!res.ok) throw new Error("HTTP " + res.status);
            const data = await res.json();
            const issues = Array.isArray(data.issues) ? data.issues : [];
            showBugReportOptIn(data.bugReports);
            issueRows.replaceChildren();
            if (!issues.length) {
              issueRows.appendChild(placeholder("No errors or warnings reported."));
              return;
            }
            for (const issue of issues) {
              const row = document.createElement("tr");

              const when = document.createElement("td");
              when.className = "mono text-xs nowrap";
              // When the workstation recorded it; its clock is what the
              // operator standing at it would have seen.
              const date = new Date(issue.occurred_at * 1000);
              if (isNaN(date.getTime())) {
                when.textContent = "\u2014";
              } else {
                when.textContent = date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) +
                  " " + pad(date.getHours()) + ":" + pad(date.getMinutes());
                when.title = date.toISOString();
              }
              row.appendChild(when);

              const workstation = document.createElement("td");
              const name = document.createElement("div");
              name.className = "cell-title";
              name.textContent = issue.client_id;
              workstation.appendChild(name);
              if (issue.image_version) {
                const version = document.createElement("div");
                version.className = "cell-sub mono";
                version.textContent = issue.image_version;
                workstation.appendChild(version);
              }
              row.appendChild(workstation);

              const problem = document.createElement("td");
              const badge = document.createElement("span");
              badge.className = "badge " + (issue.severity === "error" ? "badge-red" : "badge-yellow");
              badge.textContent = labels[issue.kind] || issue.kind;
              problem.appendChild(badge);
              if (issue.details) {
                const detail = document.createElement("div");
                detail.className = "cell-sub cell-detail";
                detail.textContent = issue.details;
                problem.appendChild(detail);
              }
              if (issue.has_log === 1) problem.appendChild(issueLogToggle(issue));
              if (issue.report_state === "sent" && typeof issue.issue_url === "string" &&
                  issue.issue_url.startsWith("https://github.com/")) {
                problem.appendChild(bugReportLine(issue));
              } else if (issue.report_state === "pending") {
                const report = document.createElement("div");
                report.className = "cell-sub";
                report.textContent = "Bug report queued";
                problem.appendChild(report);
              }
              row.appendChild(problem);

              issueRows.appendChild(row);
            }
          } catch (err) {
            console.warn("Could not load errors and warnings:", err);
            issueRows.replaceChildren();
            issueRows.appendChild(placeholder("Could not load errors and warnings."));
          }
        });
      }
      const labAuditRows = document.getElementById("lab-audit-rows");
      // Settings actions are audited: each one that succeeds calls this again,
      // so the list shows it without a reload.
      async function loadLabActivity() {
        if (!labAuditRows) return;
        await (async function () {
          function placeholder(text) {
            const row = document.createElement("tr");
            const cell = document.createElement("td");
            cell.colSpan = 2;
            cell.className = "table-empty";
            cell.textContent = text;
            row.appendChild(cell);
            return row;
          }
          try {
            const res = await fetch(labkioskApi("/api/audit-logs?limit=60"));
            const data = await res.json();
            const logs = Array.isArray(data.logs) ? data.logs : [];
            labAuditRows.replaceChildren();
            if (!logs.length) {
              labAuditRows.appendChild(placeholder("Nothing recorded for this organization yet."));
              return;
            }
            for (const entry of logs) {
              const row = document.createElement("tr");

              const when = document.createElement("td");
              when.className = "mono text-xs nowrap";
              const date = new Date(entry.created_at * 1000);
              // The viewer's own clock, not UTC: an administrator in IST reading
              // "13:44" for something done at 19:14 has been misled.
              const pad = (n) => String(n).padStart(2, "0");
              if (isNaN(date.getTime())) {
                when.textContent = "\u2014";
              } else {
                when.textContent = date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) +
                  " " + pad(date.getHours()) + ":" + pad(date.getMinutes());
                when.title = date.toISOString();
              }
              row.appendChild(when);

              const action = document.createElement("td");
              const badge = document.createElement("span");
              const removes = /suspend|reject|delete|remove|revoke|rotate/.test(entry.action);
              const grants = /approve|reactivate|create|add/.test(entry.action);
              badge.className = "badge " + (removes ? "badge-red" : grants ? "badge-green" : "badge-blue");
              // textContent throughout: details carries operator names, domains
              // and URLs that arrived from the console.
              badge.textContent = entry.action;
              action.appendChild(badge);
              // The detail sits under its action: this card is too narrow for a
              // third column, which squeezed the detail out of view -- and a
              // failed update's reason is the part an administrator needs.
              if (entry.details) {
                const detail = document.createElement("div");
                detail.className = "cell-sub cell-detail";
                detail.textContent = entry.details;
                action.appendChild(detail);
              }
              row.appendChild(action);

              labAuditRows.appendChild(row);
            }
          } catch (err) {
            labAuditRows.replaceChildren();
            labAuditRows.appendChild(placeholder("Could not load recent activity."));
          }
        })();
      }
      whenPaneShown(labAuditRows, loadLabActivity);
    </script>`;
}
