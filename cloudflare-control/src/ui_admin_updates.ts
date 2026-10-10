/**
 * Settings -> Updates: which releases this organization's workstations are
 * offered, and what they do with a security release for the line they run.
 * Shown to an account holding the `updates` permission.
 *
 * Stable is every release the platform has classified stable; beta adds the
 * releases it is still trying out. A workstation downloads the offered release
 * in the background when it hears of it; installing a feature release is the
 * Workstations page's Updates menu, never automatic. A security release (the
 * same release rebuilt with patched Debian packages) installs at the
 * workstation's next start unless the organization approves those too.
 */

import { escapeAttr } from "./escape";
import { SECURITY_WAIT_WARN_DAYS } from "./releases";

export function renderUpdatesPaneHtml(): string {
  return `
      <div class="card" id="section-updates">
        <h2 class="card-title">System updates</h2>
        <p class="card-sub">Workstations installed on a disk download the release offered here in the background, check its signature, and wait. Install it from Workstations → Updates. A workstation started from a USB stick is updated by re-flashing it.</p>
        <div class="callout hidden" id="update-pending" role="status"></div>
        <form id="form-update-channel">
          <div class="form-group">
            <label class="form-label" for="update-channel">Update channel</label>
            <select class="form-select" id="update-channel">
              <option value="stable">Stable: releases the platform has finished testing</option>
              <option value="beta">Beta: also releases still being tried out</option>
            </select>
            <p class="form-hint" id="update-offer">Loading…</p>
          </div>
          <div class="form-group">
            <label class="form-label" for="security-updates">Security fixes</label>
            <select class="form-select" id="security-updates">
              <option value="next_boot">Install at the next restart, without approval</option>
              <option value="approval">Wait for approval, like any other release</option>
            </select>
            <p class="form-hint">A security fix is the release a workstation runs, rebuilt with patched system packages. Installed at the next restart, it changes nothing until the workstation starts again, and a workstation it does not start on goes back to its old image by itself.</p>
          </div>
          <button type="submit" class="btn btn-primary">Save update settings</button>
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
        const security = document.getElementById("security-updates");
        const offer = document.getElementById("update-offer");
        const pending = document.getElementById("update-pending");
        if (!form || !select || !security || !offer || !pending) return;

        // Security fixes some workstations do not run yet; a warning once one has waited too long.
        function showPending(list, mode) {
          // One block inside the callout, which lays its children out in a row.
          const body = document.createElement("div");
          pending.replaceChildren(body);
          const items = Array.isArray(list) ? list : [];
          let late = false;
          for (const item of items) {
            const days = Math.max(0, Math.floor((Date.now() / 1000 - (Number(item.offeredAt) || 0)) / 86400));
            if (days >= ${SECURITY_WAIT_WARN_DAYS}) late = true;
            const line = document.createElement("div");
            const count = Number(item.workstations) || 0;
            line.textContent =
              "Security fix " + item.version + " is not running yet on " + count + (count === 1 ? " workstation" : " workstations") +
              " (offered " + (days === 0 ? "today" : days === 1 ? "1 day ago" : days + " days ago") + ").";
            body.append(line);
          }
          if (items.length) {
            const next = document.createElement("div");
            next.textContent = mode === "approval"
              ? "Install it from Workstations → Updates once it shows ready."
              : "It installs when each workstation next starts; Workstations → Reboot installs it now.";
            body.append(next);
          }
          pending.classList.toggle("callout-warning", late);
          pending.classList.toggle("hidden", !items.length);
        }

        function show(data) {
          select.value = data.channel === "beta" ? "beta" : "stable";
          security.value = data.securityUpdates === "approval" ? "approval" : "next_boot";
          const o = data.offer;
          offer.textContent = o
            ? "Offered now: " + o.version + (o.kind === "security" ? " (security update)" : "") + ", " + Math.round((Number(o.sizeBytes) || 0) / 1048576) + " MB."
            : "No release is offered on this channel yet.";
          showPending(data.pending, security.value);
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
              body: JSON.stringify({ channel: select.value, securityUpdates: security.value })
            });
            const data = await res.json();
            if (!res.ok) {
              lkToast(data.error || "The update settings could not be saved", "error");
              return;
            }
            show(data);
            lkToast("Update settings saved.", "success");
          } catch (err) {
            lkToast("Network error: " + err.message, "error");
          }
        });

        load();
      })();
    </script>
  `;
}
