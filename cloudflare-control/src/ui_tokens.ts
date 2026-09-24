/**
 * The single declaration of the platform's design language.
 *
 * Every surface -- the admin and super-admin consoles, the public landing page,
 * the user portal and the legal pages -- renders from the tokens below, so a
 * colour, radius or easing curve is defined once and changes everywhere.
 *
 * Before this module each of those four surfaces carried its own `:root` with
 * its own near-miss values (four different page backgrounds, three different
 * border greys), which is what made the product look like several products.
 *
 * `LEGACY_*_ALIASES` map each older surface's variable names onto the canonical
 * ones. They exist so the rules in `ui_landing.ts`, `ui_portal.ts` and
 * `ui_legal.ts` keep working unchanged while drawing from one palette; new CSS
 * should use the canonical names directly.
 */

/** Typography. Both faces are used across every surface. */
export const FONT_LINKS = `  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">`;

/**
 * The canonical tokens.
 *
 * `--text-subtle` is deliberately lighter than the slate-500 it used to be:
 * at #64748b it measured 3.2-3.7:1 against the three surfaces it is painted on,
 * below the 4.5:1 that WCAG 2.2 AA requires for the 11px section headings that
 * use it. #808fa6 clears 4.5:1 on all of them (4.68:1 on the worst, --bg-card).
 */
export const CORE_TOKENS = `      /* Surfaces */
      --bg-base: #080c14;
      --bg-rail: #0c121e;
      --bg-panel: #111827;
      --bg-surface: #141d2d;
      --bg-card: #1a2538;
      --bg-card-hover: #223049;

      /* Lines */
      --border-subtle: rgba(255, 255, 255, 0.08);
      --border: #2d3748;
      --border-focus: #3b82f6;

      /* Type */
      --text-main: #f8fafc;
      --text-muted: #94a3b8;
      --text-subtle: #808fa6;

      /* Accent & state */
      --accent: #3b82f6;
      --accent-hover: #2563eb;
      --accent-glow: rgba(59, 130, 246, 0.28);
      --accent-gradient: linear-gradient(135deg, #3b82f6, #6366f1);
      --success: #10b981;
      --success-glow: rgba(16, 185, 129, 0.2);
      --danger: #ef4444;
      --warning: #f59e0b;
      --neutral: #64748b;

      /* Geometry & motion */
      --radius: 12px;
      --radius-sm: 8px;
      --radius-lg: 20px;
      --rail-width: 72px;
      --subpanel-width: 272px;
      --ease-spring: cubic-bezier(0.16, 1, 0.3, 1);`;

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
 * Build the `:root` block for a surface: the canonical tokens plus, optionally,
 * that surface's legacy aliases.
 */
export function rootTokensCss(legacyAliases = ""): string {
  const aliases = legacyAliases ? `\n\n      /* Legacy aliases -> canonical tokens */\n${legacyAliases}` : "";
  return `    :root {\n${CORE_TOKENS}${aliases}\n    }`;
}
