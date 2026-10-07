/**
 * Tasks and Support in the Super Admin console: a list of conversations, oldest
 * open item first, beside the one that is open -- the full request, every
 * message sent and received, and the reply box.
 *
 * Everything the list and the conversation show is data a stranger typed
 * (an organization name, an email body), so the client script builds DOM nodes
 * and assigns textContent only (Rule 4). Every control is wired here (Rule 5d).
 */

import { escapeAttr, escapeJson } from "./escape";

export type InboxBox = "tasks" | "support";

export function renderInboxPaneHtml(box: InboxBox): string {
  const label = box === "tasks" ? "Tasks" : "Support conversations";
  const placeholder =
    box === "tasks"
      ? "Select a task to see the full request and decide it."
      : "Select a conversation to read it and reply.";
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

/** The Level 2 panel for Tasks and Support: the filter, wired by the inbox script. */
export function renderInboxSubPanelHtml(box: InboxBox, counts: { open: number; unread?: number }): string {
  return `
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
            : "Mail sent to the support address and the website's contact form. Replies are emailed from here, and the customer's answers come back into the same conversation."
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

        var KIND_LABELS = { signup: "Registration", remote_control: "Remote Control", support: "Support" };
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
            var data = await api("/api/super/inbox?" + new URLSearchParams({ box: BOX, filter: filter }).toString());
            var items = Array.isArray(data.items) ? data.items : [];
            listEl.replaceChildren();
            if (!items.length) {
              emptyList(filter === "open" ? (BOX === "tasks" ? "No open tasks." : "No open conversations.") : "Nothing here.");
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
                el("span", null, KIND_LABELS[item.kind] || item.kind),
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
          var label = el("label", "form-label", c.kind === "support" ? "Message to " + c.contact_email : "Message to " + c.contact_email + " (also added to an approval or rejection email)");
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
