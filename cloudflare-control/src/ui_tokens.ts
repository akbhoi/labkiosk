/**
 * The single declaration of the platform's design language.
 *
 * Every surface -- the admin and super-admin consoles, the public landing page,
 * the user portal, the organization homepage and the legal pages -- renders from
 * the tokens below, so a colour, radius or easing curve is defined once and
 * changes everywhere.
 *
 * There are two themes, light and dark. The page follows the visitor's system
 * setting (`color-scheme: light dark`) unless they pinned the other one with the
 * theme toggle, which sets `<html data-theme>`. Both themes are generated from
 * one table, `PALETTE`, so a token cannot exist in one theme and be missing from
 * the other: a colour written anywhere else is a colour that is right in one
 * theme and wrong in the other.
 *
 * `LEGACY_*_ALIASES` map each older surface's variable names onto the canonical
 * ones. They exist so the rules in `ui_landing.ts`, `ui_portal.ts` and
 * `ui_legal.ts` keep drawing from one palette; new CSS uses the canonical names.
 */

import { escapeAttr } from "./escape";

/** Typography: Inter for the interface, JetBrains Mono for ids, hosts and URLs. */
export const FONT_LINKS = `  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,400..700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">`;

/**
 * Every colour, as a `[light, dark]` pair.
 *
 * Solid hex values are used for anything text is painted on or painted with, so
 * the contrast test in `test/worker.test.ts` can measure them: every text token
 * clears WCAG 2.2 AA (4.5:1) on every surface in both themes, each `*-text`
 * clears it on its own `*-soft` tint, and `--border-input` clears the 3:1 a
 * form control's boundary needs. Translucent values are only used for overlays,
 * hovers and shadows, which carry no text of their own.
 *
 * The accent fill is the same blue in both themes on purpose: white text on the
 * brighter #3b82f6 a dark theme usually reaches for measures 3.7:1, which fails
 * AA on every primary button. Links and accent text use `--accent-text` instead.
 */
export const PALETTE: Readonly<Record<string, readonly [light: string, dark: string]>> = {
  // Surfaces, from the page canvas up.
  "--bg-base": ["#f7f7f8", "#09090b"],
  "--bg-rail": ["#ffffff", "#0e0e10"],
  "--bg-panel": ["#fbfbfc", "#111113"],
  "--bg-surface": ["#ffffff", "#161618"],
  "--bg-card": ["#ffffff", "#1b1b1e"],
  "--bg-card-hover": ["#f4f4f5", "#222226"],
  "--bg-subtle": ["#f4f4f5", "#1b1b1e"],

  // Lines.
  "--border-subtle": ["#ececef", "#222226"],
  "--border": ["#e2e2e6", "#2c2c31"],
  "--border-input": ["#8b8b95", "#6e6e78"],
  "--border-focus": ["#2563eb", "#3b82f6"],

  // Type.
  "--text-main": ["#18181b", "#f4f4f5"],
  "--text-muted": ["#52525b", "#a1a1aa"],
  "--text-subtle": ["#62626b", "#8e8e98"],

  // Accent.
  "--accent": ["#2563eb", "#2563eb"],
  "--accent-hover": ["#1d4ed8", "#1d4ed8"],
  "--accent-fg": ["#ffffff", "#ffffff"],
  "--accent-text": ["#1d4ed8", "#8ab4f8"],
  "--accent-soft": ["#eef4ff", "#172033"],

  // State: a fill for dots and solid buttons, a tint, and text for the tint.
  "--success": ["#16a34a", "#22c55e"],
  "--success-text": ["#15803d", "#4ade80"],
  "--success-soft": ["#effbf3", "#11251a"],
  "--warning": ["#d97706", "#f59e0b"],
  "--warning-text": ["#a16207", "#fbbf24"],
  "--warning-soft": ["#fff8eb", "#2a2010"],
  "--danger": ["#dc2626", "#dc2626"],
  "--danger-text": ["#b91c1c", "#f87171"],
  "--danger-soft": ["#fef2f2", "#2c1416"],
  "--neutral": ["#71717a", "#71717a"],
  "--on-solid": ["#ffffff", "#ffffff"],

  // Translucent layers: hovers, the modal scrim, shadows and the focus halo.
  "--hover": ["rgba(24, 24, 27, 0.045)", "rgba(255, 255, 255, 0.05)"],
  "--active": ["rgba(24, 24, 27, 0.08)", "rgba(255, 255, 255, 0.08)"],
  "--overlay": ["rgba(24, 24, 27, 0.4)", "rgba(0, 0, 0, 0.6)"],
  "--accent-glow": ["rgba(37, 99, 235, 0.22)", "rgba(59, 130, 246, 0.35)"],
  "--success-glow": ["rgba(22, 163, 74, 0.18)", "rgba(34, 197, 94, 0.2)"],
  "--shadow-sm": ["0 1px 2px rgba(16, 24, 40, 0.05)", "0 1px 2px rgba(0, 0, 0, 0.5)"],
  "--shadow-md": ["0 4px 12px rgba(16, 24, 40, 0.08), 0 1px 3px rgba(16, 24, 40, 0.06)", "0 4px 16px rgba(0, 0, 0, 0.45)"],
  "--shadow-lg": ["0 18px 48px rgba(16, 24, 40, 0.16), 0 2px 6px rgba(16, 24, 40, 0.06)", "0 20px 56px rgba(0, 0, 0, 0.6)"],
  "--thumb-scrim": ["#e9e9ec", "#101012"]
};

/** Everything that does not change with the theme. */
const INVARIANT_TOKENS = `      --accent-gradient: linear-gradient(135deg, var(--accent), #4f46e5);
      --focus-ring: 0 0 0 3px var(--accent-glow);

      --font-sans: "Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
      --font-mono: "JetBrains Mono", ui-monospace, "SFMono-Regular", Consolas, monospace;

      --radius: 10px;
      --radius-sm: 6px;
      --radius-xs: 4px;
      --radius-lg: 14px;
      --rail-width: 72px;
      --subpanel-width: 272px;
      --ease-spring: cubic-bezier(0.16, 1, 0.3, 1);
      --ease-out: cubic-bezier(0.2, 0, 0, 1);`;

function paletteCss(theme: 0 | 1, indent: string): string {
  return Object.entries(PALETTE)
    .map(([name, pair]) => `${indent}${name}: ${pair[theme]};`)
    .join("\n");
}

/** Names `ui_landing.ts` was written against. */
export const LEGACY_LANDING_ALIASES = `      --bg: var(--bg-base);
      --panel: var(--bg-panel);
      --card: var(--bg-card);
      --card-hover: var(--bg-card-hover);
      --text: var(--text-main);
      --muted: var(--text-muted);
      --green: var(--success);
      --green-glow: var(--success-glow);
      --amber: var(--warning);
      --red: var(--danger);`;

/** Names `ui_portal.ts` was written against. */
export const LEGACY_PORTAL_ALIASES = `      --bg-dark: var(--bg-base);
      --green: var(--success);`;

/** Names `ui_legal.ts` was written against. */
export const LEGACY_LEGAL_ALIASES = `      --bg: var(--bg-base);
      --surface: var(--bg-panel);
      --card: var(--bg-card);
      --text: var(--text-main);
      --muted: var(--text-muted);
      --green: var(--success);`;

/**
 * Build the token blocks for a surface: the light theme on `:root`, the dark
 * theme for a system that prefers it (unless the visitor pinned light), and
 * both pinned themes. Optionally with that surface's legacy aliases.
 */
export function rootTokensCss(legacyAliases = ""): string {
  const aliases = legacyAliases ? `\n\n      /* Legacy aliases -> canonical tokens */\n${legacyAliases}` : "";
  return `    :root {
      color-scheme: light dark;
${paletteCss(0, "      ")}

${INVARIANT_TOKENS}${aliases}
    }
    @media (prefers-color-scheme: dark) {
      :root:not([data-theme="light"]) {
${paletteCss(1, "        ")}
      }
    }
    :root[data-theme="dark"] {
      color-scheme: dark;
${paletteCss(1, "      ")}
    }
    :root[data-theme="light"] { color-scheme: light; }`;
}

/** Where the visitor's pinned theme is remembered, per origin. */
export const THEME_STORAGE_KEY = "labkiosk-theme";

/**
 * The `<head>` half of theming: tell the browser both schemes are supported
 * before it paints, and apply a pinned theme before first paint so a visitor
 * who chose the opposite of their system never sees a flash of the wrong one.
 * It must stay a plain, blocking script: `defer` or a module would run after
 * the first frame.
 */
export function themeHeadHtml(nonce: string): string {
  return `  <meta name="color-scheme" content="light dark">
  <script nonce="${escapeAttr(nonce)}">
    (function () {
      try {
        var pinned = localStorage.getItem("${THEME_STORAGE_KEY}");
        if (pinned === "light" || pinned === "dark") {
          document.documentElement.setAttribute("data-theme", pinned);
          document.querySelector('meta[name="color-scheme"]').setAttribute("content", pinned);
        }
      } catch (err) {
        // Storage is blocked (private window, site data cleared): the system theme applies.
      }
    })();
  </script>`;
}

/**
 * The theme toggle: any `[data-action="toggle-theme"]` button flips between the
 * system theme and its opposite. Choosing the opposite pins that exact theme
 * (a later change of the system setting does not flip the page back); choosing
 * the system's own theme again removes the pin. The button's
 * `[data-theme-label]` child names the theme a click switches to.
 *
 * Emitted inside a nonce'd `<script>` by every page that renders a toggle.
 */
export const THEME_TOGGLE_SCRIPT = `
    (function () {
      "use strict";
      var root = document.documentElement;
      var meta = document.querySelector('meta[name="color-scheme"]');
      var systemDark = window.matchMedia ? window.matchMedia("(prefers-color-scheme: dark)") : null;

      function systemTheme() { return systemDark && systemDark.matches ? "dark" : "light"; }
      function currentTheme() { return root.getAttribute("data-theme") || systemTheme(); }

      function relabel() {
        var next = currentTheme() === "dark" ? "light" : "dark";
        var buttons = document.querySelectorAll('[data-action="toggle-theme"]');
        for (var i = 0; i < buttons.length; i++) {
          var label = buttons[i].querySelector("[data-theme-label]");
          if (label) label.textContent = next === "dark" ? "Dark theme" : "Light theme";
          buttons[i].setAttribute("aria-label", "Switch to the " + next + " theme");
          buttons[i].setAttribute("data-next-theme", next);
        }
      }

      function apply(theme) {
        var pinned = theme !== systemTheme();
        if (pinned) root.setAttribute("data-theme", theme);
        else root.removeAttribute("data-theme");
        if (meta) meta.setAttribute("content", pinned ? theme : "light dark");
        try {
          if (pinned) localStorage.setItem("${THEME_STORAGE_KEY}", theme);
          else localStorage.removeItem("${THEME_STORAGE_KEY}");
        } catch (err) {
          // Storage is blocked: the choice lasts until the page is left.
        }
        relabel();
      }

      document.addEventListener("click", function (event) {
        var button = event.target && event.target.closest ? event.target.closest('[data-action="toggle-theme"]') : null;
        if (!button) return;
        event.preventDefault();
        apply(currentTheme() === "dark" ? "light" : "dark");
      });

      if (systemDark && systemDark.addEventListener) systemDark.addEventListener("change", relabel);
      relabel();
    })();
`;
