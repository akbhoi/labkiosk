/**
 * The Super Admin console's Releases tab (/super/releases): the signed system
 * images CI uploaded to the releases bucket, and the channel each is offered on.
 *
 * A release reaches no workstation until it is classified `beta` or `stable`
 * here. Beta organizations are offered the newest of both; every other
 * organization the newest stable one. A security release (a rebuild of an
 * earlier release with patched packages) is offered only to workstations on
 * its own line, which install it at their next start unless their organization
 * approves security fixes. Revoking withdraws a release for good.
 * The list is read from GET /api/super/releases, which first records any new
 * release it finds in the bucket.
 */

import { escapeAttr } from "./escape";

export function renderReleasesPaneHtml(): string {
  return `
      <div class="tab-pane active" id="pane-releases-list">
        <div class="card">
          <h2 class="card-title">System image releases</h2>
          <p class="card-sub">Each release CI signed and uploaded. Classify one <strong>beta</strong> to offer it to organizations on the beta channel, or <strong>stable</strong> to offer it to every organization. Workstations check its signature themselves before they download it.</p>
          <div class="callout callout-warning hidden" id="releases-notice" role="status"></div>
          <div class="table-container">
            <table>
              <thead>
                <tr>
                  <th>Version</th>
                  <th>Kind</th>
                  <th>Size</th>
                  <th>Built</th>
                  <th>Security floor</th>
                  <th>Channel</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody id="release-rows">
                <tr><td colspan="7" class="table-empty">Loading…</td></tr>
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
        const notice = document.getElementById("releases-notice");
        if (!rows || !notice) return;

        function cell(text, className) {
          const td = document.createElement("td");
          if (className) td.className = className;
          td.textContent = text;
          return td;
        }
        function placeholder(text) {
          const row = document.createElement("tr");
          const td = cell(text, "table-empty");
          td.colSpan = 7;
          row.appendChild(td);
          return row;
        }
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

        function render(releases) {
          rows.replaceChildren();
          if (!releases.length) {
            rows.appendChild(placeholder("No releases in the bucket yet. CI uploads one under releases/<version>/ for every tagged build."));
            return;
          }
          for (const r of releases) {
            const row = document.createElement("tr");
            row.dataset.kind = r.kind === "security" ? "security" : "feature";
            row.appendChild(cell(r.version, "mono"));
            const kind = document.createElement("td");
            kind.appendChild(badge(r.kind === "security" ? "Security" : "Feature", r.kind === "security" ? "red" : "neutral"));
            if (r.kind === "security" && r.baseVersion) {
              const base = document.createElement("div");
              base.className = "text-xs nowrap";
              base.textContent = "Rebuild of " + r.baseVersion;
              kind.appendChild(base);
            }
            row.appendChild(kind);
            row.appendChild(cell(size(r.sizeBytes), "nowrap"));
            row.appendChild(cell(String(r.builtAt || "").replace("T", " ").replace(/Z$/, " UTC"), "mono text-xs nowrap"));
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
              rows.replaceChildren(placeholder(data.error || "Releases could not be read"));
              return;
            }
            const lines = [];
            if (!data.downloadsConfigured) {
              lines.push("RELEASES_BASE_URL is not set: workstations cannot download any release until it names the bucket's public address.");
            }
            (data.problems || []).forEach((p) => lines.push(p.version + ": " + p.problem));
            showNotice(lines);
            render(Array.isArray(data.releases) ? data.releases : []);
          } catch (err) {
            rows.replaceChildren(placeholder("Network error: " + err.message));
          }
        }

        rows.addEventListener("click", async (event) => {
          const b = event.target && event.target.closest ? event.target.closest("[data-release-action]") : null;
          if (!b) return;
          const version = b.dataset.version;
          const revoke = b.dataset.releaseAction === "revoke";
          const channel = b.dataset.channel || null;
          const row = b.closest("tr");
          const security = Boolean(row && row.dataset.kind === "security");
          const line = String(version).split(".").slice(0, 2).join(".");
          // A security release installs by itself at the next start, on its own line only.
          const offerMessage = security
            ? (channel === "stable" ? "Every organization's" : "Beta organizations'") +
              " workstations on the " + line + " line will download it and install it at their next restart. " +
              "Organizations that approve security fixes install it from Workstations \u2192 Updates instead."
            : channel === "stable"
            ? "Every organization's workstations will download it, and their administrators can install it."
            : "Workstations of organizations on the beta channel will download it, and their administrators can install it.";
          const agreed = await lkConfirm(
            revoke
              ? {
                  title: "Revoke " + version + "?",
                  message: "No workstation is offered this release again. A workstation that already installed it keeps it until a newer release replaces it. This cannot be undone.",
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
        });

        load();
      })();
    </script>
  `;
}
