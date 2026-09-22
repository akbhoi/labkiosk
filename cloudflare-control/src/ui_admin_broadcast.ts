/**
 * The broadcast centre: point every screen at one lesson, plus the saved
 * shortcuts a school builds up.
 *
 * The page markup, its context-panel contents and its client script live
 * together here. They used to sit hundreds of lines apart inside one
 * 2,450-line module, which is how a panel full of controls that nothing
 * handled went unnoticed for so long.
 */

import { Tenant, PortalSite, BroadcastPreset } from "./types";
import { escapeHtml, escapeAttr, safeHttpUrl } from "./escape";
import { AdminPageInput, AdminPageParts } from "./ui_admin_shared";

export function buildBroadcastPage(options: AdminPageInput): AdminPageParts {
  const { tenant, config, sites, presets, teachers, tenantParam, baseDomain, nonce } = options;
  return {
    title: "Lesson Broadcast Center",
    contentHtml: renderBroadcastPageHtml(tenant, sites, presets),
    scriptsHtml: renderBroadcastScripts(nonce),
        subPanelTitle: "Broadcast Tools",
        subPanelSubtitle: "Synchronize lesson screens",
        subPanelHtml: `
          <div class="sub-section-title">Active Lesson Status</div>
          <div style="background: var(--bg-card); padding: 12px; border-radius: var(--radius-sm); border: 1px solid var(--border-subtle); margin-bottom: 12px;">
            <div style="font-size: 11px; color: var(--text-muted); text-transform: uppercase;">Current Broadcast URL</div>
            <div style="font-size: 12px; font-weight: 700; color: #93c5fd; margin-top: 4px; word-break: break-all; font-family: 'JetBrains Mono', monospace;" id="sub-active-url">${escapeHtml(tenant?.broadcast_url || "None (Student Portal Active)")}</div>
          </div>
          <div class="sub-action-list">
            <button type="button" class="sub-action-item" id="sub-btn-reset-portal" data-action="quick-reset-portal">
              <span style="display: flex; align-items: center; gap: 8px;">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>
                Clear / Release to Portal
              </span>
            </button>
          </div>

          <div class="sub-section-title" style="margin-top: 14px;">Quick Educational Presets</div>
          <div class="sub-action-list">
            <button type="button" class="sub-action-item" data-preset="https://scratch.mit.edu">
              <span>Scratch Programming</span>
            </button>
            <button type="button" class="sub-action-item" data-preset="https://phet.colorado.edu">
              <span>PhET Simulations</span>
            </button>
            <button type="button" class="sub-action-item" data-preset="https://www.khanacademy.org">
              <span>Khan Academy</span>
            </button>
            <button type="button" class="sub-action-item" data-preset="https://en.wikipedia.org">
              <span>Wikipedia</span>
            </button>
            ${presets
              .map(
                (p) => `
              <button type="button" class="sub-action-item" data-preset="${escapeAttr(p.url)}">
                <span>${escapeHtml(p.title)}</span>
              </button>
            `
              )
              .join("")}
          </div>
        `
  };
}

function renderBroadcastPageHtml(tenant?: Tenant, sites: PortalSite[] = [], presets: BroadcastPreset[] = []): string {
  const activeUrl = tenant?.broadcast_url;
  const isBroadcasting = Boolean(activeUrl);

  const presetsHtml = presets
    .map((p) => `
      <div class="preset-item">
        <div>
          <div style="font-weight: 700; font-size: 14px;">${escapeHtml(p.title)}</div>
          <div style="font-size: 12px; color: var(--text-muted); font-family: 'JetBrains Mono', monospace;">${escapeHtml(p.url)}</div>
        </div>
        <div style="display: flex; gap: 8px;">
          <button type="button" class="btn btn-sm btn-primary btn-launch-preset" data-url="${escapeAttr(p.url)}">Broadcast</button>
          <button type="button" class="btn btn-sm btn-danger btn-delete-preset" data-id="${escapeAttr(p.id)}">Delete</button>
        </div>
      </div>
    `)
    .join("");

  const appShortcutsHtml = sites
    .map((s) => `
      <button type="button" class="btn btn-secondary btn-launch-preset" data-url="${escapeAttr(s.url)}" style="display: inline-flex; align-items: center; gap: 8px; margin: 4px;">
        <span>${escapeHtml(s.icon || "🌐")}</span>
        <span>${escapeHtml(s.title)}</span>
      </button>
    `)
    .join("");

  return `
    <div class="page-head">
      <div>
        <h1 class="page-title">Lesson Broadcast Center</h1>
        <p class="page-desc">Direct all student workstations simultaneously to a learning resource or live simulation.</p>
      </div>
    </div>

    <div class="grid-2col">
      <div>
        <div class="card">
          <h2 class="card-title">
            <span class="stat-dot ${isBroadcasting ? "dot-green" : "dot-yellow"}"></span>
            ${isBroadcasting ? "Active Lesson Broadcast" : "No Broadcast Active"}
          </h2>
          <p class="card-sub">
            ${
              isBroadcasting
                ? `Workstations are currently synchronized to: <br><code style="font-size: 14px; margin-top: 6px; display: inline-block;">${escapeHtml(activeUrl!)}</code>`
                : "Workstations are displaying their standard Student Learning Portal."
            }
          </p>

          <form id="broadcast-form" style="margin-top: 20px;">
            <div class="form-group">
              <label class="form-label" for="broadcast-url">New Lesson or Resource URL</label>
              <input type="url" class="form-input" id="broadcast-url" required placeholder="https://scratch.mit.edu or https://phet.colorado.edu">
              <div class="form-hint">Workstations navigate instantly via top-level window. External iframes are never used.</div>
            </div>
            <div style="display: flex; gap: 10px;">
              <button type="submit" class="btn btn-primary">
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polygon points="5 3 19 12 5 21 5 3"/><line x1="19" y1="5" x2="19" y2="19"/></svg>
                Broadcast to All Screens
              </button>
              ${
                isBroadcasting
                  ? `<button type="button" class="btn btn-danger" id="btn-stop-broadcast">Stop Broadcast &amp; Return to Portal</button>`
                  : ""
              }
            </div>
          </form>
        </div>

        <div class="card">
          <h2 class="card-title">1-Click Broadcast from Portal Apps</h2>
          <p class="card-sub">Quickly launch an approved educational app across all student screens.</p>
          <div style="display: flex; flex-wrap: wrap;">
            ${appShortcutsHtml || `<p style="color: var(--text-muted); font-size: 13px;">No portal apps configured yet.</p>`}
          </div>
        </div>
      </div>

      <div>
        <div class="card">
          <h2 class="card-title">Custom Lesson Presets &amp; Shortcuts</h2>
          <p class="card-sub">Saved bookmarks for recurring classroom activities and exams.</p>

          <form id="add-preset-form" style="margin-bottom: 24px; padding-bottom: 20px; border-bottom: 1px solid var(--border);">
            <div class="form-group">
              <label class="form-label" for="preset-title">Shortcut Name</label>
              <input type="text" class="form-input" id="preset-title" required placeholder="e.g. Class 10 Python Practical">
            </div>
            <div class="form-group">
              <label class="form-label" for="preset-url">Target URL</label>
              <input type="url" class="form-input" id="preset-url" required placeholder="https://replit.com/@classroom/demo">
            </div>
            <button type="submit" class="btn btn-secondary">Save Shortcut</button>
          </form>

          <div id="presets-list">
            ${presetsHtml || `<p style="color: var(--text-muted); font-size: 13px;">No custom shortcuts saved yet.</p>`}
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderBroadcastScripts(nonce: string): string {
  return `
    <script nonce="${escapeAttr(nonce)}">
      document.getElementById("broadcast-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const url = document.getElementById("broadcast-url").value.trim();
        if (!url) return;
        try {
          const res = await fetch(labkioskApi("/api/command"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ target: "all", action: "navigate", url })
          });
          const data = await res.json();
          if (data.status === "ok") {
            window.location.reload();
          } else {
            lkToast(data.error || "Broadcast failed", "error");
          }
        } catch (err) {
          lkToast("Network error: " + err.message, "error");
        }
      });

      const stopBtn = document.getElementById("btn-stop-broadcast");
      if (stopBtn) {
        stopBtn.addEventListener("click", async () => {
          try {
            const res = await fetch(labkioskApi("/api/command"), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ target: "all", action: "navigate", resetPortal: true })
            });
            const data = await res.json();
            if (data.status === "ok") {
              window.location.reload();
            } else {
              lkToast(data.error || "Failed to stop broadcast", "error");
            }
          } catch (err) {
            lkToast("Network error: " + err.message, "error");
          }
        });
      }

      document.getElementById("add-preset-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const title = document.getElementById("preset-title").value.trim();
        const url = document.getElementById("preset-url").value.trim();
        if (!title || !url) return;
        try {
          const res = await fetch(labkioskApi("/api/broadcast-presets"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title, url })
          });
          const data = await res.json();
          if (data.preset) {
            window.location.reload();
          } else {
            lkToast(data.error || "Failed to save preset", "error");
          }
        } catch (err) {
          lkToast("Network error: " + err.message, "error");
        }
      });

      document.querySelectorAll(".btn-launch-preset").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const url = btn.dataset.url;
          if (!url) return;
          try {
            const res = await fetch(labkioskApi("/api/command"), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ target: "all", action: "navigate", url })
            });
            const data = await res.json();
            if (data.status === "ok") {
              window.location.reload();
            } else {
              lkToast(data.error || "Broadcast failed", "error");
            }
          } catch (err) {
            lkToast("Network error: " + err.message, "error");
          }
        });
      });

      document.querySelectorAll(".btn-delete-preset").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const id = btn.dataset.id;
          if (!id) return;
          const agreed = await lkConfirm({
            title: "Delete this shortcut?",
            message: "The saved lesson shortcut is removed from the broadcast panel. Workstations already on that page are not affected.",
            confirmLabel: "Delete",
            tone: "danger"
          });
          if (!agreed) return;
          try {
            const res = await fetch(labkioskApi("/api/broadcast-presets/" + encodeURIComponent(id)), { method: "DELETE" });
            const data = await res.json();
            if (data.status === "ok") {
              window.location.reload();
            } else {
              lkToast(data.error || "Failed to delete preset", "error");
            }
          } catch (err) {
            lkToast("Network error: " + err.message, "error");
          }
        });
      });
    </script>
  `;
}
