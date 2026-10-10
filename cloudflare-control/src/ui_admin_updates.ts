/**
 * Settings -> Updates: which releases this organization's workstations are
 * offered. Shown to an account holding the `updates` permission.
 *
 * Stable is every release the platform has classified stable; beta adds the
 * releases it is still trying out. A workstation downloads the offered release
 * in the background when it hears of it; installing it is the Workstations
 * page's Updates menu, never automatic.
 */

import { escapeAttr } from "./escape";

export function renderUpdatesPaneHtml(): string {
  return `
      <div class="card" id="section-updates">
        <h2 class="card-title">System updates</h2>
        <p class="card-sub">Workstations installed on a disk download the release offered here in the background, check its signature, and wait. Install it from Workstations → Updates. A workstation started from a USB stick is updated by re-flashing it.</p>
        <form id="form-update-channel">
          <div class="form-group">
            <label class="form-label" for="update-channel">Update channel</label>
            <select class="form-select" id="update-channel">
              <option value="stable">Stable: releases the platform has finished testing</option>
              <option value="beta">Beta: also releases still being tried out</option>
            </select>
          </div>
          <p class="form-hint" id="update-offer">Loading…</p>
          <button type="submit" class="btn btn-primary">Save channel</button>
        </form>
      </div>
  `;
}

export function renderUpdatesScript(nonce: string): string {
  return `
    <script nonce="${escapeAttr(nonce)}">
      (function () {
        const form = document.getElementById("form-update-channel");
        const select = document.getElementById("update-channel");
        const offer = document.getElementById("update-offer");
        if (!form || !select || !offer) return;

        function show(data) {
          select.value = data.channel === "beta" ? "beta" : "stable";
          const o = data.offer;
          offer.textContent = o
            ? "Offered now: " + o.version + (o.kind === "security" ? " (security update)" : "") + ", " + Math.round((Number(o.sizeBytes) || 0) / 1048576) + " MB."
            : "No release is offered on this channel yet.";
        }

        async function load() {
          try {
            const res = await fetch(labkioskApi("/api/settings/updates"));
            const data = await res.json();
            if (!res.ok) {
              offer.textContent = data.error || "The update settings could not be read.";
              return;
            }
            show(data);
          } catch (err) {
            offer.textContent = "Network error: " + err.message;
          }
        }

        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          try {
            const res = await fetch(labkioskApi("/api/settings/updates"), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ channel: select.value })
            });
            const data = await res.json();
            if (!res.ok) {
              lkToast(data.error || "The channel could not be saved", "error");
              return;
            }
            show(data);
            lkToast("Update channel saved.", "success");
          } catch (err) {
            lkToast("Network error: " + err.message, "error");
          }
        });

        load();
      })();
    </script>
  `;
}
