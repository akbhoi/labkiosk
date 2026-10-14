/**
 * The organization console's notifications from the platform (src/notifications.ts):
 * the ones this user has not dismissed sit above every page, newest first,
 * until they dismiss them.
 */

import { escapeAttr, escapeHtml } from "./escape";
import type { NotificationRow } from "./notifications";

/** How many undismissed notifications the console lists; the count says how many more there are. */
const SHOWN = 5;

function day(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

export function renderNotificationsHtml(notifications: readonly NotificationRow[]): string {
  if (!notifications.length) return "";
  const items = notifications
    .slice(0, SHOWN)
    .map(
      (n) => `
          <li data-notification="${escapeAttr(n.id)}">
            <div class="stack-sm">
              <div class="row"><strong>${escapeHtml(n.title)}</strong><span class="text-xs text-muted">${escapeHtml(day(n.created_at))}</span></div>
              <p class="card-sub mb-0">${escapeHtml(n.body).replace(/\n/g, "<br>")}</p>
            </div>
            <button type="button" class="btn btn-sm btn-ghost" data-dismiss="${escapeAttr(n.id)}">Dismiss</button>
          </li>`
    )
    .join("");
  const more = notifications.length - SHOWN;
  return `
      <div class="card" id="notifications-card" role="region" aria-label="Notifications from Lab Kiosk">
        <div class="row-between">
          <h2 class="card-title">Notifications from Lab Kiosk</h2>
          ${notifications.length > 1 ? `<button type="button" class="btn btn-sm btn-ghost" id="notifications-dismiss-all">Dismiss all</button>` : ""}
        </div>
        <ul class="notice-list">${items}</ul>
        ${more > 0 ? `<p class="card-sub mb-0">${more} more after you dismiss these.</p>` : ""}
      </div>`;
}

export function renderNotificationsScript(nonce: string): string {
  return `
    <script nonce="${escapeAttr(nonce)}">
      (function () {
        const card = document.getElementById("notifications-card");
        if (!card) return;
        async function dismiss(ids) {
          try {
            const res = await fetch(labkioskApi("/api/notifications/read"), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(ids ? { ids } : {})
            });
            const data = await res.json();
            if (!res.ok) {
              lkToast(data.error || "The notification could not be dismissed", "error");
              return;
            }
            if (!ids || data.unread === 0) {
              card.remove();
              return;
            }
            for (const id of ids) {
              const item = card.querySelector('[data-notification="' + CSS.escape(id) + '"]');
              if (item) item.remove();
            }
            // Dismissed the ones shown, more are waiting: show them.
            if (!card.querySelector("[data-notification]")) window.location.reload();
          } catch (err) {
            lkToast("Network error: " + err.message, "error");
          }
        }
        card.addEventListener("click", (event) => {
          const button = event.target && event.target.closest ? event.target.closest("[data-dismiss]") : null;
          if (button) dismiss([button.dataset.dismiss]);
        });
        const all = document.getElementById("notifications-dismiss-all");
        if (all) all.addEventListener("click", () => dismiss(null));
      })();
    </script>`;
}
