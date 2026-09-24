/**
 * The pieces every admin page shares: the tenant scope its API calls ride on,
 * and the behaviour behind the Level 2 context panel.
 *
 * The six per-page panels used to live here too, in one switch, six hundred
 * lines from the handlers that were supposed to read them. Each page module
 * now owns its own panel.
 */

import { LabConfig, Tenant, PortalSite, BroadcastPreset, TenantUser, WorkstationGroup } from "./types";
import { escapeAttr, escapeJson } from "./escape";

/** Everything a page builder is handed. */
export interface AdminPageInput {
  config: LabConfig;
  tenant?: Tenant;
  sites: PortalSite[];
  presets: BroadcastPreset[];
  staff: TenantUser[];
  groups?: WorkstationGroup[];
  baseDomain: string;
  /** `?tenant=<slug>` on a dev host, empty in production. See Rule 5e. */
  tenantParam: string;
  nonce: string;
}

/** Everything a page builder returns. */
export interface AdminPageParts {
  title: string;
  contentHtml: string;
  subPanelTitle: string;
  subPanelSubtitle: string;
  subPanelHtml: string;
  modalsHtml?: string;
  scriptsHtml: string;
}

// ============================================================================
// SUB-PANEL GENERATOR FOR MULTI-LEVEL PANELS
// ============================================================================

/**
 * Keeps the tenant on every dashboard API call.
 *
 * In production the organization is its own subdomain, so the Host header carries it
 * and a bare "/api/clients" resolves. On a dev host there is no subdomain, the
 * tenant travels as ?tenant=<slug>, and every one of these calls answered 400 --
 * which made the whole console untestable with `pnpm dev`.
 */
export function renderApiScopeScript(nonce: string, tenantParam: string): string {
  return `
    <script nonce="${escapeAttr(nonce)}">
      (function () {
        "use strict";
        var scope = ${escapeJson(tenantParam)};
        window.labkioskApi = function (path) {
          if (!scope) return path;
          return path + (path.indexOf("?") === -1 ? scope : "&" + scope.slice(1));
        };
      })();
    </script>
  `;
}
/**
 * Behaviour for the Level 2 context panel, on every page that has one.
 *
 * The panel shipped as markup only: `data-filter`, `data-action`, `data-preset`
 * and `data-quick-domain` were read by nothing, the "Add ..." shortcuts pointed
 * at element ids that did not exist, and the four telemetry counts never moved
 * off the zero they were rendered with. Every control in it was inert.
 *
 * Handlers are delegated from the panel itself, so a page that does not use a
 * given control simply has no element carrying it.
 */
export function renderSubPanelScripts(nonce: string, activePage: string, tenantParam: string): string {
  return `
    <script nonce="${escapeAttr(nonce)}">
      (function () {
        "use strict";
        var panel = document.getElementById("sub-panel");
        if (!panel) return;
        var activePage = ${escapeJson(activePage)};
        var workstationsHref = "/admin/workstations" + ${escapeJson(tenantParam)};

        /** Bring a field into view and put the caret in it. */
        function focusField(id) {
          var field = document.getElementById(id);
          if (!field) return;
          field.scrollIntoView({ behavior: "smooth", block: "center" });
          field.focus({ preventScroll: true });
        }

        /**
         * Run one of the workstation batch commands. The toolbar on the
         * workstations page owns the real handlers, so click through to it;
         * from any other page there is nothing to click, so navigate there.
         */
        function runToolbarAction() {
          for (var i = 0; i < arguments.length; i++) {
            var button = document.getElementById(arguments[i]);
            if (button) {
              button.click();
              return;
            }
          }
          window.location.href = workstationsHref;
        }

        function markDensity(choice) {
          var buttons = panel.querySelectorAll("[data-density]");
          for (var i = 0; i < buttons.length; i++) {
            buttons[i].classList.toggle("active", buttons[i].getAttribute("data-density") === choice);
          }
        }

        // The grid restores the density it was left in, so the panel has to show
        // which one that is rather than always marking the first button.
        if (typeof window.labkioskGridDensity === "function") markDensity(window.labkioskGridDensity());

        function setActiveFilter(button) {
          var buttons = panel.querySelectorAll("[data-filter]");
          for (var i = 0; i < buttons.length; i++) buttons[i].classList.remove("active");
          button.classList.add("active");
          window.labkioskApplyFilter(button.getAttribute("data-filter"));
        }

        panel.addEventListener("click", function (event) {
          var target = event.target && event.target.closest ? event.target.closest("[data-focus], [data-density], [data-filter], [data-action], [data-preset], [data-quick-domain]") : null;
          if (!target || target.hasAttribute("disabled")) return;

          var focusId = target.getAttribute("data-focus");
          if (focusId) {
            event.preventDefault();
            if (focusId === "app-title") {
              if (typeof window.labkioskSwitchTab === "function") window.labkioskSwitchTab("portal");
            } else if (focusId === "domain-input") {
              if (typeof window.labkioskSwitchTab === "function") window.labkioskSwitchTab("whitelist");
            }
            focusField(focusId);
            return;
          }

          var densityChoice = target.getAttribute("data-density");
          if (densityChoice) {
            event.preventDefault();
            if (typeof window.labkioskApplyDensity === "function") {
              window.labkioskApplyDensity(densityChoice);
              markDensity(densityChoice);
            }
            return;
          }

          if (target.hasAttribute("data-filter")) {
            event.preventDefault();
            if (typeof window.labkioskApplyFilter === "function") setActiveFilter(target);
            return;
          }

          var preset = target.getAttribute("data-preset");
          if (preset) {
            event.preventDefault();
            if (typeof window.labkioskSwitchTab === "function") window.labkioskSwitchTab("broadcast");
            var urlField = document.getElementById("broadcast-url");
            if (urlField) {
              urlField.value = preset;
              urlField.focus({ preventScroll: true });
              urlField.scrollIntoView({ behavior: "smooth", block: "center" });
            }
            return;
          }

          var quickDomain = target.getAttribute("data-quick-domain");
          if (quickDomain) {
            event.preventDefault();
            if (typeof window.labkioskSwitchTab === "function") window.labkioskSwitchTab("whitelist");
            var field = document.getElementById("domain-input");
            var form = document.getElementById("add-domain-form");
            if (field && form) {
              field.value = quickDomain;
              form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event("submit", { cancelable: true }));
            }
            return;
          }

          var action = target.getAttribute("data-action");
          if (!action) return;
          event.preventDefault();
          if (action.startsWith("tab-")) {
            var tabId = action.slice(4);
            if (typeof window.labkioskSwitchTab === "function") window.labkioskSwitchTab(tabId);
          }
          else if (action === "open-broadcast") runToolbarAction("btn-open-broadcast");
          else if (action === "open-lock-all") {
            // The lock dialog carries the announcement users will read. The
            // toolbar button locks immediately with the saved default; this is
            // the path for setting a message first.
            if (typeof window.labkioskOpenLockDialog === "function") window.labkioskOpenLockDialog();
            else window.location.href = workstationsHref;
          }
          else if (action === "open-unlock-all") runToolbarAction("btn-unlock-all");
          else if (action === "open-reboot-all") runToolbarAction("btn-reboot-all");
          else if (action === "open-shutdown-all") runToolbarAction("btn-shutdown-all");
          // The broadcast page calls the same thing "Stop Broadcast".
          else if (action === "reset-portal" || action === "quick-reset-portal") runToolbarAction("btn-reset-portal", "btn-stop-broadcast");
          else if (action === "new-group") {
            if (typeof window.labkioskOpenNewGroupDialog === "function") window.labkioskOpenNewGroupDialog();
          }
          else if (action === "delete-group") {
            var gid = target.getAttribute("data-id");
            var gname = target.getAttribute("data-name");
            if (typeof window.labkioskDeleteGroup === "function") window.labkioskDeleteGroup(gid, gname);
          }
        });

        // A page that installs no handler for a control cannot act on it; leave
        // those buttons out of the tab order rather than offering a control that
        // cannot work. The staff page filters by role, so this is decided by
        // what the page provides, not by which page it is.
        var inertSelectors = [];
        if (typeof window.labkioskApplyFilter !== "function") inertSelectors.push("[data-filter]");
        if (typeof window.labkioskApplyDensity !== "function") inertSelectors.push("[data-density]");
        if (inertSelectors.length) {
          var inert = panel.querySelectorAll(inertSelectors.join(", "));
          for (var j = 0; j < inert.length; j++) inert[j].setAttribute("disabled", "disabled");
        }

        // The header counters are rendered on every page but only the grid
        // polls telemetry. Elsewhere, fill them from the same endpoint so they
        // never claim an empty lab. A caller without the workstations
        // permission is refused, and the counters are then hidden instead.
        if (activePage !== "workstations" && document.getElementById("stat-online-count")) {
          var refreshCounters = function () {
            fetch(window.labkioskApi("/api/clients"))
              .then(function (res) {
                if (res.status === 401 || res.status === 403) {
                  var bar = document.getElementById("stat-online-count").closest(".canvas-header-center");
                  if (bar) bar.style.display = "none";
                  window.clearInterval(counterTimer);
                  return null;
                }
                return res.ok ? res.json() : null;
              })
              .then(function (data) {
                if (!data || !data.clients) return;
                var clients = Object.keys(data.clients).map(function (id) { return data.clients[id]; });
                var online = clients.filter(function (c) { return c.online; });
                document.getElementById("stat-online-count").textContent = String(online.length);
                document.getElementById("stat-total-count").textContent = String(clients.length);
                var locked = document.getElementById("stat-locked-count");
                if (locked) locked.textContent = String(online.filter(function (c) { return c.isLocked; }).length);
              })
              .catch(function (err) { console.warn("header counters:", err); });
          };
          var counterTimer = window.setInterval(refreshCounters, 15000);
          refreshCounters();
        }
      })();
    </script>
  `;
}
