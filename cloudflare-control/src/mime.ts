/**
 * Just enough of RFC 5322 / MIME to file an incoming support email: who sent
 * it, its subject and threading headers, and a readable plain-text body.
 *
 * The Worker has no runtime dependencies (Rule 1), so this is written here
 * rather than pulled from npm. It never executes or renders anything from the
 * message: HTML is reduced to text, attachments are listed by name and size
 * only (the forwarded copy keeps them), and every limit is explicit.
 */

export interface ParsedAddress {
  address: string;
  name: string;
}

export interface ParsedEmail {
  from: ParsedAddress | null;
  replyTo: ParsedAddress | null;
  subject: string;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  /** The readable body, quoted history removed when it can be recognised. */
  text: string;
  attachments: { filename: string; size: number }[];
  /** An auto-reply, bounce or list message (RFC 3834 `Auto-Submitted`, `Precedence`). */
  automated: boolean;
}

/** The longest body kept, in characters. */
export const MAX_BODY_CHARS = 20_000;
/** Nesting deeper than this is not followed (a hostile message can nest forever). */
const MAX_MIME_DEPTH = 8;
/** Parts examined per message. */
const MAX_MIME_PARTS = 64;

type HeaderMap = Map<string, string[]>;

interface Part {
  headers: HeaderMap;
  body: string; // binary string: one char per byte
}

/** Bytes as a string of char codes 0-255, so boundaries can be found without decoding. */
function bytesToBinary(bytes: Uint8Array): string {
  let out = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return out;
}

function binaryToBytes(binary: string): Uint8Array {
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i) & 0xff;
  return bytes;
}

function decodeCharset(bytes: Uint8Array, charset: string | undefined): string {
  const label = (charset || "utf-8").trim().toLowerCase();
  try {
    return new TextDecoder(label).decode(bytes);
  } catch {
    // An unknown label: UTF-8 is right far more often than any other guess.
    return new TextDecoder("utf-8").decode(bytes);
  }
}

function splitHeadersAndBody(binary: string): { head: string; body: string } {
  const crlf = binary.indexOf("\r\n\r\n");
  const lf = binary.indexOf("\n\n");
  if (crlf !== -1 && (lf === -1 || crlf <= lf)) return { head: binary.slice(0, crlf), body: binary.slice(crlf + 4) };
  if (lf !== -1) return { head: binary.slice(0, lf), body: binary.slice(lf + 2) };
  return { head: binary, body: "" };
}

function parseHeaders(head: string): HeaderMap {
  // Headers are ASCII, or UTF-8 under RFC 6532.
  const text = decodeCharset(binaryToBytes(head), "utf-8").replace(/\r?\n[ \t]+/g, " ");
  const map: HeaderMap = new Map();
  for (const line of text.split(/\r?\n/)) {
    const colon = line.indexOf(":");
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    const list = map.get(name);
    if (list) list.push(value);
    else map.set(name, [value]);
  }
  return map;
}

function header(headers: HeaderMap, name: string): string {
  return headers.get(name)?.[0] ?? "";
}

/** RFC 2047 encoded words (`=?utf-8?B?...?=`), adjacent ones joined as the RFC requires. */
export function decodeEncodedWords(value: string): string {
  const joined = value.replace(/(\?=)\s+(=\?)/g, "$1$2");
  return joined.replace(/=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g, (_m, charset: string, enc: string, data: string) => {
    try {
      const bytes =
        enc.toUpperCase() === "B"
          ? binaryToBytes(atob(data.replace(/\s+/g, "")))
          : binaryToBytes(
              data.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_x, hex: string) => String.fromCharCode(parseInt(hex, 16)))
            );
      return decodeCharset(bytes, charset.split("*")[0]);
    } catch {
      return data;
    }
  });
}

/** `type/subtype; a=b; c="d"` into its parts. Parameter names are lower-cased. */
function parseStructured(value: string): { value: string; params: Record<string, string> } {
  const params: Record<string, string> = {};
  const parts = value.match(/(?:[^;"]+|"(?:[^"\\]|\\.)*")+/g) || [];
  const head = (parts.shift() || "").trim().toLowerCase();
  for (const raw of parts) {
    const eq = raw.indexOf("=");
    if (eq === -1) continue;
    let name = raw.slice(0, eq).trim().toLowerCase();
    let val = raw.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1).replace(/\\(.)/g, "$1");
    // RFC 2231 `filename*=utf-8''name`, unsplit form only.
    if (name.endsWith("*")) {
      name = name.slice(0, -1);
      const match = val.match(/^([^']*)'[^']*'(.*)$/);
      if (match) {
        try {
          val = decodeCharset(
            binaryToBytes(match[2].replace(/%([0-9A-Fa-f]{2})/g, (_x, hex: string) => String.fromCharCode(parseInt(hex, 16)))),
            match[1] || "utf-8"
          );
        } catch {
          val = match[2];
        }
      }
    }
    params[name] = val;
  }
  return { value: head, params };
}

function decodeTransfer(body: string, encoding: string): Uint8Array {
  const enc = encoding.trim().toLowerCase();
  if (enc === "base64") {
    try {
      return binaryToBytes(atob(body.replace(/[^A-Za-z0-9+/=]/g, "")));
    } catch {
      return binaryToBytes(body);
    }
  }
  if (enc === "quoted-printable") {
    return binaryToBytes(
      body.replace(/=\r?\n/g, "").replace(/=([0-9A-Fa-f]{2})/g, (_x, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    );
  }
  return binaryToBytes(body);
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

/** HTML reduced to readable text. The result is shown with textContent, never as markup. */
export function htmlToText(html: string): string {
  let text = html;
  // Until nothing changes: removing one piece must not leave another behind (`<scr<script>ipt>`).
  for (let previous = ""; previous !== text; ) {
    previous = text;
    text = text
      .replace(/<(script|style|head|title)\b[\s\S]*?<\/\1\s*>/gi, "")
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|tr|h[1-6]|blockquote)\s*>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "- ")
      .replace(/<[^>]+>/g, "");
  }
  // Whatever is left is text; a decoded `&lt;` stays a character, shown with textContent.
  return text
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code: string) => {
      if (code[0] === "#") {
        const n = code[1].toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : "";
      }
      return ENTITIES[code.toLowerCase()] ?? m;
    })
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n");
}

/** Everything after the "On ... wrote:" line or an Outlook header block is the old thread. */
export function stripQuotedHistory(text: string): string {
  const markers = [
    /^On .{4,300}wrote:\s*$/m,
    /^-{2,}\s*Original Message\s*-{2,}\s*$/im,
    /^_{8,}\s*\n(From|De|Von):/m,
    /^From: .+\n(Sent|Date): .+\n(To): /m
  ];
  let cut = text.length;
  for (const marker of markers) {
    const m = marker.exec(text);
    if (m && m.index < cut) cut = m.index;
  }
  const kept = text.slice(0, cut).trimEnd();
  // A reply that is nothing but quoted history keeps the history.
  return kept.trim() ? kept : text;
}

function parseAddressHeader(value: string): ParsedAddress | null {
  const decoded = decodeEncodedWords(value).trim();
  if (!decoded) return null;
  const angled = decoded.match(/^(.*?)<\s*([^<>\s]+@[^<>\s]+)\s*>/);
  if (angled) {
    return { address: angled[2].toLowerCase(), name: angled[1].trim().replace(/^"(.*)"$/, "$1").replace(/\\(.)/g, "$1") };
  }
  const bare = decoded.match(/([^\s<>"(),;:]+@[^\s<>"(),;:]+)/);
  return bare ? { address: bare[1].toLowerCase(), name: "" } : null;
}

function messageIds(value: string): string[] {
  return value.match(/<[^<>\s]+>/g) || [];
}

interface Collected {
  plain: string | null;
  html: string | null;
  attachments: { filename: string; size: number }[];
  parts: number;
}

function walk(part: Part, depth: number, acc: Collected): void {
  if (depth > MAX_MIME_DEPTH || acc.parts >= MAX_MIME_PARTS) return;
  acc.parts++;
  const type = parseStructured(header(part.headers, "content-type") || "text/plain; charset=us-ascii");
  const disposition = parseStructured(header(part.headers, "content-disposition"));
  const filename = decodeEncodedWords(disposition.params.filename || type.params.name || "");

  if (type.value.startsWith("multipart/") && type.params.boundary) {
    const delimiter = "--" + type.params.boundary;
    const sections = part.body.split(delimiter);
    // sections[0] is the preamble; a section starting with "--" is the epilogue.
    for (const section of sections.slice(1)) {
      if (section.startsWith("--")) break;
      const trimmed = section.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
      const { head, body } = splitHeadersAndBody(trimmed);
      walk({ headers: parseHeaders(head), body }, depth + 1, acc);
    }
    return;
  }
  if (type.value === "message/rfc822") {
    // A forwarded message: its text is the content, its attachments are listed.
    const { head, body } = splitHeadersAndBody(part.body);
    walk({ headers: parseHeaders(head), body }, depth + 1, acc);
    return;
  }

  const bytes = decodeTransfer(part.body, header(part.headers, "content-transfer-encoding"));
  const isAttachment = disposition.value === "attachment" || (filename !== "" && !type.value.startsWith("text/"));
  if (isAttachment || !type.value.startsWith("text/")) {
    acc.attachments.push({ filename: filename || type.value || "attachment", size: bytes.length });
    return;
  }
  const text = decodeCharset(bytes, type.params.charset);
  if (type.value === "text/html") {
    if (acc.html === null) acc.html = text;
  } else if (acc.plain === null) {
    acc.plain = text;
  }
}

export function parseEmail(raw: Uint8Array): ParsedEmail {
  const { head, body } = splitHeadersAndBody(bytesToBinary(raw));
  const headers = parseHeaders(head);
  const acc: Collected = { plain: null, html: null, attachments: [], parts: 0 };
  walk({ headers, body }, 0, acc);

  const rawText = acc.plain !== null ? acc.plain : acc.html !== null ? htmlToText(acc.html) : "";
  const text = stripQuotedHistory(rawText.replace(/\r\n/g, "\n").trim()).slice(0, MAX_BODY_CHARS);

  const autoSubmitted = header(headers, "auto-submitted").toLowerCase();
  const precedence = header(headers, "precedence").toLowerCase();
  const inReplyTo = messageIds(header(headers, "in-reply-to"))[0] ?? null;

  return {
    from: parseAddressHeader(header(headers, "from")),
    replyTo: parseAddressHeader(header(headers, "reply-to")),
    subject: decodeEncodedWords(header(headers, "subject")).replace(/\s+/g, " ").trim().slice(0, 300),
    messageId: messageIds(header(headers, "message-id"))[0] ?? null,
    inReplyTo,
    references: messageIds((headers.get("references") || []).join(" ")).slice(-50),
    text,
    attachments: acc.attachments.slice(0, 50),
    automated:
      (autoSubmitted !== "" && autoSubmitted !== "no") ||
      precedence === "bulk" ||
      precedence === "junk" ||
      precedence === "list" ||
      headers.has("list-id")
  };
}
