/**
 * Overview: where the console opens. It answers "is anything wrong, and what
 * should I do next?" for the signed-in account: what needs attention (a plan
 * ending or a payment failing, workstations or staff over the plan, problems
 * workstations reported, workstations offline), the numbers that matter, and
 * shortcuts to what people do most. Each part shows only what the account's
 * permissions let it read; the data comes from the same routes the other
 * pages use (/api/clients, /api/billing, /api/workstation-issues, /api/audit-logs).
 */

import { escapeAttr, escapeHtml, escapeJson } from "./escape";
import { AdminPageInput, AdminPageParts } from "./ui_admin_shared";

interface Shortcut {
  href: string;
  label: string;
  hint: string;
  icon: string;
}

const ICONS = {
  screens: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`,
  broadcast: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4.9 19.1a10 10 0 0 1 0-14.2"/><path d="M7.8 16.2a6 6 0 0 1 0-8.4"/><circle cx="12" cy="12" r="2"/><path d="M16.2 7.8a6 6 0 0 1 0 8.4"/><path d="M19.1 4.9a10 10 0 0 1 0 14.2"/></svg>`,
  exam: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>`,
  staff: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>`,
  enrol: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.78 7.78 5.5 5.5 0 0 1 7.78-7.78zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/></svg>`,
  plan: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>`,
  reports: `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>`
};

export function buildOverviewPage(options: AdminPageInput): AdminPageParts {
  const perms = options.permissions ?? [];
  const all = perms.includes("*");
  const can = (p: string) => all || perms.includes(p);
  const q = options.tenantParam;
  const withTab = (path: string, tab: string) => `${path}${q ? `${q}&` : "?"}tab=${tab}`;
  const shortcuts: Shortcut[] = [];
  if (can("workstations")) shortcuts.push({ href: `/admin/workstations${q}`, label: "Workstations", hint: "Live screens, lock and commands", icon: ICONS.screens });
  if (can("broadcast")) shortcuts.push({ href: withTab("/admin/apps-web", "broadcast"), label: "Broadcast a page", hint: "Send every screen to one page", icon: ICONS.broadcast });
  if (can("workstations")) shortcuts.push({ href: `/admin/exams${q}`, label: "Schedule an exam", hint: "Hold workstations on an exam site", icon: ICONS.exam });
  if (can("staff")) shortcuts.push({ href: `/admin/staff${q}`, label: "Add staff", hint: "Delegate to colleagues", icon: ICONS.staff });
  if (can("settings")) {
    shortcuts.push({ href: withTab("/admin/settings", "security"), label: "Enrol a workstation", hint: "The enrolment key, then the ISO", icon: ICONS.enrol });
    shortcuts.push({ href: `/admin/plan${q}`, label: "Plan & billing", hint: "Plan, seats and invoices", icon: ICONS.plan });
    shortcuts.push({ href: `/admin/reports${q}`, label: "Reports", hint: "Usage, problems and activity", icon: ICONS.reports });
  }
  const name = options.tenant?.name ?? "your organization";
  return {
    title: "Overview",
    contentHtml: `
    <style>
      .ov-attention { display: grid; gap: 10px; margin: 0; padding: 0; list-style: none; }
      .ov-attention li { display: flex; align-items: center; justify-content: space-between; gap: 12px; flex-wrap: wrap; padding: 12px 14px; border-radius: var(--radius-sm); border: 1px solid var(--border-subtle); background: var(--bg-subtle); }
      .ov-attention .ov-text { display: flex; align-items: center; gap: 10px; min-width: 0; }
      .ov-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
      .ov-dot.is-danger { background: var(--danger); }
      .ov-dot.is-warning { background: var(--warning); }
      .ov-dot.is-info { background: var(--accent); }
      .ov-allclear { display: flex; align-items: center; gap: 10px; color: var(--success-text); font-weight: 600; }
      .ov-shortcuts { display: grid; gap: 12px; grid-template-columns: repeat(auto-fill, minmax(min(220px, 100%), 1fr)); }
      .ov-shortcut { display: flex; gap: 12px; align-items: flex-start; padding: 14px; border: 1px solid var(--border); border-radius: var(--radius-md); background: var(--bg-surface); color: var(--text-main); text-decoration: none; transition: border-color 120ms ease; }
      .ov-shortcut:hover, .ov-shortcut:focus-visible { border-color: var(--accent); }
      .ov-shortcut svg { color: var(--accent); flex-shrink: 0; margin-top: 2px; }
      .ov-shortcut strong { display: block; font-size: 0.9375rem; }
      .ov-shortcut span { display: block; font-size: 0.8125rem; color: var(--text-muted); margin-top: 2px; }
      .ov-list { display: grid; gap: 0; margin: 0; padding: 0; list-style: none; }
      .ov-list li { display: flex; justify-content: space-between; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--border-subtle); font-size: 0.875rem; }
      .ov-list li:last-child { border-bottom: 0; }
      .ov-list .ov-when { color: var(--text-muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
      .ov-list .ov-what { min-width: 0; overflow-wrap: anywhere; }
    </style>
    <div class="page-head">
      <div>
        <h1 class="page-title">Overview</h1>
        <p class="page-desc">What needs your attention at ${escapeHtml(name)}, and shortcuts to what you do most.</p>
      </div>
    </div>

    <div class="card" id="ov-attention-card">
      <h2 class="card-title">Needs attention</h2>
      <p class="card-sub" id="ov-attention-sub">Checking your workstations, plan and reports…</p>
      <ul class="ov-attention" id="ov-attention" aria-live="polite"></ul>
    </div>

    <div class="stat-grid mt-lg" id="ov-stats">
      ${can("workstations") ? `<div class="stat-tile"><div class="stat-tile-label">Online now</div><div class="stat-tile-value" id="ov-online">–</div><div class="stat-tile-hint" id="ov-online-hint"></div></div>` : ""}
      ${can("workstations") ? `<div class="stat-tile"><div class="stat-tile-label">Locked</div><div class="stat-tile-value" id="ov-locked">–</div><div class="stat-tile-hint">Screens showing the lock message</div></div>` : ""}
      ${can("settings") ? `<div class="stat-tile"><div class="stat-tile-label">Plan</div><div class="stat-tile-value" id="ov-plan">–</div><div class="stat-tile-hint" id="ov-plan-hint"></div></div>` : ""}
      ${can("settings") ? `<div class="stat-tile"><div class="stat-tile-label">Problems, last 7 days</div><div class="stat-tile-value" id="ov-problems">–</div><div class="stat-tile-hint">Reported by workstations</div></div>` : ""}
    </div>

    ${
      shortcuts.length
        ? `<h2 class="card-title mt-lg">Shortcuts</h2>
    <div class="ov-shortcuts">
      ${shortcuts.map((s) => `<a class="ov-shortcut" href="${escapeAttr(s.href)}">${s.icon}<div><strong>${escapeHtml(s.label)}</strong><span>${escapeHtml(s.hint)}</span></div></a>`).join("\n      ")}
    </div>`
        : ""
    }

    ${
      can("settings")
        ? `<div class="grid-2col mt-lg">
      <div class="card">
        <div class="row-between"><h2 class="card-title">Recent problems</h2><a class="btn btn-ghost btn-sm" href="${escapeAttr(withTab("/admin/reports", "issues"))}">All problems</a></div>
        <ul class="ov-list" id="ov-problem-list"><li><span class="ov-what text-muted">Loading…</span></li></ul>
      </div>
      <div class="card">
        <div class="row-between"><h2 class="card-title">Recent activity</h2><a class="btn btn-ghost btn-sm" href="${escapeAttr(withTab("/admin/reports", "activity"))}">Activity log</a></div>
        <ul class="ov-list" id="ov-activity-list"><li><span class="ov-what text-muted">Loading…</span></li></ul>
      </div>
    </div>`
        : ""
    }
  `,
    scriptsHtml: renderOverviewScript(options.nonce, {
      workstations: can("workstations"),
      settings: can("settings"),
      links: {
        workstations: `/admin/workstations${q}`,
        plan: `/admin/plan${q}`,
        issues: withTab("/admin/reports", "issues"),
        staff: `/admin/plan${q}#section-staff`
      }
    })
  };
}

function renderOverviewScript(
  nonce: string,
  ctx: { workstations: boolean; settings: boolean; links: Record<"workstations" | "plan" | "issues" | "staff", string> }
): string {
  return `
    <script nonce="${escapeAttr(nonce)}">
      (function () {
        "use strict";
        const CTX = ${escapeJson(ctx)};
        const $ = (id) => document.getElementById(id);
        const DAY = 86400;
        const now = () => Date.now() / 1000;
        const day = (s) => new Date(s * 1000).toLocaleDateString([], { dateStyle: "medium" });
        const when = (s) => new Date(s * 1000).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
        async function get(path) {
          const res = await fetch(labkioskApi(path));
          if (!res.ok) throw new Error("HTTP " + res.status);
          return res.json();
        }
        const items = [];
        function attention(tone, text, linkLabel, href) {
          items.push({ tone, text, linkLabel, href });
        }
        function renderAttention(failed) {
          const list = $("ov-attention");
          list.replaceChildren();
          const order = { danger: 0, warning: 1, info: 2 };
          items.sort((a, b) => order[a.tone] - order[b.tone]);
          if (!items.length) {
            $("ov-attention-sub").textContent = failed ? "Some checks could not be loaded; reload the page to try again." : "";
            if (!failed) {
              const ok = document.createElement("li");
              ok.className = "ov-allclear";
              ok.textContent = "All clear: nothing needs your attention.";
              list.append(ok);
            }
            return;
          }
          $("ov-attention-sub").textContent =
            items.length + (items.length === 1 ? " thing needs" : " things need") + " your attention." + (failed ? " Some checks could not be loaded." : "");
          for (const it of items) {
            const li = document.createElement("li");
            const text = document.createElement("div");
            text.className = "ov-text";
            const dot = document.createElement("span");
            dot.className = "ov-dot is-" + it.tone;
            const words = document.createElement("span");
            words.textContent = it.text;
            text.append(dot, words);
            li.append(text);
            if (it.href) {
              const a = document.createElement("a");
              a.className = "btn btn-secondary btn-sm";
              a.href = it.href;
              a.textContent = it.linkLabel;
              li.append(a);
            }
            list.append(li);
          }
        }
        function fillList(id, rows, empty) {
          const list = $(id);
          if (!list) return;
          list.replaceChildren();
          if (!rows.length) {
            const li = document.createElement("li");
            const span = document.createElement("span");
            span.className = "ov-what text-muted";
            span.textContent = empty;
            li.append(span);
            list.append(li);
            return;
          }
          for (const r of rows) {
            const li = document.createElement("li");
            const what = document.createElement("span");
            what.className = "ov-what";
            what.textContent = r.what;
            const at = document.createElement("span");
            at.className = "ov-when";
            at.textContent = when(r.at);
            li.append(what, at);
            list.append(li);
          }
        }

        async function load() {
          let failed = false;
          const jobs = [];
          if (CTX.workstations) {
            jobs.push(get("/api/clients").then((data) => {
              const clients = Object.values(data.clients || {});
              const online = clients.filter((c) => c.online);
              $("ov-online").textContent = online.length + " of " + clients.length;
              $("ov-online-hint").textContent = clients.length ? Math.round((online.length / clients.length) * 100) + "% of enrolled workstations" : "No workstation enrolled yet";
              $("ov-locked").textContent = String(online.filter((c) => c.isLocked).length);
              if (!clients.length) attention("info", "No workstation is enrolled yet. Flash the ISO, start a computer from it and enter your enrolment key.", "How to enrol", CTX.settings ? "/download" : "");
            }));
          }
          if (CTX.settings) {
            jobs.push(get("/api/billing").then((b) => {
              const p = b.plan;
              $("ov-plan").textContent = b.subscription ? b.subscription.tierLabel : p.label;
              const sub = b.subscription;
              $("ov-plan-hint").textContent = sub && sub.currentEnd
                ? (sub.status === "cancelled" ? "Ends " : "Renews ") + day(sub.currentEnd)
                : p.expiresAt ? "Until " + day(p.expiresAt) : "No end date";
              if (p.graceEndsAt && p.graceEndsAt > now()) attention("danger", "A renewal payment failed. The plan stays until " + day(p.graceEndsAt) + "; update the payment method to keep it.", "Fix payment", CTX.links.plan);
              else if (sub && sub.status === "pending") attention("warning", "Razorpay could not charge your renewal and is trying again.", "Plan & billing", CTX.links.plan);
              if (p.lapsed) attention("warning", "Your plan ended on " + day(p.expiresAt) + ". You are on Free.", "Choose a plan", CTX.links.plan);
              else if (p.endingSoon && !(sub && sub.status === "active")) attention("warning", "Your plan ends on " + day(p.expiresAt) + ".", "Renew", CTX.links.plan);
              if (sub && sub.status === "cancelled" && sub.currentEnd > now()) attention("info", "Your subscription is cancelled and ends on " + day(sub.currentEnd) + ".", "Resume", CTX.links.plan);
              const waiting = b.waitingCheckout || (b.replacement && b.replacement.authoriseUrl ? b.replacement : null);
              if (waiting) attention("warning", "A payment for " + waiting.tierLabel + " is waiting for you to authorise it.", "Open Plan & billing", CTX.links.plan);
              const unlicensed = b.usage.workstations - b.usage.licensed;
              if (unlicensed > 0) attention("warning", unlicensed + " workstation" + (unlicensed === 1 ? " is" : "s are") + " over the plan's limit and show a licence notice.", "Fix it", CTX.links.plan);
              const suspended = (b.staff || []).filter((s) => s.suspended).length;
              if (suspended) attention("warning", suspended + " staff account" + (suspended === 1 ? " is" : "s are") + " suspended because the plan allows " + p.staff + ".", "Review staff", CTX.links.staff);
              if (p.workstations > 0 && b.usage.workstations >= p.workstations && unlicensed === 0) attention("info", "Every workstation your plan covers is in use; add more before enrolling another.", "Add workstations", CTX.links.plan);
            }));
            jobs.push(get("/api/workstation-issues?limit=100").then((data) => {
              const issues = Array.isArray(data.issues) ? data.issues : [];
              const week = issues.filter((i) => i.occurred_at > now() - 7 * DAY);
              $("ov-problems").textContent = String(week.length);
              const errors = week.filter((i) => i.severity === "error").length;
              if (errors) attention("warning", errors + " error" + (errors === 1 ? "" : "s") + " reported by workstations in the last 7 days.", "See problems", CTX.links.issues);
              fillList("ov-problem-list", issues.slice(0, 5).map((i) => ({ what: i.client_id + ": " + (i.details || i.kind.replace(/_/g, " ")), at: i.occurred_at })), "No problems reported.");
            }));
            jobs.push(get("/api/audit-logs?limit=6").then((data) => {
              const logs = Array.isArray(data.logs) ? data.logs : [];
              fillList("ov-activity-list", logs.slice(0, 6).map((l) => ({ what: l.action + (l.details ? " " + l.details : ""), at: l.created_at })), "Nothing recorded yet.");
            }));
          }
          const results = await Promise.allSettled(jobs);
          for (const r of results) {
            if (r.status === "rejected") {
              failed = true;
              console.warn("[Overview] A check could not be loaded:", r.reason);
            }
          }
          renderAttention(failed);
        }
        load();
      })();
    </script>`;
}
