/**
 * Lab Kiosk Navigation Bar & Lockdown Content Script
 * Injected into top-level pages to provide locked navigation controls,
 * real-time telemetry indicators, fullscreen lock curtain and the on-screen
 * keyboard for touch workstations.
 */

/**
 * The last layer of the keyboard and mouse lockdown.
 *
 * Openbox binds nothing and the X keymap has had the F keys, the Super keys,
 * the menu key and the XF86 block removed (labkiosk-lock-keys), so most of what
 * follows should never arrive. This catches what does: a page's own shortcuts,
 * Chromium accelerators that are still reachable with Control or Alt, and the
 * context menu.
 *
 * Deliberately permissive about one thing: typing. Letters, digits,
 * punctuation, Backspace, Delete, Enter, Shift, Caps Lock, Tab, Escape and the
 * cursor keys all pass through, because a workstation that cannot fill in a
 * form is not locked down, it is broken.
 *
 * And deliberately permissive about one more: the clipboard, *only* on the
 * setup wizard. The enrolment key is a 20-character string an administrator
 * pastes from the dashboard, and taking Ctrl+V away there would make the one
 * screen that needs it unusable. Users never see that origin.
 */
/**
 * Printing, only while the organization allows it (Settings -> Printing) and
 * the agent reports that Chromium may print (status.printing). The bar's Print
 * button and Ctrl+P both end here, in the top frame, so the whole page is
 * printed and never one frame of it. Ctrl+P stays blocked by lockInput below
 * either way: Chromium's own shortcut is not what prints. Ctrl+Shift+P, the
 * system dialog's shortcut, is never let through.
 */
const kioskPrint = {
  enabled: false,
  print() {
    if (this.enabled && window.self === window.top) window.print();
  }
};

if (window.self === window.top) {
  // Ctrl+P pressed inside an iframe, relayed by background.js.
  chrome.runtime.onMessage.addListener((message, sender) => {
    if (message && sender.id === chrome.runtime.id && message.type === "labkiosk:print-request") {
      kioskPrint.print();
    }
    return false;
  });
}

(function lockInput() {
  const AGENT_ORIGIN = "http://127.0.0.1:8888";
  const CLIPBOARD_KEYS = new Set(["a", "c", "v", "x", "z", "y"]);

  // Keys that pass on their own, with no modifier.
  const ALLOWED_KEYS = new Set([
    "Backspace", "Delete", "Enter", "NumpadEnter", "Shift", "CapsLock", "Tab", "Escape",
    "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown",
    "Control", "Alt", "AltGraph", "NumLock", "Dead", "Process"
  ]);

  const isSetupPage = window.location.origin === AGENT_ORIGIN;

  function isTypedCharacter(event) {
    // A single printable character: "a", "7", "@". Dead keys and IME give
    // longer names, which fall through to the rules below.
    return typeof event.key === "string" && event.key.length === 1;
  }

  function permitted(event) {
    if (!event || typeof event.key !== "string") return false;
    if (typeof event.getModifierState === "function" && event.getModifierState("AltGraph")) {
      if (isTypedCharacter(event) || event.key === "Dead" || ALLOWED_KEYS.has(event.key)) {
        return true;
      }
    }
    const combination = event.ctrlKey || event.altKey || event.metaKey;
    if (combination) {
      // Shift is not a combination -- it is how capitals are typed.
      if (isSetupPage && event.ctrlKey && !event.altKey && !event.metaKey &&
          CLIPBOARD_KEYS.has(event.key.toLowerCase())) {
        return true;
      }
      return false;
    }
    if (ALLOWED_KEYS.has(event.key)) return true;
    if (isTypedCharacter(event)) return true;
    // Everything else: F keys, Meta, ContextMenu, PrintScreen, Insert, Pause,
    // and anything a keyboard invents that this list has never heard of.
    return false;
  }

  function isPrintShortcut(event) {
    return event.type === "keydown" && event.isTrusted && !event.repeat && event.ctrlKey &&
      !event.altKey && !event.metaKey && !event.shiftKey && event.key.toLowerCase() === "p";
  }

  function guard(event) {
    if (permitted(event)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    if (!isPrintShortcut(event)) return;
    if (window.self === window.top) {
      kioskPrint.print();
      return;
    }
    try {
      chrome.runtime.sendMessage({ type: "labkiosk:print-shortcut" }, () => {
        if (chrome.runtime.lastError) {
          console.warn("[LabKiosk] Ctrl+P not relayed to the page:", chrome.runtime.lastError.message);
        }
      });
    } catch (err) {
      // The extension was reloaded under this frame; its old script has no channel.
      console.warn("[LabKiosk] Ctrl+P not relayed to the page:", err);
    }
  }

  // Capture phase, so a page's own handler never runs either.
  for (const type of ["keydown", "keypress", "keyup"]) {
    window.addEventListener(type, guard, true);
  }

  // Right click, and the menu key that does the same thing.
  window.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
})();

/**
 * The on-screen keyboard's other half: in every frame, which text field has
 * the focus, and typing into it.
 *
 * The keyboard itself is drawn once, in the top frame (below). A field inside
 * an iframe belongs to that frame's own copy of this script, which reports its
 * focus through background.js (chrome.runtime -> chrome.tabs.sendMessage to
 * frame 0) and receives the typed keys the same way back, addressed by
 * frameId. Nothing here talks to the agent.
 *
 * Text goes in through document.execCommand("insertText") in the field's own
 * frame, the browser's own editing path for typed text: it keeps maxlength,
 * undo and the caret, it works in number and email fields (whose selection
 * APIs throw), and the page sees the same beforeinput/input events as from a
 * real key. Where the command is refused, input and textarea fall back to
 * setRangeText (or, for number and email, the value) plus an input event,
 * and contenteditable to a Range. Each key is framed by synthetic
 * keydown/keypress/keyup events with no Control, Alt or Meta, so the
 * lockdown above has nothing to block and no page shortcut is reachable from
 * here; a page that cancels the keydown cancels the key, as with a real one.
 */
const kioskTyping = (function onScreenKeyboardInput() {
  const isTop = window.self === window.top;
  const TEXT_INPUT_TYPES = new Set(["text", "search", "url", "tel", "email", "password", "number"]);
  // HTML gives selectionStart and setRangeText only to text, search, url, tel
  // and password; on these two they throw.
  const NO_SELECTION_TYPES = new Set(["email", "number"]);
  const IMPLICIT_SUBMISSION_BLOCKERS = new Set([
    "text", "search", "url", "tel", "email", "password", "date", "month", "week", "time",
    "datetime-local", "number"
  ]);
  const ACTION_KEYS = new Set(["Backspace", "Enter", "Tab", "ArrowLeft", "ArrowRight"]);
  const MAX_ACTION_TEXT = 8;
  // US layout: the unshifted character on the same key, its KeyboardEvent.code
  // and legacy keyCode, for the synthetic key events pages still listen to.
  const SHIFTED_TO_BASE = {
    "~": "`", "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7", "*": "8",
    "(": "9", ")": "0", "_": "-", "+": "=", "{": "[", "}": "]", "|": "\\", ":": ";", "\"": "'",
    "<": ",", ">": ".", "?": "/"
  };
  const PUNCTUATION_KEYS = {
    "`": ["Backquote", 192], "-": ["Minus", 189], "=": ["Equal", 187], "[": ["BracketLeft", 219],
    "]": ["BracketRight", 221], "\\": ["Backslash", 220], ";": ["Semicolon", 186], "'": ["Quote", 222],
    ",": ["Comma", 188], ".": ["Period", 190], "/": ["Slash", 191], " ": ["Space", 32]
  };
  const NAMED_KEYS = {
    Backspace: ["Backspace", 8], Enter: ["Enter", 13], Tab: ["Tab", 9],
    ArrowLeft: ["ArrowLeft", 37], ArrowRight: ["ArrowRight", 39]
  };

  // Closed shadow roots of the kiosk's own UI (the admin password field), which
  // document.activeElement cannot see into.
  const ownRoots = new WeakMap();
  let listener = null;

  function deepActiveElement() {
    let el = document.activeElement;
    for (let depth = 0; el && depth < 32; depth += 1) {
      const root = ownRoots.get(el) || el.shadowRoot;
      if (!root || !root.activeElement) break;
      el = root.activeElement;
    }
    return el;
  }

  function isEditable(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.tagName === "TEXTAREA") return !el.disabled && !el.readOnly;
    if (el.tagName === "INPUT") {
      return TEXT_INPUT_TYPES.has(String(el.type || "text").toLowerCase()) && !el.disabled && !el.readOnly;
    }
    return Boolean(el.isContentEditable);
  }

  function focusedEditable() {
    const el = deepActiveElement();
    return isEditable(el) ? el : null;
  }

  function describeFocus() {
    const el = focusedEditable();
    if (!el) return { editable: false };
    const rect = el.getBoundingClientRect();
    return {
      editable: true,
      // A field that asks for no virtual keyboard (inputmode="none") draws its
      // own; the keyboard still opens from the bar.
      noKeyboard: String(el.getAttribute("inputmode") || "").toLowerCase() === "none",
      rect: { top: rect.top, bottom: rect.bottom }
    };
  }

  function report(reason) {
    const info = describeFocus();
    info.reason = reason;
    if (isTop) {
      if (listener) listener(0, info);
      return;
    }
    try {
      chrome.runtime.sendMessage({ type: "labkiosk:osk-focus", ...info }, () => {
        // No keyboard is listening (the top frame is still loading): nothing to do.
        if (chrome.runtime.lastError) return;
      });
    } catch (err) {
      console.warn("[LabKiosk] Could not report the focused field to the keyboard:", err);
    }
  }

  // Reported a tick later: during focusout, activeElement is not the next
  // element yet.
  function watchFocus(target) {
    target.addEventListener("focusin", () => setTimeout(() => report("focus"), 0), true);
    target.addEventListener("focusout", () => setTimeout(() => report("blur"), 0), true);
  }
  watchFocus(window);
  // Tapping the field that already has the focus brings a hidden keyboard back.
  window.addEventListener("click", (event) => {
    const el = focusedEditable();
    if (el && event.composedPath().includes(el)) report("tap");
  }, true);

  function legacyKey(key) {
    if (NAMED_KEYS[key]) return { code: NAMED_KEYS[key][0], keyCode: NAMED_KEYS[key][1], shiftKey: false };
    const base = SHIFTED_TO_BASE[key] || key.toLowerCase();
    const shiftKey = Boolean(SHIFTED_TO_BASE[key]) || (key !== key.toLowerCase());
    if (/^[a-z]$/.test(base)) return { code: "Key" + base.toUpperCase(), keyCode: base.toUpperCase().charCodeAt(0), shiftKey };
    if (/^[0-9]$/.test(base)) return { code: "Digit" + base, keyCode: base.charCodeAt(0), shiftKey };
    if (PUNCTUATION_KEYS[base]) return { code: PUNCTUATION_KEYS[base][0], keyCode: PUNCTUATION_KEYS[base][1], shiftKey };
    return { code: "", keyCode: 0, shiftKey: false };
  }

  /** Dispatch one synthetic key event; false when the page cancelled it. */
  function keyEvent(el, type, key) {
    const legacy = legacyKey(key);
    const printable = key.length === 1 || key === "Enter";
    const charCode = type === "keypress" ? (key === "Enter" ? 13 : key.charCodeAt(0)) : 0;
    return el.dispatchEvent(new KeyboardEvent(type, {
      key,
      code: legacy.code,
      keyCode: type === "keypress" && printable ? charCode : legacy.keyCode,
      which: type === "keypress" && printable ? charCode : legacy.keyCode,
      charCode,
      shiftKey: legacy.shiftKey,
      bubbles: true,
      cancelable: true,
      composed: true
    }));
  }

  function inputEvent(el, inputType, data) {
    el.dispatchEvent(new InputEvent("input", { inputType, data, bubbles: true, composed: true }));
  }

  function beforeInputAllowed(el, inputType, data) {
    return el.dispatchEvent(new InputEvent("beforeinput", { inputType, data, bubbles: true, cancelable: true, composed: true }));
  }

  function isTextControl(el) {
    return el.tagName === "INPUT" || el.tagName === "TEXTAREA";
  }

  function hasSelectionApi(el) {
    return el.tagName === "TEXTAREA" || !NO_SELECTION_TYPES.has(String(el.type).toLowerCase());
  }

  function execEdit(el, command, value) {
    if (el.ownerDocument !== document) return false;
    try {
      return document.execCommand(command, false, value);
    } catch (err) {
      console.warn(`[LabKiosk] execCommand(${command}) refused:`, err);
      return false;
    }
  }

  function insertIntoTextControl(el, text) {
    if (!beforeInputAllowed(el, "insertText", text)) return;
    if (hasSelectionApi(el)) {
      const start = el.selectionStart === null ? el.value.length : el.selectionStart;
      const end = el.selectionEnd === null ? start : el.selectionEnd;
      let insert = text;
      if (el.maxLength >= 0) {
        const room = el.maxLength - (el.value.length - (end - start));
        if (room <= 0) return;
        insert = insert.slice(0, room);
      }
      el.setRangeText(insert, start, end, "end");
    } else {
      const before = el.value;
      const next = before + text;
      if (el.maxLength >= 0 && next.length > el.maxLength) return;
      el.value = next;
      // A number field drops a value that is not a number yet ("-", "1.");
      // keep what was there rather than lose it.
      if (el.value !== next) el.value = before;
    }
    inputEvent(el, "insertText", text);
  }

  function insertIntoEditableContent(el, text) {
    const selection = el.ownerDocument.getSelection();
    if (!selection || !selection.rangeCount) return;
    if (!beforeInputAllowed(el, "insertText", text)) return;
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const node = el.ownerDocument.createTextNode(text);
    range.insertNode(node);
    range.setStartAfter(node);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
    inputEvent(el, "insertText", text);
  }

  function insertText(el, text) {
    if (execEdit(el, "insertText", text)) return;
    if (isTextControl(el)) insertIntoTextControl(el, text);
    else insertIntoEditableContent(el, text);
  }

  function deleteBackward(el) {
    if (execEdit(el, "delete")) return;
    if (!beforeInputAllowed(el, "deleteContentBackward", null)) return;
    if (isTextControl(el) && hasSelectionApi(el)) {
      let start = el.selectionStart;
      const end = el.selectionEnd;
      if (start === end) {
        if (start === 0) return;
        // One character, not half of a surrogate pair.
        const code = el.value.charCodeAt(start - 1);
        start -= (code >= 0xdc00 && code <= 0xdfff && start >= 2) ? 2 : 1;
      }
      el.setRangeText("", start, end, "end");
    } else if (isTextControl(el)) {
      if (!el.value) return;
      el.value = Array.from(el.value).slice(0, -1).join("");
    } else {
      const selection = el.ownerDocument.getSelection();
      if (!selection || !selection.rangeCount) return;
      if (selection.isCollapsed) selection.modify("extend", "backward", "character");
      selection.deleteFromDocument();
    }
    inputEvent(el, "deleteContentBackward", null);
  }

  function moveCaret(el, direction) {
    if (isTextControl(el) && hasSelectionApi(el)) {
      const start = el.selectionStart;
      const end = el.selectionEnd;
      let at;
      if (start !== end) at = direction < 0 ? start : end;
      else at = Math.max(0, Math.min(el.value.length, start + direction));
      el.setSelectionRange(at, at);
      return;
    }
    const selection = el.ownerDocument.getSelection();
    if (selection) selection.modify("move", direction < 0 ? "backward" : "forward", "character");
  }

  function isSubmitButton(el) {
    if (el.tagName === "BUTTON") return String(el.type).toLowerCase() === "submit";
    return el.tagName === "INPUT" && ["submit", "image"].includes(String(el.type).toLowerCase());
  }

  /**
   * What Enter in a single-line field does (HTML "implicit submission"): click
   * the form's default button, the first submit button in tree order; with
   * none, submit only when this is the form's one field that would block it.
   */
  function implicitSubmission(input) {
    const form = input.form;
    if (!form) return;
    const elements = Array.from(form.elements);
    const defaultButton = elements.find(isSubmitButton);
    if (defaultButton) {
      if (!defaultButton.disabled) defaultButton.click();
      return;
    }
    const blockers = elements.filter((el) => el.tagName === "INPUT" &&
      IMPLICIT_SUBMISSION_BLOCKERS.has(String(el.type).toLowerCase()));
    if (blockers.length > 1) return;
    form.requestSubmit();
  }

  function pressEnter(el) {
    if (el.tagName === "INPUT") {
      implicitSubmission(el);
    } else if (el.tagName === "TEXTAREA") {
      insertText(el, "\n");
    } else if (!execEdit(el, "insertParagraph") && !execEdit(el, "insertLineBreak")) {
      insertIntoEditableContent(el, "\n");
    }
  }

  function focusNext(el) {
    const doc = el.ownerDocument;
    const candidates = Array.from(doc.querySelectorAll(
      "input, select, textarea, button, a[href], [tabindex], [contenteditable]"
    )).filter((node) => node.tabIndex >= 0 && !node.disabled && node.getClientRects().length > 0 &&
      !(node.tagName === "INPUT" && String(node.type).toLowerCase() === "hidden"));
    const index = candidates.indexOf(el);
    if (index >= 0 && candidates[index + 1]) candidates[index + 1].focus();
  }

  function actionIsValid(action) {
    if (!action || typeof action !== "object") return false;
    if (action.kind === "text") {
      return typeof action.text === "string" && action.text.length > 0 && action.text.length <= MAX_ACTION_TEXT;
    }
    return action.kind === "key" && ACTION_KEYS.has(action.key);
  }

  /** Type one key into whatever field of this frame has the focus. */
  function apply(action) {
    if (!actionIsValid(action)) return false;
    const el = focusedEditable();
    if (!el) return false;
    const key = action.kind === "text" ? action.text : action.key;
    if (!keyEvent(el, "keydown", key)) {
      keyEvent(el, "keyup", key);
      return true;
    }
    const typesSomething = action.kind === "text" || key === "Enter";
    if (typesSomething && !keyEvent(el, "keypress", key)) {
      keyEvent(el, "keyup", key);
      return true;
    }
    if (action.kind === "text") insertText(el, action.text);
    else if (key === "Backspace") deleteBackward(el);
    else if (key === "Enter") pressEnter(el);
    else if (key === "Tab") focusNext(el);
    else moveCaret(el, key === "ArrowLeft" ? -1 : 1);
    keyEvent(el, "keyup", key);
    return true;
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || sender.id !== chrome.runtime.id) return false;
    if (message.type === "labkiosk:osk-apply" && !isTop) {
      sendResponse({ ok: true, applied: apply(message.action) });
      return false;
    }
    if (message.type === "labkiosk:osk-frame-focus" && isTop) {
      if (listener && Number.isInteger(message.frameId) && message.frameId > 0) {
        listener(message.frameId, {
          editable: message.editable === true,
          noKeyboard: message.noKeyboard === true,
          reason: String(message.reason || ""),
          rect: message.rect && Number.isFinite(message.rect.top) && Number.isFinite(message.rect.bottom)
            ? { top: message.rect.top, bottom: message.rect.bottom }
            : null
        });
      }
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });

  return {
    apply,
    focusedEditable,
    describeFocus,
    actionIsValid,
    /** Top frame only: called with (frameId, focus) whenever a field's focus changes. */
    onFocusChange(callback) {
      listener = callback;
    },
    /** A closed shadow root of the kiosk's own UI whose fields the keyboard may type into. */
    addOwnRoot(host, root) {
      if (ownRoots.has(host)) return;
      ownRoots.set(host, root);
      // Focus moving between two elements of one shadow tree never reaches
      // the window (both ends retarget to the host), so listen inside it too.
      watchFocus(root);
    }
  };
})();

(function () {
  // Only inject in top window (never in sub-iframes)
  if (window.self !== window.top) return;

  /**
   * Agent state is read through the extension's service worker, not fetched
   * directly. A content script runs in the page's origin, so a direct fetch to
   * the agent would be cross-origin and would require the agent to answer every
   * site with `Access-Control-Allow-Origin: *`.
   */
  function askAgent(message) {
    return new Promise((resolve, reject) => {
      let settled = false;
      try {
        chrome.runtime.sendMessage(message, (reply) => {
          if (settled) return;
          settled = true;
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else if (!reply || !reply.ok) {
            reject(new Error((reply && reply.error) || "Agent unavailable"));
          } else {
            resolve(reply);
          }
        });
      } catch (err) {
        if (!settled) {
          settled = true;
          reject(err);
        }
      }
    });
  }

  // Usage reports: a tick a minute while this page is the one on screen
  // (background.js adds whether someone is using the workstation).
  const USAGE_TICK_MS = 60 * 1000;
  function usageTick() {
    if (document.visibilityState !== "visible") return;
    askAgent({ type: "labkiosk:usage-tick" }).catch((err) => {
      console.warn("Lab Kiosk: usage tick not counted:", err && err.message ? err.message : err);
    });
  }
  usageTick();
  setInterval(usageTick, USAGE_TICK_MS);
  document.addEventListener("visibilitychange", usageTick);
  let lastTargetUrl = null;
  let isLocked = false;
  let lastReloadEpoch = null;
  try {
    const saved = sessionStorage.getItem("labkiosk_reload_epoch");
    if (saved) lastReloadEpoch = Number(saved);
  } catch {}
  // When the agent first reported the workstation offline; null while online.
  let offlineSince = null;
  const OFFLINE_REDIRECT_MS = 6000;
  // Long enough to notice the bar and read the workstation name, short enough
  // that it is out of the way before anyone starts a page.
  let barCatalog = {};

  /**
   * The bar's own strings, in whatever language the wizard chose.
   *
   * At this scope on purpose: the nav-button titles and the network tooltip are
   * set from functions that sit beside the one that builds the bar, not inside
   * it, so a t() declared in there would not exist by the time they run.
   */
  function t(key, fallback) {
    const value = barCatalog[key];
    return typeof value === "string" && value ? value : fallback;
  }
const BAR_INTRO_MS = 2500;
  const AGENT_SETUP_URL = "http://127.0.0.1:8888/setup";

  function isAgentPage(href) {
    try {
      const url = new URL(href);
      return (url.hostname === "127.0.0.1" || url.hostname === "localhost") && url.port === "8888";
    } catch {
      return false;
    }
  }

  /**
   * Mirror of the active broadcast marker owned by the service worker.
   *
   * This lives in the isolated world, so page script cannot reach it, and it is
   * read synchronously by isAtBroadcastRoot() from a keydown handler where an
   * await is not an option. The authoritative copy is in chrome.storage.session
   * via background.js, which is what survives navigation between pages.
   */
  let broadcastState = { epoch: "0", url: "" };

  function applyBroadcastState(next) {
    if (next && typeof next.epoch === "string") {
      broadcastState = { epoch: next.epoch, url: typeof next.url === "string" ? next.url : "" };
    }
    return broadcastState;
  }

  async function loadBroadcastState() {
    try {
      const reply = await askAgent({ type: "labkiosk:broadcast-get" });
      applyBroadcastState(reply.broadcast);
    } catch {
      // Keep the default; the next sync tick retries.
    }
  }

  async function storeBroadcastState(epoch, url) {
    applyBroadcastState({ epoch: String(epoch), url: url || "" });
    try {
      const reply = await askAgent({ type: "labkiosk:broadcast-set", epoch: String(epoch), url });
      applyBroadcastState(reply.broadcast);
    } catch {
      // The mirror is already updated; persistence retries on the next change.
    }
  }

  async function clearBroadcastState() {
    applyBroadcastState({ epoch: "0", url: "" });
    try {
      await askAgent({ type: "labkiosk:broadcast-clear" });
    } catch {
      // As above.
    }
  }

  // While the operator's curtain is up, stop the page underneath from seeing any
  // input. This is a DOM-level block, not an X11 input grab: it prevents the
  // user interacting with the page, while Chromium's kiosk switches and the
  // stripped Openbox keybindings cover browser- and window-level shortcuts.
  const SWALLOWED_WHILE_LOCKED = [
    "click", "dblclick", "mousedown", "mouseup", "wheel",
    "keydown", "keypress", "keyup", "touchstart", "touchmove", "touchend"
  ];
  for (const type of SWALLOWED_WHILE_LOCKED) {
    window.addEventListener(
      type,
      (e) => {
        if (!isLocked) return;
        // Let the curtain itself keep working; everything else is discarded.
        if (e.composedPath && e.composedPath().some((n) => n && n.id === "labkiosk-root")) return;
        e.preventDefault();
        e.stopImmediatePropagation();
      },
      true
    );
  }

  // A closed shadow root is not reachable from the host element, so the only
  // handles to the kiosk UI are these two.
  let uiHost = null;
  let uiShadow = null;

  /** An http(s) URL safe to navigate to, or null. */
  function httpUrlOrNull(raw) {
    if (!raw) return null;
    try {
      const parsed = new URL(raw, window.location.href);
      return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.href : null;
    } catch {
      return null;
    }
  }

  function normalizeUrl(raw) {
    if (!raw) return "";
    try {
      const u = new URL(raw, window.location.href);
      const path = u.pathname.length > 1 ? u.pathname.replace(/\/+$/, "") : u.pathname;
      return (u.origin + path).toLowerCase() + u.search;
    } catch {
      return "";
    }
  }

  function isAtBroadcastRoot() {
    const broadcastUrl = broadcastState.url;
    if (!broadcastUrl) return false;
    const cur = normalizeUrl(window.location.href);
    const root = normalizeUrl(broadcastUrl);
    return Boolean(cur && root && cur === root);
  }

  // 1. Block right click and inspection shortcuts + back navigation at broadcast root
  window.addEventListener("contextmenu", (e) => e.preventDefault(), true);
  window.addEventListener(
    "keydown",
    (e) => {
      if (
        e.key === "F12" ||
        (e.ctrlKey && e.shiftKey && ["I", "J", "C"].includes(e.key.toUpperCase())) ||
        (e.ctrlKey && ["u", "U"].includes(e.key)) ||
        e.key === "F11"
      ) {
        e.preventDefault();
        e.stopPropagation();
      } else if (
        (e.altKey && e.key === "ArrowLeft") ||
        // Backspace outside a text field is Back -- but in a contenteditable
        // editor it deletes, from a real key and the on-screen keyboard alike.
        (e.key === "Backspace" && !kioskTyping.focusedEditable())
      ) {
        if (isAtBroadcastRoot()) {
          e.preventDefault();
          e.stopPropagation();
        }
      }
    },
    true
  );

  // 2. Create Isolated Shadow DOM Container for Top Bar & Curtain
  function initKioskUi() {
    // Always return a usable shadow root. Returning undefined when the UI already
    // exists let a second call (DOMContentLoaded firing after the first sync tick
    // had already built it) overwrite `shadowRoot` with undefined, after which the
    // status loop skipped its whole update block: the bar still rendered and its
    // dot kept its default green, but the lock curtain never appeared again.
    const existing = document.getElementById("labkiosk-root");
    if (existing && existing === uiHost && uiShadow) return uiShadow;
    if (existing) {
      existing.remove();
    }

    const host = document.createElement("div");
    host.id = "labkiosk-root";
    host.style.cssText = "all: initial; position: absolute; z-index: 2147483647;";

    // "closed" so the host page cannot reach this subtree through
    // document.getElementById("labkiosk-root").shadowRoot and delete the lock
    // curtain out from under the operator. The content script keeps its own
    // reference below, which is unaffected.
    const shadow = host.attachShadow({ mode: "closed" });
    shadow.innerHTML = `
      <style>
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
        /* A printed page is the page, without the bar or the curtain. */
        @media print { :host { display: none !important; } }
        .kiosk-btn[hidden] { display: none !important; }
        
        #kiosk-sensor {
          position: fixed;
          top: 0;
          left: 0;
          width: 100vw;
          height: 10px;
          background: transparent;
          z-index: 2147483646;
          pointer-events: none;
        }

        #kiosk-bar {
          position: fixed;
          top: 0;
          left: 0;
          width: 100vw;
          height: 44px;
          background: rgba(15, 23, 42, 0.96);
          backdrop-filter: blur(10px);
          -webkit-backdrop-filter: blur(10px);
          border-bottom: 1px solid #334155;
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0 16px;
          color: #f8fafc;
          box-shadow: 0 4px 16px rgba(0,0,0,0.5);
          user-select: none;
          z-index: 2147483647;
          transform: translateY(-100%);
          opacity: 0;
          pointer-events: none;
          transition: transform 0.22s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.2s ease;
        }

        #kiosk-bar.visible {
          transform: translateY(0);
          opacity: 1;
          pointer-events: auto;
        }

        .nav-cluster {
          display: flex;
          align-items: center;
          gap: 8px;
        }

        .kiosk-btn {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          background: #1e293b;
          border: 1px solid #334155;
          color: #f8fafc;
          padding: 6px 14px;
          border-radius: 6px;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.15s ease;
        }

        .kiosk-btn:hover {
          background: #3b82f6;
          border-color: #3b82f6;
          color: #ffffff;
        }

        .kiosk-btn:active {
          transform: scale(0.96);
        }

        .kiosk-btn[aria-pressed="true"] {
          background: #2563eb;
          border-color: #3b82f6;
        }

        .domain-pill {
          display: flex;
          align-items: center;
          gap: 8px;
          background: #1e293b;
          padding: 5px 14px;
          border-radius: 20px;
          border: 1px solid #334155;
          font-family: monospace;
          font-size: 13px;
          color: #93c5fd;
          max-width: 35vw;
          min-width: 0;
          overflow: hidden;
        }

        #kiosk-domain {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .client-meta {
          display: flex;
          align-items: center;
          gap: 10px;
          font-size: 13px;
          font-weight: 600;
        }

        .kiosk-icon-btn {
          background: transparent;
          border: none;
          color: #94a3b8;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          padding: 4px;
          border-radius: 6px;
          transition: all 0.15s ease;
        }

        .kiosk-icon-btn:hover {
          color: #38bdf8;
          background: #1e293b;
        }

        .kiosk-icon-btn:active {
          transform: scale(0.95);
        }

        .status-dot {
          width: 9px;
          height: 9px;
          border-radius: 50%;
          background: #10b981;
          box-shadow: 0 0 8px #10b981;
        }
        .status-dot.offline {
          background: #ef4444;
          box-shadow: 0 0 8px #ef4444;
        }

        .kiosk-clock {
          display: flex; align-items: center; gap: 6px;
          background: rgba(255, 255, 255, 0.06);
          border: 1px solid rgba(255, 255, 255, 0.12);
          color: #e2e8f0; border-radius: 8px;
          padding: 5px 10px; font-size: 12px; font-weight: 700;
          font-variant-numeric: tabular-nums; cursor: pointer;
          white-space: nowrap;
        }
        .kiosk-clock:hover { background: rgba(255, 255, 255, 0.12); }

        /* Administrator Verification Modal */
        .modal-overlay {
          position: fixed;
          top: 0;
          left: 0;
          width: 100vw;
          height: 100vh;
          background: rgba(0, 0, 0, 0.75);
          backdrop-filter: blur(4px);
          -webkit-backdrop-filter: blur(4px);
          z-index: 2147483647;
          display: flex;
          align-items: center;
          justify-content: center;
        }

        .modal-overlay.hidden {
          display: none;
        }

        .modal-card {
          background: #0f172a;
          border: 1px solid #334155;
          border-radius: 12px;
          padding: 24px;
          width: 380px;
          max-width: 90vw;
          box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.7);
          color: #f8fafc;
        }

        .modal-header {
          display: flex;
          align-items: center;
          gap: 10px;
          margin-bottom: 8px;
        }

        .modal-title {
          font-size: 16px;
          font-weight: 700;
          color: #f8fafc;
        }

        .modal-desc {
          font-size: 13px;
          color: #94a3b8;
          margin-bottom: 16px;
          line-height: 1.4;
        }

        .modal-input {
          width: 100%;
          background: #1e293b;
          border: 1px solid #475569;
          border-radius: 6px;
          padding: 9px 12px;
          color: #f8fafc;
          font-size: 14px;
          outline: none;
          transition: border-color 0.15s;
        }

        .modal-input:focus {
          border-color: #38bdf8;
        }

        .modal-err {
          color: #f87171;
          font-size: 12px;
          margin-top: 6px;
          font-weight: 500;
        }

        .modal-err.hidden {
          display: none;
        }

        .modal-actions {
          display: flex;
          gap: 10px;
          margin-top: 20px;
          justify-content: flex-end;
        }

        .modal-btn {
          border: none;
          padding: 8px 16px;
          border-radius: 6px;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.15s ease;
        }

        .modal-btn-cancel {
          background: #334155;
          color: #cbd5e1;
        }

        .modal-btn-cancel:hover {
          background: #475569;
          color: #ffffff;
        }

        .modal-btn-confirm {
          background: #2563eb;
          color: #ffffff;
        }

        .modal-btn-confirm:hover {
          background: #1d4ed8;
        }

        .modal-btn-confirm:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        /* Fullscreen Lockdown Curtain */
        #lock-curtain {
          position: fixed;
          top: 0;
          left: 0;
          width: 100vw;
          height: 100vh;
          background: #090d16;
          z-index: 2147483647;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          text-align: center;
          padding: 24px;
          color: #ffffff;
        }

        #lock-curtain.hidden {
          display: none;
        }

        .curtain-card {
          background: #111827;
          border: 1px solid #374151;
          border-radius: 16px;
          padding: 48px;
          max-width: 620px;
          box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.9);
        }

        .lock-icon {
          width: 64px;
          height: 64px;
          margin: 0 auto 20px;
          color: #f87171;
        }

        .lock-title {
          font-size: 32px;
          font-weight: 800;
          margin-bottom: 16px;
          letter-spacing: -0.5px;
        }

        .lock-msg {
          font-size: 18px;
          color: #9ca3af;
          line-height: 1.6;
        }

        /* A power schedule's switch-off: five minutes' notice, then shutdown. */
        #power-notice {
          position: fixed;
          left: 50%;
          bottom: 24px;
          transform: translateX(-50%);
          width: min(560px, calc(100vw - 32px));
          box-sizing: border-box;
          background: #111827;
          border: 1px solid #f59e0b;
          border-radius: 12px;
          padding: 16px 20px;
          color: #ffffff;
          z-index: 2147483646;
          box-shadow: 0 20px 40px -12px rgba(0, 0, 0, 0.8);
          font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
        }

        #power-notice.hidden {
          display: none;
        }

        .power-head {
          display: flex;
          align-items: baseline;
          justify-content: space-between;
          gap: 12px;
          margin-bottom: 6px;
        }

        .power-title {
          font-size: 17px;
          font-weight: 700;
        }

        .power-countdown {
          font-size: 22px;
          font-weight: 800;
          color: #fbbf24;
          font-variant-numeric: tabular-nums;
        }

        .power-msg {
          font-size: 14px;
          color: #d1d5db;
          line-height: 1.5;
          margin: 0;
        }
      </style>

      <div id="kiosk-sensor"></div>

      <div id="kiosk-bar">
        <div class="nav-cluster">
          <button class="kiosk-btn" id="btn-home" title="Home" data-i18n-title="bar.homeTitle">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path></svg>
            <span data-i18n="bar.home">Home</span>
          </button>
          <button class="kiosk-btn" id="btn-back" title="Go Back" data-i18n-title="bar.backTitle">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"></polyline></svg>
            <span data-i18n="bar.back">Back</span>
          </button>
          <button class="kiosk-btn" id="btn-forward" title="Go Forward" data-i18n-title="bar.forwardTitle">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"></polyline></svg>
            <span data-i18n="bar.forward">Forward</span>
          </button>
          <button class="kiosk-btn" id="btn-reload" title="Reload Page" data-i18n-title="bar.reloadTitle">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>
            <span data-i18n="bar.reload">Reload</span>
          </button>
          <!--
            Always there, keyboard or not: a touchscreen workstation with a
            keyboard attached may still be used by touch. Without a keyboard
            the keyboard also opens by itself on a text field.
          -->
          <button class="kiosk-btn" id="btn-keyboard" title="Show or hide the on-screen keyboard"
                  data-i18n-title="bar.keyboardTitle" aria-pressed="false">
            <svg width="17" height="15" viewBox="0 0 26 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><rect x="1.5" y="2" width="23" height="16" rx="2.5"></rect><path d="M6 7h.01M10 7h.01M14 7h.01M18 7h.01M6 11h.01M10 11h.01M14 11h.01M18 11h.01M8 14.5h10"></path></svg>
            <span data-i18n="bar.keyboard">Keyboard</span>
          </button>
          <!-- Only while the organization allows printing (kioskPrint). -->
          <button class="kiosk-btn" id="btn-print" title="Print this page" data-i18n-title="bar.printTitle" hidden>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 6 2 18 2 18 9"></polyline><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"></path><rect x="6" y="14" width="12" height="8"></rect></svg>
            <span data-i18n="bar.print">Print</span>
          </button>
        </div>

        <div class="domain-pill">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#22c55e" stroke-width="2.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"></path></svg>
          <span id="kiosk-domain"></span>
        </div>

        <div class="client-meta">
          <button class="kiosk-icon-btn" id="btn-network" title="Network Configuration" data-i18n-title="bar.networkTitle">
            <svg id="kiosk-net-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M5 12.55a11 11 0 0 1 14.08 0"></path>
              <path d="M1.42 9a16 16 0 0 1 21.16 0"></path>
              <path d="M8.53 16.11a6 6 0 0 1 6.95 0"></path>
              <line x1="12" y1="20" x2="12.01" y2="20"></line>
            </svg>
          </button>
          <!--
            The clock sits right after the network icon and opens the same wizard
            page the network icon does, on its Language & Region step: it is the
            one place an operator can see the time is wrong, so it is also where
            they should be able to put it right. Behind the same password.
          -->
          <button class="kiosk-clock" id="btn-clock" title="Date, time and language"
                  data-i18n-title="bar.clockTitle">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
              <circle cx="12" cy="12" r="9"></circle><polyline points="12 7 12 12 15 14"></polyline>
            </svg>
            <span id="kiosk-clock-text"></span>
          </button>
          <div class="status-dot" id="kiosk-dot"></div>
          <span id="kiosk-client-id">PC-01</span>
        </div>
      </div>

      <div id="lock-curtain" class="hidden">
        <div class="curtain-card">
          <svg class="lock-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
            <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
          </svg>
          <h1 class="lock-title" id="lock-title">Attention Please</h1>
          <p class="lock-msg" id="lock-text">This screen has been locked by an administrator. Please wait.</p>
        </div>
      </div>

      <div id="power-notice" class="hidden" role="alert" aria-live="assertive">
        <div class="power-head">
          <span class="power-title" data-i18n="bar.power-off-title">This workstation is switching off</span>
          <span class="power-countdown" id="power-countdown"></span>
        </div>
        <p class="power-msg" id="power-text" data-i18n="bar.power-off-text">The organization's power schedule switches it off in a few minutes. Save your work now.</p>
      </div>

      <div id="admin-modal" class="modal-overlay hidden">
        <div class="modal-card">
          <div class="modal-header">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#38bdf8" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="11" width="18" height="11" rx="2" ry="2"></rect>
              <path d="M7 11V7a5 5 0 0 1 10 0v4"></path>
            </svg>
            <h3 class="modal-title" data-i18n="admin.title">Administrator Verification</h3>
          </div>
          <p class="modal-desc" id="admin-modal-desc" data-i18n="admin.prompt">Enter the administrator or boot password to configure network settings.</p>
          <input type="password" id="admin-modal-input" class="modal-input" placeholder="Enter password" autocomplete="off" />
          <div id="admin-modal-err" class="modal-err hidden" data-i18n="admin.invalid">Invalid administrator password.</div>
          <div class="modal-actions">
            <button type="button" class="modal-btn modal-btn-cancel" id="btn-admin-modal-cancel" data-i18n="admin.cancel">Cancel</button>
            <button type="button" class="modal-btn modal-btn-confirm" id="btn-admin-modal-submit" data-i18n="admin.unlock">Unlock</button>
          </div>
        </div>
      </div>
    `;

    document.documentElement.appendChild(host);
    uiHost = host;
    uiShadow = shadow;
    // So the on-screen keyboard can type the admin password too.
    kioskTyping.addOwnRoot(host, shadow);

    const domainLabel = shadow.getElementById("kiosk-domain");
    if (domainLabel) {
      domainLabel.textContent = window.location.hostname || "Approved Resource";
    }

    // Ensure zero body margin so the page gets 100% full viewport height without overflow
    if (document.body && document.body.style.marginTop) {
      document.body.style.marginTop = "";
    }

    const bar = shadow.getElementById("kiosk-bar");
    const sensor = shadow.getElementById("kiosk-sensor");
    let hideTimer = null;

    function showBar() {
      if (isLocked) return;
      if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = null;
      }
      if (bar) bar.classList.add("visible");
    }

    function hideBar(delay = 400) {
      if (hideTimer) clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        if (bar && !bar.matches(":hover")) {
          bar.classList.remove("visible");
        }
      }, delay);
    }

    // Top sensor and bar hover listeners
    sensor.addEventListener("mouseenter", showBar);
    bar.addEventListener("mouseenter", () => {
      if (hideTimer) {
        clearTimeout(hideTimer);
        hideTimer = null;
      }
    });
    bar.addEventListener("mouseleave", () => hideBar(300));

    // Global window mousemove detector
    window.addEventListener(
      "mousemove",
      (e) => {
        if (e.clientY <= 12) {
          showBar();
        } else if (e.clientY > 55) {
          if (bar && bar.classList.contains("visible") && !bar.matches(":hover")) {
            hideBar(300);
          }
        }
      },
      { passive: true }
    );

    window.addEventListener("mouseleave", () => hideBar(200));

    // Show the bar once at the start of each session, then let it hide itself.
    // It is invisible until the pointer reaches the top edge, which nobody
    // discovers by accident; this is how a user learns it is there at all.
    // The service worker hands out the "first page of this session" flag, so
    // this happens once per boot rather than on every navigation.
    askAgent({ type: "labkiosk:intro-peek" })
      .then((reply) => {
        if (!reply || !reply.first) return;
        showBar();
        hideBar(BAR_INTRO_MS);
      })
      .catch(() => {
        // The service worker may still be starting; the bar simply stays hidden.
      });

    // Touch support for touchscreens
    window.addEventListener(
      "touchstart",
      (e) => {
        if (e.touches && e.touches[0] && e.touches[0].clientY <= 25) {
          showBar();
        } else if (e.touches && e.touches[0] && e.touches[0].clientY > 60) {
          hideBar(200);
        }
      },
      { passive: true }
    );

    // Button event listeners
    // Strings the bar sets from script rather than from its own markup: the
    // English is the argument, so a catalog only ever overrides it.
    const adminDesc = shadow.getElementById("admin-modal-desc");
    // Interface language. The bar is built in English and then translated in
    // place, so a missing, partial or broken catalog leaves it readable.
    askAgent({ type: "labkiosk:i18n" }).then((reply) => {
      const catalog = (reply && reply.catalog) || {};
      barCatalog = catalog;
      shadow.querySelectorAll("[data-i18n]").forEach((el) => {
        const value = catalog[el.dataset.i18n];
        if (typeof value === "string" && value) el.textContent = value;
      });
      shadow.querySelectorAll("[data-i18n-title]").forEach((el) => {
        const value = catalog[el.dataset.i18nTitle];
        if (typeof value === "string" && value) el.title = value;
      });
      const dir = (catalog._meta || {}).direction === "rtl" ? "rtl" : "ltr";
      host.setAttribute("dir", dir);
      if (bar) bar.setAttribute("dir", dir);
      const curtain = shadow.getElementById("lock-curtain");
      if (curtain) curtain.setAttribute("dir", dir);
      const adminModal = shadow.getElementById("admin-modal");
      if (adminModal) adminModal.setAttribute("dir", dir);
      const powerNotice = shadow.getElementById("power-notice");
      if (powerNotice) powerNotice.setAttribute("dir", dir);
      keyboard.relabel();
    }).catch(() => { /* English stands */ });

    shadow.getElementById("btn-home").onclick = async () => {
      try {
        const { status } = await askAgent({ type: "labkiosk:status" });
        const target = status.targetUrl || broadcastState.url;
        const safeTarget = httpUrlOrNull(target);
        if (safeTarget) {
          window.location.href = safeTarget;
        }
      } catch (e) {
        console.warn("[LabKiosk] Home target unavailable:", e);
      }
    };
    shadow.getElementById("btn-back").onclick = () => {
      if (isAtBroadcastRoot()) {
        console.log("[LabKiosk] Back navigation blocked at broadcast root");
        return;
      }
      window.history.back();
    };
    shadow.getElementById("btn-forward").onclick = () => window.history.forward();
    shadow.getElementById("btn-reload").onclick = () => window.location.reload();
    const btnKeyboard = shadow.getElementById("btn-keyboard");
    if (btnKeyboard) {
      // Pressing it must not take the focus from the field it is opened for.
      btnKeyboard.addEventListener("pointerdown", (e) => e.preventDefault());
      btnKeyboard.addEventListener("mousedown", (e) => e.preventDefault());
      btnKeyboard.onclick = () => keyboard.toggle();
      keyboard.bindButton(btnKeyboard);
    }
    const btnPrint = shadow.getElementById("btn-print");
    if (btnPrint) btnPrint.onclick = () => kioskPrint.print();

    const adminModal = shadow.getElementById("admin-modal");
    const adminInput = shadow.getElementById("admin-modal-input");
    const adminErr = shadow.getElementById("admin-modal-err");
    const btnAdminSubmit = shadow.getElementById("btn-admin-modal-submit");
    const btnAdminCancel = shadow.getElementById("btn-admin-modal-cancel");
    const btnNetwork = shadow.getElementById("btn-network");

    // Which page the password is being asked for. The modal is shared, so the
    // destination has to travel with it rather than be assumed.
    let adminModalTarget = "network";

    function openAdminModal(target) {
      adminModalTarget = target === "locale" ? "locale" : "network";
      if (adminDesc) {
        adminDesc.textContent = adminModalTarget === "locale"
          ? t("admin.promptLocale", "Enter the administrator or boot password to change the date, time and language.")
          : t("admin.prompt", "Enter the administrator or boot password to configure network settings.");
      }
      if (!adminModal) return;
      if (adminErr) adminErr.classList.add("hidden");
      if (adminInput) {
        adminInput.value = "";
        setTimeout(() => adminInput.focus(), 60);
      }
      adminModal.classList.remove("hidden");
    }

    function closeAdminModal() {
      if (!adminModal) return;
      adminModal.classList.add("hidden");
      if (adminInput) adminInput.value = "";
      if (adminErr) adminErr.classList.add("hidden");
    }

    async function submitAdminPassword() {
      if (!adminInput || !btnAdminSubmit) return;
      const val = adminInput.value;
      btnAdminSubmit.disabled = true;
      if (adminErr) adminErr.classList.add("hidden");

      try {
        const reply = await askAgent({ type: "labkiosk:verify-admin", password: val });
        if (reply && reply.verified && reply.token) {
          closeAdminModal();
          // The wizard reads the short-lived unlock token from the fragment,
          // which never leaves the browser, and removes it from the address.
          window.location.href =
            `${AGENT_SETUP_URL}#${adminModalTarget}&admin=${encodeURIComponent(reply.token)}`;
        } else {
          if (adminErr) {
            adminErr.textContent = (reply && reply.error) || "Invalid administrator password.";
            adminErr.classList.remove("hidden");
          }
        }
      } catch (err) {
        if (adminErr) {
          adminErr.textContent = (err && err.message) || "Verification failed.";
          adminErr.classList.remove("hidden");
        }
      } finally {
        btnAdminSubmit.disabled = false;
      }
    }

    // The clock, in the workstation's own timezone -- which is the point: the
    // Language & Region step is what set it, and this is where it shows.
    const clockText = shadow.getElementById("kiosk-clock-text");
    const btnClock = shadow.getElementById("btn-clock");

    function renderClock() {
      if (!clockText) return;
      try {
        clockText.textContent = new Intl.DateTimeFormat(undefined, {
          weekday: "short", day: "2-digit", month: "short",
          hour: "2-digit", minute: "2-digit",
        }).format(new Date());
      } catch {
        clockText.textContent = new Date().toLocaleString();
      }
    }
    renderClock();
    setInterval(renderClock, 15000);

    if (btnClock) btnClock.onclick = () => openAdminModal("locale");

    if (btnNetwork) btnNetwork.onclick = () => openAdminModal("network");
    if (btnAdminCancel) btnAdminCancel.onclick = closeAdminModal;
    if (btnAdminSubmit) btnAdminSubmit.onclick = submitAdminPassword;
    if (adminInput) {
      adminInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          submitAdminPassword();
        } else if (e.key === "Escape") {
          e.preventDefault();
          closeAdminModal();
        }
      });
    }

    updateNavButtonStates(shadow);
    return shadow;
  }

  function updateNavButtonStates(shadow) {
    if (!shadow) return;
    const btnBack = shadow.getElementById("btn-back");
    if (!btnBack) return;
    if (isAtBroadcastRoot()) {
      btnBack.classList.add("disabled");
      btnBack.style.opacity = "0.35";
      btnBack.style.cursor = "not-allowed";
      btnBack.title = t("bar.back-is-disabled-at-the-start", "Back is disabled at the start of the broadcast page");
    } else {
      btnBack.classList.remove("disabled");
      btnBack.style.opacity = "1";
      btnBack.style.cursor = "pointer";
      btnBack.title = t("bar.backTitle", "Go Back");
    }
  }

  /**
   * The on-screen keyboard, docked at the bottom of the top frame in a closed
   * shadow root of its own (beside the bar's, so the bar's rebuild never takes
   * it down and it can sit above the admin modal).
   *
   * It opens from the bar's Keyboard button on any workstation, and by itself
   * when the agent reports keyboardPresent: false and a text field gets the
   * focus; then it also closes when the focus leaves text, unless it was opened
   * from the button. Hide closes it until a field is tapped or focused again.
   * Keys act on pointerdown, whose default is cancelled, so the field keeps the
   * focus; the typing itself is kioskTyping's, in the field's own frame.
   *
   * One layout, US QWERTY, with the US shifted symbols and a ?123 layer.
   * Another layout is another LAYERS table chosen from the workstation's
   * keymap (localization.json), plus dead keys for accented letters.
   */
  function createOnScreenKeyboard() {
    const REPEAT_DELAY_MS = 450;
    const REPEAT_EVERY_MS = 70;
    const HIDE_AFTER_BLUR_MS = 250;
    const DOUBLE_SHIFT_MS = 400;
    const FIELD_MARGIN_PX = 12;
    const REPEATING = new Set(["Backspace", "ArrowLeft", "ArrowRight"]);

    const chars = (text, shifted) => Array.from(text).map((base, i) => ({
      base,
      shifted: shifted ? shifted[i] : (/^[a-z]$/.test(base) ? base.toUpperCase() : base),
      letter: /^[a-z]$/.test(base),
      width: 1
    }));
    const fn = (action, width) => ({ action, width });
    const LAYERS = {
      letters: [
        [...chars("`1234567890-=", "~!@#$%^&*()_+"), fn("Backspace", 2)],
        [fn("Tab", 1.5), ...chars("qwertyuiop[]", "QWERTYUIOP{}"), { ...chars("\\", "|")[0], width: 1.5 }],
        [fn("CapsLock", 1.75), ...chars("asdfghjkl;'", "ASDFGHJKL:\""), fn("Enter", 2.25)],
        [fn("Shift", 2.25), ...chars("zxcvbnm,./", "ZXCVBNM<>?"), fn("Shift", 2.75)],
        [fn("Symbols", 2), fn("ArrowLeft", 1.25), fn("Space", 8.5), fn("ArrowRight", 1.25), fn("Hide", 2)]
      ],
      symbols: [
        [...chars("1234567890"), fn("Backspace", 2)],
        [fn("Tab", 2), ...chars("@#$%&*-+()")],
        [...chars("!\"':;/?_="), fn("Enter", 3)],
        [...chars("~`\\|{}[]<>^.")],
        [fn("Letters", 2), fn("ArrowLeft", 1.5), fn("Space", 5), fn("ArrowRight", 1.5), fn("Hide", 2)]
      ]
    };

    let host = null;
    let panel = null;
    let rows = null;
    const keyDefs = new Map();
    let button = null;
    let layer = "letters";
    let shift = false;
    let caps = false;
    let lastShiftAt = 0;
    let visible = false;
    let manual = false;
    let autoMode = false;
    let dismissed = false;
    let focus = { frameId: 0, editable: false, rect: null, noKeyboard: false };
    let blurTimer = null;
    let repeatTimer = null;
    let savedPadding = null;

    function label(def) {
      switch (def.action) {
        case "Backspace": return { text: "⌫", title: t("keyboard.backspaceTitle", "Delete") };
        case "Tab": return { text: t("keyboard.tab", "Tab") };
        case "CapsLock": return { text: t("keyboard.caps", "Caps") };
        case "Enter": return { text: t("keyboard.enter", "Enter") };
        case "Shift": return { text: "⇧ " + t("keyboard.shift", "Shift") };
        case "Symbols": return { text: t("keyboard.symbols", "?123") };
        case "Letters": return { text: t("keyboard.letters", "ABC") };
        case "ArrowLeft": return { text: "←", title: t("keyboard.leftTitle", "Move left") };
        case "ArrowRight": return { text: "→", title: t("keyboard.rightTitle", "Move right") };
        case "Space": return { text: t("keyboard.space", "Space") };
        case "Hide": return { text: t("keyboard.hide", "Hide"), title: t("keyboard.hideTitle", "Hide the keyboard") };
        default: return { text: output(def) };
      }
    }

    function output(def) {
      if (def.letter) return shift !== caps ? def.shifted : def.base;
      return shift ? def.shifted : def.base;
    }

    function renderLabels() {
      for (const [el, def] of keyDefs) {
        const { text, title } = label(def);
        el.textContent = text;
        if (title) {
          el.title = title;
          el.setAttribute("aria-label", title);
        }
        el.classList.toggle("on", (def.action === "Shift" && shift) || (def.action === "CapsLock" && caps));
      }
    }

    function renderLayer() {
      if (!rows) return;
      keyDefs.clear();
      rows.replaceChildren();
      for (const row of LAYERS[layer]) {
        const rowEl = document.createElement("div");
        rowEl.className = "osk-row";
        for (const def of row) {
          const key = document.createElement("div");
          key.className = def.action ? "osk-key fn" : "osk-key";
          if (def.action === "Enter") key.classList.add("enter");
          key.setAttribute("role", "button");
          key.style.flexGrow = String(def.width);
          keyDefs.set(key, def);
          rowEl.appendChild(key);
        }
        rows.appendChild(rowEl);
      }
      renderLabels();
    }

    function stopRepeat() {
      if (repeatTimer) clearTimeout(repeatTimer);
      repeatTimer = null;
      if (rows) rows.querySelectorAll(".pressed").forEach((el) => el.classList.remove("pressed"));
    }

    function send(action) {
      if (focus.frameId === 0 || !focus.editable) {
        kioskTyping.apply(action);
        return;
      }
      askAgent({ type: "labkiosk:osk-type", frameId: focus.frameId, action }).catch((err) => {
        console.warn("[LabKiosk] Could not type into the frame:", err);
      });
    }

    function press(def) {
      switch (def.action) {
        case "Shift": {
          const now = Date.now();
          if (!shift && !caps && now - lastShiftAt < DOUBLE_SHIFT_MS) {
            caps = true;
          } else if (caps) {
            caps = false;
            shift = false;
          } else {
            shift = !shift;
          }
          lastShiftAt = now;
          renderLabels();
          return;
        }
        case "CapsLock":
          caps = !caps;
          shift = false;
          renderLabels();
          return;
        case "Symbols":
        case "Letters":
          layer = def.action === "Symbols" ? "symbols" : "letters";
          shift = false;
          renderLayer();
          return;
        case "Hide":
          hide(true);
          return;
        case "Space":
          send({ kind: "text", text: " " });
          return;
        case undefined:
          send({ kind: "text", text: output(def) });
          if (shift) {
            shift = false;
            renderLabels();
          }
          return;
        default:
          send({ kind: "key", key: def.action });
      }
    }

    function build() {
      if (host && host.isConnected) return;
      host = document.createElement("div");
      host.id = "labkiosk-keyboard";
      host.style.cssText = "all: initial; position: fixed; z-index: 2147483647; display: none;";
      const shadow = host.attachShadow({ mode: "closed" });
      shadow.innerHTML = `
        <style>
          * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; }
          @media print { :host { display: none !important; } }
          .osk {
            position: fixed; left: 0; right: 0; bottom: 0; z-index: 2147483647;
            background: rgba(15, 23, 42, 0.98);
            border-top: 1px solid #334155;
            box-shadow: 0 -8px 24px rgba(0, 0, 0, 0.45);
            padding: 8px 8px calc(10px + env(safe-area-inset-bottom));
            user-select: none; -webkit-user-select: none; touch-action: none;
          }
          .osk.top { top: 0; bottom: auto; border-top: 0; border-bottom: 1px solid #334155; box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45); }
          .osk-rows { max-width: 1180px; margin: 0 auto; display: flex; flex-direction: column; gap: 6px; }
          .osk-row { display: flex; gap: 6px; }
          .osk-key {
            flex: 1 1 0; min-width: 0;
            height: clamp(46px, 7.4vh, 68px);
            display: flex; align-items: center; justify-content: center;
            background: #1e293b; color: #f8fafc;
            border: 1px solid #334155; border-bottom-width: 3px; border-radius: 8px;
            font-size: clamp(17px, 2.7vh, 25px); font-weight: 600;
            white-space: nowrap; overflow: hidden; cursor: pointer;
          }
          .osk-key.fn { background: #273449; color: #cbd5e1; font-size: clamp(14px, 2.1vh, 18px); }
          .osk-key.enter { background: #1d4ed8; border-color: #2563eb; color: #ffffff; }
          .osk-key.on { background: #2563eb; border-color: #60a5fa; color: #ffffff; }
          .osk-key.pressed { background: #3b82f6; border-color: #93c5fd; color: #ffffff; transform: translateY(1px); }
        </style>
        <div class="osk" dir="ltr" role="group">
          <div class="osk-rows"></div>
        </div>
      `;
      panel = shadow.querySelector(".osk");
      rows = shadow.querySelector(".osk-rows");
      panel.setAttribute("aria-label", t("keyboard.title", "On-screen keyboard"));

      panel.addEventListener("pointerdown", (event) => {
        // Never take the focus from the field being typed into.
        event.preventDefault();
        const key = event.target instanceof Element ? event.target.closest(".osk-key") : null;
        const def = key ? keyDefs.get(key) : null;
        if (!def) return;
        stopRepeat();
        key.classList.add("pressed");
        press(def);
        if (REPEATING.has(def.action)) {
          const again = () => {
            press(def);
            repeatTimer = setTimeout(again, REPEAT_EVERY_MS);
          };
          repeatTimer = setTimeout(again, REPEAT_DELAY_MS);
        }
      });
      panel.addEventListener("mousedown", (event) => event.preventDefault());
      // Also no scrolling, no synthesized mouse events and no click that could
      // land on the page once Hide has taken the keyboard away.
      panel.addEventListener("touchstart", (event) => event.preventDefault(), { passive: false });
      for (const type of ["pointerup", "pointercancel", "pointerleave"]) {
        panel.addEventListener(type, stopRepeat);
      }
      document.documentElement.appendChild(host);
      renderLayer();
    }

    function setPagePadding(px) {
      const style = document.documentElement.style;
      if (savedPadding === null) {
        savedPadding = { value: style.getPropertyValue("padding-bottom"), priority: style.getPropertyPriority("padding-bottom") };
      }
      style.setProperty("padding-bottom", `${px}px`, "important");
    }

    function restorePagePadding() {
      if (savedPadding === null) return;
      const style = document.documentElement.style;
      if (savedPadding.value) style.setProperty("padding-bottom", savedPadding.value, savedPadding.priority);
      else style.removeProperty("padding-bottom");
      savedPadding = null;
    }

    /** The focused field's top and bottom in this window, or null. */
    function fieldRect() {
      if (!focus.editable) return null;
      if (focus.frameId === 0) {
        const el = kioskTyping.focusedEditable();
        if (!el) return null;
        const rect = el.getBoundingClientRect();
        return { top: rect.top, bottom: rect.bottom };
      }
      // A field in a frame: its position in that frame, moved by where the
      // frame is (exact for one level of frames, close for deeper ones).
      const frame = document.activeElement;
      if (!frame || !["IFRAME", "FRAME"].includes(frame.tagName) || !focus.rect) return null;
      const offset = frame.getBoundingClientRect().top + frame.clientTop;
      return { top: offset + focus.rect.top, bottom: offset + focus.rect.bottom };
    }

    /**
     * Keep the field above the keyboard: room at the bottom of the page, then
     * scroll; a page that cannot scroll (a fixed, full-height layout) gets the
     * keyboard at the top instead when the field fits below it.
     */
    function reveal() {
      if (!visible || !panel) return;
      panel.classList.remove("top");
      const height = panel.offsetHeight;
      setPagePadding(height);
      const rect = fieldRect();
      if (!rect) return;
      const limit = window.innerHeight - height - FIELD_MARGIN_PX;
      if (rect.bottom <= limit) return;
      window.scrollBy(0, rect.bottom - limit);
      const after = fieldRect();
      if (after && after.bottom > limit && after.top > height + FIELD_MARGIN_PX) {
        panel.classList.add("top");
      }
    }

    function updateButton() {
      if (button) button.setAttribute("aria-pressed", visible ? "true" : "false");
    }

    function show(fromButton) {
      if (isLocked) return;
      build();
      if (fromButton) manual = true;
      if (document.documentElement.lastElementChild !== host) document.documentElement.appendChild(host);
      if (!visible) {
        visible = true;
        host.style.display = "block";
      }
      updateButton();
      requestAnimationFrame(reveal);
    }

    function hide(byPerson) {
      manual = false;
      // Hidden on purpose while a field has the focus: stay hidden until a
      // field is tapped or focused again.
      if (byPerson && focus.editable) dismissed = true;
      stopRepeat();
      if (!visible) return;
      visible = false;
      if (host) host.style.display = "none";
      if (panel) panel.classList.remove("top");
      restorePagePadding();
      updateButton();
    }

    function onFocus(frameId, info) {
      if (info.editable) {
        if (blurTimer) clearTimeout(blurTimer);
        blurTimer = null;
        focus = { frameId, editable: true, rect: info.rect || null, noKeyboard: Boolean(info.noKeyboard) };
        if (info.reason === "focus" || info.reason === "tap") dismissed = false;
        if (visible) requestAnimationFrame(reveal);
        else if (autoMode && !dismissed && !focus.noKeyboard) show(false);
        return;
      }
      // A late report from a frame the field has already left.
      if (focus.editable && frameId !== focus.frameId) return;
      if (blurTimer) clearTimeout(blurTimer);
      // Not at once: moving between two fields (or into a frame's field) is
      // a blur here and a focus there, which arrives a moment later.
      blurTimer = setTimeout(() => {
        blurTimer = null;
        focus = { frameId, editable: false, rect: null, noKeyboard: false };
        if (!manual) hide(false);
      }, HIDE_AFTER_BLUR_MS);
    }

    kioskTyping.onFocusChange(onFocus);

    return {
      bindButton(el) {
        button = el;
        updateButton();
      },
      toggle() {
        if (visible) hide(true);
        else show(true);
      },
      /** Called every sync with the agent's keyboardPresent === false. */
      setAutoMode(on) {
        if (on === autoMode) return;
        autoMode = on;
        if (on && focus.editable && !dismissed && !focus.noKeyboard) show(false);
        else if (!on && visible && !manual) hide(false);
      },
      setLocked(locked) {
        if (locked && visible) hide(false);
      },
      relabel() {
        if (panel) panel.setAttribute("aria-label", t("keyboard.title", "On-screen keyboard"));
        renderLabels();
      }
    };
  }

  const keyboard = createOnScreenKeyboard();

  let shadowRoot = null;

  // 3. Periodic Synchronization with local agent
  /*
   * A power schedule's switch-off, as the agent reports it: {at: ms, postponed}.
   * A countdown to the shutdown, or, while a system update is installing, a
   * note that it waits for the update. Hidden when nothing is under way.
   */
  function showPowerNotice(root, powerOff) {
    const notice = root.getElementById("power-notice");
    if (!notice) return;
    const at = powerOff && typeof powerOff === "object" ? Number(powerOff.at) : NaN;
    if (!Number.isFinite(at) || at <= 0) {
      notice.classList.add("hidden");
      return;
    }
    const countdown = root.getElementById("power-countdown");
    const text = root.getElementById("power-text");
    if (powerOff.postponed) {
      if (countdown) countdown.textContent = "";
      if (text) text.textContent = t("bar.power-off-postponed", "A system update is installing, so it waits for the update to finish and then switches off.");
    } else {
      const left = Math.max(0, Math.round((at - Date.now()) / 1000));
      if (countdown) {
        countdown.textContent = left > 0
          ? Math.floor(left / 60) + ":" + String(left % 60).padStart(2, "0")
          : t("bar.power-off-now", "Now");
      }
      if (text) text.textContent = t("bar.power-off-text", "The organization's power schedule switches it off in a few minutes. Save your work now.");
    }
    notice.classList.remove("hidden");
  }

  async function syncLoop() {
    try {
      // A hostile or merely over-eager page can remove our host node; rebuild it
      // rather than silently losing the lock curtain for the rest of the session.
      if (!document.getElementById("labkiosk-root")) {
        shadowRoot = null;
      }
      if (!shadowRoot && document.documentElement) {
        shadowRoot = initKioskUi() || null;
      }

      const { status: data } = await askAgent({ type: "labkiosk:status" });

      if (shadowRoot) {
        const dot = shadowRoot.getElementById("kiosk-dot");
        const netIcon = shadowRoot.getElementById("kiosk-net-icon");
        const btnNet = shadowRoot.getElementById("btn-network");

        if (data && data.isOnline) {
          offlineSince = null;
          if (dot) dot.classList.remove("offline");
          if (netIcon) netIcon.setAttribute("stroke", "#10b981");
          if (btnNet) btnNet.title = t("bar.network-connected-click-to-configure", "Network Connected (Click to configure)");
        } else {
          if (offlineSince === null) offlineSince = Date.now();
          if (dot) dot.classList.add("offline");
          if (netIcon) netIcon.setAttribute("stroke", "#ef4444");
          if (btnNet) btnNet.title = t("bar.network-offline-click-to-configure", "Network Offline (Click to configure)");

          // Measured in time, not ticks: offline, a status call can take several
          // seconds, so ticks would stretch the grace period unpredictably. A
          // locked screen stays locked rather than jumping to the wizard.
          const offlineFor = Date.now() - offlineSince;
          if (offlineFor > OFFLINE_REDIRECT_MS && !isAgentPage(window.location.href) && !(data && (data.isLocked || data.updateScreen))) {
            console.warn("[LabKiosk] Workstation offline for >6s, redirecting to network configuration");
            window.location.replace(`${AGENT_SETUP_URL}#offline`);
            return;
          }
        }

        // Client ID
        const cid = shadowRoot.getElementById("kiosk-client-id");
        if (cid && data.clientId) cid.textContent = data.clientId;

        // Lock Curtain & Bar Visibility
        const curtain = shadowRoot.getElementById("lock-curtain");
        const lockText = shadowRoot.getElementById("lock-text");
        const lockTitle = shadowRoot.getElementById("lock-title");
        const bar = shadowRoot.getElementById("kiosk-bar");
        // The curtain's own words, kept to put back after an update screen.
        if (lockTitle && !lockTitle.dataset.lockDefault) lockTitle.dataset.lockDefault = lockTitle.textContent;
        if (lockText && !lockText.dataset.lockDefault) lockText.dataset.lockDefault = lockText.textContent;
        const screen = data.updateScreen && typeof data.updateScreen === "object" ? data.updateScreen : null;
        if (curtain) {
          if (screen) {
            // A system update is installing (the workstation restarts by
            // itself) or finishing its first start. Nobody can use the screen
            // meanwhile, and nobody should switch it off.
            isLocked = true;
            curtain.classList.remove("hidden");
            if (bar) bar.classList.remove("visible");
            const version = typeof screen.version === "string" ? screen.version : "";
            if (lockTitle) {
              lockTitle.textContent = screen.kind === "finishing"
                ? t("bar.update-finishing-title", "Finishing a system update")
                : t("bar.update-installing-title", "Installing a system update");
            }
            if (lockText) {
              lockText.textContent = (screen.kind === "finishing"
                ? t("bar.update-finishing-text", "This workstation is checking its new software. It will be ready in a few minutes.")
                : t("bar.update-installing-text", "This workstation restarts by itself in a moment. Please do not switch it off.")) +
                (version ? " (" + version + ")" : "");
            }
          } else if (data.isLocked) {
            isLocked = true;
            curtain.classList.remove("hidden");
            if (bar) bar.classList.remove("visible");
            if (lockTitle) lockTitle.textContent = lockTitle.dataset.lockDefault;
            if (lockText) lockText.textContent = data.lockMessage || lockText.dataset.lockDefault;
          } else {
            isLocked = false;
            curtain.classList.add("hidden");
          }
        }
        keyboard.setLocked(isLocked);
        showPowerNotice(shadowRoot, data.powerOff);
        // No keyboard attached (the agent read /proc/bus/input/devices): the
        // on-screen keyboard opens by itself on a text field. Unknown (null)
        // and true leave it to the bar's button.
        keyboard.setAutoMode(data.keyboardPresent === false);
        // Printing: the agent says true only once Chromium may print, and
        // never behind the lock curtain.
        kioskPrint.enabled = data.printing === true && !isLocked;
        const btnPrint = shadowRoot.getElementById("btn-print");
        if (btnPrint) btnPrint.hidden = !kioskPrint.enabled;

        updateNavButtonStates(shadowRoot);

        // Remote reload command detection by epoch change
        const srvReloadEpoch = Number(data.reloadEpoch || 0);
        if (lastReloadEpoch === null) {
          lastReloadEpoch = srvReloadEpoch;
        } else if (srvReloadEpoch > 0 && srvReloadEpoch !== lastReloadEpoch) {
          lastReloadEpoch = srvReloadEpoch;
          try {
            sessionStorage.setItem("labkiosk_reload_epoch", String(srvReloadEpoch));
          } catch {}
          window.location.reload();
          return;
        }

        // High-priority broadcast detection by epoch or target change
        const srvEpoch = String(data.broadcastEpoch || 0);
        const storedEpoch = broadcastState.epoch || "0";
        const isNewEpoch = srvEpoch !== "0" && srvEpoch !== storedEpoch;
        const targetChanged = data.targetUrl && lastTargetUrl && data.targetUrl !== lastTargetUrl;

        if (isNewEpoch || (targetChanged && data.broadcastUrl)) {
          const safeTarget = httpUrlOrNull(data.broadcastUrl || data.targetUrl);

          if (safeTarget) {
            await storeBroadcastState(srvEpoch, safeTarget);
            lastTargetUrl = data.targetUrl;
            if (normalizeUrl(window.location.href) !== normalizeUrl(safeTarget)) {
              window.location.replace(safeTarget);
              return;
            }
          }
        } else if (srvEpoch === "0" && storedEpoch !== "0") {
          // Broadcast session ended / reset by operator.
          await clearBroadcastState();
          // The same protocol check as the branches above: targetUrl comes from
          // the control plane and ends up in location.replace(), so a
          // javascript: value here would run in whatever page the user is on.
          const safeTarget = httpUrlOrNull(data.targetUrl);
          if (safeTarget && normalizeUrl(window.location.href) !== normalizeUrl(safeTarget)) {
            window.location.replace(safeTarget);
            return;
          }
        } else if (data.targetUrl && lastTargetUrl && data.targetUrl !== lastTargetUrl) {
          const safeTarget = httpUrlOrNull(data.targetUrl);
          if (safeTarget && normalizeUrl(window.location.href) !== normalizeUrl(safeTarget)) {
            window.location.replace(safeTarget);
            return;
          }
        }
        lastTargetUrl = data.targetUrl;
      }
    } catch (e) {
      if (shadowRoot) {
        const dot = shadowRoot.getElementById("kiosk-dot");
        if (dot) dot.classList.add("offline");
        const netIcon = shadowRoot.getElementById("kiosk-net-icon");
        if (netIcon) netIcon.setAttribute("stroke", "#ef4444");
      }
    }
  }

  // Initialize
  function ensureKioskUi() {
    const root = initKioskUi();
    if (root) shadowRoot = root;
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", ensureKioskUi);
  } else {
    ensureKioskUi();
  }
  // Run one sync immediately so a locked screen stays locked across navigation
  // rather than flashing the page for a second first. The broadcast marker is
  // hydrated from the service worker first, so this tick does not mistake an
  // in-flight broadcast for a brand new one and redirect a second time.
  loadBroadcastState().then(syncLoop, syncLoop);

  setInterval(syncLoop, 1000);
})();
