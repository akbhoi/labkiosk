/**
 * The body of /status (src/status.ts): each component's state now, a strip of
 * its last 90 days, and the incidents of those days. The page shell is the
 * public site's (src/ui_landing.ts, renderPlatformStatusHtml).
 */

import { escapeAttr, escapeHtml } from "./escape";
import { ComponentStatus, Incident, IncidentStatus, STATUS_DAYS } from "./status";

const STATUS_WORDS: Record<IncidentStatus, string> = {
  investigating: "Investigating",
  identified: "Identified",
  monitoring: "Monitoring",
  resolved: "Resolved"
};

/** A check older than this means the checks themselves stopped. */
const STALE_SECONDS = 20 * 60;

function when(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC";
}

function dayTone(day: ComponentStatus["days"][number]): { tone: string; label: string } {
  if (!day) return { tone: "none", label: "No checks" };
  if (day.failures === 0) return { tone: "ok", label: `${day.day}: no problems in ${day.checks} checks` };
  const share = day.failures / day.checks;
  return { tone: share < 0.05 ? "minor" : "major", label: `${day.day}: ${day.failures} of ${day.checks} checks failed` };
}

function uptime(c: ComponentStatus): string {
  const checked = c.days.filter((d): d is NonNullable<typeof d> => d !== null);
  const checks = checked.reduce((n, d) => n + d.checks, 0);
  if (!checks) return "";
  const failures = checked.reduce((n, d) => n + d.failures, 0);
  return `${(((checks - failures) / checks) * 100).toFixed(2)}% of checks passed`;
}

export function statusMainHtml(components: ComponentStatus[], incidents: Incident[], nowSeconds: number): string {
  const open = incidents.filter((i) => !i.resolved_at);
  const stale = components.some((c) => c.checkedAt !== null && nowSeconds - c.checkedAt > STALE_SECONDS);
  const failing = components.filter((c) => c.ok === false);
  const headline = open.some((i) => i.impact === "major")
    ? { tone: "major", text: "A major incident is under way" }
    : open.length || failing.length
      ? { tone: "minor", text: "Some services have problems" }
      : components.every((c) => c.ok === null)
        ? { tone: "none", text: "No checks have run yet" }
        : { tone: "ok", text: "All services are working" };

  const rows = components
    .map((c) => {
      const state = c.ok === null ? "Not checked yet" : c.ok ? "Working" : "Problem";
      const tone = c.ok === null ? "none" : c.ok ? "ok" : "major";
      const strip = c.days
        .map((d) => {
          const { tone: t, label } = dayTone(d);
          return `<span class="st-day st-${t}" title="${escapeAttr(label)}"></span>`;
        })
        .join("");
      return `
          <li class="st-component">
            <div class="st-row">
              <strong>${escapeHtml(c.label)}</strong>
              <span class="st-state st-text-${tone}">${state}</span>
            </div>
            <div class="st-strip" role="img" aria-label="${escapeAttr(`${c.label}, last ${STATUS_DAYS} days. ${uptime(c) || "No checks yet"}.`)}">${strip}</div>
            <div class="st-legend"><span>${STATUS_DAYS} days ago</span><span>${escapeHtml(uptime(c))}</span><span>Today</span></div>
          </li>`;
    })
    .join("");

  const incidentHtml = incidents.length
    ? incidents
        .map(
          (i) => `
          <article class="st-incident">
            <h3>${escapeHtml(i.title)} <span class="st-badge st-${i.resolved_at ? "ok" : i.impact}">${i.resolved_at ? "Resolved" : i.impact === "major" ? "Major" : "Minor"}</span></h3>
            <ol class="st-updates">${i.updates
              .map(
                (u) => `
              <li><strong>${STATUS_WORDS[u.status]}</strong> <span class="st-when">${escapeHtml(when(u.created_at))}</span><p>${escapeHtml(u.body).replace(/\n/g, "<br>")}</p></li>`
              )
              .join("")}
            </ol>
          </article>`
        )
        .join("")
    : `<p class="st-empty">No incidents in the last ${STATUS_DAYS} days.</p>`;

  const checkedAt = components.reduce((latest, c) => Math.max(latest, c.checkedAt ?? 0), 0);
  return `
    <style>
      .st-wrap { max-width: 860px; margin: 0 auto; }
      .st-headline { display: flex; align-items: center; gap: 12px; padding: 18px 20px; border-radius: var(--radius); border: 1px solid var(--border); background: var(--bg-surface); font-weight: 650; font-size: 1.0625rem; margin-bottom: 24px; }
      .st-dot { width: 12px; height: 12px; border-radius: 50%; flex-shrink: 0; }
      .st-components { list-style: none; margin: 0; padding: 0; border: 1px solid var(--border); border-radius: var(--radius); background: var(--bg-surface); }
      .st-component { padding: 16px 20px; border-top: 1px solid var(--border); }
      .st-component:first-child { border-top: 0; }
      .st-row { display: flex; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
      .st-strip { display: flex; gap: 2px; height: 28px; }
      .st-day { flex: 1; min-width: 1px; border-radius: 2px; }
      .st-legend { display: flex; justify-content: space-between; gap: 8px; font-size: 12px; color: var(--text-muted); margin-top: 6px; }
      .st-ok { background: var(--success); }
      .st-minor { background: var(--warning); }
      .st-major { background: var(--danger); }
      .st-none { background: var(--border); }
      .st-text-ok { color: var(--success-text); }
      .st-text-major { color: var(--danger-text); }
      .st-text-none { color: var(--text-muted); }
      .st-incidents { margin-top: 36px; }
      .st-incident { padding: 16px 0; border-top: 1px solid var(--border); }
      .st-incident h3 { font-size: 1rem; margin: 0 0 8px; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
      .st-badge { font-size: 11px; font-weight: 600; color: #fff; padding: 2px 8px; border-radius: 999px; }
      .st-updates { list-style: none; margin: 0; padding: 0; }
      .st-updates li { margin: 0 0 10px; }
      .st-updates p { margin: 4px 0 0; color: var(--text-muted); }
      .st-when, .st-empty, .st-note { color: var(--text-muted); font-size: 13px; }
      .st-note { margin: 10px 0 0; }
      @media (max-width: 600px) { .st-strip { gap: 1px; height: 24px; } .st-legend span:nth-child(2) { display: none; } }
    </style>
    <section class="page-hero">
      <h1 class="page-hero-title">Lab Kiosk <span>status</span></h1>
      <p class="page-hero-desc">Checked automatically every five minutes. Incidents are posted by our team as they happen.</p>
    </section>
    <section class="section-wrap" style="padding-top: 0;">
      <div class="st-wrap">
        <div class="st-headline" role="status"><span class="st-dot st-${headline.tone}" aria-hidden="true"></span>${escapeHtml(headline.text)}</div>
        <ul class="st-components">${rows}
        </ul>
        <p class="st-note">${checkedAt ? `Last checked ${escapeHtml(when(checkedAt))}.` : ""}${
          stale ? " The checks have not run for a while, so this page may be out of date." : ""
        } If this page itself does not load, the platform is down.</p>
        <div class="st-incidents">
          <h2>Incidents</h2>
          ${incidentHtml}
        </div>
      </div>
    </section>`;
}
