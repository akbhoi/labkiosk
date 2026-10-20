/**
 * Settings -> Printing: whether the organization's workstations may print, and
 * to which network printers (src/printing.ts). Shown to an account holding the
 * `settings` permission.
 *
 * Off by default. With it off a workstation runs no print service and its
 * browser refuses to print; turned on, each workstation sets up the printers
 * meant for it (all of them, or those limited to its group) and the kiosk bar
 * shows a Print button. The whole form is one save: the switch and the list.
 */

import { escapeAttr } from "./escape";
import { WHEN_PANE_SHOWN_JS } from "./ui_admin_shared";
import { MAX_PRINTERS, MAX_PRINTER_NAME_LENGTH, MAX_PRINTER_URI_LENGTH } from "./printing";

export function renderPrintingPaneHtml(): string {
  return `
      <div class="card" id="section-printing">
        <h2 class="card-title">Printing</h2>
        <p class="card-sub">Let people print the page they are on to your network printers. Off until you turn it on: workstations then run no print service at all, and the browser refuses to print.</p>
        <form id="form-printing">
          <div class="form-group">
            <label class="form-checkbox-label">
              <input type="checkbox" class="form-checkbox" id="printing-enabled">
              <span>Allow printing on workstations</span>
            </label>
            <p class="form-hint">When on, the kiosk bar shows a Print button and Ctrl+P prints. Pages print only to the printers listed here: saving as a PDF file stays off.</p>
          </div>

          <h3 class="card-subtitle mt-lg">Network printers</h3>
          <p class="form-hint">Printers that support driverless printing (IPP Everywhere or AirPrint), which most network printers sold since 2015 do. The address is the printer's IPP address, for example <span class="mono">ipps://printer.example.org/ipp/print</span> or <span class="mono">ipp://192.168.1.40/ipp/print</span>, with a host name your network's DNS resolves or a private IP address. Each workstation checks the printer when it sets it up.</p>
          <div id="printer-rows"></div>
          <p class="form-hint" id="printer-empty">No printers yet.</p>
          <div class="form-actions">
            <button type="button" class="btn btn-secondary" id="btn-printer-add">Add printer</button>
            <span class="form-hint" id="printer-count"></span>
          </div>
          <div class="form-actions mt-lg">
            <button type="submit" class="btn btn-primary">Save printing settings</button>
          </div>
        </form>
      </div>
  `;
}

export function renderPrintingScript(nonce: string): string {
  return `
    <script nonce="${escapeAttr(nonce)}">
${WHEN_PANE_SHOWN_JS}
      (function () {
        const form = document.getElementById("form-printing");
        if (!form) return;
        const enabledBox = document.getElementById("printing-enabled");
        const rows = document.getElementById("printer-rows");
        const empty = document.getElementById("printer-empty");
        const count = document.getElementById("printer-count");
        const addButton = document.getElementById("btn-printer-add");
        const MAX_PRINTERS = ${MAX_PRINTERS};
        let groups = [];
        let serial = 0;

        function field(labelText, control) {
          const group = document.createElement("div");
          group.className = "form-group";
          const label = document.createElement("label");
          label.className = "form-label";
          label.htmlFor = control.id;
          label.textContent = labelText;
          group.append(label, control);
          return group;
        }

        function refreshCount() {
          const n = rows.children.length;
          empty.classList.toggle("hidden", n > 0);
          count.textContent = n + " of " + MAX_PRINTERS + " printers";
          addButton.disabled = n >= MAX_PRINTERS;
        }

        function addRow(printer) {
          const n = ++serial;
          const row = document.createElement("div");
          row.className = "form-row printer-row";
          row.dataset.printerId = printer && printer.id ? printer.id : "";

          const name = document.createElement("input");
          name.type = "text";
          name.className = "form-input";
          name.id = "printer-name-" + n;
          name.maxLength = ${MAX_PRINTER_NAME_LENGTH};
          name.required = true;
          name.placeholder = "Library, ground floor";
          name.value = printer ? printer.name : "";
          name.dataset.printerField = "name";

          const uri = document.createElement("input");
          uri.type = "text";
          uri.className = "form-input mono";
          uri.id = "printer-uri-" + n;
          uri.maxLength = ${MAX_PRINTER_URI_LENGTH};
          uri.required = true;
          uri.spellcheck = false;
          uri.autocapitalize = "off";
          uri.placeholder = "ipps://printer.example.org/ipp/print";
          uri.pattern = "ipps?://.+";
          uri.value = printer ? printer.uri : "";
          uri.dataset.printerField = "uri";

          const group = document.createElement("select");
          group.className = "form-select";
          group.id = "printer-group-" + n;
          group.dataset.printerField = "group";
          group.append(new Option("Every workstation", ""));
          for (const g of groups) group.append(new Option(g, g));
          if (printer && printer.groupName) {
            if (!groups.includes(printer.groupName)) {
              // Its group was deleted: no workstation is in it, so none prints to it.
              group.append(new Option(printer.groupName + " (group deleted)", printer.groupName));
            }
            group.value = printer.groupName;
          }

          const remove = document.createElement("button");
          remove.type = "button";
          remove.className = "btn btn-ghost btn-sm";
          remove.textContent = "Remove";
          remove.setAttribute("aria-label", "Remove printer");
          remove.addEventListener("click", () => {
            row.remove();
            refreshCount();
          });
          const actions = document.createElement("div");
          actions.className = "form-group printer-row-actions";
          actions.append(remove);

          row.append(field("Name", name), field("IPP address", uri), field("Workstations", group), actions);
          rows.append(row);
          refreshCount();
          return row;
        }

        function show(data) {
          groups = Array.isArray(data.groups) ? data.groups : [];
          enabledBox.checked = data.enabled === true;
          rows.replaceChildren();
          for (const printer of Array.isArray(data.printers) ? data.printers : []) addRow(printer);
          refreshCount();
        }

        function collect() {
          return Array.from(rows.children).map((row) => {
            const value = (key) => row.querySelector('[data-printer-field="' + key + '"]').value.trim();
            return {
              id: row.dataset.printerId || undefined,
              name: value("name"),
              uri: value("uri"),
              groupName: value("group") || null
            };
          });
        }

        async function load() {
          try {
            const res = await fetch(labkioskApi("/api/settings/printing"));
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
            show(data);
          } catch (err) {
            empty.textContent = "Could not load the printing settings: " + err.message;
            empty.classList.remove("hidden");
          }
        }

        addButton.addEventListener("click", () => {
          if (rows.children.length >= MAX_PRINTERS) return;
          const row = addRow(null);
          const first = row.querySelector("input");
          if (first) first.focus();
        });

        form.addEventListener("submit", async (event) => {
          event.preventDefault();
          try {
            const res = await fetch(labkioskApi("/api/settings/printing"), {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ enabled: enabledBox.checked, printers: collect() })
            });
            const data = await res.json();
            if (!res.ok) {
              lkToast(data.error || "The printing settings could not be saved", "error");
              return;
            }
            show(data);
            lkToast(data.enabled ? "Printing is on. Workstations set up the printers within a minute." : "Printing is off.", "success");
          } catch (err) {
            lkToast("Network error: " + err.message, "error");
          }
        });

        whenPaneShown(form, load);
      })();
    </script>`;
}
