/**
 * The pieces every admin page shares: the tenant scope its API calls ride on,
 * and the header counters.
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
  /**
   * Settings for an account without the `settings` permission: only what is
   * the account's own (its two-factor sign-in), nothing of the organization's.
   */
  accountOnly?: boolean;
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
