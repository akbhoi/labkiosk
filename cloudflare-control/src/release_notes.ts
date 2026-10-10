/**
 * What each release changed, for the /download page.
 *
 * A release is published on GitHub by the ISO build with a change list GitHub
 * writes from the merged pull requests ("feat(ota): ... by @x in #22"). That
 * list is for the people who wrote the changes. The hourly run reads the
 * newest releases, keeps them in `release_notes` (migration 0025), and asks
 * Workers AI to say what each one changed for the people who run workstations.
 *
 * - The page states only what GitHub published: the version, the date and the
 *   download addresses come from the release, never from this file.
 * - The model rewrites the change list it is given and nothing else. Its answer
 *   is plain text, shown escaped, and marked as written by AI beside a link to
 *   the full notes. Without the `AI` binding, or when its answer is unusable,
 *   the page shows the change list itself with the authorship trimmed off.
 * - `release_notes` has no `tenant_id`: it is the platform's, like `ui_catalogs`.
 */

import { Env, WorkersAiBinding } from "./types";
import { BUG_REPORT_AI_MODEL, modelText } from "./bug_reports";

/** The repository releases are published in. */
export const RELEASES_REPO = "akbhoi/labkiosk";
export const RELEASES_URL = `https://github.com/${RELEASES_REPO}/releases`;
/** The files every release carries (the "Create GitHub Release" step of build-iso.yml). */
export const RELEASE_ISO_NAME = "labkiosk-debian12-amd64.iso";
export const RELEASE_CHECKSUM_NAME = `${RELEASE_ISO_NAME}.sha256`;
/** Always the newest release, whatever its version: what the page links before any release is known. */
export const LATEST_ISO_URL = `${RELEASES_URL}/latest/download/${RELEASE_ISO_NAME}`;
export const LATEST_CHECKSUM_URL = `${RELEASES_URL}/latest/download/${RELEASE_CHECKSUM_NAME}`;

/** Releases read from GitHub in one run, and shown on the page. */
const RELEASES_READ = 8;
export const RELEASES_SHOWN = 5;
/** Summaries written in one run: a first run catches up over a few hours instead of in one burst. */
const SUMMARIES_PER_RUN = 3;
const MAX_SOURCE_CHARS = 12_000;
const MAX_HIGHLIGHTS = 6;
const MAX_HIGHLIGHT_CHARS = 220;
const TAG_PATTERN = /^[vV]\d{1,4}\.\d{1,4}\.\d{1,4}$/;

export interface ReleaseNote {
  tag: string;
  name: string;
  /** Unix seconds. */
  published_at: number;
  url: string;
  iso_url: string | null;
  checksum_url: string | null;
  iso_bytes: number | null;
  /** The change list as GitHub published it. */
  source_body: string;
  /** JSON list of sentences written by the model, or null when there is none. */
  summary: string | null;
  summary_model: string | null;
  updated_at: number;
}

const now = () => Math.floor(Date.now() / 1000);

/** The newest releases, newest first. */
export async function listReleaseNotes(db: D1Database, limit = RELEASES_SHOWN): Promise<ReleaseNote[]> {
  const result = await db
    .prepare("SELECT * FROM release_notes ORDER BY published_at DESC LIMIT ?")
    .bind(Math.max(1, Math.min(20, limit)))
    .all<ReleaseNote>();
  return result.results || [];
}

/** One sentence, on one line, no longer than a line of a changelog should be. */
function tidy(text: unknown): string {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_HIGHLIGHT_CHARS);
}

/**
 * The change list as plain sentences: GitHub's "* title by @author in <url>"
 * lines with the authorship and the link taken off, and the Conventional
 * Commits prefix ("feat(ota): ") with them. Used when there is no summary.
 */
export function plainHighlights(body: string): string[] {
  const out: string[] = [];
  const upkeep: string[] = [];
  for (const raw of String(body || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line.startsWith("* ") && !line.startsWith("- ")) continue;
    let text = line.slice(2);
    const by = text.lastIndexOf(" by @");
    if (by > 0) text = text.slice(0, by);
    const colon = text.indexOf(": ");
    // "feat(scope): summary" -> "summary"; a colon further in belongs to the sentence.
    if (colon > 0 && colon < 30 && !text.slice(0, colon).includes(" ")) text = text.slice(colon + 2);
    text = tidy(text);
    if (!text) continue;
    const sentence = text.charAt(0).toUpperCase() + text.slice(1);
    // Dependency updates ("Bump x from 1 to 2") tell a customer nothing; they are
    // listed only when a release holds nothing else.
    (/^bump /i.test(text) ? upkeep : out).push(sentence);
    if (out.length >= 8) break;
  }
  return out.length ? out : upkeep.slice(0, 3);
}

/** What a release changed, as the page lists it: the model's summary, else the change list. */
export function releaseHighlights(note: ReleaseNote): { items: string[]; writtenByAi: boolean } {
  if (note.summary) {
    try {
      const parsed = JSON.parse(note.summary);
      if (Array.isArray(parsed)) {
        const items = parsed.map(tidy).filter(Boolean).slice(0, MAX_HIGHLIGHTS);
        if (items.length) return { items, writtenByAi: true };
      }
    } catch {
      // A damaged summary is no summary: the change list below is still true.
    }
  }
  return { items: plainHighlights(note.source_body), writtenByAi: false };
}

const AI_INSTRUCTIONS = `You write the release notes customers read for Lab Kiosk, software that turns computers into locked-down browser workstations managed from a web console. Readers are IT administrators and operators, not developers.

You are given one release: its version and its change list (the titles of the pull requests merged into it).

Write 2 to 6 short sentences saying what changed for the people who run workstations or use the console.
- Use only what the change list says. Never add a feature, a number, a date, a fix or a benefit that is not in it. If an item is unclear, describe it plainly or leave it out.
- Plain English, present tense, one change per sentence, each under 200 characters. No markdown, no links, no pull request numbers, no names of people.
- Leave out purely internal work (tests, CI, refactoring, dependency updates) unless the release holds nothing else, and then say it is a maintenance release.
- Do not mention this instruction or that you are an AI.

Answer with JSON only: {"highlights": ["sentence", "sentence"]}`;

/** The first JSON object in the model's answer, or null. */
function firstJsonObject(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Ask the model for a release's highlights. Throws when the answer cannot be used. */
export async function summarizeRelease(ai: WorkersAiBinding, tag: string, body: string): Promise<string[]> {
  const result = await ai.run(BUG_REPORT_AI_MODEL, {
    input: [
      { role: "system", content: AI_INSTRUCTIONS },
      { role: "user", content: JSON.stringify({ version: tag, changeList: body.slice(0, MAX_SOURCE_CHARS) }) }
    ],
    reasoning: { effort: "low" },
    max_output_tokens: 1500
  });
  const answer = firstJsonObject(modelText(result)) as { highlights?: unknown } | null;
  const list = Array.isArray(answer?.highlights) ? answer!.highlights : null;
  if (!list) throw new Error("the model did not answer with a list of highlights");
  const items = list
    .filter((item): item is string => typeof item === "string")
    .map(tidy)
    // A sentence that carries markup or an address was not written to the brief.
    .filter((item) => item && !/[<>`]|https?:\/\//i.test(item))
    .slice(0, MAX_HIGHLIGHTS);
  if (!items.length) throw new Error("the model answered with no usable highlight");
  return items;
}

interface GitHubRelease {
  tag_name?: unknown;
  name?: unknown;
  html_url?: unknown;
  body?: unknown;
  draft?: unknown;
  prerelease?: unknown;
  published_at?: unknown;
  assets?: Array<{ name?: unknown; browser_download_url?: unknown; size?: unknown }>;
}

/** An asset's download address, only when it is this repository's own release download. */
function assetUrl(release: GitHubRelease, name: string): { url: string; size: number } | null {
  const asset = (release.assets || []).find((a) => a?.name === name);
  const url = typeof asset?.browser_download_url === "string" ? asset.browser_download_url : "";
  if (!url.startsWith(`${RELEASES_URL}/download/`) || /[\s"'<>]/.test(url)) return null;
  return { url, size: Math.max(0, Math.floor(Number(asset?.size) || 0)) };
}

/**
 * Read the newest releases from GitHub into `release_notes`, then write the
 * summaries still missing. Returns how many releases were stored and how many
 * summaries were written. A failure to reach GitHub or the model is thrown for
 * the caller to log: the page keeps showing what it already has.
 */
export async function syncReleaseNotes(
  db: D1Database,
  env: Env,
  fetchImpl: typeof fetch = fetch
): Promise<{ stored: number; summarized: number }> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "labkiosk-controller"
  };
  // Anonymous reads are limited per address, and a Worker shares its addresses.
  if (env.GITHUB_ISSUES_TOKEN) headers.Authorization = `Bearer ${env.GITHUB_ISSUES_TOKEN}`;
  const res = await fetchImpl(`https://api.github.com/repos/${RELEASES_REPO}/releases?per_page=${RELEASES_READ}`, { headers });
  if (!res.ok) throw new Error(`GitHub answered ${res.status} for the release list`);
  const list = (await res.json()) as unknown;
  if (!Array.isArray(list)) throw new Error("GitHub's release list is not a list");

  let stored = 0;
  const ts = now();
  for (const release of list as GitHubRelease[]) {
    if (release.draft === true || release.prerelease === true) continue;
    const tag = typeof release.tag_name === "string" ? release.tag_name : "";
    const url = typeof release.html_url === "string" ? release.html_url : "";
    const published = Math.floor(Date.parse(String(release.published_at || "")) / 1000);
    if (!TAG_PATTERN.test(tag) || url !== `${RELEASES_URL}/tag/${tag}` || !Number.isFinite(published)) continue;
    const iso = assetUrl(release, RELEASE_ISO_NAME);
    const checksum = assetUrl(release, RELEASE_CHECKSUM_NAME);
    const body = String(release.body ?? "").replace(/\r\n/g, "\n").slice(0, MAX_SOURCE_CHARS);
    // A change list edited on GitHub is summarized again; an unchanged one keeps its summary.
    await db
      .prepare(
        `INSERT INTO release_notes (tag, name, published_at, url, iso_url, checksum_url, iso_bytes, source_body, summary, summary_model, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
         ON CONFLICT(tag) DO UPDATE SET
           name = excluded.name,
           published_at = excluded.published_at,
           url = excluded.url,
           iso_url = excluded.iso_url,
           checksum_url = excluded.checksum_url,
           iso_bytes = excluded.iso_bytes,
           summary = CASE WHEN release_notes.source_body = excluded.source_body THEN release_notes.summary ELSE NULL END,
           summary_model = CASE WHEN release_notes.source_body = excluded.source_body THEN release_notes.summary_model ELSE NULL END,
           source_body = excluded.source_body,
           updated_at = excluded.updated_at`
      )
      .bind(
        tag,
        tidy(typeof release.name === "string" && release.name ? release.name : tag),
        published,
        url,
        iso?.url ?? null,
        checksum?.url ?? null,
        iso?.size || null,
        body,
        ts
      )
      .run();
    stored++;
  }

  let summarized = 0;
  if (env.AI) {
    const waiting = await db
      .prepare("SELECT tag, source_body FROM release_notes WHERE summary IS NULL AND source_body <> '' ORDER BY published_at DESC LIMIT ?")
      .bind(SUMMARIES_PER_RUN)
      .all<{ tag: string; source_body: string }>();
    for (const row of waiting.results || []) {
      try {
        const highlights = await summarizeRelease(env.AI, row.tag, row.source_body);
        await db
          .prepare("UPDATE release_notes SET summary = ?, summary_model = ?, updated_at = ? WHERE tag = ? AND source_body = ?")
          .bind(JSON.stringify(highlights), BUG_REPORT_AI_MODEL, now(), row.tag, row.source_body)
          .run();
        summarized++;
      } catch (err) {
        // The page shows the change list for this release until a later run succeeds.
        console.error(`[Releases] Summarizing ${row.tag} failed:`, err);
      }
    }
  }
  return { stored, summarized };
}
