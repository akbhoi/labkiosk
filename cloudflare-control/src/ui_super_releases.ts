/**
 * The Super Admin console's Releases tab (/super/releases): the signed system
 * images CI uploaded to the releases bucket, and the channel each is offered on.
 *
 * A feature release reaches no workstation until it is classified `beta` or
 * `stable` here. Beta organizations are offered the newest of both; every
 * other organization the newest stable one. A security release (a rebuild of
 * an earlier release with patched packages) has a section of its own and no
 * channel: it is offered from the moment it is recorded to the workstations on
 * its own line, which install it at their next start unless their organization
 * approves security fixes. Revoking withdraws a release for good.
 * The list is read from GET /api/super/releases, which first records any new
 * release it finds in the bucket.
 *
 * Below it, each major release's support status (supported, security fixes
 * only, end of life, with an announced end-of-life date) and its gate: a
 * closed major reaches only the organizations it is opened or granted to, once
 * an administrator of each has confirmed it in Settings -> Updates.
 */

import { escapeAttr } from "./escape";

export function renderReleasesPaneHtml(): string {
  return `
      <div class="tab-pane active" id="pane-releases-list">
        <div class="card">
          <h2 class="card-title">System image releases</h2>
          <p class="card-sub">Each feature release CI signed and uploaded. Classify one <strong>beta</strong> to offer it to organizations on the beta channel, or <strong>stable</strong> to offer it to every organization. Workstations check its signature themselves before they download it.</p>
          <div class="callout callout-warning hidden" id="releases-notice" role="status"></div>
          <div class="table-container">
            <table>
              <thead>
                <tr>
                  <th>Version</th>
                  <th>Size</th>
                  <th>Built</th>
                  <th>Security floor</th>
                  <th>Channel</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody id="release-rows">
                <tr><td colspan="6" class="table-empty">Loading…</td></tr>
              </tbody>
            </table>
          </div>
        </div>
        <div class="card">
          <h2 class="card-title">Security</h2>
          <p class="card-sub">Each security rebuild of a release, with the Debian security fixes published since. A security release needs no classification: it is offered for download as soon as it is here, to every workstation on its line, which installs it at its next restart unless its organization approves security fixes. The daily rebuild covers each major's newest stable line and any newer one, so an older line stops receiving them once a newer line of its major is stable. Revoke one only if it must never be installed.</p>
          <div class="table-container">
            <table>
              <thead>
                <tr>
                  <th>Version</th>
                  <th>Rebuild of</th>
                  <th>Size</th>
                  <th>Built</th>
                  <th>Security floor</th>
                  <th>Status</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody id="security-rows">
                <tr><td colspan="7" class="table-empty">Loading…</td></tr>
              </tbody>
            </table>
          </div>
        </div>
        <div class="card">
          <h2 class="card-title">Support and end of life</h2>
          <p class="card-sub">Support is set per major release and covers every release of it, such as 2.x. <strong>Security only</strong> keeps sending its security fixes to the workstations already on it and moves no other workstation onto it. <strong>End of life</strong> offers it nothing more, security fixes included, and the daily security rebuild stops building it; an end-of-life date does the same by itself once it has passed. Changing a major's status or date notifies every organization in its console, and can email every owner; as the date nears, reminders go out by themselves 60, 30 and 7 days before it and once it has passed. The download page lists the newest release of each major that is not at end of life, and names the ones that are.</p>
          <div class="table-container">
            <table>
              <thead>
                <tr>
                  <th>Major</th>
                  <th>Status</th>
                  <th>End of life</th>
                  <th>Workstations</th>
                  <th>Note</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody id="line-rows">
                <tr><td colspan="6" class="table-empty">Loading…</td></tr>
              </tbody>
            </table>
          </div>
        </div>
        <div class="card">
          <h2 class="card-title">Major releases</h2>
          <p class="card-sub">The first release of a new major version arrives <strong>closed</strong>: no workstation is moved to it. Open it to every organization, or grant it to one (an organization can ask for it from Settings → Updates; its request shows here). Either way an administrator of each organization tries it on one workstation group or confirms it for every workstation before any is moved. A workstation moves one major at a time, from the newest release of its own major; one already on a major keeps receiving it.</p>
          <div class="table-container">
            <table>
              <thead>
                <tr>
                  <th>Major</th>
                  <th>Who is offered it</th>
                  <th>Organizations granted or confirmed</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody id="major-rows">
                <tr><td colspan="4" class="table-empty">Loading…</td></tr>
              </tbody>
            </table>
          </div>
        </div>
      </div>
  `;
}

export function renderReleasesScript(nonce: string): string {
  return `
    <script nonce="${escapeAttr(nonce)}">
      (function () {
        const rows = document.getElementById("release-rows");
        const securityRows = document.getElementById("security-rows");
        const notice = document.getElementById("releases-notice");
        const lineRows = document.getElementById("line-rows");
        const majorRows = document.getElementById("major-rows");
        if (!rows || !securityRows || !notice || !lineRows || !majorRows) return;
        let majors = [];

        function cell(text, className) {
          const td = document.createElement("td");
          if (className) td.className = className;
          td.textContent = text;
          return td;
        }
        function placeholder(text, span) {
          const row = document.createElement("tr");
          const td = cell(text, "table-empty");
          td.colSpan = span || 7;
          row.appendChild(td);
          return row;
        }
        function day(seconds) {
          return seconds ? new Date(seconds * 1000).toISOString().slice(0, 10) : "";
        }
        function policyButton(label, tone, data) {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "btn btn-sm " + tone;
          b.textContent = label;
          Object.keys(data).forEach((key) => { b.dataset[key] = data[key]; });
          return b;
        }
        const LINE_LABELS = { supported: ["Supported", "green"], security_only: ["Security only", "yellow"], end_of_life: ["End of life", "red"] };

        function renderLines() {
          lineRows.replaceChildren();
          if (!majors.length) {
            lineRows.appendChild(placeholder("No major releases yet.", 6));
            return;
          }
          for (const l of majors) {
            const row = document.createElement("tr");
            row.appendChild(cell(l.major + ".x", "mono"));
            const status = document.createElement("td");
            const shown = LINE_LABELS[l.effectiveStatus] || LINE_LABELS.supported;
            status.appendChild(badge(shown[0], shown[1]));
            if (l.effectiveStatus !== l.status) {
              const set = document.createElement("div");
              set.className = "text-xs nowrap";
              set.textContent = "Its end-of-life date has passed";
              status.appendChild(set);
            }
            row.appendChild(status);
            row.appendChild(cell(l.endOfLifeAt ? day(l.endOfLifeAt) : "None", "mono text-xs nowrap"));
            const count = Number(l.workstations) || 0;
            const orgs = Number(l.organizations) || 0;
            row.appendChild(cell(count + (count === 1 ? " workstation" : " workstations") + (orgs ? " in " + orgs + (orgs === 1 ? " organization" : " organizations") : ""), "nowrap"));
            row.appendChild(cell(l.note || "", "text-xs"));
            const actions = document.createElement("td");
            const wrap = document.createElement("div");
            wrap.className = "cell-actions";
            if (l.status !== "supported") wrap.appendChild(policyButton("Supported", "btn-secondary", { lineAction: "status", major: String(l.major), status: "supported" }));
            if (l.status !== "security_only") wrap.appendChild(policyButton("Security only", "btn-secondary", { lineAction: "status", major: String(l.major), status: "security_only" }));
            if (l.status !== "end_of_life") wrap.appendChild(policyButton("End of life", "btn-danger", { lineAction: "status", major: String(l.major), status: "end_of_life" }));
            wrap.appendChild(policyButton(l.endOfLifeAt ? "Change date" : "Set end-of-life date", "btn-ghost", { lineAction: "date", major: String(l.major) }));
            if (l.endOfLifeAt) wrap.appendChild(policyButton("Clear date", "btn-ghost", { lineAction: "clear-date", major: String(l.major) }));
            wrap.appendChild(policyButton("Note", "btn-ghost", { lineAction: "note", major: String(l.major) }));
            actions.appendChild(wrap);
            row.appendChild(actions);
            lineRows.appendChild(row);
          }
        }

        function renderMajors() {
          majorRows.replaceChildren();
          if (!majors.length) {
            majorRows.appendChild(placeholder("No releases yet.", 4));
            return;
          }
          for (const m of majors) {
            const row = document.createElement("tr");
            row.appendChild(cell(m.major + ".x", "mono"));
            const state = document.createElement("td");
            if (m.state === "free") state.appendChild(badge("Every organization", "green"));
            else if (m.state === "open") state.appendChild(badge("Every organization that confirms it", "blue"));
            else state.appendChild(badge("Closed: granted organizations that confirm it", "yellow"));
            row.appendChild(state);
            const grants = document.createElement("td");
            if (!m.grants.length) grants.textContent = "None";
            for (const g of m.grants) {
              const line = document.createElement("div");
              line.className = "cell-actions";
              const text = document.createElement("span");
              text.className = "text-xs";
              const waiting = m.state === "closed" && !g.grantedAt;
              text.textContent = g.name + ": " + (waiting
                ? "requested " + (g.requestedAt ? day(g.requestedAt) : "")
                : (g.grantedAt ? "granted " + day(g.grantedAt) : "open to all") + ", " +
                  (g.confirmedAt ? "confirmed " + day(g.confirmedAt) : g.pilotGroup ? "trying it on the group " + g.pilotGroup : "not confirmed yet"));
              line.appendChild(text);
              if (waiting && g.requestedAt) {
                line.appendChild(policyButton("Grant", "btn-primary", { majorAction: "grant", major: String(m.major), tenantId: g.tenantId, tenantName: g.name }));
                line.appendChild(policyButton("Decline", "btn-ghost", { majorAction: "decline", major: String(m.major), tenantId: g.tenantId, tenantName: g.name }));
              }
              if (g.grantedAt) line.appendChild(policyButton("Take back", "btn-ghost", { majorAction: "ungrant", major: String(m.major), tenantId: g.tenantId }));
              grants.appendChild(line);
            }
            row.appendChild(grants);
            const actions = document.createElement("td");
            const wrap = document.createElement("div");
            wrap.className = "cell-actions";
            if (m.state !== "open") wrap.appendChild(policyButton("Open to all", "btn-secondary", { majorAction: "open", major: String(m.major) }));
            if (m.state !== "closed") wrap.appendChild(policyButton("Close", "btn-danger", { majorAction: "close", major: String(m.major) }));
            if (m.state === "closed") wrap.appendChild(policyButton("Grant to an organization", "btn-primary", { majorAction: "grant", major: String(m.major) }));
            actions.appendChild(wrap);
            row.appendChild(actions);
            majorRows.appendChild(row);
          }
        }

        function showPolicy(data) {
          if (Array.isArray(data.majors)) majors = data.majors;
          renderLines();
          renderMajors();
        }

        async function postPolicy(url, payload) {
          try {
            const res = await fetch(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload)
            });
            const data = await res.json();
            if (!res.ok) {
              lkToast(data.error || "The change could not be saved", "error");
              return null;
            }
            showPolicy(data);
            return data;
          } catch (err) {
            lkToast("Network error: " + err.message, "error");
            return null;
          }
        }

        lineRows.addEventListener("click", async (event) => {
          const b = event.target && event.target.closest ? event.target.closest("[data-line-action]") : null;
          if (!b) return;
          const current = majors.find((l) => String(l.major) === b.dataset.major);
          if (!current) return;
          const label = current.major + ".x";
          const next = { major: current.major, status: current.status, endOfLifeAt: current.endOfLifeAt, note: current.note };
          const action = b.dataset.lineAction;
          if (action === "status") {
            next.status = b.dataset.status;
            const messages = {
              supported: "Workstations are offered every release of " + label + " again.",
              security_only: "Workstations already on " + label + " keep receiving its security fixes. No other workstation is moved onto it.",
              end_of_life: "No release of " + label + " is offered any more, security fixes included, and the daily security rebuild stops building it. Workstations on it are offered the newest supported release."
            };
            const ok = await lkConfirm({
              title: (LINE_LABELS[next.status] || LINE_LABELS.supported)[0] + ": " + label + "?",
              message: messages[next.status],
              confirmLabel: "Save",
              tone: next.status === "end_of_life" ? "danger" : undefined
            });
            if (!ok) return;
          } else if (action === "date") {
            const value = await lkPrompt({
              title: "End-of-life date for " + label,
              label: "Date (YYYY-MM-DD, UTC)",
              value: day(current.endOfLifeAt),
              hint: "From this date the major is offered nothing more, security fixes included.",
              confirmLabel: "Save date"
            });
            if (value === null) return;
            const parsed = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value) ? Date.parse(value + "T00:00:00Z") : NaN;
            if (!Number.isFinite(parsed)) {
              lkToast("Enter the date as YYYY-MM-DD", "error");
              return;
            }
            next.endOfLifeAt = Math.floor(parsed / 1000);
          } else if (action === "clear-date") {
            next.endOfLifeAt = null;
          } else if (action === "note") {
            const value = await lkPrompt({
              title: "Note for " + label,
              label: "Added to the notification and the email when the status or date next changes",
              value: current.note || "",
              confirmLabel: "Save note"
            });
            if (value === null) return;
            next.note = value;
          } else {
            return;
          }
          const restrictive = next.status !== "supported" || (next.endOfLifeAt && next.endOfLifeAt !== current.endOfLifeAt);
          if (restrictive && action !== "note") {
            next.notify = await lkConfirm({
              title: "Email every organization about " + label + "?",
              message: "Every organization sees what changed in its console. The owner of every active organization can be emailed it too" +
                (Number(current.organizations) > 0 ? "; " + current.organizations + " of them have workstations on it." : "."),
              confirmLabel: "Email owners",
              cancelLabel: "Don't email"
            });
          }
          const data = await postPolicy("/api/super/release-support", next);
          if (!data) return;
          if (data.emailProblem) lkToast(data.emailProblem, "error");
          else lkToast(label + " saved" + (data.emailed ? ", " + data.emailed + (data.emailed === 1 ? " owner" : " owners") + " emailed" : "") + (data.emailFailed ? ", " + data.emailFailed + " emails failed" : ""), data.emailFailed ? "error" : "success");
        });

        majorRows.addEventListener("click", async (event) => {
          const b = event.target && event.target.closest ? event.target.closest("[data-major-action]") : null;
          if (!b) return;
          const major = Number(b.dataset.major);
          const action = b.dataset.majorAction;
          const payload = { major, action };
          if (action === "grant" && b.dataset.tenantId) {
            payload.tenantId = b.dataset.tenantId;
            const ok = await lkConfirm({ title: "Grant " + major + ".x to " + b.dataset.tenantName + "?", message: "The organization is notified. Its administrator then tries it on a workstation group or confirms it under Settings \u2192 Updates.", confirmLabel: "Grant" });
            if (!ok) return;
          } else if (action === "decline") {
            payload.tenantId = b.dataset.tenantId;
            const reason = await lkPrompt({
              title: "Decline the request of " + b.dataset.tenantName + " for " + major + ".x?",
              label: "Reason, shown to the organization",
              hint: "The organization is notified and may ask again later.",
              confirmLabel: "Decline"
            });
            if (reason === null) return;
            payload.reason = reason;
          } else if (action === "grant") {
            const subdomain = await lkPrompt({
              title: "Grant " + major + ".x to an organization",
              label: "The organization's subdomain",
              placeholder: "riverside",
              hint: "An administrator of the organization then confirms it under Settings \u2192 Updates.",
              confirmLabel: "Grant"
            });
            if (subdomain === null) return;
            payload.subdomain = subdomain;
          } else if (action === "ungrant") {
            payload.tenantId = b.dataset.tenantId;
            const ok = await lkConfirm({ title: "Take " + major + ".x back?", message: "The organization's confirmation is removed too. Its workstations already on " + major + ".x keep it.", confirmLabel: "Take back", tone: "danger" });
            if (!ok) return;
          } else {
            const ok = await lkConfirm(action === "open"
              ? { title: "Open " + major + ".x to every organization?", message: "Each organization's administrator still confirms it before its workstations are moved.", confirmLabel: "Open" }
              : { title: "Close " + major + ".x?", message: "Only organizations granted it are offered it. Workstations already on it keep it.", confirmLabel: "Close", tone: "danger" });
            if (!ok) return;
          }
          if (await postPolicy("/api/super/release-majors", payload)) lkToast(major + ".x saved", "success");
        });
        function badge(text, tone) {
          const span = document.createElement("span");
          span.className = "badge badge-" + tone;
          span.textContent = text;
          return span;
        }
        function size(bytes) {
          const n = Number(bytes) || 0;
          if (n >= 1073741824) return (n / 1073741824).toFixed(2) + " GB";
          return Math.round(n / 1048576) + " MB";
        }
        function button(label, tone, action, version, channel) {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "btn btn-sm " + tone;
          b.textContent = label;
          b.dataset.releaseAction = action;
          b.dataset.version = version;
          if (channel !== undefined) b.dataset.channel = channel;
          return b;
        }
        function showNotice(lines) {
          notice.replaceChildren();
          lines.forEach((line) => {
            const p = document.createElement("div");
            p.textContent = line;
            notice.appendChild(p);
          });
          notice.classList.toggle("hidden", lines.length === 0);
        }

        function built(r) {
          return cell(String(r.builtAt || "").replace("T", " ").replace(/Z$/, " UTC"), "mono text-xs nowrap");
        }

        function renderSecurity(releases) {
          securityRows.replaceChildren();
          if (!releases.length) {
            securityRows.appendChild(placeholder("No security releases yet. The daily security rebuild uploads one when a release's packages have a Debian security fix."));
            return;
          }
          for (const r of releases) {
            const row = document.createElement("tr");
            row.appendChild(cell(r.version, "mono"));
            row.appendChild(cell(r.baseVersion || "", "mono"));
            row.appendChild(cell(size(r.sizeBytes), "nowrap"));
            row.appendChild(built(r));
            row.appendChild(cell(r.securityFloor, "mono"));
            const state = document.createElement("td");
            state.appendChild(r.revokedAt ? badge("Revoked", "red") : badge("Offered on its line", "green"));
            row.appendChild(state);
            const actions = document.createElement("td");
            const wrap = document.createElement("div");
            wrap.className = "cell-actions";
            if (!r.revokedAt) wrap.appendChild(button("Revoke", "btn-danger", "revoke", r.version));
            actions.appendChild(wrap);
            row.appendChild(actions);
            securityRows.appendChild(row);
          }
        }

        function render(all) {
          renderSecurity(all.filter((r) => r.kind === "security"));
          const releases = all.filter((r) => r.kind !== "security");
          rows.replaceChildren();
          if (!releases.length) {
            rows.appendChild(placeholder("No releases in the bucket yet. CI uploads one under releases/<version>/ for every tagged build.", 6));
            return;
          }
          for (const r of releases) {
            const row = document.createElement("tr");
            row.appendChild(cell(r.version, "mono"));
            row.appendChild(cell(size(r.sizeBytes), "nowrap"));
            row.appendChild(built(r));
            row.appendChild(cell(r.securityFloor, "mono"));
            const channel = document.createElement("td");
            if (r.revokedAt) channel.appendChild(badge("Revoked", "red"));
            else if (r.channel === "stable") channel.appendChild(badge("Stable", "green"));
            else if (r.channel === "beta") channel.appendChild(badge("Beta", "yellow"));
            else channel.appendChild(badge("Not offered", "neutral"));
            row.appendChild(channel);
            const actions = document.createElement("td");
            const wrap = document.createElement("div");
            wrap.className = "cell-actions";
            if (!r.revokedAt) {
              if (r.channel !== "beta") wrap.appendChild(button("Beta", "btn-secondary", "classify", r.version, "beta"));
              if (r.channel !== "stable") wrap.appendChild(button("Stable", "btn-primary", "classify", r.version, "stable"));
              if (r.channel) wrap.appendChild(button("Withdraw", "btn-ghost", "classify", r.version, ""));
              wrap.appendChild(button("Revoke", "btn-danger", "revoke", r.version));
            }
            actions.appendChild(wrap);
            row.appendChild(actions);
            rows.appendChild(row);
          }
        }

        async function load() {
          try {
            const res = await fetch("/api/super/releases");
            const data = await res.json();
            if (!res.ok) {
              rows.replaceChildren(placeholder(data.error || "Releases could not be read", 6));
              securityRows.replaceChildren(placeholder(data.error || "Security releases could not be read"));
              lineRows.replaceChildren(placeholder(data.error || "Support status could not be read", 6));
              majorRows.replaceChildren(placeholder(data.error || "Major releases could not be read", 4));
              return;
            }
            const messages = [];
            if (!data.downloadsConfigured) {
              messages.push("RELEASES_BASE_URL is not set: workstations cannot download any release until it names the bucket's public address.");
            } else if (data.downloadsDevelopmentOnly) {
              messages.push("RELEASES_BASE_URL is the bucket's r2.dev address, which Cloudflare rate-limits and never caches: connect a custom domain to the bucket and use that address instead.");
            }
            (data.problems || []).forEach((p) => messages.push(p.version + ": " + p.problem));
            showNotice(messages);
            render(Array.isArray(data.releases) ? data.releases : []);
            showPolicy(data);
          } catch (err) {
            rows.replaceChildren(placeholder("Network error: " + err.message, 6));
            securityRows.replaceChildren(placeholder("Network error: " + err.message));
          }
        }

        async function onReleaseAction(event) {
          const b = event.target && event.target.closest ? event.target.closest("[data-release-action]") : null;
          if (!b) return;
          const version = b.dataset.version;
          const revoke = b.dataset.releaseAction === "revoke";
          const channel = b.dataset.channel || null;
          const security = b.closest("tbody") === securityRows;
          const line = String(version).split(".").slice(0, 2).join(".");
          const offerMessage = channel === "stable"
            ? "Every organization's workstations will download it, and their administrators can install it."
            : "Workstations of organizations on the beta channel will download it, and their administrators can install it.";
          const agreed = await lkConfirm(
            revoke
              ? {
                  title: "Revoke " + version + "?",
                  message: (security
                    ? "Workstations on the " + line + " line stop installing this security fix at their next restart. "
                    : "") +
                    "No workstation is offered this release again. A workstation that already installed it keeps it until a newer release replaces it. This cannot be undone.",
                  confirmLabel: "Revoke",
                  tone: "danger"
                }
              : channel
              ? {
                  title: "Offer " + version + " on " + channel + "?",
                  message: offerMessage,
                  confirmLabel: "Offer on " + channel
                }
              : {
                  title: "Stop offering " + version + "?",
                  message: "Workstations that already downloaded it keep it, but no administrator is offered it until it is classified again.",
                  confirmLabel: "Withdraw"
                }
          );
          if (!agreed) return;
          try {
            const res = await fetch(revoke ? "/api/super/releases/revoke" : "/api/super/releases/classify", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(revoke ? { version } : { version, channel })
            });
            const data = await res.json();
            if (!res.ok) {
              lkToast(data.error || "The release could not be changed", "error");
              return;
            }
            render(Array.isArray(data.releases) ? data.releases : []);
            lkToast(revoke ? version + " revoked" : channel ? version + " offered on " + channel : version + " withdrawn", "success");
          } catch (err) {
            lkToast("Network error: " + err.message, "error");
          }
        }
        rows.addEventListener("click", onReleaseAction);
        securityRows.addEventListener("click", onReleaseAction);

        load();
      })();
    </script>
  `;
}
