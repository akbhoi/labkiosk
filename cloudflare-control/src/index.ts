/**
 * Multi-Tenant Lab Kiosk Cloudflare Controller & API
 * Manages Super Admin, School Tenant Admins, Subdomain Routing, Student Portals, and PC Telemetry.
 */

import { Env, LabConfig, ClientTelemetry, RemoteCommand, UserRole, Tenant, PortalSite } from "./types";
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
  listPortalSites,
  createPortalSite,
  deletePortalSite,
  upsertClientDevice,
  listClientDevices,
  deleteClientDevice,
  enqueueCommand,
  popCommandsForClient
} from "./db";
import {
  verifyPassword,
  generateSessionToken,
  parseCookies,
  createSessionCookie,
  clearSessionCookie
} from "./auth";
import { createLocalD1Database } from "./d1_adapter";

// Fallback in-memory database for environments where env.DB is not bound
let localDbInstance: D1Database | null = null;
function getDatabase(env: Env): D1Database {
  if (env.DB) return env.DB;
  if (!localDbInstance) {
    localDbInstance = createLocalD1Database();
  }
  return localDbInstance;
}

// In-Memory Fast Cache for Active Telemetry and Commands (per tenant)
const tenantTelemetryCache: Record<string, Record<string, ClientTelemetry>> = {};

const DEFAULT_CONFIG: LabConfig = {
  version: 2,
  updatedAt: new Date().toISOString(),
  adminPin: "1234",
  totalClients: 40,
  defaultHomepage: "https://www.khanacademy.org",
  tunnelDomain: "lab.myschool.edu",
  whitelist: [
    "khanacademy.org",
    "scratch.mit.edu",
    "ck12.org",
    "geogebra.org",
    "phet.colorado.edu",
    "wikipedia.org",
    "cbse.gov.in",
    "ncert.nic.in"
  ],
  scheduledShutdown: "17:00"
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // 1. Database & Schema Initialization
    const db = getDatabase(env);
    await initSchema(db);
    const superAdmin = await ensureSuperAdmin(db, env.SUPER_ADMIN_EMAIL, env.SUPER_ADMIN_PASSWORD);
    const defaultTenant = await ensureDefaultTenant(db, superAdmin.id);

    // 2. CORS Handling
    const corsHeaders: Record<string, string> = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Tenant",
      "Content-Type": "application/json"
    };

    if (method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // 3. Extract Session and Identity
    const cookies = parseCookies(request.headers.get("cookie"));
    const authHeader = request.headers.get("authorization");
    const sessionToken =
      cookies["labkiosk_session"] ||
      (authHeader && authHeader.startsWith("Bearer ") ? authHeader.substring(7) : null);

    const session = sessionToken ? await getSession(db, sessionToken) : null;

    // 4. Resolve Tenant Subdomain
    const host = request.headers.get("host") || "localhost";
    const hostParts = host.split(":")[0].split(".");
    let targetSubdomain: string | null = null;

    // Check query parameter (?tenant=xyz) or header first (allows local dev & testing)
    if (url.searchParams.has("tenant")) {
      targetSubdomain = url.searchParams.get("tenant")!.toLowerCase().trim();
    } else if (request.headers.has("x-tenant")) {
      targetSubdomain = request.headers.get("x-tenant")!.toLowerCase().trim();
    } else if (hostParts.length > 2) {
      // Subdomain in hostname: e.g. greenwood.labkiosk.io
      const firstPart = hostParts[0].toLowerCase();
      if (firstPart !== "www" && firstPart !== "super") {
        targetSubdomain = firstPart;
      }
    }

    // Resolve tenant record if subdomain requested
    let currentTenant: Tenant | null = null;
    if (targetSubdomain) {
      currentTenant = await findTenantBySubdomain(db, targetSubdomain);
    } else if (session?.tenant_id) {
      currentTenant = await findTenantById(db, session.tenant_id);
    }

    // Default tenant fallback for API routes and local container telemetry
    if (!currentTenant && (path.startsWith("/api/telemetry") || path === "/api/status" || path === "/api/portal-sites" || path.startsWith("/api/clients"))) {
      currentTenant = defaultTenant;
    }

    // Initialize telemetry cache for tenant
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
          return new Response(JSON.stringify({ error: "All fields are required" }), {
            status: 400,
            headers: corsHeaders
          });
        }

        const cleanSubdomain = body.subdomain.toLowerCase().trim().replace(/[^a-z0-9\-]/g, "");
        if (cleanSubdomain.length < 3) {
          return new Response(
            JSON.stringify({ error: "Subdomain must be at least 3 characters (letters, numbers, hyphens)" }),
            { status: 400, headers: corsHeaders }
          );
        }

        // Check if email taken
        const existingUser = await findUserByEmail(db, body.email);
        if (existingUser) {
          return new Response(JSON.stringify({ error: "Email already registered. Please sign in." }), {
            status: 400,
            headers: corsHeaders
          });
        }

        // Check if subdomain taken
        const existingTenant = await findTenantBySubdomain(db, cleanSubdomain);
        if (existingTenant) {
          return new Response(JSON.stringify({ error: "Subdomain already claimed. Please pick another." }), {
            status: 400,
            headers: corsHeaders
          });
        }

        // Create User & Tenant
        const user = await createUser(db, {
          email: body.email,
          password: body.password,
          name: body.name,
          role: "school_admin"
        });

        // Note: New subdomains are active immediately for testing or pending approval
        const tenant = await createTenant(db, {
          userId: user.id,
          name: body.name,
          subdomain: cleanSubdomain,
          status: "active" // Default active for immediate classroom use
        });

        // Generate Session Token
        const token = generateSessionToken();
        const expiresAt = Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
        await createSession(db, {
          token,
          user_id: user.id,
          tenant_id: tenant.id,
          role: "school_admin",
          expires_at: expiresAt
        });

        return new Response(
          JSON.stringify({
            status: "ok",
            role: "school_admin",
            subdomain: tenant.subdomain
          }),
          {
            headers: {
              ...corsHeaders,
              "Set-Cookie": createSessionCookie(token)
            }
          }
        );
      } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
      }
    }

    // POST /api/auth/login: Teacher or Super Admin Sign In
    if (path === "/api/auth/login" && method === "POST") {
      try {
        const body = await request.json<{ email: string; password: string }>();
        if (!body.email || !body.password) {
          return new Response(JSON.stringify({ error: "Email and password required" }), {
            status: 400,
            headers: corsHeaders
          });
        }

        const user = await findUserByEmail(db, body.email);
        if (!user) {
          return new Response(JSON.stringify({ error: "Invalid email or password" }), {
            status: 401,
            headers: corsHeaders
          });
        }

        const isValid = await verifyPassword(body.password, user.password_hash, user.salt);
        if (!isValid) {
          return new Response(JSON.stringify({ error: "Invalid email or password" }), {
            status: 401,
            headers: corsHeaders
          });
        }

        let tenant: Tenant | null = null;
        if (user.role === "school_admin") {
          tenant = await findTenantByUserId(db, user.id);
        }

        const token = generateSessionToken();
        const expiresAt = Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
        await createSession(db, {
          token,
          user_id: user.id,
          tenant_id: tenant?.id || null,
          role: user.role,
          expires_at: expiresAt
        });

        return new Response(
          JSON.stringify({
            status: "ok",
            role: user.role,
            subdomain: tenant?.subdomain || null
          }),
          {
            headers: {
              ...corsHeaders,
              "Set-Cookie": createSessionCookie(token)
            }
          }
        );
      } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
      }
    }

    // GET /api/auth/logout: Sign Out
    if (path === "/api/auth/logout") {
      if (sessionToken) {
        await deleteSession(db, sessionToken);
      }
      return new Response(null, {
        status: 302,
        headers: {
          Location: "/",
          "Set-Cookie": clearSessionCookie()
        }
      });
    }

    // GET /api/auth/me: Identity Profile
    if (path === "/api/auth/me" && method === "GET") {
      if (!session) {
        return new Response(JSON.stringify({ user: null }), { headers: corsHeaders });
      }
      const user = await findUserById(db, session.user_id);
      return new Response(
        JSON.stringify({
          user: user ? { email: user.email, name: user.name, role: user.role } : null,
          tenant: currentTenant
        }),
        { headers: corsHeaders }
      );
    }

    // ==========================================
    // SUPER ADMIN API & MASTER CONSOLE
    // ==========================================

    if (path === "/super" || (hostParts[0] === "super" && path === "/")) {
      // Must be logged in as super_admin
      if (!session || session.role !== "super_admin") {
        return new Response(renderLandingHtml({ error: "Super Admin access required. Please sign in." }), {
          status: 401,
          headers: { "Content-Type": "text/html; charset=utf-8" }
        });
      }

      const allTenants = await listAllTenants(db);
      return new Response(
        renderSuperAdminHtml({
          superAdminEmail: (await findUserById(db, session.user_id))?.email || "admin@labkiosk.io",
          tenants: allTenants,
          baseDomain: env.DEFAULT_DOMAIN || "labkiosk.io"
        }),
        { headers: { "Content-Type": "text/html; charset=utf-8" } }
      );
    }

    // POST /api/super/tenants/approve: Approve or Assign Subdomain
    if (path === "/api/super/tenants/approve" && method === "POST") {
      if (!session || session.role !== "super_admin") {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 403, headers: corsHeaders });
      }
      try {
        const body = await request.json<{ tenantId: string; subdomain: string }>();
        const cleanSub = body.subdomain.toLowerCase().trim();

        // Check collision
        const existing = await findTenantBySubdomain(db, cleanSub);
        if (existing && existing.id !== body.tenantId) {
          return new Response(JSON.stringify({ error: "Subdomain already assigned to another school" }), {
            status: 400,
            headers: corsHeaders
          });
        }

        await updateTenant(db, body.tenantId, {
          subdomain: cleanSub,
          requested_subdomain: null,
          status: "active"
        });

        return new Response(JSON.stringify({ status: "ok" }), { headers: corsHeaders });
      } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
      }
    }

    // POST /api/super/tenants/reject: Reject Subdomain Request
    if (path === "/api/super/tenants/reject" && method === "POST") {
      if (!session || session.role !== "super_admin") {
        return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 403, headers: corsHeaders });
      }
      try {
        const body = await request.json<{ tenantId: string }>();
        await updateTenant(db, body.tenantId, {
          status: "rejected",
          requested_subdomain: null
        });
        return new Response(JSON.stringify({ status: "ok" }), { headers: corsHeaders });
      } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: corsHeaders });
      }
    }

    // ==========================================
    // PORTAL APPS & LAB SETTINGS API
    // ==========================================

    // GET /api/portal-sites: List apps for current school
    if (path === "/api/portal-sites" && method === "GET") {
      const tenantId = currentTenant ? currentTenant.id : "default";
      const sites = await listPortalSites(db, tenantId);
      return new Response(JSON.stringify({ sites }), { headers: corsHeaders });
    }

    // POST /api/portal-sites: Add new app card to student launcher
    if (path === "/api/portal-sites" && method === "POST") {
      try {
        const tenantId = currentTenant ? currentTenant.id : "default";
        const body = await request.json<{
          title: string;
          url: string;
          category?: string;
          icon?: string;
          thumbnailUrl?: string;
        }>();

        const site = await createPortalSite(db, {
          tenantId,
          title: body.title,
          url: body.url,
          category: body.category,
          icon: body.icon,
          thumbnailUrl: body.thumbnailUrl
        });

        return new Response(JSON.stringify({ status: "ok", site }), { headers: corsHeaders });
      } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message }), { status: 400, headers: corsHeaders });
      }
    }

    // DELETE /api/portal-sites/:id: Remove an app card
    if (path.startsWith("/api/portal-sites/") && method === "DELETE") {
      try {
        const id = path.replace("/api/portal-sites/", "");
        const tenantId = currentTenant ? currentTenant.id : "default";
        await deletePortalSite(db, id, tenantId);
        return new Response(JSON.stringify({ status: "ok" }), { headers: corsHeaders });
      } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message }), { status: 400, headers: corsHeaders });
      }
    }

    // POST /api/settings/subdomain: School requests new subdomain
    if (path === "/api/settings/subdomain" && method === "POST") {
      try {
        if (!currentTenant) {
          return new Response(JSON.stringify({ error: "No active tenant selected" }), {
            status: 400,
            headers: corsHeaders
          });
        }
        const body = await request.json<{ requestedSubdomain: string }>();
        const cleanSub = body.requestedSubdomain.toLowerCase().trim().replace(/[^a-z0-9\-]/g, "");

        const existing = await findTenantBySubdomain(db, cleanSub);
        if (existing && existing.id !== currentTenant.id) {
          return new Response(JSON.stringify({ error: "Subdomain already claimed" }), {
            status: 400,
            headers: corsHeaders
          });
        }

        await updateTenant(db, currentTenant.id, {
          requested_subdomain: cleanSub
        });

        return new Response(JSON.stringify({ status: "ok", requestedSubdomain: cleanSub }), {
          headers: corsHeaders
        });
      } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message }), { status: 400, headers: corsHeaders });
      }
    }

    // POST /api/settings/mode: Switch between 'portal' launcher and 'single_url'
    if (path === "/api/settings/mode" && method === "POST") {
      try {
        if (!currentTenant) {
          return new Response(JSON.stringify({ error: "No active tenant selected" }), {
            status: 400,
            headers: corsHeaders
          });
        }
        const body = await request.json<{ mode: "portal" | "single_url" }>();
        await updateTenant(db, currentTenant.id, { mode: body.mode });
        return new Response(JSON.stringify({ status: "ok", mode: body.mode }), { headers: corsHeaders });
      } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message }), { status: 400, headers: corsHeaders });
      }
    }

    // ==========================================
    // CLIENT TELEMETRY & COMMAND EXECUTION API
    // ==========================================

    // POST /api/telemetry: Ingest workstation status & thumbnail
    if (path === "/api/telemetry" && method === "POST") {
      try {
        const body = await request.json<Partial<ClientTelemetry>>();
        const clientId = body.clientId || "PC-01";
        const clientIp = request.headers.get("CF-Connecting-IP") || "127.0.0.1";
        const now = Math.floor(Date.now() / 1000);
        const tenantId = currentTenant ? currentTenant.id : "default";

        const record: ClientTelemetry = {
          clientId,
          clientNum: body.clientNum || 1,
          activeUrl: body.activeUrl || DEFAULT_CONFIG.defaultHomepage,
          isLocked: Boolean(body.isLocked),
          thumbnail: body.thumbnail,
          timestamp: now,
          ip: clientIp,
          lastSeen: new Date().toISOString(),
          online: true
        };

        // Cache in memory for instantaneous sub-second polling
        tenantTelemetryCache[tenantKey][clientId] = record;

        // Persist device status to D1
        await upsertClientDevice(db, {
          tenantId,
          clientId,
          clientNum: body.clientNum,
          ip: clientIp,
          isLocked: body.isLocked,
          activeUrl: body.activeUrl,
          thumbnail: body.thumbnail
        });

        // Drain pending commands for this workstation
        const commandsForClient = await popCommandsForClient(db, tenantId, clientId);

        // Fetch active portal sites to build dynamic whitelist for client agent
        const portalSites = await listPortalSites(db, tenantId);
        const activeWhitelist = Array.from(
          new Set([...DEFAULT_CONFIG.whitelist, ...portalSites.map((s) => s.domain)])
        );

        return new Response(
          JSON.stringify({
            status: "ok",
            commands: commandsForClient,
            whitelist: activeWhitelist,
            mode: currentTenant?.mode || "portal",
            targetUrl: currentTenant?.default_url || DEFAULT_CONFIG.defaultHomepage
          }),
          { headers: corsHeaders }
        );
      } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message }), { status: 400, headers: corsHeaders });
      }
    }

    // GET /api/clients: Active client list for dashboard
    if (path === "/api/clients" && method === "GET") {
      const now = Math.floor(Date.now() / 1000);
      const activeCache = tenantTelemetryCache[tenantKey] || {};
      const clientsWithStatus: Record<string, ClientTelemetry> = {};

      for (const [id, client] of Object.entries(activeCache)) {
        clientsWithStatus[id] = {
          ...client,
          online: now - client.timestamp < 12
        };
      }

      return new Response(JSON.stringify({ clients: clientsWithStatus }), { headers: corsHeaders });
    }

    // POST /api/clients/remove: Decommission a workstation
    if (path === "/api/clients/remove" && method === "POST") {
      try {
        const body = await request.json<{ clientId: string }>();
        const tenantId = currentTenant ? currentTenant.id : defaultTenant.id;

        if (body.clientId) {
          delete tenantTelemetryCache[tenantKey][body.clientId];
          await deleteClientDevice(db, tenantId, body.clientId);
        }
        return new Response(
          JSON.stringify({ status: "ok", remaining: Object.keys(tenantTelemetryCache[tenantKey]).length }),
          { headers: corsHeaders }
        );
      } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message }), { status: 400, headers: corsHeaders });
      }
    }

    // POST /api/command: Remote command dispatch
    if (path === "/api/command" && method === "POST") {
      try {
        const body = await request.json<{
          target: string;
          action: any;
          url?: string;
          message?: string;
        }>();

        if (!body.target || !body.action) {
          return new Response(JSON.stringify({ error: "Target and action required" }), {
            status: 400,
            headers: corsHeaders
          });
        }

        const tenantId = currentTenant ? currentTenant.id : defaultTenant.id;
        const cmdId = await enqueueCommand(db, {
          tenantId,
          target: body.target,
          action: body.action,
          url: body.url,
          message: body.message
        });

        // Fast memory state synchronization for locks
        if (body.action === "lock" || body.action === "unlock") {
          const isLock = body.action === "lock";
          const cache = tenantTelemetryCache[tenantKey];
          if (body.target === "all") {
            for (const c of Object.values(cache)) c.isLocked = isLock;
          } else if (cache[body.target]) {
            cache[body.target].isLocked = isLock;
          }
        }

        return new Response(JSON.stringify({ status: "ok", commandId: cmdId }), { headers: corsHeaders });
      } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message }), { status: 400, headers: corsHeaders });
      }
    }

    // GET & POST /api/whitelist: Allowed sites management
    if (path === "/api/whitelist" && method === "GET") {
      const tenantId = currentTenant ? currentTenant.id : "default";
      const portalSites = await listPortalSites(db, tenantId);
      const activeWhitelist = Array.from(
        new Set([...DEFAULT_CONFIG.whitelist, ...portalSites.map((s) => s.domain)])
      );
      return new Response(JSON.stringify({ whitelist: activeWhitelist }), { headers: corsHeaders });
    }

    if (path === "/api/whitelist" && method === "POST") {
      try {
        const body = await request.json<{ action: "add" | "remove"; domain: string }>();
        const domain = body.domain.toLowerCase().trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
        if (body.action === "add" && domain && !DEFAULT_CONFIG.whitelist.includes(domain)) {
          DEFAULT_CONFIG.whitelist.push(domain);
        } else if (body.action === "remove" && domain) {
          DEFAULT_CONFIG.whitelist = DEFAULT_CONFIG.whitelist.filter((d: string) => d !== domain);
        }
        return new Response(JSON.stringify({ status: "ok", whitelist: DEFAULT_CONFIG.whitelist }), {
          headers: corsHeaders
        });
      } catch (err: any) {
        return new Response(JSON.stringify({ error: err.message }), { status: 400, headers: corsHeaders });
      }
    }

    // GET /api/status: Lightweight connectivity check for first-boot PC setup wizard
    if (path === "/api/status") {
      return new Response(
        JSON.stringify({
          status: "ok",
          subdomain: currentTenant?.subdomain || targetSubdomain || "root",
          schoolName: currentTenant?.name || "Lab Kiosk Platform",
          mode: currentTenant?.mode || "portal",
          isActive: currentTenant ? currentTenant.status === "active" : true
        }),
        { headers: corsHeaders }
      );
    }

    // ==========================================
    // FRONTEND WEB UI ROUTING
    // ==========================================

    // 1. School Admin Dashboard (/admin)
    if (path === "/admin") {
      // If requested without tenant and user is logged in as school admin, redirect to their tenant
      if (!currentTenant && session && session.tenant_id) {
        const userTenant = await findTenantById(db, session.tenant_id);
        if (userTenant) {
          return Response.redirect(`${url.origin}/admin?tenant=${userTenant.subdomain}`, 302);
        }
      }

      // If user not authenticated, redirect to login on landing page
      if (!session) {
        const redirectParam = currentTenant ? `?login=1&tenant=${currentTenant.subdomain}` : "?login=1";
        return Response.redirect(`${url.origin}/${redirectParam}`, 302);
      }

      const tenantId = currentTenant ? currentTenant.id : "default";
      const portalSites = await listPortalSites(db, tenantId);
      const activeWhitelist = Array.from(
        new Set([...DEFAULT_CONFIG.whitelist, ...portalSites.map((s) => s.domain)])
      );

      const config: LabConfig = {
        ...DEFAULT_CONFIG,
        whitelist: activeWhitelist
      };

      return new Response(renderDashboardHtml(config, currentTenant || undefined, portalSites), {
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    }

    // 2. Student Learning Portal (Root or /portal when on school subdomain)
    if (targetSubdomain && (path === "/" || path === "/portal")) {
      if (!currentTenant) {
        return new Response(
          `<!DOCTYPE html><html><body style="background:#090d16;color:#f8fafc;font-family:sans-serif;text-align:center;padding:80px 20px;">
            <h1 style="font-size:36px;margin-bottom:12px;">School Subdomain Not Found</h1>
            <p style="color:#94a3b8;font-size:16px;">The requested subdomain <code>${targetSubdomain}</code> is not registered.</p>
            <a href="${url.origin}/" style="display:inline-block;margin-top:24px;background:#3b82f6;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:600;">Back to Homepage</a>
          </body></html>`,
          { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } }
        );
      }

      if (currentTenant.status !== "active") {
        return new Response(
          `<!DOCTYPE html><html><body style="background:#090d16;color:#f8fafc;font-family:sans-serif;text-align:center;padding:80px 20px;">
            <h1 style="font-size:36px;margin-bottom:12px;color:#fbbf24;">Subdomain Pending Approval</h1>
            <p style="color:#94a3b8;font-size:16px;">School <strong>${currentTenant.name}</strong> (<code>${currentTenant.subdomain}</code>) is awaiting activation by the platform super administrator.</p>
            <a href="${url.origin}/" style="display:inline-block;margin-top:24px;background:#3b82f6;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none;font-weight:600;">Back to Homepage</a>
          </body></html>`,
          { status: 403, headers: { "Content-Type": "text/html; charset=utf-8" } }
        );
      }

      // If tenant configured in direct single-site lockdown mode:
      if (currentTenant.mode === "single_url") {
        return Response.redirect(currentTenant.default_url, 302);
      }

      // Render Visual Student App Launcher Grid
      const portalSites = await listPortalSites(db, currentTenant.id);
      return new Response(renderPortalHtml(currentTenant, portalSites), {
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    }

    // 3. Public SaaS Landing Page (Root domain)
    if (path === "/" || path === "/login" || path === "/register") {
      return new Response(renderLandingHtml(), {
        headers: { "Content-Type": "text/html; charset=utf-8" }
      });
    }

    // 404 Not Found fallback
    return new Response(JSON.stringify({ error: "Not Found" }), { status: 404, headers: corsHeaders });
  }
};
