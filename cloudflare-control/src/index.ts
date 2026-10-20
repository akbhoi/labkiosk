/**
 * Multi-Tenant Lab Kiosk Cloudflare Controller & API
 * Manages Super Admin, Organization Tenant Admins, Subdomain Routing, User portals, and PC Telemetry.
 *
 * Authorization rules live in `guard.ts` and output escaping in `escape.ts`.
 * No route in this file may resolve a tenant or render untrusted data without them.
 */

import { WorkerEntrypoint } from "cloudflare:workers";
import { Env, LabConfig, ClientTelemetry, ClientDevice, Tenant, User, TenantUserRole, Session, AuditEntryMessage, UpdateChannel } from "./types";
import { renderDashboardHtml, AdminPageId } from "./ui";
import { renderPortalHtml } from "./ui_portal";
import { renderOrgHomeHtml } from "./ui_org_home";
import { renderSuperAdminHtml } from "./ui_super";
import {
  renderLandingHtml,
  renderFeaturesHtml,
  renderSpecsHtml,
  renderHardwareHtml,
  renderPricingHtml,
  renderDownloadHtml,
  renderDocsHtml,
  renderContactHtml,
  findDocsPage,
  docsPath,
  siteStylesheet,
  SITE_STYLESHEET_PATH,
  SOCIAL_IMAGE_PATH
} from "./ui_landing";
import { renderBugReportTermsHtml, renderContentPolicyHtml, renderDataProcessingAgreementHtml, renderPrivacyPolicyHtml, renderTermsOfServiceHtml } from "./ui_legal";
import { GEO_DATA_PATH, GEO_JSON } from "./geo";
import {
  FAVICON_PATH,
  ZARAZ_LOADER_PATH,
  allowsAnalytics,
  canonicalUrlFor,
  faviconSvg,
  bimiSvg,
  BIMI_PATH,
  isIndexable,
  isPlatformHost,
  canonicalHost,
  INDEXABLE_PATHS,
  robotsTxt,
  siteOrigin,
  sitemapXml
} from "./seo";

/** The platform's own public pages: served on the platform's address, redirected to it from anywhere else. */
const PLATFORM_PAGES: ReadonlySet<string> = new Set(["/features", "/specs", "/hardware", "/pricing", "/download", "/docs", "/wiki", "/contact"]);
/** Pages people type or link with a trailing slash; anything else with one is left to answer for itself. */
const SLASHLESS_PAGES: ReadonlySet<string> = new Set([...PLATFORM_PAGES, "/home", "/privacy", "/terms", "/content-policy", "/dpa", "/terms/bug-reports", "/admin", "/super"]);
import { renderStatusPageHtml } from "./ui_status";
import { NOVNC_PATH, renderRemoteViewerHtml } from "./ui_remote_viewer";
import { portalUrlFor, portalContextFrom } from "./portal_url";
import {
  classifyRelease,
  findRelease,
  isReleaseVersion,
  isUpdateChannel,
  listReleases,
  offeredRelease,
  offeredReleases,
  installsByItself,
  stableFeatureReleases,
  type SyncResult,
  confirmMajor,
  declineMajorRequest,
  endOrphanedMajorPilots,
  hasMajorPilot,
  releaseOfMajorOffered,
  requestMajor,
  setMajorPilot,
  workstationGroupsIn,
  isSupportStatus,
  isReleaseMajor,
  listMajorGrants,
  listReleaseMajors,
  majorAccess,
  MAX_RELEASE_MAJOR,
  newestOffered,
  organizationReleaseNotices,
  platformReleasePolicy,
  setMajorGrant,
  setMajorSupport,
  setReleaseMajorOpen,
  workstationsPerMajor,
  majorSupportNotice,
  listMajorSupport,
  effectiveSupportStatus,
  endOfLifeReminderStage,
  setEndOfLifeReminderStage,
  sendEndOfLifeReminders,
  releaseAddressIsDevelopmentOnly,
  releaseFolderUrl,
  securityReleasesPending,
  workstationOffer,
  revokeRelease,
  syncReleases,
  UPDATE_PHASES,
  UpdatePhase,
  UpdateReport
} from "./releases";

/** A workstation's last update report, as its registry row keeps it. */
function registryUpdate(row: ClientDevice | undefined): UpdateReport | undefined {
  const phase = row?.update_phase;
  if (!phase || !UPDATE_PHASES.includes(phase as UpdatePhase)) return undefined;
  return {
    phase: phase as UpdatePhase,
    ...(row.update_version ? { version: row.update_version } : {}),
    ...(row.update_progress !== null && row.update_progress !== undefined ? { progress: Number(row.update_progress) } : {}),
    ...(row.update_detail ? { detail: row.update_detail } : {}),
    ...(row.update_kind === "feature" || row.update_kind === "security" ? { kind: row.update_kind } : {}),
    ...(row.update_since ? { since: Number(row.update_since) } : {})
  };
}

/**
 * Tell every active organization with workstations online that the releases
 * changed, so each hub reloads its offer and reminds its workstations. One
 * with none online loads the offer when its first workstation connects.
 */
/** The organization's owner, or a staff member with the org_admin role, may accept legal terms for it. */
/** The session is an administrator of the organization: its owner or an `org_admin`. */
async function isOrganizationAdministrator(db: D1Database, session: Session, tenant: Tenant): Promise<boolean> {
  if (session.role === "super_admin") return false;
  if (tenant.user_id === session.user_id) return true;
  return (await getTenantUser(db, tenant.id, session.user_id))?.role === "org_admin";
}

/** The documents in force as the platform's Legal view shows them. */
async function platformLegalOverview(db: D1Database, superAdminId: string) {
  const [documents, counts, tenants] = await Promise.all([publishedLegalVersions(db), legalAcceptanceCounts(db), listAllTenants(db)]);
  return {
    noticeDays: LEGAL_NOTICE_DAYS,
    // The platform's own demos accept nothing.
    activeOrganizations: tenants.filter((t) => t.status === "active" && !isDemoTenant(t, superAdminId)).length,
    documents: documents.map((d) => ({
      id: d.id,
      title: d.title,
      path: d.path,
      version: d.version,
      required: d.required,
      publishedAt: d.publishedAt,
      effectiveAt: d.effectiveAt,
      notifiedAt: d.notifiedAt,
      acceptedBy: counts.get(`${d.id}@${d.version}`) ?? 0
    }))
  };
}

/**
 * Record the releases CI uploaded since the last look. A security release is
 * offered the moment it is recorded, so every hub with workstations online
 * reloads; a feature release waits for a super admin to classify it.
 */
async function recordNewReleases(env: Env, db: D1Database): Promise<SyncResult | null> {
  if (!env.RELEASES) return null;
  const sync = await syncReleases(env.RELEASES, db);
  for (const problem of sync.problems) console.error(`[Worker] Release ${problem.version} could not be recorded: ${problem.problem}`);
  if (sync.security.length) {
    await writeAuditLog(db, { tenantId: null, userId: null, action: "release.security_offered", details: sync.security.join(", ") });
    await notifyOrganizationsOnline(env, db);
  }
  return sync;
}

async function notifyOrganizationsOnline(env: Env, db: D1Database): Promise<void> {
  const tenants = (await listAllTenants(db)).filter((t) => t.status === "active" && Number(t.online_clients) > 0);
  for (let i = 0; i < tenants.length; i += 20) {
    const results = await Promise.allSettled(tenants.slice(i, i + 20).map((t) => notifyConfigChanged(env, t.id)));
    results.forEach((r, j) => {
      if (r.status === "rejected") console.error(`[Worker] Could not tell ${tenants[i + j].id}'s hub about a release change:`, r.reason);
    });
  }
}
import { addBlockedDomain, BLOCKLIST_DOMAIN_PATTERN, hostedLinkProblem, listLinkBlocklist, removeBlockedDomain } from "./link_rules";
import {
  acceptancesCsv,
  isLegalDocumentId,
  LEGAL_NOTICE_DAYS,
  legalAcceptanceCounts,
  listLegalAcceptances,
  organizationLegalStatus,
  publishedLegalVersions,
  recordLegalAcceptances
} from "./legal";
import {
  activeOrganizationOwners,
  createNotification,
  emailOrganizations,
  isNotificationKind,
  listNotificationsFor,
  listSentNotifications,
  markNotificationsRead,
  NOTIFICATION_LIMITS,
  type EmailOutcome
} from "./notifications";
import { isLicensePlan, licenseExpiredMessage, licensePlanLabel, licenseDate, licenseState, parseLicenseDate } from "./license";
import {
  initSchema,
  ensureSuperAdmin,
  ensureDemoTenants,
  findUserByEmail,
  findUserById,
  createUser,
  pepperLegacyPasswordHashes,
  findTenantBySubdomain,
  findTenantById,
  findTenantByUserId,
  createTenant,
  updateTenant,
  listAllTenants,
  createSession,
  getSession,
  deleteSession,
  deleteExpiredSessions,
  listPortalSites,
  findTakenDownPortalSite,
  listTakenDownPortalSites,
  setPortalSiteTakedown,
  createPortalSite,
  deletePortalSite,
  listClientDevices,
  deleteClientDevice,
  listWorkstationGroups,
  createWorkstationGroup,
  deleteWorkstationGroup,
  assignClientsToGroup,
  setClientsBroadcast,
  createDeviceToken,
  countEnrolledWorkstations,
  DEFAULT_WORKSTATION_LIMIT,
  MAX_WORKSTATION_LIMIT,
  MAX_REMOTE_CONTROL_SEATS,
  revokeDeviceTokensForClient,
  addWhitelistDomain,
  removeWhitelistDomain,
  buildEffectiveWhitelist,
  normalizeDomain,
  regenerateEnrollmentKey,
  rotateUncheckedEnrollmentKeys,
  writeAuditLog,
  useAuditQueue,
  insertAuditEntries,
  archiveOldAuditLogs,
  AUDIT_RETENTION_DAYS,
  HOMEPAGE_LIMITS,
  parseHomepageBlocks,
  sanitizeHomepageBlocks,
  listPlatformAuditLogs,
  listUiCatalogs,
  getUiCatalog,
  putUiCatalog,
  deleteUiCatalog,
  listAuditLogs,
  recordLoginFailure,
  clearLoginFailures,
  getLockoutRemaining,
  findTenantByCustomDomain,
  findTenantByEnrollmentKey,
  requestCustomDomain,
  approveCustomDomain,
  rejectCustomDomain,
  removeCustomDomain,
  listBroadcastPresets,
  createBroadcastPreset,
  deleteBroadcastPreset,
  updateUserPassword,
  deleteSessionsForUser,
  rateLimitWait,
  recordRateLimitHit,
  purgeStaleLoginAttempts,
  assertSchemaCurrent,
  LOCAL_DEV_SUPER_ADMIN,
  listTenantUsers,
  createTenantUser,
  updateTenantUser,
  deleteTenantUser,
  getTenantUser,
  getTenantUserPermissions,
  findTenantUserById
} from "./db";
import {
  verifyPassword,
  generateSessionToken,
  parseCookies,
  timingSafeEqual,
  sha256Hex,
  validatePasswordStrength,
  breachedPasswordProblem,
  passwordPepper,
  PEPPERED_HASH_PREFIX,
  isPlausibleEmail,
  isEnrollmentKey,
  generateNonce
} from "./auth";
import {
  resolveTenant,
  requireSuperAdmin,
  requireTenantAdmin,
  requireTenantPermission,
  requireDevice,
  forgetDeviceToken,
  jsonError,
  hostname,
  hostSubdomain,
  isDevHost,
  isHostUnder,
  isReservedSlug,
  superAdminHost,
  rejectCrossSiteMutation,
  rejectCrossSiteSocket
} from "./guard";
import {
  getWorkstationIssueLog,
  listWorkstationIssues,
  parseBootReport,
  parseRestartReport,
  parseDiskHealthReport,
  parseVideoDecodingReport,
  recordVideoDecoding,
  storedVideoDecoding,
  recordDiskHealthReport,
  purgeOldWorkstationIssues,
  recordBootReport,
  recordRestartReport,
  WORKSTATION_ISSUE_RETENTION_DAYS
} from "./boot_report";
import { BUG_REPORT_TERMS_VERSION, bugReportRepository, processBugReports, setBugReportsEnabled } from "./bug_reports";
import { majorDownloads, storeReleaseNotes, syncReleaseNotes } from "./release_notes";
import { escapeHtml, cleanSubdomain, cleanCustomDomain, safeHttpUrl } from "./escape";
import { getDatabase } from "./database";
import { hubJson, hubRequest, hubUpgrade, notifyConfigChanged, requiredBindingsProblem } from "./hub";
import { LiveStatus } from "./org_hub";
import {
  RELAY_JOIN_SECONDS,
  RELAY_MAX_SECONDS,
  RELAY_TOKEN_PATTERN,
  closeRelaySession,
  hashRelayToken,
  newRelayToken,
  openRelaySession,
  relayUpgrade
} from "./remote_relay";
import { isPlatformHostname, startCustomHostnameJob } from "./custom_hostnames";
import { HANDOFF_PATH, clearSessionCookies, createSessionCookie, handleSessionHandoff, sessionCookieName } from "./session_handoff";
import { mailConfigProblem, sendMail } from "./mail";
import { consoleStylesheet, CONSOLE_STYLESHEET_PATH } from "./ui_layout";
import { PALETTE } from "./ui_tokens";

// The Durable Object and Workflow classes wrangler binds (wrangler.jsonc).
export { OrgHub } from "./org_hub";
export { RemoteRelay } from "./remote_relay";
export { CustomHostnameWorkflow } from "./custom_hostname_workflow";

/**
 * The entrypoint the `labkiosk-email-routing` Worker (cloudflare-email-routing/)
 * calls over its Service Binding once it has stored an incoming message in R2:
 * the controller files it into Mail and answers what it did, so that Worker
 * knows whether to forward the owner a copy. Not reachable from the internet.
 */
export class MailIntake extends WorkerEntrypoint<Env> {
  async file(id: string, from: string, to: string): Promise<IntakeResult> {
    const db = getDatabase(this.env);
    await bootstrap(db, this.env);
    useAuditQueue(this.env.AUDIT_QUEUE);
    return fileStoredInboundMail(this.env, db, id, from, to);
  }
}
import { DEMO_SLUGS, DemoSlug, defaultDemoSlug, isDemoSlug, isDemoTenant } from "./demo";
import { handleContactEmailCode, handleContactForm, handleRegister, handleRemoteControlRequest, handleSignupEmailCode, RouteContext } from "./signup";
import { fileStoredInboundMail, fileStrandedInboundMail, handleInboundEmail, handleInboxRoute, InboundMessage, IntakeResult, isInboxRoute } from "./inbox";
import { inboxCounts, purgeExpiredEmailCodes } from "./conversations";
import { TURNSTILE_ORIGIN, turnstileRefusal, turnstileSiteKey } from "./turnstile";
import {
  hardwareModelsComputedAt,
  listHardwareModels,
  listPublicHardwareModels,
  parseHardwareReport,
  rebuildHardwareModels,
  recordHardware,
  storedHardware
} from "./hardware";
import {
  deleteUsageSites,
  MAX_REPORT_DAYS,
  parseUsageReport,
  platformUsage,
  purgeOldUsage,
  recordUsage,
  reportPeriod,
  rollUpPlatformUsage,
  usageSummary
} from "./usage";
import {
  continueSignIn,
  handleLoginEmailCode,
  handleLoginPasskeyOptions,
  handleLoginVerify,
  handleTwoFactorRoute,
  isTwoFactorRoute,
  purgeExpiredLoginChallenges,
  revokeTrustedBrowsers
} from "./two_factor";

/** Commands an admin console is allowed to dispatch. */
const ALLOWED_COMMANDS = new Set(["lock", "unlock", "navigate", "reload", "reboot", "shutdown", "clear-session", "mute"]);

/**
 * Most workstations one request may address. A room is tens of machines;
 * the cap keeps one request from queueing an unbounded number of D1 writes.
 */
const MAX_BATCH_TARGETS = 500;

/**
 * D1 allows at most 100 bound parameters per statement, so an `IN (...)` list
 * is written in slices that leave room for the statement's other parameters.
 */
const D1_IN_LIST_CHUNK = 90;

/** Longest workstation group name, matching what the console accepts. */
const MAX_GROUP_NAME_LENGTH = 50;

/** A person's or an organization's display name, as registration caps it. */
const MAX_PERSON_NAME_LENGTH = 120;

/**
 * The permissions a staff account may hold. `*` is never stored: full access
 * comes only from owning the organization or holding the `org_admin` role.
 */
const STAFF_PERMISSIONS = new Set(["workstations", "broadcast", "portal", "whitelist", "staff", "settings", "updates"]);
const STAFF_ROLES = new Set<TenantUserRole>(["org_admin", "sub_admin", "operator", "assistant", "content_manager"]);

/** A permissions array from a request, or null when it holds anything unknown. */
function parseStaffPermissions(raw: unknown): string[] | null {
  if (!Array.isArray(raw)) return null;
  const permissions = Array.from(new Set(raw.map((p) => String(p))));
  return permissions.every((p) => STAFF_PERMISSIONS.has(p)) ? permissions : null;
}

/**
 * Why the caller may not hand out this role and these permissions, or null.
 *
 * `staff` is the permission to manage staff. Without this check a delegate
 * holding it could create an `org_admin` -- whose permissions are `*` -- or
 * promote their own account to one, and take over the organization's settings and
 * enrolment key. A delegate may only grant what they hold themselves, may not
 * appoint a co-administrator, and may not edit their own account or a
 * co-administrator's. The organization's owner and its co-administrators may.
 */
async function staffDelegationProblem(
  db: D1Database,
  session: Session,
  tenant: Tenant,
  change: { role?: TenantUserRole; permissions?: string[]; target?: { user_id: string; role: TenantUserRole } }
): Promise<string | null> {
  const actorPermissions = session.role === "super_admin"
    ? ["*"]
    : await getTenantUserPermissions(db, tenant.id, session.user_id);
  if (actorPermissions.includes("*")) return null;

  if (change.target) {
    if (change.target.user_id === session.user_id) return "You cannot change your own staff account";
    if (change.target.role === "org_admin") return "Only an organization administrator can change a co-administrator";
  }
  if (change.role === "org_admin") return "Only an organization administrator can appoint a co-administrator";
  const beyond = (change.permissions || []).filter((p) => !actorPermissions.includes(p));
  if (beyond.length) return `You cannot grant permissions you do not hold: ${beyond.join(", ")}`;
  return null;
}

/**
 * A demo keeps its name and stays active: the simulators, VMs and tests that use it
 * are enrolled against that name, and renaming one would also stop it being a demo.
 */
const DEMO_LOCKED_MESSAGE = "The platform's demo organizations keep their names and cannot be suspended or rejected";

/**
 * Remote Control is an add-on the platform approves per organization (Tasks).
 * Every way into a session -- the viewer page, opening a session, the
 * viewer's socket -- is refused until it has been approved, and to anyone but the
 * organization's administrators (its owner and `org_admin` staff).
 */
async function remoteControlRefusal(
  db: D1Database,
  session: Session,
  tenant: Tenant,
  headers: Record<string, string>
): Promise<Response | null> {
  // Only the organization's administrators, never other staff; a super admin only in a demo (the guard).
  if (session.role !== "super_admin" && !(await isOrganizationAdministrator(db, session, tenant))) {
    return jsonError("Only an administrator of the organization can use Remote Control", 403, headers);
  }
  if (tenant.remote_control_status !== "approved") {
    return jsonError(
      "Remote Control is not enabled for this organization. An administrator can request it under Settings.",
      403,
      headers
    );
  }
  const licenseEnded = licenseExpiredMessage(tenant);
  return licenseEnded ? jsonError(licenseEnded, 403, headers) : null;
}

/**
 * End every Remote Control session an organization has open, for Remote Control
 * being turned off: its OrgHub gives back the workstations holding a seat, and
 * each one's relay closes both sides. Returns how many were closed.
 */
async function closeAllRemoteSessions(env: Env, tenantId: string): Promise<number> {
  const { clientIds } = await hubJson<{ clientIds: string[] }>(env, tenantId, "/remote-revoke", {});
  if (!env.REMOTE_RELAY) return 0;
  const closed = await Promise.all(clientIds.map((clientId) => closeRelaySession(env, tenantId, clientId)));
  return closed.filter(Boolean).length;
}

/** Every organization's name by id, for the platform's views. */
async function tenantNames(db: D1Database): Promise<Map<string, string>> {
  const rows = (await db.prepare("SELECT id, name FROM tenants").all<{ id: string; name: string }>()).results || [];
  return new Map(rows.map((t) => [t.id, t.name]));
}

/** DNS label limit; a longer organization slug can never resolve. */
const MAX_SUBDOMAIN_LENGTH = 63;

/** Public registration: attempts allowed per source address per window. */
const REGISTER_RATE_LIMIT = { limit: 10, windowSeconds: 3600 };
/** Failed enrolments allowed per source address per window before the endpoint answers 429. */
const ENROLL_FAILURE_RATE_LIMIT = { limit: 10, windowSeconds: 900 };

/**
 * One-time startup work, memoized per isolate.
 * Previously this ran on every request, costing ~10 D1 round-trips before the
 * router even looked at the path.
 */
type Bootstrapped = { superAdmin: User; demos: Tenant[] };
let bootstrapCache: {
  db: D1Database;
  email?: string;
  password?: string;
  promise: Promise<Bootstrapped>;
} | null = null;
function bootstrap(db: D1Database, env: Env): Promise<Bootstrapped> {
  const email = env.SUPER_ADMIN_EMAIL?.trim();
  const password = env.SUPER_ADMIN_PASSWORD;

  // Memoized per database instance and credentials.
  if (
    !bootstrapCache ||
    bootstrapCache.db !== db ||
    bootstrapCache.email !== email ||
    bootstrapCache.password !== password
  ) {
    const promise = (async () => {
      // Idempotent CREATE TABLE IF NOT EXISTS, so `wrangler dev` works against a
      // fresh local D1 with no migration step. This is memoized per isolate, so
      // it costs one pass at startup rather than ~10 round-trips on every
      // request as it previously did. `migrations/` remains authoritative for
      // schema changes to an already-deployed database.
      const production = Boolean(env.DB) && env.ALLOW_LOCAL_DB !== "1";
      if (production) {
        // A deployed worker never creates its own tables; migrations/ is the
        // only writer of the production schema. Refuse to serve on drift.
        await assertSchemaCurrent(db);
      } else {
        await initSchema(db);
      }

      // Rule 7 (fail closed): a well-known super admin password is acceptable
      // only for the in-memory database used by tests and local development.
      if (production && (!email || !password)) {
        throw new Error(
          "SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD must both be set as Wrangler secrets before the worker can serve production traffic (`npx wrangler secret put SUPER_ADMIN_EMAIL`, then SUPER_ADMIN_PASSWORD). Refusing to seed the well-known default account."
        );
      }
      // Live control, audit history and custom domains all depend on these.
      if (production) {
        const missing = requiredBindingsProblem(env);
        if (missing) throw new Error(missing);
        // A misspelt console host is a startup error, not a console nobody can reach.
        superAdminHost(env);
      }
      if (!production && (Boolean(email) !== Boolean(password))) {
        throw new Error("SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD must be set together, or both left unset for local development.");
      }
      const superAdmin = await ensureSuperAdmin(
        db,
        email && password ? { email, password } : LOCAL_DEV_SUPER_ADMIN,
        passwordPepper(env)
      );
      const demos = await ensureDemoTenants(db, superAdmin.id);
      return { superAdmin, demos };
    })().catch((err) => {
      // Never cache a failed bootstrap, or the isolate stays broken forever.
      if (bootstrapCache?.promise === promise) bootstrapCache = null;
      throw err;
    });
    bootstrapCache = { db, email, password, promise };
  }
  return bootstrapCache.promise;
}

const DEFAULT_CONFIG: LabConfig = {
  version: 3,
  updatedAt: new Date().toISOString(),
  defaultHomepage: "https://labkiosk.org",
  whitelist: [],
  scheduledShutdown: "17:00"
};

/**
 * Where a successful sign-in should land.
 *
 * This used to be decided in the landing page script, which sent every super
 * admin to /super whatever host they signed in on -- so signing in on
 * demo.<domain> to reach the demo console threw you to the platform console
 * instead, and there was no route back through the UI.
 *
 * A super admin signing in on an organization subdomain lands on that organization when it
 * is one they may open (Rule 2 allows `demo` only) and on /super otherwise.
 */
function postLoginRedirect(options: {
  role: string;
  ownSubdomain: string | null;
  hostSlug: string | null;
  requestedSlug: string | null;
  isDev: boolean;
  baseDomain: string;
  /** SUPER_ADMIN_HOST, when the platform console is confined to its own host. */
  superHost?: string | null;
  host?: string;
}): string {
  const { role, ownSubdomain, hostSlug, requestedSlug, isDev, baseDomain, superHost, host } = options;

  const consoleFor = (slug: string) =>
    isDev ? `/admin?tenant=${encodeURIComponent(slug)}` : `https://${slug}.${baseDomain}/admin`;

  if (role === "super_admin") {
    // The organization they were already looking at, if they are allowed in it.
    const context = hostSlug || requestedSlug;
    if (isDemoSlug(context)) return consoleFor(context);
    return superHost && !isDev && host !== superHost ? `https://${superHost}/super` : "/super";
  }

  if (ownSubdomain) return consoleFor(ownSubdomain);
  return "/admin";
}

/**
 * A workstation's two routes: the WebSocket it keeps open to its organization's
 * OrgHub, and the HTTP heartbeat agents installed before it still use.
 *
 * They are answered before sessions and organization resolution, which a
 * workstation never needs: its device token alone decides the organization and
 * the workstation, and nothing in the request body can change either. Neither
 * route touches D1 in the steady state -- verified tokens are cached for a
 * minute, and everything else is OrgHub's.
 */
/** Workstation ids, as the hub accepts them. */
const REMOTE_CLIENT_ID = /^[A-Z0-9][A-Z0-9_-]{0,63}$/;

/**
 * GET /api/devices/remote: the workstation's end of a Remote Control session
 * (src/remote_relay.ts). The device token decides the organization and the
 * workstation; `X-Labkiosk-Session` names the session the hub asked it to join.
 */
async function handleDeviceRemote(
  request: Request,
  env: Env,
  db: D1Database,
  jsonHeaders: Record<string, string>
): Promise<Response> {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return jsonError("Expected a WebSocket upgrade", 426, jsonHeaders);
  }
  const auth = await requireDevice(request, db, jsonHeaders);
  if (auth.error) return auth.error;
  const token = request.headers.get("X-Labkiosk-Session") || "";
  if (!RELAY_TOKEN_PATTERN.test(token)) return jsonError("A Remote Control session is required", 400, jsonHeaders);
  if (!env.REMOTE_RELAY) return jsonError("This server has no Remote Control relay (REMOTE_RELAY binding)", 503, jsonHeaders);
  return relayUpgrade(env, auth.device.tenant_id, auth.device.client_id, "device", await hashRelayToken(token));
}

async function handleWorkstationRequest(
  request: Request,
  url: URL,
  env: Env,
  db: D1Database,
  jsonHeaders: Record<string, string>
): Promise<Response> {
  const socket = url.pathname === "/api/devices/ws";
  if (socket && request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return jsonError("Expected a WebSocket upgrade", 426, jsonHeaders);
  }
  const auth = await requireDevice(request, db, jsonHeaders);
  if (auth.error) return auth.error;
  const device = auth.device;
  const ip = request.headers.get("CF-Connecting-IP") || "127.0.0.1";
  const portal = portalContextFrom(request, url, env);

  if (socket) {
    return hubUpgrade(env, device.tenant_id, "device", { clientId: device.client_id, ip, portal });
  }

  let payload: unknown;
  try {
    payload = await request.json();
  } catch (err) {
    console.warn("[Worker] Unreadable telemetry payload:", err);
    return jsonError("Telemetry payload could not be processed", 400, jsonHeaders);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return jsonError("Telemetry payload could not be processed", 400, jsonHeaders);
  }
  const res = await hubRequest(env, device.tenant_id, "/heartbeat", {
    clientId: device.client_id,
    ip,
    portal,
    payload
  });
  return new Response(res.body, { status: res.status, headers: jsonHeaders });
}

/** The shortest RELEASE_NOTES_TOKEN accepted: a 32-byte random value, hex encoded. */
const RELEASE_NOTES_TOKEN_MIN_LENGTH = 32;

/**
 * Why a call from the repository's Actions is refused, or null: it must carry
 * Bearer RELEASE_NOTES_TOKEN. 401 a wrong token; 503 the token is not
 * configured, or too short to be one.
 */
async function releaseTokenRefusal(
  request: Request,
  env: Env,
  what: string,
  headers: Record<string, string>
): Promise<Response | null> {
  const expected = env.RELEASE_NOTES_TOKEN || "";
  if (expected.length < RELEASE_NOTES_TOKEN_MIN_LENGTH) {
    return jsonError(`${what} is not configured`, 503, headers);
  }
  const supplied = /^Bearer (\S+)$/.exec(request.headers.get("Authorization") || "")?.[1] || "";
  // Both sides hashed first: equal lengths, so the comparison says nothing about the token's.
  if (!supplied || !timingSafeEqual(await sha256Hex(supplied), await sha256Hex(expected))) {
    return jsonError("Unauthorized", 401, headers);
  }
  return null;
}

/**
 * GET /api/release-support: the support status each major release has now, for
 * the daily security rebuild (security-rebuild.yml), which rebuilds only lines
 * of majors that are not at end of life, and of each major only the lines from
 * its newest stable one on. Bearer RELEASE_NOTES_TOKEN, as the sync below.
 * 200 {majors: [{major, status, endOfLifeAt}], stable: ["3.1.0", ...]}: one
 * entry per major the platform has set (a major not listed is supported), and
 * every unrevoked feature release classified stable.
 */
async function handleReleaseSupportForCi(
  request: Request,
  env: Env,
  db: D1Database,
  headers: Record<string, string>
): Promise<Response> {
  const refused = await releaseTokenRefusal(request, env, "Release support status", headers);
  if (refused) return refused;
  const now = Math.floor(Date.now() / 1000);
  const majors = [...(await listMajorSupport(db)).values()]
    .filter((row) => isReleaseMajor(row.major))
    .sort((a, b) => a.major - b.major)
    .map((row) => ({ major: row.major, status: effectiveSupportStatus(row, now), endOfLifeAt: row.end_of_life_at ?? null }));
  const stable = await stableFeatureReleases(db);
  return new Response(JSON.stringify({ majors, stable }), { status: 200, headers });
}

/**
 * POST /api/release-notes/sync: the ISO build calls this the moment it has
 * published a release (build-iso.yml), so /download offers the new ISO at once
 * instead of after the next hourly run. It only re-reads GitHub's public
 * release list, the hourly run's first half; the summaries stay with that run.
 *
 * Bearer RELEASE_NOTES_TOKEN (a secret shared with the repository's Actions).
 * 200 {stored, latest}; 401 a wrong token; 502 GitHub could not be read;
 * 503 the token is not configured, or too short to be one.
 */
async function handleReleaseNotesSync(
  request: Request,
  env: Env,
  db: D1Database,
  headers: Record<string, string>
): Promise<Response> {
  const refused = await releaseTokenRefusal(request, env, "Release notes sync", headers);
  if (refused) return refused;
  // CI calls this once a release is in the bucket: a security release is offered at once.
  try {
    await recordNewReleases(env, db);
  } catch (err) {
    console.error("[Worker] Recording the releases in the bucket failed:", err);
  }
  try {
    const result = await storeReleaseNotes(db, env);
    return new Response(JSON.stringify(result), { status: 200, headers });
  } catch (err) {
    console.error("[Worker] Reading the releases from GitHub failed:", err);
    return jsonError("The releases could not be read from GitHub", 502, headers);
  }
}

/**
 * POST /api/devices/boot-report: an installed workstation reports what its last
 * boot did with its system image (a new image installed, a failed first boot,
 * a rollback). Like the heartbeat, the device token alone decides the
 * organization and the workstation.
 *
 * A failure or warning is listed in Settings -> Errors & Warnings.
 *
 * 200 recorded or already recorded; 400 malformed (the agent drops it);
 * 409 the workstation's row does not exist yet (the agent tries again).
 */
async function handleBootReport(
  request: Request,
  db: D1Database,
  jsonHeaders: Record<string, string>
): Promise<Response> {
  const auth = await requireDevice(request, db, jsonHeaders);
  if (auth.error) return auth.error;
  const device = auth.device;
  const now = Math.floor(Date.now() / 1000);

  let report;
  try {
    report = parseBootReport(await request.json(), now);
  } catch (err: any) {
    return jsonError(`Boot report refused: ${err?.message || "unreadable"}`, 400, jsonHeaders);
  }
  const outcome = await recordBootReport(db, device.tenant_id, device.client_id, report, now);
  if (outcome === "unknown-workstation") {
    return jsonError("This workstation has not checked in yet; send the report again later", 409, jsonHeaders);
  }
  return new Response(JSON.stringify({ status: "ok", recorded: outcome === "recorded" }), {
    status: 200,
    headers: jsonHeaders
  });
}

/**
 * POST /api/devices/disk-health: a workstation reports the disks labkiosk-health
 * found wearing out or failing. The device token alone decides the
 * organization and the workstation.
 *
 * 200 recorded (or already recorded); 400 malformed (the agent drops it);
 * 409 the workstation's row does not exist yet and 429 too many today (the
 * agent tries again after the next check).
 */
async function handleDiskHealthReport(
  request: Request,
  db: D1Database,
  jsonHeaders: Record<string, string>
): Promise<Response> {
  const auth = await requireDevice(request, db, jsonHeaders);
  if (auth.error) return auth.error;
  const device = auth.device;

  let disks;
  try {
    disks = parseDiskHealthReport(await request.json());
  } catch (err: any) {
    return jsonError(`Disk health report refused: ${err?.message || "unreadable"}`, 400, jsonHeaders);
  }
  const outcome = await recordDiskHealthReport(db, device.tenant_id, device.client_id, disks, Math.floor(Date.now() / 1000));
  if (outcome === "unknown-workstation") {
    return jsonError("This workstation has not checked in yet; send the report again later", 409, jsonHeaders);
  }
  if (outcome === "too-many") {
    return jsonError("This workstation has reported enough disk problems today", 429, jsonHeaders);
  }
  return new Response(JSON.stringify({ status: "ok", recorded: outcome.recorded }), {
    status: 200,
    headers: jsonHeaders
  });
}

/**
 * POST /api/devices/video-decoding: a workstation reports what its GPUs decode
 * in hardware, once per agent start. The device token alone decides the
 * organization and the workstation; the latest report replaces the last.
 *
 * 200 kept; 400 malformed (the agent drops it); 409 the workstation's row does
 * not exist yet (the agent tries again).
 */
async function handleVideoDecodingReport(
  request: Request,
  db: D1Database,
  jsonHeaders: Record<string, string>
): Promise<Response> {
  const auth = await requireDevice(request, db, jsonHeaders);
  if (auth.error) return auth.error;
  const device = auth.device;

  let report;
  try {
    report = parseVideoDecodingReport(await request.json());
  } catch (err: any) {
    return jsonError(`Video decoding report refused: ${err?.message || "unreadable"}`, 400, jsonHeaders);
  }
  const kept = await recordVideoDecoding(db, device.tenant_id, device.client_id, report, Math.floor(Date.now() / 1000));
  if (!kept) {
    return jsonError("This workstation has not checked in yet; send the report again later", 409, jsonHeaders);
  }
  return new Response(JSON.stringify({ status: "ok" }), { status: 200, headers: jsonHeaders });
}

/**
 * POST /api/devices/hardware: a workstation reports the machine it runs on,
 * once per agent start (src/hardware.ts). The device token alone decides the
 * organization and the workstation; the latest report replaces the last.
 *
 * 200 kept; 400 malformed (the agent drops it); 409 the workstation's row does
 * not exist yet (the agent tries again).
 */
async function handleHardwareReport(
  request: Request,
  db: D1Database,
  jsonHeaders: Record<string, string>
): Promise<Response> {
  const auth = await requireDevice(request, db, jsonHeaders);
  if (auth.error) return auth.error;
  const device = auth.device;

  let report;
  try {
    report = parseHardwareReport(await request.json());
  } catch (err: any) {
    return jsonError(`Hardware report refused: ${err?.message || "unreadable"}`, 400, jsonHeaders);
  }
  const kept = await recordHardware(db, device.tenant_id, device.client_id, report, Math.floor(Date.now() / 1000));
  if (!kept) {
    return jsonError("This workstation has not checked in yet; send the report again later", 409, jsonHeaders);
  }
  return new Response(JSON.stringify({ status: "ok" }), { status: 200, headers: jsonHeaders });
}

/**
 * POST /api/devices/usage: a workstation sends what it counted since its last
 * report (src/usage.ts): per day, seconds on and in use, sessions and, when
 * the organization records them, the sites. The counts are added, so the
 * agent forgets what it sent once this answers 200.
 *
 * 200 counted; 400 malformed (the agent drops it rather than resend it forever).
 */
async function handleUsageReport(
  request: Request,
  db: D1Database,
  jsonHeaders: Record<string, string>
): Promise<Response> {
  const auth = await requireDevice(request, db, jsonHeaders);
  if (auth.error) return auth.error;
  const device = auth.device;

  let days;
  try {
    days = parseUsageReport(await request.json());
  } catch (err: any) {
    return jsonError(`Usage report refused: ${err?.message || "unreadable"}`, 400, jsonHeaders);
  }
  const tenant = await findTenantById(db, device.tenant_id);
  if (!tenant) return jsonError("This organization no longer exists", 401, jsonHeaders);
  await recordUsage(db, tenant.id, device.client_id, days, tenant.usage_sites !== 0);
  return new Response(JSON.stringify({ status: "ok" }), { status: 200, headers: jsonHeaders });
}

/**
 * POST /api/devices/restart-report: an installed workstation reports a boot
 * that ended without shutting down, with the end of that boot's journal. The
 * device token alone decides the organization and the workstation.
 *
 * Listed in Settings -> Errors & Warnings, the log beside it.
 *
 * 200 recorded or already recorded; 400 malformed (the agent drops it);
 * 409 the workstation's row does not exist yet and 429 too many today (the
 * agent tries again at its next boot).
 */
async function handleRestartReport(
  request: Request,
  db: D1Database,
  jsonHeaders: Record<string, string>
): Promise<Response> {
  const auth = await requireDevice(request, db, jsonHeaders);
  if (auth.error) return auth.error;
  const device = auth.device;
  const now = Math.floor(Date.now() / 1000);

  let report;
  try {
    report = parseRestartReport(await request.json(), now);
  } catch (err: any) {
    return jsonError(`Restart report refused: ${err?.message || "unreadable"}`, 400, jsonHeaders);
  }
  const outcome = await recordRestartReport(db, device.tenant_id, device.client_id, report, now);
  if (outcome === "unknown-workstation") {
    return jsonError("This workstation has not checked in yet; send the report again later", 409, jsonHeaders);
  }
  if (outcome === "too-many") {
    return jsonError("Too many restart reports from this workstation today; send it again later", 429, jsonHeaders);
  }
  return new Response(JSON.stringify({ status: "ok", recorded: outcome === "recorded" }), {
    status: 200,
    headers: jsonHeaders
  });
}

/**
 * GET /api/devices/update?running=<version>: the release this workstation's
 * organization is offered, and where to download it. Asked by the
 * workstation's root updater (labkiosk-update run) whenever the hub sends
 * `release-available`.
 *
 * The device token alone decides the organization. `release` is the newest
 * release of its channel, null when nothing is offered; the updater then
 * reports itself up to date when it runs that version or newer. Phase 4 adds
 * `security`, the newest security release for the line `running` belongs to
 * (null without `running`, as a 2.9.0 updater asks), and `securityUpdates`,
 * always `next_boot`: the workstation installs that at its next boot by itself
 * (an updater from before this reads the setting, and `approval` is no longer
 * one). Each release also says `automatic`: whether it installs at the next
 * boot without an administrator (installsByItself: a security fix for its line,
 * a minor release of the running major, or a major an administrator confirmed). 503 when
 * the platform has no public release address, so a workstation never mistakes
 * a missing setting for "up to date".
 *
 * Phase 5 adds `lan`: null unless the organization shares releases on its LAN,
 * else `{ peers }`, the LAN addresses of workstations at this one's site that
 * hold the release it should fetch (security first) verified, to copy it from
 * before the internet; a workstation also serves a release it holds only while
 * `lan` is not null.
 */
async function handleDeviceUpdate(
  request: Request,
  env: Env,
  db: D1Database,
  jsonHeaders: Record<string, string>
): Promise<Response> {
  const auth = await requireDevice(request, db, jsonHeaders);
  if (auth.error) return auth.error;
  const tenant = await findTenantById(db, auth.device.tenant_id);
  if (!tenant || tenant.status !== "active") return jsonError("This organization is not active", 403, jsonHeaders);
  const running = new URL(request.url).searchParams.get("running");
  if (running !== null && !isReleaseVersion(running)) {
    return jsonError("running must be a release version", 400, jsonHeaders);
  }
  const releases = await offeredReleases(db, tenant.update_channel, tenant.id);
  // Only a workstation in a group its organization is trying a major on needs its group.
  const pilots = [...new Set(releases.flatMap((r) => (r.pilotGroup ? [r.pilotGroup] : [])))];
  const group = (await workstationGroupsIn(db, tenant.id, pilots)).get(auth.device.client_id) ?? null;
  const offer = workstationOffer(releases, running, group);
  const securityUpdates = "next_boot";
  const described: Record<string, { version: string; kind: string; sizeBytes: number; url: string; automatic: boolean } | null> = {};
  for (const [name, release] of [["release", offer.release], ["security", offer.security]] as const) {
    if (!release) {
      described[name] = null;
      continue;
    }
    const folder = releaseFolderUrl(env, release.version);
    if (!folder) {
      console.error("[Worker] A release is offered but RELEASES_BASE_URL is missing or not an https address");
      return jsonError("Updates are not available from this server right now", 503, jsonHeaders);
    }
    described[name] = {
      version: release.version,
      kind: release.kind,
      sizeBytes: release.sizeBytes,
      url: folder,
      automatic: installsByItself(release, running)
    };
  }
  let lan: { peers: string[] } | null = null;
  if (tenant.lan_sharing === 1) {
    const target = offer.security ?? offer.release;
    const peers = target
      ? (await hubJson<{ peers: string[] }>(env, tenant.id, "/lan-peers", { clientId: auth.device.client_id, version: target.version })).peers
      : [];
    lan = { peers };
  }
  return new Response(JSON.stringify({ ...described, securityUpdates, lan }), { headers: jsonHeaders });
}

/**
 * Routes that may name a tenant without a session, either because they are
 * public and read-only (the user portal, the wizard status probe) or because
 * they carry their own credential (`/api/telemetry` uses a device token, and
 * `/api/devices/enroll` proves possession of the enrollment key).
 */
/**
 * A language tag, and the size limits a catalog has to stay inside.
 *
 * A workstation refuses anything larger or stranger than this as well; the
 * limits exist in both places because neither side may assume the other has
 * checked.
 */
const LANGUAGE_TAG_PATTERN = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,2}$/;
const CATALOG_MAX_BYTES = 256 * 1024;
const CATALOG_MAX_KEYS = 2000;
const CATALOG_MAX_VALUE = 2000;

/**
 * Reduce a submitted catalog to what a workstation will accept: a flat map of
 * string to string, plus an optional _meta block. Anything else is rejected
 * rather than stored, so a bad upload fails here and not in a room.
 */
function sanitizeCatalog(input: unknown): { body: string; entryCount: number } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("The catalog must be a JSON object");
  }
  const source = input as Record<string, unknown>;
  const keys = Object.keys(source);
  if (keys.length > CATALOG_MAX_KEYS) {
    throw new Error(`A catalog may hold at most ${CATALOG_MAX_KEYS} entries`);
  }
const output: Record<string, unknown> = Object.create(null);
  let entryCount = 0;
  for (const key of keys) {
    const value = source[key];
    if (key === "_meta") {
      const meta = (value && typeof value === "object" && !Array.isArray(value))
        ? (value as Record<string, unknown>)
        : {};
      output._meta = {
        name: String(meta.name ?? "").slice(0, 120),
        direction: String(meta.direction ?? "").toLowerCase() === "rtl" ? "rtl" : "ltr",
      };
      continue;
    }
    if (typeof value !== "string") {
      throw new Error(`The value for "${key}" is not a string`);
    }
    output[key] = value.slice(0, CATALOG_MAX_VALUE);
    entryCount += 1;
  }
  const body = JSON.stringify(output);
  const byteLength = new TextEncoder().encode(body).length;
  if (byteLength > CATALOG_MAX_BYTES) {
    throw new Error(`The catalog is larger than ${Math.floor(CATALOG_MAX_BYTES / 1024)} KB`);
  }
  return { body, entryCount };
}

function isPublicTenantRoute(path: string, method: string): boolean {
  if (path === "/" || path === "/home" || path === "/privacy" || path === "/terms" || path === "/api/status") return true;
  if (path === "/terms/bug-reports" || path === "/content-policy" || path === "/dpa") return true;
  if (path === "/api/portal-sites" && method === "GET") return true;
  if (path === "/api/devices/enroll" || path === "/api/telemetry") return true;
  // Interface catalogs. A workstation asks for its language before it is
  // enrolled and holds no credential at that point, and the text is the same
  // for every organization, so these are readable without a session.
  if (path === "/api/i18n" && method === "GET") return true;
  if (path.startsWith("/i18n/") && method === "GET") return true;
  return false;
}

/**
 * Headers every HTML response carries. The CSP allows scripts only when they
 * carry this response's nonce, so no template may use an inline event handler
 * or a `<script>` without `nonce="..."`; the test suite asserts both.
 *
 * `analyticsOrigin` is set only on the platform's public marketing pages: it
 * lets Cloudflare Zaraz's loader script, which Zaraz's own (nonced) inline
 * snippet adds without a nonce, load from this origin. `indexable` false adds
 * `X-Robots-Tag: noindex` (see src/seo.ts).
 */
function buildHtmlHeaders(
  nonce: string,
  options: { hsts: boolean; indexable: boolean; analyticsOrigin: string | null; remoteViewer?: boolean; turnstile?: boolean; revalidate?: boolean }
): Record<string, string> {
  const scriptSources = [`'nonce-${nonce}'`];
  // Turnstile's widget script, and the frame it draws the check in (src/turnstile.ts).
  if (options.turnstile) scriptSources.push(TURNSTILE_ORIGIN);
  // The Remote Control viewer's nonced module imports noVNC from /novnc/.
  if (options.remoteViewer) scriptSources.push("'self'");
  if (options.analyticsOrigin) scriptSources.push(`${options.analyticsOrigin}${ZARAZ_LOADER_PATH}`);
  const csp = [
    "default-src 'self'",
    `script-src ${scriptSources.join(" ")}`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: https:",
    // Only Remote Control frames a page: the viewer on this console's own address.
    options.turnstile ? `frame-src 'self' ${TURNSTILE_ORIGIN}` : "frame-src 'self'",
    "connect-src 'self'",
    // Only the viewer is framed, and only by the console on its own address.
    options.remoteViewer ? "frame-ancestors 'self'" : "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'"
  ].join("; ");
  const headers: Record<string, string> = {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": csp,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "X-Frame-Options": options.remoteViewer ? "SAMEORIGIN" : "DENY",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "Cross-Origin-Opener-Policy": "same-origin",
    // A public page shown to a signed-out visitor may be kept for the back and
    // forward buttons, and is asked for again otherwise: its nonce is never reused
    // for a new document. Everything else is never stored.
    "Cache-Control": options.revalidate ? "no-cache" : "no-store"
  };
  if (options.hsts) headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
  if (!options.indexable) headers["X-Robots-Tag"] = "noindex, nofollow";
  return headers;
}

export default {
  /**
   * Hourly housekeeping (see `triggers.crons` in wrangler.jsonc). Expired
   * sessions, delivered commands and stale throttle rows would otherwise only
   * be purged as a side effect of unrelated requests.
   */
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    const db = getDatabase(env);
    await bootstrap(db, env);
    useAuditQueue(env.AUDIT_QUEUE);
    await deleteExpiredSessions(db);
    await purgeStaleLoginAttempts(db);
    await purgeExpiredEmailCodes(db);
    await purgeExpiredLoginChallenges(db);
    const peppered = await pepperLegacyPasswordHashes(db, passwordPepper(env));
    if (peppered) console.log(`[Worker] Wrapped ${peppered} password hashes in PASSWORD_PEPPER.`);
    for (const tenantId of await rotateUncheckedEnrollmentKeys(db)) {
      await writeAuditLog(db, { tenantId, userId: null, action: "settings.rotate_enrollment_key", details: "reason=check_character" });
    }
    const stranded = await fileStrandedInboundMail(env, db);
    if (stranded) console.log(`[Worker] Filed ${stranded} incoming messages the email Worker could not hand over.`);
    const purgedUsage = await purgeOldUsage(db);
    if (purgedUsage) console.log(`[Worker] Deleted ${purgedUsage} usage rows older than the retention period.`);
    await rollUpPlatformUsage(db);
    await rebuildHardwareModels(db, Math.floor(Date.now() / 1000));
    const purgedIssues = await purgeOldWorkstationIssues(db);
    if (purgedIssues) console.log(`[Worker] Deleted ${purgedIssues} workstation issues older than ${WORKSTATION_ISSUE_RETENTION_DAYS} days.`);
    // Commands expire inside each organization's OrgHub; the audit log is the
    // one table here that grows without bound, so old entries move to R2.
    if (env.AUDIT_ARCHIVE) {
      const archived = await archiveOldAuditLogs(db, env.AUDIT_ARCHIVE);
      if (archived) console.log(`[Worker] Archived ${archived} audit entries older than ${AUDIT_RETENTION_DAYS} days to R2.`);
    }
    try {
      const releases = await syncReleaseNotes(db, env);
      if (releases.summarized) console.log(`[Worker] Release notes: ${releases.summarized} summaries written.`);
    } catch (err) {
      // /download keeps showing the releases it already has.
      console.error("[Worker] Reading the releases from GitHub failed:", err);
    }
    try {
      const recorded = await recordNewReleases(env, db);
      if (recorded?.added.length) console.log(`[Worker] Releases recorded: ${recorded.added.join(", ")}.`);
    } catch (err) {
      // The next hour, or the Releases page, records them.
      console.error("[Worker] Recording the releases in the bucket failed:", err);
    }
    try {
      const reminded = await sendEndOfLifeReminders(env, db);
      if (reminded.length) console.log(`[Worker] End-of-life reminders sent for ${reminded.join(", ")}.`);
    } catch (err) {
      console.error("[Worker] End-of-life reminders failed:", err);
    }
    const bugs = await processBugReports(db, env);
    if (bugs.filed || bugs.matched || bugs.linked || bugs.refreshed) {
      console.log(
        `[Worker] Bug reports: ${bugs.filed} filed, ${bugs.matched} matched to existing issues, ${bugs.linked} repeats, ${bugs.refreshed} statuses read.`
      );
    }
  },

  /**
   * Mail routed straight to this Worker by Email Routing: filed into Mail or
   * the conversation it answers (src/inbox.ts). Production routes the
   * catch-all to `labkiosk-email-routing`, which hands over through
   * `MailIntake`; this handler keeps a direct route working too.
   */
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const db = getDatabase(env);
    await bootstrap(db, env);
    useAuditQueue(env.AUDIT_QUEUE);
    try {
      await handleInboundEmail(message as unknown as InboundMessage, env, db);
    } catch (err) {
      console.error("[Worker] Filing an incoming email failed:", err);
      // Not filed: the owner's copy is the only one left, and without it the
      // sender is better off with a bounce than with silence.
      if (!env.SUPPORT_FORWARD_TO) throw err;
      await message.forward(env.SUPPORT_FORWARD_TO);
    }
  },

  /** The AUDIT_QUEUE consumer: one insert per batch instead of one per action. */
  async queue(batch: MessageBatch<AuditEntryMessage>, env: Env): Promise<void> {
    const db = getDatabase(env);
    await bootstrap(db, env);
    try {
      await insertAuditEntries(db, batch.messages.map((message) => message.body));
      batch.ackAll();
    } catch (err) {
      console.error("[Worker] Writing a batch of audit entries failed; the queue will retry it:", err);
      batch.retryAll();
    }
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // "/pricing/" is "/pricing": one address per page, so a link with a slash still lands.
    if (
      path.length > 1 &&
      path.endsWith("/") &&
      (method === "GET" || method === "HEAD") &&
      (SLASHLESS_PAGES.has(path.slice(0, -1)) || (path.startsWith("/docs/") && path.length > "/docs/".length))
    ) {
      const slashless = new URL(request.url);
      slashless.pathname = path.slice(0, -1);
      return Response.redirect(slashless.toString(), 301);
    }

    const db = getDatabase(env);
    await bootstrap(db, env);
    useAuditQueue(env.AUDIT_QUEUE);

    // Same-origin JSON API: no cross-origin credentials are ever needed, so no
    // Access-Control-Allow-Origin is emitted. `/api/status` opts in explicitly
    // below because the first-boot wizard probes it from a file:// page.
    const jsonHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff"
    };
    if (method === "OPTIONS") {
      return new Response(null, { status: 204, headers: { Allow: "GET, POST, DELETE, OPTIONS" } });
    }

    if ((path === "/api/telemetry" && method === "POST") || (path === "/api/devices/ws" && method === "GET")) {
      return handleWorkstationRequest(request, url, env, db, jsonHeaders);
    }
    if (path === "/api/devices/boot-report" && method === "POST") {
      return handleBootReport(request, db, jsonHeaders);
    }
    if (path === "/api/devices/restart-report" && method === "POST") {
      return handleRestartReport(request, db, jsonHeaders);
    }
    if (path === "/api/devices/disk-health" && method === "POST") {
      return handleDiskHealthReport(request, db, jsonHeaders);
    }
    if (path === "/api/devices/video-decoding" && method === "POST") {
      return handleVideoDecodingReport(request, db, jsonHeaders);
    }
    if (path === "/api/devices/hardware" && method === "POST") {
      return handleHardwareReport(request, db, jsonHeaders);
    }
    if (path === "/api/devices/usage" && method === "POST") {
      return handleUsageReport(request, db, jsonHeaders);
    }
    if (path === "/api/release-notes/sync" && method === "POST") {
      return handleReleaseNotesSync(request, env, db, jsonHeaders);
    }
    if (path === "/api/release-support" && method === "GET") {
      return handleReleaseSupportForCi(request, env, db, jsonHeaders);
    }
    if (path === "/api/devices/update" && method === "GET") {
      return handleDeviceUpdate(request, env, db, jsonHeaders);
    }
    if (path === "/api/devices/remote" && method === "GET") {
      return handleDeviceRemote(request, env, db, jsonHeaders);
    }

    // The noVNC client the Remote Control viewer loads, from static assets.
    if (path.startsWith(NOVNC_PATH) && (method === "GET" || method === "HEAD")) {
      if (!env.ASSETS) return jsonError("Not Found", 404, jsonHeaders);
      const asset = await env.ASSETS.fetch(request);
      if (!asset.ok) return asset;
      const headers = new Headers(asset.headers);
      headers.set("X-Content-Type-Options", "nosniff");
      headers.set("Cross-Origin-Resource-Policy", "same-origin");
      headers.set("Cache-Control", "public, max-age=3600");
      return new Response(asset.body, { status: asset.status, headers });
    }

    // The console stylesheet: one immutable file per version instead of ~50 KB
    // inlined into every console page.
    if (path.startsWith("/assets/console-") && path.endsWith(".css") && method === "GET") {
      const current = path === CONSOLE_STYLESHEET_PATH;
      return new Response(consoleStylesheet(), {
        headers: {
          "Content-Type": "text/css; charset=utf-8",
          "X-Content-Type-Options": "nosniff",
          // An old page asking for an old version gets today's styles, uncached.
          "Cache-Control": current ? "public, max-age=31536000, immutable" : "no-store"
        }
      });
    }

    // The public pages' stylesheet, served the same way.
    if (path.startsWith("/assets/site-") && path.endsWith(".css") && method === "GET") {
      const current = path === SITE_STYLESHEET_PATH;
      return new Response(siteStylesheet(), {
        headers: {
          "Content-Type": "text/css; charset=utf-8",
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": current ? "public, max-age=31536000, immutable" : "no-store"
        }
      });
    }

    // The registration form's country table (src/geo.ts), served the same way.
    if (path.startsWith("/assets/geo-") && path.endsWith(".json") && method === "GET") {
      return new Response(GEO_JSON, {
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": path === GEO_DATA_PATH ? "public, max-age=31536000, immutable" : "no-store"
        }
      });
    }

    // The picture shared links show, from static assets.
    if (path === SOCIAL_IMAGE_PATH && (method === "GET" || method === "HEAD")) {
      if (!env.ASSETS) return jsonError("Not Found", 404, jsonHeaders);
      const asset = await env.ASSETS.fetch(request);
      if (!asset.ok) return asset;
      const headers = new Headers(asset.headers);
      headers.set("X-Content-Type-Options", "nosniff");
      headers.set("Cache-Control", "public, max-age=86400");
      return new Response(asset.body, { status: asset.status, headers });
    }

    // One address for each public page: the platform's other host name (`www.`
    // beside the apex, or the reverse) answers with the canonical one. Only the
    // pages people land on: the sitemap, the mail logo and the consoles keep
    // answering on both.
    if ((method === "GET" || method === "HEAD") && INDEXABLE_PATHS.includes(path) && !isDevHost(request)) {
      const canonical = canonicalHost(env);
      const base = (env.DEFAULT_DOMAIN || "").replace(/^\./, "").toLowerCase();
      const host = hostname(request);
      if (canonical && base && host !== canonical && (host === base || host === `www.${base}`)) {
        const target = new URL(request.url);
        target.hostname = canonical;
        return Response.redirect(target.toString(), 301);
      }
    }

    // --- Search engines -----------------------------------------------------
    if (method === "GET" || method === "HEAD") {
      if (path === "/robots.txt") {
        return new Response(robotsTxt(request, url, env), {
          headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600", "X-Content-Type-Options": "nosniff" }
        });
      }
      if (path === "/sitemap.xml") {
        if (!isPlatformHost(request, env)) return jsonError("Not Found", 404, jsonHeaders);
        return new Response(sitemapXml(request, url, env), {
          headers: { "Content-Type": "application/xml; charset=utf-8", "Cache-Control": "public, max-age=3600", "X-Content-Type-Options": "nosniff" }
        });
      }
      if (path === BIMI_PATH) {
        if (!isPlatformHost(request, env)) return jsonError("Not Found", 404, jsonHeaders);
        return new Response(bimiSvg(PALETTE["--accent"][0], PALETTE["--accent-fg"][0]), {
          headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400", "X-Content-Type-Options": "nosniff" }
        });
      }
      if (path === FAVICON_PATH) {
        return new Response(faviconSvg(PALETTE["--accent"][0], PALETTE["--accent-fg"][0]), {
          headers: { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400", "X-Content-Type-Options": "nosniff" }
        });
      }
    }

    // --- Identity -----------------------------------------------------------
    const isDev = isDevHost(request);
    const isHttps = Boolean(
      url.protocol === "https:" ||
      request.headers.get("x-forwarded-proto") === "https" ||
      request.headers.get("cf-visitor")?.includes('"scheme":"https"')
    );
    const secureCookies = Boolean(isHttps && !isDev);
    // Sessions are host-only (session_handoff.ts). Earlier releases set one cookie for the whole
    // platform domain; it is no longer read, and sign-in and sign-out clear it.
    const legacyCookieDomain =
      isHttps && !isDev && env.DEFAULT_DOMAIN && isHostUnder(hostname(request), env.DEFAULT_DOMAIN)
        ? env.DEFAULT_DOMAIN
        : undefined;
    const cookies = parseCookies(request.headers.get("cookie"));
    const authHeader = request.headers.get("authorization");
    const cookieToken = cookies[sessionCookieName(secureCookies)] || "";
    const usedCookie = Boolean(cookieToken);
    const sessionToken = cookieToken || (authHeader && authHeader.startsWith("Bearer ") ? authHeader.substring(7) : null);
    const session = sessionToken ? await getSession(db, sessionToken) : null;
    const sessionCookie = (token: string, maxAgeSeconds: number) => createSessionCookie(token, { secure: secureCookies, maxAgeSeconds });
    const clientIp = request.headers.get("CF-Connecting-IP") || "127.0.0.1";

    // A coarse per-address limit in front of what a stranger can hammer. The
    // precise lockout windows stay in D1 (login attempts, enrolment failures);
    // this keeps a flood from reaching the database at all.
    if (
      env.AUTH_RATE_LIMITER &&
      method === "POST" &&
      (path === "/api/auth/login" ||
        path === "/api/auth/login/verify" ||
        path === "/api/auth/login/email-code" ||
        path === "/api/auth/login/passkey" ||
        path === "/api/auth/register" ||
        path === "/api/auth/register/email-code" ||
        path === "/api/contact" ||
        path === "/api/contact/email-code" ||
        path === "/api/devices/enroll")
    ) {
      let success = true;
      try {
        ({ success } = await env.AUTH_RATE_LIMITER.limit({ key: `${path}|${clientIp}` }));
      } catch (err) {
        // A fault in the front layer must not take sign-in down: the D1 lockouts
        // below still apply. (wrangler's local simulator throws on every call.)
        console.error("[Worker] The sign-in rate limiter failed; relying on the D1 lockouts:", err);
      }
      if (!success) {
        return jsonError("Too many attempts from this address. Wait a minute and try again.", 429, jsonHeaders);
      }
    }

    // Every HTML response carries the same hardened headers and a fresh CSP nonce.
    const nonce = generateNonce();
    const htmlHeaders = buildHtmlHeaders(nonce, {
      hsts: isHttps && !isDev,
      indexable: isIndexable(request, url, env),
      analyticsOrigin: allowsAnalytics(request, url, env) ? url.origin : null,
      turnstile: Boolean(turnstileSiteKey(env)),
      revalidate: !session && isIndexable(request, url, env)
    });
    const canonicalUrl = canonicalUrlFor(request, url, env);
    const baseDomain = env.DEFAULT_DOMAIN || "labkiosk.org";
    // Turnstile stands in front of sign-in on the platform's own names. A widget
    // only runs on the host names its site key lists, and an organization's own
    // domain is not one of them, so sign-in there relies on the lockouts alone.
    const loginTurnstile = isDev || isHostUnder(hostname(request), env.DEFAULT_DOMAIN);
    /** What every public page needs to draw the checks its forms carry. */
    const formChecks = { turnstileSiteKey: turnstileSiteKey(env), loginTurnstile };

    // With SUPER_ADMIN_HOST set, the platform console and its API answer on that host only, so the
    // public apex (landing, registration, legal pages) never shares an origin with it.
    const superHost = superAdminHost(env);
    if (
      superHost &&
      !isDev &&
      hostname(request) !== superHost &&
      (path === "/super" || path.startsWith("/super/") || path === "/api/super" || path.startsWith("/api/super/"))
    ) {
      if (method === "GET" && !path.startsWith("/api/")) return Response.redirect(`https://${superHost}${path}${url.search}`, 302);
      return jsonError("The Super Admin console is served on its own host", 404, jsonHeaders);
    }

    // A cookie-authenticated mutation must come from this site.
    if (path.startsWith("/api/")) {
      const crossSite = rejectCrossSiteMutation(
        request,
        { usedCookie: usedCookie && session !== null, baseDomain: env.DEFAULT_DOMAIN },
        jsonHeaders
      );
      if (crossSite) return crossSite;
    }

    // --- Tenant -------------------------------------------------------------
    const resolution = await resolveTenant({
      db,
      request,
      url,
      session,
      allowAnonymousOverride: isPublicTenantRoute(path, method),
      baseDomain: env.DEFAULT_DOMAIN
    });
    const currentTenant = resolution.tenant;

    // A caller who explicitly named an organization they may not act on is refused
    // once, here, rather than falling through to a route-specific message.
    if (resolution.denied && (path.startsWith("/api/") || path === "/console/remote")) {
      return jsonError("You do not have access to this organization", 403, jsonHeaders);
    }

    // ==========================================
    // AUTHENTICATION API ENDPOINTS
    // ==========================================

    // Signup, the contact form and Remote Control requests (src/signup.ts) and
    // the Super Admin's Tasks and Support (src/inbox.ts) share one context.
    const routeContext: RouteContext = {
      request,
      env,
      db,
      url,
      session,
      jsonHeaders,
      clientIp,
      baseDomain,
      isDev
    };
    const signInCookies = { secure: secureCookies, legacyDomain: legacyCookieDomain, sessionCookie };

    // POST /api/auth/register/email-code: prove the email address before signing up.
    if (path === "/api/auth/register/email-code" && method === "POST") {
      return handleSignupEmailCode(routeContext);
    }

    // POST /api/auth/register: an organization asks to join. It is created as
    // pending and nothing works until the platform approves it (Tasks).
    if (path === "/api/auth/register" && method === "POST") {
      try {
        return await handleRegister(routeContext);
      } catch (err: any) {
        console.error("[Worker] Registration failed:", err);
        return jsonError("Registration failed. Please try again.", 500, jsonHeaders);
      }
    }

    // POST /api/contact/email-code, /api/contact: the contact page. A code proves
    // the sender's address, then the message is filed into Mail.
    if (path === "/api/contact/email-code" && method === "POST") {
      return handleContactEmailCode(routeContext);
    }
    if (path === "/api/contact" && method === "POST") {
      return handleContactForm(routeContext);
    }

    // /api/super/inbox...: Tasks and Support in the Super Admin console.
    if (isInboxRoute(path)) {
      return handleInboxRoute(routeContext);
    }

    // POST /api/auth/login: Operator or Super Admin Sign In
    if (path === "/api/auth/login" && method === "POST") {
      try {
        const body = await request.json<{ email: string; password: string; tenant?: string; turnstileToken?: unknown }>();
        if (!body.email || !body.password) {
          return jsonError("Email and password required", 400, jsonHeaders);
        }
        // Before a password is looked at, so a script cannot guess at them.
        if (loginTurnstile) {
          const refused = await turnstileRefusal(env, body.turnstileToken, clientIp, "login");
          if (refused) return jsonError(refused.message, refused.status, jsonHeaders);
        }

        const identifier = String(body.email).toLowerCase().trim();
        const lockedFor = await getLockoutRemaining(db, identifier);
        if (lockedFor > 0) {
          return jsonError(
            `Too many failed sign-in attempts. Try again in ${Math.ceil(lockedFor / 60)} minute(s).`,
            429,
            jsonHeaders
          );
        }

        const user = await findUserByEmail(db, identifier);
        // Always run a verification so a missing account and a wrong password
        // take comparable time and cannot be told apart by response latency.
        const isValid = user
          ? await verifyPassword(body.password, user.password_hash, user.salt, passwordPepper(env))
          : await verifyPassword(body.password, PEPPERED_HASH_PREFIX + "0".repeat(64), "0".repeat(64), passwordPepper(env));

        if (!user || !isValid) {
          await recordLoginFailure(db, identifier);
          return jsonError("Invalid email or password", 401, jsonHeaders);
        }

        await clearLoginFailures(db, identifier);
        await deleteExpiredSessions(db, user.id);

        const tenant = user.role === "org_admin" ? await findTenantByUserId(db, user.id) : null;
        // An organization that has not been approved has no console yet. Said only
        // after the password checked out, so it reveals nothing to a stranger.
        if (tenant && (tenant.status === "pending" || tenant.status === "rejected")) {
          return jsonError(
            tenant.status === "pending"
              ? "Your organization is waiting for approval. We will email you as soon as it is active."
              : "This registration was not approved. Reply to our email or contact support for details.",
            403,
            jsonHeaders
          );
        }
        // A session now, or a second step first for an account with two-factor sign-in.
        return await continueSignIn(routeContext, signInCookies, {
          userId: user.id,
          tenantId: tenant?.id || null,
          role: user.role,
          redirect: postLoginRedirect({
              role: user.role,
              ownSubdomain: tenant?.subdomain || null,
              hostSlug: hostSubdomain(request, env.DEFAULT_DOMAIN),
              // The sign-in POST has no query string of its own, so the page
              // sends the organization it was showing. It is a hint about where to go
              // next: postLoginRedirect honours it only for the one organization a
              // super admin may open, an organization admin is sent to their own
              // regardless, and the console guards on arrival either way.
              requestedSlug:
                cleanSubdomain(url.searchParams.get("tenant") || body.tenant || "") || null,
            isDev,
            baseDomain,
            superHost: superAdminHost(env),
            host: hostname(request)
          })
        });
      } catch (err: any) {
        console.error("[Worker] Login failed:", err);
        return jsonError("Sign-in failed. Please try again.", 500, jsonHeaders);
      }
    }

    // POST /api/auth/login/verify, /email-code, /passkey: the second step of a two-factor sign-in.
    if (path === "/api/auth/login/verify" && method === "POST") {
      return handleLoginVerify(routeContext, signInCookies);
    }
    if (path === "/api/auth/login/email-code" && method === "POST") {
      return handleLoginEmailCode(routeContext);
    }
    if (path === "/api/auth/login/passkey" && method === "POST") {
      return handleLoginPasskeyOptions(routeContext);
    }

    // /api/auth/two-factor...: the signed-in account turns its own second factor on or off.
    if (isTwoFactorRoute(path)) {
      return handleTwoFactorRoute(routeContext, sessionToken);
    }

    // POST /api/auth/logout: Sign Out. GET is refused so a cross-site link or
    // image cannot sign an operator out; the consoles submit a same-site form.
    if (path === "/api/auth/logout") {
      if (method !== "POST") {
        return new Response(JSON.stringify({ error: "Sign out with a POST request" }), {
          status: 405,
          headers: { ...jsonHeaders, Allow: "POST" }
        });
      }
      if (sessionToken) {
        await deleteSession(db, sessionToken);
      }
      const signedOut = new Headers({ Location: "/" });
      for (const cleared of clearSessionCookies({ secure: secureCookies, legacyDomain: legacyCookieDomain })) {
        signedOut.append("Set-Cookie", cleared);
      }
      return new Response(null, { status: 302, headers: signedOut });
    }

    // GET /api/auth/handoff: a sign-in on another host hands its session to this one.
    if (path === HANDOFF_PATH && method === "GET") {
      return handleSessionHandoff(db, request, url, {
        pepper: passwordPepper(env),
        secure: secureCookies,
        legacyDomain: legacyCookieDomain
      });
    }

    // GET /api/auth/me: Identity Profile
    if (path === "/api/auth/me" && method === "GET") {
      if (!session) {
        return new Response(JSON.stringify({ user: null }), { headers: jsonHeaders });
      }
      const user = await findUserById(db, session.user_id);
      // Only ever describe the tenant this session actually belongs to.
      const ownTenant = session.tenant_id ? await findTenantById(db, session.tenant_id) : null;
      let permissions: string[] = ["*"];
      let tenantRole = user?.role;
      if (ownTenant && user) {
        permissions = await getTenantUserPermissions(db, ownTenant.id, user.id);
        const tu = await getTenantUser(db, ownTenant.id, user.id);
        if (tu) tenantRole = tu.role as any;
      }
      return new Response(
        JSON.stringify({
          user: user ? { email: user.email, name: user.name, role: tenantRole, permissions } : null,
          tenantRole,
          permissions,
          tenant: ownTenant
            ? { id: ownTenant.id, name: ownTenant.name, subdomain: ownTenant.subdomain, mode: ownTenant.mode }
            : null
        }),
        { headers: jsonHeaders }
      );
    }

    // POST /api/auth/change-password: rotate the signed-in user's own password
    if (path === "/api/auth/change-password" && method === "POST") {
      if (!session) return jsonError("Authentication required", 401, jsonHeaders);
      try {
        const body = await request.json<{ currentPassword?: string; newPassword?: string }>();
        const currentPassword = String(body.currentPassword || "");
        const newPassword = String(body.newPassword || "");
        if (!currentPassword || !newPassword) {
          return jsonError("Current and new password are required", 400, jsonHeaders);
        }
        const passwordProblem = validatePasswordStrength(newPassword);
        if (passwordProblem) return jsonError(passwordProblem, 400, jsonHeaders);

        const user = await findUserById(db, session.user_id);
        if (!user || !(await verifyPassword(currentPassword, user.password_hash, user.salt, passwordPepper(env)))) {
          return jsonError("Current password is not correct", 400, jsonHeaders);
        }
        if (currentPassword === newPassword) {
          return jsonError("New password must differ from the current one", 400, jsonHeaders);
        }
        const breached = await breachedPasswordProblem(newPassword, env);
        if (breached) return jsonError(breached, 400, jsonHeaders);

        await updateUserPassword(db, user.id, newPassword, passwordPepper(env));
        await revokeTrustedBrowsers(db, user.id);
        // Any other browser holding this account is signed out; this one stays.
        await deleteSessionsForUser(db, user.id, sessionToken || undefined);
        await writeAuditLog(db, {
          tenantId: session.tenant_id || null,
          userId: user.id,
          action: "auth.change_password"
        });
        return new Response(JSON.stringify({ status: "ok" }), { headers: jsonHeaders });
      } catch (err: any) {
        console.error("[Worker] Password change failed:", err);
        return jsonError("Could not change the password. Please try again.", 400, jsonHeaders);
      }
    }

    // ==========================================
    // SUPER ADMIN API & MASTER CONSOLE
    // ==========================================

    // Renamed with the organization vocabulary; old bookmarks still land.
    if (path === "/super/schools") {
      const redirectUrl = new URL(request.url);
      redirectUrl.pathname = "/super/organizations";
      return Response.redirect(redirectUrl.toString(), 302);
    }

    // On the console's own host (super.<domain>), "/" is the console; "/?login=1" stays the sign-in page.
    if (path === "/super" || path.startsWith("/super/") || (hostname(request).split(".")[0] === "super" && path === "/" && !url.searchParams.has("login"))) {
      // Signed out: the sign-in page, as /admin does.
      if (!session) return Response.redirect(`${url.origin}/?login=1`, 302);
      if (session.role !== "super_admin") {
        return new Response(
          renderLandingHtml({
            error: "Super administrator access required. Please sign in.",
            openModal: "login",
            isoDownloadUrl: env.ISO_DOWNLOAD_URL,
            baseDomain,
            contactEmail: "contact@labkiosk.org",
            ...formChecks,
            nonce
          }),
          { status: 401, headers: htmlHeaders }
        );
      }

      // The approvals queue became Tasks: signups, Remote Control and domain requests.
      // Support became Mail: every address on the mail domain.
      if (path === "/super/approvals" || path === "/super/support") {
        const redirectUrl = new URL(request.url);
        redirectUrl.pathname = path === "/super/approvals" ? "/super/tasks" : "/super/mail";
        return Response.redirect(redirectUrl.toString(), 302);
      }
      let activeTab: "organizations" | "tasks" | "support" | "releases" | "catalogs" | "system" = "organizations";
      if (path === "/super/tasks") activeTab = "tasks";
      else if (path === "/super/releases") activeTab = "releases";
      else if (path === "/super/mail") activeTab = "support";
      else if (path === "/super/catalogs") activeTab = "catalogs";
      else if (path === "/super/system") activeTab = "system";
      else if (path.startsWith("/super/") && path !== "/super/organizations") {
        // A mistyped console address is not the Organizations page.
        return new Response(
          renderStatusPageHtml({
            title: "Page Not Found",
            heading: "This page does not exist",
            messageHtml: "The address may have been mistyped, or the page may have moved.",
            homeHref: `${url.origin}/super`
          }),
          { status: 404, headers: htmlHeaders }
        );
      }

      const allTenants = await listAllTenants(db);
      const catalogs = await listUiCatalogs(db);
      const counts = await inboxCounts(db);
      return new Response(
        renderSuperAdminHtml({
          superAdminEmail: (await findUserById(db, session.user_id))?.email || "admin@labkiosk.org",
          superAdminId: session.user_id,
          tenants: allTenants,
          catalogs,
          baseDomain,
          activeTab,
          inbox: counts,
          nonce
        }),
        { headers: htmlHeaders }
      );
    }

    // POST /api/super/tenants/suspend | /reactivate: pause or resume a whole organization.
    // A suspended organization keeps its data and its console, but its portal, its
    // workstations' telemetry and new enrolments are refused until reactivated.
    if ((path === "/api/super/tenants/suspend" || path === "/api/super/tenants/reactivate") && method === "POST") {
      const denied = requireSuperAdmin(session, jsonHeaders);
      if (denied) return denied;
      const suspend = path.endsWith("/suspend");
      try {
        const body = await request.json<{ tenantId?: string }>();
        const target = body.tenantId ? await findTenantById(db, body.tenantId) : null;
        if (!target) return jsonError("Organization not found", 404, jsonHeaders);
        if (suspend && isDemoTenant(target, session!.user_id)) return jsonError(DEMO_LOCKED_MESSAGE, 400, jsonHeaders);
        if (suspend && target.status !== "active") {
          return jsonError("Only an active organization can be suspended", 400, jsonHeaders);
        }
        if (!suspend && target.status !== "suspended") {
          return jsonError("Only a suspended organization can be reactivated", 400, jsonHeaders);
        }
        await updateTenant(db, target.id, { status: suspend ? "suspended" : "active" });
        await writeAuditLog(db, {
          tenantId: target.id,
          userId: session!.user_id,
          action: suspend ? "tenant.suspend" : "tenant.reactivate"
        });
        // A suspension closes every workstation's connection and refuses heartbeats.
        await notifyConfigChanged(env, target.id);
        return new Response(JSON.stringify({ status: "ok", tenantStatus: suspend ? "suspended" : "active" }), {
          headers: jsonHeaders
        });
      } catch (err: any) {
        console.error("[Worker] Tenant status change failed:", err);
        return jsonError("Could not change this organization's status", 400, jsonHeaders);
      }
    }

    // POST /api/super/tenants/workstation-limit: how many workstations an organization
    // may enrol. Lowering it below what is enrolled only stops new enrolments.
    if (path === "/api/super/tenants/workstation-limit" && method === "POST") {
      const denied = requireSuperAdmin(session, jsonHeaders);
      if (denied) return denied;
      let body: { tenantId?: unknown; limit?: unknown };
      try {
        body = (await request.json<{ tenantId?: unknown; limit?: unknown }>()) ?? {};
      } catch (err) {
        console.warn("[Worker] Unreadable workstation limit request:", err);
        return jsonError("The request body is not valid JSON", 400, jsonHeaders);
      }
      const target = typeof body.tenantId === "string" ? await findTenantById(db, body.tenantId) : null;
      if (!target) return jsonError("Organization not found", 404, jsonHeaders);
      const limit = typeof body.limit === "number" ? body.limit : Number.NaN;
      if (!Number.isInteger(limit) || limit < 1 || limit > MAX_WORKSTATION_LIMIT) {
        return jsonError(`The workstation limit must be a whole number from 1 to ${MAX_WORKSTATION_LIMIT}`, 400, jsonHeaders);
      }
      const enrolled = await countEnrolledWorkstations(db, target.id);
      await updateTenant(db, target.id, { workstation_limit: limit });
      await writeAuditLog(db, {
        tenantId: target.id,
        userId: session!.user_id,
        action: "tenant.workstation_limit",
        details: `limit=${limit} was=${Number(target.workstation_limit) || DEFAULT_WORKSTATION_LIMIT} enrolled=${enrolled}`
      });
      await createNotification(db, { tenantId: target.id, kind: "account", title: "Workstation limit changed", body: `${target.name} may now enrol up to ${limit} workstation${limit === 1 ? "" : "s"}; ${enrolled} ${enrolled === 1 ? "is" : "are"} enrolled. Workstations already enrolled are never cut off.`, createdBy: session!.user_id });
      return new Response(JSON.stringify({ status: "ok", limit, enrolled }), { headers: jsonHeaders });
    }

    // POST /api/super/tenants/license { tenantId, plan, expiresOn }: the license an
    // organization runs under. expiresOn is "YYYY-MM-DD" (00:00 UTC that day) or null
    // for no end date. Once it has passed, new enrolments and Remote Control stop.
    if (path === "/api/super/tenants/license" && method === "POST") {
      const denied = requireSuperAdmin(session, jsonHeaders);
      if (denied) return denied;
      let body: { tenantId?: unknown; plan?: unknown; expiresOn?: unknown };
      try {
        body = (await request.json<{ tenantId?: unknown; plan?: unknown; expiresOn?: unknown }>()) ?? {};
      } catch (err) {
        console.warn("[Worker] Unreadable license request:", err);
        return jsonError("The request body is not valid JSON", 400, jsonHeaders);
      }
      const target = typeof body.tenantId === "string" ? await findTenantById(db, body.tenantId) : null;
      if (!target) return jsonError("Organization not found", 404, jsonHeaders);
      if (!isLicensePlan(body.plan)) {
        return jsonError("The plan must be education, evaluation, subscriber or commercial", 400, jsonHeaders);
      }
      let expiresAt: number | null = null;
      if (body.expiresOn !== null && body.expiresOn !== undefined) {
        expiresAt = typeof body.expiresOn === "string" ? parseLicenseDate(body.expiresOn) : null;
        if (expiresAt === null) return jsonError("The end date must be a date as YYYY-MM-DD, or null for none", 400, jsonHeaders);
      }
      await updateTenant(db, target.id, { license_plan: body.plan, license_expires_at: expiresAt });
      const was = target.license_expires_at ? licenseDate(Number(target.license_expires_at)) : "none";
      await writeAuditLog(db, {
        tenantId: target.id,
        userId: session!.user_id,
        action: "tenant.license",
        details: `plan=${body.plan} expires=${expiresAt === null ? "none" : licenseDate(expiresAt)} was=${licensePlanLabel(target.license_plan)}/${was}`
      });
      await createNotification(db, { tenantId: target.id, kind: "license", title: "License updated", body: `Lab Kiosk recorded the license of ${target.name}: ${licensePlanLabel(body.plan)}${expiresAt === null ? ", with no end date" : `, until ${licenseDate(expiresAt)}`}.`, createdBy: session!.user_id });
      return new Response(JSON.stringify({ status: "ok", plan: body.plan, expiresAt }), { headers: jsonHeaders });
    }

    // POST /api/super/tenants/remote-control { tenantId, action, seats? }: the platform's
    // controls over an organization's Remote Control. "revoke" turns it off and ends
    // every open session at once; "restore" turns it back on; "seats" sets how many
    // sessions may be open at once.
    if (path === "/api/super/tenants/remote-control" && method === "POST") {
      const denied = requireSuperAdmin(session, jsonHeaders);
      if (denied) return denied;
      let body: { tenantId?: unknown; action?: unknown; seats?: unknown; reason?: unknown };
      try {
        body = (await request.json<typeof body>()) ?? {};
      } catch (err) {
        console.warn("[Worker] Unreadable Remote Control request:", err);
        return jsonError("The request body is not valid JSON", 400, jsonHeaders);
      }
      const target = typeof body.tenantId === "string" ? await findTenantById(db, body.tenantId) : null;
      if (!target) return jsonError("Organization not found", 404, jsonHeaders);
      const action = body.action;
      if (action !== "revoke" && action !== "restore" && action !== "seats") {
        return jsonError("The action is revoke, restore or seats", 400, jsonHeaders);
      }
      const seats = body.seats;
      const validSeats = typeof seats === "number" && Number.isInteger(seats) && seats >= 1 && seats <= MAX_REMOTE_CONTROL_SEATS;
      if (action === "seats" && !validSeats) {
        return jsonError(`Remote Control seats must be a whole number from 1 to ${MAX_REMOTE_CONTROL_SEATS}`, 400, jsonHeaders);
      }
      if (action === "revoke") {
        if (isDemoTenant(target, session!.user_id)) return jsonError("The platform's demo organizations keep Remote Control", 400, jsonHeaders);
        if (target.remote_control_status !== "approved") return jsonError("Remote Control is not on for this organization", 409, jsonHeaders);
        const reason = typeof body.reason === "string" ? body.reason.replace(/\r\n/g, "\n").trim().slice(0, 2000) : "";
        await updateTenant(db, target.id, { remote_control_status: "rejected", remote_control_revoked_at: Math.floor(Date.now() / 1000) });
        const closed = await closeAllRemoteSessions(env, target.id);
        await writeAuditLog(db, {
          tenantId: target.id,
          userId: session!.user_id,
          action: "remote_control.revoke",
          details: `sessions_closed=${closed}${reason ? ` reason=${reason.slice(0, 200)}` : ""}`
        });
        await createNotification(db, { tenantId: target.id, kind: "remote_control", title: "Remote Control has been turned off", body: `Lab Kiosk has turned Remote Control off for ${target.name}. Any session that was open has ended.${reason ? `\n\n${reason}` : ""}`, createdBy: session!.user_id });
        const owner = await findUserById(db, target.user_id);
        let emailSent = false;
        if (owner?.email && !mailConfigProblem(env)) {
          try {
            await sendMail(env, {
              to: owner.email,
              toName: owner.name,
              subject: "Remote Control has been turned off",
              text:
                `Hello ${owner.name || ""},\n\n` +
                `Lab Kiosk has turned Remote Control off for ${target.name}. Any session that was open has ended.` +
                (reason ? `\n\n${reason}` : "") +
                `\n\nYour workstations keep working as before. To ask for Remote Control again, open Settings in your console, or reply to this email.\n\nLab Kiosk`,
              template: { name: "notice", title: "Remote Control has been turned off" }
            });
            emailSent = true;
          } catch (err) {
            console.error(`[Worker] Could not email ${target.name} that Remote Control was turned off:`, err);
          }
        }
        return new Response(JSON.stringify({ status: "ok", remoteControlStatus: "rejected", sessionsClosed: closed, emailSent }), { headers: jsonHeaders });
      }
      if (action === "restore") {
        if (target.remote_control_status === "approved") return jsonError("Remote Control is already on for this organization", 409, jsonHeaders);
        if (!target.remote_control_revoked_at) return jsonError("Only Remote Control the platform turned off can be restored; a new request goes through Tasks", 409, jsonHeaders);
        const update: Partial<Tenant> = { remote_control_status: "approved", remote_control_revoked_at: null };
        if (validSeats) update.remote_control_seats = seats as number;
        await updateTenant(db, target.id, update);
        await writeAuditLog(db, { tenantId: target.id, userId: session!.user_id, action: "remote_control.restore" });
        await createNotification(db, { tenantId: target.id, kind: "remote_control", title: "Remote Control is on again", body: `Lab Kiosk has turned Remote Control back on for ${target.name}. Administrators can open it from a workstation's card.`, createdBy: session!.user_id });
        return new Response(JSON.stringify({ status: "ok", remoteControlStatus: "approved" }), { headers: jsonHeaders });
      }
      await updateTenant(db, target.id, { remote_control_seats: seats as number });
      await writeAuditLog(db, {
        tenantId: target.id,
        userId: session!.user_id,
        action: "remote_control.seats",
        details: `seats=${seats} was=${Number(target.remote_control_seats) || 1}`
      });
      await createNotification(db, { tenantId: target.id, kind: "remote_control", title: "Remote Control seats changed", body: `${target.name} may now have ${seats} Remote Control session${seats === 1 ? "" : "s"} open at once.`, createdBy: session!.user_id });
      return new Response(JSON.stringify({ status: "ok", seats }), { headers: jsonHeaders });
    }

    // GET /api/i18n: which interface languages this platform can supply.
    // Public and read-only: a workstation asks before it is enrolled.
    if (path === "/api/i18n" && method === "GET") {
      const catalogs = await listUiCatalogs(db);
      return new Response(
        JSON.stringify({
          languages: catalogs.map((row) => ({
            tag: row.tag,
            name: row.name,
            direction: row.direction,
            entries: row.entry_count,
            updatedAt: row.updated_at,
          })),
        }),
        { headers: jsonHeaders }
      );
    }

    // GET /i18n/<tag>.json: the catalog itself, in the shape the wizard and the
    // kiosk bar read. Stored already sanitised, so it is handed back verbatim.
    if (path.startsWith("/i18n/") && path.endsWith(".json") && method === "GET") {
      const tag = path.slice("/i18n/".length, -".json".length);
      if (!LANGUAGE_TAG_PATTERN.test(tag)) {
        return jsonError("No such language", 404, jsonHeaders);
      }
      const row = await getUiCatalog(db, tag);
      if (!row) return jsonError("No such language", 404, jsonHeaders);
      return new Response(row.body, {
        headers: {
          ...jsonHeaders,
          "Content-Type": "application/json; charset=utf-8",
          // Interface text changes rarely, and a lab of forty workstations
          // fetches it at the same moment after a holiday.
          "Cache-Control": "public, max-age=3600",
        },
      });
    }

    // GET /api/super/i18n: list stored interface catalogs for the super admin.
    if (path === "/api/super/i18n" && method === "GET") {
      const denied = requireSuperAdmin(session, jsonHeaders);
      if (denied) return denied;
      const catalogs = await listUiCatalogs(db);
      return new Response(
        JSON.stringify({
          languages: catalogs.map((row) => ({
            tag: row.tag,
            name: row.name,
            direction: row.direction,
            entries: row.entry_count,
            updatedAt: row.updated_at,
          })),
        }),
        { headers: jsonHeaders }
      );
    }

    // POST /api/super/i18n: upload or replace a catalog. Platform-wide, so it
    // is the super admin's to write and nobody else's.
    if (path === "/api/super/i18n" && method === "POST") {
      const denied = requireSuperAdmin(session, jsonHeaders);
      if (denied) return denied;
      try {
        const body = await request.json<{ tag: string; name?: string; direction?: string; catalog: unknown }>();
        const tag = String(body.tag || "").trim();
        if (!LANGUAGE_TAG_PATTERN.test(tag)) {
          return jsonError("A language tag looks like en-US or hi-IN", 400, jsonHeaders);
        }
        const { body: catalogBody, entryCount } = sanitizeCatalog(body.catalog);
        const name = String(body.name || tag).trim().slice(0, 120) || tag;
        const direction = String(body.direction || "").toLowerCase() === "rtl" ? "rtl" : "ltr";
        await putUiCatalog(db, {
          tag,
          name,
          direction,
          body: catalogBody,
          entryCount,
          updatedBy: session?.user_id ?? null,
        });
        await writeAuditLog(db, {
          tenantId: null,
          userId: session?.user_id ?? null,
          action: "i18n.upload",
          details: `${tag} (${entryCount} entries)`,
        });
        return new Response(JSON.stringify({ status: "ok", tag, entries: entryCount }), { headers: jsonHeaders });
      } catch (err) {
        return jsonError(err instanceof Error ? err.message : "Invalid catalog", 400, jsonHeaders);
      }
    }

    // DELETE /api/super/i18n/<tag>: withdraw one. Workstations that already
    // downloaded it keep what they have; nothing new receives it.
    if (path.startsWith("/api/super/i18n/") && method === "DELETE") {
      const denied = requireSuperAdmin(session, jsonHeaders);
      if (denied) return denied;
      const tag = path.slice("/api/super/i18n/".length);
      if (!LANGUAGE_TAG_PATTERN.test(tag)) {
        return jsonError("No such language", 404, jsonHeaders);
      }
      await deleteUiCatalog(db, tag);
      await writeAuditLog(db, {
        tenantId: null,
        userId: session?.user_id ?? null,
        action: "i18n.delete",
        details: tag,
      });
      return new Response(JSON.stringify({ status: "ok", tag }), { headers: jsonHeaders });
    }

    // GET /api/super/releases: the releases CI uploaded, as the releases bucket
    // holds them. Each call first records any new release it finds there.
    if (path === "/api/super/releases" && method === "GET") {
      const denied = requireSuperAdmin(session, jsonHeaders);
      if (denied) return denied;
      const sync = await recordNewReleases(env, db);
      if (!sync) return jsonError("This server has no releases bucket (RELEASES binding)", 503, jsonHeaders);
      const releases = await listReleases(db);
      const names = await tenantNames(db);
      return new Response(
        JSON.stringify({
          releases,
          ...(await platformReleasePolicy(db, releases, names)),
          added: sync.added,
          problems: sync.problems,
          downloadsConfigured: releaseFolderUrl(env, "0.0.0") !== null,
          downloadsDevelopmentOnly: releaseAddressIsDevelopmentOnly(env)
        }),
        { headers: jsonHeaders }
      );
    }

    // POST /api/super/releases/classify { version, channel: "beta" | "stable" | null }
    // POST /api/super/releases/revoke { version }
    // Classifying puts a feature release in front of every organization on that
    // channel; a security release has no channel, it is offered from the moment
    // it is recorded. Revoking withdraws either for good. Either way each organization's hub reloads,
    // so connected workstations hear of the change at once.
    if ((path === "/api/super/releases/classify" || path === "/api/super/releases/revoke") && method === "POST") {
      const denied = requireSuperAdmin(session, jsonHeaders);
      if (denied) return denied;
      let body: { version?: unknown; channel?: unknown };
      try {
        body = (await request.json<typeof body>()) ?? {};
      } catch {
        return jsonError("The request body must be JSON", 400, jsonHeaders);
      }
      if (!isReleaseVersion(body?.version)) return jsonError("A release version is required", 400, jsonHeaders);
      const version = body.version;
      const release = await findRelease(db, version);
      if (!release) return jsonError("Release not found", 404, jsonHeaders);
      if (release.revoked_at) return jsonError("This release was revoked", 409, jsonHeaders);
      const revoke = path.endsWith("/revoke");
      let details = version;
      if (revoke) {
        await revokeRelease(db, version);
        details = `${version} revoked`;
      } else {
        if (release.kind === "security") {
          return jsonError("A security release is offered on its line by itself; it can only be revoked", 409, jsonHeaders);
        }
        const channel = body.channel === null || body.channel === "" ? null : body.channel;
        if (channel !== null && !isUpdateChannel(channel)) {
          return jsonError("The channel is beta, stable or none", 400, jsonHeaders);
        }
        await classifyRelease(db, version, channel, session!.user_id);
        details = `${version} -> ${channel || "unclassified"}`;
      }
      await writeAuditLog(db, {
        tenantId: null,
        userId: session!.user_id,
        action: revoke ? "release.revoke" : "release.classify",
        details
      });
      await notifyOrganizationsOnline(env, db);
      return new Response(JSON.stringify({ status: "ok", releases: await listReleases(db) }), { headers: jsonHeaders });
    }

    // POST /api/super/release-support { major, status, endOfLifeAt?, note?, notify? }:
    // a major release's support status, which covers every release of that major.
    // "security_only" moves no workstation onto it and offers the workstations
    // already on it only its security releases; "end_of_life" offers it nothing.
    // endOfLifeAt (Unix seconds, or null) announces the date it ends by itself.
    // Every organization gets a console notification; notify emails every owner too.
    if (path === "/api/super/release-support" && method === "POST") {
      const denied = requireSuperAdmin(session, jsonHeaders);
      if (denied) return denied;
      let body: { major?: unknown; status?: unknown; endOfLifeAt?: unknown; note?: unknown; notify?: unknown };
      try {
        body = (await request.json<typeof body>()) ?? {};
      } catch {
        return jsonError("The request body must be JSON", 400, jsonHeaders);
      }
      if (!isReleaseMajor(body?.major)) {
        return jsonError("A major release number such as 3 is required", 400, jsonHeaders);
      }
      if (!isSupportStatus(body.status)) return jsonError("The status is supported, security_only or end_of_life", 400, jsonHeaders);
      const endOfLifeAt = body.endOfLifeAt ?? null;
      if (endOfLifeAt !== null && !(typeof endOfLifeAt === "number" && Number.isSafeInteger(endOfLifeAt) && endOfLifeAt > 0)) {
        return jsonError("endOfLifeAt is a date in Unix seconds, or null", 400, jsonHeaders);
      }
      if (body.note !== undefined && body.note !== null && typeof body.note !== "string") {
        return jsonError("The note is text", 400, jsonHeaders);
      }
      const note = typeof body.note === "string" && body.note.trim() ? body.note.replace(/\r\n/g, "\n").trim().slice(0, 500) : null;
      const major = body.major;
      const status = body.status;
      const previous = (await listMajorSupport(db)).get(major);
      // A note alone tells nobody anything new.
      const changed =
        !previous || previous.status !== status || (previous.end_of_life_at === null ? null : Number(previous.end_of_life_at)) !== endOfLifeAt;
      await setMajorSupport(db, major, status, endOfLifeAt as number | null, note, session!.user_id);
      await writeAuditLog(db, {
        tenantId: null,
        userId: session!.user_id,
        action: "release.support",
        details: `${major} ${status}${endOfLifeAt ? ` end_of_life_at=${endOfLifeAt}` : ""}`
      });
      await notifyOrganizationsOnline(env, db);
      // Every organization is told in its console; with notify, every owner is emailed too.
      let outcome: EmailOutcome = { emailed: 0, emailFailed: 0, emailProblem: null };
      if (changed && (status !== "supported" || endOfLifeAt !== null)) {
        const notice = majorSupportNotice(major, status, endOfLifeAt as number | null, note);
        await createNotification(db, { tenantId: null, kind: "release", title: notice.title, body: notice.body, createdBy: session!.user_id });
        // This announcement stands in for the reminders already due.
        if (endOfLifeAt !== null) await setEndOfLifeReminderStage(db, major, endOfLifeReminderStage(endOfLifeAt as number));
        if (body.notify === true) {
          const usage = new Map((await workstationsPerMajor(db)).filter((u) => u.major === major).map((u) => [u.tenantId, u.workstations]));
          outcome = await emailOrganizations(env, await activeOrganizationOwners(db, null), notice.title, (owner) => {
            const running = usage.get(owner.tenantId);
            return notice.body + (running ? `\n\n${running} of ${owner.name}'s workstations run Lab Kiosk ${major}.` : "");
          });
        }
      }
      const { emailed, emailFailed, emailProblem } = outcome;
      const releases = await listReleases(db);
      const names = await tenantNames(db);
      return new Response(
        JSON.stringify({ status: "ok", emailed, emailFailed, emailProblem, ...(await platformReleasePolicy(db, releases, names)) }),
        { headers: jsonHeaders }
      );
    }

    // POST /api/super/release-majors { major, action, tenantId? | subdomain?, reason? }:
    // whether workstations may be moved to a major release. "open" opens it to every
    // organization, "close" closes it; "grant" and "ungrant" open or close it for
    // one organization, and "decline" turns down an organization's request for it.
    // Either way, an administrator of the organization still tries it on a group or
    // confirms it before any of its workstations is moved. The organization is notified.
    if (path === "/api/super/release-majors" && method === "POST") {
      const denied = requireSuperAdmin(session, jsonHeaders);
      if (denied) return denied;
      let body: { major?: unknown; action?: unknown; tenantId?: unknown; subdomain?: unknown; reason?: unknown };
      try {
        body = (await request.json<typeof body>()) ?? {};
      } catch {
        return jsonError("The request body must be JSON", 400, jsonHeaders);
      }
      const major = body?.major;
      if (typeof major !== "number" || !Number.isInteger(major) || major < 0 || major > MAX_RELEASE_MAJOR) {
        return jsonError("A major release number is required", 400, jsonHeaders);
      }
      const action = body.action;
      if (action !== "open" && action !== "close" && action !== "grant" && action !== "ungrant" && action !== "decline") {
        return jsonError("The action is open, close, grant, ungrant or decline", 400, jsonHeaders);
      }
      const reason = typeof body.reason === "string" ? body.reason.trim() : "";
      if (reason.length > 500) return jsonError("The reason is at most 500 characters", 400, jsonHeaders);
      let details = `${major} ${action}`;
      if (action === "open" || action === "close") {
        const wasOpen = (await listReleaseMajors(db)).get(major) === true;
        await setReleaseMajorOpen(db, major, action === "open", session!.user_id);
        await writeAuditLog(db, { tenantId: null, userId: session!.user_id, action: "release.major", details });
        if (action === "open" && !wasOpen) {
          await createNotification(db, {
            tenantId: null,
            kind: "release",
            title: `Lab Kiosk ${major} is available`,
            body: `Lab Kiosk ${major} is a new major release. None of your workstations moves to it until an administrator tries it on a workstation group or confirms it under Settings → Updates.`,
            createdBy: session!.user_id
          });
        }
        await notifyOrganizationsOnline(env, db);
      } else {
        const target =
          typeof body.tenantId === "string"
            ? await findTenantById(db, body.tenantId)
            : typeof body.subdomain === "string" && body.subdomain.trim()
            ? await findTenantBySubdomain(db, body.subdomain.trim().toLowerCase())
            : null;
        if (!target) return jsonError("Organization not found", 404, jsonHeaders);
        if (action === "grant" && (await listReleaseMajors(db)).get(major) === undefined) {
          return jsonError(`Release ${major} is not closed; every organization is offered it already`, 409, jsonHeaders);
        }
        let notice: { title: string; body: string };
        if (action === "decline") {
          if (!(await declineMajorRequest(db, target.id, major))) {
            return jsonError(`${target.name} has no open request for Lab Kiosk ${major}`, 409, jsonHeaders);
          }
          notice = {
            title: `Your request for Lab Kiosk ${major} was declined`,
            body: `Lab Kiosk has declined the request of ${target.name} for Lab Kiosk ${major} for now. Your workstations stay on the release they run, and you may ask again later.`
          };
        } else {
          await setMajorGrant(db, target.id, major, action === "grant", session!.user_id);
          notice =
            action === "grant"
              ? {
                  title: `Lab Kiosk ${major} is available to ${target.name}`,
                  body: `Lab Kiosk ${major} is now available to your organization. No workstation moves to it yet: under Settings → Updates, try it on one workstation group first, then confirm it for every workstation.`
                }
              : {
                  title: `Lab Kiosk ${major} is no longer available`,
                  body: `Lab Kiosk has taken back Lab Kiosk ${major} from ${target.name}. Workstations that already run it keep it; no other workstation moves to it.`
                };
        }
        if (reason) notice.body += `\n\n${reason}`;
        await createNotification(db, { tenantId: target.id, kind: "release", ...notice, createdBy: session!.user_id });
        details = `${major} ${action} tenant=${target.id}`;
        await writeAuditLog(db, { tenantId: target.id, userId: session!.user_id, action: "release.major", details });
        await notifyConfigChanged(env, target.id);
      }
      const releases = await listReleases(db);
      const names = await tenantNames(db);
      return new Response(JSON.stringify({ status: "ok", ...(await platformReleasePolicy(db, releases, names)) }), {
        headers: jsonHeaders
      });
    }

    // GET /api/super/notifications: what the platform has told organizations, newest first.
    // POST /api/super/notifications { tenantId | null, title, body, email }: tell one
    // organization (tenantId) or every organization (null) in its console, and
    // with email, email its owner too.
    if (path === "/api/super/notifications") {
      const denied = requireSuperAdmin(session, jsonHeaders);
      if (denied) return denied;
      if (method === "POST") {
        let body: { tenantId?: unknown; title?: unknown; body?: unknown; email?: unknown };
        try {
          body = (await request.json<typeof body>()) ?? {};
        } catch {
          return jsonError("The request body must be JSON", 400, jsonHeaders);
        }
        const title = typeof body.title === "string" ? body.title.trim() : "";
        const text = typeof body.body === "string" ? body.body.replace(/\r\n/g, "\n").trim() : "";
        if (!title || title.length > NOTIFICATION_LIMITS.title) {
          return jsonError(`A title of up to ${NOTIFICATION_LIMITS.title} characters is required`, 400, jsonHeaders);
        }
        if (!text || text.length > NOTIFICATION_LIMITS.body) {
          return jsonError(`A message of up to ${NOTIFICATION_LIMITS.body} characters is required`, 400, jsonHeaders);
        }
        if (body.email !== undefined && typeof body.email !== "boolean") return jsonError("email is true or false", 400, jsonHeaders);
        let tenantId: string | null = null;
        if (body.tenantId !== null && body.tenantId !== undefined) {
          const target = typeof body.tenantId === "string" ? await findTenantById(db, body.tenantId) : null;
          if (!target) return jsonError("Organization not found", 404, jsonHeaders);
          if (target.status !== "active") return jsonError("Only an active organization can be notified", 409, jsonHeaders);
          tenantId = target.id;
        }
        const id = await createNotification(db, { tenantId, kind: "general", title, body: text, createdBy: session!.user_id });
        const outcome: EmailOutcome =
          body.email === true
            ? await emailOrganizations(env, await activeOrganizationOwners(db, tenantId), title, () => text)
            : { emailed: 0, emailFailed: 0, emailProblem: null };
        await writeAuditLog(db, {
          tenantId,
          userId: session!.user_id,
          action: "notification.send",
          details: `id=${id} to=${tenantId ?? "all"} emailed=${outcome.emailed} failed=${outcome.emailFailed}`
        });
        return new Response(JSON.stringify({ status: "ok", id, ...outcome, notifications: await listSentNotifications(db) }), {
          headers: jsonHeaders
        });
      }
      if (method !== "GET") return jsonError("Method not allowed", 405, jsonHeaders);
      return new Response(JSON.stringify({ status: "ok", notifications: await listSentNotifications(db) }), { headers: jsonHeaders });
    }

    // GET /api/super/legal: the documents in force, when each version was
    // published, and how many active organizations accepted it.
    // GET /api/super/legal/acceptances?tenantId=&format=csv: the acceptance
    // record, of one organization or all, as JSON or CSV.
    // POST /api/super/legal/notify { document }: email the owner of every active
    // organization that has not accepted the current version.
    if (path === "/api/super/legal" && method === "GET") {
      const denied = requireSuperAdmin(session, jsonHeaders);
      if (denied) return denied;
      return new Response(JSON.stringify(await platformLegalOverview(db, session!.user_id)), { headers: jsonHeaders });
    }
    if (path === "/api/super/legal/acceptances" && method === "GET") {
      const denied = requireSuperAdmin(session, jsonHeaders);
      if (denied) return denied;
      const tenantId = url.searchParams.get("tenantId");
      if (tenantId !== null && !(await findTenantById(db, tenantId))) return jsonError("Organization not found", 404, jsonHeaders);
      const rows = await listLegalAcceptances(db, tenantId);
      if (url.searchParams.get("format") === "csv") {
        return new Response(acceptancesCsv(rows), {
          headers: {
            ...jsonHeaders,
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="legal-acceptances${tenantId ? `-${tenantId}` : ""}.csv"`
          }
        });
      }
      return new Response(JSON.stringify({ acceptances: rows }), { headers: jsonHeaders });
    }
    if (path === "/api/super/legal/notify" && method === "POST") {
      const denied = requireSuperAdmin(session, jsonHeaders);
      if (denied) return denied;
      let body: { document?: unknown };
      try {
        body = (await request.json<typeof body>()) ?? {};
      } catch {
        return jsonError("The request body must be JSON", 400, jsonHeaders);
      }
      if (!isLegalDocumentId(body?.document)) return jsonError("Name a legal document", 400, jsonHeaders);
      const problem = mailConfigProblem(env);
      if (problem) return jsonError("This server cannot send email", 503, jsonHeaders);
      const doc = (await publishedLegalVersions(db)).find((d) => d.id === body.document)!;
      if (!doc.required) return jsonError(`The ${doc.title} is not accepted by organizations`, 400, jsonHeaders);
      const date = new Date(doc.effectiveAt * 1000).toISOString().slice(0, 10);
      let emailed = 0;
      let failed = 0;
      const accepted = new Set(
        ((await db
          .prepare("SELECT DISTINCT tenant_id FROM legal_acceptances WHERE document = ? AND version = ?")
          .bind(doc.id, doc.version)
          .all<{ tenant_id: string }>()).results || []).map((r) => r.tenant_id)
      );
      const pending = (await listAllTenants(db)).filter(
        (t) => t.status === "active" && !isDemoTenant(t, session!.user_id) && !accepted.has(t.id)
      );
      for (const tenant of pending) {
        try {
          await sendMail(env, {
            to: tenant.admin_email,
            toName: tenant.admin_name,
            subject: `Updated Lab Kiosk ${doc.title}`,
            text:
              `Hello ${tenant.admin_name || ""},\n\n` +
              `We have updated the Lab Kiosk ${doc.title} (version ${doc.version}). You can read it at https://${baseDomain}${doc.path}.\n\n` +
              `An administrator of ${tenant.name} needs to accept it in your console. From ${date} the console asks for it before anything else; ` +
              `your workstations, homepage and User Portal keep working throughout.\n\nLab Kiosk`,
            template: { name: "notice", title: `Updated ${doc.title}` }
          });
          emailed++;
        } catch (err) {
          failed++;
          console.error(`[Worker] Could not email ${tenant.name} about the ${doc.title}:`, err);
        }
      }
      await db.prepare("UPDATE legal_versions SET notified_at = ? WHERE document = ? AND version = ?")
        .bind(Math.floor(Date.now() / 1000), doc.id, doc.version)
        .run();
      await writeAuditLog(db, {
        tenantId: null,
        userId: session!.user_id,
        action: "legal.notify",
        details: `${doc.id}=${doc.version} emailed=${emailed} failed=${failed}`
      });
      return new Response(JSON.stringify({ status: "ok", emailed, failed, ...(await platformLegalOverview(db, session!.user_id)) }), { headers: jsonHeaders });
    }

    // GET /api/super/link-blocklist: the domains no hosted page may link to.
    // POST /api/super/link-blocklist { domain, reason? }: add one.
    // POST /api/super/link-blocklist/remove { domain }: remove one.
    if (path === "/api/super/link-blocklist" || path === "/api/super/link-blocklist/remove") {
      const denied = requireSuperAdmin(session, jsonHeaders);
      if (denied) return denied;
      if (method === "GET" && path === "/api/super/link-blocklist") {
        return new Response(JSON.stringify({ domains: await listLinkBlocklist(db) }), { headers: jsonHeaders });
      }
      if (method !== "POST") return jsonError("Method not allowed", 405, jsonHeaders);
      let body: { domain?: unknown; reason?: unknown };
      try {
        body = (await request.json<typeof body>()) ?? {};
      } catch {
        return jsonError("The request body must be JSON", 400, jsonHeaders);
      }
      const domain = typeof body?.domain === "string" ? body.domain.trim().toLowerCase().replace(/\.$/, "") : "";
      if (!BLOCKLIST_DOMAIN_PATTERN.test(domain)) return jsonError("A domain name such as example.com is required", 400, jsonHeaders);
      const remove = path.endsWith("/remove");
      if (remove) {
        if (!(await removeBlockedDomain(db, domain))) return jsonError("That domain is not on the blocklist", 404, jsonHeaders);
      } else {
        const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 300) : null;
        await addBlockedDomain(db, domain, reason, session!.user_id);
      }
      await writeAuditLog(db, {
        tenantId: null,
        userId: session!.user_id,
        action: remove ? "content.unblock" : "content.block",
        details: domain
      });
      return new Response(JSON.stringify({ status: "ok", domains: await listLinkBlocklist(db) }), { headers: jsonHeaders });
    }

    // POST /api/super/tenants/content { tenantId, target: "homepage" | "card", action: "takedown" | "restore", url?, reason? }:
    // take an organization's homepage, or the User Portal cards linking to `url`,
    // down after a report, or put them back. Taking down emails the owner the reason.
    if (path === "/api/super/tenants/content" && method === "POST") {
      const denied = requireSuperAdmin(session, jsonHeaders);
      if (denied) return denied;
      let body: { tenantId?: unknown; target?: unknown; action?: unknown; url?: unknown; reason?: unknown };
      try {
        body = (await request.json<typeof body>()) ?? {};
      } catch {
        return jsonError("The request body must be JSON", 400, jsonHeaders);
      }
      const target = typeof body?.tenantId === "string" ? await findTenantById(db, body.tenantId) : null;
      if (!target) return jsonError("Organization not found", 404, jsonHeaders);
      if (body.target !== "homepage" && body.target !== "card") return jsonError("The target is homepage or card", 400, jsonHeaders);
      if (body.action !== "takedown" && body.action !== "restore") return jsonError("The action is takedown or restore", 400, jsonHeaders);
      const takedown = body.action === "takedown";
      const reason = typeof body.reason === "string" ? body.reason.replace(/\r\n/g, "\n").trim().slice(0, 2000) : "";
      if (takedown && !reason) return jsonError("Give the reason; the organization is told it", 400, jsonHeaders);
      const now = Math.floor(Date.now() / 1000);
      let what: string;
      if (body.target === "homepage") {
        if (takedown === Boolean(target.homepage_takedown_at)) {
          return jsonError(takedown ? "The homepage is already taken down" : "The homepage is not taken down", 409, jsonHeaders);
        }
        await updateTenant(db, target.id, { homepage_takedown_at: takedown ? now : null, homepage_takedown_reason: takedown ? reason : null });
        what = "organization homepage";
      } else {
        const cardUrl = safeHttpUrl(body.url);
        if (!cardUrl) return jsonError("The card's link (an http or https address) is required", 400, jsonHeaders);
        const changed = await setPortalSiteTakedown(db, target.id, cardUrl, takedown ? { at: now, reason } : null);
        if (!changed) return jsonError(takedown ? "No active card of this organization links there" : "No card linking there is taken down", 404, jsonHeaders);
        what = `User Portal card${changed === 1 ? "" : "s"} linking to ${cardUrl}`;
        await notifyConfigChanged(env, target.id);
      }
      await writeAuditLog(db, {
        tenantId: target.id,
        userId: session!.user_id,
        action: takedown ? "content.takedown" : "content.restore",
        details: `${body.target}${body.target === "card" ? ` ${safeHttpUrl(body.url)}` : ""}${reason ? ` reason=${reason.slice(0, 200)}` : ""}`
      });
      await createNotification(db, { tenantId: target.id, kind: "content", title: takedown ? `Lab Kiosk took down your ${what}` : `Lab Kiosk restored your ${what}`, body: takedown ? `Lab Kiosk took down your ${what} under the Terms of Service and the Content Policy: ${reason}\n\nTo contest it, write to legal@labkiosk.org.` : `Lab Kiosk restored your ${what}. It is shown again.`, createdBy: session!.user_id });
      let emailSent = false;
      const owner = await findUserById(db, target.user_id);
      if (takedown && owner?.email && !mailConfigProblem(env)) {
        try {
          await sendMail(env, {
            to: owner.email,
            toName: owner.name,
            subject: `Lab Kiosk took down your ${body.target === "homepage" ? "organization homepage" : "User Portal card"}`,
            text:
              `Hello ${owner.name || ""},\n\n` +
              `Lab Kiosk has taken down ${target.name}'s ${what} under the Terms of Service and the Content Policy.\n\n${reason}\n\n` +
              `Your workstations keep working. To contest this, reply to this email or write to legal@labkiosk.org.\n\nLab Kiosk`,
            template: { name: "notice", title: "Content taken down" }
          });
          emailSent = true;
        } catch (err) {
          console.error(`[Worker] Could not email ${target.name} about a takedown:`, err);
        }
      }
      return new Response(JSON.stringify({ status: "ok", emailSent }), { headers: jsonHeaders });
    }

    // POST /api/super/tenants/approve: Approve or Assign Subdomain
    // GET /api/super/audit-logs: what the platform has done -- catalog uploads
    // and deletions, and every super-admin action taken on an organization. Every one
    // of these was already being written and none of it could be read back:
    // `listAuditLogs` is scoped to a tenant, so the entries with no tenant were
    // invisible to everything.
    if (path === "/api/super/audit-logs" && method === "GET") {
      const denied = requireSuperAdmin(session, jsonHeaders);
      if (denied) return denied;
      const limit = Number(url.searchParams.get("limit") || 100);
      const logs = await listPlatformAuditLogs(db, Number.isFinite(limit) ? limit : 100);
      return new Response(JSON.stringify({ logs }), { headers: jsonHeaders });
    }

    // GET /api/super/usage?days=N: the platform's anonymous usage totals and the
    // hardware every organization's workstations run on, by model. Nothing here
    // names an organization (src/usage.ts, src/hardware.ts).
    if (path === "/api/super/usage" && method === "GET") {
      const denied = requireSuperAdmin(session, jsonHeaders);
      if (denied) return denied;
      const days = Number(url.searchParams.get("days") || 30);
      if (!Number.isInteger(days) || days < 1 || days > MAX_REPORT_DAYS) {
        return jsonError(`days is a whole number from 1 to ${MAX_REPORT_DAYS}`, 400, jsonHeaders);
      }
      const [usage, models, modelsAt] = await Promise.all([
        platformUsage(db, reportPeriod(days)),
        listHardwareModels(db),
        hardwareModelsComputedAt(db)
      ]);
      return new Response(JSON.stringify({ ...usage, hardware: { models, computedAt: modelsAt } }), { headers: jsonHeaders });
    }

    if (path === "/api/super/tenants/approve" && method === "POST") {
      const denied = requireSuperAdmin(session, jsonHeaders);
      if (denied) return denied;
      try {
        const body = await request.json<{ tenantId: string; subdomain: string }>();
        const cleanSub = cleanSubdomain(body.subdomain);
        if (cleanSub.length < 3 || cleanSub.length > MAX_SUBDOMAIN_LENGTH || isReservedSlug(cleanSub)) {
          return jsonError(`Subdomain must be 3-${MAX_SUBDOMAIN_LENGTH} characters (letters, numbers, hyphens) and not a reserved name`, 400, jsonHeaders);
        }

        if (isDemoTenant(await findTenantById(db, body.tenantId), session!.user_id)) {
          return jsonError(DEMO_LOCKED_MESSAGE, 400, jsonHeaders);
        }
        const existing = await findTenantBySubdomain(db, cleanSub);
        if (existing && existing.id !== body.tenantId) {
          return jsonError("Subdomain already assigned to another organization", 400, jsonHeaders);
        }

        const target = await findTenantById(db, body.tenantId);
        if (!target) return jsonError("Organization not found", 404, jsonHeaders);
        // Activating a registration is a decision with its own checks and email:
        // it is made from Tasks, never as a side effect of assigning an address.
        await updateTenant(db, body.tenantId, {
          subdomain: cleanSub,
          requested_subdomain: null
        });

        await writeAuditLog(db, {
          tenantId: body.tenantId,
          userId: session!.user_id,
          action: "tenant.approve",
          details: `subdomain=${cleanSub}`
        });
        await notifyConfigChanged(env, body.tenantId);

        return new Response(JSON.stringify({ status: "ok", subdomain: cleanSub }), { headers: jsonHeaders });
      } catch (err: any) {
        console.error("[Worker] Tenant approval failed:", err);
        return jsonError("Could not approve this subdomain", 400, jsonHeaders);
      }
    }

    // POST /api/super/tenants/reject: Reject Subdomain Request
    if (path === "/api/super/tenants/reject" && method === "POST") {
      const denied = requireSuperAdmin(session, jsonHeaders);
      if (denied) return denied;
      try {
        const body = await request.json<{ tenantId: string }>();
        const target = await findTenantById(db, body.tenantId);
        if (!target) return jsonError("Organization not found", 404, jsonHeaders);
        if (isDemoTenant(target, session!.user_id)) {
          return jsonError(DEMO_LOCKED_MESSAGE, 400, jsonHeaders);
        }
        // A registration is decided from Tasks, which tells the customer why.
        if (target.status === "pending") {
          return jsonError("Decide registrations from Tasks, where the customer is emailed the outcome", 409, jsonHeaders);
        }
        if (!target.requested_subdomain) return jsonError("This organization has no subdomain request", 400, jsonHeaders);
        // Declining a new address keeps the organization on the one it has.
        await updateTenant(db, body.tenantId, { requested_subdomain: null });
        await writeAuditLog(db, {
          tenantId: body.tenantId,
          userId: session!.user_id,
          action: "tenant.reject_subdomain",
          details: `requested=${target.requested_subdomain}`
        });
        await notifyConfigChanged(env, body.tenantId);
        return new Response(JSON.stringify({ status: "ok" }), { headers: jsonHeaders });
      } catch (err: any) {
        console.error("[Worker] Tenant rejection failed:", err);
        return jsonError("Could not reject this request", 400, jsonHeaders);
      }
    }

    // POST /api/super/tenants/custom-domain/approve: Approve or Assign Custom Domain
    if (path === "/api/super/tenants/custom-domain/approve" && method === "POST") {
      const denied = requireSuperAdmin(session, jsonHeaders);
      if (denied) return denied;
      try {
        const body = await request.json<{ tenantId?: string; subdomain?: string; customDomain?: string }>();
        let targetTenant: Tenant | null = null;
        if (body.tenantId) {
          targetTenant = await findTenantById(db, body.tenantId);
        } else if (body.subdomain) {
          targetTenant = await findTenantBySubdomain(db, cleanSubdomain(body.subdomain));
        }
        if (!targetTenant) return jsonError("Organization not found", 404, jsonHeaders);

        const domain = cleanCustomDomain(body.customDomain || targetTenant.requested_custom_domain);
        if (!domain) {
          return jsonError("Valid domain name required (e.g. kiosk.example.com)", 400, jsonHeaders);
        }
        if (isPlatformHostname(env, domain)) {
          return jsonError("Custom domain cannot be a subdomain of the platform domain", 400, jsonHeaders);
        }

        const existing = await findTenantByCustomDomain(db, domain);
        if (existing && existing.id !== targetTenant.id) {
          return jsonError("This domain is already assigned to another organization", 400, jsonHeaders);
        }

        const replaced =
          targetTenant.custom_domain && targetTenant.custom_domain !== domain
            ? { hostname: targetTenant.custom_domain, id: targetTenant.custom_hostname_id }
            : null;
        await approveCustomDomain(db, targetTenant.id, domain);
        await writeAuditLog(db, {
          tenantId: targetTenant.id,
          userId: session!.user_id,
          action: "tenant.approve_custom_domain",
          details: `customDomain=${domain}`
        });
        // Cloudflare for SaaS issues the certificate and routes the domain here.
        if (replaced) {
          await startCustomHostnameJob(env, {
            operation: "delete",
            tenantId: targetTenant.id,
            hostname: replaced.hostname,
            customHostnameId: replaced.id
          });
        }
        await startCustomHostnameJob(env, { operation: "create", tenantId: targetTenant.id, hostname: domain });
        await notifyConfigChanged(env, targetTenant.id);

        return new Response(JSON.stringify({ status: "ok", customDomain: domain }), { headers: jsonHeaders });
      } catch (err: any) {
        console.error("[Worker] Custom domain approval failed:", err);
        return jsonError("Could not approve this custom domain", 400, jsonHeaders);
      }
    }

    // POST /api/super/tenants/custom-domain/reject: Reject Custom Domain Request
    if (path === "/api/super/tenants/custom-domain/reject" && method === "POST") {
      const denied = requireSuperAdmin(session, jsonHeaders);
      if (denied) return denied;
      try {
        const body = await request.json<{ tenantId?: string; subdomain?: string }>();
        let targetTenant: Tenant | null = null;
        if (body.tenantId) {
          targetTenant = await findTenantById(db, body.tenantId);
        } else if (body.subdomain) {
          targetTenant = await findTenantBySubdomain(db, cleanSubdomain(body.subdomain));
        }
        if (!targetTenant) return jsonError("Organization not found", 404, jsonHeaders);

        await rejectCustomDomain(db, targetTenant.id);
        await writeAuditLog(db, {
          tenantId: targetTenant.id,
          userId: session!.user_id,
          action: "tenant.reject_custom_domain"
        });
        return new Response(JSON.stringify({ status: "ok" }), { headers: jsonHeaders });
      } catch (err: any) {
        console.error("[Worker] Custom domain rejection failed:", err);
        return jsonError("Could not reject this request", 400, jsonHeaders);
      }
    }

    // POST /api/super/tenants/custom-domain/remove: Disconnect Custom Domain
    if (path === "/api/super/tenants/custom-domain/remove" && method === "POST") {
      const denied = requireSuperAdmin(session, jsonHeaders);
      if (denied) return denied;
      try {
        const body = await request.json<{ tenantId?: string; subdomain?: string }>();
        let targetTenant: Tenant | null = null;
        if (body.tenantId) {
          targetTenant = await findTenantById(db, body.tenantId);
        } else if (body.subdomain) {
          targetTenant = await findTenantBySubdomain(db, cleanSubdomain(body.subdomain));
        }
        if (!targetTenant) return jsonError("Organization not found", 404, jsonHeaders);

        const previous = { hostname: targetTenant.custom_domain, id: targetTenant.custom_hostname_id };
        await removeCustomDomain(db, targetTenant.id);
        await writeAuditLog(db, {
          tenantId: targetTenant.id,
          userId: session!.user_id,
          action: "tenant.remove_custom_domain"
        });
        if (previous.hostname) {
          await startCustomHostnameJob(env, {
            operation: "delete",
            tenantId: targetTenant.id,
            hostname: previous.hostname,
            customHostnameId: previous.id
          });
        }
        await notifyConfigChanged(env, targetTenant.id);
        return new Response(JSON.stringify({ status: "ok" }), { headers: jsonHeaders });
      } catch (err: any) {
        console.error("[Worker] Custom domain removal failed:", err);
        return jsonError("Could not remove custom domain", 400, jsonHeaders);
      }
    }

    // ==========================================
    // PORTAL APPS & Settings API
    // ==========================================

    // GET /api/portal-sites: public -- user kiosks render this without a session
    if (path === "/api/portal-sites" && method === "GET") {
      if (!currentTenant) {
        return jsonError("Organization not found", 404, jsonHeaders);
      }
      const sites = await listPortalSites(db, currentTenant.id);
      return new Response(JSON.stringify({ sites }), { headers: jsonHeaders });
    }

    // POST /api/portal-sites: Add new app card to user launcher
    if (path === "/api/portal-sites" && method === "POST") {
      const denied = await requireTenantPermission(db, session, currentTenant, "portal", jsonHeaders);
      if (denied) return denied;
      try {
        const body = await request.json<{
          title: string;
          url: string;
          category?: string;
          icon?: string;
          thumbnailUrl?: string;
        }>();

        const title = String(body.title || "").trim().slice(0, 120);
        const targetUrl = safeHttpUrl(body.url);
        if (!title) return jsonError("An application title is required", 400, jsonHeaders);
        if (!targetUrl) return jsonError("Application URL must be a valid http(s) address", 400, jsonHeaders);

        const thumbnailUrl = body.thumbnailUrl ? safeHttpUrl(body.thumbnailUrl) : null;
        if (body.thumbnailUrl && !thumbnailUrl) {
          return jsonError("Thumbnail URL must be a valid http(s) address", 400, jsonHeaders);
        }
        const blocked = (await listLinkBlocklist(db)).map((b) => b.domain);
        const linkProblem = hostedLinkProblem(targetUrl, blocked) ?? (thumbnailUrl ? hostedLinkProblem(thumbnailUrl, blocked) : null);
        if (linkProblem) return jsonError(linkProblem, 400, jsonHeaders);
        if (await findTakenDownPortalSite(db, currentTenant!.id, targetUrl)) {
          return jsonError("Lab Kiosk took a card with this link down. Write to legal@labkiosk.org to contest it.", 403, jsonHeaders);
        }

        const site = await createPortalSite(db, {
          tenantId: currentTenant!.id,
          title,
          url: targetUrl,
          category: String(body.category || "").trim().slice(0, 60) || undefined,
          icon: String(body.icon || "").trim().slice(0, 8) || undefined,
          thumbnailUrl: thumbnailUrl || undefined
        });

        await writeAuditLog(db, {
          tenantId: currentTenant!.id,
          userId: session!.user_id,
          action: "portal.add",
          details: `${title} -> ${targetUrl}`
        });
        await notifyConfigChanged(env, currentTenant!.id);

        return new Response(JSON.stringify({ status: "ok", site }), { headers: jsonHeaders });
      } catch (err: any) {
        console.error("[Worker] Adding portal site failed:", err);
        return jsonError("Could not add this application", 400, jsonHeaders);
      }
    }

    // DELETE /api/portal-sites/:id: Remove an app card
    if (path.startsWith("/api/portal-sites/") && method === "DELETE") {
      const denied = await requireTenantPermission(db, session, currentTenant, "portal", jsonHeaders);
      if (denied) return denied;
      try {
        const id = decodeURIComponent(path.substring("/api/portal-sites/".length));
        await deletePortalSite(db, id, currentTenant!.id);
        await writeAuditLog(db, {
          tenantId: currentTenant!.id,
          userId: session!.user_id,
          action: "portal.remove",
          details: `site=${id}`
        });
        await notifyConfigChanged(env, currentTenant!.id);
        return new Response(JSON.stringify({ status: "ok" }), { headers: jsonHeaders });
      } catch (err: any) {
        console.error("[Worker] Deleting portal site failed:", err);
        return jsonError("Could not remove this application", 400, jsonHeaders);
      }
    }

    // GET /api/broadcast-presets: List tenant's custom broadcast presets
    if (path === "/api/broadcast-presets" && method === "GET") {
      const denied = requireTenantAdmin(session, currentTenant, jsonHeaders);
      if (denied) return denied;
      const presets = await listBroadcastPresets(db, currentTenant!.id);
      return new Response(JSON.stringify({ presets }), { headers: jsonHeaders });
    }

    // POST /api/broadcast-presets: Add a new custom broadcast preset
    if (path === "/api/broadcast-presets" && method === "POST") {
      const denied = await requireTenantPermission(db, session, currentTenant, "broadcast", jsonHeaders);
      if (denied) return denied;
      try {
        const body = await request.json<{ title: string; url: string }>();
        const title = String(body.title || "").trim().slice(0, 80);
        const rawUrl = String(body.url || "").trim();
        if (!title || !rawUrl) {
          return jsonError("Title and URL are required", 400, jsonHeaders);
        }
        const validatedUrl = safeHttpUrl(rawUrl);
        if (!validatedUrl) {
          return jsonError("URL must be a valid http(s) address", 400, jsonHeaders);
        }
        const preset = await createBroadcastPreset(db, {
          tenantId: currentTenant!.id,
          title,
          url: validatedUrl
        });
        await writeAuditLog(db, {
          tenantId: currentTenant!.id,
          userId: session!.user_id,
          action: "broadcast_presets.create",
          details: `title=${title} url=${validatedUrl}`
        });
        await notifyConfigChanged(env, currentTenant!.id);
        return new Response(JSON.stringify({ status: "ok", preset }), { headers: jsonHeaders });
      } catch (err: any) {
        console.error("[Worker] Failed adding broadcast preset:", err);
        return jsonError("Could not add broadcast preset", 400, jsonHeaders);
      }
    }

    // DELETE /api/broadcast-presets/:id: Remove a custom broadcast preset
    if (path.startsWith("/api/broadcast-presets/") && method === "DELETE") {
      const denied = await requireTenantPermission(db, session, currentTenant, "broadcast", jsonHeaders);
      if (denied) return denied;
      try {
        const presetId = decodeURIComponent(path.substring("/api/broadcast-presets/".length));
        if (!presetId) return jsonError("Preset ID required", 400, jsonHeaders);

        await deleteBroadcastPreset(db, presetId, currentTenant!.id);
        await writeAuditLog(db, {
          tenantId: currentTenant!.id,
          userId: session!.user_id,
          action: "broadcast_presets.delete",
          details: `id=${presetId}`
        });
        await notifyConfigChanged(env, currentTenant!.id);
        return new Response(JSON.stringify({ status: "ok" }), { headers: jsonHeaders });
      } catch (err: any) {
        console.error("[Worker] Deleting broadcast preset failed:", err);
        return jsonError("Could not remove this preset", 400, jsonHeaders);
      }
    }

    // POST /api/settings/subdomain: Organization requests new subdomain
    if (path === "/api/settings/subdomain" && method === "POST") {
      const denied = await requireTenantPermission(db, session, currentTenant, "settings", jsonHeaders);
      if (denied) return denied;
      try {
        if (isDemoTenant(currentTenant, session!.user_id)) return jsonError(DEMO_LOCKED_MESSAGE, 400, jsonHeaders);
        const body = await request.json<{ requestedSubdomain: string }>();
        const cleanSub = cleanSubdomain(body.requestedSubdomain);
        if (cleanSub.length < 3 || cleanSub.length > MAX_SUBDOMAIN_LENGTH || isReservedSlug(cleanSub)) {
          return jsonError(`Subdomain must be 3-${MAX_SUBDOMAIN_LENGTH} characters (letters, numbers, hyphens) and not a reserved name`, 400, jsonHeaders);
        }

        const existing = await findTenantBySubdomain(db, cleanSub);
        if (existing && existing.id !== currentTenant!.id) {
          return jsonError("Subdomain already claimed", 400, jsonHeaders);
        }

        await updateTenant(db, currentTenant!.id, { requested_subdomain: cleanSub });
        await writeAuditLog(db, {
          tenantId: currentTenant!.id,
          userId: session!.user_id,
          action: "tenant.request_subdomain",
          details: cleanSub
        });

        return new Response(JSON.stringify({ status: "ok", requestedSubdomain: cleanSub }), {
          headers: jsonHeaders
        });
      } catch (err: any) {
        console.error("[Worker] Subdomain request failed:", err);
        return jsonError("Could not submit this request", 400, jsonHeaders);
      }
    }

    // POST /api/settings/mode: Switch between 'portal' launcher and 'single_url'
    if (path === "/api/settings/mode" && method === "POST") {
      const denied = await requireTenantPermission(db, session, currentTenant, "settings", jsonHeaders);
      if (denied) return denied;
      try {
        const body = await request.json<{ mode: "portal" | "single_url"; defaultUrl?: string; default_url?: string }>();
        if (body.mode !== "portal" && body.mode !== "single_url") {
          return jsonError("Mode must be either 'portal' or 'single_url'", 400, jsonHeaders);
        }

        const updates: { mode: "portal" | "single_url"; default_url?: string } = { mode: body.mode };
        const rawDefaultUrl = body.defaultUrl || body.default_url;
        if (rawDefaultUrl) {
          const validated = safeHttpUrl(rawDefaultUrl);
          if (!validated) return jsonError("Default URL must be a valid http(s) address", 400, jsonHeaders);
          updates.default_url = validated;
        }

        await updateTenant(db, currentTenant!.id, updates);
        await writeAuditLog(db, {
          tenantId: currentTenant!.id,
          userId: session!.user_id,
          action: "settings.mode",
          details: `${body.mode}${updates.default_url ? ` url=${updates.default_url}` : ""}`
        });
        await notifyConfigChanged(env, currentTenant!.id);
        return new Response(
          JSON.stringify({
            status: "ok",
            mode: body.mode,
            defaultUrl: updates.default_url || currentTenant!.default_url
          }),
          { headers: jsonHeaders }
        );
      } catch (err: any) {
        console.error("[Worker] Mode change failed:", err);
        return jsonError("Could not change the homepage mode", 400, jsonHeaders);
      }
    }

    // GET /api/settings/customization: Read tenant branding and customization settings
    if (path === "/api/settings/customization" && method === "GET") {
      const denied = await requireTenantPermission(db, session, currentTenant, "settings", jsonHeaders);
      if (denied) return denied;
      return new Response(
        JSON.stringify({
          status: "ok",
          name: currentTenant!.name,
          mode: currentTenant!.mode,
          defaultUrl: currentTenant!.default_url,
          defaultLockMessage:
            currentTenant!.default_lock_message ||
            "This screen has been locked by an administrator. Please wait.",
          portalTitle: currentTenant!.portal_title || "",
          portalSubtitle: currentTenant!.portal_subtitle || "",
          portalDescription: currentTenant!.portal_description || "",
          portalFooter: currentTenant!.portal_footer || ""
        }),
        { headers: jsonHeaders }
      );
    }

    // POST /api/settings/customization: Update tenant branding and customization settings
    if (path === "/api/settings/customization" && method === "POST") {
      const denied = await requireTenantPermission(db, session, currentTenant, "settings", jsonHeaders);
      if (denied) return denied;
      try {
        const body = await request.json<{
          name?: string;
          mode?: "portal" | "single_url";
          defaultUrl?: string;
          default_url?: string;
          defaultLockMessage?: string;
          default_lock_message?: string;
          portalTitle?: string;
          portal_title?: string;
          portalSubtitle?: string;
          portal_subtitle?: string;
          portalDescription?: string;
          portal_description?: string;
          portalFooter?: string;
          portal_footer?: string;
        }>();

        const updates: Record<string, any> = {};

        if (body.name !== undefined) {
          const trimmedName = String(body.name).trim().slice(0, MAX_PERSON_NAME_LENGTH);
          if (!trimmedName) return jsonError("Name cannot be empty", 400, jsonHeaders);
          updates.name = trimmedName;
        }

        if (body.mode !== undefined) {
          if (body.mode === "portal" || body.mode === "single_url") {
            updates.mode = body.mode;
          } else {
            return jsonError("Mode must be either 'portal' or 'single_url'", 400, jsonHeaders);
          }
        }

        const rawDefaultUrl = body.defaultUrl !== undefined ? body.defaultUrl : body.default_url;
        if (rawDefaultUrl !== undefined) {
          const trimmedUrl = String(rawDefaultUrl).trim();
          if (trimmedUrl) {
            const validated = safeHttpUrl(trimmedUrl);
            if (!validated) return jsonError("Default URL must be a valid http(s) address", 400, jsonHeaders);
            updates.default_url = validated;
          }
        }

        const rawLockMsg = body.defaultLockMessage !== undefined ? body.defaultLockMessage : body.default_lock_message;
        if (rawLockMsg !== undefined) {
          const trimmedMsg = String(rawLockMsg).trim().slice(0, 280);
          updates.default_lock_message = trimmedMsg || "This screen has been locked by an administrator. Please wait.";
        }

        const rawTitle = body.portalTitle !== undefined ? body.portalTitle : body.portal_title;
        if (rawTitle !== undefined) {
          updates.portal_title = String(rawTitle).trim().slice(0, 100) || null;
        }

        const rawSub = body.portalSubtitle !== undefined ? body.portalSubtitle : body.portal_subtitle;
        if (rawSub !== undefined) {
          updates.portal_subtitle = String(rawSub).trim().slice(0, 150) || null;
        }

        const rawDesc = body.portalDescription !== undefined ? body.portalDescription : body.portal_description;
        if (rawDesc !== undefined) {
          updates.portal_description = String(rawDesc).trim().slice(0, 300) || null;
        }

        const rawFooter = body.portalFooter !== undefined ? body.portalFooter : body.portal_footer;
        if (rawFooter !== undefined) {
          updates.portal_footer = String(rawFooter).trim().slice(0, 200) || null;
        }

        if (Object.keys(updates).length > 0) {
          await updateTenant(db, currentTenant!.id, updates);
          Object.assign(currentTenant!, updates);
          await writeAuditLog(db, {
            tenantId: currentTenant!.id,
            userId: session!.user_id,
            action: "settings.customization",
            details: JSON.stringify(updates)
          });
          await notifyConfigChanged(env, currentTenant!.id);
        }

        return new Response(
          JSON.stringify({
            status: "ok",
            name: currentTenant!.name,
            mode: currentTenant!.mode,
            defaultUrl: currentTenant!.default_url,
            defaultLockMessage: currentTenant!.default_lock_message,
            portalTitle: currentTenant!.portal_title || "",
            portalSubtitle: currentTenant!.portal_subtitle || "",
            portalDescription: currentTenant!.portal_description || "",
            portalFooter: currentTenant!.portal_footer || "",
            updates
          }),
          { headers: jsonHeaders }
        );
      } catch (err: any) {
        console.error("[Worker] Customization update failed:", err);
        return jsonError("Could not update customization settings", 400, jsonHeaders);
      }
    }

    // GET /api/settings/enrollment-key: reveal the key used to enrol workstations
    if (path === "/api/settings/enrollment-key" && method === "GET") {
      const denied = await requireTenantPermission(db, session, currentTenant, "settings", jsonHeaders);
      if (denied) return denied;
      // A key from before the check character cannot be typed into a workstation
      // any more: hand out a new one rather than one the wizard would refuse.
      let enrollmentKey = currentTenant!.enrollment_key;
      if (enrollmentKey && !isEnrollmentKey(enrollmentKey)) {
        enrollmentKey = await regenerateEnrollmentKey(db, currentTenant!.id);
        await writeAuditLog(db, {
          tenantId: currentTenant!.id,
          userId: null,
          action: "settings.rotate_enrollment_key",
          details: "reason=check_character"
        });
      }
      return new Response(JSON.stringify({ enrollmentKey, subdomain: currentTenant!.subdomain }), { headers: jsonHeaders });
    }

    // POST /api/settings/enrollment-key: rotate it (previously enrolled devices keep working)
    if (path === "/api/settings/enrollment-key" && method === "POST") {
      const denied = await requireTenantPermission(db, session, currentTenant, "settings", jsonHeaders);
      if (denied) return denied;
      const enrollmentKey = await regenerateEnrollmentKey(db, currentTenant!.id);
      await writeAuditLog(db, {
        tenantId: currentTenant!.id,
        userId: session!.user_id,
        action: "settings.rotate_enrollment_key"
      });
      return new Response(JSON.stringify({ status: "ok", enrollmentKey }), { headers: jsonHeaders });
    }

    // POST /api/settings/custom-domain: Request or register a custom domain
    if (path === "/api/settings/custom-domain" && method === "POST") {
      const denied = await requireTenantPermission(db, session, currentTenant, "settings", jsonHeaders);
      if (denied) return denied;
      try {
        const body = await request.json<{ domain: string }>();
        const domain = cleanCustomDomain(body.domain);
        if (!domain) {
          return jsonError("Please enter a valid domain name (e.g. kiosk.example.com)", 400, jsonHeaders);
        }

        if (isPlatformHostname(env, domain)) {
          return jsonError("Custom domain cannot be a subdomain of the platform domain", 400, jsonHeaders);
        }

        // Check collisions
        const existing = await findTenantByCustomDomain(db, domain);
        if (existing && existing.id !== currentTenant!.id) {
          return jsonError("This domain is already assigned to another organization", 400, jsonHeaders);
        }

        await requestCustomDomain(db, currentTenant!.id, domain);
        await writeAuditLog(db, {
          tenantId: currentTenant!.id,
          userId: session!.user_id,
          action: "settings.request_custom_domain",
          details: `domain=${domain}`
        });

        return new Response(
          JSON.stringify({
            status: "ok",
            requestedCustomDomain: domain,
            customDomainStatus: "pending"
          }),
          { headers: jsonHeaders }
        );
      } catch (err: any) {
        console.error("[Worker] Custom domain request failed:", err);
        return jsonError("Could not submit custom domain request", 400, jsonHeaders);
      }
    }

    // DELETE /api/settings/custom-domain: Cancel request or disconnect custom domain
    if (path === "/api/settings/custom-domain" && method === "DELETE") {
      const denied = await requireTenantPermission(db, session, currentTenant, "settings", jsonHeaders);
      if (denied) return denied;
      try {
        const previous = { hostname: currentTenant!.custom_domain, id: currentTenant!.custom_hostname_id };
        await removeCustomDomain(db, currentTenant!.id);
        await writeAuditLog(db, {
          tenantId: currentTenant!.id,
          userId: session!.user_id,
          action: "settings.remove_custom_domain"
        });
        if (previous.hostname) {
          await startCustomHostnameJob(env, {
            operation: "delete",
            tenantId: currentTenant!.id,
            hostname: previous.hostname,
            customHostnameId: previous.id
          });
        }
        await notifyConfigChanged(env, currentTenant!.id);
        return new Response(JSON.stringify({ status: "ok" }), { headers: jsonHeaders });
      } catch (err: any) {
        console.error("[Worker] Remove custom domain failed:", err);
        return jsonError("Could not remove custom domain", 400, jsonHeaders);
      }
    }

    // GET /api/workstation-issues: errors and warnings workstations reported
    // (Settings -> Errors & Warnings), and whether they become bug reports.
    // Settings permission, like the audit log.
    if (path === "/api/workstation-issues" && method === "GET") {
      const denied = await requireTenantPermission(db, session, currentTenant, "settings", jsonHeaders);
      if (denied) return denied;
      const limit = Number(url.searchParams.get("limit") || 100);
      const issues = await listWorkstationIssues(db, currentTenant!.id, Number.isFinite(limit) ? limit : 100);
      const repository = bugReportRepository(env);
      return new Response(
        JSON.stringify({
          issues,
          bugReports: {
            enabled: currentTenant!.bug_reports_enabled === 1,
            available: repository !== null,
            repository,
            termsVersion: BUG_REPORT_TERMS_VERSION,
            acceptedTermsVersion: currentTenant!.bug_reports_terms_version ?? null,
            termsAcceptedAt: currentTenant!.bug_reports_terms_accepted_at ?? null
          }
        }),
        { headers: jsonHeaders }
      );
    }

    // GET /api/workstation-issues/log?id=<issue>: the journal a workstation sent
    // with a restart it did not shut down for. Settings permission, like the list.
    if (path === "/api/workstation-issues/log" && method === "GET") {
      const denied = await requireTenantPermission(db, session, currentTenant, "settings", jsonHeaders);
      if (denied) return denied;
      const issueId = url.searchParams.get("id") || "";
      if (!/^[0-9A-Za-z-]{1,64}$/.test(issueId)) {
        return jsonError("id is not an issue id", 400, jsonHeaders);
      }
      const log = await getWorkstationIssueLog(db, currentTenant!.id, issueId);
      if (log === undefined) return jsonError("No such issue", 404, jsonHeaders);
      return new Response(JSON.stringify({ id: issueId, log }), { headers: jsonHeaders });
    }

    // POST /api/settings/bug-reports: opt this organization in to (or out of)
    // automatic, redacted GitHub bug reports for its workstations' problems.
    // Turning it on accepts the current Automatic Bug Report Terms, by version.
    if (path === "/api/settings/bug-reports" && method === "POST") {
      const denied = await requireTenantPermission(db, session, currentTenant, "settings", jsonHeaders);
      if (denied) return denied;
      let body: { enabled?: unknown; acceptTerms?: unknown };
      try {
        body = await request.json<{ enabled?: unknown; acceptTerms?: unknown }>();
      } catch {
        return jsonError("The request body must be JSON", 400, jsonHeaders);
      }
      if (typeof body?.enabled !== "boolean") {
        return jsonError("enabled must be true or false", 400, jsonHeaders);
      }
      if (body.enabled && !bugReportRepository(env)) {
        return jsonError("Automatic bug reports are not set up on this platform", 409, jsonHeaders);
      }
      if (body.enabled && body.acceptTerms !== BUG_REPORT_TERMS_VERSION) {
        return jsonError(
          `Accept the Automatic Bug Report Terms (version ${BUG_REPORT_TERMS_VERSION}) to turn this on`,
          400,
          jsonHeaders
        );
      }
      await setBugReportsEnabled(db, currentTenant!.id, body.enabled, Math.floor(Date.now() / 1000));
      await writeAuditLog(db, {
        tenantId: currentTenant!.id,
        userId: session!.user_id,
        action: "settings.bug_reports",
        details: body.enabled ? `on, terms ${BUG_REPORT_TERMS_VERSION} accepted` : "off"
      });
      return new Response(JSON.stringify({ status: "ok", enabled: body.enabled }), { headers: jsonHeaders });
    }

    // GET /api/audit-logs: recent activity for this organization
    if (path === "/api/audit-logs" && method === "GET") {
      const denied = await requireTenantPermission(db, session, currentTenant, "settings", jsonHeaders);
      if (denied) return denied;
      const limit = Number(url.searchParams.get("limit") || 100);
      const logs = await listAuditLogs(db, currentTenant!.id, Number.isFinite(limit) ? limit : 100);
      return new Response(JSON.stringify({ logs }), { headers: jsonHeaders });
    }

    // ==========================================
    // TENANT STAFF / OPERATOR DELEGATION API
    // ==========================================

    // GET /api/tenant/staff: list staff accounts
    if (path === "/api/tenant/staff" && method === "GET") {
      // The staff list carries every colleague's email address; it belongs to
      // the people who manage staff, not to everyone who can sign in.
      const denied = await requireTenantPermission(db, session, currentTenant, "staff", jsonHeaders);
      if (denied) return denied;
      const staff = await listTenantUsers(db, currentTenant!.id);
      return new Response(JSON.stringify({ status: "ok", staff }), { headers: jsonHeaders });
    }

    // POST /api/tenant/staff: create staff account
    if (path === "/api/tenant/staff" && method === "POST") {
      const denied = await requireTenantPermission(db, session, currentTenant, "staff", jsonHeaders);
      if (denied) return denied;
      try {
        const body = await request.json<{
          name: string;
          email: string;
          password?: string;
          role?: TenantUserRole;
          permissions?: string[];
        }>();

        // Strings only, trimmed and capped as a registration's name is: a number
        // used to reach .trim() in createTenantUser and fail as a vague 400, and
        // a name of spaces was stored empty.
        const name = typeof body.name === "string" ? body.name.trim().slice(0, MAX_PERSON_NAME_LENGTH) : "";
        const email = typeof body.email === "string" ? body.email.trim() : "";
        if (!name || !email) {
          return jsonError("Name and email are required", 400, jsonHeaders);
        }
        if (!isPlausibleEmail(email)) {
          return jsonError("Please enter a valid email address", 400, jsonHeaders);
        }

        if (body.role !== undefined && !STAFF_ROLES.has(body.role)) {
          return jsonError("Unknown staff role", 400, jsonHeaders);
        }
        const role: TenantUserRole = body.role || "operator";
        const permissions = body.permissions === undefined ? [] : parseStaffPermissions(body.permissions);
        if (!permissions) return jsonError("Unknown permission requested", 400, jsonHeaders);

        const refused = await staffDelegationProblem(db, session!, currentTenant!, { role, permissions });
        if (refused) return jsonError(refused, 403, jsonHeaders);

        if (body.password !== undefined && body.password !== "") {
          const passwordProblem =
            validatePasswordStrength(String(body.password)) || (await breachedPasswordProblem(String(body.password), env));
          if (passwordProblem) return jsonError(passwordProblem, 400, jsonHeaders);
        }

        // An address that already has an account is refused rather than linked:
        // linking would let any organization pull another organization's administrator (or
        // the platform's) into its own staff list and read back their name.
        if (await findUserByEmail(db, email.toLowerCase())) {
          return jsonError("An account with this email address already exists", 409, jsonHeaders);
        }

        const operator = await createTenantUser(db, {
          tenantId: currentTenant!.id,
          email,
          name,
          password: body.password,
          role,
          permissions
        }, passwordPepper(env));

        await writeAuditLog(db, {
          tenantId: currentTenant!.id,
          userId: session!.user_id,
          action: "staff.create",
          details: `email=${operator.email} role=${role}`
        });

        return new Response(JSON.stringify({ status: "ok", operator }), { headers: jsonHeaders });
      } catch (err: any) {
        console.error("[Worker] Create operator failed:", err);
        return jsonError("Could not create operator account", 400, jsonHeaders);
      }
    }

    // POST /api/tenant/staff/update: update role or permissions
    if (path === "/api/tenant/staff/update" && method === "POST") {
      const denied = await requireTenantPermission(db, session, currentTenant, "staff", jsonHeaders);
      if (denied) return denied;
      try {
        const body = await request.json<{ id: string; role?: TenantUserRole; permissions?: string[] }>();
        if (!body.id) return jsonError("Staff ID is required", 400, jsonHeaders);
        if (body.role !== undefined && !STAFF_ROLES.has(body.role)) {
          return jsonError("Unknown staff role", 400, jsonHeaders);
        }
        const permissions = body.permissions === undefined ? undefined : parseStaffPermissions(body.permissions);
        if (permissions === null) return jsonError("Unknown permission requested", 400, jsonHeaders);

        const target = await findTenantUserById(db, currentTenant!.id, String(body.id));
        if (!target) return jsonError("Staff account not found", 404, jsonHeaders);

        const refused = await staffDelegationProblem(db, session!, currentTenant!, { role: body.role, permissions, target });
        if (refused) return jsonError(refused, 403, jsonHeaders);

        await updateTenantUser(db, currentTenant!.id, target.id, {
          role: body.role,
          permissions
        });

        await writeAuditLog(db, {
          tenantId: currentTenant!.id,
          userId: session!.user_id,
          action: "staff.update",
          details: `id=${body.id}`
        });

        return new Response(JSON.stringify({ status: "ok" }), { headers: jsonHeaders });
      } catch (err: any) {
        console.error("[Worker] Update operator failed:", err);
        return jsonError("Could not update staff account", 400, jsonHeaders);
      }
    }

    // DELETE /api/tenant/staff/:id: remove staff account
    if (path.startsWith("/api/tenant/staff/") && method === "DELETE") {
      const denied = await requireTenantPermission(db, session, currentTenant, "staff", jsonHeaders);
      if (denied) return denied;
      try {
        const operatorId = path.slice("/api/tenant/staff/".length);
        if (!operatorId) return jsonError("Staff ID is required", 400, jsonHeaders);

        const target = await findTenantUserById(db, currentTenant!.id, operatorId);
        if (!target) return jsonError("Staff account not found", 404, jsonHeaders);
        const refused = await staffDelegationProblem(db, session!, currentTenant!, { target });
        if (refused) return jsonError(refused, 403, jsonHeaders);

        await deleteTenantUser(db, currentTenant!.id, operatorId);
        // The console promises the removed account is signed out at once; a
        // session left open would still pass every membership-only guard.
        await deleteSessionsForUser(db, target.user_id);
        await writeAuditLog(db, {
          tenantId: currentTenant!.id,
          userId: session!.user_id,
          action: "staff.delete",
          details: `id=${operatorId}`
        });

        return new Response(JSON.stringify({ status: "ok" }), { headers: jsonHeaders });
      } catch (err: any) {
        console.error("[Worker] Delete operator failed:", err);
        return jsonError("Could not remove staff account", 400, jsonHeaders);
      }
    }

    // POST /api/tenant/subdomain: update organization subdomain
    if (path === "/api/tenant/subdomain" && method === "POST") {
      const denied = await requireTenantPermission(db, session, currentTenant, "settings", jsonHeaders);
      if (denied) return denied;
      try {
        if (isDemoTenant(currentTenant, session!.user_id)) return jsonError(DEMO_LOCKED_MESSAGE, 400, jsonHeaders);
        const body = await request.json<{ subdomain: string }>();
        const cleanSub = cleanSubdomain(body.subdomain);
        if (cleanSub.length < 3 || cleanSub.length > MAX_SUBDOMAIN_LENGTH) {
          return jsonError(`Subdomain must be 3-${MAX_SUBDOMAIN_LENGTH} characters`, 400, jsonHeaders);
        }
        if (isReservedSlug(cleanSub)) {
          return jsonError("That subdomain is reserved by the platform", 400, jsonHeaders);
        }

        const existing = await findTenantBySubdomain(db, cleanSub);
        if (existing && existing.id !== currentTenant!.id) {
          return jsonError("That subdomain is already claimed by another organization", 400, jsonHeaders);
        }

        await updateTenant(db, currentTenant!.id, { subdomain: cleanSub });
        currentTenant!.subdomain = cleanSub;

        await writeAuditLog(db, {
          tenantId: currentTenant!.id,
          userId: session!.user_id,
          action: "tenant.update_subdomain",
          details: `subdomain=${cleanSub}`
        });
        await notifyConfigChanged(env, currentTenant!.id);

        const redirectUrl = isDev
          ? `/admin?tenant=${encodeURIComponent(cleanSub)}`
          : `https://${cleanSub}.${baseDomain}/admin`;

        return new Response(JSON.stringify({ status: "ok", subdomain: cleanSub, redirectUrl }), { headers: jsonHeaders });
      } catch (err: any) {
        console.error("[Worker] Subdomain update failed:", err);
        return jsonError("Could not update subdomain", 400, jsonHeaders);
      }
    }

    // POST /api/tenant/settings: update Settings (mode, home_route, profile)
    // POST /api/tenant/homepage: the organization homepage served at the subdomain
    // root. Guarded by the same `settings` permission as the rest of the lab
    // configuration, and every field is normalised here rather than trusted:
    // this text is rendered on the page users land on.
    if (path === "/api/tenant/homepage" && method === "POST") {
      const denied = await requireTenantPermission(db, session, currentTenant, "settings", jsonHeaders);
      if (denied) return denied;
      try {
        const body = await request.json<{
          headline?: unknown;
          intro?: unknown;
          blocks?: unknown;
        }>();

        const headline = String(body.headline ?? "").trim().slice(0, HOMEPAGE_LIMITS.headline);
        const intro = String(body.intro ?? "").trim().slice(0, HOMEPAGE_LIMITS.intro);
        const blocks = sanitizeHomepageBlocks(body.blocks);
        const blocked = (await listLinkBlocklist(db)).map((b) => b.domain);
        for (const [index, block] of blocks.entries()) {
          const problem = block.url ? hostedLinkProblem(block.url, blocked) : null;
          if (problem) return jsonError(`Block ${index + 1} (${block.title || "untitled"}): ${problem}`, 400, jsonHeaders);
        }

        await updateTenant(db, currentTenant!.id, {
          // Empty means "use the default", which is the organization name and the
          // standard welcome line, so store null rather than an empty string.
          homepage_headline: headline || null,
          homepage_intro: intro || null,
          homepage_blocks: blocks.length ? JSON.stringify(blocks) : null
        });

        await writeAuditLog(db, {
          tenantId: currentTenant!.id,
          userId: session!.user_id,
          action: "homepage.update",
          details: `${blocks.length} block(s)${blocks.some((b) => b.url) ? `; links: ${blocks.flatMap((b) => (b.url ? [b.url] : [])).join(" ")}`.slice(0, 1500) : ""}`
        });

        return new Response(JSON.stringify({ status: "ok", blocks }), { headers: jsonHeaders });
      } catch (err: any) {
        console.error("[Worker] Homepage update failed:", err);
        return jsonError("Could not save the homepage", 400, jsonHeaders);
      }
    }

    if (path === "/api/tenant/settings" && method === "POST") {
      const denied = await requireTenantPermission(db, session, currentTenant, "settings", jsonHeaders);
      if (denied) return denied;
      try {
        const body = await request.json<{
          name?: string;
          mode?: "portal" | "single_url";
          defaultUrl?: string;
          defaultLockMessage?: string;
          homeRoute?: string;
          portalTitle?: string;
          portalSubtitle?: string;
          portalDescription?: string;
          portalFooter?: string;
        }>();

        const updates: Partial<Tenant> = {};
        if (body.name !== undefined) {
          const trimmed = String(body.name).trim().slice(0, MAX_PERSON_NAME_LENGTH);
          if (trimmed) updates.name = trimmed;
        }
        if (body.mode === "portal" || body.mode === "single_url") {
          updates.mode = body.mode;
        }
        if (body.defaultUrl !== undefined) {
          const validated = safeHttpUrl(body.defaultUrl);
          if (validated) updates.default_url = validated;
        }
        if (body.defaultLockMessage !== undefined) {
          updates.default_lock_message = String(body.defaultLockMessage).trim().slice(0, 280);
        }
        if (body.homeRoute !== undefined) {
          const cleanRoute = String(body.homeRoute).trim().startsWith("/")
            ? String(body.homeRoute).trim()
            : "/" + String(body.homeRoute).trim();
          updates.home_route = cleanRoute;
        }
        if (body.portalTitle !== undefined) {
          updates.portal_title = String(body.portalTitle).trim().slice(0, 100) || null;
        }
        if (body.portalSubtitle !== undefined) {
          updates.portal_subtitle = String(body.portalSubtitle).trim().slice(0, 150) || null;
        }
        if (body.portalDescription !== undefined) {
          updates.portal_description = String(body.portalDescription).trim().slice(0, 300) || null;
        }
        if (body.portalFooter !== undefined) {
          updates.portal_footer = String(body.portalFooter).trim().slice(0, 200) || null;
        }

        if (Object.keys(updates).length > 0) {
          await updateTenant(db, currentTenant!.id, updates);
          Object.assign(currentTenant!, updates);
          await writeAuditLog(db, {
            tenantId: currentTenant!.id,
            userId: session!.user_id,
            action: "settings.update",
            details: JSON.stringify(updates)
          });
          await notifyConfigChanged(env, currentTenant!.id);
        }

        return new Response(JSON.stringify({ status: "ok", updates }), { headers: jsonHeaders });
      } catch (err: any) {
        console.error("[Worker] Settings update failed:", err);
        return jsonError("Could not update Settings", 400, jsonHeaders);
      }
    }

    // ==========================================
    // DEVICE ENROLMENT
    // ==========================================

    // POST /api/devices/enroll: exchange the organization enrollment key for a device token
    if (path === "/api/devices/enroll" && method === "POST") {
      try {
        const body = await request.json<{
          subdomain?: string;
          customDomain?: string;
          enrollmentKey: string;
          clientId: string;
        }>();
        const slug = cleanSubdomain(body.subdomain ?? "");
        const customDomain = cleanCustomDomain(body.customDomain ?? "");
        let tenant: Tenant | null = null;
        if (customDomain) {
          tenant = await findTenantByCustomDomain(db, customDomain);
        }
        if (!tenant && slug) {
          tenant = await findTenantBySubdomain(db, slug);
        }
        if (!tenant) {
          tenant = currentTenant;
        }

        const suppliedKey = String(body.enrollmentKey || "").trim().toUpperCase();
        const enrollKey = `enroll:${clientIp}`;
        const enrollWait = await rateLimitWait(db, enrollKey, ENROLL_FAILURE_RATE_LIMIT.limit, ENROLL_FAILURE_RATE_LIMIT.windowSeconds);
        if (enrollWait > 0) {
          return jsonError(`Too many failed enrolment attempts. Try again in ${Math.ceil(enrollWait / 60)} minute(s).`, 429, jsonHeaders);
        }
        if (!tenant && suppliedKey) {
          tenant = await findTenantByEnrollmentKey(db, suppliedKey);
        }

        const clientId = String(body.clientId || "").trim().toUpperCase().slice(0, 64);
        if (!/^[A-Z0-9][A-Z0-9_-]{0,63}$/.test(clientId)) {
          return jsonError(
            "Workstation name may contain only letters, numbers, hyphens and underscores",
            400,
            jsonHeaders
          );
        }

        // A wrong organization and a wrong key are reported identically so the endpoint
        // cannot be used to enumerate which subdomains exist.
        const keyMatches =
          !!tenant && tenant.enrollment_key.length > 0 && timingSafeEqual(suppliedKey, tenant.enrollment_key);

        if (!tenant || !keyMatches) {
          await recordRateLimitHit(db, enrollKey, ENROLL_FAILURE_RATE_LIMIT.windowSeconds);
          await writeAuditLog(db, {
            tenantId: tenant?.id || null,
            action: "device.enroll_denied",
            details: `client=${clientId} subdomain=${slug}`
          });
          return jsonError("Organization subdomain or enrollment key is not correct", 401, jsonHeaders);
        }

        if (tenant.status !== "active") {
          return jsonError("This organization is not active yet. Ask your administrator to approve it.", 403, jsonHeaders);
        }

        const licenseEnded = licenseExpiredMessage(tenant);
        const issued = await createDeviceToken(db, { tenantId: tenant.id, clientId, existingOnly: licenseEnded !== null });
        if (!issued && licenseEnded) {
          await writeAuditLog(db, {
            tenantId: tenant.id,
            action: "device.enroll_license",
            details: `client=${clientId}`
          });
          return jsonError(licenseEnded, 403, jsonHeaders);
        }
        if (!issued) {
          const limit = Number(tenant.workstation_limit) || DEFAULT_WORKSTATION_LIMIT;
          await writeAuditLog(db, {
            tenantId: tenant.id,
            action: "device.enroll_limit",
            details: `client=${clientId} limit=${limit}`
          });
          return jsonError(
            `${tenant.name} has enrolled all ${limit} workstations its plan allows. ` +
              "Remove a workstation in the console, or ask Lab Kiosk to raise the limit.",
            403,
            jsonHeaders
          );
        }
        const { token } = issued;
        // A workstation removed earlier and enrolled again is welcome again.
        forgetDeviceToken(tenant.id, clientId);
        await hubJson(env, tenant.id, "/device-enrolled", { clientId });
        await writeAuditLog(db, {
          tenantId: tenant.id,
          action: "device.enroll",
          details: `client=${clientId}`
        });

        return new Response(
          JSON.stringify({
            status: "ok",
            deviceToken: token,
            clientId,
            subdomain: tenant.subdomain,
            organizationName: tenant.name,
            // Deprecated alias for workstations installed from an ISO older than
            // the organization vocabulary; remove once every agent reads
            // organizationName.
            schoolName: tenant.name,
            mode: tenant.mode,
            targetUrl: portalUrlFor(tenant, request, url, env)
          }),
          { headers: jsonHeaders }
        );
      } catch (err: any) {
        console.error("[Worker] Device enrolment failed:", err);
        return jsonError("Enrolment failed. Please try again.", 400, jsonHeaders);
      }
    }

    // ==========================================
    // CLIENT TELEMETRY & COMMAND EXECUTION API
    // ==========================================

    // GET /api/clients: every workstation of this organization, with live status.
    // POST /api/clients: the same, from a console without its live channel, naming
    // the screens it shows so their frames keep coming.
    if (path === "/api/clients" && (method === "GET" || method === "POST")) {
      const denied = await requireTenantPermission(db, session, currentTenant, "workstations", jsonHeaders);
      if (denied) return denied;
      let watch: string[] = [];
      if (method === "POST") {
        try {
          const body = await request.json<{ watch?: unknown }>();
          watch = Array.isArray(body.watch) ? body.watch.map((id) => String(id)).slice(0, MAX_BATCH_TARGETS) : [];
        } catch (err) {
          console.warn("[Worker] Unreadable workstation list request:", err);
          return jsonError("The request body is not valid JSON", 400, jsonHeaders);
        }
      }

      const tenant = currentTenant!;
      // D1 is the registry (groups, offline machines, last known state); OrgHub
      // is who is connected right now and what each one shows.
      const [rows, live] = await Promise.all([
        listClientDevices(db, tenant.id),
        hubJson<{ clients: Record<string, LiveStatus> }>(env, tenant.id, "/live", { watch })
      ]);
      const fallbackUrl = tenant.default_url || DEFAULT_CONFIG.defaultHomepage;
      const clients: Record<string, ClientTelemetry> = {};
      const toTelemetry = (status: LiveStatus | undefined, row?: (typeof rows)[number]): ClientTelemetry => {
        const lastSeenMs = status ? status.lastSeen : (row?.last_seen ?? 0) * 1000;
        return {
          clientId: status?.clientId ?? row!.client_id,
          clientNum: status?.clientNum ?? row?.client_num ?? 1,
          activeUrl: status?.activeUrl || row?.active_url || fallbackUrl,
          isLocked: status ? status.isLocked : row?.is_locked === 1,
          thumbnail: status?.thumbnail,
          timestamp: Math.floor(lastSeenMs / 1000),
          ip: status?.ip || row?.ip || undefined,
          lastSeen: new Date(lastSeenMs).toISOString(),
          online: Boolean(status?.online),
          // Of no use without Remote Control, which the platform approves per organization.
          vncPassword:
            tenant.remote_control_status === "approved" ? status?.vncPassword || row?.vnc_password || undefined : undefined,
          groupName: row?.group_name || undefined,
          imageVersion: status?.imageVersion || row?.image_version || undefined,
          agentVersion: status?.agentVersion || row?.agent_version || undefined,
          update: status?.update ?? registryUpdate(row),
          updateWaitingSince: status?.online ? status.updateWaitingSince : undefined,
          videoDecoding: storedVideoDecoding(row?.video_decoding, row?.video_decoding_at),
          hardware: storedHardware(row?.hardware, row?.hardware_at)
        };
      };
      for (const row of rows) clients[row.client_id] = toTelemetry(live.clients[row.client_id], row);
      // Connected a moment ago, before its registry row could be listed.
      for (const [id, status] of Object.entries(live.clients)) {
        if (!clients[id]) clients[id] = toTelemetry(status);
      }
      return new Response(JSON.stringify({ clients }), { headers: jsonHeaders });
    }

    // GET /api/console/ws: the console's live channel to this organization's
    // OrgHub -- status changes and the frames of the screens it is showing.
    if (path === "/api/console/ws" && method === "GET") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return jsonError("Expected a WebSocket upgrade", 426, jsonHeaders);
      }
      const denied = await requireTenantPermission(db, session, currentTenant, "workstations", jsonHeaders);
      if (denied) return denied;
      const crossSite = rejectCrossSiteSocket(request, { baseDomain: env.DEFAULT_DOMAIN }, jsonHeaders);
      if (crossSite) return crossSite;
      return hubUpgrade(env, currentTenant!.id, "console", { userId: session!.user_id });
    }

    // GET /console/remote?clientId=...: the Remote Control viewer the
    // Workstations page frames (src/ui_remote_viewer.ts).
    if (path === "/console/remote" && method === "GET") {
      // Opened signed out in a browser tab: the sign-in page, not a line of JSON.
      if (!session && (request.headers.get("Accept") || "").includes("text/html")) {
        return Response.redirect(`${url.origin}/?login=1`, 302);
      }
      const denied = await requireTenantPermission(db, session, currentTenant, "workstations", jsonHeaders);
      if (denied) return denied;
      const notEnabled = await remoteControlRefusal(db, session!, currentTenant!, jsonHeaders);
      if (notEnabled) return notEnabled;
      const clientId = url.searchParams.get("clientId") || "";
      if (!REMOTE_CLIENT_ID.test(clientId)) return jsonError("A workstation id is required", 400, jsonHeaders);
      return new Response(renderRemoteViewerHtml({ clientId, nonce }), {
        headers: buildHtmlHeaders(nonce, { hsts: isHttps && !isDev, indexable: false, analyticsOrigin: null, remoteViewer: true })
      });
    }

    // POST /api/tenant/remote-control/request: ask the platform to turn Remote Control on.
    if (path === "/api/tenant/remote-control/request" && method === "POST") {
      const denied = await requireTenantPermission(db, session, currentTenant, "settings", jsonHeaders);
      if (denied) return denied;
      if (session!.role === "super_admin") {
        return jsonError("The demo organizations already have Remote Control", 400, jsonHeaders);
      }
      return handleRemoteControlRequest(routeContext, currentTenant!);
    }

    // POST /api/tenant/remote-control/disable: the organization turns Remote Control
    // off for itself. Open sessions end at once; turning it on again is a new request.
    if (path === "/api/tenant/remote-control/disable" && method === "POST") {
      const denied = await requireTenantPermission(db, session, currentTenant, "settings", jsonHeaders);
      if (denied) return denied;
      if (session!.role === "super_admin") {
        return jsonError("The demo organizations keep Remote Control", 400, jsonHeaders);
      }
      if (currentTenant!.remote_control_status !== "approved") {
        return jsonError("Remote Control is not on for this organization", 409, jsonHeaders);
      }
      await updateTenant(db, currentTenant!.id, { remote_control_status: "none" });
      const closed = await closeAllRemoteSessions(env, currentTenant!.id);
      await writeAuditLog(db, {
        tenantId: currentTenant!.id,
        userId: session!.user_id,
        action: "remote_control.disable",
        details: `sessions_closed=${closed}`
      });
      return new Response(JSON.stringify({ status: "ok", sessionsClosed: closed }), { headers: jsonHeaders });
    }

    // POST /api/clients/remote-session: Remote Control through the console's
    // own address (src/remote_relay.ts). { clientId } -> { socketPath, joinSeconds }.
    // The workstation is asked, over the connection it already holds, to join.
    if (path === "/api/clients/remote-session" && method === "POST") {
      const denied = await requireTenantPermission(db, session, currentTenant, "workstations", jsonHeaders);
      if (denied) return denied;
      const notEnabled = await remoteControlRefusal(db, session!, currentTenant!, jsonHeaders);
      if (notEnabled) return notEnabled;
      if (!env.REMOTE_RELAY) return jsonError("This server has no Remote Control relay (REMOTE_RELAY binding)", 503, jsonHeaders);
      let body: { clientId?: unknown };
      try {
        body = (await request.json<typeof body>()) ?? {};
      } catch {
        return jsonError("The request body must be JSON", 400, jsonHeaders);
      }
      const clientId = typeof body?.clientId === "string" ? body.clientId.trim() : "";
      if (!REMOTE_CLIENT_ID.test(clientId)) return jsonError("A workstation id is required", 400, jsonHeaders);
      const tenantId = currentTenant!.id;
      const token = newRelayToken();
      if (!(await openRelaySession(env, tenantId, clientId, await hashRelayToken(token), session!.user_id))) {
        return jsonError("The Remote Control relay could not open a session", 502, jsonHeaders);
      }
      const seats = Number(currentTenant!.remote_control_seats) || 1;
      const asked = await hubRequest(env, tenantId, "/remote-open", {
        clientId,
        session: token,
        userId: session!.user_id,
        seats,
        endsAt: Math.floor(Date.now() / 1000) + RELAY_MAX_SECONDS
      });
      if (asked.status === 429) {
        // The relay session just opened is not used: close it rather than wait for it to expire.
        await closeRelaySession(env, tenantId, clientId);
        const { holders } = (await asked.json()) as { holders?: unknown };
        const busy = Array.isArray(holders) ? holders.map(String).join(", ") : "";
        return jsonError(
          `All ${seats} Remote Control ${seats === 1 ? "seat is" : "seats are"} in use${busy ? ` (${busy})` : ""}. ` +
            "End one of those sessions first, or ask Lab Kiosk for more seats.",
          429,
          jsonHeaders
        );
      }
      if (asked.status === 409) {
        return jsonError("This workstation is not connected to the console right now", 409, jsonHeaders);
      }
      if (!asked.ok) return jsonError("The organization hub could not reach the workstation", 502, jsonHeaders);
      await writeAuditLog(db, {
        tenantId,
        userId: session!.user_id,
        action: "device.remote_control",
        details: `client=${clientId} via=relay`
      });
      const socket = new URLSearchParams({ clientId, session: token });
      if (url.searchParams.get("tenant")) socket.set("tenant", url.searchParams.get("tenant")!);
      return new Response(JSON.stringify({ socketPath: `/api/console/remote?${socket.toString()}`, joinSeconds: RELAY_JOIN_SECONDS }), {
        headers: jsonHeaders
      });
    }

    // GET /api/console/remote: noVNC's end of a relay session, opened by the
    // same operator who asked for it.
    if (path === "/api/console/remote" && method === "GET") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return jsonError("Expected a WebSocket upgrade", 426, jsonHeaders);
      }
      const denied = await requireTenantPermission(db, session, currentTenant, "workstations", jsonHeaders);
      if (denied) return denied;
      const crossSite = rejectCrossSiteSocket(request, { baseDomain: env.DEFAULT_DOMAIN }, jsonHeaders);
      if (crossSite) return crossSite;
      const notEnabled = await remoteControlRefusal(db, session!, currentTenant!, jsonHeaders);
      if (notEnabled) return notEnabled;
      if (!env.REMOTE_RELAY) return jsonError("This server has no Remote Control relay (REMOTE_RELAY binding)", 503, jsonHeaders);
      const clientId = url.searchParams.get("clientId") || "";
      const token = url.searchParams.get("session") || "";
      if (!REMOTE_CLIENT_ID.test(clientId) || !RELAY_TOKEN_PATTERN.test(token)) {
        return jsonError("A workstation id and session are required", 400, jsonHeaders);
      }
      return relayUpgrade(env, currentTenant!.id, clientId, "console", await hashRelayToken(token), session!.user_id);
    }

    // GET /api/settings/updates: which releases this organization's workstations
    // are offered (its channel), the release that means right now, and the
    // security releases some of its workstations still do not run. Minor
    // releases and security fixes always install at the next boot, so there is
    // no setting for them.
    // POST /api/settings/updates { channel?: "stable" | "beta", lanSharing?: boolean }.
    if (path === "/api/settings/updates" && (method === "GET" || method === "POST")) {
      const denied = await requireTenantPermission(db, session, currentTenant, "updates", jsonHeaders);
      if (denied) return denied;
      const tenantId = currentTenant!.id;
      let channel: UpdateChannel = currentTenant!.update_channel === "beta" ? "beta" : "stable";
      let lanSharing = currentTenant!.lan_sharing === 1;
      if (method === "POST") {
        let body: { channel?: unknown; securityUpdates?: unknown; lanSharing?: unknown };
        try {
          body = await request.json<typeof body>();
        } catch {
          return jsonError("The request body must be JSON", 400, jsonHeaders);
        }
        if (
          !body ||
          typeof body !== "object" ||
          (body.channel === undefined && body.securityUpdates === undefined && body.lanSharing === undefined)
        ) {
          return jsonError("Send a channel or a lanSharing setting", 400, jsonHeaders);
        }
        if (body.securityUpdates !== undefined) {
          return jsonError("Minor updates and security fixes always install at the next restart; there is no setting for it", 400, jsonHeaders);
        }
        if (body.channel !== undefined && !isUpdateChannel(body.channel)) {
          return jsonError("The channel is stable or beta", 400, jsonHeaders);
        }
        if (body.lanSharing !== undefined && typeof body.lanSharing !== "boolean") {
          return jsonError("lanSharing is true or false", 400, jsonHeaders);
        }
        const changes: Partial<Tenant> = {};
        if (isUpdateChannel(body.channel) && body.channel !== channel) changes.update_channel = channel = body.channel;
        if (typeof body.lanSharing === "boolean" && body.lanSharing !== lanSharing) {
          lanSharing = body.lanSharing;
          changes.lan_sharing = lanSharing ? 1 : 0;
        }
        if (Object.keys(changes).length) {
          await updateTenant(db, tenantId, changes);
          if (changes.update_channel) {
            await writeAuditLog(db, { tenantId, userId: session!.user_id, action: "settings.update_channel", details: channel });
          }
          if (changes.lan_sharing !== undefined) {
            await writeAuditLog(db, {
              tenantId,
              userId: session!.user_id,
              action: "settings.lan_sharing",
              details: lanSharing ? "on" : "off"
            });
          }
          await notifyConfigChanged(env, tenantId);
        }
      }
      const releases = await offeredReleases(db, channel, tenantId);
      const devices = await listClientDevices(db, tenantId);
      const pending = securityReleasesPending(releases, devices);
      const notices = await organizationReleaseNotices(db, tenantId, releases, devices);
      return new Response(
        JSON.stringify({
          channel,
          offer: newestOffered(releases),
          lanSharing,
          pending,
          support: notices.support,
          majors: notices.majors,
          groups: (await listWorkstationGroups(db, tenantId)).map((g) => g.name)
        }),
        { headers: jsonHeaders }
      );
    }

    // GET /api/usage?days=N: the organization's usage over the last N days (1 to
    // MAX_REPORT_DAYS) by day, by workstation and by site (src/usage.ts).
    // POST /api/usage/settings { recordSites }: record the sites visited, or stop.
    // POST /api/usage/sites/delete: delete every recorded site.
    if (
      (path === "/api/usage" && method === "GET") ||
      ((path === "/api/usage/settings" || path === "/api/usage/sites/delete") && method === "POST")
    ) {
      const denied = await requireTenantPermission(db, session, currentTenant, "settings", jsonHeaders);
      if (denied) return denied;
      const tenant = currentTenant!;
      if (path === "/api/usage/settings") {
        let body: { recordSites?: unknown };
        try {
          body = await request.json<typeof body>();
        } catch {
          return jsonError("The request body must be JSON", 400, jsonHeaders);
        }
        if (!body || typeof body.recordSites !== "boolean") return jsonError("recordSites is true or false", 400, jsonHeaders);
        if ((tenant.usage_sites !== 0) !== body.recordSites) {
          await updateTenant(db, tenant.id, { usage_sites: body.recordSites ? 1 : 0 });
          await writeAuditLog(db, { tenantId: tenant.id, userId: session!.user_id, action: "settings.usage_sites", details: body.recordSites ? "on" : "off" });
          await notifyConfigChanged(env, tenant.id);
        }
        return new Response(JSON.stringify({ status: "ok", recordSites: body.recordSites }), { headers: jsonHeaders });
      }
      if (path === "/api/usage/sites/delete") {
        const deleted = await deleteUsageSites(db, tenant.id);
        await writeAuditLog(db, { tenantId: tenant.id, userId: session!.user_id, action: "usage.delete_sites", details: `rows=${deleted}` });
        return new Response(JSON.stringify({ status: "ok", deleted }), { headers: jsonHeaders });
      }
      const days = Number(url.searchParams.get("days") || 30);
      if (!Number.isInteger(days) || days < 1 || days > MAX_REPORT_DAYS) {
        return jsonError(`days is a whole number from 1 to ${MAX_REPORT_DAYS}`, 400, jsonHeaders);
      }
      const summary = await usageSummary(db, tenant.id, reportPeriod(days), tenant.usage_sites !== 0);
      return new Response(JSON.stringify(summary), { headers: jsonHeaders });
    }

    // GET /api/notifications: the platform's notifications for this organization,
    // newest first, with whether this user has dismissed each.
    // POST /api/notifications/read { ids? }: dismiss them (every one when ids is left out).
    if ((path === "/api/notifications" && method === "GET") || (path === "/api/notifications/read" && method === "POST")) {
      const denied = requireTenantAdmin(session, currentTenant, jsonHeaders);
      if (denied) return denied;
      const tenant = currentTenant!;
      if (method === "POST") {
        let body: { ids?: unknown };
        try {
          body = (await request.json<typeof body>()) ?? {};
        } catch {
          return jsonError("The request body must be JSON", 400, jsonHeaders);
        }
        const ids = body.ids === undefined ? null : body.ids;
        if (ids !== null && !(Array.isArray(ids) && ids.length <= 200 && ids.every((id) => typeof id === "string"))) {
          return jsonError("ids is a list of notification ids", 400, jsonHeaders);
        }
        await markNotificationsRead(db, tenant.id, session!.user_id, ids as string[] | null);
      }
      const notifications = await listNotificationsFor(db, tenant.id, session!.user_id, { limit: 50 });
      return new Response(
        JSON.stringify({ status: "ok", notifications, unread: notifications.filter((n) => !n.read).length }),
        { headers: jsonHeaders }
      );
    }

    // GET /api/legal/status: the legal documents this organization has not
    // accepted at their current version, whether its console now asks before
    // anything else, and whether this account may accept them.
    // POST /api/legal/accept { versions: { terms: "<version>", ... } }: accept
    // them, on behalf of the organization. Only its owner or an org_admin may.
    if ((path === "/api/legal/status" && method === "GET") || (path === "/api/legal/accept" && method === "POST")) {
      const denied = requireTenantAdmin(session, currentTenant, jsonHeaders);
      if (denied) return denied;
      const tenant = currentTenant!;
      const canAccept = await isOrganizationAdministrator(db, session!, tenant);
      const status = await organizationLegalStatus(db, tenant.id);
      if (method === "GET") return new Response(JSON.stringify({ ...status, canAccept }), { headers: jsonHeaders });
      if (session!.role === "super_admin") return jsonError("A platform administrator cannot accept terms for an organization", 403, jsonHeaders);
      if (!canAccept) return jsonError("Only the organization's owner or an administrator can accept the terms", 403, jsonHeaders);
      let body: { versions?: unknown };
      try {
        body = (await request.json<typeof body>()) ?? {};
      } catch {
        return jsonError("The request body must be JSON", 400, jsonHeaders);
      }
      const versions = body?.versions;
      if (!versions || typeof versions !== "object" || Array.isArray(versions)) {
        return jsonError("versions names the version of each document accepted", 400, jsonHeaders);
      }
      if (!status.pending.length) return jsonError("The current terms are already accepted", 409, jsonHeaders);
      const given = versions as Record<string, unknown>;
      const stale = status.pending.filter((doc) => given[doc.id] !== doc.version);
      if (stale.length) {
        return jsonError(`Accept the current ${stale.map((d) => `${d.title} (version ${d.version})`).join(" and ")}; reload the page to read it`, 409, jsonHeaders);
      }
      const user = await findUserById(db, session!.user_id);
      if (!user) return jsonError("Your account was not found", 403, jsonHeaders);
      await recordLegalAcceptances(db, {
        tenantId: tenant.id,
        tenantName: tenant.name,
        userId: user.id,
        userEmail: user.email,
        documents: status.pending.map((doc) => ({ id: doc.id, version: doc.version })),
        source: "console",
        ip: request.headers.get("CF-Connecting-IP"),
        userAgent: request.headers.get("User-Agent")
      });
      await writeAuditLog(db, {
        tenantId: tenant.id,
        userId: user.id,
        action: "legal.accept",
        details: status.pending.map((d) => `${d.id}=${d.version}`).join(" ")
      });
      return new Response(JSON.stringify({ status: "ok", accepted: status.pending.map((d) => ({ id: d.id, version: d.version })) }), {
        headers: jsonHeaders
      });
    }

    // The major upgrade pipeline, each step recorded with who and when:
    // POST /api/settings/updates/request-major { major }: ask Lab Kiosk for a major
    // release closed to this organization.
    // POST /api/settings/updates/pilot-major { major, group }: try a major the platform
    // opened or granted it on one workstation group first (group null ends the trial).
    // POST /api/settings/updates/confirm-major { major }: an administrator's
    // confirmation that every workstation of this organization may be moved to it.
    if (
      (path === "/api/settings/updates/confirm-major" ||
        path === "/api/settings/updates/request-major" ||
        path === "/api/settings/updates/pilot-major") &&
      method === "POST"
    ) {
      const denied = await requireTenantPermission(db, session, currentTenant, "updates", jsonHeaders);
      if (denied) return denied;
      let body: { major?: unknown; group?: unknown };
      try {
        body = (await request.json<typeof body>()) ?? {};
      } catch {
        return jsonError("The request body must be JSON", 400, jsonHeaders);
      }
      const major = body?.major;
      if (typeof major !== "number" || !Number.isInteger(major) || major < 0 || major > MAX_RELEASE_MAJOR) {
        return jsonError("A major release number is required", 400, jsonHeaders);
      }
      const tenantId = currentTenant!.id;
      const access = majorAccess((await listReleaseMajors(db)).get(major), (await listMajorGrants(db, tenantId)).get(major));
      if (access === "free") return jsonError(`Release ${major} needs no confirmation`, 409, jsonHeaders);
      if (access === "confirmed") return jsonError(`Release ${major} is already confirmed`, 409, jsonHeaders);
      if (path.endsWith("/request-major")) {
        if (access === "requested") return jsonError(`Release ${major} has been requested already`, 409, jsonHeaders);
        if (access !== "closed") return jsonError(`Release ${major} is available to this organization already`, 409, jsonHeaders);
        if (!(await releaseOfMajorOffered(db, currentTenant!.update_channel, major))) {
          return jsonError(`No release of Lab Kiosk ${major} is offered on this organization's channel`, 404, jsonHeaders);
        }
        await requestMajor(db, tenantId, major, session!.user_id);
        await writeAuditLog(db, { tenantId, userId: session!.user_id, action: "update.major_request", details: String(major) });
        return new Response(JSON.stringify({ status: "ok", major, access: "requested" }), { headers: jsonHeaders });
      }
      if (access === "closed" || access === "requested") {
        return jsonError(`Release ${major} is not available to this organization yet; ask Lab Kiosk for it`, 403, jsonHeaders);
      }
      if (path.endsWith("/pilot-major")) {
        let group: string | null = null;
        if (body.group !== null) {
          group = typeof body.group === "string" ? body.group.trim() : "";
          if (!group) return jsonError("A workstation group is required", 400, jsonHeaders);
          const chosen = group;
          if (!(await listWorkstationGroups(db, tenantId)).some((g) => g.name === chosen)) {
            return jsonError("Workstation group not found", 404, jsonHeaders);
          }
        }
        await setMajorPilot(db, tenantId, major, group, session!.user_id);
        await writeAuditLog(db, {
          tenantId,
          userId: session!.user_id,
          action: "update.major_pilot",
          details: `${major} group=${group ?? "none"}`
        });
        await notifyConfigChanged(env, tenantId);
        return new Response(JSON.stringify({ status: "ok", major, access: group ? "pilot" : "available" }), { headers: jsonHeaders });
      }
      await confirmMajor(db, tenantId, major, session!.user_id);
      await writeAuditLog(db, { tenantId, userId: session!.user_id, action: "update.major_confirm", details: String(major) });
      await notifyConfigChanged(env, tenantId);
      return new Response(JSON.stringify({ status: "ok", major, access: "confirmed" }), { headers: jsonHeaders });
    }

    // POST /api/clients/check-update { clientIds }: ask these workstations to
    // check for the release their organization is offered now.
    // POST /api/clients/install-update { clientIds }: install it -- or, on a
    // workstation with a security release for its line, that one -- on those
    // that hold it downloaded and verified; the rest come back with the reason.
    if ((path === "/api/clients/check-update" || path === "/api/clients/install-update") && method === "POST") {
      const denied = await requireTenantPermission(db, session, currentTenant, "updates", jsonHeaders);
      if (denied) return denied;
      let body: { clientIds?: unknown };
      try {
        body = (await request.json<typeof body>()) ?? {};
      } catch {
        return jsonError("The request body must be JSON", 400, jsonHeaders);
      }
      if (!Array.isArray(body?.clientIds)) return jsonError("Client IDs array required", 400, jsonHeaders);
      const requested = Array.from(new Set(body.clientIds.map((c) => String(c ?? "").trim()).filter(Boolean)));
      if (!requested.length) return jsonError("Client IDs array required", 400, jsonHeaders);
      if (requested.length > MAX_BATCH_TARGETS) {
        return jsonError(`At most ${MAX_BATCH_TARGETS} workstations can be addressed at once`, 400, jsonHeaders);
      }
      const tenant = currentTenant!;
      // Only this organization's own workstations; an unknown id is reported, never queued.
      const known = new Set((await listClientDevices(db, tenant.id)).map((row) => row.client_id));
      const clientIds = requested.filter((id) => known.has(id));
      const unknown = requested.filter((id) => !known.has(id)).map((clientId) => ({ clientId, reason: "Not found" }));
      const offer = await offeredRelease(db, tenant.update_channel, tenant.id);
      const install = path.endsWith("/install-update");
      if (install && !offer) return jsonError("No release is offered to this organization", 409, jsonHeaders);
      let sent: string[] = [];
      let skipped: Array<{ clientId: string; reason: string }> = unknown;
      let versions = offer ? [offer.version] : [];
      if (clientIds.length && install) {
        const result = await hubJson<{ sent: string[]; skipped: Array<{ clientId: string; reason: string }>; versions: string[] }>(
          env,
          tenant.id,
          "/install-update",
          { clientIds }
        );
        sent = result.sent;
        skipped = skipped.concat(result.skipped);
        versions = result.versions;
      } else if (clientIds.length) {
        // The hub tells each the release meant for it; with LAN sharing, one whose site is still fetching it waits.
        sent = (await hubJson<{ sent: string[] }>(env, tenant.id, "/check-update", { clientIds, version: offer?.version })).sent;
      }
      if (sent.length) {
        await writeAuditLog(db, {
          tenantId: tenant.id,
          userId: session!.user_id,
          action: install ? "update.install" : "update.check",
          details: `clients=${sent.join(",")}${versions.length ? ` version=${versions.join(",")}` : ""}`
        });
      }
      return new Response(
        JSON.stringify({ status: "ok", version: offer?.version ?? null, ...(install ? { versions } : {}), sent, skipped }),
        { headers: jsonHeaders }
      );
    }

    // POST /api/clients/remove: Decommission a workstation
    if (path === "/api/clients/remove" && method === "POST") {
      const denied = await requireTenantPermission(db, session, currentTenant, "workstations", jsonHeaders);
      if (denied) return denied;
      try {
        const body = await request.json<{ clientId: string }>();
        const clientId = String(body.clientId || "").trim();
        if (!clientId) return jsonError("A workstation id is required", 400, jsonHeaders);

        const tenantId = currentTenant!.id;
        await deleteClientDevice(db, tenantId, clientId);
        // Decommissioning must also invalidate the device's credentials, or the
        // workstation simply re-registers itself on its next heartbeat. OrgHub
        // refuses it at once and closes its connection; the token cache of this
        // isolate forgets it, and other isolates' copies expire within a minute.
        await revokeDeviceTokensForClient(db, tenantId, clientId);
        forgetDeviceToken(tenantId, clientId);
        await hubJson(env, tenantId, "/remove-device", { clientId });
        await writeAuditLog(db, {
          tenantId,
          userId: session!.user_id,
          action: "device.remove",
          details: `client=${clientId}`
        });

        return new Response(
          JSON.stringify({
            status: "ok",
            remaining: (await listClientDevices(db, tenantId)).length
          }),
          { headers: jsonHeaders }
        );
      } catch (err: any) {
        console.error("[Worker] Removing workstation failed:", err);
        return jsonError("Could not remove this workstation", 400, jsonHeaders);
      }
    }

    // POST /api/clients/group: Assign workstations to a group
    if (path === "/api/clients/group" && method === "POST") {
      const denied = await requireTenantPermission(db, session, currentTenant, "workstations", jsonHeaders);
      if (denied) return denied;
      try {
        const body = await request.json<{ clientIds: string[]; groupName: string | null }>();
        if (!Array.isArray(body.clientIds) || !body.clientIds.length) {
          return jsonError("Client IDs array required", 400, jsonHeaders);
        }
        const clientIds = Array.from(new Set(body.clientIds.map((c) => String(c || "").trim()).filter(Boolean)));
        if (!clientIds.length) return jsonError("Client IDs array required", 400, jsonHeaders);
        if (clientIds.length > MAX_BATCH_TARGETS) {
          return jsonError(`At most ${MAX_BATCH_TARGETS} workstations can be moved at once`, 400, jsonHeaders);
        }
        const groupName = body.groupName ? String(body.groupName).trim() : null;
        // Only a group that exists: a free-form name would put workstations in a
        // group the console lists nowhere and cannot delete.
        if (groupName && !(await listWorkstationGroups(db, currentTenant!.id)).some((g) => g.name === groupName)) {
          return jsonError("Workstation group not found", 404, jsonHeaders);
        }

        for (let i = 0; i < clientIds.length; i += D1_IN_LIST_CHUNK) {
          await assignClientsToGroup(db, currentTenant!.id, clientIds.slice(i, i + D1_IN_LIST_CHUNK), groupName);
        }
        // A workstation moved into or out of a group a major is being tried on is offered differently.
        if (await hasMajorPilot(db, currentTenant!.id)) await notifyConfigChanged(env, currentTenant!.id);

        await writeAuditLog(db, {
          tenantId: currentTenant!.id,
          userId: session!.user_id,
          action: "group.assign",
          details: `clients=${clientIds.join(",")} group=${groupName || "none"}`
        });

        return new Response(JSON.stringify({ status: "ok", count: clientIds.length }), { headers: jsonHeaders });
      } catch (err: any) {
        console.error("[Worker] Assign group failed:", err);
        return jsonError("Could not assign clients to group", 400, jsonHeaders);
      }
    }

    // GET /api/groups: List groups for current organization tenant
    if (path === "/api/groups" && method === "GET") {
      const denied = await requireTenantPermission(db, session, currentTenant, "workstations", jsonHeaders);
      if (denied) return denied;

      const groups = await listWorkstationGroups(db, currentTenant!.id);
      return new Response(JSON.stringify({ groups }), { headers: jsonHeaders });
    }

    // POST /api/groups: Create a new workstation group
    if (path === "/api/groups" && method === "POST") {
      const denied = await requireTenantPermission(db, session, currentTenant, "workstations", jsonHeaders);
      if (denied) return denied;

      try {
        const body = await request.json<{ name: string }>();
        const name = String(body.name || "").trim();
        if (!name) return jsonError("Group name is required", 400, jsonHeaders);
        if (name.length > MAX_GROUP_NAME_LENGTH) {
          return jsonError(`Group names are at most ${MAX_GROUP_NAME_LENGTH} characters`, 400, jsonHeaders);
        }
        // Membership is stored by name, so two groups with one name would share
        // members, and deleting either would ungroup both.
        const existing = await listWorkstationGroups(db, currentTenant!.id);
        if (existing.some((g) => g.name.toLowerCase() === name.toLowerCase())) {
          return jsonError("A group with this name already exists", 409, jsonHeaders);
        }

        const group = await createWorkstationGroup(db, currentTenant!.id, name);
        await writeAuditLog(db, {
          tenantId: currentTenant!.id,
          userId: session!.user_id,
          action: "group.create",
          details: `name=${name} id=${group.id}`
        });

        return new Response(JSON.stringify({ status: "ok", group }), { headers: jsonHeaders });
      } catch (err: any) {
        // Two requests can both pass the check above; the unique index settles it.
        if (/UNIQUE constraint failed/i.test(String(err?.message))) {
          return jsonError("A group with this name already exists", 409, jsonHeaders);
        }
        console.error("[Worker] Create group failed:", err);
        return jsonError("Could not create workstation group", 400, jsonHeaders);
      }
    }

    // DELETE /api/groups/:id: Delete a workstation group
    if (path.startsWith("/api/groups/") && method === "DELETE") {
      const denied = await requireTenantPermission(db, session, currentTenant, "workstations", jsonHeaders);
      if (denied) return denied;

      const groupId = path.slice("/api/groups/".length).trim();
      if (!groupId) return jsonError("Group ID is required", 400, jsonHeaders);

      if (!(await deleteWorkstationGroup(db, currentTenant!.id, groupId))) {
        return jsonError("Workstation group not found", 404, jsonHeaders);
      }
      // A major being tried on the group is no longer tried anywhere.
      if (await endOrphanedMajorPilots(db, currentTenant!.id)) await notifyConfigChanged(env, currentTenant!.id);
      await writeAuditLog(db, {
        tenantId: currentTenant!.id,
        userId: session!.user_id,
        action: "group.delete",
        details: `id=${groupId}`
      });

      return new Response(JSON.stringify({ status: "ok" }), { headers: jsonHeaders });
    }

    // POST /api/command: Remote command dispatch
    if (path === "/api/command" && method === "POST") {
      try {
        const body = await request.json<{
          target?: string;
          targets?: string[];
          action: string;
          url?: string;
          message?: string;
        }>();

        const rawTargets = Array.isArray(body.targets)
          ? (body.targets as unknown[]).map((t) => String(t || "").trim()).filter(Boolean)
          : [];
        const singleTarget = String(body.target || "").trim();
        // "all" already reaches every workstation, so it replaces any named ones
        // rather than queueing a second command for each of them.
        const named = Array.from(new Set(rawTargets.length > 0 ? rawTargets : (singleTarget ? [singleTarget] : [])));
        const targets = named.includes("all") ? ["all"] : named;

        const action = String(body.action || "").trim();
        if (targets.length === 0 || !action) {
          return jsonError("Target and action required", 400, jsonHeaders);
        }
        if (targets.length > MAX_BATCH_TARGETS) {
          return jsonError(`At most ${MAX_BATCH_TARGETS} workstations can be addressed at once`, 400, jsonHeaders);
        }
        if (!ALLOWED_COMMANDS.has(action)) {
          return jsonError(`Unsupported action: ${action}`, 400, jsonHeaders);
        }

        const requiredPerm = action === "navigate" ? "broadcast" : "workstations";
        const denied = await requireTenantPermission(db, session, currentTenant, requiredPerm, jsonHeaders);
        if (denied) return denied;

        let commandUrl: string | undefined;
        let commandEpoch: number | undefined;
        // A reset carries no URL: each workstation is handed its portal when the
        // command is delivered, built from its own request. Built from this one,
        // it would be the operator's host -- `localhost` for a local console, the
        // apex for a super admin -- which a workstation may not be able to reach.
        let toPortal = false;
        if (action === "navigate") {
          const isReset = Boolean((body as any).resetPortal);
          const portalUrl = portalUrlFor(currentTenant!, request, url, env);

          if (isReset) {
            toPortal = true;
          } else {
            const validated = safeHttpUrl(body.url);
            if (!validated) {
              return jsonError("Navigate requires a valid http(s) URL", 400, jsonHeaders);
            }
            commandUrl = validated;
          }
          commandEpoch = Date.now();

          // The heartbeat re-sends every workstation its target every 3 seconds,
          // so a broadcast has to be recorded where that answer comes from, or the
          // next heartbeat sends the screen straight back to the portal. It is
          // recorded where it was addressed: organization-wide for "all", on each
          // workstation's own row otherwise. A reset is recorded too (URL null,
          // with its epoch) rather than erased, so it outranks an older broadcast
          // instead of letting it resurface.
          const recordedUrl = toPortal || commandUrl === portalUrl ? null : commandUrl ?? null;
          if (targets.includes("all")) {
            await updateTenant(db, currentTenant!.id, { broadcast_url: recordedUrl, broadcast_epoch: commandEpoch });
          } else {
            for (let i = 0; i < targets.length; i += D1_IN_LIST_CHUNK) {
              await setClientsBroadcast(db, currentTenant!.id, targets.slice(i, i + D1_IN_LIST_CHUNK), recordedUrl, commandEpoch);
            }
          }
        }

        const tenantId = currentTenant!.id;
        const lockMsg = body.message
          ? String(body.message).slice(0, 280)
          : action === "lock"
          ? (currentTenant!.default_lock_message || "This screen has been locked by an administrator. Please wait.")
          : undefined;

        // OrgHub queues the command and pushes it at once to every connected
        // workstation it addresses; the rest get it on their next connection or
        // heartbeat until it expires. A navigate changed the recorded broadcast
        // above, so the hub reloads before it delivers.
        const { commandIds: cmdIds } = await hubJson<{ commandIds: string[] }>(env, tenantId, "/enqueue", {
          targets,
          action,
          url: commandUrl,
          epoch: commandEpoch,
          message: lockMsg,
          portal: toPortal,
          reloadConfig: action === "navigate"
        });

        await writeAuditLog(db, {
          tenantId,
          userId: session!.user_id,
          action: `command.${action}`,
          details: `targets=${targets.join(",")}${toPortal ? " url=portal" : commandUrl ? ` url=${commandUrl}` : ""}`
        });

        return new Response(JSON.stringify({ status: "ok", commandId: cmdIds[0], commandIds: cmdIds, count: cmdIds.length }), { headers: jsonHeaders });
      } catch (err: any) {
        console.error("[Worker] Command dispatch failed:", err);
        return jsonError("Could not dispatch this command", 400, jsonHeaders);
      }
    }

    // GET & POST /api/whitelist: Allowed sites management (per organization, persisted)
    if (path === "/api/whitelist" && method === "GET") {
      const denied = requireTenantAdmin(session, currentTenant, jsonHeaders);
      if (denied) return denied;
      return new Response(
        JSON.stringify({ whitelist: await buildEffectiveWhitelist(db, currentTenant!.id) }),
        { headers: jsonHeaders }
      );
    }

    if (path === "/api/whitelist" && method === "POST") {
      const denied = await requireTenantPermission(db, session, currentTenant, "whitelist", jsonHeaders);
      if (denied) return denied;
      try {
        const body = await request.json<{ action: "add" | "remove"; domain: string }>();
        const tenantId = currentTenant!.id;

        if (body.action === "add") {
          const candidate = normalizeDomain(String(body.domain || ""));
          if (!candidate || !candidate.includes(".")) {
            return jsonError("Enter a domain name such as scratch.mit.edu", 400, jsonHeaders);
          }
          const added = await addWhitelistDomain(db, tenantId, candidate);
          await writeAuditLog(db, {
            tenantId,
            userId: session!.user_id,
            action: "whitelist.add",
            details: added
          });
        } else if (body.action === "remove") {
          await removeWhitelistDomain(db, tenantId, body.domain);
          await writeAuditLog(db, {
            tenantId,
            userId: session!.user_id,
            action: "whitelist.remove",
            details: String(body.domain)
          });
        } else {
          return jsonError("Action must be either 'add' or 'remove'", 400, jsonHeaders);
        }
        await notifyConfigChanged(env, tenantId);

        return new Response(
          JSON.stringify({ status: "ok", whitelist: await buildEffectiveWhitelist(db, tenantId) }),
          { headers: jsonHeaders }
        );
      } catch (err: any) {
        console.error("[Worker] Allowlist update failed:", err);
        return jsonError("Could not update the allowed sites list", 400, jsonHeaders);
      }
    }

    // GET /api/status: Lightweight connectivity check for the first-boot wizard.
    // Deliberately anonymous and CORS-open: it exposes nothing but whether a
    // organization subdomain exists and is active.
    if (path === "/api/status") {
      return new Response(
        JSON.stringify({
          status: "ok",
          subdomain:
            currentTenant?.subdomain ||
            hostSubdomain(request, env.DEFAULT_DOMAIN) ||
            cleanSubdomain(url.searchParams.get("tenant") || "") ||
            "root",
          organizationName: currentTenant?.name || "Lab Kiosk Platform",
          // Deprecated alias for agents older than the organization vocabulary.
          schoolName: currentTenant?.name || "Lab Kiosk Platform",
          mode: currentTenant?.mode || "portal",
          isActive: currentTenant ? currentTenant.status === "active" : true
        }),
        { headers: { ...jsonHeaders, "Access-Control-Allow-Origin": "*" } }
      );
    }

    // ==========================================
    // Legal & Compliance Pages
    if (path === "/privacy") {
      return new Response(renderPrivacyPolicyHtml({ canonicalUrl }), { headers: htmlHeaders });
    }
    if (path === "/terms") {
      return new Response(renderTermsOfServiceHtml({ canonicalUrl }), { headers: htmlHeaders });
    }
    if (path === "/content-policy") {
      return new Response(renderContentPolicyHtml({ canonicalUrl }), { headers: htmlHeaders });
    }
    if (path === "/dpa") {
      return new Response(renderDataProcessingAgreementHtml({ canonicalUrl }), { headers: htmlHeaders });
    }
    if (path === "/terms/bug-reports") {
      return new Response(renderBugReportTermsHtml(bugReportRepository(env), { canonicalUrl }), { headers: htmlHeaders });
    }

    // The platform's own pages belong to the platform's address. An organization's
    // host (its subdomain or its own domain) has three paths, each with one job
    // (Rule 5g), and must not also serve Lab Kiosk's pricing and download pages
    // under the organization's name: send those to the platform.
    if ((PLATFORM_PAGES.has(path) || path.startsWith("/docs/") || path.startsWith("/wiki/")) && (method === "GET" || method === "HEAD") && !isPlatformHost(request, env)) {
      const platform = new URL(path, siteOrigin(request, url, env));
      if (platform.origin !== url.origin) return Response.redirect(platform.toString(), 301);
    }

    // ==========================================
    // Public Documentation & Wiki 301 Redirect
    if (path === "/wiki" || path.startsWith("/wiki/")) {
      // "/wiki/Quickstart" is the same page as "/docs/quickstart".
      const wikiPage = findDocsPage(`/docs/${path.slice("/wiki/".length).toLowerCase()}`);
      const redirectUrl = new URL(request.url);
      redirectUrl.pathname = wikiPage ? docsPath(wikiPage.slug) : "/docs";
      return Response.redirect(redirectUrl.toString(), 301);
    }
    // The documentation: the repository's wiki, one page per address under /docs.
    const docsPage = findDocsPage(path);
    if (docsPage) {
      return new Response(
        renderDocsHtml(
          {
            baseDomain,
            contactEmail: "contact@labkiosk.org",
            ...formChecks,
            canonicalUrl,
            nonce
          },
          docsPage
        ),
        { headers: htmlHeaders }
      );
    }

    // ==========================================
    // Dedicated Public Marketing Pages
    if (path === "/features") {
      return new Response(
        renderFeaturesHtml({
          baseDomain,
          contactEmail: "contact@labkiosk.org",
          ...formChecks,
          canonicalUrl,
          nonce
        }),
        { headers: htmlHeaders }
      );
    }
    if (path === "/specs") {
      return new Response(
        renderSpecsHtml({
          baseDomain,
          contactEmail: "contact@labkiosk.org",
          ...formChecks,
          canonicalUrl,
          nonce
        }),
        { headers: htmlHeaders }
      );
    }
    if (path === "/hardware") {
      const [models, computedAt] = await Promise.all([listPublicHardwareModels(db), hardwareModelsComputedAt(db)]);
      return new Response(
        renderHardwareHtml(
          {
            baseDomain,
            contactEmail: "contact@labkiosk.org",
            ...formChecks,
            canonicalUrl,
            nonce
          },
          models,
          computedAt
        ),
        { headers: htmlHeaders }
      );
    }
    if (path === "/contact") {
      return new Response(
        renderContactHtml({
          baseDomain,
          contactEmail: "contact@labkiosk.org",
          ...formChecks,
          canonicalUrl,
          nonce
        }),
        { headers: htmlHeaders }
      );
    }
    if (path === "/pricing") {
      return new Response(
        renderPricingHtml({
          baseDomain,
          contactEmail: "contact@labkiosk.org",
          ...formChecks,
          canonicalUrl,
          nonce
        }),
        { headers: htmlHeaders }
      );
    }
    if (path === "/download") {
      const now = Math.floor(Date.now() / 1000);
      const releaseSupport = [...(await listMajorSupport(db)).values()].map((row) => ({
        major: row.major,
        status: effectiveSupportStatus(row, now),
        endOfLifeAt: row.end_of_life_at ?? null
      }));
      return new Response(
        renderDownloadHtml({
          isoDownloadUrl: env.ISO_DOWNLOAD_URL,
          releases: await majorDownloads(db),
          releaseSupport,
          baseDomain,
          contactEmail: "contact@labkiosk.org",
          ...formChecks,
          canonicalUrl,
          nonce
        }),
        { headers: htmlHeaders }
      );
    }

    // 1. Organization Admin Dashboard (/admin and /admin/*)
    if (path === "/admin" || path.startsWith("/admin/")) {
      // Legacy redirects: consolidated pages, and the staff page's old name.
      if (path === "/admin/teachers") {
        const redirectUrl = new URL(request.url);
        redirectUrl.pathname = "/admin/staff";
        return Response.redirect(redirectUrl.toString(), 302);
      }
      if (path === "/admin/broadcast" || path === "/admin/portal" || path === "/admin/whitelist") {
        const tab = path === "/admin/broadcast" ? "broadcast" : (path === "/admin/portal" ? "portal" : "whitelist");
        const redirectUrl = new URL(request.url);
        redirectUrl.pathname = "/admin/apps-web";
        redirectUrl.searchParams.set("tab", tab);
        return Response.redirect(redirectUrl.toString(), 302);
      }
      if (!session) {
        const slug = cleanSubdomain(url.searchParams.get("tenant") || hostSubdomain(request, env.DEFAULT_DOMAIN) || "");
        const suffix = slug ? `?login=1&tenant=${encodeURIComponent(slug)}` : "?login=1";
        const targetOrigin = (!isDev && env.DEFAULT_DOMAIN) ? `https://${baseDomain}` : url.origin;
        return Response.redirect(`${targetOrigin}/${suffix}`, 302);
      }

      // An operator who explicitly named another organization is refused, not silently
      // bounced to their own console. (A super admin never lands here: the
      // override in resolveTenant admits them, and requireTenantAdmin below is
      // what holds the `demo`-only line.)
      if (resolution.denied) {
        return new Response(
          renderLandingHtml({
            error: "You do not have access to that organization's console.",
            openModal: "login",
            isoDownloadUrl: env.ISO_DOWNLOAD_URL,
            baseDomain,
            contactEmail: "contact@labkiosk.org",
            ...formChecks,
            nonce
          }),
          { status: 403, headers: htmlHeaders }
        );
      }

      // If arriving on apex/base domain without a subdomain:
      const explicitTenant = url.searchParams.get("tenant") || request.headers.get("x-tenant");
      const onApex = !isDev && env.DEFAULT_DOMAIN && hostname(request) === env.DEFAULT_DOMAIN.toLowerCase().replace(/^\./, "") && !explicitTenant;
      if (onApex) {
        if (session.role === "super_admin") {
          // A named console page (/admin/workstations, ...) on the apex can only be
          // a demo console, the only kind a platform admin may open: land in the
          // hosted site's demo rather than bouncing to /super.
          if (path !== "/admin") {
            return Response.redirect(
              `${url.origin}${path}?tenant=${encodeURIComponent(defaultDemoSlug(false))}`,
              302
            );
          }
          return Response.redirect(`${url.origin}/super`, 302);
        }
        if (session.tenant_id) {
          const userTenant = await findTenantById(db, session.tenant_id);
          if (userTenant) {
            return Response.redirect(`https://${userTenant.subdomain}.${baseDomain}${path}`, 302);
          }
        }
      }

      // Land an organization admin on their own console when none was named.
      if (!currentTenant && session.tenant_id) {
        const userTenant = await findTenantById(db, session.tenant_id);
        if (userTenant) {
          if (isDev) {
            return Response.redirect(
              `${url.origin}${path}?tenant=${encodeURIComponent(userTenant.subdomain)}`,
              302
            );
          } else {
            return Response.redirect(
              `https://${userTenant.subdomain}.${baseDomain}${path}`,
              302
            );
          }
        }
      }


      // Land a super admin in a demo console when visiting /admin/* with no organization named:
      // local-demo on a dev host, web-demo otherwise.
      if (!currentTenant && session.role === "super_admin" && path !== "/admin") {
        return Response.redirect(
          `${url.origin}${path}?tenant=${encodeURIComponent(defaultDemoSlug(isDev))}`,
          302
        );
      }

      const denied = requireTenantAdmin(session, currentTenant, jsonHeaders);
      if (denied) {
        // Say which refusal this is. A platform administrator is not locked
        // out by accident: the demo organizations are the only ones they may open,
        // and the console they actually want is /super.
        //
        // Only when the isolation is what actually refused them. A super admin
        // naming an organization that does not exist gets a 400 from the guard, and
        // telling them about privacy isolation would send them looking for the
        // wrong problem.
        const isPlatformIsolation =
          session.role === "super_admin" &&
          denied.status === 403 &&
          Boolean(currentTenant) &&
          !isDemoTenant(currentTenant, session.user_id);
        const message = isPlatformIsolation
          ? `Platform administrators cannot open an organization console. This is the privacy isolation described in the Terms: only the demo organizations (${DEMO_SLUGS.join(", ")}) are available for testing. Use the Super Admin console instead.`
          : "You do not have access to that organization's console.";
        return new Response(
          renderLandingHtml({
            error: message,
            openModal: isPlatformIsolation ? undefined : "login",
            isoDownloadUrl: env.ISO_DOWNLOAD_URL,
            baseDomain,
            contactEmail: "contact@labkiosk.org",
            ...formChecks,
            nonce
          }),
          { status: denied.status, headers: htmlHeaders }
        );
      }

      const tenant = currentTenant!;
      let activePage: AdminPageId = "workstations";
      if (path === "/admin/apps-web") activePage = "apps-web";
      else if (path === "/admin/staff") activePage = "staff";
      else if (path === "/admin/settings") activePage = "settings";

      const userPerms = session.role === "super_admin"
        ? ["*"]
        : await getTenantUserPermissions(db, tenant.id, session.user_id);

      const checkPermission = (page: AdminPageId) => {
        if (userPerms.includes("*") || userPerms.includes(page)) return true;
        if (page === "apps-web") {
          return (
            userPerms.includes("broadcast") ||
            userPerms.includes("portal") ||
            userPerms.includes("whitelist")
          );
        }
        return false;
      };

      // Settings opens for every staff account: without the `settings`
      // permission it renders only the account's own two-factor sign-in.
      const hasAccess = checkPermission(activePage) || activePage === "settings";

      if (!hasAccess) {
        const pages: AdminPageId[] = ["workstations", "apps-web", "staff", "settings"];
        const allowedPage = pages.find(p => checkPermission(p));
        if (allowedPage) {
          const redirectPath = allowedPage === "workstations" ? "/admin" : `/admin/${allowedPage}`;
          const targetUrl = isDev
            ? `${url.origin}${redirectPath}?tenant=${encodeURIComponent(tenant.subdomain)}`
            : `https://${tenant.subdomain}.${baseDomain}${redirectPath}`;
          return Response.redirect(targetUrl, 302);
        }
        return new Response(
          renderLandingHtml({
            error: "You do not have permission to access this section.",
            openModal: "login",
            isoDownloadUrl: env.ISO_DOWNLOAD_URL,
            baseDomain,
            contactEmail: "contact@labkiosk.org",
            ...formChecks,
            nonce
          }),
          { status: 403, headers: htmlHeaders }
        );
      }

      const [portalSites, broadcastPresets, whitelist, staff, user, tenantUser, workstationGroups, enrolledWorkstations] = await Promise.all([
        listPortalSites(db, tenant.id),
        listBroadcastPresets(db, tenant.id),
        buildEffectiveWhitelist(db, tenant.id),
        listTenantUsers(db, tenant.id),
        findUserById(db, session.user_id),
        getTenantUser(db, tenant.id, session.user_id),
        listWorkstationGroups(db, tenant.id),
        countEnrolledWorkstations(db, tenant.id)
      ]);
      const userRole = session.role === "super_admin"
        ? "super_admin"
        : (tenant.user_id === session.user_id ? "org_admin" : (tenantUser?.role || "operator"));
      // The platform's own demos have no customer to accept anything.
      const legalStatus = isDemoTenant(tenant, session.user_id) ? null : await organizationLegalStatus(db, tenant.id);
      const takenDownCards = await listTakenDownPortalSites(db, tenant.id);

      const config: LabConfig = {
        ...DEFAULT_CONFIG,
        defaultHomepage: env.DEFAULT_HOMEPAGE || DEFAULT_CONFIG.defaultHomepage,
        homeRoute: tenant.home_route || "/",
        whitelist
      };

      const host = hostname(request);
      const isTenantHost =
        host === `${tenant.subdomain}.${baseDomain}`.toLowerCase() ||
        (tenant.custom_domain && host === tenant.custom_domain.toLowerCase());
      // A super admin can only be here in a demo; off its own host the tenant rides along.
      const needsTenantParam = isDev || (session.role === "super_admin" && !isTenantHost);

      return new Response(
        renderDashboardHtml({
          config,
          tenant,
          sites: portalSites,
          baseDomain,
          presets: broadcastPresets,
          staff,
          groups: workstationGroups,
          enrolledWorkstations,
          activePage,
          legal: legalStatus && legalStatus.pending.length ? { ...legalStatus, canAccept: userRole === "org_admin" } : undefined,
          license: isDemoTenant(tenant, session.user_id) ? undefined : licenseState(tenant),
          notifications: await listNotificationsFor(db, tenant.id, session.user_id, { unreadOnly: true, limit: 50 }),
          takedowns: {
            homepage: tenant.homepage_takedown_at ? { at: tenant.homepage_takedown_at, reason: tenant.homepage_takedown_reason ?? null } : null,
            cards: takenDownCards.map((c) => ({ title: c.title, url: c.url, at: Number(c.takedown_at), reason: c.takedown_reason ?? null }))
          },
          currentUser: user ? { name: user.name, email: user.email, role: userRole, permissions: userPerms } : undefined,
          userPermissions: userPerms,
          isDevHost: isDev,
          needsTenantParam,
          nonce
        }),
        { headers: htmlHeaders }
      );
    }

    // 2. User Portal (root of an organization subdomain or custom domain)
    const wantsOrganizationHome = path === "/";
    const wantsPortal = path === "/home";
    // ?login=1 and ?register=1 are an explicit request for the sign-in page, and
    // they outrank the tenant on the URL. The redirect that sends a signed-out
    // operator here is `/?login=1&tenant=<organization>`, and naming an organization used to
    // route it to that organization’s page instead -- the portal before, the homepage
    // after -- so the one link in the product that offers a sign-in form never
    // reached one.
    const wantsAuthPage = url.searchParams.has("login") || url.searchParams.has("register");
    const wantsOrganizationPage = (wantsOrganizationHome || wantsPortal) && !wantsAuthPage;
    const namedTenant = url.searchParams.has("tenant") || request.headers.has("x-tenant");
    const onSubdomain = hostSubdomain(request, env.DEFAULT_DOMAIN) !== null;
    const isCustomDomainHost = Boolean(
      currentTenant?.custom_domain && hostname(request) === currentTenant.custom_domain.toLowerCase()
    );

    if (wantsOrganizationPage && (namedTenant || onSubdomain || isCustomDomainHost)) {
      if (!currentTenant) {
        const requested = cleanSubdomain(url.searchParams.get("tenant") ?? hostSubdomain(request, env.DEFAULT_DOMAIN) ?? "");
        return new Response(
          renderStatusPageHtml({
            title: "Organization Not Found",
            heading: "Organization Subdomain Not Found",
            messageHtml: `The requested subdomain <code>${escapeHtml(requested)}</code> is not registered.`,
            homeHref: `${url.origin}/`
          }),
          { status: 404, headers: htmlHeaders }
        );
      }

      if (currentTenant.status !== "active") {
        const suspended = currentTenant.status === "suspended";
        return new Response(
          renderStatusPageHtml({
            title: suspended ? "Organization Suspended" : "Pending Approval",
            heading: suspended ? "Organization Suspended" : "Subdomain Pending Approval",
            messageHtml: `Organization <strong>${escapeHtml(currentTenant.name)}</strong> (<code>${escapeHtml(currentTenant.subdomain)}</code>) ${suspended ? "has been suspended by the platform super administrator." : "is awaiting activation by the platform super administrator."}`,
            homeHref: `${url.origin}/`,
            tone: "warning"
          }),
          { status: 403, headers: htmlHeaders }
        );
      }

      // Single-site lockdown outranks both pages: the organization has chosen that
      // its workstations only ever see one site.
      if (currentTenant.mode === "single_url") {
        const target = safeHttpUrl(currentTenant.default_url);
        if (target) return Response.redirect(target, 302);
        console.warn(`[Worker] Tenant ${currentTenant.subdomain} has an invalid default_url; showing the portal instead.`);
      }

      // Anyone can report a hosted page: the platform's contact form, preset to legal.
      const reportHref = `${isDev ? url.origin : `https://${baseDomain}`}/contact?reason=legal&report=${encodeURIComponent(`${url.origin}${url.pathname}${namedTenant ? `?tenant=${currentTenant.subdomain}` : ""}`)}`;

      // The root is the organization's own page; the grid lives at /home.
      if (wantsOrganizationHome) {
        const portalPath = namedTenant
          ? `/home?tenant=${encodeURIComponent(currentTenant.subdomain)}`
          : "/home";
        return new Response(
          renderOrgHomeHtml({
            tenant: currentTenant,
            blocks: parseHomepageBlocks(currentTenant.homepage_blocks),
            portalPath,
            reportHref
          }),
          { headers: htmlHeaders }
        );
      }

      const portalSites = await listPortalSites(db, currentTenant.id);
      return new Response(renderPortalHtml(currentTenant, portalSites, nonce, reportHref), { headers: htmlHeaders });
    }

    // 3. Public SaaS Landing Page (Root domain)
    if (
      path === "/" ||
      path === "/login" ||
      path === "/register" ||
      path === "/iso"
    ) {
      const openModal =
        path === "/register" || url.searchParams.has("register")
          ? "register"
          : path === "/login" || url.searchParams.has("login")
            ? "login"
            : path === "/iso" || url.searchParams.has("download") || url.searchParams.has("iso")
              ? "iso"
              : undefined;
      return new Response(
        renderLandingHtml({
          openModal,
          isoDownloadUrl: env.ISO_DOWNLOAD_URL,
          baseDomain,
          contactEmail: "contact@labkiosk.org",
          ...formChecks,
          canonicalUrl,
          nonce
        }),
        { headers: htmlHeaders }
      );
    }

    // A person who followed a bad link gets a page with a way back; a program gets JSON.
    if ((method === "GET" || method === "HEAD") && !path.startsWith("/api/") && (request.headers.get("Accept") || "").includes("text/html")) {
      return new Response(
        renderStatusPageHtml({
          title: "Page Not Found",
          heading: "This page does not exist",
          messageHtml: "The address may have been mistyped, or the page may have moved.",
          homeHref: `${url.origin}/`
        }),
        { status: 404, headers: htmlHeaders }
      );
    }
    return jsonError("Not Found", 404, jsonHeaders);
  }
};
