/**
 * The license an organization runs under (tenants.license_plan and
 * license_expires_at, migration 0037), as the platform recorded it.
 *
 * Once the license has expired the organization enrols no new workstation and
 * opens no Remote Control session. Enrolled workstations keep booting into the
 * kiosk and getting updates, a workstation that still holds its token enrols
 * again, and the console says why, so nothing is stranded.
 */

import type { LicensePlan, Tenant } from "./types";

export const LICENSE_PLANS: ReadonlyArray<{ id: LicensePlan; label: string }> = [
  { id: "education", label: "Education" },
  { id: "evaluation", label: "Evaluation" },
  { id: "subscriber", label: "Subscriber" },
  { id: "commercial", label: "Commercial" }
];

/** Days before the end date from which the console reminds the organization. */
export const LICENSE_REMINDER_DAYS = 30;
const DAY = 86_400;

export function isLicensePlan(value: unknown): value is LicensePlan {
  return LICENSE_PLANS.some((p) => p.id === value);
}

export function licensePlanLabel(plan: LicensePlan | null | undefined): string {
  return LICENSE_PLANS.find((p) => p.id === plan)?.label ?? "Not recorded";
}

/** "2027-06-30" to Unix seconds at 00:00 UTC that day; null for anything that is not a real date. */
export function parseLicenseDate(value: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const ms = Date.UTC(year, month - 1, day);
  const date = new Date(ms);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return Math.floor(ms / 1000);
}

export function licenseDate(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}

export interface LicenseState {
  plan: LicensePlan | null;
  expiresAt: number | null;
  expired: boolean;
  /** Not expired, and ends within LICENSE_REMINDER_DAYS. */
  endingSoon: boolean;
}

export function licenseState(tenant: Pick<Tenant, "license_plan" | "license_expires_at">, now = Math.floor(Date.now() / 1000)): LicenseState {
  const plan = isLicensePlan(tenant.license_plan) ? tenant.license_plan : null;
  const raw = tenant.license_expires_at;
  const expiresAt = raw === null || raw === undefined ? null : Number(raw);
  const expired = expiresAt !== null && expiresAt <= now;
  const endingSoon = expiresAt !== null && !expired && expiresAt - now <= LICENSE_REMINDER_DAYS * DAY;
  return { plan, expiresAt, expired, endingSoon };
}

/** The sentence a refused enrolment or Remote Control session gives, or null while the license is in force. */
export function licenseExpiredMessage(tenant: Pick<Tenant, "name" | "license_plan" | "license_expires_at">, now?: number): string | null {
  const state = licenseState(tenant, now);
  if (!state.expired || state.expiresAt === null) return null;
  return `The Lab Kiosk license of ${tenant.name} ended on ${licenseDate(state.expiresAt)}. Enrolled workstations keep working; ask Lab Kiosk to renew it to enrol more or use Remote Control.`;
}
