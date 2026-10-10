/**
 * Tasks and Mail in the Super Admin console: a list of conversations, oldest
 * open item first, beside the one that is open -- the full request, every
 * message sent and received with its attachments, and the reply box. Mail is
 * grouped by the platform address it was sent to and split into folders
 * (Inbox, Unread, Read, Closed, Deleted), and new mail is written here. Both
 * tabs filter by type: what a conversation is about, which is also the prefix
 * of its tracking id (`CATEGORIES` in src/conversations.ts).
 *
 * Everything the list and the conversation show is data a stranger typed
 * (an organization name, an email body), so the client script builds DOM nodes
 * and assigns textContent only (Rule 4). Every control is wired here (Rule 5d).
 */

import { escapeAttr, escapeJson } from "./escape";
import { CATEGORIES } from "./conversations";

export type InboxBox = "tasks" | "support";

export function renderInboxPaneHtml(box: InboxBox, counts: InboxViewCounts): string {
  const label = box === "tasks" ? "Tasks" : "Mail";
  const placeholder =
    box === "tasks"
      ? "Select a task to see the full request and decide it."
      : "Select a message to read it and reply, or write a new one.";
  return `${renderInboxFiltersHtml(box, counts)}
      <div class="inbox-layout" id="inbox" data-box="${escapeAttr(box)}">
        <div class="inbox-list" id="inbox-list" role="list" aria-label="${escapeAttr(label)}">
          <div class="inbox-empty">Loading…</div>
        </div>
        <div class="inbox-detail" id="inbox-detail" aria-live="polite">
          <div class="card"><p class="empty-note">${placeholder}</p></div>
        </div>
      </div>
      <p class="panel-note mt-md">${
        box === "tasks"
          ? "Registrations and Remote Control requests, oldest first. Approving or rejecting emails the customer; a reply asks them something first, such as payment. Confirm a registration's phone number before approving it. A tracking ID starts with REG for a registration and RMT for Remote Control."
          : "Mail sent to any address on the mail domain, and the website's contact form, grouped by the address it was sent to. Replies go out as that address, and answers come back into the same conversation. The start of a tracking ID says what the mail is about (SUP support, SAL sales, BIL billing, LGL legal, GEN general, LTR a letter you wrote). Deleted mail stays in Deleted until it is restored or deleted for good."
      }</p>
  `;
}

/** What the console shows of the inbox counts (`inboxCounts()` in src/conversations.ts). */
export interface InboxViewCounts {
  open: number;
  unread?: number;
  deleted?: number;
}

/** Mail's folders, in the order the view tabs list them. `id` is the API's `filter`. */
const MAIL_FOLDERS: ReadonlyArray<{ id: string; label: string; count?: keyof InboxViewCounts }> = [
  { id: "open", label: "Inbox", count: "open" },
  { id: "unread", label: "Unread", count: "unread" },
  { id: "read", label: "Read" },
  { id: "closed", label: "Closed" },
  { id: "deleted", label: "Deleted", count: "deleted" }
];

const COMPOSE_ICON = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>`;

function folderCount(counts: InboxViewCounts, key?: keyof InboxViewCounts): number {
  return key ? Math.max(0, Math.floor(Number(counts[key]) || 0)) : 0;
}

/** Mail's view tabs (its folders) and the New message button, above the list. Wired by the inbox script. */
export function renderMailViewBarHtml(counts: InboxViewCounts): string {
  const tabs = MAIL_FOLDERS.map((folder, index) => {
    const n = folderCount(counts, folder.count);
    return `
        <button type="button" class="segmented-tab${index === 0 ? " active" : ""}" data-inbox-filter="${escapeAttr(folder.id)}">
          <span>${folder.label}</span>${n > 0 ? `<span class="chip-badge">${n}</span>` : ""}
        </button>`;
  }).join("");
  return `
    <div class="view-bar">
      <nav class="segmented-nav" aria-label="Mail folders">${tabs}
      </nav>
      <button type="button" class="btn btn-secondary" data-inbox-compose>
        ${COMPOSE_ICON}
        <span>New message</span>
      </button>
    </div>
  `;
}

/** What narrows the list, above it: the view (Tasks), the type and the mailbox (Mail). Wired by the inbox script. */
function renderInboxFiltersHtml(box: InboxBox, counts: InboxViewCounts): string {
  const typeRow = `
      <div class="chip-row">
        <span class="chip-row-label">Type</span>
        <div class="filter-chips" id="inbox-categories">
          <button type="button" class="filter-chip active" data-inbox-category=""><span>All types</span></button>
        </div>
      </div>`;
  if (box === "support") {
    return `${typeRow}
      <div class="chip-row">
        <span class="chip-row-label">Mailbox</span>
        <div class="filter-chips" id="inbox-mailboxes">
          <button type="button" class="filter-chip active" data-inbox-mailbox=""><span>All mailboxes</span></button>
        </div>
      </div>`;
  }
  const open = folderCount(counts, "open");
  return `
      <div class="chip-row">
        <span class="chip-row-label">Show</span>
        <div class="filter-chips">
          <button type="button" class="filter-chip active" data-inbox-filter="open">
            <span>Open</span>${open > 0 ? `<span class="chip-badge">${open}</span>` : ""}
          </button>
          <button type="button" class="filter-chip" data-inbox-filter="closed"><span>Decided</span></button>
          <button type="button" class="filter-chip" data-inbox-filter="all"><span>Everything</span></button>
        </div>
      </div>${typeRow}`;
}

/**
 * `otherTasks` counts what the Tasks rail badge shows besides open tasks (the
 * subdomain and custom domain requests), so the script can keep that badge
 * right as tasks are decided.
 */
export function renderInboxScript(nonce: string, box: InboxBox, baseDomain: string, otherTasks = 0): string {
  return `
    <script nonce="${escapeAttr(nonce)}">
      (function () {
        var BOX = ${escapeJson(box)};
        var BASE_DOMAIN = ${escapeJson(baseDomain)};
        var OTHER_TASKS = ${escapeJson(Math.max(0, Math.floor(Number(otherTasks) || 0)))};
        var listEl = document.getElementById("inbox-list");
        var detailEl = document.getElementById("inbox-detail");
        if (!listEl || !detailEl) return;
        var FILTERS = BOX === "support" ? ["open", "unread", "read", "closed", "deleted"] : ["open", "closed", "all"];
        var EMPTY_TEXT = BOX === "support"
          ? { open: "The inbox is empty.", unread: "No unread mail.", read: "No read mail.", closed: "No closed mail.", deleted: "Nothing in Deleted." }
          : { open: "No open tasks." };
        var filter = new URLSearchParams(window.location.search).get("view") || "open";
        if (FILTERS.indexOf(filter) < 0) filter = "open";
        var selectedId = new URLSearchParams(window.location.search).get("id");

        var mailbox = BOX === "support" ? (new URLSearchParams(window.location.search).get("mailbox") || "") : "";
        var mailDomain = "";
        var category = new URLSearchParams(window.location.search).get("type") || "";
        var CATEGORY_LABELS = ${escapeJson(Object.fromEntries(Object.entries(CATEGORIES).map(([id, c]) => [id, c.label])))};

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

        /** Set a count badge inside a node, or remove it at zero. */
        function setBadge(container, className, count) {
          if (!container) return;
          var current = container.querySelector("." + className.split(" ")[0]);
          var n = Math.max(0, Number(count) || 0);
          if (!n) {
            if (current) current.remove();
            return;
          }
          if (!current) {
            current = el("span", className);
            container.append(current);
          }
          current.textContent = String(n);
        }

        /** The rail badges and the Open count, from the counts every list answer carries. */
        function applyCounts(counts) {
          if (!counts) return;
          var tasks = (Number(counts.openTasks) || 0) + OTHER_TASKS;
          setBadge(document.querySelector('.rail-item[data-nav="tasks"]'), "rail-badge attention", tasks);
          var stat = document.getElementById("stat-tasks");
          if (stat) {
            stat.textContent = String(tasks);
            var dot = stat.parentElement ? stat.parentElement.querySelector(".stat-dot") : null;
            if (dot) {
              dot.classList.toggle("dot-yellow", tasks > 0);
              dot.classList.toggle("dot-blue", tasks === 0);
            }
          }
          setBadge(document.querySelector('.rail-item[data-nav="support"]'), "rail-badge attention", counts.unreadSupport);
          var byFilter = BOX === "tasks"
            ? { open: counts.openTasks }
            : { open: counts.openSupport, unread: counts.unreadSupport, deleted: counts.deletedSupport };
          document.querySelectorAll("[data-inbox-filter]").forEach(function (button) {
            var name = button.dataset.inboxFilter;
            if (!(name in byFilter)) return;
            setBadge(button, "chip-badge", byFilter[name]);
          });
          if (BOX === "tasks") {
            document.querySelectorAll('[data-action="tab-requests"]').forEach(function (button) {
              setBadge(button, "chip-badge", counts.openTasks);
            });
          }
        }

        /** Show which view is on. */
        function markFilter() {
          document.querySelectorAll("[data-inbox-filter]").forEach(function (button) {
            button.classList.toggle("active", button.dataset.inboxFilter === filter);
          });
        }

        /** What a conversation is about, as its type reads everywhere. */
        function typeLabel(c) {
          return CATEGORY_LABELS[c.category] || KIND_LABELS[c.kind] || c.kind;
        }

        function emptyList(text) {
          listEl.replaceChildren(el("div", "inbox-empty", text));
        }

        async function loadList() {
          try {
            var query = { box: BOX, filter: filter };
            if (BOX === "support" && mailbox) query.mailbox = mailbox;
            if (category) query.category = category;
            var data = await api("/api/super/inbox?" + new URLSearchParams(query).toString());
            var items = Array.isArray(data.items) ? data.items : [];
            applyCounts(data.counts);
            renderCategories(Array.isArray(data.categories) ? data.categories : []);
            if (BOX === "support") {
              mailDomain = data.mailDomain || "";
              renderMailboxes(Array.isArray(data.mailboxes) ? data.mailboxes : []);
            }
            listEl.replaceChildren();
            if (!items.length) {
              emptyList(EMPTY_TEXT[filter] || "Nothing here.");
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
                el("span", "truncate", typeLabel(item) + (item.kind === "support" && item.mailbox ? " \u00b7 " + item.mailbox : "")),
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

        /** A conversation in Deleted: it is restored or removed for good, not answered. */
        function deletedCard(c) {
          var card = el("div", "card");
          card.append(el("h2", "card-title", "In Deleted"));
          card.append(el("p", "card-sub", "Restore this conversation to reply to it. An answer from " + c.contact_email + " also brings it back."));
          var actions = el("div", "form-actions");
          var restore = el("button", "btn btn-sm btn-primary", "Restore");
          restore.type = "button";
          restore.addEventListener("click", async function () {
            await act(c.id, "restore", {}, "Conversation restored.");
          });
          var purge = el("button", "btn btn-sm btn-danger", "Delete permanently");
          purge.type = "button";
          purge.addEventListener("click", async function () {
            var ok = await lkConfirm({
              title: "Delete this conversation permanently?",
              message: "Every message in it, its attachments and the stored originals are removed for good.",
              confirmLabel: "Delete permanently",
              tone: "danger"
            });
            if (!ok) return;
            await leave(c.id, "delete", "Conversation deleted.");
          });
          actions.append(restore, el("span", "toolbar-spacer"), purge);
          card.append(actions);
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
            button("Mark as unread", "btn-ghost", async function () {
              await leave(c.id, "unread", "Marked as unread.");
            });
            actions.append(el("span", "toolbar-spacer"));
            button("Delete", "btn-danger", async function () {
              await leave(c.id, "trash", "Moved to Deleted.");
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
            badge(typeLabel(c), "badge-blue"),
            badge(c.status, STATUS_BADGES[c.status] || "badge-neutral"),
            el("span", "mono text-xs", c.reference),
            el("span", "text-xs text-muted", "opened " + when(c.created_at))
          );
          if (c.deleted_at) meta.append(badge("deleted", "badge-red"));
          left.append(meta);
          title.append(left);
          head.append(title);
          var cards = [head];
          if (c.kind !== "support") cards.push(organizationCard(data));
          cards.push(threadCard(data), c.deleted_at ? deletedCard(c) : composeCard(data));
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
          var row = listEl.querySelector('.inbox-item[data-id="' + CSS.escape(id) + '"]');
          var wasUnread = Boolean(row && row.classList.contains("inbox-item-unread"));
          try {
            renderDetail(await api("/api/super/inbox/" + encodeURIComponent(id)));
            // Opening marks it read: the list and the unread badges follow.
            if (wasUnread) await loadList();
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

        /** An action after which the conversation is no longer the one being read. */
        async function leave(id, action, success) {
          try {
            await api("/api/super/inbox/" + encodeURIComponent(id) + "/" + action, {});
            lkToast(success, "success");
            clearSelection();
          } catch (err) {
            lkToast(err.message, "error");
          }
          await loadList();
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

        /** The Type list: every type of this tab, with how many are open. */
        function renderCategories(list) {
          var container = document.getElementById("inbox-categories");
          if (!container) return;
          var all = el("button", "filter-chip" + (category ? "" : " active"));
          all.type = "button";
          all.dataset.inboxCategory = "";
          all.append(el("span", null, "All types"));
          var rows = [all];
          list.forEach(function (type) {
            var row = el("button", "filter-chip" + (type.id === category ? " active" : ""));
            row.type = "button";
            row.dataset.inboxCategory = type.id;
            row.title = type.prefix + "-\u2026: " + type.total + " conversation" + (type.total === 1 ? "" : "s") + ", " + type.open + " open";
            row.append(el("span", "truncate", type.label));
            if (type.open > 0) row.append(el("span", "chip-badge", type.open));
            rows.push(row);
          });
          container.replaceChildren.apply(container, rows);
        }

        function renderMailboxes(list) {
          var container = document.getElementById("inbox-mailboxes");
          if (!container) return;
          var all = el("button", "filter-chip" + (mailbox ? "" : " active"));
          all.type = "button";
          all.dataset.inboxMailbox = "";
          all.append(el("span", null, "All mailboxes"));
          var rows = [all];
          var known = false;
          list.forEach(function (box) {
            var row = el("button", "filter-chip" + (box.mailbox === mailbox ? " active" : ""));
            row.type = "button";
            row.dataset.inboxMailbox = box.mailbox;
            row.title = box.total + " conversation" + (box.total === 1 ? "" : "s") + ", " + box.open + " open";
            row.append(el("span", "truncate", box.mailbox));
            if (box.unread > 0) row.append(el("span", "chip-badge", box.unread));
            if (box.mailbox === mailbox) known = true;
            rows.push(row);
          });
          if (mailbox && !known) {
            var current = el("button", "filter-chip active");
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
          var formatInput = el("select", "form-select");
          formatInput.id = "compose-format";
          formatInput.append(new Option("Message", "message"), new Option("Formal letter", "letter"));
          var nameInput = textInput("compose-name", "", "Ms N. Okafor");
          nameInput.maxLength = 120;
          var organizationInput = textInput("compose-organization", "", "Northfield Learning Trust");
          organizationInput.maxLength = 160;
          var signatoryInput = textInput("compose-signatory", "", "Your full name");
          signatoryInput.maxLength = 120;
          try {
            // Remembered on this browser, so it is typed once.
            signatoryInput.value = localStorage.getItem("labkiosk-letter-signatory") || "";
          } catch (err) {
            signatoryInput.value = "";
          }
          var titleInput = textInput("compose-signatory-title", "", "Customer Accounts");
          titleInput.maxLength = 120;
          var letterFields = el("div", "hidden");
          letterFields.append(
            field("Addressed to", nameInput, "The person the letter is for, as it should read above the text."),
            field("Organization", organizationInput),
            field("Signed by", signatoryInput, "Your name as it should read at the end of the letter. Left empty, your account's name is used."),
            field("Your title", titleInput, "Shown under your name.")
          );
          formatInput.addEventListener("change", function () {
            letterFields.classList.toggle("hidden", formatInput.value !== "letter");
          });
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
            field("Format", formatInput, "A letter carries the date, who it is addressed to and your name, and gets an LTR tracking ID."),
            field("To", toInput),
            letterFields,
            field("Subject", subjectInput),
            field("Message", bodyInput, "Sent in the Lab Kiosk layout, with a plain text copy. Answers come back into this conversation.")
          );
          var actions = el("div", "form-actions");
          var send = el("button", "btn btn-sm btn-primary", "Send email");
          send.type = "button";
          send.addEventListener("click", async function () {
            send.disabled = true;
            try {
              var letter = formatInput.value === "letter";
              var recipient = toInput.value.trim();
              var recipientName = nameInput.value.replace(/[<>"]/g, "").trim();
              var result = await api("/api/super/inbox/compose", {
                from: fromInput.value.trim(),
                to: letter && recipientName ? recipientName + " <" + recipient + ">" : recipient,
                subject: subjectInput.value.trim(),
                message: bodyInput.value.trim(),
                format: letter ? "letter" : "message",
                organization: letter ? organizationInput.value.trim() : "",
                signatory: letter ? signatoryInput.value.trim() : "",
                signatoryTitle: letter ? titleInput.value.trim() : ""
              });
              if (letter && signatoryInput.value.trim()) {
                try {
                  localStorage.setItem("labkiosk-letter-signatory", signatoryInput.value.trim());
                } catch (err) {
                  // Private browsing: the name is simply typed again next time.
                }
              }
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

        document.querySelectorAll("[data-inbox-compose]").forEach(function (button) {
          button.addEventListener("click", openCompose);
        });

        var categoryList = document.getElementById("inbox-categories");
        if (categoryList) {
          categoryList.addEventListener("click", function (event) {
            var target = event.target instanceof Element ? event.target.closest("[data-inbox-category]") : null;
            if (!target) return;
            category = target.dataset.inboxCategory || "";
            setParam("type", category);
            categoryList.querySelectorAll("[data-inbox-category]").forEach(function (b) {
              b.classList.toggle("active", b === target);
            });
            if (BOX === "tasks" && window.labkioskSwitchTab) window.labkioskSwitchTab("requests");
            loadList();
          });
        }

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
            setParam("view", filter === "open" ? "" : filter);
            markFilter();
            // The filter is the request list's: show that list if another view of Tasks is open.
            if (BOX === "tasks" && window.labkioskSwitchTab) window.labkioskSwitchTab("requests");
            loadList();
          });
        });

        markFilter();
        loadList().then(function () { if (selectedId) openItem(selectedId); });
      })();
    </script>
  `;
}
