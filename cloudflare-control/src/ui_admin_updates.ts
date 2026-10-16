/**
 * Settings -> Updates: which releases this organization's workstations are
 * offered, and how they take minor, security and major releases.
 * Shown to an account holding the `updates` permission.
 *
 * Stable is every release the platform has classified stable; beta adds the
 * releases it is still trying out. A workstation downloads the offered release
 * in the background when it hears of it. A minor release of the major it runs,
 * and a security release (the same release rebuilt with patched Debian
 * packages), always install at its next start. A new major release installs at
 * the next start once an administrator confirmed it.
 *
 * Lines the workstations run that the platform has put on security fixes only
 * or given an end-of-life date are warned about here, and a new major release
 * the platform opened or granted the organization waits for an administrator
 * to confirm it before any workstation is moved to it.
 *
 * Sharing on the local network (phase 5, off by default) lets the workstations
 * at one site copy a release from each other instead of each downloading it.
 */

import { escapeAttr } from "./escape";
import { WHEN_PANE_SHOWN_JS } from "./ui_admin_shared";
import { SECURITY_WAIT_WARN_DAYS } from "./releases";

export function renderUpdatesPaneHtml(): string {
  return `
      <div class="card" id="section-updates">
        <h2 class="card-title">System updates</h2>
        <p class="card-sub">Workstations installed on a disk download the release offered here in the background, check its signature, and install it when they next restart. A new major release waits until you confirm it below. A workstation started from a USB stick is updated by re-flashing it.</p>
        <div class="callout hidden" id="update-pending" role="status"></div>
        <div class="callout callout-warning hidden" id="update-lines" role="status"></div>
        <div class="hidden" id="update-majors"></div>
        <form id="form-update-channel">
          <div class="form-group">
            <label class="form-label" for="update-channel">Update channel</label>
            <select class="form-select" id="update-channel">
              <option value="stable">Stable: releases the platform has finished testing</option>
              <option value="beta">Beta: also releases still being tried out</option>
            </select>
            <p class="form-hint" id="update-offer">Loading…</p>
          </div>
          <div class="form-group">
            <p class="form-hint">Minor updates (a newer release of the major version a workstation runs, such as 3.1 for 3.0) and security fixes (the release it runs, rebuilt with patched system packages) install at the next restart, with no approval. An update changes nothing until the workstation starts again, and a workstation it does not start on goes back to its old image by itself. A new major version waits for you to confirm it.</p>
          </div>
          <div class="form-group">
            <label class="form-checkbox-label">
              <input type="checkbox" class="form-checkbox" id="lan-sharing">
              <span>Share updates on the local network</span>
            </label>
            <p class="form-hint">At each site, one or two workstations download a release and the others copy it from them over the local network, which saves internet bandwidth. A workstation that holds a release then accepts connections on TCP port 8890 from its own subnet, for up to 48 hours, and serves only that release's files; each copy is checked against the release's signature, and a workstation that cannot reach another downloads the release itself.</p>
          </div>
          <button type="submit" class="btn btn-primary">Save update settings</button>
        </form>
      </div>
  `;
}

export function renderUpdatesScript(nonce: string): string {
  return `
    <script nonce="${escapeAttr(nonce)}">
      (function () {
        const form = document.getElementById("form-update-channel");
        const select = document.getElementById("update-channel");
        const offer = document.getElementById("update-offer");
        const pending = document.getElementById("update-pending");
        const lanSharing = document.getElementById("lan-sharing");
        const linesBox = document.getElementById("update-lines");
        const majorsBox = document.getElementById("update-majors");
        if (!form || !select || !offer || !pending || !lanSharing || !linesBox || !majorsBox) return;

        function day(seconds) {
          return new Date(seconds * 1000).toISOString().slice(0, 10);
        }

        // Majors its workstations run that are security-only, end of life, or have an end-of-life date.
        function showLines(list) {
          const body = document.createElement("div");
          linesBox.replaceChildren(body);
          const items = Array.isArray(list) ? list : [];
          for (const item of items) {
            const count = Number(item.workstations) || 0;
            const who = count + (count === 1 ? " workstation runs " : " workstations run ") + "Lab Kiosk " + item.major;
            const line = document.createElement("div");
            line.textContent =
              item.status === "end_of_life"
                ? who + ", which has reached end of life: it receives no more updates, security fixes included. Install the newest release."
                : item.status === "security_only"
                ? who + ", which now receives security fixes only" + (item.endOfLifeAt ? " until " + day(item.endOfLifeAt) : "") + "."
                : who + ", which reaches end of life on " + day(item.endOfLifeAt) + ". Install the newest release before then.";
            body.append(line);
            if (item.note) {
              const note = document.createElement("div");
              note.textContent = item.note;
              body.append(note);
            }
          }
          linesBox.classList.toggle("hidden", !items.length);
        }

        // New major releases, and where this organization is in the pipeline to each:
        // ask Lab Kiosk for it, try it on one workstation group, then confirm it for all.
        let groups = [];
        function majorButton(label, tone, step, major) {
          const b = document.createElement("button");
          b.type = "button";
          b.className = "btn btn-sm " + tone;
          b.textContent = label;
          b.dataset.majorStep = step;
          b.dataset.major = String(major);
          return b;
        }
        function showMajors(list) {
          majorsBox.replaceChildren();
          const items = Array.isArray(list) ? list : [];
          for (const item of items) {
            const box = document.createElement("div");
            box.className = "callout mt-sm";
            const body = document.createElement("div");
            const title = document.createElement("strong");
            title.textContent = "Lab Kiosk " + item.major + " (" + item.newest + ")";
            const text = document.createElement("div");
            const actions = document.createElement("div");
            actions.className = "row mt-sm";
            body.append(title, text);
            if (item.access === "closed") {
              text.textContent = "A new major release. It is not available to your organization yet; ask Lab Kiosk for it and you are told the answer in Notifications.";
              actions.append(majorButton("Ask for Lab Kiosk " + item.major, "btn-primary", "request", item.major));
            } else if (item.access === "requested") {
              text.textContent = "Requested " + (item.requestedAt ? day(item.requestedAt) : "") + ". Lab Kiosk tells you in Notifications when it is available to your organization.";
            } else if (item.access === "confirmed") {
              text.textContent = "Confirmed " + (item.confirmedAt ? day(item.confirmedAt) : "") + ": your workstations download it and install it at their next restart.";
            } else if (item.access === "pilot") {
              text.textContent = "Being tried on the workstation group " + item.pilotGroup + ": only its workstations are offered it. When they work as you expect, confirm it for every workstation.";
              actions.append(
                majorButton("Confirm for every workstation", "btn-primary", "confirm", item.major),
                majorButton("End the trial", "btn-ghost", "end-pilot", item.major)
              );
            } else {
              text.textContent = "A new major release is available to your organization. It can change how workstations look and behave, so none is moved to it yet. Try it on one workstation group first, then confirm it for every workstation; once confirmed, each one downloads it and installs it at its next restart.";
              if (groups.length) actions.append(majorButton("Try on a group", "btn-secondary", "pilot", item.major));
              actions.append(majorButton("Confirm for every workstation", groups.length ? "btn-ghost" : "btn-primary", "confirm", item.major));
            }
            if (actions.childElementCount) body.append(actions);
            box.append(body);
            majorsBox.append(box);
          }
          majorsBox.classList.toggle("hidden", !items.length);
        }

        async function majorStep(step, major, group) {
          const path = step === "request" ? "request-major" : step === "confirm" ? "confirm-major" : "pilot-major";
          const payload = { major };
          if (step === "pilot" || step === "end-pilot") payload.group = step === "pilot" ? group : null;
          try {
            const res = await fetch(labkioskApi("/api/settings/updates/" + path), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(payload)
            });
            const data = await res.json();
            if (!res.ok) {
              lkToast(data.error || "The change could not be saved", "error");
              return;
            }
            lkToast(
              step === "request" ? "Lab Kiosk " + major + " requested." :
              step === "pilot" ? "Lab Kiosk " + major + " is offered to the group " + group + "." :
              step === "end-pilot" ? "The trial of Lab Kiosk " + major + " has ended." :
              "Lab Kiosk " + major + " confirmed.",
              "success"
            );
            load();
          } catch (err) {
            lkToast("Network error: " + err.message, "error");
          }
        }

        majorsBox.addEventListener("click", async (event) => {
          const b = event.target && event.target.closest ? event.target.closest("[data-major-step]") : null;
          if (!b) return;
          const major = Number(b.dataset.major);
          const step = b.dataset.majorStep;
          if (step === "request") {
            const ok = await lkConfirm({
              title: "Ask for Lab Kiosk " + major + "?",
              message: "Lab Kiosk reviews the request and tells you in Notifications. Nothing changes on your workstations until you then try it or confirm it.",
              confirmLabel: "Ask"
            });
            if (ok) majorStep(step, major);
            return;
          }
          if (step === "pilot") {
            const group = await lkPrompt({
              title: "Try Lab Kiosk " + major + " on a group",
              label: "Workstation group",
              choices: groups,
              hint: "Only its workstations are offered it; each installs it when you choose, from Workstations → Updates.",
              confirmLabel: "Try it"
            });
            if (group === null) return;
            majorStep(step, major, group);
            return;
          }
          if (step === "end-pilot") {
            const ok = await lkConfirm({
              title: "End the trial of Lab Kiosk " + major + "?",
              message: "No more workstations of the group are offered it. Those that installed it already keep it.",
              confirmLabel: "End the trial",
              tone: "danger"
            });
            if (ok) majorStep(step, major);
            return;
          }
          const ok = await lkConfirm({
            title: "Confirm Lab Kiosk " + major + " for every workstation?",
            message: "Your workstations will be offered Lab Kiosk " + major + ". Each one downloads it in the background and installs it at its next restart. This is recorded with your name.",
            confirmLabel: "Confirm"
          });
          if (ok) majorStep("confirm", major);
        });

        // Security fixes some workstations do not run yet; a warning once one has waited too long.
        function showPending(list) {
          // One block inside the callout, which lays its children out in a row.
          const body = document.createElement("div");
          pending.replaceChildren(body);
          const items = Array.isArray(list) ? list : [];
          let late = false;
          for (const item of items) {
            const days = Math.max(0, Math.floor((Date.now() / 1000 - (Number(item.offeredAt) || 0)) / 86400));
            if (days >= ${SECURITY_WAIT_WARN_DAYS}) late = true;
            const line = document.createElement("div");
            const count = Number(item.workstations) || 0;
            line.textContent =
              "Security fix " + item.version + " is not running yet on " + count + (count === 1 ? " workstation" : " workstations") +
              " (offered " + (days === 0 ? "today" : days === 1 ? "1 day ago" : days + " days ago") + ").";
            body.append(line);
          }
          if (items.length) {
            const next = document.createElement("div");
            next.textContent = "It installs when each workstation next starts; Workstations → Reboot installs it now.";
            body.append(next);
          }
          pending.classList.toggle("callout-warning", late);
          pending.classList.toggle("hidden", !items.length);
        }

        function show(data) {
          select.value = data.channel === "beta" ? "beta" : "stable";
          lanSharing.checked = data.lanSharing === true;
          const o = data.offer;
          offer.textContent = o
            ? "Offered now: " + o.version + (o.kind === "security" ? " (security update)" : "") + ", " + Math.round((Number(o.sizeBytes) || 0) / 1048576) + " MB."
            : "No release is offered on this channel yet.";
          showPending(data.pending);
          showLines(data.support);
          groups = Array.isArray(data.groups) ? data.groups : [];
          showMajors(data.majors);
        }

        async function load() {
          try {
            const res = await fetch(labkioskApi("/api/settings/updates"));
            const data = await res.json();
            if (!res.ok) {
              offer.textContent = data.error || "The update settings could not be read.";
              return;
            }
            show(data);
          } catch (err) {
            offer.textContent = "Network error: " + err.message;
          }
        }

        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          try {
            const res = await fetch(labkioskApi("/api/settings/updates"), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ channel: select.value, lanSharing: lanSharing.checked })
            });
            const data = await res.json();
            if (!res.ok) {
              lkToast(data.error || "The update settings could not be saved", "error");
              return;
            }
            show(data);
            lkToast("Update settings saved.", "success");
          } catch (err) {
            lkToast("Network error: " + err.message, "error");
          }
        });

${WHEN_PANE_SHOWN_JS}
        whenPaneShown(form, load);
      })();
    </script>
  `;
}
