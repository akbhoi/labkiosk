/**
 * The Super Admin console's Overview (/super): where the console opens. What
 * needs the platform's attention (open requests, address and domain requests,
 * Education applications, unread mail, plans ending, failing status checks,
 * paid amounts that did not match, failed charges), the platform's numbers and
 * shortcuts. Counts the console already has are rendered on the server; the
 * rest comes from /api/super/billing and /api/super/status.
 */

import { escapeAttr, escapeHtml, escapeJson } from "./escape";

export interface SuperOverviewData {
  organizations: { active: number; pending: number; suspended: number };
  workstations: { online: number; total: number };
  tasks: { requests: number; subdomains: number; customDomains: number; education: number };
  unreadMail: number;
  plansEndingSoon: number;
  plansLapsed: number;
}

interface Item {
  tone: "danger" | "warning" | "info";
  text: string;
  label: string;
  href: string;
}

export function renderSuperOverviewPaneHtml(d: SuperOverviewData): string {
  const items: Item[] = [];
  const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
  if (d.organizations.pending) items.push({ tone: "warning", text: `${plural(d.organizations.pending, "registration waits", "registrations wait")} for approval.`, label: "Review", href: "/super/tasks?tab=requests" });
  if (d.tasks.requests > d.organizations.pending) items.push({ tone: "warning", text: `${plural(d.tasks.requests, "open request", "open requests")} under Tasks.`, label: "Open Tasks", href: "/super/tasks?tab=requests" });
  if (d.tasks.education) items.push({ tone: "warning", text: `${plural(d.tasks.education, "Education application waits", "Education applications wait")} for review.`, label: "Review", href: "/super/tasks?tab=education" });
  if (d.tasks.subdomains) items.push({ tone: "info", text: `${plural(d.tasks.subdomains, "organization asks", "organizations ask")} for a chosen address.`, label: "Review", href: "/super/tasks?tab=subdomains" });
  if (d.tasks.customDomains) items.push({ tone: "info", text: `${plural(d.tasks.customDomains, "custom domain waits", "custom domains wait")} for approval.`, label: "Review", href: "/super/tasks?tab=custom-domains" });
  if (d.unreadMail) items.push({ tone: "info", text: `${plural(d.unreadMail, "unread message", "unread messages")} in Mail.`, label: "Open Mail", href: "/super/mail?view=unread" });
  if (d.plansEndingSoon) items.push({ tone: "info", text: `${plural(d.plansEndingSoon, "organization's plan ends", "organizations' plans end")} soon.`, label: "Organizations", href: "/super/organizations" });
  if (d.organizations.suspended) items.push({ tone: "info", text: `${plural(d.organizations.suspended, "organization is", "organizations are")} suspended.`, label: "Organizations", href: "/super/organizations" });
  const dot = (tone: string) => `<span class="ov-dot is-${tone}"></span>`;
  const shortcuts = [
    ["/super/tasks", "Tasks", "Registrations, addresses, Education"],
    ["/super/mail", "Mail", "Support, sales and billing mail"],
    ["/super/billing", "Billing", "Subscriptions and payment links"],
    ["/super/releases", "Releases", "Classify and withdraw system images"],
    ["/super/platform?tab=system-status", "Status & incidents", "Checks and open incidents"],
    ["/super/platform?tab=system-notifications", "Notify organizations", "A notice in every console"]
  ];
  return `
      <style>
        .ov-attention { display: grid; gap: 10px; margin: 0; padding: 0; list-style: none; }
        .ov-attention li { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding: 12px 14px; border-radius: var(--radius-sm); border: 1px solid var(--border-subtle); background: var(--bg-subtle); }
        .ov-text { display: flex; align-items: center; gap: 10px; min-width: 0; }
        .ov-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
        .ov-dot.is-danger { background: var(--danger); }
        .ov-dot.is-warning { background: var(--warning); }
        .ov-dot.is-info { background: var(--accent); }
        .ov-allclear { color: var(--success-text); font-weight: 600; }
        .ov-shortcuts { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(min(220px, 100%), 1fr)); }
        .ov-shortcut { display: block; padding: 14px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--bg-surface); color: var(--text-main); text-decoration: none; transition: border-color 120ms ease; }
        .ov-shortcut:hover, .ov-shortcut:focus-visible { border-color: var(--accent); }
        .ov-shortcut strong { display: block; font-size: 0.9375rem; }
        .ov-shortcut span { display: block; font-size: 0.8125rem; color: var(--text-muted); margin-top: 2px; }
      </style>
      <div class="tab-pane active" id="pane-overview">
        <div class="card">
          <h2 class="card-title">Needs attention</h2>
          <ul class="ov-attention" id="sov-attention" aria-live="polite">
            ${items
              .map(
                (i) => `<li data-tone="${i.tone}"><div class="ov-text">${dot(i.tone)}<span>${escapeHtml(i.text)}</span></div><a class="btn btn-secondary btn-sm" href="${escapeAttr(i.href)}">${escapeHtml(i.label)}</a></li>`
              )
              .join("\n            ")}
          </ul>
        </div>

        <div class="stat-grid mt-lg">
          <div class="stat-tile"><div class="stat-tile-label">Organizations</div><div class="stat-tile-value">${d.organizations.active}</div><div class="stat-tile-hint">${d.organizations.pending} pending, ${d.organizations.suspended} suspended</div></div>
          <div class="stat-tile"><div class="stat-tile-label">Workstations online</div><div class="stat-tile-value">${d.workstations.online} of ${d.workstations.total}</div><div class="stat-tile-hint">Across every organization</div></div>
          <div class="stat-tile"><div class="stat-tile-label">Monthly recurring revenue</div><div class="stat-tile-value" id="sov-mrr">&ndash;</div><div class="stat-tile-hint" id="sov-mrr-hint">Before GST</div></div>
          <div class="stat-tile"><div class="stat-tile-label">Status checks</div><div class="stat-tile-value" id="sov-status">&ndash;</div><div class="stat-tile-hint" id="sov-status-hint">Run every five minutes</div></div>
        </div>

        <h2 class="card-title mt-lg">Shortcuts</h2>
        <div class="ov-shortcuts">
          ${shortcuts.map(([href, label, hint]) => `<a class="ov-shortcut" href="${escapeAttr(href)}"><strong>${escapeHtml(label)}</strong><span>${escapeHtml(hint)}</span></a>`).join("\n          ")}
        </div>
      </div>`;
}

export function renderSuperOverviewScript(nonce: string): string {
  const empty = "All clear: nothing needs the platform's attention.";
  return `
    <script nonce="${escapeAttr(nonce)}">
      (function () {
        "use strict";
        const list = document.getElementById("sov-attention");
        const order = { danger: 0, warning: 1, info: 2 };
        function add(tone, text, label, href) {
          const li = document.createElement("li");
          li.dataset.tone = tone;
          const wrap = document.createElement("div");
          wrap.className = "ov-text";
          const dot = document.createElement("span");
          dot.className = "ov-dot is-" + tone;
          const words = document.createElement("span");
          words.textContent = text;
          wrap.append(dot, words);
          const a = document.createElement("a");
          a.className = "btn btn-secondary btn-sm";
          a.href = href;
          a.textContent = label;
          li.append(wrap, a);
          list.append(li);
        }
        function finish() {
          const items = Array.from(list.children).filter((li) => li.dataset.tone);
          items.sort((a, b) => order[a.dataset.tone] - order[b.dataset.tone]).forEach((li) => list.append(li));
          if (!items.length) {
            const ok = document.createElement("li");
            ok.className = "ov-allclear";
            ok.textContent = ${escapeJson(empty)};
            list.append(ok);
          }
        }
        const money = (p) => "\\u20b9" + Math.round(p / 100).toLocaleString("en-IN");
        const billing = fetch("/api/super/billing").then((r) => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)))).then((b) => {
          document.getElementById("sov-mrr").textContent = money(b.tiles.mrr);
          document.getElementById("sov-mrr-hint").textContent = b.tiles.active + " active, " + b.tiles.pastDue + " past due";
          const mismatches = (b.attention || []).filter((a) => a.outcome === "amount_mismatch").length;
          if (mismatches) add("danger", mismatches + " payment" + (mismatches === 1 ? "" : "s") + " did not match what was sold and granted nothing.", "Billing", "/super/billing");
          if (b.tiles.pastDue) add("warning", b.tiles.pastDue + " subscription" + (b.tiles.pastDue === 1 ? " is" : "s are") + " past due.", "Billing", "/super/billing");
          if (!b.enabled) add("info", "Razorpay keys are not set: organizations cannot pay online.", "Billing", "/super/billing");
          else if (!b.gstRegistered) add("info", "SELLER_GSTIN is not set to a valid GSTIN: no GST is charged.", "Billing", "/super/billing");
        });
        const status = fetch("/api/super/status").then((r) => (r.ok ? r.json() : Promise.reject(new Error("HTTP " + r.status)))).then((s) => {
          const components = Array.isArray(s.components) ? s.components : [];
          const failing = components.filter((c) => c.ok === false);
          const checked = components.filter((c) => c.ok !== null);
          document.getElementById("sov-status").textContent = checked.length ? (failing.length ? failing.length + " failing" : "All working") : "Not checked yet";
          for (const c of failing) add("danger", c.label + " is failing" + (c.detail ? ": " + c.detail : "."), "Status", "/super/platform?tab=system-status");
          const open = (Array.isArray(s.incidents) ? s.incidents : []).filter((i) => !i.resolved_at);
          for (const i of open) add("warning", "Open incident: " + i.title, "Status", "/super/platform?tab=system-status");
        });
        Promise.allSettled([billing, status]).then((results) => {
          for (const r of results) if (r.status === "rejected") console.warn("[Overview] A check could not be loaded:", r.reason);
          finish();
        });
      })();
    </script>`;
}
