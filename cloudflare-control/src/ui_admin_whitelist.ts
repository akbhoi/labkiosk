/**
 * The domain allowlist, which becomes Chromium's managed URLAllowlist policy
 * on every workstation at its next heartbeat.
 *
 * The page markup, its context-panel contents and its client script live
 * together here. They used to sit hundreds of lines apart inside one
 * 2,450-line module, which is how a panel full of controls that nothing
 * handled went unnoticed for so long.
 */

import { escapeHtml, escapeAttr } from "./escape";
import { AdminPageInput, AdminPageParts } from "./ui_admin_shared";

export function buildWhitelistPage(options: AdminPageInput): AdminPageParts {
  const { tenant, config, sites, presets, teachers, tenantParam, baseDomain, nonce } = options;
  return {
    title: "Allowed Educational Domains",
    contentHtml: renderWhitelistPageHtml(config.whitelist),
    scriptsHtml: renderWhitelistScripts(nonce),
        subPanelTitle: "Domain Allowlist",
        subPanelSubtitle: "Chromium policy firewall",
        subPanelHtml: `
          <div class="sub-section-title">Actions</div>
          <div class="sub-action-list">
            <button type="button" class="sub-action-item" data-focus="domain-input">
              <span style="display: flex; align-items: center; gap: 8px;">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                Add Domain
              </span>
            </button>
          </div>

          <div class="sub-section-title" style="margin-top: 14px;">Quick Presets</div>
          <div class="sub-action-list">
            <button type="button" class="sub-action-item" data-quick-domain="scratch.mit.edu">
              <span>+ scratch.mit.edu</span>
            </button>
            <button type="button" class="sub-action-item" data-quick-domain="phet.colorado.edu">
              <span>+ phet.colorado.edu</span>
            </button>
            <button type="button" class="sub-action-item" data-quick-domain="khanacademy.org">
              <span>+ khanacademy.org</span>
            </button>
          </div>

          <div class="sub-section-title" style="margin-top: 14px;">Policy Info</div>
          <div style="background: var(--bg-card); padding: 12px; border-radius: var(--radius-sm); border: 1px solid var(--border-subtle); font-size: 12px; color: var(--text-muted); line-height: 1.4;">
            Permitted domains are merged into Chromium's enterprise managed policy (<code>URLAllowlist</code>) upon each 3-second heartbeat.
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

function renderWhitelistPageHtml(domains: string[] = []): string {
  const domainTagsHtml = domains
    .map((d) => `
      <span class="domain-tag">
        <span>${escapeHtml(d)}</span>
        <button type="button" class="btn-remove-domain" data-domain="${escapeAttr(d)}" style="background: none; border: none; color: var(--text-muted); cursor: pointer; font-size: 12px; padding: 0 2px;">✕</button>
      </span>
    `)
    .join("");

  return `
    <div class="page-head">
      <div>
        <h1 class="page-title">Domain Allowlist &amp; Content Security</h1>
        <p class="page-desc">Define the educational web domains student thin clients are permitted to access.</p>
      </div>
    </div>

    <div class="grid-2col">
      <div>
        <div class="card">
          <h2 class="card-title">Add Allowed Domain</h2>
          <p class="card-sub">Student Chromium browsers enforce this policy at the OS layer.</p>

          <form id="add-domain-form" style="margin-bottom: 24px;">
            <div class="form-group">
              <label class="form-label" for="domain-input">Domain Name</label>
              <input type="text" class="form-input" id="domain-input" required placeholder="e.g. scratch.mit.edu">
              <div class="form-hint">Enter the bare domain without http:// or trailing slashes.</div>
            </div>
            <button type="submit" class="btn btn-primary">Add to Allowlist</button>
          </form>

          <h3 style="font-size: 14px; font-weight: 700; margin-bottom: 12px;">Quick-Add Educational Preset Packs</h3>
          <div style="display: flex; gap: 8px; flex-wrap: wrap;">
            <button type="button" class="btn btn-secondary btn-sm btn-pack" data-domains="khanacademy.org,kastatic.org,kasandbox.org">Khan Academy Pack</button>
            <button type="button" class="btn btn-secondary btn-sm btn-pack" data-domains="scratch.mit.edu,replit.com,github.com">Coding &amp; STEM Pack</button>
            <button type="button" class="btn btn-secondary btn-sm btn-pack" data-domains="cbse.gov.in,ncert.nic.in,diksha.gov.in">CBSE / NCERT Pack</button>
            <button type="button" class="btn btn-secondary btn-sm btn-pack" data-domains="wikipedia.org,wikimedia.org">Encyclopedia Pack</button>
          </div>
        </div>
      </div>

      <div>
        <div class="card">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
            <h2 class="card-title" style="margin-bottom: 0;">Currently Allowed Domains (${domains.length})</h2>
            <input type="text" id="filter-domains" placeholder="Search domains..." style="background: var(--bg-card); border: 1px solid var(--border); border-radius: 6px; padding: 4px 10px; font-size: 12px; color: #fff;">
          </div>
          <div id="domains-container" style="display: flex; flex-wrap: wrap; gap: 8px; max-height: 480px; overflow-y: auto;">
            ${domainTagsHtml || `<p style="color: var(--text-muted); font-size: 13px;">No domains configured.</p>`}
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderWhitelistScripts(nonce: string): string {
  return `
    <script nonce="${escapeAttr(nonce)}">
      document.getElementById("add-domain-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const domain = document.getElementById("domain-input").value.trim();
        if (!domain) return;
        try {
          const res = await fetch(labkioskApi("/api/whitelist"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "add", domain })
          });
          const data = await res.json();
          if (data.status === "ok") {
            window.location.reload();
          } else {
            lkToast(data.error || "Failed to add domain", "error");
          }
        } catch (err) {
          lkToast("Network error: " + err.message, "error");
        }
      });

      document.querySelectorAll(".btn-remove-domain").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const domain = btn.dataset.domain;
          if (!domain) return;
          const agreed = await lkConfirm({
            title: "Remove " + domain + "?",
            message: "Workstations pick this up on their next 3-second heartbeat and will be blocked from the domain after that.",
            confirmLabel: "Remove",
            tone: "danger"
          });
          if (!agreed) return;
          try {
            const res = await fetch(labkioskApi("/api/whitelist"), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: "remove", domain })
            });
            const data = await res.json();
            if (data.status === "ok") {
              window.location.reload();
            } else {
              lkToast(data.error || "Failed to remove domain", "error");
            }
          } catch (err) {
            lkToast("Network error: " + err.message, "error");
          }
        });
      });

      document.querySelectorAll(".btn-pack").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const raw = btn.dataset.domains || "";
          const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
          // Each domain is its own INSERT OR IGNORE row, so these do not race.
          // allSettled rather than all: one refusal should not hide the rest, and
          // a pack that only half applied must not reload as though it worked.
          const results = await Promise.allSettled(
            list.map((d) =>
              fetch(labkioskApi("/api/whitelist"), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ action: "add", domain: d })
              }).then((res) => {
                if (!res.ok) throw new Error(d);
                return d;
              })
            )
          );
          const failed = results.filter((r) => r.status === "rejected").length;
          if (failed) {
            // The reload is what shows which ones landed, so the message has to
            // survive it.
            lkToastAfterReload(failed + " of " + list.length + " domains in this pack could not be added.", "error");
          }
          window.location.reload();
        });
      });

      document.getElementById("filter-domains").addEventListener("input", (e) => {
        const q = e.target.value.toLowerCase().trim();
        document.querySelectorAll(".domain-tag").forEach((tag) => {
          tag.style.display = tag.textContent.toLowerCase().includes(q) ? "inline-flex" : "none";
        });
      });
    </script>
  `;
}
