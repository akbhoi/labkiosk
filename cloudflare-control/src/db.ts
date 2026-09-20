/**
 * Cloudflare D1 Database Abstraction Layer
 * Handles schema initialization, Super Admin seeding, multi-tenant queries, and device state.
 */

import {
  User,
  Tenant,
  Session,
  PortalSite,
  ClientDevice,
  RemoteCommand,
  CommandAction,
  DeviceToken,
  AuditLogEntry,
  BroadcastPreset,
  TenantUser,
  TenantUserRole
} from "./types";
import {
  hashPassword,
  verifyPassword,
  sha256Hex,
  generateDeviceToken,
  generateEnrollmentKey
} from "./auth";

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  salt TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('super_admin', 'school_admin')),
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tenants (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  subdomain TEXT UNIQUE NOT NULL,
  requested_subdomain TEXT,
  status TEXT NOT NULL CHECK (status IN ('active', 'pending', 'rejected', 'suspended')),
  mode TEXT NOT NULL DEFAULT 'portal' CHECK (mode IN ('portal', 'single_url')),
  default_url TEXT NOT NULL DEFAULT 'https://www.khanacademy.org',
  admin_pin TEXT NOT NULL DEFAULT '1234',
  enrollment_key TEXT NOT NULL DEFAULT '',
  custom_domain TEXT UNIQUE,
  requested_custom_domain TEXT,
  custom_domain_status TEXT NOT NULL DEFAULT 'none',
  default_lock_message TEXT NOT NULL DEFAULT 'Screens locked by the instructor. Please look to the front.',
  portal_title TEXT,
  portal_subtitle TEXT,
  portal_description TEXT,
  portal_footer TEXT,
  broadcast_url TEXT,
  broadcast_epoch INTEGER NOT NULL DEFAULT 0,
  home_route TEXT DEFAULT '/',
  tunnel_domain TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id TEXT REFERENCES tenants(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS portal_sites (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  domain TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'General',
  icon TEXT,
  thumbnail_url TEXT,
  order_index INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS client_devices (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  client_num INTEGER NOT NULL DEFAULT 1,
  ip TEXT,
  last_seen INTEGER NOT NULL,
  is_locked INTEGER NOT NULL DEFAULT 0,
  active_url TEXT,
  thumbnail TEXT,
  vnc_password TEXT,
  remote_host TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS commands (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  target TEXT NOT NULL,
  action TEXT NOT NULL,
  payload_json TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT REFERENCES tenants(id) ON DELETE SET NULL,
  user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  details TEXT,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS device_tokens (
  id TEXT PRIMARY KEY,
  token_hash TEXT UNIQUE NOT NULL,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS tenant_whitelist (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE (tenant_id, domain)
);

CREATE TABLE IF NOT EXISTS command_deliveries (
  command_id TEXT NOT NULL,
  client_id TEXT NOT NULL,
  delivered_at INTEGER NOT NULL,
  PRIMARY KEY (command_id, client_id)
);

CREATE TABLE IF NOT EXISTS login_attempts (
  identifier TEXT PRIMARY KEY,
  failed_count INTEGER NOT NULL DEFAULT 0,
  last_failed_at INTEGER NOT NULL,
  locked_until INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS broadcast_presets (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  url TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ui_catalogs (
  tag TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  direction TEXT NOT NULL DEFAULT 'ltr',
  body TEXT NOT NULL,
  entry_count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  updated_by TEXT
);

CREATE TABLE IF NOT EXISTS tenant_users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'teacher' CHECK (role IN ('school_admin', 'sub_admin', 'teacher', 'lab_assistant', 'content_manager')),
  permissions TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  UNIQUE (tenant_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_tenants_subdomain ON tenants(subdomain);
CREATE INDEX IF NOT EXISTS idx_tenants_status ON tenants(status);
CREATE INDEX IF NOT EXISTS idx_tenants_custom_domain ON tenants(custom_domain);
CREATE INDEX IF NOT EXISTS idx_tenants_custom_domain_status ON tenants(custom_domain_status);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_portal_sites_tenant ON portal_sites(tenant_id, order_index);
CREATE INDEX IF NOT EXISTS idx_client_devices_tenant ON client_devices(tenant_id);
CREATE INDEX IF NOT EXISTS idx_commands_tenant_target ON commands(tenant_id, target, expires_at);
CREATE INDEX IF NOT EXISTS idx_device_tokens_tenant ON device_tokens(tenant_id, client_id);
CREATE INDEX IF NOT EXISTS idx_tenant_whitelist_tenant ON tenant_whitelist(tenant_id);
CREATE INDEX IF NOT EXISTS idx_command_deliveries_client ON command_deliveries(client_id, delivered_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant ON audit_logs(tenant_id, created_at);
CREATE INDEX IF NOT EXISTS idx_broadcast_presets_tenant ON broadcast_presets(tenant_id);
CREATE INDEX IF NOT EXISTS idx_ui_catalogs_updated ON ui_catalogs(updated_at);
CREATE INDEX IF NOT EXISTS idx_tenant_users_tenant ON tenant_users(tenant_id);
CREATE INDEX IF NOT EXISTS idx_tenant_users_user ON tenant_users(user_id);
`;

/**
 * Domains every new school starts with. Schools edit their own copy from the
 * dashboard; nothing here is shared mutable state between tenants.
 */
export const DEFAULT_WHITELIST_DOMAINS = [
  "khanacademy.org",
  "kastatic.org",
  "kasandbox.org",
  "scratch.mit.edu",
  "ck12.org",
  "geogebra.org",
  "phet.colorado.edu",
  "wikipedia.org",
  "wikimedia.org",
  "cbse.gov.in",
  "ncert.nic.in"
];

/**
 * Initializes database schema if not already present
 */
export async function initSchema(db: D1Database): Promise<void> {
  const stmts = SCHEMA_SQL
    .replace(/\r\n/g, "\n")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  for (const stmt of stmts) {
    try {
      await db.prepare(stmt).run();
    } catch (err: any) {
      // Ignore if table/index already exists, else log
      if (!err.message?.includes("already exists")) {
        console.warn("[DB] initSchema notice:", err.message || err);
      }
    }
  }
}

/** Credentials seeded when no secrets are configured; local development and tests only. */
export const LOCAL_DEV_SUPER_ADMIN = { email: "admin@akbhoi.com", password: "SuperAdmin2026!" };

/**
 * Ensures a Super Admin account exists in the database.
 *
 * `credentials` comes from the SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD secrets;
 * the caller (bootstrap in index.ts) decides whether falling back to
 * LOCAL_DEV_SUPER_ADMIN is acceptable, so this function never invents a default.
 * The stored password is only rewritten when a password was explicitly supplied,
 * so changing SUPER_ADMIN_EMAIL alone can no longer reset the account to a
 * well-known password.
 */
export async function ensureSuperAdmin(
  db: D1Database,
  credentials: { email: string; password: string }
): Promise<User> {
  const email = credentials.email.toLowerCase().trim();
  const existing = await db
    .prepare("SELECT * FROM users WHERE role = 'super_admin' LIMIT 1")
    .first<User>();

  if (existing) {
    const passwordMatches = await verifyPassword(
      credentials.password,
      existing.password_hash,
      existing.salt
    );
    // The database was initialised with a legacy placeholder, the configured email
    // changed, or the configured password does not match the stored hash: move
    // the account to the configured credentials and clear any lockout.
    if (existing.email === "admin@labkiosk.io" || existing.email !== email || !passwordMatches) {
      const { hashHex, saltHex } = await hashPassword(credentials.password);
      await db
        .prepare("UPDATE users SET email = ?, password_hash = ?, salt = ? WHERE id = ?")
        .bind(email, hashHex, saltHex, existing.id)
        .run();
      await clearLoginFailures(db, email);
      if (existing.email !== email) {
        await clearLoginFailures(db, existing.email);
      }
      return { ...existing, email, password_hash: hashHex, salt: saltHex };
    }
    return existing;
  }

  const { hashHex, saltHex } = await hashPassword(credentials.password);
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  await db
    .prepare(
      "INSERT INTO users (id, email, password_hash, salt, role, name, created_at) VALUES (?, ?, ?, ?, 'super_admin', 'Platform Super Administrator', ?)"
    )
    .bind(id, email, hashHex, saltHex, now)
    .run();

  return {
    id,
    email,
    password_hash: hashHex,
    salt: saltHex,
    role: "super_admin",
    name: "Platform Super Administrator",
    created_at: now
  };
}

/**
 * Confirms a bound D1 database carries the current schema. A production worker
 * must never create tables itself: on an un-migrated database that leaves a
 * shape later migrations cannot ALTER, so the worker refuses to serve instead.
 */
export async function assertSchemaCurrent(db: D1Database): Promise<void> {
  try {
    await db.prepare("SELECT broadcast_epoch FROM tenants LIMIT 1").run();
    await db.prepare("SELECT remote_host FROM client_devices LIMIT 1").run();
    await db.prepare("SELECT home_route FROM tenants LIMIT 1").run();
    await db.prepare("SELECT role FROM tenant_users LIMIT 1").run();
  } catch (err: any) {
    throw new Error(
      "The D1 database is missing the current schema. Run `wrangler d1 migrations apply labkiosk-db --remote` (or `--local` for `wrangler dev`) before starting the worker. " +
        `(${err?.message || err})`
    );
  }
}

/**
 * Ensures a default Demonstration School tenant exists for local dev and testing
 */
export async function ensureDefaultTenant(
  db: D1Database,
  superAdminId: string
): Promise<Tenant> {
  const existing = await db
    .prepare("SELECT * FROM tenants WHERE subdomain = 'demo' LIMIT 1")
    .first<Tenant>();

  if (existing) {
    if (!existing.tunnel_domain) {
      await updateTenant(db, existing.id, { tunnel_domain: "demo.labkiosk.akbhoi.com" });
      existing.tunnel_domain = "demo.labkiosk.akbhoi.com";
    }
    return existing;
  }

  const tenant = await createTenant(db, {
    userId: superAdminId,
    name: "Demonstration High School",
    subdomain: "demo",
    status: "active",
    mode: "portal",
    defaultUrl: "https://www.khanacademy.org"
  });

  await updateTenant(db, tenant.id, { tunnel_domain: "demo.labkiosk.akbhoi.com" });
  tenant.tunnel_domain = "demo.labkiosk.akbhoi.com";
  return tenant;
}

export async function findUserByEmail(db: D1Database, email: string): Promise<User | null> {
  return await db
    .prepare("SELECT * FROM users WHERE email = ?")
    .bind(email.toLowerCase())
    .first<User>();
}

export async function findUserById(db: D1Database, id: string): Promise<User | null> {
  return await db.prepare("SELECT * FROM users WHERE id = ?").bind(id).first<User>();
}

export async function createUser(
  db: D1Database,
  data: { email: string; password: string; name: string; role?: "super_admin" | "school_admin" }
): Promise<User> {
  const { hashHex, saltHex } = await hashPassword(data.password);
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const role = data.role || "school_admin";

  await db
    .prepare(
      "INSERT INTO users (id, email, password_hash, salt, role, name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(id, data.email.toLowerCase(), hashHex, saltHex, role, data.name, now)
    .run();

  return {
    id,
    email: data.email.toLowerCase(),
    password_hash: hashHex,
    salt: saltHex,
    role,
    name: data.name,
    created_at: now
  };
}

export async function findTenantBySubdomain(
  db: D1Database,
  subdomain: string
): Promise<Tenant | null> {
  return await db
    .prepare("SELECT * FROM tenants WHERE subdomain = ?")
    .bind(subdomain.toLowerCase())
    .first<Tenant>();
}

export async function findTenantByCustomDomain(
  db: D1Database,
  domain: string
): Promise<Tenant | null> {
  if (!domain) return null;
  return await db
    .prepare("SELECT * FROM tenants WHERE custom_domain = ?")
    .bind(domain.toLowerCase())
    .first<Tenant>();
}

export async function findTenantById(db: D1Database, id: string): Promise<Tenant | null> {
  return await db.prepare("SELECT * FROM tenants WHERE id = ?").bind(id).first<Tenant>();
}

export async function findTenantByUserId(db: D1Database, userId: string): Promise<Tenant | null> {
  const direct = await db.prepare("SELECT * FROM tenants WHERE user_id = ?").bind(userId).first<Tenant>();
  if (direct) return direct;
  return await db
    .prepare(
      `SELECT t.* FROM tenants t
       JOIN tenant_users tu ON tu.tenant_id = t.id
       WHERE tu.user_id = ?
       LIMIT 1`
    )
    .bind(userId)
    .first<Tenant>();
}

export async function createTenant(
  db: D1Database,
  data: {
    userId: string;
    name: string;
    subdomain: string;
    status?: "active" | "pending";
    mode?: "portal" | "single_url";
    defaultUrl?: string;
    defaultLockMessage?: string;
    portalTitle?: string | null;
    portalSubtitle?: string | null;
    portalDescription?: string | null;
    portalFooter?: string | null;
  }
): Promise<Tenant> {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const status = data.status || "pending";
  const mode = data.mode || "portal";
  const defaultUrl = data.defaultUrl || "https://www.khanacademy.org";
  const defaultLockMessage =
    data.defaultLockMessage || "Screens locked by the instructor. Please look to the front.";
  const enrollmentKey = generateEnrollmentKey();

  await db
    .prepare(
      `INSERT INTO tenants (id, user_id, name, subdomain, status, mode, default_url, admin_pin, enrollment_key, default_lock_message, portal_title, portal_subtitle, portal_description, portal_footer, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, '1234', ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      data.userId,
      data.name,
      data.subdomain.toLowerCase(),
      status,
      mode,
      defaultUrl,
      enrollmentKey,
      defaultLockMessage,
      data.portalTitle || null,
      data.portalSubtitle || null,
      data.portalDescription || null,
      data.portalFooter || null,
      now,
      now
    )
    .run();

  // Populate default educational portal cards and the school's own allowlist
  await seedDefaultPortalSites(db, id);
  await seedDefaultWhitelist(db, id);

  return {
    id,
    user_id: data.userId,
    name: data.name,
    subdomain: data.subdomain.toLowerCase(),
    status,
    mode,
    default_url: defaultUrl,
    admin_pin: "1234",
    enrollment_key: enrollmentKey,
    default_lock_message: defaultLockMessage,
    portal_title: data.portalTitle || null,
    portal_subtitle: data.portalSubtitle || null,
    portal_description: data.portalDescription || null,
    portal_footer: data.portalFooter || null,
    created_at: now,
    updated_at: now
  };
}

export async function seedDefaultPortalSites(db: D1Database, tenantId: string): Promise<void> {
  const defaults = [
    {
      title: "Khan Academy",
      url: "https://www.khanacademy.org",
      domain: "khanacademy.org",
      category: "Mathematics & Science",
      icon: "📘",
      thumbnail: "https://images.unsplash.com/photo-1509228468518-180dd4864904?w=600&q=80"
    },
    {
      title: "Scratch Studio",
      url: "https://scratch.mit.edu",
      domain: "scratch.mit.edu",
      category: "Coding & Creative",
      icon: "🐱",
      thumbnail: "https://images.unsplash.com/photo-1517694712202-14dd9538aa97?w=600&q=80"
    },
    {
      title: "CK-12 STEM",
      url: "https://india.ck12.org",
      domain: "ck12.org",
      category: "Science & Physics",
      icon: "🔬",
      thumbnail: "https://images.unsplash.com/photo-1532094349884-543bc11b234d?w=600&q=80"
    },
    {
      title: "GeoGebra Math",
      url: "https://www.geogebra.org/calculator",
      domain: "geogebra.org",
      category: "Geometry & 3D",
      icon: "📐",
      thumbnail: "https://images.unsplash.com/photo-1635070041078-e363dbe005cb?w=600&q=80"
    },
    {
      title: "PhET Simulations",
      url: "https://phet.colorado.edu/en/simulations/filter?type=html",
      domain: "colorado.edu",
      category: "Physics & Chemistry",
      icon: "⚛️",
      thumbnail: "https://images.unsplash.com/photo-1507413245164-6160d8298b31?w=600&q=80"
    },
    {
      title: "Wikipedia Simple",
      url: "https://simple.wikipedia.org",
      domain: "wikipedia.org",
      category: "Encyclopedia",
      icon: "🌐",
      thumbnail: "https://images.unsplash.com/photo-1457369804613-52c61a468e7d?w=600&q=80"
    }
  ];

  const now = Math.floor(Date.now() / 1000);
  for (let i = 0; i < defaults.length; i++) {
    const item = defaults[i];
    await db
      .prepare(
        `INSERT INTO portal_sites (id, tenant_id, title, url, domain, category, icon, thumbnail_url, order_index, is_active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
      )
      .bind(
        crypto.randomUUID(),
        tenantId,
        item.title,
        item.url,
        item.domain,
        item.category,
        item.icon,
        item.thumbnail,
        i,
        now
      )
      .run();
  }
}

/**
 * Columns a caller may change. Anything outside this set is rejected rather
 * than interpolated into the statement, so no caller can shape the SQL.
 */
const MUTABLE_TENANT_COLUMNS = new Set([
  "name",
  "subdomain",
  "requested_subdomain",
  "status",
  "mode",
  "default_url",
  "admin_pin",
  "enrollment_key",
  "custom_domain",
  "requested_custom_domain",
  "custom_domain_status",
  "default_lock_message",
  "portal_title",
  "portal_subtitle",
  "portal_description",
  "portal_footer",
  "broadcast_url",
  "broadcast_epoch",
  "home_route",
  "tunnel_domain"
]);

export async function updateTenant(
  db: D1Database,
  id: string,
  updates: Partial<Tenant>
): Promise<void> {
  const fields: string[] = [];
  const values: any[] = [];

  for (const [key, val] of Object.entries(updates)) {
    if (!MUTABLE_TENANT_COLUMNS.has(key)) {
      throw new Error(`Refusing to update unknown or protected tenant column: ${key}`);
    }
    fields.push(`${key} = ?`);
    values.push(val);
  }

  if (fields.length === 0) return;

  fields.push("updated_at = ?");
  values.push(Math.floor(Date.now() / 1000));
  values.push(id);

  await db
    .prepare(`UPDATE tenants SET ${fields.join(", ")} WHERE id = ?`)
    .bind(...values)
    .run();
}

/** Issue a fresh enrollment key, invalidating the previous one. */
export async function regenerateEnrollmentKey(db: D1Database, tenantId: string): Promise<string> {
  const key = generateEnrollmentKey();
  await updateTenant(db, tenantId, { enrollment_key: key });
  return key;
}

/** Find an active tenant by its enrollment key. */
export async function findTenantByEnrollmentKey(db: D1Database, key: string): Promise<Tenant | null> {
  const cleanKey = String(key || "").trim().toUpperCase();
  if (!cleanKey) return null;
  const row = await db.prepare("SELECT * FROM tenants WHERE enrollment_key = ? AND status = 'active' LIMIT 1")
    .bind(cleanKey)
    .first<Tenant>();
  return row || null;
}

/** Submit a custom domain request for superadmin review. */
export async function requestCustomDomain(
  db: D1Database,
  tenantId: string,
  domain: string
): Promise<void> {
  await updateTenant(db, tenantId, {
    requested_custom_domain: domain.toLowerCase().trim(),
    custom_domain_status: "pending"
  });
}

/** Approve and assign a custom domain to a school. */
export async function approveCustomDomain(
  db: D1Database,
  tenantId: string,
  domain?: string
): Promise<void> {
  const targetDomain = domain
    ? domain.toLowerCase().trim()
    : (await findTenantById(db, tenantId))?.requested_custom_domain;
  if (!targetDomain) throw new Error("No custom domain specified or requested");
  await updateTenant(db, tenantId, {
    custom_domain: targetDomain,
    requested_custom_domain: null,
    custom_domain_status: "approved"
  });
}

/** Reject a pending custom domain request. */
export async function rejectCustomDomain(db: D1Database, tenantId: string): Promise<void> {
  await updateTenant(db, tenantId, {
    requested_custom_domain: null,
    custom_domain_status: "rejected"
  });
}

/** Remove an active custom domain from a school. */
export async function removeCustomDomain(db: D1Database, tenantId: string): Promise<void> {
  await updateTenant(db, tenantId, {
    custom_domain: null,
    requested_custom_domain: null,
    custom_domain_status: "none"
  });
}

export async function listTenantUsers(db: D1Database, tenantId: string): Promise<TenantUser[]> {
  const res = await db
    .prepare(
      `SELECT tu.*, u.email, u.name
       FROM tenant_users tu
       JOIN users u ON tu.user_id = u.id
       WHERE tu.tenant_id = ?
       ORDER BY tu.created_at ASC`
    )
    .bind(tenantId)
    .all<any>();

  return (res.results || []).map((row) => ({
    id: row.id,
    tenant_id: row.tenant_id,
    user_id: row.user_id,
    role: row.role as TenantUserRole,
    permissions: typeof row.permissions === "string" ? JSON.parse(row.permissions) : (row.permissions || []),
    created_at: row.created_at,
    email: row.email,
    name: row.name
  }));
}

export async function createTenantUser(
  db: D1Database,
  data: {
    tenantId: string;
    email: string;
    name: string;
    password?: string;
    role?: TenantUserRole;
    permissions?: string[];
  }
): Promise<TenantUser> {
  const email = data.email.toLowerCase().trim();
  let user = await findUserByEmail(db, email);
  if (!user) {
    user = await createUser(db, {
      email,
      name: data.name.trim(),
      password: data.password || crypto.randomUUID().slice(0, 16) + "Aa1!",
      role: "school_admin"
    });
  }

  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const role: TenantUserRole = data.role || "teacher";
  const permissions = data.permissions || [];
  const permissionsJson = JSON.stringify(permissions);

  await db
    .prepare(
      `INSERT INTO tenant_users (id, tenant_id, user_id, role, permissions, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .bind(id, data.tenantId, user.id, role, permissionsJson, now)
    .run();

  return {
    id,
    tenant_id: data.tenantId,
    user_id: user.id,
    role,
    permissions,
    created_at: now,
    email: user.email,
    name: user.name
  };
}

export async function updateTenantUser(
  db: D1Database,
  tenantId: string,
  id: string,
  updates: { role?: TenantUserRole; permissions?: string[] }
): Promise<void> {
  const fields: string[] = [];
  const values: any[] = [];

  if (updates.role !== undefined) {
    fields.push("role = ?");
    values.push(updates.role);
  }
  if (updates.permissions !== undefined) {
    fields.push("permissions = ?");
    values.push(JSON.stringify(updates.permissions));
  }

  if (fields.length === 0) return;

  values.push(id);
  values.push(tenantId);

  await db
    .prepare(`UPDATE tenant_users SET ${fields.join(", ")} WHERE id = ? AND tenant_id = ?`)
    .bind(...values)
    .run();
}

export async function deleteTenantUser(db: D1Database, tenantId: string, id: string): Promise<void> {
  await db
    .prepare("DELETE FROM tenant_users WHERE id = ? AND tenant_id = ?")
    .bind(id, tenantId)
    .run();
}

export async function getTenantUser(
  db: D1Database,
  tenantId: string,
  userId: string
): Promise<TenantUser | null> {
  const row = await db
    .prepare(
      `SELECT tu.*, u.email, u.name
       FROM tenant_users tu
       JOIN users u ON tu.user_id = u.id
       WHERE tu.tenant_id = ? AND tu.user_id = ?
       LIMIT 1`
    )
    .bind(tenantId, userId)
    .first<any>();

  if (!row) return null;
  return {
    id: row.id,
    tenant_id: row.tenant_id,
    user_id: row.user_id,
    role: row.role as TenantUserRole,
    permissions: typeof row.permissions === "string" ? JSON.parse(row.permissions) : (row.permissions || []),
    created_at: row.created_at,
    email: row.email,
    name: row.name
  };
}

export async function getTenantUserPermissions(
  db: D1Database,
  tenantId: string,
  userId: string
): Promise<string[]> {
  const tenant = await findTenantById(db, tenantId);
  if (tenant && tenant.user_id === userId) {
    return ["*"];
  }

  const row = await db
    .prepare("SELECT role, permissions FROM tenant_users WHERE tenant_id = ? AND user_id = ? LIMIT 1")
    .bind(tenantId, userId)
    .first<{ role?: string; permissions: string }>();

  if (!row) return [];
  if (row.role === "school_admin") {
    return ["*"];
  }
  try {
    return typeof row.permissions === "string" ? JSON.parse(row.permissions) : (row.permissions || []);
  } catch {
    return [];
  }
}

export async function listAllTenants(
  db: D1Database
): Promise<Array<Tenant & { admin_email: string; admin_name: string; online_clients: number; total_clients: number }>> {
  const now = Math.floor(Date.now() / 1000);
  const res = await db
    .prepare(
      `SELECT t.*, u.email as admin_email, u.name as admin_name,
              (SELECT COUNT(*) FROM client_devices cd WHERE cd.tenant_id = t.id AND (? - cd.last_seen) < 15) as online_clients,
              (SELECT COUNT(*) FROM client_devices cd WHERE cd.tenant_id = t.id) as total_clients
       FROM tenants t
       JOIN users u ON t.user_id = u.id
       ORDER BY t.created_at DESC`
    )
    .bind(now)
    .all<Tenant & { admin_email: string; admin_name: string; online_clients: number; total_clients: number }>();

  return res.results || [];
}

export async function createSession(db: D1Database, session: Session): Promise<void> {
  await db
    .prepare(
      "INSERT INTO sessions (token, user_id, tenant_id, role, expires_at) VALUES (?, ?, ?, ?, ?)"
    )
    .bind(session.token, session.user_id, session.tenant_id || null, session.role, session.expires_at)
    .run();
}

/** Replace a user's password hash; every other session of that user should be dropped by the caller. */
export async function updateUserPassword(db: D1Database, userId: string, password: string): Promise<void> {
  const { hashHex, saltHex } = await hashPassword(password);
  await db
    .prepare("UPDATE users SET password_hash = ?, salt = ? WHERE id = ?")
    .bind(hashHex, saltHex, userId)
    .run();
}

/** Delete every session a user holds except, optionally, the one they are using right now. */
export async function deleteSessionsForUser(db: D1Database, userId: string, keepToken?: string): Promise<void> {
  if (keepToken) {
    await db
      .prepare("DELETE FROM sessions WHERE user_id = ? AND token != ?")
      .bind(userId, keepToken)
      .run();
    return;
  }
  await db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId).run();
}

export async function getSession(db: D1Database, token: string): Promise<Session | null> {
  const now = Math.floor(Date.now() / 1000);
  const session = await db
    .prepare("SELECT * FROM sessions WHERE token = ? AND expires_at > ?")
    .bind(token, now)
    .first<Session>();

  return session;
}

export async function deleteSession(db: D1Database, token: string): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
}

export async function listPortalSites(db: D1Database, tenantId: string): Promise<PortalSite[]> {
  const res = await db
    .prepare(
      "SELECT * FROM portal_sites WHERE tenant_id = ? AND is_active = 1 ORDER BY order_index ASC, created_at ASC"
    )
    .bind(tenantId)
    .all<PortalSite>();

  return res.results || [];
}

export async function createPortalSite(
  db: D1Database,
  data: {
    tenantId: string;
    title: string;
    url: string;
    category?: string;
    icon?: string;
    thumbnailUrl?: string;
  }
): Promise<PortalSite> {
  const id = crypto.randomUUID();
  let domain: string;
  try {
    domain = new URL(data.url).hostname.replace(/^www\./, "");
  } catch (err) {
    throw new Error(`Invalid application URL: ${data.url}`);
  }

  const now = Math.floor(Date.now() / 1000);
  const maxOrder = await db
    .prepare("SELECT MAX(order_index) as m FROM portal_sites WHERE tenant_id = ?")
    .bind(data.tenantId)
    .first<{ m: number | null }>();

  const orderIndex = (maxOrder?.m ?? -1) + 1;

  await db
    .prepare(
      `INSERT INTO portal_sites (id, tenant_id, title, url, domain, category, icon, thumbnail_url, order_index, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
    )
    .bind(
      id,
      data.tenantId,
      data.title,
      data.url,
      domain,
      data.category || "General",
      data.icon || "🌐",
      data.thumbnailUrl || null,
      orderIndex,
      now
    )
    .run();

  return {
    id,
    tenant_id: data.tenantId,
    title: data.title,
    url: data.url,
    domain,
    category: data.category || "General",
    icon: data.icon || "🌐",
    thumbnail_url: data.thumbnailUrl || null,
    order_index: orderIndex,
    is_active: 1,
    created_at: now
  };
}

export async function deletePortalSite(
  db: D1Database,
  id: string,
  tenantId: string
): Promise<void> {
  await db
    .prepare("DELETE FROM portal_sites WHERE id = ? AND tenant_id = ?")
    .bind(id, tenantId)
    .run();
}

export async function upsertClientDevice(
  db: D1Database,
  data: {
    tenantId: string;
    clientId: string;
    clientNum?: number;
    ip?: string;
    isLocked?: boolean;
    activeUrl?: string;
    thumbnail?: string;
    vncPassword?: string;
    remoteHost?: string;
  }
): Promise<void> {
  const compositeId = `${data.tenantId}:${data.clientId}`;
  const now = Math.floor(Date.now() / 1000);
  const isLockedVal = data.isLocked ? 1 : 0;
  const clientNum = data.clientNum || 1;

  await db
    .prepare(
      `INSERT INTO client_devices (id, tenant_id, client_id, client_num, ip, last_seen, is_locked, active_url, thumbnail, vnc_password, remote_host, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         client_num = excluded.client_num,
         ip = excluded.ip,
         last_seen = excluded.last_seen,
         is_locked = excluded.is_locked,
         active_url = excluded.active_url,
         thumbnail = COALESCE(excluded.thumbnail, client_devices.thumbnail),
         vnc_password = COALESCE(excluded.vnc_password, client_devices.vnc_password),
         remote_host = COALESCE(excluded.remote_host, client_devices.remote_host),
         updated_at = excluded.updated_at`
    )
    .bind(
      compositeId,
      data.tenantId,
      data.clientId,
      clientNum,
      data.ip || null,
      now,
      isLockedVal,
      data.activeUrl || null,
      data.thumbnail || null,
      data.vncPassword || null,
      data.remoteHost || null,
      now,
      now
    )
    .run();
}

export async function listClientDevices(
  db: D1Database,
  tenantId: string
): Promise<ClientDevice[]> {
  const res = await db
    .prepare("SELECT * FROM client_devices WHERE tenant_id = ? ORDER BY client_num ASC, client_id ASC")
    .bind(tenantId)
    .all<ClientDevice>();

  return res.results || [];
}

export async function deleteClientDevice(
  db: D1Database,
  tenantId: string,
  clientId: string
): Promise<void> {
  await db
    .prepare("DELETE FROM client_devices WHERE tenant_id = ? AND client_id = ?")
    .bind(tenantId, clientId)
    .run();
}

export async function enqueueCommand(
  db: D1Database,
  data: {
    tenantId: string;
    target: string;
    action: CommandAction;
    url?: string;
    message?: string;
    epoch?: number;
  }
): Promise<string> {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + 60; // 60s command TTL
  const payloadJson = JSON.stringify({ url: data.url, message: data.message, epoch: data.epoch });

  await db
    .prepare(
      `INSERT INTO commands (id, tenant_id, target, action, payload_json, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(id, data.tenantId, data.target, data.action, payloadJson, now, expiresAt)
    .run();

  return id;
}

/**
 * Drain the commands a workstation has not yet seen.
 *
 * Broadcast commands (`target: "all"`) stay queued until they expire so a client
 * that was offline at dispatch time still receives them, but a delivery receipt
 * per (command, client) guarantees each workstation executes one exactly once.
 * Previously every client re-ran a broadcast on all ~20 heartbeats within the
 * 60s TTL, so a single "Broadcast URL" spawned ~20 browser launches per PC.
 */
export async function popCommandsForClient(
  db: D1Database,
  tenantId: string,
  clientId: string
): Promise<RemoteCommand[]> {
  const now = Math.floor(Date.now() / 1000);
  const rows = await db
    .prepare(
      `SELECT c.* FROM commands c
       WHERE c.tenant_id = ?
         AND (c.target = 'all' OR c.target = ?)
         AND c.expires_at > ?
         AND NOT EXISTS (
           SELECT 1 FROM command_deliveries d
           WHERE d.command_id = c.id AND d.client_id = ?
         )
       ORDER BY c.created_at ASC`
    )
    .bind(tenantId, clientId, now, clientId)
    .all<any>();

  const commands: RemoteCommand[] = [];

  for (const row of rows.results || []) {
    let payload: { url?: string; message?: string } = {};
    if (row.payload_json) {
      try {
        payload = JSON.parse(row.payload_json);
      } catch (err) {
        console.warn(`[DB] Discarding malformed payload for command ${row.id}:`, err);
      }
    }

    commands.push({
      id: row.id,
      target: row.target,
      action: row.action as CommandAction,
      url: payload.url,
      message: payload.message,
      epoch: (payload as any).epoch,
      timestamp: row.created_at
    });

    await db
      .prepare(
        "INSERT OR IGNORE INTO command_deliveries (command_id, client_id, delivered_at) VALUES (?, ?, ?)"
      )
      .bind(row.id, clientId, now)
      .run();

    // A unicast command has exactly one recipient, so it can retire immediately.
    if (row.target === clientId) {
      await db.prepare("DELETE FROM commands WHERE id = ?").bind(row.id).run();
    }
  }

  return commands;
}

/** Remove expired commands and the delivery receipts that referenced them. */
export async function purgeExpiredCommands(db: D1Database): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      "DELETE FROM command_deliveries WHERE command_id IN (SELECT id FROM commands WHERE expires_at <= ?)"
    )
    .bind(now)
    .run();
  await db.prepare("DELETE FROM commands WHERE expires_at <= ?").bind(now).run();
}

// ============================================================
// DEVICE ENROLMENT & TOKENS
// ============================================================

/**
 * Enrol a workstation and mint its bearer token.
 * Only the SHA-256 of the token is stored, so a database read cannot be replayed
 * against the telemetry API. Re-enrolling a client id revokes the tokens
 * previously issued to that same workstation.
 */
export async function createDeviceToken(
  db: D1Database,
  data: { tenantId: string; clientId: string }
): Promise<{ token: string; device: DeviceToken }> {
  const token = generateDeviceToken();
  const tokenHash = await sha256Hex(token);
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  await revokeDeviceTokensForClient(db, data.tenantId, data.clientId);

  await db
    .prepare(
      `INSERT INTO device_tokens (id, token_hash, tenant_id, client_id, created_at, last_used_at, revoked)
       VALUES (?, ?, ?, ?, ?, ?, 0)`
    )
    .bind(id, tokenHash, data.tenantId, data.clientId, now, now)
    .run();

  return {
    token,
    device: {
      id,
      token_hash: tokenHash,
      tenant_id: data.tenantId,
      client_id: data.clientId,
      created_at: now,
      last_used_at: now,
      revoked: 0
    }
  };
}

export async function findDeviceByToken(db: D1Database, token: string): Promise<DeviceToken | null> {
  const tokenHash = await sha256Hex(token);
  return await db
    .prepare("SELECT * FROM device_tokens WHERE token_hash = ? AND revoked = 0")
    .bind(tokenHash)
    .first<DeviceToken>();
}

export async function touchDeviceToken(db: D1Database, id: string): Promise<void> {
  await db
    .prepare("UPDATE device_tokens SET last_used_at = ? WHERE id = ?")
    .bind(Math.floor(Date.now() / 1000), id)
    .run();
}

export async function revokeDeviceTokensForClient(
  db: D1Database,
  tenantId: string,
  clientId: string
): Promise<void> {
  await db
    .prepare("UPDATE device_tokens SET revoked = 1 WHERE tenant_id = ? AND client_id = ?")
    .bind(tenantId, clientId)
    .run();
}

// ============================================================
// PER-TENANT DOMAIN ALLOWLIST
// ============================================================

/** Strip scheme, credentials, path and port down to a bare hostname. */
export function normalizeDomain(raw: string): string {
  return String(raw || "")
    .toLowerCase()
    .trim()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/^[^@/]*@/, "")
    .split("/")[0]
    .split(":")[0]
    .replace(/[^a-z0-9.-]/g, "");
}

export async function seedDefaultWhitelist(db: D1Database, tenantId: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  for (const domain of DEFAULT_WHITELIST_DOMAINS) {
    await db
      .prepare(
        "INSERT OR IGNORE INTO tenant_whitelist (id, tenant_id, domain, created_at) VALUES (?, ?, ?, ?)"
      )
      .bind(crypto.randomUUID(), tenantId, domain, now)
      .run();
  }
}

export async function listWhitelistDomains(db: D1Database, tenantId: string): Promise<string[]> {
  const res = await db
    .prepare("SELECT domain FROM tenant_whitelist WHERE tenant_id = ? ORDER BY domain ASC")
    .bind(tenantId)
    .all<{ domain: string }>();
  return (res.results || []).map((r) => r.domain);
}

export async function addWhitelistDomain(
  db: D1Database,
  tenantId: string,
  rawDomain: string
): Promise<string> {
  const domain = normalizeDomain(rawDomain);
  if (!domain || !domain.includes(".")) {
    throw new Error(`Not a valid domain: ${rawDomain}`);
  }
  await db
    .prepare(
      "INSERT OR IGNORE INTO tenant_whitelist (id, tenant_id, domain, created_at) VALUES (?, ?, ?, ?)"
    )
    .bind(crypto.randomUUID(), tenantId, domain, Math.floor(Date.now() / 1000))
    .run();
  return domain;
}

export async function removeWhitelistDomain(
  db: D1Database,
  tenantId: string,
  rawDomain: string
): Promise<void> {
  await db
    .prepare("DELETE FROM tenant_whitelist WHERE tenant_id = ? AND domain = ?")
    .bind(tenantId, normalizeDomain(rawDomain))
    .run();
}

/**
 * The complete set of domains a workstation may reach: the school's own
 * allowlist plus the hostnames of every app card on its student portal, plus
 * any configured single-site lockdown domain, plus custom broadcast shortcuts.
 */
export async function buildEffectiveWhitelist(db: D1Database, tenantId: string): Promise<string[]> {
  const [domains, sites, presets, tenant] = await Promise.all([
    listWhitelistDomains(db, tenantId),
    listPortalSites(db, tenantId),
    listBroadcastPresets(db, tenantId),
    findTenantById(db, tenantId)
  ]);
  const set = new Set([...domains, ...sites.map((s) => s.domain)]);
  for (const preset of presets) {
    try {
      const parsed = new URL(preset.url);
      if (parsed.hostname) set.add(parsed.hostname.toLowerCase());
    } catch {
      // Ignored if invalid URL
    }
  }
  if (tenant?.default_url) {
    try {
      const parsed = new URL(tenant.default_url);
      if (parsed.hostname) set.add(parsed.hostname.toLowerCase());
    } catch {
      // Ignored if invalid URL
    }
  }
  if (tenant?.custom_domain) {
    set.add(tenant.custom_domain.toLowerCase());
  }
  return Array.from(set).sort();
}

// ============================================================
// BROADCAST SHORTCUT PRESETS
// ============================================================

/**
 * Interface catalogs.
 *
 * Platform assets rather than tenant data: the wizard and the kiosk bar say the
 * same thing to every school, so there is no tenant_id to scope by and nothing
 * tenant-specific may be stored here. Only a super admin writes them; every
 * workstation reads them, including before it is enrolled.
 */
export interface UiCatalogRow {
  tag: string;
  name: string;
  direction: string;
  body: string;
  entry_count: number;
  updated_at: number;
  updated_by: string | null;
}

export async function listUiCatalogs(db: D1Database): Promise<UiCatalogRow[]> {
  const { results } = await db
    .prepare("SELECT tag, name, direction, '' AS body, entry_count, updated_at, updated_by FROM ui_catalogs ORDER BY tag ASC")
    .all<UiCatalogRow>();
  return results || [];
}

export async function getUiCatalog(db: D1Database, tag: string): Promise<UiCatalogRow | null> {
  return await db
    .prepare("SELECT * FROM ui_catalogs WHERE tag = ?")
    .bind(tag)
    .first<UiCatalogRow>();
}

export async function putUiCatalog(
  db: D1Database,
  entry: { tag: string; name: string; direction: string; body: string; entryCount: number; updatedBy: string | null }
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO ui_catalogs (tag, name, direction, body, entry_count, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(tag) DO UPDATE SET
         name = excluded.name,
         direction = excluded.direction,
         body = excluded.body,
         entry_count = excluded.entry_count,
         updated_at = excluded.updated_at,
         updated_by = excluded.updated_by`
    )
    .bind(entry.tag, entry.name, entry.direction, entry.body, entry.entryCount, Math.floor(Date.now() / 1000), entry.updatedBy)
    .run();
}

export async function deleteUiCatalog(db: D1Database, tag: string): Promise<void> {
  await db.prepare("DELETE FROM ui_catalogs WHERE tag = ?").bind(tag).run();
}

export async function listBroadcastPresets(
  db: D1Database,
  tenantId: string
): Promise<BroadcastPreset[]> {
  const { results } = await db
    .prepare("SELECT * FROM broadcast_presets WHERE tenant_id = ? ORDER BY created_at ASC")
    .bind(tenantId)
    .all<BroadcastPreset>();
  return results || [];
}

export async function createBroadcastPreset(
  db: D1Database,
  data: { tenantId: string; title: string; url: string }
): Promise<BroadcastPreset> {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      "INSERT INTO broadcast_presets (id, tenant_id, title, url, created_at) VALUES (?, ?, ?, ?, ?)"
    )
    .bind(id, data.tenantId, data.title, data.url, now)
    .run();
  return {
    id,
    tenant_id: data.tenantId,
    title: data.title,
    url: data.url,
    created_at: now
  };
}

export async function deleteBroadcastPreset(
  db: D1Database,
  id: string,
  tenantId: string
): Promise<boolean> {
  const res = await db
    .prepare("DELETE FROM broadcast_presets WHERE id = ? AND tenant_id = ?")
    .bind(id, tenantId)
    .run();
  return (res.meta?.changes ?? 0) > 0;
}

// ============================================================
// AUDIT LOG
// ============================================================

export async function writeAuditLog(
  db: D1Database,
  entry: { tenantId?: string | null; userId?: string | null; action: string; details?: string }
): Promise<void> {
  try {
    await db
      .prepare(
        "INSERT INTO audit_logs (id, tenant_id, user_id, action, details, created_at) VALUES (?, ?, ?, ?, ?, ?)"
      )
      .bind(
        crypto.randomUUID(),
        entry.tenantId || null,
        entry.userId || null,
        entry.action,
        entry.details || null,
        Math.floor(Date.now() / 1000)
      )
      .run();
  } catch (err) {
    // Auditing must never break the operation it records, but a failure to
    // record is itself worth surfacing in the worker logs.
    console.error("[DB] Failed writing audit log:", err);
  }
}

export async function listAuditLogs(
  db: D1Database,
  tenantId: string,
  limit = 100
): Promise<AuditLogEntry[]> {
  const res = await db
    .prepare("SELECT * FROM audit_logs WHERE tenant_id = ? ORDER BY created_at DESC LIMIT ?")
    .bind(tenantId, Math.min(Math.max(limit, 1), 500))
    .all<AuditLogEntry>();
  return res.results || [];
}

// ============================================================
// LOGIN THROTTLING & SESSION HYGIENE
// ============================================================

const LOCKOUT_THRESHOLD = 5;
const LOCKOUT_BASE_SECONDS = 30;
const LOCKOUT_MAX_SECONDS = 15 * 60;

/** Seconds remaining before this identifier may attempt a login again. */
export async function getLockoutRemaining(db: D1Database, identifier: string): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const row = await db
    .prepare("SELECT locked_until FROM login_attempts WHERE identifier = ?")
    .bind(identifier)
    .first<{ locked_until: number }>();
  if (!row || row.locked_until <= now) return 0;
  return row.locked_until - now;
}

export async function recordLoginFailure(db: D1Database, identifier: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  const existing = await db
    .prepare("SELECT failed_count FROM login_attempts WHERE identifier = ?")
    .bind(identifier)
    .first<{ failed_count: number }>();

  const failed = (existing?.failed_count || 0) + 1;
  const over = Math.max(0, failed - LOCKOUT_THRESHOLD);
  const lockedUntil =
    over > 0 ? now + Math.min(LOCKOUT_BASE_SECONDS * 2 ** (over - 1), LOCKOUT_MAX_SECONDS) : 0;

  await db
    .prepare(
      `INSERT INTO login_attempts (identifier, failed_count, last_failed_at, locked_until)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(identifier) DO UPDATE SET
         failed_count = excluded.failed_count,
         last_failed_at = excluded.last_failed_at,
         locked_until = excluded.locked_until`
    )
    .bind(identifier, failed, now, lockedUntil)
    .run();
}

export async function clearLoginFailures(db: D1Database, identifier: string): Promise<void> {
  await db.prepare("DELETE FROM login_attempts WHERE identifier = ?").bind(identifier).run();
}

/**
 * Fixed-window rate limiting on top of `login_attempts`, keyed by the caller
 * (e.g. `register:<ip>`, `enroll:<ip>`). `rateLimitWait` reports how long a
 * caller has to wait (0 when allowed) without recording anything;
 * `recordRateLimitHit` counts one attempt against the key.
 */
export async function rateLimitWait(
  db: D1Database,
  key: string,
  limit: number,
  windowSeconds: number
): Promise<number> {
  const now = Math.floor(Date.now() / 1000);
  const row = await db
    .prepare("SELECT failed_count, last_failed_at FROM login_attempts WHERE identifier = ?")
    .bind(key)
    .first<{ failed_count: number; last_failed_at: number }>();
  if (!row || now - row.last_failed_at >= windowSeconds) return 0;
  if (row.failed_count < limit) return 0;
  return Math.max(1, row.last_failed_at + windowSeconds - now);
}

export async function recordRateLimitHit(db: D1Database, key: string, windowSeconds: number): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare(
      `INSERT INTO login_attempts (identifier, failed_count, last_failed_at, locked_until)
       VALUES (?1, 1, ?2, 0)
       ON CONFLICT(identifier) DO UPDATE SET
         failed_count = CASE WHEN ?2 - last_failed_at < ?3 THEN failed_count + 1 ELSE 1 END,
         last_failed_at = CASE WHEN ?2 - last_failed_at < ?3 THEN last_failed_at ELSE ?2 END`
    )
    .bind(key, now, windowSeconds)
    .run();
}

/** Drop throttle rows that can no longer affect anyone. */
export async function purgeStaleLoginAttempts(db: D1Database, olderThanSeconds = 24 * 3600): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  await db
    .prepare("DELETE FROM login_attempts WHERE locked_until <= ? AND last_failed_at <= ?")
    .bind(now, now - olderThanSeconds)
    .run();
}

/** Drop stale sessions so expired tokens do not accumulate indefinitely. */
export async function deleteExpiredSessions(db: D1Database, userId?: string): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  if (userId) {
    await db
      .prepare("DELETE FROM sessions WHERE user_id = ? AND expires_at <= ?")
      .bind(userId, now)
      .run();
    return;
  }
  await db.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(now).run();
}
