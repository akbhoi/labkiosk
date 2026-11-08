/**
 * Money: quotes, GST, pro-rating, invoices, and the subscription engine
 * against a stand-in for Razorpay's API (src/plans.ts, src/invoices.ts,
 * src/subscriptions.ts, src/limits.ts). Every charge is granted and invoiced
 * once, whatever order or how often Razorpay's state is read.
 */

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createLocalD1Database } from "../src/d1_adapter";
import { createTenant, createUser, findTenantById, initSchema, updateTenant } from "../src/db";
import { financialYear, splitGst, validGstin, gstPercentFor, invoiceStatements } from "../src/invoices";
import { claimRemoteSeat, enforceRemoteSeats, enforceStaffCap, setStaffSuspended } from "../src/limits";
import { CATALOGUE, entitlement, parseTierQuoteInput, prorate, quoteTier, type TierQuoteInput } from "../src/plans";
import {
  cancelSubscription,
  findSubscription,
  planChange,
  reconcileSubscriptions,
  startCheckout,
  syncSubscription
} from "../src/subscriptions";
import type { Env, Tenant } from "../src/types";

const PEPPER = "p".repeat(40);
const DAY = 86_400;

describe("Prices, GST and invoices", () => {
  test("A tier's price is worked out in paise from the catalogue alone", () => {
    const standard = quoteTier({ tier: "standard", period: "month", extraWorkstations: 0, remoteSeats: 0 }, 18);
    assert.deepEqual([standard.base, standard.subtotal, standard.gst, standard.total], [199_900, 199_900, 35_982, 235_882]);
    const pro = quoteTier({ tier: "pro", period: "year", extraWorkstations: 5, remoteSeats: 3 }, 18);
    assert.equal(pro.base, 4_999_000);
    assert.equal(pro.extras, 5 * 29_000);
    assert.equal(pro.remote, 3 * 49_000);
    assert.equal(pro.subtotal, 4_999_000 + 145_000 + 147_000);
    assert.equal(pro.gst, Math.round((pro.subtotal * 18) / 100));
    assert.equal(pro.workstations, 125);
    assert.equal(pro.remoteSeatsTotal, 13, "Pro includes 10 seats");
    const unregistered = quoteTier({ tier: "starter", period: "month", extraWorkstations: 0, remoteSeats: 0 }, 0);
    assert.equal(unregistered.gst, 0);
    assert.equal(unregistered.total, 99_900);
    const education = quoteTier({ tier: "education", period: "year", extraWorkstations: 0, remoteSeats: 4 }, 18);
    assert.equal(education.base, 0);
    assert.equal(education.remote, 4 * 24_500, "Remote Control is half price on Education");
  });

  test("Only a tier, a period and counts are accepted from the browser", () => {
    assert.equal(parseTierQuoteInput({ tier: "gold", period: "month" }).ok, false);
    assert.equal(parseTierQuoteInput({ tier: "pro", period: "week" }).ok, false);
    assert.equal(parseTierQuoteInput({ tier: "pro", period: "month", extraWorkstations: -1 }).ok, false);
    assert.equal(parseTierQuoteInput({ tier: "pro", period: "month", extraWorkstations: 1.5 }).ok, false);
    assert.equal(parseTierQuoteInput({ tier: "pro", period: "month", extraWorkstations: "3" }).ok, false);
    assert.equal(parseTierQuoteInput({ tier: "starter", period: "month", extraWorkstations: 200 }).ok, false, "above 200 workstations is sales");
    assert.equal(parseTierQuoteInput({ tier: "starter", period: "month", remoteSeats: 16 }).ok, false, "no more seats than workstations");
    assert.equal(parseTierQuoteInput({ tier: "education", period: "month" }).ok, false, "Education has nothing to pay for without extras");
    const tampered: Record<string, unknown> = { tier: "standard", period: "year", extraWorkstations: 5, remoteSeats: 2, total: 1 };
    const ok = parseTierQuoteInput(tampered);
    assert.ok(ok.ok);
    if (ok.ok) assert.deepEqual(ok.value, { tier: "standard", period: "year", extraWorkstations: 5, remoteSeats: 2 }, "an amount sent along is ignored");
  });

  test("A mid-term increase charges the difference for the time left, rounded up to the rupee", () => {
    const start = 1_800_000_000;
    const end = start + 30 * DAY;
    const half = prorate(199_900, 499_900, start, end, start + 15 * DAY, 18);
    assert.equal(half.subtotal, 150_000);
    assert.equal(half.gst, 27_000);
    assert.equal(prorate(499_900, 199_900, start, end, start + DAY, 18).total, 0, "a decrease charges nothing now");
    assert.equal(prorate(199_900, 499_900, start, end, end + 1, 18).total, 0, "nothing after the period");
    const tiny = prorate(100_000, 100_100, start, end, end - 60, 0);
    assert.equal(tiny.subtotal, 100, "never below one rupee");
  });

  test("GSTINs are checked by format, state and check character", () => {
    assert.ok(validGstin("27AAPFU0939F1ZV"));
    assert.ok(!validGstin("27AAPFU0939F1ZX"), "wrong check character");
    assert.ok(!validGstin("99AAPFU0939F1ZV"), "no such state");
    assert.ok(!validGstin("AA211126005970R"), "an application reference number is not a GSTIN");
    assert.equal(gstPercentFor({ SELLER_GSTIN: "AA211126005970R" } as Env), 0, "no GST without a valid GSTIN");
    assert.equal(gstPercentFor({ SELLER_GSTIN: "27AAPFU0939F1ZV" } as Env), 18);
  });

  test("The financial year turns on 1 April in India, and GST splits by place of supply", () => {
    const ist = (iso: string) => Date.parse(iso) / 1000;
    assert.equal(financialYear(ist("2027-03-31T23:59:00+05:30")), "2026-27");
    assert.equal(financialYear(ist("2027-04-01T00:00:00+05:30")), "2027-28");
    assert.deepEqual(splitGst(35_983, "21", "21"), { cgst: 17_991, sgst: 17_992, igst: 0, placeOfSupply: "21" });
    assert.deepEqual(splitGst(35_982, "21", "27"), { cgst: 0, sgst: 0, igst: 35_982, placeOfSupply: "27" });
    assert.deepEqual(splitGst(35_982, "21", null), { cgst: 17_991, sgst: 17_991, igst: 0, placeOfSupply: "21" }, "an unknown buyer is taxed in the seller's state");
    assert.deepEqual(splitGst(0, "21", "27"), { cgst: 0, sgst: 0, igst: 0, placeOfSupply: "27" });
  });
});

// ------------------------------------------------------------- the engine

interface FakeInvoice {
  id: string;
  status: string;
  amount: number;
  payment_id: string;
  billing_start: number | null;
  billing_end: number | null;
  line_items: Array<{ type: string }>;
}

interface FakeSubscription {
  id: string;
  status: string;
  plan_id: string;
  current_start: number | null;
  current_end: number | null;
  start_at: number | null;
  addons: number;
  invoices: FakeInvoice[];
}

/** Razorpay's API, as far as the engine uses it. */
class FakeRazorpay {
  plans = new Map<string, number>();
  subs = new Map<string, FakeSubscription>();
  calls: string[] = [];
  private n = 0;
  private id(prefix: string) {
    this.n++;
    return `${prefix}_${String(this.n).padStart(14, "0")}`;
  }
  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    this.calls.push(`${method} ${url.pathname}`);
    const ok = (data: unknown) => new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
    if (method === "POST" && url.pathname === "/v1/plans") {
      const id = this.id("plan");
      this.plans.set(id, body.item.amount);
      return ok({ id });
    }
    if (method === "POST" && url.pathname === "/v1/subscriptions") {
      const id = this.id("sub");
      const sub: FakeSubscription = {
        id,
        status: "created",
        plan_id: body.plan_id,
        current_start: null,
        current_end: null,
        start_at: body.start_at ?? null,
        addons: body.addons ? body.addons[0].item.amount : 0,
        invoices: []
      };
      this.subs.set(id, sub);
      return ok({ id, status: "created", short_url: `https://rzp.io/i/${id}` });
    }
    const one = /^\/v1\/subscriptions\/(sub_\w+)$/.exec(url.pathname);
    if (method === "GET" && one) {
      const sub = this.subs.get(one[1])!;
      return ok({ id: sub.id, status: sub.status, current_start: sub.current_start, current_end: sub.current_end });
    }
    const cancel = /^\/v1\/subscriptions\/(sub_\w+)\/cancel$/.exec(url.pathname);
    if (method === "POST" && cancel) {
      const sub = this.subs.get(cancel[1])!;
      sub.status = "cancelled";
      return ok({ id: sub.id, status: "cancelled" });
    }
    if (method === "GET" && url.pathname === "/v1/invoices") {
      const sub = this.subs.get(url.searchParams.get("subscription_id")!)!;
      const skip = Number(url.searchParams.get("skip"));
      return ok({ items: sub.invoices.slice(skip, skip + 100) });
    }
    return new Response(JSON.stringify({ error: { description: "not faked" } }), { status: 400 });
  };
  /** The payer authorised, and the first period was charged. */
  charge(subId: string, start: number, length: number, amount?: number, extra?: Partial<FakeInvoice>) {
    const sub = this.subs.get(subId)!;
    sub.status = "active";
    sub.current_start = start;
    sub.current_end = start + length;
    sub.invoices.push({
      id: this.id("inv"),
      status: "paid",
      amount: amount ?? this.plans.get(sub.plan_id)!,
      payment_id: this.id("pay"),
      billing_start: start,
      billing_end: start + length,
      line_items: [{ type: "plan" }],
      ...extra
    });
    return sub.invoices.at(-1)!;
  }
}

describe("The subscription engine", () => {
  let db: D1Database;
  let tenant: Tenant;
  let userId: string;
  let rzp: FakeRazorpay;
  let realFetch: typeof fetch;
  const env = { RAZORPAY_KEY_ID: "rzp_test_x", RAZORPAY_KEY_SECRET: "secret", SELLER_GSTIN: "27AAPFU0939F1ZV", SELLER_STATE: "21" } as Env;
  const now = Math.floor(Date.now() / 1000);

  beforeEach(async () => {
    db = createLocalD1Database();
    await initSchema(db);
    const user = await createUser(db, { email: "owner@riverside.example", password: "OwnerPassword123!", name: "Owner" }, PEPPER);
    userId = user.id;
    tenant = await createTenant(db, { userId, name: "Riverside", subdomain: "riverside", status: "active" });
    await updateTenant(db, tenant.id, { workstation_limit: 5 });
    tenant = (await findTenantById(db, tenant.id))!;
    rzp = new FakeRazorpay();
    realFetch = globalThis.fetch;
    globalThis.fetch = rzp.fetch as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const checkout = async (input: TierQuoteInput = { tier: "standard", period: "month", extraWorkstations: 5, remoteSeats: 2 }) =>
    startCheckout(env, db, { tenant, userId, quote: quoteTier(input, gstPercentFor(env)), now });
  const invoices = async () => (await db.prepare("SELECT * FROM invoices WHERE tenant_id = ? ORDER BY number").bind(tenant.id).all<any>()).results ?? [];

  test("A paid period is granted and invoiced once, however often Razorpay is read", async () => {
    const row = await checkout();
    assert.equal(row.status, "created");
    assert.equal(row.total_paise, quoteTier({ tier: "standard", period: "month", extraWorkstations: 5, remoteSeats: 2 }, 18).total);
    assert.equal(rzp.plans.get(row.razorpay_plan_id!), row.total_paise, "Razorpay's plan is exactly the stored total");
    rzp.charge(row.razorpay_subscription_id!, now, 30 * DAY);

    const first = await syncSubscription(env, db, row, now);
    assert.deepEqual([first.status, first.granted, first.mismatched.length], ["active", 1, 0]);
    const t = (await findTenantById(db, tenant.id))!;
    assert.equal(t.license_plan, "subscriber");
    assert.equal(t.plan_tier, "standard");
    assert.equal(Number(t.workstation_limit), 50);
    assert.equal(Number(t.remote_seats_paid), 2);
    assert.equal(Number(t.license_expires_at), now + 30 * DAY);
    assert.equal(entitlement(t, now).staffLimit, CATALOGUE.standard.staff);

    for (let i = 0; i < 3; i++) assert.equal((await syncSubscription(env, db, (await findSubscription(db, row.id))!, now)).granted, 0, "a repeat grants nothing");
    const list = await invoices();
    assert.equal(list.length, 1);
    assert.match(list[0].number, new RegExp(`^LK/${financialYear(now)}/000001$`));
    assert.equal(list[0].total_paise, row.total_paise);
    assert.equal(list[0].cgst_paise + list[0].sgst_paise + list[0].igst_paise, row.gst_paise);
    assert.equal(list[0].igst_paise, 0, "a buyer with no state on record is taxed in the seller's state");
  });

  test("A renewal moves the end date on; a late, older charge moves nothing back", async () => {
    const row = await checkout();
    const first = rzp.charge(row.razorpay_subscription_id!, now - 30 * DAY, 30 * DAY);
    rzp.charge(row.razorpay_subscription_id!, now, 30 * DAY);
    // Razorpay listed the newer charge first: order must not matter.
    rzp.subs.get(row.razorpay_subscription_id!)!.invoices.reverse();
    const result = await syncSubscription(env, db, row, now);
    assert.equal(result.granted, 2);
    const t = (await findTenantById(db, tenant.id))!;
    assert.equal(Number(t.license_expires_at), now + 30 * DAY);
    assert.ok((await invoices()).some((i) => i.razorpay_payment_id === first.payment_id));
    assert.deepEqual((await invoices()).map((i) => i.number.slice(-6)), ["000001", "000002"], "numbers have no gap");
  });

  test("A paid amount that does not match what was sold grants nothing and is reported once", async () => {
    const row = await checkout();
    rzp.charge(row.razorpay_subscription_id!, now, 30 * DAY, 100);
    const a = await syncSubscription(env, db, row, now);
    const b = await syncSubscription(env, db, row, now);
    assert.equal(a.granted + b.granted, 0);
    assert.equal(a.mismatched.length, 1);
    assert.equal((await findTenantById(db, tenant.id))!.license_plan, null);
    const reported = await db.prepare("SELECT COUNT(*) AS n FROM billing_events WHERE outcome = 'amount_mismatch'").first<{ n: number }>();
    assert.equal(Number(reported!.n), 1);
    assert.equal((await invoices()).length, 0);
  });

  test("A halted subscription keeps the plan for the grace period, then Free", async () => {
    const row = await checkout();
    rzp.charge(row.razorpay_subscription_id!, now - 30 * DAY, 30 * DAY);
    await syncSubscription(env, db, row, now - 30 * DAY);
    rzp.subs.get(row.razorpay_subscription_id!)!.status = "halted";
    await syncSubscription(env, db, (await findSubscription(db, row.id))!, now);
    const t = (await findTenantById(db, tenant.id))!;
    assert.equal(Number(t.grace_ends_at), now + 7 * DAY);
    assert.equal(entitlement(t, now + 6 * DAY).kind, "subscription");
    assert.equal(entitlement(t, now + 8 * DAY).kind, "free", "after the grace the organization is on Free");
    rzp.charge(row.razorpay_subscription_id!, now + DAY, 30 * DAY);
    await syncSubscription(env, db, (await findSubscription(db, row.id))!, now + DAY);
    assert.equal((await findTenantById(db, tenant.id))!.grace_ends_at, null, "paying again ends the grace");
  });

  test("An increase mid-term charges the difference upfront and replaces the subscription only once authorised", async () => {
    const row = await checkout({ tier: "starter", period: "month", extraWorkstations: 0, remoteSeats: 0 });
    rzp.charge(row.razorpay_subscription_id!, now - 10 * DAY, 30 * DAY);
    await syncSubscription(env, db, row, now);
    const current = (await findSubscription(db, row.id))!;
    const next = quoteTier({ tier: "pro", period: "month", extraWorkstations: 0, remoteSeats: 0 }, 18);
    const change = planChange(current, next, now, 18);
    assert.equal(change.immediate, false);
    assert.equal(change.startsAt, now + 20 * DAY);
    assert.ok(change.upfront && change.upfront.total > 0);
    tenant = (await findTenantById(db, tenant.id))!;
    const replacement = await startCheckout(env, db, { tenant, userId, quote: next, replaces: current, startsAt: change.startsAt, upfront: change.upfront, now });
    assert.equal(rzp.subs.get(replacement.razorpay_subscription_id!)!.addons, change.upfront!.total);
    assert.equal(rzp.subs.get(row.razorpay_subscription_id!)!.status, "active", "the old one renews until the new one is authorised");

    // Authorised: the upfront add-on is charged on its own invoice.
    const sub = rzp.subs.get(replacement.razorpay_subscription_id!)!;
    sub.status = "authenticated";
    sub.invoices.push({ id: "inv_up", status: "paid", amount: change.upfront!.total, payment_id: "pay_up000000000001", billing_start: null, billing_end: null, line_items: [{ type: "addon" }] });
    const synced = await syncSubscription(env, db, replacement, now);
    assert.equal(synced.granted, 1);
    const t = (await findTenantById(db, tenant.id))!;
    assert.equal(t.plan_tier, "pro", "the change applies at once");
    assert.equal(Number(t.workstation_limit), CATALOGUE.pro.includedWorkstations);
    assert.equal(Number(t.license_expires_at), now + 20 * DAY, "the paid period does not move");
    assert.equal(rzp.subs.get(row.razorpay_subscription_id!)!.status, "cancelled", "the old one stops charging");
    assert.equal((await findSubscription(db, row.id))!.cancel_reason, "replaced");
  });

  test("Cancelling stops charges at Razorpay and keeps the plan until the period ends", async () => {
    const row = await checkout();
    rzp.charge(row.razorpay_subscription_id!, now, 30 * DAY);
    await syncSubscription(env, db, row, now);
    tenant = (await findTenantById(db, tenant.id))!;
    const { endsAt } = await cancelSubscription(env, db, { tenant, userId, reason: "Too expensive", now });
    assert.equal(endsAt, now + 30 * DAY);
    assert.equal(rzp.subs.get(row.razorpay_subscription_id!)!.status, "cancelled");
    const t = (await findTenantById(db, tenant.id))!;
    assert.equal(entitlement(t, now + 29 * DAY).kind, "subscription");
    assert.equal(entitlement(t, now + 31 * DAY).kind, "free");
    await assert.rejects(cancelSubscription(env, db, { tenant: t, userId, reason: "", now }), /no subscription to cancel/);
  });

  test("Only one checkout waits at a time, and the cron closes one never authorised", async () => {
    const a = await checkout();
    const b = await checkout({ tier: "pro", period: "year", extraWorkstations: 0, remoteSeats: 0 });
    assert.equal((await findSubscription(db, a.id))!.status, "expired");
    assert.equal(rzp.subs.get(a.razorpay_subscription_id!)!.status, "cancelled");
    await db.prepare("UPDATE subscriptions SET created_at = ?, updated_at = ? WHERE id = ?").bind(now - 2 * DAY, now - 2 * DAY, b.id).run();
    await reconcileSubscriptions(env, db, now);
    assert.equal((await findSubscription(db, b.id))!.status, "expired");
  });

  test("An invoice for the same payment is never issued twice, even when two batches race", async () => {
    const statements = () =>
      invoiceStatements(db, env, {
        id: `in${crypto.randomUUID().replace(/-/g, "")}`,
        tenant,
        source: "payment",
        sourceId: "p1",
        razorpayPaymentId: "pay_same",
        subtotal: 100,
        gst: 18,
        total: 118,
        lines: [{ description: "x", amount: 100 }],
        issuedAt: now
      });
    await db.batch(statements());
    await db.batch(statements());
    assert.equal((await invoices()).length, 1);
    const counter = await db.prepare("SELECT next FROM invoice_counters WHERE fy = ?").bind(financialYear(now)).first<{ next: number }>();
    assert.equal(Number(counter!.next), 1, "the counter did not skip a number");
  });

  test("Staff over the cap are suspended newest first and can be swapped within it", async () => {
    const staff: string[] = [];
    for (let i = 0; i < 4; i++) {
      const u = await createUser(db, { email: `s${i}@riverside.example`, password: "StaffPassword123!", name: `S${i}` }, PEPPER);
      await db.prepare("INSERT INTO tenant_users (id, tenant_id, user_id, role, permissions, created_at) VALUES (?, ?, ?, 'operator', '[]', ?)").bind(crypto.randomUUID(), tenant.id, u.id, now + i).run();
      staff.push(u.id);
    }
    const suspended = await enforceStaffCap(db, tenant, 2, now);
    assert.deepEqual(suspended.sort(), [staff[2], staff[3]].sort());
    const refused = await setStaffSuspended(db, tenant, staff[3], false, 2, now);
    assert.equal(refused.ok, false, "no room to restore");
    assert.ok((await setStaffSuspended(db, tenant, staff[0], true, 2, now)).ok);
    assert.ok((await setStaffSuspended(db, tenant, staff[3], false, 2, now)).ok, "swapped within the cap");
    assert.equal((await setStaffSuspended(db, tenant, userId, true, 2, now)).ok, false, "the owner is never suspended");
  });

  test("A Remote Control seat belongs to one workstation and the last one cannot be taken twice", async () => {
    for (const id of ["PC-1", "PC-2", "PC-3"]) {
      await db
        .prepare("INSERT INTO device_tokens (id, token_hash, tenant_id, client_id, created_at, last_used_at, revoked) VALUES (?, ?, ?, ?, ?, ?, 0)")
        .bind(crypto.randomUUID(), `hash-${id}`, tenant.id, id, now, now)
        .run();
    }
    assert.equal((await claimRemoteSeat(db, tenant.id, "PC-1", 0, userId, now)).ok, false, "no seats bought");
    assert.deepEqual(await claimRemoteSeat(db, tenant.id, "PC-1", 2, userId, now), { ok: true, claimed: true });
    assert.deepEqual(await claimRemoteSeat(db, tenant.id, "PC-1", 2, userId, now), { ok: true, claimed: false });
    const race = await Promise.all([claimRemoteSeat(db, tenant.id, "PC-2", 2, userId, now), claimRemoteSeat(db, tenant.id, "PC-3", 2, userId, now)]);
    assert.equal(race.filter((r) => r.ok).length, 1, "two at once get one seat");
    assert.deepEqual(await enforceRemoteSeats(db, tenant.id, 1), [race[0].ok ? "PC-2" : "PC-3"], "the newest seat is released first");
  });
});

