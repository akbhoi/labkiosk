/**
 * Super Admin -> System -> Legal: the legal documents organizations accept, the
 * version of each in force, when it was published and from when consoles ask
 * for it before anything else, how many active organizations accepted it, and
 * the acceptance record as CSV (src/legal.ts).
 */

import { escapeAttr } from "./escape";

export function renderLegalPaneHtml(): string {
  return `
        <div class="card">
          <h2 class="card-title">Legal documents</h2>
          <p class="card-sub">A new version of a document is published the first time the platform serves it. Organizations that have not accepted it see a notice in their console, and after the notice period the console asks for it before anything else. Workstations, homepages and User Portals keep working. The record of every acceptance is kept even after an organization is deleted.</p>
          <div class="table-container">
            <table>
              <thead>
                <tr>
                  <th>Document</th>
                  <th>Version</th>
                  <th>Published</th>
                  <th>Required from</th>
                  <th>Accepted by</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody id="legal-rows">
                <tr><td colspan="6" class="table-empty">Loading…</td></tr>
              </tbody>
            </table>
          </div>
          <a class="btn btn-secondary btn-sm mt-md" href="/api/super/legal/acceptances?format=csv" download>Download every acceptance (CSV)</a>
        </div>
  `;
}

export function renderLegalScript(nonce: string): string {
  return `
    <script nonce="${escapeAttr(nonce)}">
      (function () {
        const rows = document.getElementById("legal-rows");
        if (!rows) return;
        function day(seconds) {
          return seconds ? new Date(seconds * 1000).toISOString().slice(0, 10) : "";
        }
        function cell(text, className) {
          const td = document.createElement("td");
          if (className) td.className = className;
          td.textContent = text;
          return td;
        }
        function render(data) {
          rows.replaceChildren();
          const total = Number(data.activeOrganizations) || 0;
          for (const d of data.documents || []) {
            const row = document.createElement("tr");
            const title = document.createElement("td");
            const link = document.createElement("a");
            link.href = d.path;
            link.target = "_blank";
            link.rel = "noopener";
            link.textContent = d.title;
            title.appendChild(link);
            row.appendChild(title);
            row.appendChild(cell(d.version, "mono"));
            row.appendChild(cell(day(d.publishedAt), "mono text-xs nowrap"));
            row.appendChild(cell(d.required ? day(d.effectiveAt) : "Acknowledged at registration", d.required ? "mono text-xs nowrap" : "text-xs"));
            row.appendChild(cell(d.required ? d.acceptedBy + " of " + total + " active organizations" : "", "nowrap"));
            const actions = document.createElement("td");
            if (d.required) {
              const b = document.createElement("button");
              b.type = "button";
              b.className = "btn btn-sm btn-secondary";
              b.textContent = d.notifiedAt ? "Email again" : "Email organizations";
              b.dataset.notify = d.id;
              b.dataset.title = d.title;
              actions.appendChild(b);
              if (d.notifiedAt) {
                const sent = document.createElement("div");
                sent.className = "text-xs nowrap";
                sent.textContent = "Last emailed " + day(d.notifiedAt);
                actions.appendChild(sent);
              }
            }
            row.appendChild(actions);
            rows.appendChild(row);
          }
        }
        async function load() {
          try {
            const res = await fetch("/api/super/legal");
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "The legal documents could not be read");
            render(data);
          } catch (err) {
            rows.replaceChildren();
            const row = document.createElement("tr");
            const td = cell(err.message, "table-empty");
            td.colSpan = 6;
            row.appendChild(td);
            rows.appendChild(row);
          }
        }
        rows.addEventListener("click", async (event) => {
          const b = event.target && event.target.closest ? event.target.closest("[data-notify]") : null;
          if (!b) return;
          const ok = await lkConfirm({
            title: "Email organizations about the " + b.dataset.title + "?",
            message: "The owner of every active organization that has not accepted the current version is emailed a link to it and the date its console starts asking for it.",
            confirmLabel: "Send emails"
          });
          if (!ok) return;
          try {
            const res = await fetch("/api/super/legal/notify", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ document: b.dataset.notify })
            });
            const data = await res.json();
            if (!res.ok) {
              lkToast(data.error || "The emails could not be sent", "error");
              return;
            }
            render(data);
            lkToast(data.emailed + (data.emailed === 1 ? " organization" : " organizations") + " emailed" + (data.failed ? ", " + data.failed + " failed" : ""), data.failed ? "error" : "success");
          } catch (err) {
            lkToast("Network error: " + err.message, "error");
          }
        });
        load();
      })();
    </script>
  `;
}
