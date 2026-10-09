/**
 * Markdown to HTML for the documentation pages (/docs), which are the
 * repository's `wiki/` folder rendered as it is written.
 *
 * It covers what those files use and nothing more: headings, paragraphs,
 * fenced code, lists (two levels), tables, block quotes, rules, and inline
 * code, bold, emphasis and links. No dependency (Rule 1), and no raw HTML:
 * every character of the source is escaped, so a `<script>` in a page is text.
 * A link is written only for an address `resolveLink` returns.
 */

import { escapeHtml } from "./escape";

export interface MarkdownHeading {
  level: number;
  id: string;
  text: string;
}

export interface RenderedMarkdown {
  html: string;
  headings: MarkdownHeading[];
}

/** Where a link's target leads, or null to show its text without a link. */
export type LinkResolver = (target: string) => { href: string; external: boolean } | null;

/** GitHub's anchor for a heading: lower case, spaces to hyphens, punctuation dropped. */
export function headingId(text: string): string {
  let id = "";
  for (const ch of text.toLowerCase()) {
    if ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9") || ch === "-" || ch === "_") id += ch;
    else if (ch === " ") id += "-";
  }
  return id;
}

/** Bold, emphasis and links in text that holds no code span. The text is escaped first. */
function inlineText(text: string, resolveLink: LinkResolver): string {
  let out = "";
  let rest = text;
  // Links are found by hand: "[" ... "](" ... ")", with no nesting.
  for (;;) {
    const open = rest.indexOf("[");
    const mid = open < 0 ? -1 : rest.indexOf("](", open);
    const close = mid < 0 ? -1 : rest.indexOf(")", mid);
    if (open < 0 || mid < 0 || close < 0 || rest.slice(open + 1, mid).includes("\n")) break;
    const label = rest.slice(open + 1, mid);
    const target = rest.slice(mid + 2, close).trim();
    const link = target && !/\s/.test(target) ? resolveLink(target) : null;
    out += emphasis(rest.slice(0, open));
    out += link
      ? `<a href="${escapeHtml(link.href)}"${link.external ? ' target="_blank" rel="noopener noreferrer"' : ""}>${emphasis(label)}</a>`
      : emphasis(label);
    rest = rest.slice(close + 1);
  }
  return out + emphasis(rest);
}

/** `**bold**` and `*emphasis*` in escaped text. */
function emphasis(text: string): string {
  const escaped = escapeHtml(text);
  let out = "";
  let i = 0;
  while (i < escaped.length) {
    if (escaped.startsWith("**", i)) {
      const end = escaped.indexOf("**", i + 2);
      if (end > i + 2) {
        out += `<strong>${escaped.slice(i + 2, end)}</strong>`;
        i = end + 2;
        continue;
      }
    } else if (escaped[i] === "*" && escaped[i + 1] !== " " && escaped[i + 1] !== undefined) {
      const end = escaped.indexOf("*", i + 1);
      if (end > i + 1 && escaped[end - 1] !== " ") {
        out += `<em>${escaped.slice(i + 1, end)}</em>`;
        i = end + 1;
        continue;
      }
    }
    out += escaped[i];
    i++;
  }
  return out;
}

/** One line of prose: code spans kept literal, the rest formatted. */
function inline(text: string, resolveLink: LinkResolver): string {
  const parts = text.split("`");
  // An odd number of backticks: the last one opens nothing, so it is a plain character.
  if (parts.length % 2 === 0) {
    const tail = parts.pop()!;
    parts[parts.length - 1] += "`" + tail;
  }
  return parts.map((part, index) => (index % 2 === 1 ? `<code>${escapeHtml(part)}</code>` : inlineText(part, resolveLink))).join("");
}

function tableCells(line: string): string[] {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|") && !row.endsWith("\\|")) row = row.slice(0, -1);
  const cells: string[] = [];
  let cell = "";
  let inCode = false;
  for (let i = 0; i < row.length; i++) {
    const ch = row[i];
    if (ch === "`") inCode = !inCode;
    if (ch === "\\" && row[i + 1] === "|") {
      cell += "|";
      i++;
    } else if (ch === "|" && !inCode) {
      cells.push(cell.trim());
      cell = "";
    } else {
      cell += ch;
    }
  }
  cells.push(cell.trim());
  return cells;
}

function isTableRule(line: string): boolean {
  const cells = tableCells(line);
  return line.includes("-") && cells.length > 0 && cells.every((c) => c.length > 0 && c.split("").every((ch) => ch === "-" || ch === ":" || ch === " "));
}

function listMarker(line: string): { indent: number; ordered: boolean; text: string } | null {
  const indent = line.length - line.trimStart().length;
  const body = line.slice(indent);
  if ((body.startsWith("- ") || body.startsWith("* ")) && body.length > 2) return { indent, ordered: false, text: body.slice(2) };
  let digits = 0;
  while (digits < body.length && body[digits] >= "0" && body[digits] <= "9") digits++;
  if (digits > 0 && digits < 4 && body.startsWith(". ", digits)) return { indent, ordered: true, text: body.slice(digits + 2) };
  return null;
}

export function renderMarkdown(markdown: string, resolveLink: LinkResolver): RenderedMarkdown {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const headings: MarkdownHeading[] = [];
  const usedIds = new Map<string, number>();
  const out: string[] = [];
  let i = 0;

  const isBlockStart = (line: string): boolean =>
    line.startsWith("#") || line.startsWith("```") || line.startsWith(">") || line.trim() === "---" || listMarker(line) !== null || line.trim().startsWith("|");

  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }

    // Fenced code: everything up to the closing fence, exactly as written.
    if (line.startsWith("```")) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) code.push(lines[i++]);
      i++;
      out.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
      continue;
    }

    // Headings.
    let level = 0;
    while (level < line.length && line[level] === "#") level++;
    if (level >= 1 && level <= 6 && line[level] === " ") {
      const text = line.slice(level + 1).trim();
      const plain = text.split("`").join("").split("*").join("");
      let id = headingId(plain) || "section";
      const seen = usedIds.get(id) || 0;
      usedIds.set(id, seen + 1);
      if (seen) id = `${id}-${seen}`;
      headings.push({ level, id, text: plain });
      out.push(`<h${level} id="${escapeHtml(id)}">${inline(text, resolveLink)}</h${level}>`);
      i++;
      continue;
    }

    if (line.trim() === "---") {
      out.push("<hr>");
      i++;
      continue;
    }

    // Tables: a header row, a rule, then rows.
    if (line.trim().startsWith("|") && i + 1 < lines.length && isTableRule(lines[i + 1])) {
      const header = tableCells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) rows.push(tableCells(lines[i++]));
      out.push(
        `<div class="docs-table"><table><thead><tr>${header.map((c) => `<th>${inline(c, resolveLink)}</th>`).join("")}</tr></thead><tbody>${rows
          .map((row) => `<tr>${header.map((_, col) => `<td>${inline(row[col] ?? "", resolveLink)}</td>`).join("")}</tr>`)
          .join("")}</tbody></table></div>`
      );
      continue;
    }

    // Block quotes.
    if (line.startsWith(">")) {
      const quote: string[] = [];
      while (i < lines.length && lines[i].startsWith(">")) quote.push(lines[i++].slice(1).trim());
      out.push(`<blockquote>${quote.filter(Boolean).map((q) => `<p>${inline(q, resolveLink)}</p>`).join("")}</blockquote>`);
      continue;
    }

    // Lists, with one level of nesting.
    const first = listMarker(line);
    if (first) {
      const tag = first.ordered ? "ol" : "ul";
      const items: string[] = [];
      while (i < lines.length) {
        const marker = listMarker(lines[i]);
        if (!marker || marker.indent > first.indent + 1) break;
        let text = marker.text;
        i++;
        const nested: string[] = [];
        let nestedTag = "ul";
        // Continuation lines and nested items belong to this item.
        while (i < lines.length && lines[i].trim() && lines[i].startsWith(" ")) {
          const inner = listMarker(lines[i]);
          if (inner && inner.indent > first.indent + 1) {
            nestedTag = inner.ordered ? "ol" : "ul";
            nested.push(`<li>${inline(inner.text, resolveLink)}</li>`);
          } else if (!inner && !lines[i].trim().startsWith("```")) {
            if (nested.length) nested[nested.length - 1] = nested[nested.length - 1].replace(/<\/li>$/, ` ${inline(lines[i].trim(), resolveLink)}</li>`);
            else text += ` ${lines[i].trim()}`;
          } else {
            break;
          }
          i++;
        }
        items.push(`<li>${inline(text, resolveLink)}${nested.length ? `<${nestedTag}>${nested.join("")}</${nestedTag}>` : ""}</li>`);
        // A blank line between items of the same list does not end it.
        if (i + 1 < lines.length && !lines[i].trim() && listMarker(lines[i + 1])?.indent === first.indent && listMarker(lines[i + 1])?.ordered === first.ordered) i++;
      }
      out.push(`<${tag}>${items.join("")}</${tag}>`);
      continue;
    }

    // A paragraph: lines up to a blank one or the start of another block.
    const paragraph: string[] = [line.trim()];
    i++;
    while (i < lines.length && lines[i].trim() && !isBlockStart(lines[i])) paragraph.push(lines[i++].trim());
    out.push(`<p>${inline(paragraph.join(" "), resolveLink)}</p>`);
  }

  return { html: out.join("\n"), headings };
}
