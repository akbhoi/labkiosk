/**
 * My account: the signed-in person's own password and two-factor sign-in
 * (src/ui_two_factor.ts). Every staff account opens it, whatever its
 * permissions; nothing of the organization's is here.
 */

import { escapeAttr } from "./escape";
import { AdminPageInput, AdminPageParts } from "./ui_admin_shared";
import { renderTwoFactorPaneHtml, renderTwoFactorScript } from "./ui_two_factor";

export function buildAccountPage(options: AdminPageInput): AdminPageParts {
  return {
    title: "My account",
    contentHtml: `
    <div class="page-head">
      <div>
        <h1 class="page-title">My account</h1>
        <p class="page-desc">How you sign in to this console. The organization's own settings are under Settings.</p>
      </div>
    </div>
    <div class="grid-2col">
      <div class="stack-cards">
          <div class="card" id="section-password">
            <h2 class="card-title">Password</h2>
            <p class="card-sub">Changing it signs every other browser out of your account.</p>

            <form id="form-change-password">
              <input type="text" id="pwd-username" class="visually-hidden" autocomplete="username" aria-hidden="true" tabindex="-1">
              <div class="form-group">
                <label class="form-label" for="pwd-current">Current Password</label>
                <input type="password" class="form-input" id="pwd-current" autocomplete="current-password" required>
              </div>
              <div class="form-group">
                <label class="form-label" for="pwd-new">New Password (min 12 characters)</label>
                <input type="password" class="form-input" id="pwd-new" autocomplete="new-password" required minlength="12">
              </div>
              <button type="submit" class="btn btn-secondary">Change Password</button>
            </form>
          </div>
      </div>
      <div></div>
    </div>
    <div class="mt-lg" id="pane-two-factor-section">
${renderTwoFactorPaneHtml()}
    </div>
  `,
    scriptsHtml: renderPasswordScript(options.nonce) + renderTwoFactorScript(options.nonce)
  };
}

function renderPasswordScript(nonce: string): string {
  return `
    <script nonce="${escapeAttr(nonce)}">
      // A password manager files the new password under this account.
      const passwordAccount = document.getElementById("pwd-username");
      const signedInAs = document.querySelector(".profile-menu-email");
      if (passwordAccount && signedInAs) passwordAccount.value = signedInAs.textContent.trim();
      document.getElementById("form-change-password").addEventListener("submit", async (e) => {
        e.preventDefault();
        const currentPassword = document.getElementById("pwd-current").value;
        const newPassword = document.getElementById("pwd-new").value;
        try {
          const res = await fetch(labkioskApi("/api/auth/change-password"), {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ currentPassword, newPassword })
          });
          const data = await res.json();
          if (data.status === "ok") {
            lkToast("Password updated successfully.", "success");
            document.getElementById("form-change-password").reset();
          } else {
            lkToast(data.error || "Failed to change password", "error");
          }
        } catch (err) {
          lkToast("Network error: " + err.message, "error");
        }
      });
    </script>`;
}
