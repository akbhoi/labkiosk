/**
 * Settings -> Security: single sign-on (src/sso.ts). Which providers this
 * organization's sign-in page offers, the Google Workspace domains and Entra
 * tenant ids an account must belong to, and whether staff must use it.
 *
 * Shown to an account holding `settings`; only administrators (the owner and
 * `org_admin` staff) can change it, and the form says so when it is read-only.
 */

import { escapeAttr } from "./escape";
import { WHEN_PANE_SHOWN_JS } from "./ui_admin_shared";

export function renderSsoCardHtml(): string {
  return `
          <div class="card" id="section-sso">
            <h2 class="card-title">Single sign-on</h2>
            <p class="card-sub">Let staff sign in with their Google Workspace or Microsoft Entra ID work account. The email address the provider verifies must be one a staff account here already has: nobody is added by signing in, and the second factor your organization requires is still asked for afterwards.</p>
            <p class="form-hint" id="sso-readonly" hidden>Only the organization's administrators can change single sign-on.</p>
            <form id="form-sso-settings">
              <div class="form-group">
                <label class="form-checkbox-label">
                  <input type="checkbox" class="form-checkbox" id="sso-google-enabled">
                  <span>Continue with Google</span>
                </label>
                <p class="form-hint" id="sso-google-unavailable" hidden>Not set up on this platform yet, so it cannot be turned on.</p>
              </div>
              <div class="form-group">
                <label class="form-label" for="sso-google-domains">Google Workspace domains</label>
                <textarea class="form-textarea mono" id="sso-google-domains" rows="2" maxlength="2000" placeholder="example.org" spellcheck="false" autocapitalize="off"></textarea>
                <p class="form-hint">One per line: your Workspace's primary domain, as Google reports it for each account. Personal Gmail accounts are never accepted.</p>
              </div>
              <div class="form-group">
                <label class="form-checkbox-label">
                  <input type="checkbox" class="form-checkbox" id="sso-microsoft-enabled">
                  <span>Continue with Microsoft</span>
                </label>
                <p class="form-hint" id="sso-microsoft-unavailable" hidden>Not set up on this platform yet, so it cannot be turned on.</p>
              </div>
              <div class="form-group">
                <label class="form-label" for="sso-microsoft-tenants">Microsoft Entra tenant IDs</label>
                <textarea class="form-textarea mono" id="sso-microsoft-tenants" rows="2" maxlength="2000" placeholder="00000000-0000-0000-0000-000000000000" spellcheck="false" autocapitalize="off"></textarea>
                <p class="form-hint">One per line, from the Microsoft Entra admin center (Overview, Tenant ID). List only directories your organization runs: whoever administers a listed directory decides which email address each of its accounts carries.</p>
              </div>
              <div class="form-group">
                <label class="form-checkbox-label">
                  <input type="checkbox" class="form-checkbox" id="sso-require">
                  <span>Require single sign-on for staff</span>
                </label>
                <p class="form-hint">Staff can then no longer sign in with a password. The organization's owner always can, so you are never locked out; and if the platform stops offering every provider you turned on, passwords work again until it is back.</p>
              </div>
              <div class="form-actions">
                <button type="submit" class="btn btn-primary" id="btn-sso-save">Save single sign-on</button>
              </div>
            </form>
          </div>`;
}

export function renderSsoScript(nonce: string): string {
  return `
    <script nonce="${escapeAttr(nonce)}">
${WHEN_PANE_SHOWN_JS}
      (function () {
        const section = document.getElementById("section-sso");
        if (!section) return;
        const form = document.getElementById("form-sso-settings");
        const googleBox = document.getElementById("sso-google-enabled");
        const googleList = document.getElementById("sso-google-domains");
        const microsoftBox = document.getElementById("sso-microsoft-enabled");
        const microsoftList = document.getElementById("sso-microsoft-tenants");
        const requireBox = document.getElementById("sso-require");
        const lines = (text) => text.split(/[\\s,]+/).map((v) => v.trim()).filter(Boolean);

        function show(data) {
          googleBox.checked = data.google.enabled === true;
          googleList.value = data.google.domains.join("\\n");
          microsoftBox.checked = data.microsoft.enabled === true;
          microsoftList.value = data.microsoft.tenants.join("\\n");
          requireBox.checked = data.requireSso === true;
          // A provider the platform has not set up can be turned off, never on.
          document.getElementById("sso-google-unavailable").hidden = data.google.available;
          document.getElementById("sso-microsoft-unavailable").hidden = data.microsoft.available;
          googleBox.disabled = !data.canEdit || (!data.google.available && !data.google.enabled);
          microsoftBox.disabled = !data.canEdit || (!data.microsoft.available && !data.microsoft.enabled);
          for (const control of [googleList, microsoftList, requireBox, document.getElementById("btn-sso-save")]) control.disabled = !data.canEdit;
          document.getElementById("sso-readonly").hidden = data.canEdit;
        }

        async function load() {
          try {
            const res = await fetch(labkioskApi("/api/settings/sso"));
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
            show(data);
          } catch (err) {
            lkToast("Could not load single sign-on: " + err.message, "error");
          }
        }

        form.addEventListener("submit", async (e) => {
          e.preventDefault();
          try {
            const res = await fetch(labkioskApi("/api/settings/sso"), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                google: { enabled: googleBox.checked, domains: lines(googleList.value) },
                microsoft: { enabled: microsoftBox.checked, tenants: lines(microsoftList.value) },
                requireSso: requireBox.checked
              })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
            show(data);
            lkToast("Single sign-on saved.", "success");
          } catch (err) {
            lkToast("Could not save: " + err.message, "error");
          }
        });

        whenPaneShown(section, load);
      })();
    </script>`;
}
