/**
 * The organization console's notice of legal documents it has not accepted at
 * their current version (src/legal.ts). Until the notice period ends it sits
 * above every page; after that it is the page, until an administrator accepts.
 * Staff who may not accept are told who can.
 */

import { escapeAttr, escapeHtml } from "./escape";
import type { LegalStatus } from "./legal";
import { licenseDate, type LicenseState } from "./license";

export interface ConsoleLegal extends LegalStatus {
  /** This account is the owner or an org_admin. */
  canAccept: boolean;
}

function day(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

export function renderLegalNoticeHtml(legal: ConsoleLegal, organization: string): string {
  const docs = legal.pending
    .map((d) => `<a href="${escapeAttr(d.path)}" target="_blank" rel="noopener">${escapeHtml(d.title)}</a> (version ${escapeHtml(d.version)})`)
    .join(" and ");
  const effective = Math.min(...legal.pending.map((d) => d.effectiveAt));
  const versions = JSON.stringify(Object.fromEntries(legal.pending.map((d) => [d.id, d.version])));
  const lead = legal.gated
    ? `Before you continue, ${escapeHtml(organization)} needs to accept the updated ${docs}.`
    : `We have updated the ${docs}. Please review and accept ${legal.pending.length === 1 ? "it" : "them"} before ${escapeHtml(day(effective))}, when the console will ask for ${legal.pending.length === 1 ? "it" : "them"} before anything else.`;
  const action = legal.canAccept
    ? `<form id="form-legal-accept" class="mt-sm" data-versions="${escapeAttr(versions)}">
          <label class="form-checkbox-label">
            <input type="checkbox" class="form-checkbox" id="legal-agree" required>
            <span>I have read and accept the ${docs} on behalf of ${escapeHtml(organization)}, and I am authorized to do so.</span>
          </label>
          <button type="submit" class="btn btn-primary btn-sm mt-sm">Accept</button>
        </form>`
    : `<p class="mt-sm mb-0">The organization's owner or an administrator needs to accept ${legal.pending.length === 1 ? "it" : "them"}${legal.gated ? " before the console can be used" : ""}. Your workstations, homepage and User Portal keep working.</p>`;
  return `
      <div class="card" id="legal-notice" role="region" aria-label="Updated terms">
        <h2 class="card-title">${legal.gated ? "Accept the updated terms" : "Updated terms"}</h2>
        <p class="card-sub mb-0">${lead} Your workstations, homepage and User Portal keep working.</p>
        ${action}
      </div>`;
}

export function renderLegalNoticeScript(nonce: string): string {
  return `
    <script nonce="${escapeAttr(nonce)}">
      (function () {
        const form = document.getElementById("form-legal-accept");
        if (!form) return;
        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          const agree = document.getElementById("legal-agree");
          if (!agree || !agree.checked) return;
          let versions;
          try {
            versions = JSON.parse(form.dataset.versions || "{}");
          } catch (err) {
            lkToast("The page is out of date; reload it.", "error");
            return;
          }
          try {
            const res = await fetch(labkioskApi("/api/legal/accept"), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ versions })
            });
            const data = await res.json();
            if (!res.ok) {
              lkToast(data.error || "The terms could not be accepted", "error");
              return;
            }
            lkToast("Thank you. The updated terms are accepted.", "success");
            window.location.reload();
          } catch (err) {
            lkToast("Network error: " + err.message, "error");
          }
        });
      })();
    </script>
  `;
}

/** Content of this organization the platform took down, as its console tells it. */
export interface ConsoleTakedowns {
  homepage: { at: number; reason: string | null } | null;
  cards: Array<{ title: string; url: string; at: number; reason: string | null }>;
}

export function renderTakedownNoticeHtml(takedowns: ConsoleTakedowns): string {
  const items: string[] = [];
  if (takedowns.homepage) {
    items.push(
      `<li>Your organization homepage, on ${escapeHtml(day(takedowns.homepage.at))}${takedowns.homepage.reason ? `: ${escapeHtml(takedowns.homepage.reason)}` : "."} It shows "This content is unavailable" until Lab Kiosk restores it.</li>`
    );
  }
  for (const card of takedowns.cards) {
    items.push(
      `<li>The User Portal card <strong>${escapeHtml(card.title)}</strong> (<code>${escapeHtml(card.url)}</code>), on ${escapeHtml(day(card.at))}${card.reason ? `: ${escapeHtml(card.reason)}` : "."}</li>`
    );
  }
  return `
      <div class="card" id="takedown-notice" role="region" aria-label="Content taken down">
        <h2 class="card-title">Content taken down by Lab Kiosk</h2>
        <p class="card-sub">Lab Kiosk took this down under the Terms of Service and the <a href="/content-policy" target="_blank" rel="noopener noreferrer">Content Policy</a>. To contest it, write to <a href="mailto:legal@labkiosk.org">legal@labkiosk.org</a>.</p>
        <ul class="mb-0">${items.join("")}</ul>
      </div>`;
}

/** The organization's license is ending within LICENSE_REMINDER_DAYS, or has ended. */
export function renderLicenseNoticeHtml(license: LicenseState, organization: string): string {
  if (license.expiresAt === null || (!license.expired && !license.endingSoon)) return "";
  const date = escapeHtml(licenseDate(license.expiresAt));
  const lead = license.expired
    ? `The Lab Kiosk license of ${escapeHtml(organization)} ended on ${date}. Enrolled workstations, the homepage and the User Portal keep working, but no new workstation can be enrolled and Remote Control is off until it is renewed.`
    : `The Lab Kiosk license of ${escapeHtml(organization)} ends on ${date}. After that no new workstation can be enrolled and Remote Control is off until it is renewed; enrolled workstations keep working.`;
  return `
      <div class="card" id="license-notice" role="region" aria-label="License">
        <h2 class="card-title">${license.expired ? "License ended" : "License ending soon"}</h2>
        <p class="card-sub mb-0">${lead} To renew, write to <a href="mailto:sales@labkiosk.org">sales@labkiosk.org</a>.</p>
      </div>`;
}
