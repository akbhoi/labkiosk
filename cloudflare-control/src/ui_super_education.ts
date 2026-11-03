/**
 * Super Admin -> Tasks -> Education: institutions' applications for the free
 * Education plan (src/education.ts). Each shows what the institution gave, the
 * address it confirmed with a code, and its certificate; approving puts the
 * organization on Education, rejecting needs a reason the institution is told.
 */

import { escapeAttr } from "./escape";

export function renderEducationPaneHtml(): string {
  return `
      <div class="card" id="education-applications">
        <h2 class="card-title">Education applications</h2>
        <p class="card-sub">Open the certificate, check the affiliation number with the board's own register, and check that the website is the institution's. The address was proved with an emailed code and is on the website's domain. Approving gives the free Education plan for a year.</p>
        <div class="table-container table-scrollable">
          <table>
            <thead><tr><th>Institution</th><th>Affiliation</th><th>Website and address</th><th>Sent</th><th>Status</th><th class="th-actions"><span class="visually-hidden">Actions</span></th></tr></thead>
            <tbody id="education-rows"><tr><td colspan="6" class="table-empty">Loading…</td></tr></tbody>
          </table>
        </div>
      </div>`;
}

export function renderEducationScript(nonce: string): string {
  return `
    <script nonce="${escapeAttr(nonce)}">
      (function () {
        const rows = document.getElementById("education-rows");
        if (!rows) return;
        const STATUS = { pending: ["Waiting", "badge-yellow"], approved: ["Approved", "badge-green"], rejected: ["Rejected", "badge-neutral"] };
        function cell(text, className) {
          const td = document.createElement("td");
          td.textContent = text;
          if (className) td.className = className;
          return td;
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
        async function decide(a, decision) {
          let reason = "";
          if (decision === "reject") {
            reason = await lkPrompt({
              title: "Reject " + a.institution + "?",
              message: "The institution is told this reason by email and in its console, and can apply again.",
              label: "Reason",
              value: "",
              hint: "Such as: the affiliation number is not in the CBSE register.",
              confirmLabel: "Reject"
            });
            if (!reason) return;
          } else {
            const ok = await lkConfirm({
              title: "Approve " + a.institution + "?",
              message: a.organization + " goes on the free Education plan for a year, and its owner is emailed.",
              confirmLabel: "Approve",
              tone: "primary"
            });
            if (!ok) return;
          }
          try {
            const res = await fetch("/api/super/education/decide", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ id: a.id, decision, reason })
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
            lkToast((decision === "approve" ? "Approved" : "Rejected") + (data.emailed ? ", and the owner was emailed." : ". The email did not go out."), data.emailed ? "success" : "warning");
            load();
          } catch (err) {
            lkToast("Could not save: " + err.message, "error");
          }
        }
        function render(list) {
          if (!list.length) return empty("No institution has applied yet.");
          rows.replaceChildren();
          for (const a of list) {
            const row = document.createElement("tr");
            const institution = cell(a.institution, "cell-title");
            const org = document.createElement("div");
            org.className = "cell-sub";
            org.textContent = a.organization + " (" + a.subdomain + ")";
            institution.appendChild(org);
            const site = document.createElement("td");
            const link = document.createElement("a");
            link.href = a.website;
            link.target = "_blank";
            link.rel = "noopener noreferrer";
            link.textContent = a.website;
            const mail = document.createElement("div");
            mail.className = "cell-sub";
            mail.textContent = a.email + " (confirmed)";
            site.append(link, mail);
            const status = document.createElement("td");
            const badge = document.createElement("span");
            badge.className = "badge " + STATUS[a.status][1];
            badge.textContent = STATUS[a.status][0];
            status.appendChild(badge);
            if (a.reason) {
              const why = document.createElement("div");
              why.className = "cell-sub";
              why.textContent = a.reason;
              status.appendChild(why);
            }
            const actions = document.createElement("td");
            const wrap = document.createElement("div");
            wrap.className = "cell-actions";
            if (a.hasCertificate) {
              const view = document.createElement("a");
              view.className = "btn btn-sm btn-secondary";
              view.href = "/api/super/education/" + encodeURIComponent(a.id) + "/certificate";
              view.target = "_blank";
              view.rel = "noopener";
              view.textContent = "Certificate";
              wrap.appendChild(view);
            }
            if (a.status === "pending") {
              for (const [label, decision, tone] of [["Approve", "approve", "btn-primary"], ["Reject", "reject", "btn-ghost"]]) {
                const b = document.createElement("button");
                b.type = "button";
                b.className = "btn btn-sm " + tone;
                b.textContent = label;
                b.addEventListener("click", () => decide(a, decision));
                wrap.appendChild(b);
              }
            }
            actions.appendChild(wrap);
            row.append(institution, cell(a.board + ", " + a.affiliationNumber), site, cell(day(a.submittedAt)), status, actions);
            rows.appendChild(row);
          }
        }
        async function load() {
          try {
            const res = await fetch("/api/super/education");
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
            render(data.applications);
          } catch (err) {
            empty("Could not load: " + err.message);
          }
        }
        load();
      })();
    </script>`;
}
