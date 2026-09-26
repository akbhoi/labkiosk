/**
 * Staff accounts, and the granular permissions delegated to each of them.
 *
 * The page markup, its context-panel contents and its client script live
 * together here. They used to sit hundreds of lines apart inside one
 * 2,450-line module, which is how a panel full of controls that nothing
 * handled went unnoticed for so long.
 */

import { TenantUser } from "./types";
import { escapeHtml, escapeAttr } from "./escape";
import { AdminPageInput, AdminPageParts } from "./ui_admin_shared";

export function buildStaffPage(options: AdminPageInput): AdminPageParts {
  const { tenant, config, sites, presets, staff, tenantParam, baseDomain, nonce } = options;

  const standardRoles: { id: string; label: string }[] = [
    { id: "operator", label: "Operator" },
    { id: "assistant", label: "Assistant" },
    { id: "content_manager", label: "Content Manager" },
    { id: "org_admin", label: "Co-Administrator" }
  ];

  const knownRoleIds = new Set(standardRoles.map((r) => r.id));
  const extraRoleIds = Array.from(new Set(staff.map((t) => t.role).filter((role) => role && !knownRoleIds.has(role))));
  const extraRoles = extraRoleIds.map((role) => ({
    id: role,
    label: role === "sub_admin" ? "Sub-Admin" : role.charAt(0).toUpperCase() + role.slice(1).replace(/_/g, " ")
  }));

  const allRoles = [...standardRoles, ...extraRoles];

  const roleButtonsHtml = allRoles
    .map((r) => {
      const count = staff.filter((t) => t.role === r.id).length;
      return `
        <button type="button" class="sub-action-item" data-filter="${escapeAttr(r.id)}">
          <span>${escapeHtml(r.label)}</span>
          <span class="sub-action-badge">${count}</span>
        </button>
      `;
    })
    .join("");

  const roleLabels = new Map(allRoles.map((r) => [r.id, r.label]));

  return {
    title: "Staff & Delegation",
    contentHtml: renderStaffPageHtml(staff, roleLabels),
    scriptsHtml: renderStaffScripts(nonce),
    subPanelTitle: "Staff Directory",
    subPanelSubtitle: "Sub-admin delegation",
    subPanelHtml: `
      <div class="sub-section-title">Actions</div>
      <div class="sub-action-list">
        <button type="button" class="sub-action-item" data-focus="operator-name">
          <span class="row">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg>
            Add Staff Member
          </span>
        </button>
      </div>

      <div class="sub-section-title">Role</div>
      <div class="sub-action-list" id="sub-role-list">
        <button type="button" class="sub-action-item active" data-filter="all">
          <span>All Roles</span>
          <span class="sub-action-badge">${staff.length}</span>
        </button>
        ${roleButtonsHtml}
      </div>
    `
  };
}

/** A permission as a person reads it: "Workstations", not "workstations". */
function permissionLabel(permission: string): string {
  return permission.charAt(0).toUpperCase() + permission.slice(1);
}

function renderStaffPageHtml(staff: TenantUser[] = [], roleLabels: Map<string, string> = new Map()): string {
  const rowsHtml = staff
    .map((t) => {
      const permsList = (t.permissions || []).map((p) => `<span class="badge badge-neutral">${escapeHtml(permissionLabel(p))}</span>`).join("");
      return `
        <tr data-role="${escapeAttr(t.role)}">
          <td>
            <div class="cell-title">${escapeHtml(t.name || "Operator")}</div>
            <div class="cell-sub">${escapeHtml(t.email || "")}</div>
          </td>
          <td>
            <span class="badge badge-blue">${escapeHtml(roleLabels.get(t.role) || t.role)}</span>
          </td>
          <td>
            <div class="badge-list">${permsList || `<span class="text-muted text-xs">Full access</span>`}</div>
          </td>
          <td>
            <div class="cell-actions">
              <button type="button" class="btn btn-sm btn-danger btn-delete-operator" data-id="${escapeAttr(t.id)}">Remove</button>
            </div>
          </td>
        </tr>
      `;
    })
    .join("");

  return `
    <div class="page-head">
      <div>
        <h1 class="page-title">Staff &amp; Delegation</h1>
        <p class="page-desc">Delegate workstation monitoring, broadcasting and allowlist controls to individual staff members.</p>
      </div>
    </div>

    <div class="grid-sidebar">
      <div>
        <div class="card">
          <h2 class="card-title">Create Staff Account</h2>
          <p class="card-sub">Staff sign in with their own account and see only what you delegate to them.</p>

          <form id="add-operator-form">
            <div class="form-group">
              <label class="form-label" for="operator-name">Full Name</label>
              <input type="text" class="form-input" id="operator-name" required placeholder="e.g. Sarah Jenkins">
            </div>
            <div class="form-group">
              <label class="form-label" for="operator-email">Email Address</label>
              <input type="email" class="form-input" id="operator-email" required placeholder="sjenkins@example.com">
            </div>
            <div class="form-group">
              <label class="form-label" for="operator-password">Temporary Password</label>
              <input type="text" class="form-input" id="operator-password" required minlength="12" autocomplete="off" spellcheck="false">
              <p class="form-hint">A random password is suggested. Hand it to the staff member and ask them to change it after signing in.</p>
            </div>
            <div class="form-group">
              <label class="form-label" for="operator-role">Role</label>
              <select class="form-select" id="operator-role">
                <option value="operator">Operator (Runs the Workstations)</option>
                <option value="assistant">Assistant (Monitoring Only)</option>
                <option value="content_manager">Content Manager (Portal &amp; Whitelist)</option>
                <option value="org_admin">Co-Administrator (Full Access)</option>
              </select>
            </div>

            <div class="form-group">
              <label class="form-label">Delegated Permissions</label>
              <div class="checkbox-list">
                <label class="form-checkbox-label">
                  <input type="checkbox" class="form-checkbox" name="perms" value="workstations" checked>
                  <span>Workstations (Monitor &amp; Lock PCs)</span>
                </label>
                <label class="form-checkbox-label">
                  <input type="checkbox" class="form-checkbox" name="perms" value="broadcast" checked>
                  <span>Broadcast (Broadcast Pages)</span>
                </label>
                <label class="form-checkbox-label">
                  <input type="checkbox" class="form-checkbox" name="perms" value="portal" checked>
                  <span>User Portal (Manage Cards)</span>
                </label>
                <label class="form-checkbox-label">
                  <input type="checkbox" class="form-checkbox" name="perms" value="whitelist">
                  <span>Allowlist (Manage Approved Domains)</span>
                </label>
                <label class="form-checkbox-label">
                  <input type="checkbox" class="form-checkbox" name="perms" value="staff">
                  <span>Staff (Add &amp; Manage Staff)</span>
                </label>
                <label class="form-checkbox-label">
                  <input type="checkbox" class="form-checkbox" name="perms" value="settings">
                  <span>Settings (Profile &amp; Keys)</span>
                </label>
              </div>
            </div>

            <button type="submit" class="btn btn-primary">Create Staff Account</button>
          </form>
        </div>
      </div>

      <div>
        <div class="card card-flush">
          <div class="card-head">
            <h2 class="card-title">Staff Accounts <span id="staff-count" class="text-muted">(${staff.length})</span></h2>
          </div>
          <div class="table-container">
            <table>
              <thead>
                <tr>
                  <th>Staff Member</th>
                  <th>Role</th>
                  <th>Permissions</th>
                  <th class="th-actions"><span class="visually-hidden">Actions</span></th>
                </tr>
              </thead>
              <tbody id="staff-tbody">
                ${rowsHtml || `<tr><td colspan="4" class="table-empty">No sub-admins or operators added yet.</td></tr>`}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderStaffScripts(nonce: string): string {
  return `
    <script nonce="${escapeAttr(nonce)}">
      // -------------------------------------------------------------
      // Role Filter Handler (Level 2 Subpanel)
      // -------------------------------------------------------------
      window.labkioskApplyFilter = function (filter) {
        const rows = document.querySelectorAll("#staff-tbody tr[data-role]");
        let visibleCount = 0;
        rows.forEach((row) => {
          const role = row.getAttribute("data-role");
          const matches = filter === "all" || role === filter;
          row.style.display = matches ? "" : "none";
          if (matches) visibleCount++;
        });

        let emptyRow = document.getElementById("empty-filter-row");
        if (visibleCount === 0 && rows.length > 0) {
          if (!emptyRow) {
            emptyRow = document.createElement("tr");
            emptyRow.id = "empty-filter-row";
            const cell = document.createElement("td");
            cell.colSpan = 4;
            cell.className = "table-empty";
            cell.textContent = "No staff members found with this role.";
            emptyRow.appendChild(cell);
            const tbody = document.getElementById("staff-tbody");
            if (tbody) tbody.appendChild(emptyRow);
          }
          emptyRow.style.display = "";
        } else if (emptyRow) {
          emptyRow.style.display = "none";
        }

        const countEl = document.getElementById("staff-count");
        if (countEl) {
          countEl.textContent = filter === "all" ? "(" + rows.length + ")" : "(" + visibleCount + " of " + rows.length + ")";
        }
      };

      // -------------------------------------------------------------
      // Role Select Preset Defaults
      // -------------------------------------------------------------
      const roleSelect = document.getElementById("operator-role");
      if (roleSelect) {
        const defaultPermsByRole = {
          operator: ["workstations", "broadcast", "portal"],
          assistant: ["workstations"],
          content_manager: ["portal", "whitelist"],
          org_admin: ["workstations", "broadcast", "portal", "whitelist", "staff", "settings"]
        };
        roleSelect.addEventListener("change", () => {
          const selected = roleSelect.value;
          const defaults = defaultPermsByRole[selected] || ["workstations"];
          document.querySelectorAll('input[name="perms"]').forEach((cb) => {
            cb.checked = defaults.includes(cb.value);
          });
        });
      }

      // -------------------------------------------------------------
      // Temporary password: random per page load, never a shared default
      // -------------------------------------------------------------
      (function suggestPassword() {
        const field = document.getElementById("operator-password");
        if (!field) return;
        const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
        const bytes = crypto.getRandomValues(new Uint8Array(16));
        let value = "";
        for (const b of bytes) value += alphabet[b % alphabet.length];
        // Guarantee the letters-and-digits rule the server enforces.
        field.value = value.slice(0, 14) + "a" + String(bytes[0] % 10);
      })();

      // -------------------------------------------------------------
      // Create Operator Form
      // -------------------------------------------------------------
      document.getElementById("add-operator-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const name = document.getElementById("operator-name").value.trim();
        const email = document.getElementById("operator-email").value.trim();
        const password = document.getElementById("operator-password").value;
        const role = document.getElementById("operator-role").value;
        const perms = Array.from(document.querySelectorAll('input[name="perms"]:checked')).map((c) => c.value);

        try {
          const res = await fetch(labkioskApi("/api/tenant/staff"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, email, password, role, permissions: perms })
          });
          const data = await res.json();
          if (data.status === "ok") {
            window.location.reload();
          } else {
            lkToast(data.error || "Failed to create operator account", "error");
          }
        } catch (err) {
          lkToast("Network error: " + err.message, "error");
        }
      });

      // -------------------------------------------------------------
      // Delete Operator
      // -------------------------------------------------------------
      document.querySelectorAll(".btn-delete-operator").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const id = btn.dataset.id;
          if (!id) return;
          const agreed = await lkConfirm({
            title: "Remove this staff account?",
            message: "Their sign-in stops working immediately and any session they have open is ended.",
            confirmLabel: "Remove",
            tone: "danger"
          });
          if (!agreed) return;
          try {
            const res = await fetch(labkioskApi("/api/tenant/staff/" + encodeURIComponent(id)), { method: "DELETE" });
            const data = await res.json();
            if (data.status === "ok") {
              window.location.reload();
            } else {
              lkToast(data.error || "Failed to remove operator", "error");
            }
          } catch (err) {
            lkToast("Network error: " + err.message, "error");
          }
        });
      });
    </script>
  `;
}
