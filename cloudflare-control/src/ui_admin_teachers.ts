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

export function buildTeachersPage(options: AdminPageInput): AdminPageParts {
  const { tenant, config, sites, presets, teachers, tenantParam, baseDomain, nonce } = options;

  const standardRoles: { id: string; label: string }[] = [
    { id: "teacher", label: "Teacher" },
    { id: "lab_assistant", label: "Lab Assistant" },
    { id: "content_manager", label: "Content Manager" },
    { id: "school_admin", label: "Co-Administrator" }
  ];

  const knownRoleIds = new Set(standardRoles.map((r) => r.id));
  const extraRoleIds = Array.from(new Set(teachers.map((t) => t.role).filter((role) => role && !knownRoleIds.has(role))));
  const extraRoles = extraRoleIds.map((role) => ({
    id: role,
    label: role === "sub_admin" ? "Sub-Admin" : role.charAt(0).toUpperCase() + role.slice(1).replace(/_/g, " ")
  }));

  const allRoles = [...standardRoles, ...extraRoles];

  const roleButtonsHtml = allRoles
    .map((r) => {
      const count = teachers.filter((t) => t.role === r.id).length;
      return `
        <button type="button" class="sub-action-item" data-filter="${escapeAttr(r.id)}">
          <span>${escapeHtml(r.label)}</span>
          <span class="sub-action-badge">${count}</span>
        </button>
      `;
    })
    .join("");

  return {
    title: "Teachers & Sub-Admin Delegation",
    contentHtml: renderTeachersPageHtml(teachers),
    scriptsHtml: renderTeachersScripts(nonce),
    subPanelTitle: "Staff Directory",
    subPanelSubtitle: "Sub-admin delegation",
    subPanelHtml: `
      <div class="sub-section-title">Actions</div>
      <div class="sub-action-list">
        <button type="button" class="sub-action-item" data-focus="teacher-name">
          <span style="display: flex; align-items: center; gap: 8px;">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg>
            Add Staff Member
          </span>
        </button>
      </div>

      <div class="sub-section-title" style="margin-top: 14px;">Role</div>
      <div class="sub-action-list" id="sub-role-list">
        <button type="button" class="sub-action-item active" data-filter="all">
          <span>All Roles</span>
          <span class="sub-action-badge">${teachers.length}</span>
        </button>
        ${roleButtonsHtml}
      </div>
    `
  };
}

function renderTeachersPageHtml(teachers: TenantUser[] = []): string {
  const rowsHtml = teachers
    .map((t) => {
      const permsList = (t.permissions || []).map((p) => `<span class="badge badge-blue" style="font-size: 10px; margin-right: 4px;">${escapeHtml(p)}</span>`).join("");
      return `
        <tr data-role="${escapeAttr(t.role)}">
          <td>
            <strong>${escapeHtml(t.name || "Teacher")}</strong>
            <div style="font-size: 12px; color: var(--text-muted);">${escapeHtml(t.email || "")}</div>
          </td>
          <td>
            <span class="badge badge-green">${escapeHtml(t.role)}</span>
          </td>
          <td>
            ${permsList || `<span style="color: var(--text-muted); font-size: 12px;">Full Lab Access</span>`}
          </td>
          <td>
            <button type="button" class="btn btn-sm btn-danger btn-delete-teacher" data-id="${escapeAttr(t.id)}">Remove</button>
          </td>
        </tr>
      `;
    })
    .join("");

  return `
    <div class="page-head">
      <div>
        <h1 class="page-title">Teachers &amp; Sub-Admin Delegation</h1>
        <p class="page-desc">Delegate classroom monitoring, broadcasting, and allowlist controls to individual instructors.</p>
      </div>
    </div>

    <div class="grid-2col">
      <div>
        <div class="card">
          <h2 class="card-title">Invite / Create Teacher Account</h2>
          <p class="card-sub">Instructors can log in directly to manage classroom sessions.</p>

          <form id="add-teacher-form">
            <div class="form-group">
              <label class="form-label" for="teacher-name">Full Name</label>
              <input type="text" class="form-input" id="teacher-name" required placeholder="e.g. Sarah Jenkins">
            </div>
            <div class="form-group">
              <label class="form-label" for="teacher-email">Email Address</label>
              <input type="email" class="form-input" id="teacher-email" required placeholder="sjenkins@school.edu">
            </div>
            <div class="form-group">
              <label class="form-label" for="teacher-password">Temporary Password</label>
              <input type="text" class="form-input" id="teacher-password" required value="TeacherPass2026!">
            </div>
            <div class="form-group">
              <label class="form-label" for="teacher-role">Role</label>
              <select class="form-select" id="teacher-role">
                <option value="teacher">Teacher (Classroom Instructor)</option>
                <option value="lab_assistant">Lab Assistant (Monitoring Only)</option>
                <option value="content_manager">Content Manager (Portal &amp; Whitelist)</option>
                <option value="school_admin">Co-Administrator (Full Access)</option>
              </select>
            </div>

            <div class="form-group">
              <label class="form-label">Delegated Permissions</label>
              <div style="display: flex; flex-direction: column; gap: 10px; margin-top: 8px;">
                <label class="form-checkbox-label">
                  <input type="checkbox" class="form-checkbox" name="perms" value="workstations" checked>
                  <span>Workstations (Monitor &amp; Lock PCs)</span>
                </label>
                <label class="form-checkbox-label">
                  <input type="checkbox" class="form-checkbox" name="perms" value="broadcast" checked>
                  <span>Broadcast (Broadcast Lessons)</span>
                </label>
                <label class="form-checkbox-label">
                  <input type="checkbox" class="form-checkbox" name="perms" value="portal" checked>
                  <span>Student Portal (Manage Cards)</span>
                </label>
                <label class="form-checkbox-label">
                  <input type="checkbox" class="form-checkbox" name="perms" value="whitelist">
                  <span>Allowlist (Manage Educational Domains)</span>
                </label>
                <label class="form-checkbox-label">
                  <input type="checkbox" class="form-checkbox" name="perms" value="settings">
                  <span>Lab Settings (Profile &amp; Keys)</span>
                </label>
              </div>
            </div>

            <button type="submit" class="btn btn-primary">Create Teacher Account</button>
          </form>
        </div>
      </div>

      <div>
        <div class="card" style="padding: 0; overflow: hidden;">
          <div style="padding: 20px 24px; border-bottom: 1px solid var(--border);">
            <h2 class="card-title" style="margin-bottom: 0;">Authorized Lab Instructors <span id="teachers-count">(${teachers.length})</span></h2>
          </div>
          <div class="table-container" style="border: none; border-radius: 0;">
            <table>
              <thead>
                <tr>
                  <th>Teacher</th>
                  <th>Role</th>
                  <th>Permissions</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody id="teachers-tbody">
                ${rowsHtml || `<tr><td colspan="4" style="text-align: center; color: var(--text-muted); padding: 32px;">No sub-admins or teachers added yet.</td></tr>`}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  `;
}

function renderTeachersScripts(nonce: string): string {
  return `
    <script nonce="${escapeAttr(nonce)}">
      // -------------------------------------------------------------
      // Role Filter Handler (Level 2 Subpanel)
      // -------------------------------------------------------------
      window.labkioskApplyFilter = function (filter) {
        const rows = document.querySelectorAll("#teachers-tbody tr[data-role]");
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
            emptyRow.innerHTML = '<td colspan="4" style="text-align: center; color: var(--text-muted); padding: 32px;">No staff members found with this role.</td>';
            const tbody = document.getElementById("teachers-tbody");
            if (tbody) tbody.appendChild(emptyRow);
          }
          emptyRow.style.display = "";
        } else if (emptyRow) {
          emptyRow.style.display = "none";
        }

        const countEl = document.getElementById("teachers-count");
        if (countEl) {
          countEl.textContent = filter === "all" ? "(" + rows.length + ")" : "(" + visibleCount + " of " + rows.length + ")";
        }
      };

      // -------------------------------------------------------------
      // Role Select Preset Defaults
      // -------------------------------------------------------------
      const roleSelect = document.getElementById("teacher-role");
      if (roleSelect) {
        const defaultPermsByRole = {
          teacher: ["workstations", "broadcast", "portal"],
          lab_assistant: ["workstations"],
          content_manager: ["portal", "whitelist"],
          school_admin: ["workstations", "broadcast", "portal", "whitelist", "settings"]
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
      // Create Teacher Form
      // -------------------------------------------------------------
      document.getElementById("add-teacher-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const name = document.getElementById("teacher-name").value.trim();
        const email = document.getElementById("teacher-email").value.trim();
        const password = document.getElementById("teacher-password").value;
        const role = document.getElementById("teacher-role").value;
        const perms = Array.from(document.querySelectorAll('input[name="perms"]:checked')).map((c) => c.value);

        try {
          const res = await fetch(labkioskApi("/api/tenant/teachers"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ name, email, password, role, permissions: perms })
          });
          const data = await res.json();
          if (data.status === "ok") {
            window.location.reload();
          } else {
            lkToast(data.error || "Failed to create teacher account", "error");
          }
        } catch (err) {
          lkToast("Network error: " + err.message, "error");
        }
      });

      // -------------------------------------------------------------
      // Delete Teacher
      // -------------------------------------------------------------
      document.querySelectorAll(".btn-delete-teacher").forEach((btn) => {
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
            const res = await fetch(labkioskApi("/api/tenant/teachers/" + encodeURIComponent(id)), { method: "DELETE" });
            const data = await res.json();
            if (data.status === "ok") {
              window.location.reload();
            } else {
              lkToast(data.error || "Failed to remove teacher", "error");
            }
          } catch (err) {
            lkToast("Network error: " + err.message, "error");
          }
        });
      });
    </script>
  `;
}
