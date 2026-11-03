/**
 * Super Admin -> System -> Status: what the automatic checks found, and the
 * incidents shown on /status and in every organization's console (src/status.ts).
 */

import { escapeAttr } from "./escape";
import { INCIDENT_LIMITS } from "./status";

export function renderStatusPaneHtml(): string {
  return `
        <div class="card">
          <h2 class="card-title">Checks</h2>
          <p class="card-sub">Run every five minutes and shown on the public <a href="/status" target="_blank" rel="noopener">status page</a>. An outside monitor should watch <code>/api/health</code>, because this Worker cannot report its own outage.</p>
          <div class="table-container">
            <table>
              <thead><tr><th>Component</th><th>State</th><th>Last checked</th></tr></thead>
              <tbody id="status-check-rows"><tr><td colspan="3" class="table-empty">Loading…</td></tr></tbody>
            </table>
          </div>
        </div>
        <div class="card">
          <h2 class="card-title">Open an incident</h2>
          <p class="card-sub">It shows on the status page and as a banner in every organization's console until it is resolved. Nothing is emailed.</p>
          <form id="form-incident">
            <div class="form-group">
              <label class="form-label" for="incident-title">Title</label>
              <input type="text" class="form-input" id="incident-title" required maxlength="${INCIDENT_LIMITS.title}" placeholder="Workstations cannot connect">
            </div>
            <div class="form-group">
              <label class="form-label" for="incident-impact">Impact</label>
              <select class="form-select" id="incident-impact">
                <option value="minor">Minor: some things are slow or failing</option>
                <option value="major">Major: a service is down</option>
              </select>
            </div>
            <div class="form-group">
              <label class="form-label" for="incident-body">First update</label>
              <textarea class="form-textarea" id="incident-body" rows="3" required maxlength="${INCIDENT_LIMITS.body}" placeholder="We are looking into it."></textarea>
            </div>
            <button type="submit" class="btn btn-primary">Open incident</button>
          </form>
        </div>
        <div class="card">
          <h2 class="card-title">Incidents</h2>
          <div id="incident-list"><p class="card-sub">Loading…</p></div>
        </div>
  `;
}

export function renderStatusPaneScript(nonce: string): string {
  return `
    <script nonce="${escapeAttr(nonce)}">
      (function () {
        const rows = document.getElementById("status-check-rows");
        const list = document.getElementById("incident-list");
        const form = document.getElementById("form-incident");
        if (!rows || !list || !form) return;
        const STATUSES = ["investigating", "identified", "monitoring", "resolved"];
        const when = (s) => new Date(s * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";
        function el(tag, className, text) {
          const node = document.createElement(tag);
          if (className) node.className = className;
          if (text !== undefined) node.textContent = text;
          return node;
        }
        function renderChecks(components) {
          rows.replaceChildren();
          for (const c of components) {
            const row = el("tr");
            row.appendChild(el("td", null, c.label));
            const state = el("td");
            state.appendChild(el("span", "badge " + (c.ok === null ? "badge-neutral" : c.ok ? "badge-green" : "badge-red"), c.ok === null ? "Not checked yet" : c.ok ? "Working" : "Problem"));
            if (c.detail) state.appendChild(el("div", "cell-sub", c.detail));
            row.appendChild(state);
            row.appendChild(el("td", "mono text-xs nowrap", c.checkedAt ? when(c.checkedAt) : "-"));
            rows.appendChild(row);
          }
        }
        function renderIncidents(incidents) {
          list.replaceChildren();
          if (!incidents.length) {
            list.appendChild(el("p", "card-sub", "No incidents in the last 90 days."));
            return;
          }
          for (const i of incidents) {
            const box = el("div", "stack-sm mt-md");
            const head = el("div", "row");
            head.appendChild(el("strong", null, i.title));
            head.appendChild(el("span", "badge " + (i.resolved_at ? "badge-green" : i.impact === "major" ? "badge-red" : "badge-yellow"), i.resolved_at ? "Resolved" : i.impact + ", " + i.status));
            box.appendChild(head);
            for (const u of i.updates) box.appendChild(el("div", "cell-sub", when(u.created_at) + " · " + u.status + ": " + u.body));
            if (!i.resolved_at) {
              const update = el("form", "form-row mt-sm");
              const status = el("select", "form-select");
              status.setAttribute("aria-label", "New status");
              for (const s of STATUSES) {
                const option = el("option", null, s);
                option.value = s;
                if (s === i.status) option.selected = true;
                status.appendChild(option);
              }
              const body = el("input", "form-input");
              body.type = "text";
              body.required = true;
              body.maxLength = ${INCIDENT_LIMITS.body};
              body.placeholder = "What changed";
              body.setAttribute("aria-label", "Update");
              const post = el("button", "btn btn-sm btn-secondary", "Post update");
              post.type = "submit";
              update.append(status, body, post);
              update.addEventListener("submit", async (event) => {
                event.preventDefault();
                if (status.value === "resolved") {
                  const ok = await lkConfirm({ title: "Resolve this incident?", message: "The banner leaves every console, and no more updates can be posted.", confirmLabel: "Resolve" });
                  if (!ok) return;
                }
                const data = await call("/api/super/status/incidents/" + encodeURIComponent(i.id), { status: status.value, body: body.value });
                if (data) lkToast("Update posted", "success");
              });
              box.appendChild(update);
            }
            list.appendChild(box);
          }
        }
        async function call(url, payload) {
          try {
            const res = await fetch(url, payload ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) } : undefined);
            const data = await res.json();
            if (!res.ok) {
              lkToast(data.error || "The request failed", "error");
              return null;
            }
            if (data.components) renderChecks(data.components);
            if (data.incidents) renderIncidents(data.incidents);
            return data;
          } catch (err) {
            lkToast("Network error: " + err.message, "error");
            return null;
          }
        }
        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          const ok = await lkConfirm({ title: "Open this incident?", message: "It shows on the status page and in every organization's console.", confirmLabel: "Open incident" });
          if (!ok) return;
          const data = await call("/api/super/status/incidents", {
            title: document.getElementById("incident-title").value,
            impact: document.getElementById("incident-impact").value,
            body: document.getElementById("incident-body").value
          });
          if (data) {
            form.reset();
            lkToast("Incident opened", "success");
          }
        });
        call("/api/super/status", null);
      })();
    </script>
  `;
}
