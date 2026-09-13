export type UserRole = "super_admin" | "school_admin";
export type TenantStatus = "active" | "pending" | "rejected" | "suspended";
export type KioskMode = "portal" | "single_url";
export type CommandAction = "lock" | "unlock" | "navigate" | "reload" | "reboot" | "shutdown" | "mute";

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
  created_at: number;
  updated_at: number;
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
  thumbnail?: string | null;
  created_at: number;
  updated_at: number;
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
}

export interface RemoteCommand {
  id: string;
  target: "all" | string;
  action: CommandAction;
  url?: string;
  message?: string;
  timestamp: number;
}

export interface LabConfig {
  version: number;
  updatedAt: string;
  adminPin: string;
  totalClients: number;
  defaultHomepage: string;
  tunnelDomain: string;
  whitelist: string[];
  scheduledShutdown: string;
}

export interface Env {
  DB?: D1Database;
  LAB_KIOSK_KV?: KVNamespace;
  SUPER_ADMIN_EMAIL?: string;
  SUPER_ADMIN_PASSWORD?: string;
  DEFAULT_DOMAIN?: string; // e.g. "labkiosk.io"
}

