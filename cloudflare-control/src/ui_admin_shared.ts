/**
 * The pieces every admin page shares: the tenant scope its API calls ride on,
 * and the header counters.
 */

import type { MonthlySummary } from "./monthly_summary";
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
  /**
   * Settings for an account without the `settings` permission: only what is
   * the account's own (its two-factor sign-in), nothing of the organization's.
   */
  accountOnly?: boolean;
  /** The account holds the `updates` permission: check for and install system updates. */
  canUpdate?: boolean;
  /** The account holds the `settings` permission: it can ask for Remote Control or a chosen address. */
  canSettings?: boolean;
  /** Last month's summary, for Workstations (src/monthly_summary.ts). */
  monthlySummary?: MonthlySummary | null;
  /** The account is an administrator of the organization (its owner or an `org_admin`): Remote Control. */
  canRemoteControl?: boolean;
  /** The account's permissions (`*` for an administrator), for pages that show only what it may open. */
  permissions?: string[];
  nonce: string;
}

/** Everything a page builder returns. */
export interface AdminPageParts {
  title: string;
  contentHtml: string;
  modalsHtml?: string;
  scriptsHtml: string;
}

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
 * The header counters (online, total, locked) on the pages that are not the
 * workstation grid, which fills them from its own poll.
 */
export function renderHeaderCountersScript(nonce: string, activePage: string): string {
  return `
    <script nonce="${escapeAttr(nonce)}">
      (function () {
        "use strict";
        var activePage = ${escapeJson(activePage)};

        // Filled from the grid's own endpoint, so they never claim an empty
        // lab. A caller without the workstations permission is refused, and
        // the counters are then hidden instead.
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

/**
 * Client code, written into a page script: run `run` once the tab pane holding
 * `inside` is first shown, at once when it already is (or the page has no panes).
 * A pane's data is asked for when its tab is opened, not on every page load.
 */
export const WHEN_PANE_SHOWN_JS = `
      function whenPaneShown(inside, run) {
        var pane = inside && inside.closest ? inside.closest(".tab-pane") : null;
        if (!pane || pane.classList.contains("active")) { run(); return; }
        var seen = new MutationObserver(function () {
          if (!pane.classList.contains("active")) return;
          seen.disconnect();
          run();
        });
        seen.observe(pane, { attributes: true, attributeFilter: ["class"] });
      }
`;

/**
 * Client code, written into a page script: the page's `.segmented-nav` tabs
 * switch its `.tab-pane`s (`data-action="tab-<id>"`, `id="pane-<id>"`), the
 * open tab rides in `?tab=` (replaceState, no jump), and an unknown tab opens
 * `fallback`. Sets `window.labkioskSwitchTab`, as Settings does.
 */
export function tabSwitchScript(fallback: string): string {
  return `
      (function () {
        function switchTab(tabId) {
          var valid = Array.from(document.querySelectorAll(".tab-pane[id^='pane-']")).map(function (p) { return p.id.slice(5); });
          if (valid.indexOf(tabId) < 0) tabId = ${JSON.stringify(fallback)};
          document.querySelectorAll(".segmented-nav .segmented-tab").forEach(function (tab) {
            var active = tab.getAttribute("data-action") === "tab-" + tabId;
            tab.classList.toggle("active", active);
            if (active && typeof tab.scrollIntoView === "function") tab.scrollIntoView({ block: "nearest", inline: "nearest" });
          });
          document.querySelectorAll(".tab-pane").forEach(function (pane) { pane.classList.toggle("active", pane.id === "pane-" + tabId); });
          try {
            var url = new URL(window.location.href);
            url.searchParams.set("tab", tabId);
            window.history.replaceState({}, "", url.toString());
          } catch (err) {
            console.warn("Could not record the tab in the address:", err);
          }
        }
        window.labkioskSwitchTab = switchTab;
        var nav = document.querySelector(".segmented-nav");
        if (nav) nav.addEventListener("click", function (e) {
          var tab = e.target && e.target.closest ? e.target.closest(".segmented-tab") : null;
          var action = tab ? tab.getAttribute("data-action") : null;
          if (action && action.indexOf("tab-") === 0) { e.preventDefault(); switchTab(action.slice(4)); }
        });
        switchTab(new URLSearchParams(window.location.search).get("tab") || ${JSON.stringify(fallback)});
      })();
`;
}
