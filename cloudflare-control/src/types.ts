export type UserRole = "super_admin" | "org_admin";
export type TenantStatus = "active" | "pending" | "rejected" | "suspended";
export type KioskMode = "portal" | "single_url";
export type CommandAction = "lock" | "unlock" | "navigate" | "reload" | "reboot" | "shutdown" | "clear-session" | "mute";
export type CustomHostnameStatus = "none" | "pending" | "active" | "failed" | "local";
export type TenantUserRole = "org_admin" | "sub_admin" | "operator" | "assistant" | "content_manager";

export interface TenantUser {
  id: string;
  tenant_id: string;
  user_id: string;
  role: TenantUserRole;
  permissions: string[];
  created_at: number;
  email?: string;
  name?: string;
}

export interface User {
  id: string;
  email: string;
  password_hash: string;
  salt: string;
  role: UserRole;
  name: string;
  created_at: number;
}

export interface Tenant {
  id: string;
  user_id: string;
  name: string;
  subdomain: string;
  requested_subdomain?: string | null;
  status: TenantStatus;
  mode: KioskMode;
  default_url: string;
  admin_pin: string;
  enrollment_key: string;
  custom_domain?: string | null;
  requested_custom_domain?: string | null;
  custom_domain_status?: "none" | "pending" | "approved" | "rejected";
  default_lock_message?: string;
  portal_title?: string | null;
  portal_subtitle?: string | null;
  portal_description?: string | null;
  portal_footer?: string | null;
  /** Active broadcast page URL, or null when workstations should sit on their portal. */
  broadcast_url?: string | null;
  /** Monotonic marker workstations use to detect a new broadcast; 0 when none is active. */
  broadcast_epoch?: number;
  home_route?: string | null;
  /** Headline on the organization homepage. Falls back to the organization name. */
  homepage_headline?: string | null;
  /** One or two lines under the headline. */
  homepage_intro?: string | null;
  /** A JSON array of HomepageBlock; read it with parseHomepageBlocks. */
  homepage_blocks?: string | null;
  tunnel_domain?: string | null;
  /** Workstations online, as the organization's OrgHub last counted them. */
  online_workstations?: number;
  /** Cloudflare for SaaS custom hostname id for `custom_domain`, once provisioned. */
  custom_hostname_id?: string | null;
  /** none, pending (certificate being issued), active, failed, or local (development). */
  custom_hostname_status?: CustomHostnameStatus;
  created_at: number;
  updated_at: number;
}

export interface BroadcastPreset {
  id: string;
  tenant_id: string;
  title: string;
  url: string;
  created_at: number;
}

export interface Session {
  token: string;
  user_id: string;
  tenant_id?: string | null;
  role: UserRole;
  expires_at: number;
}

export interface PortalSite {
  id: string;
  tenant_id: string;
  title: string;
  url: string;
  domain: string;
  category: string;
  icon?: string | null;
  thumbnail_url?: string | null;
  order_index: number;
  is_active: number; // 0 or 1
  created_at: number;
}

export interface ClientDevice {
  id: string;
  tenant_id: string;
  client_id: string;
  client_num: number;
  ip?: string | null;
  last_seen: number;
  is_locked: number; // 0 or 1
  active_url?: string | null;
  /** x11vnc password the workstation generated at boot; reported over telemetry. */
  vnc_password?: string | null;
  /** Hostname the workstation's noVNC gateway is reachable on (Cloudflare Tunnel). */
  remote_host?: string | null;
  group_name?: string | null;
  /** Last broadcast addressed to this workstation alone; NULL with an epoch is a reset. */
  broadcast_url?: string | null;
  broadcast_epoch?: number;
  created_at: number;
  updated_at: number;
}

export interface WorkstationGroup {
  id: string;
  tenant_id: string;
  name: string;
  created_at: number;
}

export interface DeviceToken {
  id: string;
  token_hash: string;
  tenant_id: string;
  client_id: string;
  created_at: number;
  last_used_at: number;
  revoked: number; // 0 or 1
}

export interface WhitelistEntry {
  id: string;
  tenant_id: string;
  domain: string;
  created_at: number;
}

/** One editable section of an organization homepage. */
export interface HomepageBlock {
  title: string;
  body: string;
  /** An http(s) link, already validated by safeHttpUrl. */
  url: string | null;
}

export interface AuditLogEntry {
  id: string;
  tenant_id?: string | null;
  user_id?: string | null;
  action: string;
  details?: string | null;
  created_at: number;
}

export interface ClientTelemetry {
  clientId: string; // e.g. "PC-01"
  clientNum: number; // e.g. 1..40
  activeUrl: string;
  isLocked: boolean;
  thumbnail?: string;
  timestamp: number;
  ip?: string;
  lastSeen?: string;
  online?: boolean;
  vncPassword?: string;
  remoteHost?: string;
  groupName?: string;
}

export interface RemoteCommand {
  id: string;
  target: "all" | string;
  action: CommandAction;
  url?: string;
  message?: string;
  epoch?: number;
  /**
   * A "Reset to Portal": the URL is filled in when the command is delivered,
   * from the workstation's own request, because the operator who queued it may
   * have reached the console under a different host.
   */
  portal?: boolean;
  timestamp: number;
}

export interface LabConfig {
  version: number;
  updatedAt: string;
  defaultHomepage: string;
  tunnelDomain: string;
  homeRoute?: string;
  /** Effective allowlist for this organization: its own domains plus portal app hosts. */
  whitelist: string[];
  scheduledShutdown: string;
}

/** What the audit queue carries: one entry, as `writeAuditLog` received it. */
export interface AuditEntryMessage {
  id: string;
  tenantId: string | null;
  userId: string | null;
  action: string;
  details: string | null;
  createdAt: number;
}

/** A custom hostname job for the CUSTOM_HOSTNAMES workflow. */
export interface CustomHostnameParams {
  operation: "create" | "delete";
  tenantId: string;
  hostname: string;
  /** For "delete": the Cloudflare for SaaS custom hostname id to remove. */
  customHostnameId?: string | null;
}

export interface Env {
  DB?: D1Database;
  /**
   * The bindings below are required in production (bootstrap refuses to serve
   * without them). Tests and `ALLOW_LOCAL_DB=1` development use in-process
   * stand-ins, so they are optional in the type.
   */
  /** One OrgHub Durable Object per organization (src/org_hub.ts). */
  ORG_HUB?: DurableObjectNamespace;
  /** Audit entries, written to D1 in batches by the queue consumer. */
  AUDIT_QUEUE?: Queue<AuditEntryMessage>;
  /** Audit entries older than the retention period, as NDJSON files. */
  AUDIT_ARCHIVE?: R2Bucket;
  /** Fleet history: connections, disconnections and online counts per organization. */
  FLEET_METRICS?: AnalyticsEngineDataset;
  /** Coarse per-address throttle in front of sign-in, registration and enrolment. */
  AUTH_RATE_LIMITER?: RateLimit;
  /** Provisions and removes Cloudflare for SaaS custom hostnames. */
  CUSTOM_HOSTNAMES?: Workflow<CustomHostnameParams>;
  /** API token with SSL and Certificates: Edit on the zone (Cloudflare for SaaS). */
  CF_API_TOKEN?: string;
  /** The zone custom hostnames are created in (the platform domain's zone). */
  CF_ZONE_ID?: string;
  SUPER_ADMIN_EMAIL?: string;
  SUPER_ADMIN_PASSWORD?: string;
  DEFAULT_DOMAIN?: string; // e.g. "labkiosk.akbhoi.com"
  /**
   * Opt-in to the ephemeral in-memory database (tests & local dev only).
   * Without it a missing DB binding is a hard failure rather than silent data loss.
   */
  ALLOW_LOCAL_DB?: string;
  /** Public download URL for the built kiosk ISO, shown on the landing page. */
  ISO_DOWNLOAD_URL?: string;
  /** Cloudflare Tunnel domain for remote management (VNC). Defaults to lab.example.com. */
  TUNNEL_DOMAIN?: string;
  /** Default homepage URL for non-enrolled clients. Defaults to https://labkiosk.akbhoi.com. */
  DEFAULT_HOMEPAGE?: string;
}

