/**
 * "Two-factor sign-in" in every console's profile menu: the signed-in account
 * turns its own authenticator-app code on or off, and replaces its recovery
 * codes (src/two_factor.ts holds the rules).
 *
 * It lives in the shared shell rather than on a settings page, so staff
 * without the `settings` permission and super admins reach it the same way.
 * The script builds DOM nodes and sets textContent only (Rule 6).
 */

import { escapeAttr } from "./escape";

export function renderTwoFactorModalHtml(): string {
  return `
  <div class="modal-overlay" id="two-factor-modal" role="dialog" aria-modal="true" aria-labelledby="two-factor-title">
    <div class="modal-box modal-sm">
      <h3 class="modal-title" id="two-factor-title">Two-factor sign-in</h3>
      <button type="button" class="modal-close" data-two-factor-close aria-label="Close dialog">✕</button>
      <p class="modal-desc">After your password, sign-in asks for a six-digit code from an authenticator app on your phone, such as Google Authenticator, Microsoft Authenticator or 1Password. A code by email works too, if the phone is not at hand.</p>
      <div id="two-factor-body" aria-live="polite"></div>
    </div>
  </div>`;
}

export function renderTwoFactorScript(nonce: string): string {
  return `
  <script nonce="${escapeAttr(nonce)}">
    (function () {
      "use strict";
      var modal = document.getElementById("two-factor-modal");
      var body = document.getElementById("two-factor-body");
      if (!modal || !body) return;

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
          button("Done", "btn-primary", async function () { await render(); })
        );
        body.append(note, list, hint, actions);
      }

      function renderOff() {
        body.replaceChildren();
        body.append(el("p", "text-muted", "Two-factor sign-in is off for this account."));
        var password = input("two-factor-password", "password", "Your password", { autocomplete: "current-password" });
        var error = errorLine();
        var actions = el("div", "form-actions");
        actions.append(button("Set up", "btn-primary", async function () {
          error.textContent = "";
          try {
            var setup = await api("/api/auth/two-factor/setup", { password: password.field.value });
            renderSetup(setup);
          } catch (err) {
            error.textContent = err.message;
          }
        }));
        body.append(password.group, error, actions);
        password.field.focus();
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
              lkToast("Two-factor sign-in is on.", "success");
              showRecoveryCodes(result.recoveryCodes, "Two-factor sign-in is on. Other browsers signed in to this account were signed out. These are your recovery codes:");
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
        status.append(el("div", null, "Two-factor sign-in is on" + (state.enabledAt ? " since " + when(state.enabledAt) : "") + ". " +
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
          button("Turn off", "btn-danger", async function () {
            error.textContent = "";
            var ok = await lkConfirm({
              title: "Turn off two-factor sign-in?",
              message: "Signing in will need only the password again, and trusted browsers are forgotten.",
              confirmLabel: "Turn off",
              tone: "danger"
            });
            if (!ok) return;
            try {
              await api("/api/auth/two-factor/disable", credentials());
              lkToast("Two-factor sign-in is off.", "success");
              await render();
            } catch (err) {
              error.textContent = err.message;
            }
          })
        );
        body.append(status, password.group, code.group, error, actions);
      }

      async function render() {
        body.replaceChildren(el("p", "text-muted", "Loading…"));
        try {
          var state = await api("/api/auth/two-factor");
          if (state.enabled) renderOn(state);
          else renderOff();
        } catch (err) {
          body.replaceChildren(el("p", "form-error", "Could not load: " + err.message));
        }
      }

      function open() {
        modal.classList.add("active");
        render();
      }
      function close() {
        modal.classList.remove("active");
        body.replaceChildren();
      }

      document.addEventListener("click", function (e) {
        var target = e.target && e.target.closest ? e.target.closest("[data-action='open-two-factor'], [data-two-factor-close]") : null;
        if (target) {
          e.preventDefault();
          if (target.hasAttribute("data-two-factor-close")) close();
          else open();
          return;
        }
        if (e.target === modal) close();
      });
      document.addEventListener("keydown", function (e) {
        if (e.key === "Escape" && modal.classList.contains("active")) close();
      });
    })();
  </script>`;
}
