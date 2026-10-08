/**
 * Tasks and Mail in the Super Admin console: a list of conversations, oldest
 * open item first, beside the one that is open -- the full request, every
 * message sent and received with its attachments, and the reply box. Mail is
 * grouped by the platform address it was sent to, and new mail is written here.
 *
 * Everything the list and the conversation show is data a stranger typed
 * (an organization name, an email body), so the client script builds DOM nodes
 * and assigns textContent only (Rule 4). Every control is wired here (Rule 5d).
 */

import { escapeAttr, escapeJson } from "./escape";

export type InboxBox = "tasks" | "support";

export function renderInboxPaneHtml(box: InboxBox): string {
  const label = box === "tasks" ? "Tasks" : "Mail";
  const placeholder =
    box === "tasks"
      ? "Select a task to see the full request and decide it."
      : "Select a message to read it and reply, or write a new one.";
  return `
      <div class="inbox-layout" id="inbox" data-box="${escapeAttr(box)}">
        <div class="inbox-list" id="inbox-list" role="list" aria-label="${escapeAttr(label)}">
          <div class="inbox-empty">Loading…</div>
        </div>
        <div class="inbox-detail" id="inbox-detail" aria-live="polite">
          <div class="card"><p class="empty-note">${placeholder}</p></div>
        </div>
      </div>
  `;
}

/** The Level 2 panel for Tasks and Mail: mailboxes and the filter, wired by the inbox script. */
export function renderInboxSubPanelHtml(box: InboxBox, counts: { open: number; unread?: number }): string {
  const mail =
    box === "support"
      ? `
      <div class="sub-action-list">
        <button type="button" class="sub-action-item" id="inbox-compose">
          <span>New message</span>
        </button>
      </div>
      <div class="sub-section-title">Mailboxes</div>
      <div class="sub-action-list" id="inbox-mailboxes">
        <button type="button" class="sub-action-item active" data-inbox-mailbox="">
          <span>All mail</span>
        </button>
      </div>`
      : "";
  return `${mail}
      <div class="sub-section-title">Show</div>
      <div class="sub-action-list">
        <button type="button" class="sub-action-item active" data-inbox-filter="open">
          <span>Open</span><span class="sub-action-badge">${Number(counts.open) || 0}</span>
        </button>
        <button type="button" class="sub-action-item" data-inbox-filter="closed">
          <span>${box === "tasks" ? "Decided" : "Closed"}</span>
        </button>
        <button type="button" class="sub-action-item" data-inbox-filter="all">
          <span>Everything</span>
        </button>
      </div>
      <div class="sub-section-title">How this works</div>
      <div class="panel-note">
        ${
          box === "tasks"
            ? "Registrations and Remote Control requests, oldest first. Approving or rejecting emails the customer; a reply asks them something first, such as payment. Confirm a registration's phone number before approving it."
            : "Mail sent to any address on the mail domain, and the website's contact form, grouped by the address it was sent to. Replies go out as that address, and answers come back into the same conversation. Attachments are kept with the original message."
        }
      </div>
  `;
}

export function renderInboxScript(nonce: string, box: InboxBox, baseDomain: string): string {
  return `
    <script nonce="${escapeAttr(nonce)}">
      (function () {
        var BOX = ${escapeJson(box)};
        var BASE_DOMAIN = ${escapeJson(baseDomain)};
        var listEl = document.getElementById("inbox-list");
        var detailEl = document.getElementById("inbox-detail");
        if (!listEl || !detailEl) return;
        var filter = "open";
        var selectedId = new URLSearchParams(window.location.search).get("id");

        var mailbox = BOX === "support" ? (new URLSearchParams(window.location.search).get("mailbox") || "") : "";
        var mailDomain = "";

        var KIND_LABELS = { signup: "Registration", remote_control: "Remote Control", support: "Mail" };
        var STATUS_BADGES = { open: "badge-yellow", approved: "badge-green", rejected: "badge-red", closed: "badge-neutral" };

        function el(tag, className, text) {
          var node = document.createElement(tag);
          if (className) node.className = className;
          if (text !== undefined && text !== null) node.textContent = String(text);
          return node;
        }

        function badge(text, tone) {
          return el("span", "badge " + tone, text);
        }

        function when(seconds) {
          var date = new Date(Number(seconds) * 1000);
          if (isNaN(date.getTime())) return "—";
          var pad = function (n) { return String(n).padStart(2, "0"); };
          return date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) + " " + pad(date.getHours()) + ":" + pad(date.getMinutes());
        }

        async function api(path, body) {
          var init = body === undefined ? {} : { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
          var res = await fetch(path, init);
          var data = null;
          try { data = await res.json(); } catch (err) { data = null; }
          if (!res.ok) throw new Error((data && data.error) || ("The server answered " + res.status));
          return data;
        }

        function emptyList(text) {
          listEl.replaceChildren(el("div", "inbox-empty", text));
        }

        async function loadList() {
          try {
            var query = { box: BOX, filter: filter };
            if (BOX === "support" && mailbox) query.mailbox = mailbox;
            var data = await api("/api/super/inbox?" + new URLSearchParams(query).toString());
            var items = Array.isArray(data.items) ? data.items : [];
            if (BOX === "support") {
              mailDomain = data.mailDomain || "";
              renderMailboxes(Array.isArray(data.mailboxes) ? data.mailboxes : []);
            }
            listEl.replaceChildren();
            if (!items.length) {
              emptyList(filter === "open" ? (BOX === "tasks" ? "No open tasks." : "No open mail.") : "Nothing here.");
              return;
            }
            items.forEach(function (item) {
              var row = el("button", "inbox-item" + (item.unread ? " inbox-item-unread" : ""));
              row.type = "button";
              row.setAttribute("role", "listitem");
              row.dataset.id = item.id;
              if (item.id === selectedId) row.setAttribute("aria-current", "true");
              var head = el("div", "inbox-item-head");
              head.append(
                el("span", "inbox-item-title", item.organization_name || item.subject),
                badge(item.status, STATUS_BADGES[item.status] || "badge-neutral")
              );
              var meta = el("div", "inbox-item-meta");
              meta.append(
                el("span", "truncate", item.kind === "support" ? (item.mailbox || "Mail") : (KIND_LABELS[item.kind] || item.kind)),
                el("span", "mono", item.reference),
                el("span", null, when(item.status === "open" ? item.created_at : item.last_message_at))
              );
              var who = el("div", "inbox-item-meta");
              who.append(el("span", "truncate", item.contact_email), el("span", null, item.message_count + " message" + (item.message_count === 1 ? "" : "s")));
              row.append(head, meta, who);
              row.addEventListener("click", function () { openItem(item.id); });
              listEl.appendChild(row);
            });
          } catch (err) {
            emptyList("Could not load: " + err.message);
          }
        }

        function definition(list, term, value, extra) {
          list.append(el("dt", null, term));
          var dd = el("dd", null, value === null || value === undefined || value === "" ? "—" : value);
          if (extra) dd.append(" ", extra);
          list.append(dd);
        }

        function organizationCard(data) {
          var card = el("div", "card");
          card.append(el("h2", "card-title", "Request details"));
          var list = el("dl", "detail-grid mt-md");
          var org = data.organization;
          var p = data.profile;
          if (org) {
            definition(list, "Organization", org.name);
            definition(list, "Console address", org.subdomain + "." + BASE_DOMAIN);
            definition(list, "Account", org.status);
            definition(list, "Remote Control", org.remoteControlStatus);
          }
          if (p) {
            definition(list, "Legal / billing name", p.legal_name);
            definition(list, "Type", p.organization_type);
            definition(list, "Technical contact", p.contact_name);
            definition(list, "Email", p.contact_email, p.email_verified_at ? badge("verified", "badge-green") : badge("not verified", "badge-red"));
            var phoneState = p.phone_verified_at ? badge("verified", "badge-green") : badge("not verified", "badge-yellow");
            definition(list, "Phone", p.contact_phone, phoneState);
            definition(list, "Postal address", [p.address_line1, p.address_line2, p.city, p.region, p.postal_code, p.country].filter(Boolean).join(", "));
            definition(list, "Tax ID", p.tax_id);
            definition(list, "Billing email", p.billing_email);
            definition(list, "Expected workstations", p.workstation_estimate);
            if (p.notes) definition(list, "Notes", p.notes);
          }
          card.append(list);
          if (p && !p.phone_verified_at && data.conversation.kind === "signup" && data.conversation.status === "open") {
            var actions = el("div", "form-actions mt-md");
            var verify = el("button", "btn btn-sm btn-secondary", "Mark phone as verified");
            verify.type = "button";
            verify.addEventListener("click", async function () {
              var ok = await lkConfirm({
                title: "Phone number confirmed?",
                message: "Only mark it after you have spoken to or exchanged messages with " + p.contact_name + " on " + p.contact_phone + ".",
                confirmLabel: "Mark verified"
              });
              if (!ok) return;
              await act(data.conversation.id, "verify-phone", {}, "Phone number marked as verified.");
            });
            actions.append(verify);
            card.append(actions);
          }
          return card;
        }

        function threadCard(data) {
          var card = el("div", "card");
          card.append(el("h2", "card-title", "Conversation"));
          var thread = el("div", "msg-thread mt-md");
          var labels = { inbound: "From ", outbound: "Sent to ", note: "Note by ", event: "" };
          (data.messages || []).forEach(function (m) {
            var item = el("div", "msg msg-" + m.direction);
            var meta = el("div", "msg-meta");
            var who = m.direction === "inbound" ? (m.from_address || "") :
              m.direction === "outbound" ? (m.to_address || "") :
              m.direction === "note" ? (m.author_name || "Platform") : (m.author_name || "System");
            var left = el("span", null, (labels[m.direction] || "") + who);
            var right = el("span", null, when(m.created_at));
            meta.append(left);
            if (m.delivery === "failed") meta.append(badge("not delivered", "badge-red"));
            meta.append(right);
            item.append(meta);
            if (m.subject && m.direction !== "event" && m.direction !== "note") item.append(el("div", "text-xs text-muted mb-sm", m.subject));
            item.append(el("pre", "msg-body", m.body));
            if (m.raw_key) item.append(attachmentLinks(data.conversation.id, m));
            thread.append(item);
          });
          if (!thread.children.length) thread.append(el("p", "empty-note", "No messages yet."));
          card.append(thread);
          return card;
        }

        function composeCard(data) {
          var c = data.conversation;
          var card = el("div", "card");
          card.append(el("h2", "card-title", c.kind === "support" ? "Reply" : "Reply or decide"));
          if (data.mailProblem) {
            var warn = el("div", "callout callout-warning mt-md");
            warn.append(el("div", null, data.mailProblem));
            card.append(warn);
          }
          var group = el("div", "form-group mt-md");
          var label = el("label", "form-label", c.kind === "support"
            ? (c.mailbox ? "Reply as " + c.mailbox + " to " + c.contact_email : "Message to " + c.contact_email)
            : "Message to " + c.contact_email + " (also added to an approval or rejection email)");
          label.htmlFor = "inbox-message";
          var area = el("textarea", "form-textarea");
          area.id = "inbox-message";
          area.rows = 6;
          area.maxLength = 20000;
          group.append(label, area);
          card.append(group);

          var actions = el("div", "form-actions");
          function button(text, tone, handler) {
            var b = el("button", "btn btn-sm " + tone, text);
            b.type = "button";
            b.addEventListener("click", handler);
            actions.append(b);
            return b;
          }
          function message() { return area.value.trim(); }

          button("Send email", "btn-primary", async function () {
            if (!message()) { lkToast("Write the message first.", "error"); return; }
            await act(c.id, "reply", { message: message() }, "Email sent.");
          });
          if (c.kind === "support") {
            if (c.status === "open") {
              button("Send and close", "btn-secondary", async function () {
                if (!message()) { lkToast("Write the message first.", "error"); return; }
                await act(c.id, "reply", { message: message(), close: true }, "Email sent and conversation closed.");
              });
              button("Close without reply", "btn-ghost", async function () {
                await act(c.id, "status", { status: "closed" }, "Conversation closed.");
              });
            } else {
              button("Reopen", "btn-ghost", async function () {
                await act(c.id, "status", { status: "open" }, "Conversation reopened.");
              });
            }
          }
          button("Add internal note", "btn-ghost", async function () {
            if (!message()) { lkToast("Write the note first.", "error"); return; }
            await act(c.id, "note", { message: message() }, "Note added.");
          });
          if (c.kind === "support") {
            actions.append(el("span", "toolbar-spacer"));
            button("Delete", "btn-danger", async function () {
              var ok = await lkConfirm({
                title: "Delete this conversation?",
                message: "Every message in it, its attachments and the stored originals are removed for good.",
                confirmLabel: "Delete",
                tone: "danger"
              });
              if (!ok) return;
              try {
                await api("/api/super/inbox/" + encodeURIComponent(c.id) + "/delete", {});
                lkToast("Conversation deleted.", "success");
                clearSelection();
              } catch (err) {
                lkToast(err.message, "error");
              }
              await loadList();
            });
          }

          if (c.kind !== "support" && c.status === "open") {
            var spacer = el("span", "toolbar-spacer");
            actions.append(spacer);
            var needsPhone = c.kind === "signup" && !(data.profile && data.profile.phone_verified_at);
            var approve = button(c.kind === "signup" ? "Approve account" : "Approve Remote Control", "btn-success", async function () {
              var ok = await lkConfirm({
                title: c.kind === "signup" ? "Activate " + (data.organization ? data.organization.name : "this organization") + "?" : "Turn on Remote Control?",
                message: c.kind === "signup"
                  ? "The console goes live and " + c.contact_email + " is emailed the sign-in address. Any message above is included."
                  : "Operators in this organization can open Remote Control straight away, and " + c.contact_email + " is emailed. Any message above is included.",
                confirmLabel: "Approve"
              });
              if (!ok) return;
              await act(c.id, "approve", { message: message() }, "Approved and emailed.");
            });
            if (needsPhone) {
              approve.disabled = true;
              approve.title = "Mark the phone number as verified first";
            }
            button("Reject", "btn-danger", async function () {
              var ok = await lkConfirm({
                title: "Reject this request?",
                message: c.contact_email + " is emailed that it was not approved. Any message above is included as the reason.",
                confirmLabel: "Reject",
                tone: "danger"
              });
              if (!ok) return;
              await act(c.id, "reject", { message: message() }, "Rejected and emailed.");
            });
          }
          card.append(actions);
          if (c.kind === "signup" && c.status === "open" && !(data.profile && data.profile.phone_verified_at)) {
            card.append(el("p", "form-hint mt-sm", "Approval is available once the phone number has been confirmed."));
          }
          return card;
        }

        function renderDetail(data) {
          var c = data.conversation;
          var head = el("div", "card");
          var title = el("div", "row-between");
          var left = el("div", "stack-sm");
          left.append(el("h2", "card-title", c.subject));
          var meta = el("div", "row");
          meta.append(
            badge(KIND_LABELS[c.kind] || c.kind, "badge-blue"),
            badge(c.status, STATUS_BADGES[c.status] || "badge-neutral"),
            el("span", "mono text-xs", c.reference),
            el("span", "text-xs text-muted", "opened " + when(c.created_at))
          );
          left.append(meta);
          title.append(left);
          head.append(title);
          var cards = [head];
          if (c.kind !== "support") cards.push(organizationCard(data));
          cards.push(threadCard(data), composeCard(data));
          detailEl.replaceChildren.apply(detailEl, cards);
        }

        async function openItem(id) {
          selectedId = id;
          listEl.querySelectorAll(".inbox-item").forEach(function (row) {
            if (row.dataset.id === id) row.setAttribute("aria-current", "true");
            else row.removeAttribute("aria-current");
          });
          var params = new URLSearchParams(window.location.search);
          params.set("id", id);
          history.replaceState(null, "", window.location.pathname + "?" + params.toString());
          try {
            renderDetail(await api("/api/super/inbox/" + encodeURIComponent(id)));
            var row = listEl.querySelector('.inbox-item[data-id="' + CSS.escape(id) + '"]');
            if (row) row.classList.remove("inbox-item-unread");
          } catch (err) {
            detailEl.replaceChildren(el("div", "card", "Could not open it: " + err.message));
          }
        }

        async function act(id, action, body, success) {
          try {
            await api("/api/super/inbox/" + encodeURIComponent(id) + "/" + action, body);
            lkToast(success, "success");
          } catch (err) {
            lkToast(err.message, "error");
          }
          await loadList();
          await openItem(id);
        }

        function setParam(name, value) {
          var params = new URLSearchParams(window.location.search);
          if (value) params.set(name, value);
          else params.delete(name);
          var search = params.toString();
          history.replaceState(null, "", window.location.pathname + (search ? "?" + search : ""));
        }

        function clearSelection() {
          selectedId = null;
          setParam("id", "");
          var card = el("div", "card");
          card.append(el("p", "empty-note", BOX === "tasks" ? "Select a task to see the full request and decide it." : "Select a message to read it and reply, or write a new one."));
          detailEl.replaceChildren(card);
        }

        function kb(bytes) {
          var n = Number(bytes) || 0;
          return n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB";
        }

        function attachmentLinks(conversationId, m) {
          var box = el("div", "msg-attachments");
          var base = "/api/super/inbox/" + encodeURIComponent(conversationId) + "/attachment/" + encodeURIComponent(m.id) + "/";
          var list = [];
          try { list = m.attachments ? JSON.parse(m.attachments) : []; } catch (err) { list = []; }
          (Array.isArray(list) ? list : []).forEach(function (a) {
            var link = el("a", "msg-attachment", a.filename + " (" + kb(a.size) + ")");
            link.href = base + encodeURIComponent(String(a.index));
            link.setAttribute("download", "");
            link.title = "Download " + a.filename + (a.contentType ? " (" + a.contentType + ")" : "");
            box.append(link);
          });
          var original = el("a", "msg-attachment", "Original message (.eml)");
          original.href = base + "original";
          original.setAttribute("download", "");
          box.append(original);
          return box;
        }

        function renderMailboxes(list) {
          var container = document.getElementById("inbox-mailboxes");
          if (!container) return;
          var all = el("button", "sub-action-item" + (mailbox ? "" : " active"));
          all.type = "button";
          all.dataset.inboxMailbox = "";
          all.append(el("span", null, "All mail"));
          var rows = [all];
          var known = false;
          list.forEach(function (box) {
            var row = el("button", "sub-action-item" + (box.mailbox === mailbox ? " active" : ""));
            row.type = "button";
            row.dataset.inboxMailbox = box.mailbox;
            row.title = box.total + " conversation" + (box.total === 1 ? "" : "s") + ", " + box.open + " open";
            row.append(el("span", "truncate", box.mailbox));
            if (box.unread > 0) row.append(el("span", "sub-action-badge", box.unread));
            if (box.mailbox === mailbox) known = true;
            rows.push(row);
          });
          if (mailbox && !known) {
            var current = el("button", "sub-action-item active");
            current.type = "button";
            current.dataset.inboxMailbox = mailbox;
            current.append(el("span", "truncate", mailbox));
            rows.push(current);
          }
          container.replaceChildren.apply(container, rows);
        }

        function field(labelText, input, hint) {
          var group = el("div", "form-group");
          var label = el("label", "form-label", labelText);
          label.htmlFor = input.id;
          group.append(label, input);
          if (hint) group.append(el("p", "form-hint", hint));
          return group;
        }

        function textInput(id, value, placeholder) {
          var input = el("input", "form-input");
          input.id = id;
          input.type = "text";
          input.value = value || "";
          if (placeholder) input.placeholder = placeholder;
          return input;
        }

        function openCompose() {
          clearSelection();
          listEl.querySelectorAll(".inbox-item").forEach(function (row) { row.removeAttribute("aria-current"); });
          var card = el("div", "card");
          card.append(el("h2", "card-title", "New message"));
          var fromInput = textInput("compose-from", mailbox ? mailbox.split("@")[0] : "support", "support");
          fromInput.autocomplete = "off";
          fromInput.maxLength = 64;
          var fromRow = el("div", "form-row mt-md mb-md");
          var fromGroup = field("From", fromInput);
          fromRow.append(fromGroup, el("span", "input-suffix", "@" + (mailDomain || "…")));
          var toInput = textInput("compose-to", "", "name@example.com");
          toInput.type = "email";
          toInput.autocomplete = "off";
          toInput.maxLength = 254;
          var subjectInput = textInput("compose-subject", "", "");
          subjectInput.maxLength = 200;
          var bodyInput = el("textarea", "form-textarea");
          bodyInput.id = "compose-message";
          bodyInput.rows = 10;
          bodyInput.maxLength = 20000;
          card.append(
            fromRow,
            field("To", toInput),
            field("Subject", subjectInput),
            field("Message", bodyInput, "Sent as plain text. Answers come back into this conversation.")
          );
          var actions = el("div", "form-actions");
          var send = el("button", "btn btn-sm btn-primary", "Send email");
          send.type = "button";
          send.addEventListener("click", async function () {
            send.disabled = true;
            try {
              var result = await api("/api/super/inbox/compose", {
                from: fromInput.value.trim(),
                to: toInput.value.trim(),
                subject: subjectInput.value.trim(),
                message: bodyInput.value.trim()
              });
              lkToast("Email sent.", "success");
              await loadList();
              await openItem(result.id);
            } catch (err) {
              lkToast(err.message, "error");
              send.disabled = false;
            }
          });
          var cancel = el("button", "btn btn-sm btn-ghost", "Cancel");
          cancel.type = "button";
          cancel.addEventListener("click", clearSelection);
          actions.append(send, cancel);
          card.append(actions);
          detailEl.replaceChildren(card);
          (mailbox ? toInput : fromInput).focus();
        }

        var composeButton = document.getElementById("inbox-compose");
        if (composeButton) composeButton.addEventListener("click", openCompose);

        var mailboxList = document.getElementById("inbox-mailboxes");
        if (mailboxList) {
          mailboxList.addEventListener("click", function (event) {
            var target = event.target instanceof Element ? event.target.closest("[data-inbox-mailbox]") : null;
            if (!target) return;
            mailbox = target.dataset.inboxMailbox || "";
            setParam("mailbox", mailbox);
            mailboxList.querySelectorAll("[data-inbox-mailbox]").forEach(function (b) {
              b.classList.toggle("active", b === target);
            });
            loadList();
          });
        }

        document.querySelectorAll("[data-inbox-filter]").forEach(function (button) {
          button.addEventListener("click", function () {
            filter = button.dataset.inboxFilter;
            document.querySelectorAll("[data-inbox-filter]").forEach(function (b) {
              b.classList.toggle("active", b === button);
            });
            loadList();
          });
        });

        loadList().then(function () { if (selectedId) openItem(selectedId); });
      })();
    </script>
  `;
}
