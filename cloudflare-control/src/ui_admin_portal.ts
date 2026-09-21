/**
 * The student portal manager: the cards a student sees on the launcher grid.
 *
 * The page markup, its context-panel contents and its client script live
 * together here. They used to sit hundreds of lines apart inside one
 * 2,450-line module, which is how a panel full of controls that nothing
 * handled went unnoticed for so long.
 */

import { Tenant, PortalSite } from "./types";
import { escapeHtml, escapeAttr, safeHttpUrl } from "./escape";
import { AdminPageInput, AdminPageParts } from "./ui_admin_shared";

export function buildPortalPage(options: AdminPageInput): AdminPageParts {
  const { tenant, config, sites, presets, teachers, tenantParam, baseDomain, nonce } = options;
  return {
    title: "Student Learning Portal Manager",
    contentHtml: renderPortalPageHtml(tenant, sites),
    scriptsHtml: renderPortalScripts(nonce),
        subPanelTitle: "Portal Manager",
        subPanelSubtitle: "Curate educational resources",
        subPanelHtml: `
          <div class="sub-section-title">Actions</div>
          <div class="sub-action-list">
            <button type="button" class="sub-action-item" data-focus="app-title">
              <span style="display: flex; align-items: center; gap: 8px;">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                Add App Card
              </span>
            </button>
            <a href="/?tenant=${encodeURIComponent(tenant?.subdomain || "demo")}" target="_blank" rel="noopener noreferrer" class="sub-action-item">
              <span style="display: flex; align-items: center; gap: 8px;">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                Preview Student Portal
              </span>
            </a>
          </div>

          <div class="sub-section-title" style="margin-top: 14px;">Summary</div>
          <div style="background: var(--bg-card); padding: 12px; border-radius: var(--radius-sm); border: 1px solid var(--border-subtle); font-size: 13px;">
            <div style="display: flex; justify-content: space-between; margin-bottom: 6px;">
              <span style="color: var(--text-muted);">Total Apps:</span>
              <strong>${sites.length}</strong>
            </div>
            <div style="display: flex; justify-content: space-between;">
              <span style="color: var(--text-muted);">Current Mode:</span>
              <span class="badge ${tenant?.mode === "single_url" ? "badge-yellow" : "badge-green"}">${tenant?.mode === "single_url" ? "Single URL" : "App Grid"}</span>
            </div>
          </div>

          <div class="sub-section-title" style="margin-top: 14px;">Navigation</div>
          <div class="sub-action-list">
            <a href="/admin/workstations${tenantParam}" class="sub-action-item">
              <span>← Back to Workstations</span>
            </a>
          </div>
        `
  };
}

function renderPortalPageHtml(_tenant?: Tenant, sites: PortalSite[] = []): string {
  const cardsHtml = sites
    .map((s) => `
      <div class="card" style="display: flex; flex-direction: column; justify-content: space-between; gap: 12px; padding: 18px;">
        <div style="display: flex; align-items: center; gap: 12px;">
          <span style="font-size: 24px;">${escapeHtml(s.icon || "🌐")}</span>
          <div>
            <div style="font-weight: 700; font-size: 15px;">${escapeHtml(s.title)}</div>
            <div style="font-size: 12px; color: var(--text-muted); font-family: 'JetBrains Mono', monospace;">${escapeHtml(s.domain)}</div>
          </div>
        </div>
        <div style="font-size: 12px; color: #93c5fd; background: rgba(59, 130, 246, 0.1); padding: 4px 8px; border-radius: 6px; align-self: flex-start;">
          ${escapeHtml(s.category)}
        </div>
        <div style="display: flex; justify-content: space-between; align-items: center; border-top: 1px solid var(--border-subtle); padding-top: 12px; margin-top: 4px;">
          <a href="${escapeAttr(safeHttpUrl(s.url) || "#")}" target="_blank" rel="noopener noreferrer" style="font-size: 12px; color: var(--accent); text-decoration: none;">Test Link &rarr;</a>
          <button type="button" class="btn btn-sm btn-danger btn-delete-app" data-id="${escapeAttr(s.id)}">Remove</button>
        </div>
      </div>
    `)
    .join("");

  return `
    <div class="page-head">
      <div>
        <h1 class="page-title">Student Learning Portal Manager</h1>
        <p class="page-desc">Configure the application cards students see when logging into thin client workstations.</p>
      </div>
      <div>
        <a href="/portal" target="_blank" rel="noopener noreferrer" class="btn btn-secondary">
          Preview Student Portal &rarr;
        </a>
      </div>
    </div>

    <div class="grid-2col">
      <div>
        <div class="card">
          <h2 class="card-title">Add Educational Application</h2>
          <p class="card-sub">Applications are automatically permitted through the kiosk domain filter.</p>

          <form id="add-app-form">
            <div class="form-group">
              <label class="form-label" for="app-title">Application Title</label>
              <input type="text" class="form-input" id="app-title" required placeholder="e.g. Scratch Creative Coding">
            </div>
            <div class="form-group">
              <label class="form-label" for="app-url">Destination URL</label>
              <input type="url" class="form-input" id="app-url" required placeholder="https://scratch.mit.edu">
            </div>
            <div class="grid-2col" style="gap: 12px; margin-bottom: 0;">
              <div class="form-group">
                <label class="form-label" for="app-category">Subject / Category</label>
                <input type="text" class="form-input" id="app-category" placeholder="e.g. Computer Science">
              </div>
              <div class="form-group">
                <label class="form-label" for="app-icon">Icon Emoji</label>
                <input type="text" class="form-input" id="app-icon" placeholder="e.g. 🐱 or 🔬" maxlength="4">
              </div>
            </div>
            <div class="form-group">
              <label class="form-label" for="app-thumb">Thumbnail Image URL (Optional)</label>
              <input type="url" class="form-input" id="app-thumb" placeholder="https://images.unsplash.com/photo-...">
            </div>
            <button type="submit" class="btn btn-primary">Add to Student Portal</button>
          </form>
        </div>
      </div>

      <div>
        <h2 style="font-size: 18px; font-weight: 700; margin-bottom: 16px;">Active Portal Cards (${sites.length})</h2>
        <div style="display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 16px;">
          ${cardsHtml || `<p style="color: var(--text-muted); font-size: 13px;">No applications added yet.</p>`}
        </div>
      </div>
    </div>
  `;
}

function renderPortalScripts(nonce: string): string {
  return `
    <script nonce="${escapeAttr(nonce)}">
      document.getElementById("add-app-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const title = document.getElementById("app-title").value.trim();
        const url = document.getElementById("app-url").value.trim();
        const category = document.getElementById("app-category").value.trim() || "General";
        const icon = document.getElementById("app-icon").value.trim() || "🌐";
        const thumbnailUrl = document.getElementById("app-thumb").value.trim() || undefined;

        if (!title || !url) return;
        try {
          const res = await fetch(labkioskApi("/api/portal-sites"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title, url, category, icon, thumbnailUrl })
          });
          const data = await res.json();
          if (data.site) {
            window.location.reload();
          } else {
            lkToast(data.error || "Failed to add application", "error");
          }
        } catch (err) {
          lkToast("Network error: " + err.message, "error");
        }
      });

      document.querySelectorAll(".btn-delete-app").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const id = btn.dataset.id;
          if (!id) return;
          const agreed = await lkConfirm({
            title: "Remove this app from the portal?",
            message: "Students will no longer see this card. The site stays on the domain allowlist unless you remove it there too.",
            confirmLabel: "Remove",
            tone: "danger"
          });
          if (!agreed) return;
          try {
            const res = await fetch(labkioskApi("/api/portal-sites/" + encodeURIComponent(id)), { method: "DELETE" });
            const data = await res.json();
            if (data.status === "ok") {
              window.location.reload();
            } else {
              lkToast(data.error || "Failed to remove application", "error");
            }
          } catch (err) {
            lkToast("Network error: " + err.message, "error");
          }
        });
      });
    </script>
  `;
}
