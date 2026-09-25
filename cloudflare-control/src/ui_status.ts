/**
 * The one-message pages an organization address can answer with instead of its
 * homepage: not registered, suspended, or waiting for approval.
 *
 * They used to be inline HTML in the router with their own dark colours, so they
 * ignored the visitor's theme and drifted from every other page.
 */

import { escapeAttr, escapeHtml } from "./escape";
import { FONT_LINKS, rootTokensCss } from "./ui_tokens";

export interface StatusPageOptions {
  title: string;
  heading: string;
  /** Already-escaped markup: the caller escapes every organization-supplied value. */
  messageHtml: string;
  homeHref: string;
  tone?: "neutral" | "warning";
}

export function renderStatusPageHtml(options: StatusPageOptions): string {
  const { title, heading, messageHtml, homeHref, tone = "neutral" } = options;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="color-scheme" content="light dark">
  <title>${escapeHtml(title)}</title>
${FONT_LINKS}
  <style>
${rootTokensCss()}
    *, *::before, *::after { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      min-height: 100dvh;
      display: grid;
      place-items: center;
      padding: 24px;
      font-family: var(--font-sans);
      background: var(--bg-base);
      color: var(--text-main);
      -webkit-font-smoothing: antialiased;
    }
    .status-card {
      max-width: 520px;
      width: 100%;
      text-align: center;
      background: var(--bg-surface);
      border: 1px solid var(--border);
      border-radius: var(--radius-lg);
      box-shadow: var(--shadow-md);
      padding: 40px 32px;
    }
    .status-mark {
      width: 44px;
      height: 44px;
      margin: 0 auto 18px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      background: var(--bg-subtle);
      color: var(--text-muted);
    }
    .tone-warning .status-mark { background: var(--warning-soft); color: var(--warning-text); }
    h1 { font-size: 1.375rem; font-weight: 650; letter-spacing: -0.02em; margin: 0 0 10px; text-wrap: balance; }
    p { color: var(--text-muted); font-size: 0.9375rem; line-height: 1.6; margin: 0; text-wrap: pretty; }
    code { font-family: var(--font-mono); font-size: 0.875em; background: var(--bg-subtle); padding: 1px 6px; border-radius: var(--radius-xs); }
    strong { color: var(--text-main); }
    a {
      display: inline-flex;
      align-items: center;
      min-height: 40px;
      margin-top: 24px;
      padding: 0 18px;
      border-radius: var(--radius-sm);
      background: var(--accent);
      color: var(--accent-fg);
      font-weight: 600;
      font-size: 0.875rem;
      text-decoration: none;
    }
    a:hover { background: var(--accent-hover); }
    a:focus-visible { outline: 2px solid var(--border-focus); outline-offset: 2px; }
  </style>
</head>
<body>
  <main class="status-card tone-${tone}">
    <div class="status-mark" aria-hidden="true">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
    </div>
    <h1>${escapeHtml(heading)}</h1>
    <p>${messageHtml}</p>
    <a href="${escapeAttr(homeHref)}">Back to Homepage</a>
  </main>
</body>
</html>`;
}
