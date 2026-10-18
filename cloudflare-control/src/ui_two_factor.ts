/**
 * The "Two-factor sign-in" tab: the signed-in account turns the emailed
 * sign-in code on or off, adds or removes an authenticator app, replaces
 * its recovery codes, and adds or removes passkeys (src/two_factor.ts holds
 * the rules).
 *
 * It is a tab of Settings in the organization console and of System in the
 * Super Admin console, and the profile menu links to it. Staff without the
 * `settings` permission open Settings with this tab alone, so every account
 * reaches it. The script builds DOM nodes and sets textContent only (Rule 6).
 */

import { escapeAttr } from "./escape";
import { WHEN_PANE_SHOWN_JS } from "./ui_admin_shared";

/** The tab's two cards; `renderTwoFactorScript()` fills them. */
export function renderTwoFactorPaneHtml(): string {
  return `
      <div class="grid-2col" id="two-factor">
        <div class="card">
          <h2 class="card-title">Emailed code</h2>
          <p class="card-sub">After your password, sign-in emails a six-digit code to your address. There is nothing to set up.</p>
          <form id="two-factor-email" aria-live="polite" novalidate></form>
        </div>
        <div class="card">
          <h2 class="card-title">Authenticator app</h2>
          <p class="card-sub">Optional. Sign-in then asks for the code from an app on your phone, such as Google Authenticator, Microsoft Authenticator or 1Password, and works when email is slow.</p>
          <form id="two-factor-body" aria-live="polite" novalidate></form>
        </div>
        <div class="card">
          <h2 class="card-title">Passkeys</h2>
          <p class="card-sub">Optional. A passkey on this computer, your phone or a security key finishes sign-in with a touch or your fingerprint, and cannot be used on a fake copy of this site.</p>
          <form id="two-factor-passkeys" aria-live="polite" novalidate></form>
        </div>
      </div>`;
}

export function renderTwoFactorScript(nonce: string): string {
  return `
  <script nonce="${escapeAttr(nonce)}">
    (function () {
      "use strict";
      var emailBox = document.getElementById("two-factor-email");
      var body = document.getElementById("two-factor-body");
      var passkeyBox = document.getElementById("two-factor-passkeys");
      if (!emailBox || !body || !passkeyBox) return;
      // Forms so the browser and a password manager treat each password field as one;
      // the buttons do the work, so Enter must not send the page anywhere.
      [emailBox, body, passkeyBox].forEach(function (form) {
        form.addEventListener("submit", function (event) { event.preventDefault(); });
      });

      function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined && text !== null) node.textContent = String(text);
        return node;
      }

      function input(id, type, label, attrs) {
        var group = el("div", "form-group");
        var labelEl = el("label", "form-label", label);
        labelEl.htmlFor = id;
        var field = el("input", "form-input");
        field.id = id;
        field.type = type;
        Object.keys(attrs || {}).forEach(function (name) { field.setAttribute(name, attrs[name]); });
        group.append(labelEl, field);
        if (type === "password") {
          // A password manager matches the password to this account.
          // Off screen, not hidden: some password managers skip a field that is not rendered.
          var account = el("input", "visually-hidden");
          account.type = "text";
          account.name = "username";
          account.tabIndex = -1;
          account.setAttribute("autocomplete", "username");
          account.setAttribute("aria-hidden", "true");
          var signedInAs = document.querySelector(".profile-menu-email");
          account.value = signedInAs ? signedInAs.textContent.trim() : "";
          group.prepend(account);
        }
        return { group: group, field: field };
      }

      function button(text, tone, handler) {
        var b = el("button", "btn btn-sm " + tone, text);
        b.type = "button";
        b.addEventListener("click", async function () {
          b.disabled = true;
          try { await handler(); } finally { b.disabled = false; }
        });
        return b;
      }

      function errorLine() { return el("div", "form-error"); }

      function callout(tone, text) {
        var box = el("div", "callout" + (tone ? " callout-" + tone : ""));
        box.append(el("div", null, text));
        return box;
      }

      async function api(path, payload) {
        var init = payload === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) };
        var res = await fetch(path, init);
        var data = null;
        try { data = await res.json(); } catch (err) { data = null; }
        if (!res.ok) throw new Error((data && data.error) || ("The server answered " + res.status));
        return data;
      }

      function when(seconds) {
        var date = new Date(Number(seconds) * 1000);
        return isNaN(date.getTime()) ? "" : date.toLocaleDateString();
      }

      // ------------------------------------------------------ emailed code
      function renderEmail(state) {
        emailBox.replaceChildren();
        if (!state.mailAvailable) {
          emailBox.append(callout("warning", "Email is not set up on this server, so a code cannot be sent" +
            (state.emailCodes ? " and sign-in uses the password alone until it is." : ".")));
          if (!state.emailCodes) return;
        }
        if (state.required) {
          emailBox.append(callout("success", "On. Every sign-in emails a code to " + state.email + ". An administrator account cannot turn this off."));
          return;
        }
        emailBox.append(state.emailCodes
          ? callout("success", "On. After your password, sign-in emails a code to " + state.email + ".")
          : el("p", "text-muted", "Off. Signing in needs only your password."));
        var password = input("two-factor-email-password", "password", "Your password", { autocomplete: "current-password" });
        password.group.classList.add("mt-md");
        var error = errorLine();
        var actions = el("div", "form-actions");
        async function set(enabled) {
          error.textContent = "";
          try {
            await api("/api/auth/two-factor/email", { password: password.field.value, enabled: enabled });
            lkToast(enabled ? "Sign-in now asks for an emailed code." : "Emailed codes are off.", "success");
            await render();
          } catch (err) {
            error.textContent = err.message;
          }
        }
        if (state.emailCodes) {
          actions.append(button("Turn off", "btn-danger", async function () {
            var ok = await lkConfirm({
              title: "Turn off the emailed code?",
              message: state.enabled
                ? "Sign-in will ask for your authenticator app's code only."
                : "Signing in will need only the password again, and trusted browsers are forgotten.",
              confirmLabel: "Turn off",
              tone: "danger"
            });
            if (ok) await set(false);
          }));
        } else {
          actions.append(button("Turn on", "btn-primary", async function () { await set(true); }));
        }
        emailBox.append(password.group, error, actions);
      }

      // -------------------------------------------------- authenticator app
      function showRecoveryCodes(codes, intro) {
        body.replaceChildren();
        var note = el("div", "callout callout-success");
        note.append(el("div", null, intro));
        var list = el("div", "recovery-codes mt-md");
        codes.forEach(function (code) { list.append(el("span", null, code)); });
        var hint = el("p", "form-hint mt-md", "Keep these somewhere safe, away from your phone. Each one signs in once if you lose the app. They are not shown again.");
        var actions = el("div", "form-actions mt-md");
        actions.append(
          button("Copy codes", "btn-secondary", async function () {
            try {
              await navigator.clipboard.writeText(codes.join("\\n"));
              lkToast("Recovery codes copied.", "success");
            } catch (err) {
              lkToast("Copy failed: select the codes and copy them by hand.", "error");
            }
          }),
          button("Done", "btn-secondary", async function () { await render(); })
        );
        body.append(note, list, hint, actions);
      }

      function renderOff() {
        body.replaceChildren();
        body.append(el("p", "text-muted", "No authenticator app is set up for this account."));
        var password = input("two-factor-password", "password", "Your password", { autocomplete: "current-password" });
        password.group.classList.add("mt-md");
        var error = errorLine();
        var actions = el("div", "form-actions");
        actions.append(button("Set up an app", "btn-secondary", async function () {
          error.textContent = "";
          try {
            var setup = await api("/api/auth/two-factor/setup", { password: password.field.value });
            renderSetup(setup);
          } catch (err) {
            error.textContent = err.message;
          }
        }));
        body.append(password.group, error, actions);
      }

      function renderSetup(setup) {
        body.replaceChildren();
        var steps = el("ol", "stack-sm numbered-steps");
        steps.append(
          el("li", null, "In your authenticator app, add an account and choose to enter a setup key."),
          el("li", null, "Enter this key (time-based), or open the link on the phone that has the app."),
          el("li", null, "Type the six-digit code the app shows.")
        );
        var secret = el("div", "secret-box mt-md");
        secret.append(el("code", "mono", setup.secret.replace(/(.{4})/g, "$1 ").trim()));
        var link = el("a", "text-xs", "Open in authenticator app");
        link.href = setup.otpauthUri;
        var code = input("two-factor-code", "text", "Six-digit code", { inputmode: "numeric", autocomplete: "one-time-code", maxlength: "6" });
        code.group.classList.add("mt-md");
        var error = errorLine();
        var actions = el("div", "form-actions");
        actions.append(
          button("Turn on", "btn-primary", async function () {
            error.textContent = "";
            try {
              var result = await api("/api/auth/two-factor/enable", { code: code.field.value.trim() });
              lkToast("The authenticator app is on.", "success");
              showRecoveryCodes(result.recoveryCodes, "The authenticator app is on. Other browsers signed in to this account were signed out. These are your recovery codes:");
            } catch (err) {
              error.textContent = err.message;
            }
          }),
          button("Cancel", "btn-ghost", async function () { await render(); })
        );
        body.append(steps, secret, link, code.group, error, actions);
        code.field.focus();
      }

      function renderOn(state) {
        body.replaceChildren();
        var status = el("div", "callout callout-success");
        status.append(el("div", null, "On" + (state.enabledAt ? " since " + when(state.enabledAt) : "") + ". " +
          state.recoveryCodesLeft + " recovery code" + (state.recoveryCodesLeft === 1 ? "" : "s") + " left."));
        var password = input("two-factor-password", "password", "Your password", { autocomplete: "current-password" });
        password.group.classList.add("mt-md");
        var code = input("two-factor-code", "text", "A code from the app, or a recovery code", { autocomplete: "one-time-code", maxlength: "11" });
        var error = errorLine();
        function credentials() { return { password: password.field.value, code: code.field.value.trim() }; }
        var actions = el("div", "form-actions");
        actions.append(
          button("New recovery codes", "btn-secondary", async function () {
            error.textContent = "";
            try {
              var result = await api("/api/auth/two-factor/recovery-codes", credentials());
              showRecoveryCodes(result.recoveryCodes, "Your old recovery codes no longer work. These are the new ones:");
            } catch (err) {
              error.textContent = err.message;
            }
          }),
          button("Remove the app", "btn-danger", async function () {
            error.textContent = "";
            var ok = await lkConfirm({
              title: "Remove the authenticator app?",
              message: state.emailCodes
                ? "Sign-in will ask for an emailed code instead, and trusted browsers are forgotten."
                : "Signing in will need only the password again, and trusted browsers are forgotten.",
              confirmLabel: "Remove",
              tone: "danger"
            });
            if (!ok) return;
            try {
              await api("/api/auth/two-factor/disable", credentials());
              lkToast("The authenticator app was removed.", "success");
              await render();
            } catch (err) {
              error.textContent = err.message;
            }
          })
        );
        body.append(status, password.group, code.group, error, actions);
      }

      // ------------------------------------------------------------ passkeys
      function fromB64url(value) {
        var text = atob(value.replace(/-/g, "+").replace(/_/g, "/"));
        return Uint8Array.from(text, function (c) { return c.charCodeAt(0); });
      }
      function toB64url(buffer) {
        var text = "";
        new Uint8Array(buffer).forEach(function (b) { text += String.fromCharCode(b); });
        return btoa(text).replace(/\\+/g, "-").replace(/\\//g, "_").replace(/=+$/, "");
      }

      function renderPasskeys(state) {
        passkeyBox.replaceChildren();
        var keys = state.passkeys || [];
        var supported = Boolean(window.PublicKeyCredential && navigator.credentials);
        var name = input("two-factor-passkey-name", "text", "Name for a new passkey", { maxlength: "60", placeholder: "Work laptop", autocomplete: "off" });
        name.group.classList.add("mt-md");
        var password = input("two-factor-passkey-password", "password", "Your password", { autocomplete: "current-password" });
        if (!supported) password.group.classList.add("mt-md");
        var error = errorLine();
        if (keys.length) {
          var list = el("ul", "stack-sm");
          keys.forEach(function (key) {
            var item = el("li", "passkey-row");
            var text = el("div");
            text.append(el("strong", null, key.name));
            text.append(el("div", "text-xs text-muted",
              "Added " + when(key.createdAt) +
              (key.lastUsedAt ? ", last used " + when(key.lastUsedAt) : ", not used yet") +
              (key.here ? "" : ". Works on " + key.site + " only")));
            item.append(text, button("Remove", "btn-danger", async function () {
              error.textContent = "";
              var ok = await lkConfirm({
                title: "Remove the passkey " + key.name + "?",
                message: "It will no longer sign in to this account. Enter your password below first.",
                confirmLabel: "Remove",
                tone: "danger"
              });
              if (!ok) return;
              try {
                await api("/api/auth/two-factor/passkey-delete", { password: password.field.value, id: key.id });
                lkToast("The passkey was removed.", "success");
                await render();
              } catch (err) {
                error.textContent = err.message;
              }
            }));
            list.append(item);
          });
          passkeyBox.append(list);
        } else {
          passkeyBox.append(el("p", "text-muted", "No passkey is set up for this account."));
        }
        if (!supported) {
          passkeyBox.append(callout("warning", "This browser cannot create passkeys."));
          // Removing one still works here.
          if (keys.length) passkeyBox.append(password.group, error);
          return;
        }
        var actions = el("div", "form-actions");
        actions.append(button("Add a passkey", "btn-secondary", async function () {
          error.textContent = "";
          try {
            var options = await api("/api/auth/two-factor/passkey-options", { password: password.field.value });
            var credential;
            try {
              credential = await navigator.credentials.create({
                publicKey: {
                  challenge: fromB64url(options.challenge),
                  rp: options.rp,
                  user: { id: fromB64url(options.user.id), name: options.user.name, displayName: options.user.displayName },
                  pubKeyCredParams: options.pubKeyCredParams,
                  timeout: options.timeout,
                  attestation: options.attestation,
                  authenticatorSelection: options.authenticatorSelection,
                  excludeCredentials: options.excludeCredentials.map(function (c) { return { type: c.type, id: fromB64url(c.id) }; })
                }
              });
            } catch (err) {
              error.textContent = err && err.name === "InvalidStateError"
                ? "This device already holds a passkey for this account."
                : "No passkey was created.";
              return;
            }
            await api("/api/auth/two-factor/passkey-register", {
              name: name.field.value,
              credential: {
                clientDataJSON: toB64url(credential.response.clientDataJSON),
                attestationObject: toB64url(credential.response.attestationObject)
              }
            });
            lkToast("The passkey was added. Other browsers signed in to this account were signed out.", "success");
            await render();
          } catch (err) {
            error.textContent = err.message;
          }
        }));
        passkeyBox.append(name.group, password.group, error, actions);
      }

      async function render() {
        emailBox.replaceChildren(el("p", "text-muted", "Loading…"));
        body.replaceChildren(el("p", "text-muted", "Loading…"));
        passkeyBox.replaceChildren(el("p", "text-muted", "Loading…"));
        try {
          var state = await api("/api/auth/two-factor");
          renderEmail(state);
          if (state.enabled) renderOn(state);
          else renderOff();
          renderPasskeys(state);
        } catch (err) {
          emailBox.replaceChildren(el("p", "form-error", "Could not load: " + err.message));
          body.replaceChildren();
          passkeyBox.replaceChildren();
        }
      }

${WHEN_PANE_SHOWN_JS}
      whenPaneShown(body, render);
    })();
  </script>`;
}
