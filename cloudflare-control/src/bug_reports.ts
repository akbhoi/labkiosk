/**
 * Automatic bug reports: workstation errors and warnings triaged into GitHub issues.
 *
 * Off for every organization until one of its administrators accepts the
 * Automatic Bug Report Terms and turns it on in Settings -> Errors & Warnings,
 * and unavailable on a platform that has not set up the AI binding,
 * GITHUB_ISSUES_TOKEN and GITHUB_ISSUES_REPO (fail closed).
 *
 * An issue recorded while its organization had opted in is marked 'pending'
 * (src/boot_report.ts). The hourly cron triages each pending one:
 *  - What leaves the platform is the kind of problem, the image version and the
 *    problem text with addresses, host names, e-mail addresses and identifiers
 *    masked. Never the organization, the workstation or anything a person typed.
 *  - The same redacted signature is linked to its issue without asking anyone.
 *  - Otherwise a reasoning model compares it with the open reports of the same
 *    kind: a match is linked to that issue (with one comment naming the new
 *    variant), anything else becomes a new issue whose title and summary it
 *    drafts. The facts are written into GitHub by this code, verbatim.
 *  - Each issue's status (open, in progress, PR created, resolved, closed) is
 *    read back from GitHub, so the console shows where a problem stands.
 */
import type { BugReportStatus, Env, WorkersAiBinding } from "./types";

/**
 * A reasoning model: slow is fine (the cron is hourly), cheap matters.
 * $0.35 per million input tokens and $0.75 per million output tokens as of
 * 2026-10 (developers.cloudflare.com/workers-ai/models/gpt-oss-120b).
 */
export const BUG_REPORT_AI_MODEL = "@cf/openai/gpt-oss-120b";
const AI_REASONING_EFFORT = "high";
const AI_MAX_OUTPUT_TOKENS = 6000;
/**
 * The Automatic Bug Report Terms an organization accepts (ui_legal.ts). Changing
 * the terms means a new version: reports pause until an administrator accepts it.
 */
export const BUG_REPORT_TERMS_VERSION = "2026-10-04";
/** Pending issues looked at per cron run. */
const MAX_ISSUES_PER_RUN = 20;
/** GitHub writes (new issues and comments) per run, so a burst cannot flood the repository. */
const MAX_GITHUB_WRITES_PER_RUN = 5;
/** Open reports of the same kind shown to the model for comparison. */
const MAX_CANDIDATES = 15;
/** GitHub issues whose status is read back per run, least recently checked first. */
const MAX_STATUS_CHECKS_PER_RUN = 10;
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

/** An open report the model may match a new problem to. */
export interface BugCandidate {
  issue_number: number;
  issue_url: string;
  title: string | null;
  problem: string | null;
  image_version: string | null;
  status: BugReportStatus;
  pr_url: string | null;
}

export type Triage =
  | { decision: "existing"; candidate: BugCandidate }
  | { decision: "new"; draft: BugDraft; drafted: "ai" | "template" };

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
  "You triage bug reports for Lab Kiosk, a Debian-based kiosk operating system that installs system images " +
  "side by side and rolls back an update whose first boot fails its health check. You are given one problem a " +
  "workstation reported and the open reports already filed for the same kind of problem, as JSON. Decide whether " +
  "the new problem has the same underlying cause as one of the existing reports. Different host names, addresses " +
  "or other masked values do not make problems different; a different failing component, error or cause does. " +
  "If it matches, reply with JSON only: " +
  '{"decision": "existing", "issue": <the existing report\'s issue number>}. ' +
  "If none matches, reply with JSON only: " +
  '{"decision": "new", "title": "...", "summary": "..."}: a title under 90 characters naming the problem, and ' +
  "a summary of two to four plain sentences on what happened and what a developer should look at first. " +
  "Use only the facts given. Do not invent versions, file names, logs or causes, and do not use markdown.";

/**
 * The text of a Workers AI reply. gpt-oss models answer in the Responses API
 * shape through the binding; older text models answer `{ response }`. Accept
 * the documented shapes and nothing else.
 */
export function modelText(result: unknown): string {
  if (typeof result === "string") return result;
  const r = (result || {}) as Record<string, any>;
  if (typeof r.response === "string") return r.response;
  if (typeof r.output_text === "string") return r.output_text;
  const choice = Array.isArray(r.choices) ? r.choices[0] : null;
  if (typeof choice?.message?.content === "string") return choice.message.content;
  if (Array.isArray(r.output)) {
    const texts: string[] = [];
    for (const item of r.output) {
      if (item?.type !== "message" || !Array.isArray(item.content)) continue;
      for (const part of item.content) {
        if (part?.type === "output_text" && typeof part.text === "string") texts.push(part.text);
      }
    }
    if (texts.length) return texts.join("\n");
  }
  throw new Error("the model returned no text");
}

function parseModelJson(text: string): Record<string, unknown> {
  const json = text.match(/\{[\s\S]*\}/);
  if (!json) throw new Error("the model did not return JSON");
  try {
    const parsed = JSON.parse(json[0]);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch (err: any) {
    throw new Error(`the model returned malformed JSON (${err?.message || err})`);
  }
}

/**
 * Ask the reasoning model whether a problem is already reported, and draft a
 * new report if it is not. Throws on anything it cannot use; a match must name
 * one of the candidates it was shown.
 */
export async function triageWithAi(ai: WorkersAiBinding, facts: BugFacts, candidates: BugCandidate[]): Promise<Triage> {
  const result = await ai.run(BUG_REPORT_AI_MODEL, {
    input: [
      { role: "system", content: AI_INSTRUCTIONS },
      {
        role: "user",
        content: JSON.stringify({
          newProblem: {
            kind: facts.kind,
            description: KIND_LABELS[facts.kind] || facts.kind,
            imageVersion: facts.imageVersion,
            problem: facts.problem
          },
          existingReports: candidates.map((c) => ({
            issue: c.issue_number,
            title: c.title,
            imageVersion: c.image_version,
            problem: c.problem,
            status: c.status
          }))
        })
      }
    ],
    reasoning: { effort: AI_REASONING_EFFORT },
    max_output_tokens: AI_MAX_OUTPUT_TOKENS
  });
  const answer = parseModelJson(modelText(result));
  if (answer.decision === "existing") {
    const match = candidates.find((c) => c.issue_number === answer.issue);
    if (!match) throw new Error(`the model named issue ${String(answer.issue)}, which it was not shown`);
    return { decision: "existing", candidate: match };
  }
  if (answer.decision !== "new") throw new Error("the model gave no decision");
  const { title, summary } = answer;
  if (typeof title !== "string" || typeof summary !== "string") throw new Error("the model left out the title or summary");
  const cleanedTitle = cleanTitle(title);
  const cleanedSummary = summary.trim().slice(0, MAX_SUMMARY_LENGTH);
  if (cleanedTitle.length < 8 || cleanedSummary.length < 20) throw new Error("the model's title or summary is too short");
  return { decision: "new", draft: { title: cleanedTitle, summary: cleanedSummary }, drafted: "ai" };
}

/** A code block no text can close early. */
function fenced(text: string): string {
  const longestRun = Math.max(2, ...[...text.matchAll(/~+/g)].map((m) => m[0].length));
  const fence = "~".repeat(longestRun + 1);
  return `${fence}text\n${text}\n${fence}`;
}

const REPORT_FOOTER =
  "Filed automatically by Lab Kiosk for an organization that accepted the Automatic Bug Report Terms. " +
  "Organization and workstation names, network addresses, host names and identifiers are left out.";

function factLines(facts: BugFacts): string[] {
  return [
    `- Kind: \`${facts.kind}\``,
    `- Image version: \`${facts.imageVersion || "unknown"}\``,
    `- Signature: \`${facts.signature.slice(0, 16)}\``,
    "",
    "Problem, as the workstation reported it (redacted):",
    "",
    fenced(facts.problem)
  ];
}

export function issueBody(facts: BugFacts, draft: BugDraft, drafted: "ai" | "template"): string {
  return [
    inertMarkdown(draft.summary),
    "",
    "### Report",
    "",
    ...factLines(facts),
    "",
    "---",
    REPORT_FOOTER +
      (drafted === "ai"
        ? " The first paragraph was drafted by Workers AI from the report above; the report itself is exact."
        : " The report is exact.")
  ].join("\n");
}

/** The comment that adds a matched variant to an existing issue. */
export function variantComment(facts: BugFacts): string {
  return [
    "Another workstation reported a problem that Workers AI matched to this issue.",
    "",
    ...factLines(facts),
    "",
    "---",
    REPORT_FOOTER
  ].join("\n");
}

export interface FiledIssue {
  number: number;
  url: string;
}

async function github(
  token: string,
  fetchImpl: typeof fetch,
  method: "GET" | "POST",
  url: string,
  body?: unknown
): Promise<unknown> {
  const res = await fetchImpl(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "labkiosk-controller",
      ...(body === undefined ? {} : { "Content-Type": "application/json" })
    },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const expected = method === "POST" ? 201 : 200;
  if (res.status !== expected) {
    throw new Error(`GitHub answered ${res.status} to ${method} ${new URL(url).pathname}: ${(await res.text()).slice(0, 200)}`);
  }
  return res.json();
}

export async function createGithubIssue(
  repo: string,
  token: string,
  title: string,
  body: string,
  fetchImpl: typeof fetch
): Promise<FiledIssue> {
  const data = (await github(token, fetchImpl, "POST", `https://api.github.com/repos/${repo}/issues`, { title, body })) as {
    number?: unknown;
    html_url?: unknown;
  };
  const prefix = `https://github.com/${repo}/issues/`;
  if (typeof data.number !== "number" || typeof data.html_url !== "string" || !data.html_url.startsWith(prefix)) {
    throw new Error("GitHub's reply did not name the new issue");
  }
  return { number: data.number, url: data.html_url };
}

/**
 * Where an issue stands on GitHub. Closed as completed is resolved, closed for
 * any other reason is closed; an open issue that a pull request in the same
 * repository references has a PR; one with an assignee or an "in progress"
 * label is in progress. `prUrl` is null when this check did not look.
 */
export async function readIssueStatus(
  repo: string,
  token: string,
  issueNumber: number,
  fetchImpl: typeof fetch
): Promise<{ status: BugReportStatus; prUrl: string | null }> {
  const issue = (await github(token, fetchImpl, "GET", `https://api.github.com/repos/${repo}/issues/${issueNumber}`)) as {
    state?: unknown;
    state_reason?: unknown;
    assignees?: unknown;
    labels?: unknown;
  };
  if (issue.state === "closed") {
    return { status: issue.state_reason === "completed" ? "resolved" : "closed", prUrl: null };
  }
  if (issue.state !== "open") throw new Error(`GitHub reported issue ${issueNumber} in state ${String(issue.state)}`);
  const timeline = (await github(
    token,
    fetchImpl,
    "GET",
    `https://api.github.com/repos/${repo}/issues/${issueNumber}/timeline?per_page=100`
  )) as unknown;
  if (!Array.isArray(timeline)) throw new Error(`GitHub's timeline for issue ${issueNumber} is not a list`);
  const pulls = `https://github.com/${repo}/pull/`;
  let prUrl: string | null = null;
  for (const event of timeline) {
    const source = event?.event === "cross-referenced" ? event?.source?.issue : null;
    if (source?.pull_request && typeof source.html_url === "string" && source.html_url.startsWith(pulls)) {
      prUrl = source.html_url;
    }
  }
  if (prUrl) return { status: "pr_open", prUrl };
  const assigned = Array.isArray(issue.assignees) && issue.assignees.length > 0;
  const labelled =
    Array.isArray(issue.labels) &&
    issue.labels.some((label: any) => typeof label?.name === "string" && /^in[ _-]?progress$/i.test(label.name.trim()));
  return { status: assigned || labelled ? "in_progress" : "open", prUrl: null };
}

export interface BugReportRun {
  /** New GitHub issues. */
  filed: number;
  /** New variants the model matched to an existing issue. */
  matched: number;
  /** Repeats of a signature already filed. */
  linked: number;
  /** Issues whose status was read back from GitHub. */
  refreshed: number;
}

async function openCandidates(db: D1Database, kind: string): Promise<BugCandidate[]> {
  const res = await db
    .prepare(
      `SELECT issue_number, MIN(issue_url) AS issue_url, MIN(title) AS title, MIN(problem) AS problem,
              MIN(image_version) AS image_version, MIN(status) AS status, MIN(pr_url) AS pr_url
         FROM bug_reports
        WHERE kind = ? AND status IN ('open', 'in_progress', 'pr_open')
        GROUP BY issue_number ORDER BY MAX(created_at) DESC LIMIT ?`
    )
    .bind(kind, MAX_CANDIDATES)
    .all<BugCandidate>();
  return res.results || [];
}

async function markSent(db: D1Database, issueId: string, signature: string, match: "new" | "existing"): Promise<void> {
  await db
    .prepare("UPDATE workstation_issues SET report_state = 'sent', bug_signature = ?, report_match = ? WHERE id = ?")
    .bind(signature, match, issueId)
    .run();
}

/** Read back where the least recently checked issues stand on GitHub. */
async function refreshStatuses(
  db: D1Database,
  repo: string,
  token: string,
  now: number,
  fetchImpl: typeof fetch
): Promise<number> {
  const due = await db
    .prepare(
      `SELECT issue_number FROM bug_reports GROUP BY issue_number ORDER BY MIN(status_checked_at), issue_number LIMIT ?`
    )
    .bind(MAX_STATUS_CHECKS_PER_RUN)
    .all<{ issue_number: number }>();
  let refreshed = 0;
  for (const { issue_number } of due.results || []) {
    let state: { status: BugReportStatus; prUrl: string | null };
    try {
      state = await readIssueStatus(repo, token, issue_number, fetchImpl);
    } catch (err: any) {
      console.error(`[BugReports] Reading issue ${issue_number} from GitHub failed; trying again next hour: ${err?.message || err}`);
      break;
    }
    await db
      .prepare("UPDATE bug_reports SET status = ?, pr_url = COALESCE(?, pr_url), status_checked_at = ? WHERE issue_number = ?")
      .bind(state.status, state.prUrl, now, issue_number)
      .run();
    refreshed++;
  }
  return refreshed;
}

/**
 * Triage the pending issues of organizations that are still opted in under the
 * current terms, then read back the status of filed issues. A GitHub or model
 * failure ends that part of the run; what is left waits for the next one.
 */
export async function processBugReports(
  db: D1Database,
  env: Env,
  now = Math.floor(Date.now() / 1000),
  fetchImpl: typeof fetch = fetch
): Promise<BugReportRun> {
  const run: BugReportRun = { filed: 0, matched: 0, linked: 0, refreshed: 0 };
  const repo = bugReportRepository(env);
  if (!repo) {
    if (env.GITHUB_ISSUES_REPO && !REPO_PATTERN.test(env.GITHUB_ISSUES_REPO.trim())) {
      console.error("[BugReports] GITHUB_ISSUES_REPO must be owner/repo; automatic bug reports are off.");
    }
    return run;
  }
  const token = env.GITHUB_ISSUES_TOKEN!;
  const pending = await db
    .prepare(
      `SELECT i.id, i.kind, i.image_version, i.details
         FROM workstation_issues i JOIN tenants t ON t.id = i.tenant_id
        WHERE i.report_state = 'pending' AND t.bug_reports_enabled = 1 AND t.bug_reports_terms_version = ?
        ORDER BY i.created_at LIMIT ?`
    )
    .bind(BUG_REPORT_TERMS_VERSION, MAX_ISSUES_PER_RUN)
    .all<{ id: string; kind: string; image_version: string | null; details: string | null }>();

  let writes = 0;
  for (const row of pending.results || []) {
    const problem = redactProblemText(row.details || "");
    const signature = await bugSignature(row.kind, row.image_version, problem);
    const facts: BugFacts = { kind: row.kind, imageVersion: row.image_version, problem, signature };
    const known = await db.prepare("SELECT issue_number FROM bug_reports WHERE signature = ?").bind(signature).first();
    if (known) {
      await markSent(db, row.id, signature, "existing");
      run.linked++;
      continue;
    }
    if (writes >= MAX_GITHUB_WRITES_PER_RUN) break;

    const candidates = await openCandidates(db, row.kind);
    let triage: Triage;
    try {
      triage = await triageWithAi(env.AI!, facts, candidates);
    } catch (err: any) {
      if (candidates.length) {
        // Filing without the comparison could duplicate an open report.
        console.error(`[BugReports] Workers AI could not triage a report; trying again next hour: ${err?.message || err}`);
        break;
      }
      console.warn(`[BugReports] Workers AI could not draft a report; using the template: ${err?.message || err}`);
      triage = { decision: "new", draft: templateDraft(facts), drafted: "template" };
    }

    try {
      if (triage.decision === "existing") {
        const target = triage.candidate;
        await github(token, fetchImpl, "POST", `https://api.github.com/repos/${repo}/issues/${target.issue_number}/comments`, {
          body: variantComment(facts)
        });
        writes++;
        await db
          .prepare(
            `INSERT INTO bug_reports (signature, kind, image_version, issue_number, issue_url, created_at, title, problem, status, pr_url)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(signature, row.kind, row.image_version, target.issue_number, target.issue_url, now, target.title, problem, target.status, target.pr_url)
          .run();
        await markSent(db, row.id, signature, "existing");
        run.matched++;
      } else {
        const issue = await createGithubIssue(
          repo,
          token,
          `[Workstation] ${triage.draft.title}`,
          issueBody(facts, triage.draft, triage.drafted),
          fetchImpl
        );
        writes++;
        await db
          .prepare(
            `INSERT INTO bug_reports (signature, kind, image_version, issue_number, issue_url, created_at, title, problem, status, status_checked_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?)`
          )
          .bind(signature, row.kind, row.image_version, issue.number, issue.url, now, triage.draft.title, problem, now)
          .run();
        await markSent(db, row.id, signature, "new");
        run.filed++;
      }
    } catch (err: any) {
      console.error(`[BugReports] Filing a report failed; trying again next hour: ${err?.message || err}`);
      break;
    }
  }

  run.refreshed = await refreshStatuses(db, repo, token, now, fetchImpl);
  return run;
}

/**
 * Turn an organization's bug reports on (recording the terms version it
 * accepted) or off; off also drops what was still waiting.
 */
export async function setBugReportsEnabled(db: D1Database, tenantId: string, enabled: boolean, now: number): Promise<void> {
  const statements = enabled
    ? [
        db
          .prepare(
            `UPDATE tenants SET bug_reports_enabled = 1, bug_reports_terms_version = ?, bug_reports_terms_accepted_at = ?, updated_at = ?
              WHERE id = ?`
          )
          .bind(BUG_REPORT_TERMS_VERSION, now, now, tenantId)
      ]
    : [
        db.prepare("UPDATE tenants SET bug_reports_enabled = 0, updated_at = ? WHERE id = ?").bind(now, tenantId),
        db
          .prepare("UPDATE workstation_issues SET report_state = 'none' WHERE tenant_id = ? AND report_state = 'pending'")
          .bind(tenantId)
      ];
  await db.batch(statements);
}
