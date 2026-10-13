/**
 * Super Admin -> System -> Notifications: write a notification to one
 * organization or every organization, shown in their consoles and optionally
 * emailed to their owners, and the list of everything the platform has told
 * organizations, its own automatic notifications included (src/notifications.ts).
 */

import { escapeAttr, escapeHtml } from "./escape";
import { NOTIFICATION_LIMITS } from "./notifications";

export function renderNotificationsPaneHtml(organizations: ReadonlyArray<{ id: string; name: string }>): string {
  const options = organizations.map((o) => `<option value="${escapeAttr(o.id)}">${escapeHtml(o.name)}</option>`).join("");
  return `
        <div class="card">
          <h2 class="card-title">Notify organizations</h2>
          <p class="card-sub">A notification shows at the top of the organization's console until each member of its staff dismisses it. Approvals, Remote Control, workstation limits, licenses, content taken down and release lines reaching end of life notify organizations by themselves.</p>
          <form id="form-notification">
            <div class="form-group">
              <label class="form-label" for="notification-to">To</label>
              <select id="notification-to" class="form-select">
                <option value="">Every organization</option>
                ${options}
              </select>
            </div>
            <div class="form-group">
              <label class="form-label" for="notification-title">Title</label>
              <input type="text" class="form-input" id="notification-title" required maxlength="${NOTIFICATION_LIMITS.title}">
            </div>
            <div class="form-group">
              <label class="form-label" for="notification-body">Message</label>
              <textarea class="form-textarea" id="notification-body" rows="4" required maxlength="${NOTIFICATION_LIMITS.body}"></textarea>
            </div>
            <div class="form-group">
              <label class="form-checkbox-label">
                <input type="checkbox" class="form-checkbox" id="notification-email">
                <span>Email it to the owner of each organization too</span>
              </label>
            </div>
            <button type="submit" class="btn btn-primary">Send notification</button>
          </form>
        </div>
        <div class="card">
          <h2 class="card-title">Sent notifications</h2>
          <div class="table-container">
            <table>
              <thead>
                <tr><th>Sent</th><th>To</th><th>Notification</th><th>Dismissed by</th></tr>
              </thead>
              <tbody id="notification-rows">
                <tr><td colspan="4" class="table-empty">Loading…</td></tr>
              </tbody>
            </table>
          </div>
        </div>
  `;
}

export function renderNotificationsPaneScript(nonce: string): string {
  return `
    <script nonce="${escapeAttr(nonce)}">
      (function () {
        const rows = document.getElementById("notification-rows");
        const form = document.getElementById("form-notification");
        if (!rows || !form) return;
        function cell(text, className) {
          const td = document.createElement("td");
          if (className) td.className = className;
          td.textContent = text;
          return td;
        }
        function render(list) {
          rows.replaceChildren();
          if (!list.length) {
            const row = document.createElement("tr");
            const td = cell("No notifications yet.", "table-empty");
            td.colSpan = 4;
            row.appendChild(td);
            rows.appendChild(row);
            return;
          }
          for (const n of list) {
            const row = document.createElement("tr");
            row.appendChild(cell(new Date(n.created_at * 1000).toISOString().slice(0, 10), "mono text-xs nowrap"));
            row.appendChild(cell(n.tenant_id ? n.tenant_name || "(deleted)" : "Every organization", "nowrap"));
            const what = document.createElement("td");
            const title = document.createElement("strong");
            title.textContent = n.title;
            const body = document.createElement("div");
            body.className = "cell-sub";
            body.textContent = n.body;
            what.append(title, body);
            row.appendChild(what);
            row.appendChild(cell(String(n.reads), "nowrap"));
            rows.appendChild(row);
          }
        }
        async function call(payload) {
          try {
            const res = await fetch("/api/super/notifications", payload
              ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) }
              : undefined);
            const data = await res.json();
            if (!res.ok) {
              lkToast(data.error || "The notification could not be sent", "error");
              return null;
            }
            render(data.notifications || []);
            return data;
          } catch (err) {
            lkToast("Network error: " + err.message, "error");
            return null;
          }
        }
        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          const to = document.getElementById("notification-to");
          const email = document.getElementById("notification-email").checked;
          const audience = to.value ? to.options[to.selectedIndex].textContent : "every organization";
          const ok = await lkConfirm({
            title: "Send this notification to " + audience + "?",
            message: email ? "It shows in their consoles, and each owner is emailed it." : "It shows in their consoles.",
            confirmLabel: "Send"
          });
          if (!ok) return;
          const data = await call({
            tenantId: to.value || null,
            title: document.getElementById("notification-title").value,
            body: document.getElementById("notification-body").value,
            email
          });
          if (!data) return;
          form.reset();
          if (data.emailProblem) lkToast("Sent to consoles. " + data.emailProblem + ".", "error");
          else if (email) lkToast("Sent; " + data.emailed + (data.emailed === 1 ? " owner" : " owners") + " emailed" + (data.emailFailed ? ", " + data.emailFailed + " failed" : ""), data.emailFailed ? "error" : "success");
          else lkToast("Notification sent", "success");
        });
        call(null);
      })();
    </script>
  `;
}
