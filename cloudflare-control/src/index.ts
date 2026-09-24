/**
 * Multi-Tenant Lab Kiosk Cloudflare Controller & API
 * Manages Super Admin, Organization Tenant Admins, Subdomain Routing, User portals, and PC Telemetry.
 *
 * Authorization rules live in `guard.ts` and output escaping in `escape.ts`.
 * No route in this file may resolve a tenant or render untrusted data without them.
 */

import { Env, LabConfig, ClientTelemetry, Tenant, User, TenantUserRole, Session } from "./types";
import { renderDashboardHtml, AdminPageId } from "./ui";
import { renderPortalHtml } from "./ui_portal";
import { renderOrgHomeHtml } from "./ui_org_home";
import { renderSuperAdminHtml } from "./ui_super";
import { renderLandingHtml } from "./ui_landing";
import { renderPrivacyPolicyHtml, renderTermsOfServiceHtml } from "./ui_legal";
import {
  initSchema,
  ensureSuperAdmin,
  ensureDemoTenants,
  findUserByEmail,
  findUserById,
  createUser,
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
  createPortalSite,
  deletePortalSite,
  upsertClientDevice,
  listClientDevices,
  deleteClientDevice,
  listWorkstationGroups,
  createWorkstationGroup,
  deleteWorkstationGroup,
  assignClientsToGroup,
  setClientsBroadcast,
  enqueueCommands,
  popCommandsForClient,
  purgeExpiredCommands,
  createDeviceToken,
  revokeDeviceTokensForClient,
  addWhitelistDomain,
  removeWhitelistDomain,
  buildEffectiveWhitelist,
  normalizeDomain,
  regenerateEnrollmentKey,
  writeAuditLog,
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
  createSessionCookie,
  clearSessionCookie,
  timingSafeEqual,
  validatePasswordStrength,
  isPlausibleEmail,
  generateNonce
} from "./auth";
import {
  resolveTenant,
  requireSuperAdmin,
  requireTenantAdmin,
  requireTenantPermission,
  requireDevice,
  jsonError,
  hostname,
  hostSubdomain,
  isDevHost,
  isHostUnder,
  isReservedSlug,
  rejectCrossSiteMutation
} from "./guard";
import { escapeHtml, cleanSubdomain, cleanCustomDomain, safeHttpUrl } from "./escape";
import { createLocalD1Database } from "./d1_adapter";
import { DEMO_SLUGS, WEB_DEMO_TUNNEL_DOMAIN, defaultDemoSlug, isDemoSlug, isDemoTenant } from "./demo";

/** Largest screen thumbnail a workstation may upload (base64 data URL). */
const MAX_THUMBNAIL_BYTES = 256 * 1024;

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

/**
 * The permissions a staff account may hold. `*` is never stored: full access
 * comes only from owning the organization or holding the `org_admin` role.
 */
const STAFF_PERMISSIONS = new Set(["workstations", "broadcast", "portal", "whitelist", "staff", "settings"]);
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

/** Longest x11vnc password a workstation may report (x11vnc itself uses the first 8 characters). */
const MAX_VNC_PASSWORD_LENGTH = 64;

/** DNS label limit; a longer organization slug can never resolve. */
const MAX_SUBDOMAIN_LENGTH = 63;

/** Public registration: attempts allowed per source address per window. */
const REGISTER_RATE_LIMIT = { limit: 10, windowSeconds: 3600 };
/** Failed enrolments allowed per source address per window before the endpoint answers 429. */
const ENROLL_FAILURE_RATE_LIMIT = { limit: 10, windowSeconds: 900 };

/**
 * Ephemeral in-memory database, used only by the test suite and local dev.
 * A production deployment with no D1 binding fails loudly rather than silently
 * running on storage that disappears when the isolate recycles.
 */
let localDbInstance: D1Database | null = null;
function getDatabase(env: Env): D1Database {
  if (env.DB) return env.DB;
  if (env.ALLOW_LOCAL_DB !== "1") {
    throw new Error(
      "No D1 database bound. Bind `DB` in wrangler.jsonc, or set ALLOW_LOCAL_DB=1 to use the ephemeral in-memory database for local development."
    );
  }
  if (!localDbInstance) {
    localDbInstance = createLocalD1Database();
  }
  return localDbInstance;
}

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
      if (!production && (Boolean(email) !== Boolean(password))) {
        throw new Error("SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD must be set together, or both left unset for local development.");
      }
      const superAdmin = await ensureSuperAdmin(
        db,
        email && password ? { email, password } : LOCAL_DEV_SUPER_ADMIN
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
  defaultHomepage: "https://labkiosk.akbhoi.com",
  tunnelDomain: "",
  whitelist: [],
  scheduledShutdown: "17:00"
};

/**
 * In-memory telemetry cache, partitioned by tenant.
 * This is a latency optimisation only -- `client_devices` in D1 is the source of
 * truth, because worker isolates are per-colocation and short-lived.
 */
const tenantTelemetryCache: Record<string, Record<string, ClientTelemetry>> = {};

/**
 * The URL a workstation of this organization should open.
 *
 * A workstation may reach the control plane on a host that is not its organization's
 * own subdomain: the Docker simulator talks to `host.docker.internal`, and a
 * worker deployed to `*.workers.dev` has no organization subdomain at all. Returning a
 * bare `${origin}/` in those cases lands the kiosk on the public landing page
 * instead of the organization's portal, so the organization is named explicitly whenever the
 * host itself cannot carry it.
 */
function effectiveOrigin(request: Request, url: URL): string {
  // The Host header is the only origin evidence honoured: a caller-supplied
  // X-Forwarded-Host would let anyone choose where a workstation is sent.
  const host = request.headers.get("host");
  if (host && isDevHost(request)) {
    const proto = (request.headers.get("x-forwarded-proto") || url.protocol || "http:").replace(/:?$/, ":");
    return `${proto}//${host}`;
  }
  return url.origin;
}

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
}): string {
  const { role, ownSubdomain, hostSlug, requestedSlug, isDev, baseDomain } = options;

  const consoleFor = (slug: string) =>
    isDev ? `/admin?tenant=${encodeURIComponent(slug)}` : `https://${slug}.${baseDomain}/admin`;

  if (role === "super_admin") {
    // The organization they were already looking at, if they are allowed in it.
    const context = hostSlug || requestedSlug;
    if (isDemoSlug(context)) return consoleFor(context);
    return "/super";
  }

  if (ownSubdomain) return consoleFor(ownSubdomain);
  return "/admin";
}

function portalUrlFor(tenant: Tenant, request: Request, url: URL, env: Env): string {
  const origin = effectiveOrigin(request, url);
  const homePath = tenant.home_route && tenant.home_route.startsWith("/") ? tenant.home_route : "/";
  const named = `${origin}${homePath === "/" ? "" : homePath}?tenant=${encodeURIComponent(tenant.subdomain)}`;

  if (tenant.mode === "single_url") {
    return safeHttpUrl(tenant.default_url) || named;
  }

  // If reached on local dev or unencrypted HTTP, return the local origin URL so
  // workstations and Docker simulators can test without needing public DNS.
  const isHttps = Boolean(
    url.protocol === "https:" ||
    request.headers.get("x-forwarded-proto") === "https" ||
    request.headers.get("cf-visitor")?.includes('"scheme":"https"')
  );
  if (!isHttps || isDevHost(request)) {
    return named;
  }

  // Already on this organization's own subdomain or custom domain:
  if (
    hostSubdomain(request, env.DEFAULT_DOMAIN) === tenant.subdomain ||
    (tenant.custom_domain && hostname(request) === tenant.custom_domain.toLowerCase())
  ) {
    return `${url.origin}${homePath}`;
  }

  // If an active custom domain is configured, it is the canonical address for this organization.
  if (tenant.custom_domain) {
    return `https://${tenant.custom_domain}${homePath}`;
  }

  // Talking to the production domain, so the organization has a canonical address.
  if (env.DEFAULT_DOMAIN) {
    const base = env.DEFAULT_DOMAIN.replace(/^\./, "").toLowerCase();
    const host = hostname(request);
    if (host === base || host.endsWith("." + base)) {
      return `https://${tenant.subdomain}.${base}${homePath}`;
    }
  }

  // Reached on some other host (container gateway, workers.dev, a bare IP).
  return named;
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
 */
function buildHtmlHeaders(nonce: string, options: { hsts: boolean }): Record<string, string> {
  const csp = [
    "default-src 'self'",
    `script-src 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: https:",
    // Remote control embeds a workstation's noVNC page: its tunnel hostname in
    // production, or the simulator's published port in local development.
    "frame-src https: http://localhost:6080 http://127.0.0.1:6080",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'"
  ].join("; ");
  const headers: Record<string, string> = {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": csp,
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "same-origin",
    "X-Frame-Options": "DENY",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cache-Control": "no-store"
  };
  if (options.hsts) headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains";
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
    await deleteExpiredSessions(db);
    await purgeExpiredCommands(db);
    await purgeStaleLoginAttempts(db);
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    const db = getDatabase(env);
    await bootstrap(db, env);

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

    // --- Identity -----------------------------------------------------------
    const cookies = parseCookies(request.headers.get("cookie"));
    const authHeader = request.headers.get("authorization");
    const usedCookie = Boolean(cookies["labkiosk_session"]);
    const sessionToken =
      cookies["labkiosk_session"] ||
      (authHeader && authHeader.startsWith("Bearer ") ? authHeader.substring(7) : null);
    const session = sessionToken ? await getSession(db, sessionToken) : null;

    const isDev = isDevHost(request);
    const isHttps = Boolean(
      url.protocol === "https:" ||
      request.headers.get("x-forwarded-proto") === "https" ||
      request.headers.get("cf-visitor")?.includes('"scheme":"https"')
    );
    const secureCookies = Boolean(isHttps && !isDev);
    const cookieDomain =
      isHttps && !isDev && env.DEFAULT_DOMAIN && isHostUnder(hostname(request), env.DEFAULT_DOMAIN)
        ? env.DEFAULT_DOMAIN
        : undefined;
    const sessionCookie = (token: string) =>
      createSessionCookie(token, { domain: cookieDomain, secure: secureCookies });
    const clientIp = request.headers.get("CF-Connecting-IP") || "127.0.0.1";

    // Every HTML response carries the same hardened headers and a fresh CSP nonce.
    const nonce = generateNonce();
    const htmlHeaders = buildHtmlHeaders(nonce, { hsts: isHttps && !isDev });
    const baseDomain = env.DEFAULT_DOMAIN || "labkiosk.akbhoi.com";

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
    if (resolution.denied && path.startsWith("/api/")) {
      return jsonError("You do not have access to this organization", 403, jsonHeaders);
    }

    if (currentTenant && !tenantTelemetryCache[currentTenant.id]) {
      tenantTelemetryCache[currentTenant.id] = {};
    }

    // ==========================================
    // AUTHENTICATION API ENDPOINTS
    // ==========================================

    // POST /api/auth/register: Organization Admin Signup & Subdomain Claim
    if (path === "/api/auth/register" && method === "POST") {
      try {
        const body = await request.json<{
          name: string;
          email: string;
          password: string;
          subdomain: string;
        }>();

        if (!body.name || !body.email || !body.password || !body.subdomain) {
          return jsonError("All fields are required", 400, jsonHeaders);
        }

        const passwordProblem = validatePasswordStrength(body.password);
        if (passwordProblem) {
          return jsonError(passwordProblem, 400, jsonHeaders);
        }

        const name = String(body.name).trim().slice(0, 120);
        if (!name) {
          return jsonError("Organization name is required", 400, jsonHeaders);
        }

        if (!isPlausibleEmail(body.email)) {
          return jsonError("Please enter a valid email address", 400, jsonHeaders);
        }

        const cleanSub = cleanSubdomain(body.subdomain);
        if (cleanSub.length < 3 || cleanSub.length > MAX_SUBDOMAIN_LENGTH) {
          return jsonError(
            `Subdomain must be 3-${MAX_SUBDOMAIN_LENGTH} characters (letters, numbers, hyphens)`,
            400,
            jsonHeaders
          );
        }
        if (isReservedSlug(cleanSub)) {
          return jsonError("That subdomain is reserved by the platform. Please pick another.", 400, jsonHeaders);
        }

        const registerKey = `register:${clientIp}`;
        const wait = await rateLimitWait(db, registerKey, REGISTER_RATE_LIMIT.limit, REGISTER_RATE_LIMIT.windowSeconds);
        if (wait > 0) {
          return jsonError(`Too many registrations from this address. Try again in ${Math.ceil(wait / 60)} minute(s).`, 429, jsonHeaders);
        }
        await recordRateLimitHit(db, registerKey, REGISTER_RATE_LIMIT.windowSeconds);

        if (await findUserByEmail(db, body.email)) {
          return jsonError("Email already registered. Please sign in.", 400, jsonHeaders);
        }
        if (await findTenantBySubdomain(db, cleanSub)) {
          return jsonError("Subdomain already claimed. Please pick another.", 400, jsonHeaders);
        }

        const user = await createUser(db, {
          email: body.email,
          password: body.password,
          name,
          role: "org_admin"
        });

        const tenant = await createTenant(db, {
          userId: user.id,
          name,
          subdomain: cleanSub,
          status: "active" // Active immediately so a lab can be set up the same day
        });

        const token = generateSessionToken();
        await createSession(db, {
          token,
          user_id: user.id,
          tenant_id: tenant.id,
          role: "org_admin",
          expires_at: Math.floor(Date.now() / 1000) + 7 * 24 * 3600
        });

        await writeAuditLog(db, {
          tenantId: tenant.id,
          userId: user.id,
          action: "tenant.register",
          details: `subdomain=${tenant.subdomain}`
        });

        return new Response(
          JSON.stringify({ status: "ok", role: "org_admin", subdomain: tenant.subdomain }),
          { headers: { ...jsonHeaders, "Set-Cookie": sessionCookie(token) } }
        );
      } catch (err: any) {
        console.error("[Worker] Registration failed:", err);
        return jsonError("Registration failed. Please try again.", 500, jsonHeaders);
      }
    }

    // POST /api/auth/login: Operator or Super Admin Sign In
    if (path === "/api/auth/login" && method === "POST") {
      try {
        const body = await request.json<{ email: string; password: string; tenant?: string }>();
        if (!body.email || !body.password) {
          return jsonError("Email and password required", 400, jsonHeaders);
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
          ? await verifyPassword(body.password, user.password_hash, user.salt)
          : await verifyPassword(body.password, "0".repeat(64), "0".repeat(64));

        if (!user || !isValid) {
          await recordLoginFailure(db, identifier);
          return jsonError("Invalid email or password", 401, jsonHeaders);
        }

        await clearLoginFailures(db, identifier);
        await deleteExpiredSessions(db, user.id);

        const tenant = user.role === "org_admin" ? await findTenantByUserId(db, user.id) : null;
        const token = generateSessionToken();
        await createSession(db, {
          token,
          user_id: user.id,
          tenant_id: tenant?.id || null,
          role: user.role,
          expires_at: Math.floor(Date.now() / 1000) + 7 * 24 * 3600
        });

        await writeAuditLog(db, {
          tenantId: tenant?.id || null,
          userId: user.id,
          action: "auth.login",
          details: `role=${user.role}`
        });

        return new Response(
          JSON.stringify({
            status: "ok",
            role: user.role,
            subdomain: tenant?.subdomain || null,
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
              baseDomain
            })
          }),
          { headers: { ...jsonHeaders, "Set-Cookie": sessionCookie(token) } }
        );
      } catch (err: any) {
        console.error("[Worker] Login failed:", err);
        return jsonError("Sign-in failed. Please try again.", 500, jsonHeaders);
      }
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
      return new Response(null, {
        status: 302,
        headers: {
          Location: "/",
          "Set-Cookie": clearSessionCookie({ domain: cookieDomain, secure: secureCookies })
        }
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
        if (!user || !(await verifyPassword(currentPassword, user.password_hash, user.salt))) {
          return jsonError("Current password is not correct", 400, jsonHeaders);
        }
        if (currentPassword === newPassword) {
          return jsonError("New password must differ from the current one", 400, jsonHeaders);
        }

        await updateUserPassword(db, user.id, newPassword);
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

    if (path === "/super" || path.startsWith("/super/") || (hostname(request).split(".")[0] === "super" && path === "/")) {
      if (!session || session.role !== "super_admin") {
        return new Response(
          renderLandingHtml({
            error: "Super administrator access required. Please sign in.",
            openModal: "login",
            isoDownloadUrl: env.ISO_DOWNLOAD_URL,
            baseDomain,
            contactEmail: "contact@akbhoi.com",
            nonce
          }),
          { status: 401, headers: htmlHeaders }
        );
      }

      let activeTab: "organizations" | "approvals" | "catalogs" | "system" = "organizations";
      if (path === "/super/approvals") activeTab = "approvals";
      else if (path === "/super/catalogs") activeTab = "catalogs";
      else if (path === "/super/system") activeTab = "system";

      const allTenants = await listAllTenants(db);
      const catalogs = await listUiCatalogs(db);
      return new Response(
        renderSuperAdminHtml({
          superAdminEmail: (await findUserById(db, session.user_id))?.email || "admin@akbhoi.com",
          superAdminId: session.user_id,
          tenants: allTenants,
          catalogs,
          baseDomain,
          activeTab,
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
        return new Response(JSON.stringify({ status: "ok", tenantStatus: suspend ? "suspended" : "active" }), {
          headers: jsonHeaders
        });
      } catch (err: any) {
        console.error("[Worker] Tenant status change failed:", err);
        return jsonError("Could not change this organization's status", 400, jsonHeaders);
      }
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

        await updateTenant(db, body.tenantId, {
          subdomain: cleanSub,
          requested_subdomain: null,
          status: "active"
        });

        await writeAuditLog(db, {
          tenantId: body.tenantId,
          userId: session!.user_id,
          action: "tenant.approve",
          details: `subdomain=${cleanSub}`
        });

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
        if (isDemoTenant(await findTenantById(db, body.tenantId), session!.user_id)) {
          return jsonError(DEMO_LOCKED_MESSAGE, 400, jsonHeaders);
        }
        await updateTenant(db, body.tenantId, { status: "rejected", requested_subdomain: null });
        await writeAuditLog(db, {
          tenantId: body.tenantId,
          userId: session!.user_id,
          action: "tenant.reject"
        });
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

        const existing = await findTenantByCustomDomain(db, domain);
        if (existing && existing.id !== targetTenant.id) {
          return jsonError("This domain is already assigned to another organization", 400, jsonHeaders);
        }

        await approveCustomDomain(db, targetTenant.id, domain);
        await writeAuditLog(db, {
          tenantId: targetTenant.id,
          userId: session!.user_id,
          action: "tenant.approve_custom_domain",
          details: `customDomain=${domain}`
        });

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

        await removeCustomDomain(db, targetTenant.id);
        await writeAuditLog(db, {
          tenantId: targetTenant.id,
          userId: session!.user_id,
          action: "tenant.remove_custom_domain"
        });
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
          const trimmedName = String(body.name).trim().slice(0, 120);
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
      return new Response(
        JSON.stringify({ enrollmentKey: currentTenant!.enrollment_key, subdomain: currentTenant!.subdomain }),
        { headers: jsonHeaders }
      );
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

        // Prevent setting the platform apex or its subdomains as custom domain
        if (env.DEFAULT_DOMAIN) {
          const base = env.DEFAULT_DOMAIN.replace(/^\./, "").toLowerCase();
          if (domain === base || domain.endsWith("." + base)) {
            return jsonError("Custom domain cannot be a subdomain of the platform domain", 400, jsonHeaders);
          }
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
        await removeCustomDomain(db, currentTenant!.id);
        await writeAuditLog(db, {
          tenantId: currentTenant!.id,
          userId: session!.user_id,
          action: "settings.remove_custom_domain"
        });
        return new Response(JSON.stringify({ status: "ok" }), { headers: jsonHeaders });
      } catch (err: any) {
        console.error("[Worker] Remove custom domain failed:", err);
        return jsonError("Could not remove custom domain", 400, jsonHeaders);
      }
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

        if (!body.name || !body.email) {
          return jsonError("Name and email are required", 400, jsonHeaders);
        }
        if (!isPlausibleEmail(body.email)) {
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
          const passwordProblem = validatePasswordStrength(String(body.password));
          if (passwordProblem) return jsonError(passwordProblem, 400, jsonHeaders);
        }

        // An address that already has an account is refused rather than linked:
        // linking would let any organization pull another organization's administrator (or
        // the platform's) into its own staff list and read back their name.
        if (await findUserByEmail(db, String(body.email).toLowerCase().trim())) {
          return jsonError("An account with this email address already exists", 409, jsonHeaders);
        }

        const operator = await createTenantUser(db, {
          tenantId: currentTenant!.id,
          email: body.email,
          name: body.name,
          password: body.password,
          role,
          permissions
        });

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

        const redirectUrl = isDev
          ? `/admin?tenant=${encodeURIComponent(cleanSub)}`
          : `https://${cleanSub}.${baseDomain}/admin`;

        return new Response(JSON.stringify({ status: "ok", subdomain: cleanSub, redirectUrl }), { headers: jsonHeaders });
      } catch (err: any) {
        console.error("[Worker] Subdomain update failed:", err);
        return jsonError("Could not update subdomain", 400, jsonHeaders);
      }
    }

    // POST /api/tenant/settings: update Settings (mode, home_route, tunnel_domain, profile)
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
          details: `${blocks.length} block(s)`
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
          tunnelDomain?: string;
          portalTitle?: string;
          portalSubtitle?: string;
          portalDescription?: string;
          portalFooter?: string;
        }>();

        const updates: Partial<Tenant> = {};
        if (body.name !== undefined) {
          const trimmed = String(body.name).trim().slice(0, 120);
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
        if (body.tunnelDomain !== undefined) {
          updates.tunnel_domain = cleanCustomDomain(body.tunnelDomain) || null;
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

        const { token } = await createDeviceToken(db, { tenantId: tenant.id, clientId });
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

    // POST /api/telemetry: Ingest workstation status & thumbnail (device token required)
    if (path === "/api/telemetry" && method === "POST") {
      const auth = await requireDevice(request, db, jsonHeaders);
      if (auth.error) return auth.error;
      const device = auth.device;

      const tenant = await findTenantById(db, device.tenant_id);
      if (!tenant || tenant.status !== "active") {
        return jsonError("This organization is not active", 403, jsonHeaders);
      }

      try {
        const body = await request.json<Partial<ClientTelemetry>>();
        // The token, never the request body, decides who this workstation is.
        const clientId = device.client_id;
        const tenantId = device.tenant_id;
        const now = Math.floor(Date.now() / 1000);

        // Remote-control details the workstation volunteers: the x11vnc password
        // it generated at boot and the tunnel hostname its noVNC gateway answers on.
        const vncPassword =
          typeof body.vncPassword === "string" && body.vncPassword.trim()
            ? body.vncPassword.trim().slice(0, MAX_VNC_PASSWORD_LENGTH)
            : undefined;
        const remoteHost = typeof body.remoteHost === "string" ? cleanCustomDomain(body.remoteHost) || undefined : undefined;

        let thumbnail = typeof body.thumbnail === "string" ? body.thumbnail : undefined;
        if (thumbnail) {
          if (!thumbnail.startsWith("data:image/jpeg;base64,") && !thumbnail.startsWith("data:image/png;base64,")) {
            thumbnail = undefined;
          } else if (thumbnail.length > MAX_THUMBNAIL_BYTES) {
            console.warn(`[Worker] Dropping oversized thumbnail from ${clientId} (${thumbnail.length} bytes)`);
            thumbnail = undefined;
          }
        }

        const activeUrl = safeHttpUrl(body.activeUrl) || (tenant.default_url ? safeHttpUrl(tenant.default_url) : "") || DEFAULT_CONFIG.defaultHomepage;
        const clientNum = Number.isFinite(Number(body.clientNum)) ? Number(body.clientNum) : 1;

        const record: ClientTelemetry = {
          clientId,
          clientNum,
          activeUrl,
          isLocked: Boolean(body.isLocked),
          thumbnail,
          timestamp: now,
          ip: clientIp,
          lastSeen: new Date().toISOString(),
          online: true,
          vncPassword: vncPassword ?? tenantTelemetryCache[tenantId]?.[clientId]?.vncPassword,
          remoteHost: remoteHost ?? tenantTelemetryCache[tenantId]?.[clientId]?.remoteHost
        };

        if (!tenantTelemetryCache[tenantId]) tenantTelemetryCache[tenantId] = {};
        tenantTelemetryCache[tenantId][clientId] = record;

        const ownBroadcast = await upsertClientDevice(db, {
          tenantId,
          clientId,
          clientNum,
          ip: clientIp,
          isLocked: Boolean(body.isLocked),
          activeUrl,
          thumbnail,
          vncPassword,
          remoteHost
        });

        const commandsForClient = await popCommandsForClient(db, tenantId, clientId);
        const activeWhitelist = await buildEffectiveWhitelist(db, tenantId);
        // Broadcast state lives in D1 -- organization-wide on the tenant row, per
        // workstation on its own row -- so every colo and every isolate hands this
        // workstation the same answer. The newer of the two wins; a winner with no
        // URL is a reset, and the workstation gets the portal.
        const organizationEpoch = Number(tenant.broadcast_epoch) || 0;
        const winner = ownBroadcast.broadcast_epoch > organizationEpoch
          ? { url: ownBroadcast.broadcast_url, epoch: ownBroadcast.broadcast_epoch }
          : { url: tenant.broadcast_url ?? null, epoch: organizationEpoch };
        const validatedBroadcastUrl = winner.url ? safeHttpUrl(winner.url) : null;
        const activeBroadcast = validatedBroadcastUrl
          ? { url: validatedBroadcastUrl, epoch: winner.epoch }
          : null;
        if (activeBroadcast) {
          const bHost = new URL(activeBroadcast.url).hostname.toLowerCase();
          if (bHost && !activeWhitelist.includes(bHost)) {
            activeWhitelist.push(bHost);
            activeWhitelist.sort();
          }
        }
        const portalUrl = portalUrlFor(tenant, request, url, env);
        const targetUrl = activeBroadcast?.url || portalUrl;
        // A "Reset to Portal" gets this workstation's portal, from this request.
        const commands = commandsForClient.map(({ portal, ...command }) =>
          portal ? { ...command, url: portalUrl } : command
        );

        return new Response(
          JSON.stringify({
            status: "ok",
            commands,
            whitelist: activeWhitelist,
            mode: tenant.mode,
            targetUrl,
            broadcastUrl: activeBroadcast?.url || "",
            broadcastEpoch: activeBroadcast?.epoch || 0
          }),
          { headers: jsonHeaders }
        );
      } catch (err: any) {
        console.error("[Worker] Telemetry ingest failed:", err);
        return jsonError("Telemetry payload could not be processed", 400, jsonHeaders);
      }
    }

    // GET /api/clients: Active client list for dashboard
    if (path === "/api/clients" && method === "GET") {
      const denied = await requireTenantPermission(db, session, currentTenant, "workstations", jsonHeaders);
      if (denied) return denied;

      const now = Math.floor(Date.now() / 1000);
      const cache = tenantTelemetryCache[currentTenant!.id] || {};
      const clientsWithStatus: Record<string, ClientTelemetry> = {};

      // D1 is the source of truth; the cache only supplies fresher frames for
      // workstations this particular isolate has recently heard from.
      for (const row of await listClientDevices(db, currentTenant!.id)) {
        clientsWithStatus[row.client_id] = {
          clientId: row.client_id,
          clientNum: row.client_num,
          activeUrl: row.active_url || currentTenant!.default_url || DEFAULT_CONFIG.defaultHomepage,
          isLocked: row.is_locked === 1,
          thumbnail: row.thumbnail || undefined,
          timestamp: row.last_seen,
          ip: row.ip || undefined,
          lastSeen: new Date(row.last_seen * 1000).toISOString(),
          online: now - row.last_seen < 12,
          vncPassword: row.vnc_password || undefined,
          remoteHost: row.remote_host || undefined,
          groupName: row.group_name || undefined
        };
      }

      for (const [id, cached] of Object.entries(cache)) {
        const existing = clientsWithStatus[id];
        if (!existing || cached.timestamp >= existing.timestamp) {
          clientsWithStatus[id] = { ...cached, groupName: existing?.groupName, online: now - cached.timestamp < 12 };
        }
      }

      return new Response(JSON.stringify({ clients: clientsWithStatus }), { headers: jsonHeaders });
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
        delete tenantTelemetryCache[tenantId]?.[clientId];
        await deleteClientDevice(db, tenantId, clientId);
        // Decommissioning must also invalidate the device's credentials, or the
        // workstation simply re-registers itself on its next heartbeat.
        await revokeDeviceTokensForClient(db, tenantId, clientId);
        await writeAuditLog(db, {
          tenantId,
          userId: session!.user_id,
          action: "device.remove",
          details: `client=${clientId}`
        });

        return new Response(
          JSON.stringify({
            status: "ok",
            remaining: Object.keys(tenantTelemetryCache[tenantId] || {}).length
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

        const cache = tenantTelemetryCache[currentTenant!.id] || {};
        for (const cid of clientIds) {
          if (cache[cid]) cache[cid].groupName = groupName || undefined;
        }

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

        const cache = tenantTelemetryCache[tenantId] || {};
        const isLock = action === "lock";
        const isUnlock = action === "unlock";

        // One statement for every target, not one round trip each.
        const cmdIds = await enqueueCommands(db, {
          tenantId,
          targets,
          action: action as any,
          url: commandUrl,
          epoch: commandEpoch,
          message: lockMsg,
          portal: toPortal
        });

        for (const target of targets) {
          if (isLock || isUnlock) {
            if (target === "all") {
              for (const c of Object.values(cache)) c.isLocked = isLock;
            } else if (cache[target]) {
              cache[target].isLocked = isLock;
            }
          }
        }

        await writeAuditLog(db, {
          tenantId,
          userId: session!.user_id,
          action: `command.${action}`,
          details: `targets=${targets.join(",")}${toPortal ? " url=portal" : commandUrl ? ` url=${commandUrl}` : ""}`
        });

        // Opportunistic housekeeping; command rows are short-lived by design.
        await purgeExpiredCommands(db);

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
      return new Response(renderPrivacyPolicyHtml(), { headers: htmlHeaders });
    }
    if (path === "/terms") {
      return new Response(renderTermsOfServiceHtml(), { headers: htmlHeaders });
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
            contactEmail: "contact@akbhoi.com",
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
            contactEmail: "contact@akbhoi.com",
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

      const hasAccess = checkPermission(activePage);

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
            contactEmail: "contact@akbhoi.com",
            nonce
          }),
          { status: 403, headers: htmlHeaders }
        );
      }

      const [portalSites, broadcastPresets, whitelist, staff, user, tenantUser, workstationGroups] = await Promise.all([
        listPortalSites(db, tenant.id),
        listBroadcastPresets(db, tenant.id),
        buildEffectiveWhitelist(db, tenant.id),
        listTenantUsers(db, tenant.id),
        findUserById(db, session.user_id),
        getTenantUser(db, tenant.id, session.user_id),
        listWorkstationGroups(db, tenant.id)
      ]);
      const userRole = session.role === "super_admin"
        ? "super_admin"
        : (tenant.user_id === session.user_id ? "org_admin" : (tenantUser?.role || "operator"));

      const config: LabConfig = {
        ...DEFAULT_CONFIG,
        // The hosted demo's tunnel belongs to web-demo only. Handed to anyone
        // else it sent their Remote Control -- VNC password included -- to
        // <pc>.demo.<domain>, a host in another organization's namespace.
        tunnelDomain: tenant.tunnel_domain || env.TUNNEL_DOMAIN ||
          (tenant.subdomain === "web-demo" && isDemoTenant(tenant, session.user_id) ? WEB_DEMO_TUNNEL_DOMAIN : ""),
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
          activePage,
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
          `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>Organization Not Found</title></head>
           <body style="background:#090d16;color:#f8fafc;font-family:sans-serif;text-align:center;padding:80px 20px;">
            <h1 style="font-size:36px;margin-bottom:12px;">Organization Subdomain Not Found</h1>
            <p style="color:#94a3b8;font-size:16px;">The requested subdomain <code>${escapeHtml(requested)}</code> is not registered.</p>
            <a href="${escapeHtml(url.origin)}/" style="display:inline-block;margin-top:24px;background:#3b82f6;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:600;">Back to Homepage</a>
          </body></html>`,
          { status: 404, headers: htmlHeaders }
        );
      }

      if (currentTenant.status !== "active") {
        const suspended = currentTenant.status === "suspended";
        return new Response(
          `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${suspended ? "Organization Suspended" : "Pending Approval"}</title></head>
           <body style="background:#090d16;color:#f8fafc;font-family:sans-serif;text-align:center;padding:80px 20px;">
            <h1 style="font-size:36px;margin-bottom:12px;color:#fbbf24;">${suspended ? "Organization Suspended" : "Subdomain Pending Approval"}</h1>
            <p style="color:#94a3b8;font-size:16px;">Organization <strong>${escapeHtml(currentTenant.name)}</strong> (<code>${escapeHtml(currentTenant.subdomain)}</code>) ${suspended ? "has been suspended by the platform super administrator." : "is awaiting activation by the platform super administrator."}</p>
            <a href="${escapeHtml(url.origin)}/" style="display:inline-block;margin-top:24px;background:#3b82f6;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:600;">Back to Homepage</a>
          </body></html>`,
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

      // The root is the organization's own page; the grid lives at /home.
      if (wantsOrganizationHome) {
        const portalPath = namedTenant
          ? `/home?tenant=${encodeURIComponent(currentTenant.subdomain)}`
          : "/home";
        return new Response(
          renderOrgHomeHtml({
            tenant: currentTenant,
            blocks: parseHomepageBlocks(currentTenant.homepage_blocks),
            portalPath
          }),
          { headers: htmlHeaders }
        );
      }

      const portalSites = await listPortalSites(db, currentTenant.id);
      return new Response(renderPortalHtml(currentTenant, portalSites, nonce), { headers: htmlHeaders });
    }

    // 3. Public SaaS Landing Page (Root domain)
    if (
      path === "/" ||
      path === "/login" ||
      path === "/register" ||
      path === "/download" ||
      path === "/iso" ||
      path === "/contact"
    ) {
      const openModal =
        path === "/register" || url.searchParams.has("register")
          ? "register"
          : path === "/login" || url.searchParams.has("login")
            ? "login"
            : path === "/download" || path === "/iso" || url.searchParams.has("download") || url.searchParams.has("iso")
              ? "iso"
              : path === "/contact" || url.searchParams.has("contact")
                ? "contact"
                : undefined;
      return new Response(
        renderLandingHtml({
          openModal,
          isoDownloadUrl: env.ISO_DOWNLOAD_URL,
          baseDomain,
          contactEmail: "contact@akbhoi.com",
          nonce
        }),
        { headers: htmlHeaders }
      );
    }

    return jsonError("Not Found", 404, jsonHeaders);
  }
};
