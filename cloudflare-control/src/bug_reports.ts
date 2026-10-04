/**
 * Automatic bug reports: workstation errors and warnings filed as GitHub issues.
 *
 * Off for every organization until one of its administrators turns it on in
 * Settings -> Errors & Warnings, and unavailable on a platform that has not set
 * up the AI binding, GITHUB_ISSUES_TOKEN and GITHUB_ISSUES_REPO (fail closed).
 *
 * An issue recorded while its organization had opted in is marked 'pending'
 * (src/boot_report.ts). The hourly cron files each pending one:
 *  - What leaves the platform is the kind of problem, the image version and the
 *    problem text with addresses, host names, e-mail addresses and identifiers
 *    masked. Never the organization, the workstation or anything a person typed.
 *  - Problems with the same redacted signature share one issue, whichever
 *    organizations report them.
 *  - Workers AI drafts the title and summary from those redacted facts only; the
 *    facts themselves are written into the issue by this code, verbatim.
 */
import type { Env, WorkersAiBinding } from "./types";

export const BUG_REPORT_AI_MODEL = "@cf/meta/llama-3.1-8b-instruct-fast";
/** Pending issues looked at per cron run. */
const MAX_ISSUES_PER_RUN = 20;
/** New GitHub issues per cron run, so a burst of distinct errors cannot flood the repository. */
const MAX_NEW_REPORTS_PER_RUN = 5;
const MAX_TITLE_LENGTH = 100;
const MAX_SUMMARY_LENGTH = 1200;
const REPO_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

/** Plain labels for the kinds src/boot_report.ts records. */
const KIND_LABELS: Record<string, string> = {
  update_failed: "System update failed its health check",
  update_rolled_back: "System update rolled back",
  boot_fallback: "Workstation started a fallback image",
  boot_error: "Boot record error"
};

/** The repository issues are filed in, or null when the feature is not set up. */
export function bugReportRepository(env: Env): string | null {
  if (!env.AI || !env.GITHUB_ISSUES_TOKEN || !env.GITHUB_ISSUES_REPO) return null;
  const repo = env.GITHUB_ISSUES_REPO.trim();
  return REPO_PATTERN.test(repo) ? repo : null;
}

/**
 * Mask what could identify an organization, a person or a machine. Applied to
 * text that is about to leave the platform; order matters (a URL contains a
 * host name, an e-mail address contains a domain).
 */
const REDACTIONS: ReadonlyArray<[RegExp, string]> = [
  [/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>"],
  [/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi, "<email>"],
  [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>"],
  [/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "<ip>"],
  // IPv6, compressed or not: a whole token of hex groups and at least two colons.
  [/(?<![\w:.])[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}(?![\w:])/gi, "<ip>"],
  [/\b[0-9a-f]{16,}\b/gi, "<hex>"],
  [/\b(?:[a-z0-9-]+\.){2,}[a-z]{2,}\b/gi, "<host>"]
];

export function redactProblemText(text: string): string {
  let out = text.replace(/[\u0000-\u001f\u007f]+/g, " ");
  for (const [pattern, mask] of REDACTIONS) out = out.replace(pattern, mask);
  return out.replace(/\s+/g, " ").trim();
}

/** One signature per distinct redacted problem. */
export async function bugSignature(kind: string, imageVersion: string | null, redacted: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(`${kind}\n${imageVersion || ""}\n${redacted}`)
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export interface BugFacts {
  kind: string;
  imageVersion: string | null;
  problem: string;
  signature: string;
}

export interface BugDraft {
  title: string;
  summary: string;
}

/** One line, no mentions; GitHub would notify whoever an `@name` names. */
function cleanTitle(text: string): string {
  return text
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/@/g, "@\u200b")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TITLE_LENGTH);
}

/**
 * Model output as inert text: no links, images, HTML, headings, mentions or
 * issue references, whatever the model wrote.
 */
function inertMarkdown(text: string): string {
  return text
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f]+/g, " ")
    .replace(/([\\`*_[\]<>!#|~])/g, "\\$1")
    .replace(/@/g, "@\u200b")
    .trim();
}

export function templateDraft(facts: BugFacts): BugDraft {
  const label = KIND_LABELS[facts.kind] || facts.kind;
  return {
    title: cleanTitle(`${label}${facts.imageVersion ? ` (${facts.imageVersion})` : ""}`),
    summary: facts.problem
  };
}

const AI_INSTRUCTIONS =
  "You write GitHub bug reports for Lab Kiosk, a Debian-based kiosk operating system that installs " +
  "system images side by side and rolls back an update whose first boot fails its health check. " +
  "You are given one problem a workstation reported, as JSON. Reply with JSON only, in the form " +
  '{"title": "...", "summary": "..."}: a title under 90 characters naming the problem, and a summary ' +
  "of two to four plain sentences on what happened and what a developer should look at first. " +
  "Use only the facts given. Do not invent versions, file names, logs or causes, and do not use markdown.";

/** Ask Workers AI for a title and summary; throws on anything it cannot use. */
export async function draftWithAi(ai: WorkersAiBinding, facts: BugFacts): Promise<BugDraft> {
  const result = await ai.run(BUG_REPORT_AI_MODEL, {
    messages: [
      { role: "system", content: AI_INSTRUCTIONS },
      {
        role: "user",
        content: JSON.stringify({
          kind: facts.kind,
          description: KIND_LABELS[facts.kind] || facts.kind,
          imageVersion: facts.imageVersion,
          problem: facts.problem
        })
      }
    ],
    max_tokens: 400
  });
  const response = (result as { response?: unknown } | null)?.response;
  if (typeof response !== "string") throw new Error("the model returned no text");
  const json = response.match(/\{[\s\S]*\}/);
  if (!json) throw new Error("the model did not return JSON");
  let parsed: unknown;
  try {
    parsed = JSON.parse(json[0]);
  } catch (err: any) {
    throw new Error(`the model returned malformed JSON (${err?.message || err})`);
  }
  const { title, summary } = (parsed || {}) as Record<string, unknown>;
  if (typeof title !== "string" || typeof summary !== "string") throw new Error("the model left out the title or summary");
  const cleanedTitle = cleanTitle(title);
  const cleanedSummary = summary.trim().slice(0, MAX_SUMMARY_LENGTH);
  if (cleanedTitle.length < 8 || cleanedSummary.length < 20) throw new Error("the model's title or summary is too short");
  return { title: cleanedTitle, summary: cleanedSummary };
}

/** A code block no text can close early. */
function fenced(text: string): string {
  const longestRun = Math.max(2, ...[...text.matchAll(/~+/g)].map((m) => m[0].length));
  const fence = "~".repeat(longestRun + 1);
  return `${fence}text\n${text}\n${fence}`;
}

export function issueBody(facts: BugFacts, draft: BugDraft, drafted: "ai" | "template"): string {
  return [
    inertMarkdown(draft.summary),
    "",
    "### Report",
    "",
    `- Kind: \`${facts.kind}\``,
    `- Image version: \`${facts.imageVersion || "unknown"}\``,
    `- Signature: \`${facts.signature.slice(0, 16)}\``,
    "",
    "Problem, as the workstation reported it (redacted):",
    "",
    fenced(facts.problem),
    "",
    "---",
    "Filed automatically by Lab Kiosk for an organization that turned on automatic bug reports. " +
      "Organization and workstation names, network addresses, host names and identifiers are left out. " +
      (drafted === "ai"
        ? "The first paragraph was drafted by Workers AI from the report above; the report itself is exact."
        : "The report is exact.")
  ].join("\n");
}

export interface FiledIssue {
  number: number;
  url: string;
}

export async function createGithubIssue(
  repo: string,
  token: string,
  title: string,
  body: string,
  fetchImpl: typeof fetch
): Promise<FiledIssue> {
  const res = await fetchImpl(`https://api.github.com/repos/${repo}/issues`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "labkiosk-controller",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ title, body })
  });
  if (res.status !== 201) {
    throw new Error(`GitHub answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  }
  const data = (await res.json()) as { number?: unknown; html_url?: unknown };
  const prefix = `https://github.com/${repo}/issues/`;
  if (typeof data.number !== "number" || typeof data.html_url !== "string" || !data.html_url.startsWith(prefix)) {
    throw new Error("GitHub's reply did not name the new issue");
  }
  return { number: data.number, url: data.html_url };
}

export interface BugReportRun {
  filed: number;
  linked: number;
}

/**
 * File the pending issues of organizations that are still opted in. A GitHub
 * failure ends the run with the rest left pending for the next one.
 */
export async function processBugReports(
  db: D1Database,
  env: Env,
  now = Math.floor(Date.now() / 1000),
  fetchImpl: typeof fetch = fetch
): Promise<BugReportRun> {
  const run: BugReportRun = { filed: 0, linked: 0 };
  const repo = bugReportRepository(env);
  if (!repo) {
    if (env.GITHUB_ISSUES_REPO && !REPO_PATTERN.test(env.GITHUB_ISSUES_REPO.trim())) {
      console.error("[BugReports] GITHUB_ISSUES_REPO must be owner/repo; automatic bug reports are off.");
    }
    return run;
  }
  const pending = await db
    .prepare(
      `SELECT i.id, i.kind, i.image_version, i.details
         FROM workstation_issues i JOIN tenants t ON t.id = i.tenant_id
        WHERE i.report_state = 'pending' AND t.bug_reports_enabled = 1
        ORDER BY i.created_at LIMIT ?`
    )
    .bind(MAX_ISSUES_PER_RUN)
    .all<{ id: string; kind: string; image_version: string | null; details: string | null }>();

  for (const row of pending.results || []) {
    const problem = redactProblemText(row.details || "");
    const signature = await bugSignature(row.kind, row.image_version, problem);
    const known = await db
      .prepare("SELECT issue_url FROM bug_reports WHERE signature = ?")
      .bind(signature)
      .first<{ issue_url: string }>();
    if (!known) {
      if (run.filed >= MAX_NEW_REPORTS_PER_RUN) break;
      const facts: BugFacts = { kind: row.kind, imageVersion: row.image_version, problem, signature };
      let draft: BugDraft;
      let drafted: "ai" | "template" = "ai";
      try {
        draft = await draftWithAi(env.AI!, facts);
      } catch (err: any) {
        console.warn(`[BugReports] Workers AI could not draft a report; using the template: ${err?.message || err}`);
        draft = templateDraft(facts);
        drafted = "template";
      }
      let issue: FiledIssue;
      try {
        issue = await createGithubIssue(
          repo,
          env.GITHUB_ISSUES_TOKEN!,
          `[Workstation] ${draft.title}`,
          issueBody(facts, draft, drafted),
          fetchImpl
        );
      } catch (err: any) {
        console.error(`[BugReports] Filing a GitHub issue failed; trying again next hour: ${err?.message || err}`);
        break;
      }
      await db
        .prepare(
          "INSERT INTO bug_reports (signature, kind, image_version, issue_number, issue_url, created_at) VALUES (?, ?, ?, ?, ?, ?)"
        )
        .bind(signature, row.kind, row.image_version, issue.number, issue.url, now)
        .run();
      run.filed++;
    } else {
      run.linked++;
    }
    await db
      .prepare("UPDATE workstation_issues SET report_state = 'sent', bug_signature = ? WHERE id = ?")
      .bind(signature, row.id)
      .run();
  }
  return run;
}

/** Turn an organization's bug reports on or off; off also drops what was still waiting. */
export async function setBugReportsEnabled(db: D1Database, tenantId: string, enabled: boolean, now: number): Promise<void> {
  const statements = [
    db.prepare("UPDATE tenants SET bug_reports_enabled = ?, updated_at = ? WHERE id = ?").bind(enabled ? 1 : 0, now, tenantId)
  ];
  if (!enabled) {
    statements.push(
      db
        .prepare("UPDATE workstation_issues SET report_state = 'none' WHERE tenant_id = ? AND report_state = 'pending'")
        .bind(tenantId)
    );
  }
  await db.batch(statements);
}
