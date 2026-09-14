/**
 * Multi-Tenant Lab Kiosk Cloudflare Controller & API
 * Manages Super Admin, School Tenant Admins, Subdomain Routing, Student Portals, and PC Telemetry.
 *
 * Authorization rules live in `guard.ts` and output escaping in `escape.ts`.
 * No route in this file may resolve a tenant or render untrusted data without them.
 */

import { Env, LabConfig, ClientTelemetry, Tenant, User } from "./types";
import { renderDashboardHtml } from "./ui";
import { renderPortalHtml } from "./ui_portal";
import { renderSuperAdminHtml } from "./ui_super";
import { renderLandingHtml } from "./ui_landing";
import {
  initSchema,
  ensureSuperAdmin,
  ensureDefaultTenant,
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
  enqueueCommand,
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
  LOCAL_DEV_SUPER_ADMIN
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

/** Largest screen thumbnail a workstation may upload (base64 data URL). */
const MAX_THUMBNAIL_BYTES = 256 * 1024;

/** Commands a teacher console is allowed to dispatch. */
const ALLOWED_COMMANDS = new Set(["lock", "unlock", "navigate", "reload", "reboot", "shutdown", "mute"]);

/** Longest x11vnc password a workstation may report (x11vnc itself uses the first 8 characters). */
const MAX_VNC_PASSWORD_LENGTH = 64;

/** DNS label limit; a longer school slug can never resolve. */
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
type Bootstrapped = { superAdmin: User; defaultTenant: Tenant };
let bootstrapCache: { db: D1Database; promise: Promise<Bootstrapped> } | null = null;
function bootstrap(db: D1Database, env: Env): Promise<Bootstrapped> {
  // Memoized per database instance: a different binding is a different deployment.
  if (!bootstrapCache || bootstrapCache.db !== db) {
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
      const email = env.SUPER_ADMIN_EMAIL?.trim();
      const password = env.SUPER_ADMIN_PASSWORD;
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
      const defaultTenant = await ensureDefaultTenant(db, superAdmin.id);
      return { superAdmin, defaultTenant };
    })().catch((err) => {
      // Never cache a failed bootstrap, or the isolate stays broken forever.
      if (bootstrapCache?.promise === promise) bootstrapCache = null;
      throw err;
    });
    bootstrapCache = { db, promise };
  }
  return bootstrapCache.promise;
}

const DEFAULT_CONFIG: LabConfig = {
  version: 3,
  updatedAt: new Date().toISOString(),
  defaultHomepage: "https://labkiosk.akbhoi.com",
  tunnelDomain: "lab.myschool.edu",
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
 * The URL a workstation of this school should open.
 *
 * A workstation may reach the control plane on a host that is not its school's
 * own subdomain: the Docker simulator talks to `host.docker.internal`, and a
 * worker deployed to `*.workers.dev` has no school subdomain at all. Returning a
 * bare `${origin}/` in those cases lands the kiosk on the public landing page
 * instead of the school's portal, so the school is named explicitly whenever the
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

function portalUrlFor(tenant: Tenant, request: Request, url: URL, env: Env): string {
  const origin = effectiveOrigin(request, url);
  const named = `${origin}/?tenant=${encodeURIComponent(tenant.subdomain)}`;

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

  // Already on this school's own subdomain or custom domain: its root is the portal.
  if (
    hostSubdomain(request, env.DEFAULT_DOMAIN) === tenant.subdomain ||
    (tenant.custom_domain && hostname(request) === tenant.custom_domain.toLowerCase())
  ) {
    return `${url.origin}/`;
  }

  // If an active custom domain is configured, it is the canonical address for this school.
  if (tenant.custom_domain) {
    return `https://${tenant.custom_domain}/`;
  }

  // Talking to the production domain, so the school has a canonical address.
  if (env.DEFAULT_DOMAIN) {
    const base = env.DEFAULT_DOMAIN.replace(/^\./, "").toLowerCase();
    const host = hostname(request);
    if (host === base || host.endsWith("." + base)) {
      return `https://${tenant.subdomain}.${base}/`;
    }
  }

  // Reached on some other host (container gateway, workers.dev, a bare IP).
  return named;
}

/**
 * Routes that may name a tenant without a session, either because they are
 * public and read-only (the student portal, the wizard status probe) or because
 * they carry their own credential (`/api/telemetry` uses a device token, and
 * `/api/devices/enroll` proves possession of the enrollment key).
 */
function isPublicTenantRoute(path: string, method: string): boolean {
  if (path === "/" || path === "/portal" || path === "/api/status") return true;
  if (path === "/api/portal-sites" && method === "GET") return true;
  if (path === "/api/devices/enroll" || path === "/api/telemetry") return true;
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
    const { defaultTenant } = await bootstrap(db, env);

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

    // A caller who explicitly named a school they may not act on is refused
    // once, here, rather than falling through to a route-specific message.
    if (resolution.denied && path.startsWith("/api/")) {
      return jsonError("You do not have access to this school", 403, jsonHeaders);
    }

    const tenantKey = currentTenant ? currentTenant.id : defaultTenant.id;
    if (!tenantTelemetryCache[tenantKey]) {
      tenantTelemetryCache[tenantKey] = {};
    }

    // ==========================================
    // AUTHENTICATION API ENDPOINTS
    // ==========================================

    // POST /api/auth/register: School Admin Signup & Subdomain Claim
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
          return jsonError("School name is required", 400, jsonHeaders);
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
          role: "school_admin"
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
          role: "school_admin",
          expires_at: Math.floor(Date.now() / 1000) + 7 * 24 * 3600
        });

        await writeAuditLog(db, {
          tenantId: tenant.id,
          userId: user.id,
          action: "tenant.register",
          details: `subdomain=${tenant.subdomain}`
        });

        return new Response(
          JSON.stringify({ status: "ok", role: "school_admin", subdomain: tenant.subdomain }),
          { headers: { ...jsonHeaders, "Set-Cookie": sessionCookie(token) } }
        );
      } catch (err: any) {
        console.error("[Worker] Registration failed:", err);
        return jsonError("Registration failed. Please try again.", 500, jsonHeaders);
      }
    }

    // POST /api/auth/login: Teacher or Super Admin Sign In
    if (path === "/api/auth/login" && method === "POST") {
      try {
        const body = await request.json<{ email: string; password: string }>();
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

        const tenant = user.role === "school_admin" ? await findTenantByUserId(db, user.id) : null;
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
          JSON.stringify({ status: "ok", role: user.role, subdomain: tenant?.subdomain || null }),
          { headers: { ...jsonHeaders, "Set-Cookie": sessionCookie(token) } }
        );
      } catch (err: any) {
        console.error("[Worker] Login failed:", err);
        return jsonError("Sign-in failed. Please try again.", 500, jsonHeaders);
      }
    }

    // POST /api/auth/logout: Sign Out. GET is refused so a cross-site link or
    // image cannot sign a teacher out; the consoles submit a same-site form.
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
      return new Response(
        JSON.stringify({
          user: user ? { email: user.email, name: user.name, role: user.role } : null,
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

    if (path === "/super" || (hostname(request).split(".")[0] === "super" && path === "/")) {
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

      const allTenants = await listAllTenants(db);
      return new Response(
        renderSuperAdminHtml({
          superAdminEmail: (await findUserById(db, session.user_id))?.email || "admin@akbhoi.com",
          tenants: allTenants,
          baseDomain,
          nonce
        }),
        { headers: htmlHeaders }
      );
    }

    // POST /api/super/tenants/suspend | /reactivate: pause or resume a whole school.
    // A suspended school keeps its data and its console, but its portal, its
    // workstations' telemetry and new enrolments are refused until reactivated.
    if ((path === "/api/super/tenants/suspend" || path === "/api/super/tenants/reactivate") && method === "POST") {
      const denied = requireSuperAdmin(session, jsonHeaders);
      if (denied) return denied;
      const suspend = path.endsWith("/suspend");
      try {
        const body = await request.json<{ tenantId?: string }>();
        const target = body.tenantId ? await findTenantById(db, body.tenantId) : null;
        if (!target) return jsonError("School not found", 404, jsonHeaders);
        if (suspend && target.status !== "active") {
          return jsonError("Only an active school can be suspended", 400, jsonHeaders);
        }
        if (!suspend && target.status !== "suspended") {
          return jsonError("Only a suspended school can be reactivated", 400, jsonHeaders);
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
        return jsonError("Could not change this school's status", 400, jsonHeaders);
      }
    }

    // POST /api/super/tenants/approve: Approve or Assign Subdomain
    if (path === "/api/super/tenants/approve" && method === "POST") {
      const denied = requireSuperAdmin(session, jsonHeaders);
      if (denied) return denied;
      try {
        const body = await request.json<{ tenantId: string; subdomain: string }>();
        const cleanSub = cleanSubdomain(body.subdomain);
        if (cleanSub.length < 3 || cleanSub.length > MAX_SUBDOMAIN_LENGTH || isReservedSlug(cleanSub)) {
          return jsonError(`Subdomain must be 3-${MAX_SUBDOMAIN_LENGTH} characters (letters, numbers, hyphens) and not a reserved name`, 400, jsonHeaders);
        }

        const existing = await findTenantBySubdomain(db, cleanSub);
        if (existing && existing.id !== body.tenantId) {
          return jsonError("Subdomain already assigned to another school", 400, jsonHeaders);
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
        if (!targetTenant) return jsonError("School not found", 404, jsonHeaders);

        const domain = cleanCustomDomain(body.customDomain || targetTenant.requested_custom_domain);
        if (!domain) {
          return jsonError("Valid domain name required (e.g. kiosk.myschool.edu)", 400, jsonHeaders);
        }

        const existing = await findTenantByCustomDomain(db, domain);
        if (existing && existing.id !== targetTenant.id) {
          return jsonError("This domain is already assigned to another school", 400, jsonHeaders);
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
        if (!targetTenant) return jsonError("School not found", 404, jsonHeaders);

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
        if (!targetTenant) return jsonError("School not found", 404, jsonHeaders);

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
    // PORTAL APPS & LAB SETTINGS API
    // ==========================================

    // GET /api/portal-sites: public -- student kiosks render this without a session
    if (path === "/api/portal-sites" && method === "GET") {
      if (!currentTenant) {
        return jsonError("School not found", 404, jsonHeaders);
      }
      const sites = await listPortalSites(db, currentTenant.id);
      return new Response(JSON.stringify({ sites }), { headers: jsonHeaders });
    }

    // POST /api/portal-sites: Add new app card to student launcher
    if (path === "/api/portal-sites" && method === "POST") {
      const denied = requireTenantAdmin(session, currentTenant, jsonHeaders);
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
      const denied = requireTenantAdmin(session, currentTenant, jsonHeaders);
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
      const denied = requireTenantAdmin(session, currentTenant, jsonHeaders);
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
      const denied = requireTenantAdmin(session, currentTenant, jsonHeaders);
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

    // POST /api/settings/subdomain: School requests new subdomain
    if (path === "/api/settings/subdomain" && method === "POST") {
      const denied = requireTenantAdmin(session, currentTenant, jsonHeaders);
      if (denied) return denied;
      try {
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
      const denied = requireTenantAdmin(session, currentTenant, jsonHeaders);
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
      const denied = requireTenantAdmin(session, currentTenant, jsonHeaders);
      if (denied) return denied;
      return new Response(
        JSON.stringify({
          status: "ok",
          name: currentTenant!.name,
          mode: currentTenant!.mode,
          defaultUrl: currentTenant!.default_url,
          defaultLockMessage:
            currentTenant!.default_lock_message ||
            "Screens locked by the instructor. Please look to the front.",
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
      const denied = requireTenantAdmin(session, currentTenant, jsonHeaders);
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
          updates.default_lock_message = trimmedMsg || "Screens locked by the instructor. Please look to the front.";
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
      const denied = requireTenantAdmin(session, currentTenant, jsonHeaders);
      if (denied) return denied;
      return new Response(
        JSON.stringify({ enrollmentKey: currentTenant!.enrollment_key, subdomain: currentTenant!.subdomain }),
        { headers: jsonHeaders }
      );
    }

    // POST /api/settings/enrollment-key: rotate it (previously enrolled devices keep working)
    if (path === "/api/settings/enrollment-key" && method === "POST") {
      const denied = requireTenantAdmin(session, currentTenant, jsonHeaders);
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
      const denied = requireTenantAdmin(session, currentTenant, jsonHeaders);
      if (denied) return denied;
      try {
        const body = await request.json<{ domain: string }>();
        const domain = cleanCustomDomain(body.domain);
        if (!domain) {
          return jsonError("Please enter a valid domain name (e.g. kiosk.myschool.edu)", 400, jsonHeaders);
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
          return jsonError("This domain is already assigned to another school", 400, jsonHeaders);
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
      const denied = requireTenantAdmin(session, currentTenant, jsonHeaders);
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

    // GET /api/audit-logs: recent activity for this school
    if (path === "/api/audit-logs" && method === "GET") {
      const denied = requireTenantAdmin(session, currentTenant, jsonHeaders);
      if (denied) return denied;
      const limit = Number(url.searchParams.get("limit") || 100);
      const logs = await listAuditLogs(db, currentTenant!.id, Number.isFinite(limit) ? limit : 100);
      return new Response(JSON.stringify({ logs }), { headers: jsonHeaders });
    }

    // ==========================================
    // DEVICE ENROLMENT
    // ==========================================

    // POST /api/devices/enroll: exchange the school enrollment key for a device token
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

        // A wrong school and a wrong key are reported identically so the endpoint
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
          return jsonError("School subdomain or enrollment key is not correct", 401, jsonHeaders);
        }

        if (tenant.status !== "active") {
          return jsonError("This school is not active yet. Ask your administrator to approve it.", 403, jsonHeaders);
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
        return jsonError("This school is not active", 403, jsonHeaders);
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

        await upsertClientDevice(db, {
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
        // The active broadcast lives on the tenant row, so every colo and every
        // isolate hands this workstation the same answer.
        const validatedBroadcastUrl = tenant.broadcast_url ? safeHttpUrl(tenant.broadcast_url) : null;
        const activeBroadcast = validatedBroadcastUrl
          ? { url: validatedBroadcastUrl, epoch: Number(tenant.broadcast_epoch) || 0 }
          : null;
        if (activeBroadcast) {
          const bHost = new URL(activeBroadcast.url).hostname.toLowerCase();
          if (bHost && !activeWhitelist.includes(bHost)) {
            activeWhitelist.push(bHost);
            activeWhitelist.sort();
          }
        }
        const targetUrl = activeBroadcast?.url || portalUrlFor(tenant, request, url, env);

        return new Response(
          JSON.stringify({
            status: "ok",
            commands: commandsForClient,
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
      const denied = requireTenantAdmin(session, currentTenant, jsonHeaders);
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
          remoteHost: row.remote_host || undefined
        };
      }

      for (const [id, cached] of Object.entries(cache)) {
        const existing = clientsWithStatus[id];
        if (!existing || cached.timestamp >= existing.timestamp) {
          clientsWithStatus[id] = { ...cached, online: now - cached.timestamp < 12 };
        }
      }

      return new Response(JSON.stringify({ clients: clientsWithStatus }), { headers: jsonHeaders });
    }

    // POST /api/clients/remove: Decommission a workstation
    if (path === "/api/clients/remove" && method === "POST") {
      const denied = requireTenantAdmin(session, currentTenant, jsonHeaders);
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

    // POST /api/command: Remote command dispatch
    if (path === "/api/command" && method === "POST") {
      const denied = requireTenantAdmin(session, currentTenant, jsonHeaders);
      if (denied) return denied;
      try {
        const body = await request.json<{
          target: string;
          action: string;
          url?: string;
          message?: string;
        }>();

        const target = String(body.target || "").trim();
        const action = String(body.action || "").trim();
        if (!target || !action) {
          return jsonError("Target and action required", 400, jsonHeaders);
        }
        if (!ALLOWED_COMMANDS.has(action)) {
          return jsonError(`Unsupported action: ${action}`, 400, jsonHeaders);
        }

        let commandUrl: string | undefined;
        let commandEpoch: number | undefined;
        if (action === "navigate") {
          const isReset = Boolean((body as any).resetPortal);
          const portalUrl = portalUrlFor(currentTenant!, request, url, env);

          if (isReset) {
            commandUrl = portalUrl;
            commandEpoch = Date.now();
            await updateTenant(db, currentTenant!.id, { broadcast_url: null, broadcast_epoch: 0 });
          } else {
            const validated = safeHttpUrl(body.url);
            if (!validated) {
              return jsonError("Navigate requires a valid http(s) URL", 400, jsonHeaders);
            }
            commandUrl = validated;
            commandEpoch = Date.now();

            if (commandUrl === portalUrl) {
              await updateTenant(db, currentTenant!.id, { broadcast_url: null, broadcast_epoch: 0 });
            } else if (target === "all") {
              await updateTenant(db, currentTenant!.id, { broadcast_url: commandUrl, broadcast_epoch: commandEpoch });
            }
          }
        }

        const tenantId = currentTenant!.id;
        const lockMsg = body.message
          ? String(body.message).slice(0, 280)
          : action === "lock"
          ? (currentTenant!.default_lock_message || "Screens locked by the instructor. Please look to the front.")
          : undefined;

        const cmdId = await enqueueCommand(db, {
          tenantId,
          target,
          action: action as any,
          url: commandUrl,
          epoch: commandEpoch,
          message: lockMsg
        });

        // Reflect lock state immediately so the console does not wait a heartbeat.
        if (action === "lock" || action === "unlock") {
          const isLock = action === "lock";
          const cache = tenantTelemetryCache[tenantId] || {};
          if (target === "all") {
            for (const c of Object.values(cache)) c.isLocked = isLock;
          } else if (cache[target]) {
            cache[target].isLocked = isLock;
          }
        }

        await writeAuditLog(db, {
          tenantId,
          userId: session!.user_id,
          action: `command.${action}`,
          details: `target=${target}${commandUrl ? ` url=${commandUrl}` : ""}`
        });

        // Opportunistic housekeeping; command rows are short-lived by design.
        await purgeExpiredCommands(db);

        return new Response(JSON.stringify({ status: "ok", commandId: cmdId }), { headers: jsonHeaders });
      } catch (err: any) {
        console.error("[Worker] Command dispatch failed:", err);
        return jsonError("Could not dispatch this command", 400, jsonHeaders);
      }
    }

    // GET & POST /api/whitelist: Allowed sites management (per school, persisted)
    if (path === "/api/whitelist" && method === "GET") {
      const denied = requireTenantAdmin(session, currentTenant, jsonHeaders);
      if (denied) return denied;
      return new Response(
        JSON.stringify({ whitelist: await buildEffectiveWhitelist(db, currentTenant!.id) }),
        { headers: jsonHeaders }
      );
    }

    if (path === "/api/whitelist" && method === "POST") {
      const denied = requireTenantAdmin(session, currentTenant, jsonHeaders);
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
    // school subdomain exists and is active.
    if (path === "/api/status") {
      return new Response(
        JSON.stringify({
          status: "ok",
          subdomain:
            currentTenant?.subdomain ||
            hostSubdomain(request, env.DEFAULT_DOMAIN) ||
            cleanSubdomain(url.searchParams.get("tenant") || "") ||
            "root",
          schoolName: currentTenant?.name || "Lab Kiosk Platform",
          mode: currentTenant?.mode || "portal",
          isActive: currentTenant ? currentTenant.status === "active" : true
        }),
        { headers: { ...jsonHeaders, "Access-Control-Allow-Origin": "*" } }
      );
    }

    // ==========================================
    // FRONTEND WEB UI ROUTING
    // ==========================================

    // 1. School Admin Dashboard (/admin)
    if (path === "/admin") {
      if (!session) {
        const suffix = url.searchParams.has("tenant")
          ? `?login=1&tenant=${encodeURIComponent(cleanSubdomain(url.searchParams.get("tenant")))}`
          : "?login=1";
        return Response.redirect(`${url.origin}/${suffix}`, 302);
      }

      // A teacher who explicitly named another school is refused, not silently
      // bounced to their own console.
      if (resolution.denied) {
        return new Response(
          renderLandingHtml({
            error: "You do not have access to that school's console.",
            openModal: "login",
            isoDownloadUrl: env.ISO_DOWNLOAD_URL,
            baseDomain,
            contactEmail: "contact@akbhoi.com",
            nonce
          }),
          { status: 403, headers: htmlHeaders }
        );
      }

      // Land a school admin on their own console when none was named.
      if (!currentTenant && session.tenant_id) {
        const userTenant = await findTenantById(db, session.tenant_id);
        if (userTenant) {
          return Response.redirect(
            `${url.origin}/admin?tenant=${encodeURIComponent(userTenant.subdomain)}`,
            302
          );
        }
      }

      const denied = requireTenantAdmin(session, currentTenant, jsonHeaders);
      if (denied) {
        return new Response(
          renderLandingHtml({
            error: "You do not have access to that school's console.",
            openModal: "login",
            isoDownloadUrl: env.ISO_DOWNLOAD_URL,
            baseDomain,
            contactEmail: "contact@akbhoi.com",
            nonce
          }),
          { status: denied.status, headers: htmlHeaders }
        );
      }

      const tenant = currentTenant!;
      const [portalSites, broadcastPresets, whitelist] = await Promise.all([
        listPortalSites(db, tenant.id),
        listBroadcastPresets(db, tenant.id),
        buildEffectiveWhitelist(db, tenant.id)
      ]);
      const config: LabConfig = {
        ...DEFAULT_CONFIG,
        tunnelDomain: env.TUNNEL_DOMAIN || DEFAULT_CONFIG.tunnelDomain,
        defaultHomepage: env.DEFAULT_HOMEPAGE || DEFAULT_CONFIG.defaultHomepage,
        whitelist
      };

      return new Response(
        renderDashboardHtml({
          config,
          tenant,
          sites: portalSites,
          baseDomain,
          presets: broadcastPresets,
          nonce
        }),
        { headers: htmlHeaders }
      );
    }

    // 2. Student Learning Portal (root of a school subdomain)
    const wantsPortal = path === "/" || path === "/portal";
    const namedTenant = url.searchParams.has("tenant") || request.headers.has("x-tenant");
    const onSubdomain = hostSubdomain(request, env.DEFAULT_DOMAIN) !== null;

    if (wantsPortal && (namedTenant || onSubdomain)) {
      if (!currentTenant) {
        const requested = cleanSubdomain(url.searchParams.get("tenant") ?? hostSubdomain(request, env.DEFAULT_DOMAIN) ?? "");
        return new Response(
          `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>School Not Found</title></head>
           <body style="background:#090d16;color:#f8fafc;font-family:sans-serif;text-align:center;padding:80px 20px;">
            <h1 style="font-size:36px;margin-bottom:12px;">School Subdomain Not Found</h1>
            <p style="color:#94a3b8;font-size:16px;">The requested subdomain <code>${escapeHtml(requested)}</code> is not registered.</p>
            <a href="${escapeHtml(url.origin)}/" style="display:inline-block;margin-top:24px;background:#3b82f6;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:600;">Back to Homepage</a>
          </body></html>`,
          { status: 404, headers: htmlHeaders }
        );
      }

      if (currentTenant.status !== "active") {
        const suspended = currentTenant.status === "suspended";
        return new Response(
          `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${suspended ? "School Suspended" : "Pending Approval"}</title></head>
           <body style="background:#090d16;color:#f8fafc;font-family:sans-serif;text-align:center;padding:80px 20px;">
            <h1 style="font-size:36px;margin-bottom:12px;color:#fbbf24;">${suspended ? "School Suspended" : "Subdomain Pending Approval"}</h1>
            <p style="color:#94a3b8;font-size:16px;">School <strong>${escapeHtml(currentTenant.name)}</strong> (<code>${escapeHtml(currentTenant.subdomain)}</code>) ${suspended ? "has been suspended by the platform super administrator." : "is awaiting activation by the platform super administrator."}</p>
            <a href="${escapeHtml(url.origin)}/" style="display:inline-block;margin-top:24px;background:#3b82f6;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:600;">Back to Homepage</a>
          </body></html>`,
          { status: 403, headers: htmlHeaders }
        );
      }

      if (currentTenant.mode === "single_url") {
        const target = safeHttpUrl(currentTenant.default_url);
        if (target) return Response.redirect(target, 302);
        console.warn(`[Worker] Tenant ${currentTenant.subdomain} has an invalid default_url; showing the portal instead.`);
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
