/**
 * Cloudflare D1 Database Abstraction Layer
 * Handles schema initialization, Super Admin seeding, multi-tenant queries, and device state.
 */

import { User, Tenant, Session, PortalSite, ClientDevice, RemoteCommand, CommandAction } from "./types";
import { hashPassword } from "./auth";

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

CREATE INDEX IF NOT EXISTS idx_tenants_subdomain ON tenants(subdomain);
CREATE INDEX IF NOT EXISTS idx_tenants_status ON tenants(status);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
CREATE INDEX IF NOT EXISTS idx_portal_sites_tenant ON portal_sites(tenant_id, order_index);
CREATE INDEX IF NOT EXISTS idx_client_devices_tenant ON client_devices(tenant_id);
CREATE INDEX IF NOT EXISTS idx_commands_tenant_target ON commands(tenant_id, target, expires_at);
`;

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

/**
 * Ensures a Super Admin account exists in the database
 */
export async function ensureSuperAdmin(
  db: D1Database,
  email: string = "admin@labkiosk.io",
  password: string = "SuperAdmin2026!"
): Promise<User> {
  const existing = await db
    .prepare("SELECT * FROM users WHERE role = 'super_admin' LIMIT 1")
    .first<User>();

  if (existing) return existing;

  const { hashHex, saltHex } = await hashPassword(password);
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);

  await db
    .prepare(
      "INSERT INTO users (id, email, password_hash, salt, role, name, created_at) VALUES (?, ?, ?, ?, 'super_admin', 'Platform Super Administrator', ?)"
    )
    .bind(id, email.toLowerCase(), hashHex, saltHex, now)
    .run();

  return {
    id,
    email: email.toLowerCase(),
    password_hash: hashHex,
    salt: saltHex,
    role: "super_admin",
    name: "Platform Super Administrator",
    created_at: now
  };
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

  if (existing) return existing;

  return await createTenant(db, {
    userId: superAdminId,
    name: "Demonstration High School",
    subdomain: "demo",
    status: "active",
    mode: "portal",
    defaultUrl: "https://www.khanacademy.org"
  });
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

export async function findTenantById(db: D1Database, id: string): Promise<Tenant | null> {
  return await db.prepare("SELECT * FROM tenants WHERE id = ?").bind(id).first<Tenant>();
}

export async function findTenantByUserId(db: D1Database, userId: string): Promise<Tenant | null> {
  return await db.prepare("SELECT * FROM tenants WHERE user_id = ?").bind(userId).first<Tenant>();
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
  }
): Promise<Tenant> {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const status = data.status || "pending";
  const mode = data.mode || "portal";
  const defaultUrl = data.defaultUrl || "https://www.khanacademy.org";

  await db
    .prepare(
      `INSERT INTO tenants (id, user_id, name, subdomain, status, mode, default_url, admin_pin, created_at, updated_at) 
       VALUES (?, ?, ?, ?, ?, ?, ?, '1234', ?, ?)`
    )
    .bind(id, data.userId, data.name, data.subdomain.toLowerCase(), status, mode, defaultUrl, now, now)
    .run();

  // Populate default educational portal cards
  await seedDefaultPortalSites(db, id);

  return {
    id,
    user_id: data.userId,
    name: data.name,
    subdomain: data.subdomain.toLowerCase(),
    status,
    mode,
    default_url: defaultUrl,
    admin_pin: "1234",
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

export async function updateTenant(
  db: D1Database,
  id: string,
  updates: Partial<Tenant>
): Promise<void> {
  const fields: string[] = [];
  const values: any[] = [];

  for (const [key, val] of Object.entries(updates)) {
    fields.push(`${key} = ?`);
    values.push(val);
  }
  fields.push("updated_at = ?");
  values.push(Math.floor(Date.now() / 1000));
  values.push(id);

  await db
    .prepare(`UPDATE tenants SET ${fields.join(", ")} WHERE id = ?`)
    .bind(...values)
    .run();
}

export async function listAllTenants(db: D1Database): Promise<any[]> {
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
    .all();

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
  let domain = "educational.org";
  try {
    domain = new URL(data.url).hostname.replace(/^www\./, "");
  } catch (e) {}

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
  }
): Promise<void> {
  const compositeId = `${data.tenantId}:${data.clientId}`;
  const now = Math.floor(Date.now() / 1000);
  const isLockedVal = data.isLocked ? 1 : 0;
  const clientNum = data.clientNum || 1;

  await db
    .prepare(
      `INSERT INTO client_devices (id, tenant_id, client_id, client_num, ip, last_seen, is_locked, active_url, thumbnail, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         client_num = excluded.client_num,
         ip = excluded.ip,
         last_seen = excluded.last_seen,
         is_locked = excluded.is_locked,
         active_url = excluded.active_url,
         thumbnail = COALESCE(excluded.thumbnail, client_devices.thumbnail),
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
  }
): Promise<string> {
  const id = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const expiresAt = now + 60; // 60s command TTL
  const payloadJson = JSON.stringify({ url: data.url, message: data.message });

  await db
    .prepare(
      `INSERT INTO commands (id, tenant_id, target, action, payload_json, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(id, data.tenantId, data.target, data.action, payloadJson, now, expiresAt)
    .run();

  return id;
}

export async function popCommandsForClient(
  db: D1Database,
  tenantId: string,
  clientId: string
): Promise<RemoteCommand[]> {
  const now = Math.floor(Date.now() / 1000);
  const rows = await db
    .prepare(
      `SELECT * FROM commands 
       WHERE tenant_id = ? AND (target = 'all' OR target = ?) AND expires_at > ?
       ORDER BY created_at ASC`
    )
    .bind(tenantId, clientId, now)
    .all<any>();

  const commands: RemoteCommand[] = [];
  const idsToDelete: string[] = [];

  for (const row of rows.results || []) {
    let payload: any = {};
    try {
      if (row.payload_json) payload = JSON.parse(row.payload_json);
    } catch (e) {}

    commands.push({
      id: row.id,
      target: row.target,
      action: row.action as CommandAction,
      url: payload.url,
      message: payload.message,
      timestamp: row.created_at
    });

    if (row.target === clientId) {
      idsToDelete.push(row.id);
    }
  }

  // Delete consumed unicast commands
  for (const cid of idsToDelete) {
    await db.prepare("DELETE FROM commands WHERE id = ?").bind(cid).run();
  }

  return commands;
}
