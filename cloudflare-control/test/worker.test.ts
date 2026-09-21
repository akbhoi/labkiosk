import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import worker from "../src/index";
import * as workerModule from "../src/index";
import { SCHEMA_SQL, initSchema } from "../src/db";
import { createLocalD1Database } from "../src/d1_adapter";
import { safeHttpUrl } from "../src/escape";
import { isHostUnder } from "../src/guard";
import { Env } from "../src/types";

/**
 * The suite runs against the in-memory D1 adapter, which a production
 * deployment refuses to use unless ALLOW_LOCAL_DB is set explicitly.
 */
const mockEnv: Env = {
  DEFAULT_DOMAIN: "labkiosk.akbhoi.com",
  SUPER_ADMIN_EMAIL: "admin@akbhoi.com",
  SUPER_ADMIN_PASSWORD: "SuperAdminPassword2026!",
  ALLOW_LOCAL_DB: "1"
};

const BASE = "https://labkiosk.akbhoi.com";

function request(path: string, init: RequestInit & { cookie?: string; bearer?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set("Cookie", init.cookie);
  if (init.bearer) headers.set("Authorization", `Bearer ${init.bearer}`);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return new Request(`${BASE}${path}`, { ...init, headers });
}

function json(body: unknown): RequestInit {
  return { method: "POST", body: JSON.stringify(body) };
}

async function call(path: string, init: RequestInit & { cookie?: string; bearer?: string } = {}) {
  const res = await worker.fetch(request(path, init), mockEnv);
  return res;
}

async function callJson<T = any>(path: string, init: RequestInit & { cookie?: string; bearer?: string } = {}) {
  const res = await call(path, init);
  const data = (await res.json()) as T;
  return { res, data };
}

describe("Multi-Tenant Lab Kiosk SaaS Platform", () => {
  let schoolSessionCookie = "";
  let rivalSessionCookie = "";
  let superSessionCookie = "";
  let createdSiteId = "";
  let enrollmentKey = "";
  let deviceToken = "";

  // ----------------------------------------------------------- public pages

  test("Serves Public SaaS Landing Page on root /", async () => {
    const res = await call("/");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Content-Type"), "text/html; charset=utf-8");
    const html = await res.text();
    assert.match(html, /Centralized School Computer Lab/);
    assert.match(html, /Download Kiosk ISO/);
    assert.match(html, /Register School Lab/);
    assert.match(html, /id="mobile-toggle"/);
    assert.match(html, /id="mobile-drawer"/);
    assert.match(html, /class="specs-table-container"/);
  });

  test("Opens the sign-in dialog when redirected with ?login=1", async () => {
    const html = await (await call("/?login=1")).text();
    assert.match(html, /const requestedModal = "login"/);
  });

  // -------------------------------------------------------- registration

  test("Rejects registration with a weak password", async () => {
    const { res, data } = await callJson(
      "/api/auth/register",
      json({ name: "Weak School", email: "weak@school.edu", password: "short", subdomain: "weakschool" })
    );
    assert.equal(res.status, 400);
    assert.match(data.error, /at least 12 characters/);
  });

  test("Registers new school admin and claims subdomain", async () => {
    const { res, data } = await callJson(
      "/api/auth/register",
      json({
        name: "Greenwood High School",
        email: "teacher@greenwood.edu",
        password: "SchoolPassword123!",
        subdomain: "greenwood"
      })
    );
    assert.equal(res.status, 200);
    assert.equal(data.status, "ok");
    assert.equal(data.subdomain, "greenwood");

    const cookie = res.headers.get("Set-Cookie");
    assert.ok(cookie && cookie.includes("labkiosk_session="));
    // Session cookies must be Secure, HttpOnly, and scoped to the parent domain
    // so they survive the hop to greenwood.labkiosk.akbhoi.com.
    assert.match(cookie!, /HttpOnly/);
    assert.match(cookie!, /Secure/);
    assert.match(cookie!, /Domain=\.labkiosk\.akbhoi\.com/);
    schoolSessionCookie = cookie!.split(";")[0];
  });

  test("Registers a second, unrelated school for isolation checks", async () => {
    const { res } = await callJson(
      "/api/auth/register",
      json({
        name: "Riverside Academy",
        email: "teacher@riverside.edu",
        password: "RiversidePass456!",
        subdomain: "riverside"
      })
    );
    assert.equal(res.status, 200);
    rivalSessionCookie = res.headers.get("Set-Cookie")!.split(";")[0];
  });

  // ------------------------------------------------------------ super admin

  test("Logs in as Super Admin and accesses Super Admin Console on /super", async () => {
    const { res: loginRes, data: loginData } = await callJson(
      "/api/auth/login",
      json({ email: "admin@akbhoi.com", password: "SuperAdminPassword2026!" })
    );
    assert.equal(loginRes.status, 200);
    assert.equal(loginData.status, "ok");
    assert.equal(loginData.role, "super_admin");
    superSessionCookie = loginRes.headers.get("Set-Cookie")!.split(";")[0];

    const superRes = await call("/super", { cookie: superSessionCookie });
    assert.equal(superRes.status, 200);
    const html = await superRes.text();
    assert.match(html, /Super Admin Master Console/);
    assert.match(html, /Greenwood High School/);
  });

  test("Refuses the Super Admin Console without a super admin session", async () => {
    const anonymous = await call("/super");
    assert.equal(anonymous.status, 401);

    const asTeacher = await call("/super", { cookie: schoolSessionCookie });
    assert.equal(asTeacher.status, 401);
  });

  test("Updates super admin password when SUPER_ADMIN_PASSWORD changes in environment", async () => {
    // Attempt sign-in with rotated password before rotation - must fail
    const { res: preRes } = await callJson(
      "/api/auth/login",
      json({ email: "admin@akbhoi.com", password: "NewRotatedPassword2026!" })
    );
    assert.equal(preRes.status, 401);

    // Call worker with updated SUPER_ADMIN_PASSWORD environment secret
    const rotatedEnv: Env = {
      ...mockEnv,
      SUPER_ADMIN_PASSWORD: "NewRotatedPassword2026!"
    };
    const pingRes = await worker.fetch(request("/api/status"), rotatedEnv);
    assert.equal(pingRes.status, 200);

    // Sign in with new rotated password - must succeed
    const newLoginRes = await worker.fetch(
      request("/api/auth/login", json({ email: "admin@akbhoi.com", password: "NewRotatedPassword2026!" })),
      rotatedEnv
    );
    assert.equal(newLoginRes.status, 200);
    const newLoginData = (await newLoginRes.json()) as any;
    assert.equal(newLoginData.status, "ok");
    assert.equal(newLoginData.role, "super_admin");

    // Old password must now fail
    const oldLoginRes = await worker.fetch(
      request("/api/auth/login", json({ email: "admin@akbhoi.com", password: "SuperAdminPassword2026!" })),
      rotatedEnv
    );
    assert.equal(oldLoginRes.status, 401);

    // Revert password back for subsequent tests
    await worker.fetch(request("/api/status"), mockEnv);
  });

  test("Throttles repeated failed sign-in attempts", async () => {
    for (let i = 0; i < 6; i++) {
      await callJson("/api/auth/login", json({ email: "throttle@school.edu", password: "WrongPassword1" }));
    }
    const { res, data } = await callJson(
      "/api/auth/login",
      json({ email: "throttle@school.edu", password: "WrongPassword1" })
    );
    assert.equal(res.status, 429);
    assert.match(data.error, /Too many failed sign-in attempts/);
  });

  // ------------------------------------------------------------------- XSS

  test("Escapes a hostile school name in the Super Admin Console", async () => {
    const hostileName = '<img src=x onerror=alert(1)>';
    const { res } = await callJson(
      "/api/auth/register",
      json({
        name: hostileName,
        email: "attacker@evil.test",
        password: "AttackerPass789!",
        subdomain: "evilschool"
      })
    );
    assert.equal(res.status, 200);

    const html = await (await call("/super", { cookie: superSessionCookie })).text();
    assert.ok(!html.includes(hostileName), "raw script-bearing tag must never reach the super admin console");
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  });

  // ---------------------------------------------------------- student portal

  test("Serves Student Learning Portal on school subdomain /", async () => {
    const res = await call("/?tenant=greenwood");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Content-Type"), "text/html; charset=utf-8");
    const html = await res.text();
    assert.match(html, /Greenwood High School/);
    assert.match(html, /Select an Educational Resource/);
    assert.match(html, /Khan Academy/);
    assert.match(html, /Scratch Studio/);
  });

  test("Returns 404 for an unknown subdomain without reflecting it as markup", async () => {
    const res = await call("/?tenant=%3Cimg%20src=x%20onerror=alert(1)%3E");
    assert.equal(res.status, 404);
    const html = await res.text();
    assert.ok(!html.includes("<img src=x"), "the requested subdomain must not be reflected as raw HTML");
  });

  // ------------------------------------------------------------ portal apps

  test("Adds and deletes a custom app card in Student Portal", async () => {
    const { res: addRes, data: addData } = await callJson("/api/portal-sites?tenant=greenwood", {
      ...json({
        title: "NASA Space Sims",
        url: "https://eyes.nasa.gov/apps/solar-system",
        category: "Astronomy",
        icon: "\u{1F680}"
      }),
      cookie: schoolSessionCookie
    });

    assert.equal(addRes.status, 200);
    assert.equal(addData.status, "ok");
    assert.equal(addData.site.title, "NASA Space Sims");
    assert.equal(addData.site.domain, "eyes.nasa.gov");
    createdSiteId = addData.site.id;

    const portalHtml = await (await call("/?tenant=greenwood")).text();
    assert.match(portalHtml, /NASA Space Sims/);

    const { res: delRes, data: delData } = await callJson(
      `/api/portal-sites/${createdSiteId}?tenant=greenwood`,
      { method: "DELETE", cookie: schoolSessionCookie }
    );
    assert.equal(delRes.status, 200);
    assert.equal(delData.status, "ok");
  });

  test("Rejects a portal app whose URL is not http(s)", async () => {
    const { res, data } = await callJson("/api/portal-sites?tenant=greenwood", {
      ...json({ title: "Bad", url: "javascript:alert(1)" }),
      cookie: schoolSessionCookie
    });
    assert.equal(res.status, 400);
    assert.match(data.error, /valid http\(s\) address/);
  });

  test("Escapes a hostile app title on the student portal", async () => {
    const hostileTitle = "</script><script>alert(1)</script>";
    await callJson("/api/portal-sites?tenant=greenwood", {
      ...json({ title: hostileTitle, url: "https://example.org/lesson" }),
      cookie: schoolSessionCookie
    });

    const html = await (await call("/?tenant=greenwood")).text();
    assert.ok(!html.includes(hostileTitle), "a hostile title must not break out of the portal markup");
    assert.match(html, /&lt;\/script&gt;/);
  });

  // -------------------------------------------------------------- dashboard

  test("Serves School Teacher Dashboard on /admin for logged-in school admin", async () => {
    const res = await call("/admin?tenant=greenwood", { cookie: schoolSessionCookie });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Greenwood High School/);
    assert.match(html, /greenwood\.labkiosk\.akbhoi\.com/);
    assert.match(html, /Portal Apps/);
    assert.match(html, /Settings/);
  });

  test("Dashboard markup is well formed so every modal is reachable", async () => {
    const html = await (await call("/admin?tenant=greenwood", { cookie: schoolSessionCookie })).text();
    const body = html.split("<body>")[1].split("<script>")[0];
    const opened = (body.match(/<div\b/g) || []).length;
    const closed = (body.match(/<\/div>/g) || []).length;
    assert.equal(opened, closed, "unbalanced <div> tags nest the modals inside one another");

    // Each dialog must be a top-level sibling, not a child of a hidden overlay.
    for (const id of ["vnc-modal", "url-modal", "lock-modal"]) {
      const start = body.indexOf(`<div class="modal-overlay" id="${id}">`);
      assert.notEqual(start, -1, `${id} overlay not found in the rendered dashboard`);
      const before = body.slice(0, start);
      const depth = (before.match(/<div\b/g) || []).length - (before.match(/<\/div>/g) || []).length;
      assert.equal(depth, 0, `${id} must not be nested inside another modal`);
    }

    // The allowlist, portal and settings editors live on their own pages. A
    // second copy used to sit in a dialog here, built on an `input-field`
    // class that was never defined -- so those inputs rendered as white
    // browser defaults -- and the settings copy saved nothing at all.
    for (const id of ["whitelist-modal", "portal-modal", "settings-modal"]) {
      assert.equal(body.includes(`id="${id}"`), false, `${id} duplicates a dedicated page and must not come back`);
    }
    for (const page of ["/admin/whitelist", "/admin/portal", "/admin/settings"]) {
      assert.ok(body.includes(`href="${page}"`), `the toolbar must link to ${page}`);
    }
  });

  test("Every CSS class the consoles render is declared by the shared shell", async () => {
    // `input-field` was used fourteen times and declared nowhere, which is how a
    // white-on-white form ended up inside a dark console. Nothing catches that
    // but a render, so render every page and compare the two sets.
    const pages = [
      ["/admin/workstations?tenant=greenwood", schoolSessionCookie],
      ["/admin/broadcast?tenant=greenwood", schoolSessionCookie],
      ["/admin/portal?tenant=greenwood", schoolSessionCookie],
      ["/admin/whitelist?tenant=greenwood", schoolSessionCookie],
      ["/admin/teachers?tenant=greenwood", schoolSessionCookie],
      ["/admin/settings?tenant=greenwood", schoolSessionCookie],
      ["/super/schools", superSessionCookie],
      ["/super/approvals", superSessionCookie],
      ["/super/catalogs", superSessionCookie],
      ["/super/system", superSessionCookie]
    ];

    for (const [page, cookie] of pages) {
      const html = await (await call(page, { cookie })).text();
      const style = html.split("<style>")[1].split("</style>")[0];
      const declared = new Set((style.match(/\.[a-z][a-z0-9_-]*/g) || []).map((c) => c.slice(1)));
      const used = new Set<string>();
      for (const attr of html.match(/class="[^"<>]*"/g) || []) {
        for (const name of attr.slice(7, -1).split(/\s+/)) {
          if (/^[a-z][a-z0-9_-]*$/.test(name)) used.add(name);
        }
      }
      // A "btn-" name is a JavaScript hook; its appearance is carried by .btn.
      const missing = [...used].filter((c) => !declared.has(c) && !c.startsWith("btn-"));
      assert.deepEqual(missing, [], `${page} renders CSS classes the shell never declares: ${missing.join(", ")}`);
    }
  });

  test("The consoles never speak through a native browser dialog", async () => {
    // window.alert/confirm/prompt cannot be styled, block the 3-second telemetry
    // poll for as long as they are up, and made the platform console look like a
    // different product from the school one. The shell provides lkToast,
    // lkConfirm and lkPrompt instead.
    const pages = [
      ["/admin/workstations?tenant=greenwood", schoolSessionCookie],
      ["/admin/broadcast?tenant=greenwood", schoolSessionCookie],
      ["/admin/portal?tenant=greenwood", schoolSessionCookie],
      ["/admin/whitelist?tenant=greenwood", schoolSessionCookie],
      ["/admin/teachers?tenant=greenwood", schoolSessionCookie],
      ["/admin/settings?tenant=greenwood", schoolSessionCookie],
      ["/super/schools", superSessionCookie],
      ["/super/approvals", superSessionCookie],
      ["/super/catalogs", superSessionCookie],
      ["/super/system", superSessionCookie]
    ];

    for (const [page, cookie] of pages) {
      const html = await (await call(page, { cookie })).text();
      for (const script of html.split("<script").slice(1)) {
        const body = script.slice(script.indexOf(">") + 1);
        const offender = body.split("\n").find((line) => /(^|[^\w.])(alert|confirm|prompt)\s*\(/.test(line));
        assert.equal(
          offender,
          undefined,
          `${page} still calls a native dialog: ${(offender || "").trim()}`
        );
      }
      // And the replacements have to actually be on the page.
      assert.ok(html.includes("window.lkToast"), `${page} is missing the toast kit`);
      assert.ok(html.includes("window.lkConfirm"), `${page} is missing the confirm dialog`);
    }
  });

  test("Platform action history is readable, and only by a super admin", async () => {
    // Every privileged action was already written to audit_logs and none of it
    // could be read back: listAuditLogs filters `tenant_id = ?`, so the entries
    // with no tenant -- catalog uploads and deletions -- were invisible to
    // everything, and no console called the tenant-scoped route either.
    await callJson("/api/super/i18n", {
      ...json({ tag: "de-DE", name: "Deutsch", catalog: { "bar.home": "Startseite" } }),
      cookie: superSessionCookie
    });

    const res = await call("/api/super/audit-logs", { cookie: superSessionCookie });
    assert.equal(res.status, 200);
    const { logs } = (await res.json()) as { logs: Array<{ action: string; details?: string | null }> };
    assert.ok(logs.some((entry) => entry.action === "i18n.upload"), "the catalog upload must be listed");

    // Anonymous and school-admin callers are refused.
    assert.equal((await call("/api/super/audit-logs")).status, 401);
    const asSchool = await call("/api/super/audit-logs", { cookie: schoolSessionCookie });
    assert.ok(asSchool.status === 401 || asSchool.status === 403, `school admin got ${asSchool.status}`);

    await callJson("/api/super/i18n/de-DE", { method: "DELETE", cookie: superSessionCookie });
  });

  test("Platform history never exposes a school's own activity", async () => {
    // Rule 2 keeps super admins out of school data. The query matches on who
    // acted, never on which school was acted upon, so a teacher adding a portal
    // card must not appear here even though that row carries a tenant_id.
    await callJson("/api/portal-sites?tenant=greenwood", {
      ...json({ title: "Private Lab Tool", url: "https://internal.greenwood.example" }),
      cookie: schoolSessionCookie
    });

    const { logs } = (await (await call("/api/super/audit-logs?limit=200", { cookie: superSessionCookie })).json()) as {
      logs: Array<{ action: string; details?: string | null }>;
    };
    // Prove the row exists before asserting it is absent, so this cannot pass
    // just because nothing was written.
    const own = (await (await call("/api/audit-logs?tenant=greenwood&limit=200", { cookie: schoolSessionCookie })).json()) as {
      logs: Array<{ action: string; details?: string | null }>;
    };
    assert.ok(
      own.logs.some((entry) => (entry.details || "").includes("Private Lab Tool")),
      "the school must be able to see its own action"
    );

    const leaked = logs.find((entry) => (entry.details || "").includes("Private Lab Tool"));
    assert.equal(leaked, undefined, "a school's own action leaked into the platform history");
  });

  test("A school can read what the platform did to its lab", async () => {
    // The answer to \"who changed our subdomain\". The super admin acts with the
    // school's tenant_id on the row, so it belongs in that school's own log.
    const meRes = await callJson("/api/auth/me", { cookie: schoolSessionCookie });
    const greenwoodTenantId = meRes.data.tenant.id;

    const before = await (await call("/api/audit-logs?tenant=greenwood&limit=200", { cookie: schoolSessionCookie })).json();
    assert.ok(Array.isArray((before as { logs: unknown[] }).logs));

    await callJson("/api/super/tenants/suspend", { ...json({ tenantId: greenwoodTenantId }), cookie: superSessionCookie });
    await callJson("/api/super/tenants/reactivate", { ...json({ tenantId: greenwoodTenantId }), cookie: superSessionCookie });

    const { logs } = (await (await call("/api/audit-logs?tenant=greenwood&limit=200", { cookie: schoolSessionCookie })).json()) as {
      logs: Array<{ action: string }>;
    };
    assert.ok(logs.some((entry) => entry.action === "tenant.suspend"), "the suspension must be visible to the school");
    assert.ok(logs.some((entry) => entry.action === "tenant.reactivate"), "so must the reactivation");
  });

  test("Redirects an unauthenticated visitor away from /admin", async () => {
    const res = await call("/admin?tenant=greenwood");
    assert.equal(res.status, 302);
    assert.match(res.headers.get("Location")!, /login=1/);
  });

  // ------------------------------------------------------- authorization

  test("Rejects unauthenticated access to every workstation-control API", async () => {
    const cases: Array<[string, RequestInit]> = [
      ["/api/clients?tenant=greenwood", {}],
      ["/api/command?tenant=greenwood", json({ target: "all", action: "lock" })],
      ["/api/clients/remove?tenant=greenwood", json({ clientId: "PC-01" })],
      ["/api/portal-sites?tenant=greenwood", json({ title: "X", url: "https://x.org" })],
      ["/api/settings/mode?tenant=greenwood", json({ mode: "single_url" })],
      ["/api/settings/customization?tenant=greenwood", {}],
      ["/api/broadcast-presets?tenant=greenwood", {}],
      ["/api/settings/subdomain?tenant=greenwood", json({ requestedSubdomain: "hijacked" })],
      ["/api/settings/enrollment-key?tenant=greenwood", {}],
      ["/api/whitelist?tenant=greenwood", {}],
      ["/api/audit-logs?tenant=greenwood", {}],
      ["/api/auth/change-password", json({ currentPassword: "x", newPassword: "y" })],
      ["/api/super/tenants/suspend", json({ tenantId: "any" })],
      ["/api/super/tenants/reactivate", json({ tenantId: "any" })]
    ];

    for (const [path, init] of cases) {
      const res = await call(path, init);
      assert.ok(
        res.status === 401 || res.status === 403,
        `${path} answered ${res.status}; an anonymous caller must never reach it`
      );
    }
  });

  test("Refuses cross-tenant access from a teacher at another school", async () => {
    const apiRes = await call("/api/clients?tenant=greenwood", { cookie: rivalSessionCookie });
    assert.equal(apiRes.status, 403);

    const cmdRes = await call("/api/command?tenant=greenwood", {
      ...json({ target: "all", action: "lock" }),
      cookie: rivalSessionCookie
    });
    assert.equal(cmdRes.status, 403);

    const adminRes = await call("/admin?tenant=greenwood", { cookie: rivalSessionCookie });
    assert.equal(adminRes.status, 403);
  });

  test("Rejects a navigate command that is not an http(s) URL", async () => {
    const { res, data } = await callJson("/api/command?tenant=greenwood", {
      ...json({ target: "all", action: "navigate", url: "javascript:alert(1)" }),
      cookie: schoolSessionCookie
    });
    assert.equal(res.status, 400);
    assert.match(data.error, /valid http\(s\) URL/);
  });

  test("Rejects an unsupported command action", async () => {
    const { res } = await callJson("/api/command?tenant=greenwood", {
      ...json({ target: "all", action: "rm -rf" }),
      cookie: schoolSessionCookie
    });
    assert.equal(res.status, 400);
  });

  // --------------------------------------------------------- device enrolment

  test("Reveals the enrollment key to the school admin only", async () => {
    const { res, data } = await callJson("/api/settings/enrollment-key?tenant=greenwood", {
      cookie: schoolSessionCookie
    });
    assert.equal(res.status, 200);
    assert.match(data.enrollmentKey, /^[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}-[A-Z0-9]{5}$/);
    enrollmentKey = data.enrollmentKey;
  });

  test("Refuses enrolment with a wrong enrollment key", async () => {
    const { res } = await callJson(
      "/api/devices/enroll",
      json({ subdomain: "greenwood", enrollmentKey: "AAAAA-BBBBB-CCCCC-DDDDD", clientId: "PC-99" })
    );
    assert.equal(res.status, 401);
  });

  test("Enrols a workstation and issues a device token", async () => {
    const { res, data } = await callJson(
      "/api/devices/enroll",
      json({ subdomain: "greenwood", enrollmentKey, clientId: "PC-01" })
    );
    assert.equal(res.status, 200);
    assert.equal(data.status, "ok");
    assert.equal(data.clientId, "PC-01");
    assert.equal(data.schoolName, "Greenwood High School");
    assert.match(data.deviceToken, /^[0-9a-f]{64}$/);
    deviceToken = data.deviceToken;
  });

  // ------------------------------------------------------------- telemetry

  test("Rejects telemetry without a valid device token", async () => {
    const anonymous = await call("/api/telemetry?tenant=greenwood", json({ clientId: "PC-01" }));
    assert.equal(anonymous.status, 401);

    const forged = await call("/api/telemetry?tenant=greenwood", {
      ...json({ clientId: "PC-01" }),
      bearer: "f".repeat(64)
    });
    assert.equal(forged.status, 401);
  });

  test("Ingests client telemetry scoped to the token's own tenant", async () => {
    const { res, data } = await callJson("/api/telemetry", {
      ...json({
        // A hostile client claiming another school and another PC is ignored:
        // the token decides both.
        clientId: "PC-EVIL",
        activeUrl: "https://www.khanacademy.org",
        isLocked: false
      }),
      bearer: deviceToken
    });

    assert.equal(res.status, 200);
    assert.equal(data.status, "ok");
    assert.ok(Array.isArray(data.whitelist));
    assert.ok(data.whitelist.includes("khanacademy.org"));

    const { data: clients } = await callJson("/api/clients?tenant=greenwood", { cookie: schoolSessionCookie });
    assert.ok(clients.clients["PC-01"], "telemetry must be recorded against the enrolled client id");
    assert.ok(!clients.clients["PC-EVIL"], "a client id supplied in the body must be ignored");
  });

  test("Delivers a broadcast command to each workstation exactly once", async () => {
    const { res: cmdRes } = await callJson("/api/command?tenant=greenwood", {
      ...json({ target: "all", action: "lock", message: "Attention to front" }),
      cookie: schoolSessionCookie
    });
    assert.equal(cmdRes.status, 200);

    const first = await callJson("/api/telemetry", { ...json({}), bearer: deviceToken });
    const lockCommands = first.data.commands.filter((c: any) => c.action === "lock");
    assert.equal(lockCommands.length, 1);

    // The same broadcast must not be replayed on the next 3-second heartbeat.
    const second = await callJson("/api/telemetry", { ...json({}), bearer: deviceToken });
    assert.equal(second.data.commands.filter((c: any) => c.action === "lock").length, 0);
  });

  test("Broadcast URL sets authoritative targetUrl and epoch in telemetry and reset restores portal", async () => {
    const { res: cmdRes } = await callJson("/api/command?tenant=greenwood", {
      ...json({ target: "all", action: "navigate", url: "https://scratch.mit.edu" }),
      cookie: schoolSessionCookie
    });
    assert.equal(cmdRes.status, 200);

    const telem = await callJson("/api/telemetry", { ...json({}), bearer: deviceToken });
    assert.equal(telem.res.status, 200);
    assert.equal(telem.data.targetUrl, "https://scratch.mit.edu/");
    assert.equal(telem.data.broadcastUrl, "https://scratch.mit.edu/");
    assert.ok(telem.data.broadcastEpoch > 0);

    const navCmd = telem.data.commands.find((c: any) => c.action === "navigate");
    assert.ok(navCmd);
    assert.equal(navCmd.url, "https://scratch.mit.edu/");
    assert.ok(navCmd.epoch > 0);

    // Reset broadcast to portal
    const { res: resetRes } = await callJson("/api/command?tenant=greenwood", {
      ...json({ target: "all", action: "navigate", url: "https://greenwood.labkiosk.akbhoi.com/", resetPortal: true }),
      cookie: schoolSessionCookie
    });
    assert.equal(resetRes.status, 200);

    const telemAfter = await callJson("/api/telemetry", { ...json({}), bearer: deviceToken });
    assert.equal(telemAfter.res.status, 200);
    assert.equal(telemAfter.data.targetUrl, "https://greenwood.labkiosk.akbhoi.com/");
    assert.equal(telemAfter.data.broadcastUrl, "");
  });

  test("Drops an oversized screen thumbnail instead of storing it", async () => {
    const huge = "data:image/jpeg;base64," + "A".repeat(300 * 1024);
    const { res } = await callJson("/api/telemetry", { ...json({ thumbnail: huge }), bearer: deviceToken });
    assert.equal(res.status, 200);

    const { data } = await callJson("/api/clients?tenant=greenwood", { cookie: schoolSessionCookie });
    const thumb = data.clients["PC-01"].thumbnail;
    assert.ok(!thumb || thumb.length < 300 * 1024, "an oversized thumbnail must not be persisted");
  });

  test("Revokes the device token when a workstation is decommissioned", async () => {
    const { res: removeRes } = await callJson("/api/clients/remove?tenant=greenwood", {
      ...json({ clientId: "PC-01" }),
      cookie: schoolSessionCookie
    });
    assert.equal(removeRes.status, 200);

    const afterRemoval = await call("/api/telemetry", { ...json({}), bearer: deviceToken });
    assert.equal(afterRemoval.status, 401, "a decommissioned workstation must not be able to re-register itself");
  });

  // ---------------------------------------------------------------- misc

  test("Keeps the domain allowlist separate per school", async () => {
    await callJson("/api/whitelist?tenant=greenwood", {
      ...json({ action: "add", domain: "https://nasa.gov/education" }),
      cookie: schoolSessionCookie
    });

    const { data: greenwood } = await callJson("/api/whitelist?tenant=greenwood", {
      cookie: schoolSessionCookie
    });
    assert.ok(greenwood.whitelist.includes("nasa.gov"), "the domain should be normalized to a bare hostname");

    const { data: riverside } = await callJson("/api/whitelist?tenant=riverside", {
      cookie: rivalSessionCookie
    });
    assert.ok(!riverside.whitelist.includes("nasa.gov"), "one school's allowlist must not leak into another's");
  });

  test("Records privileged actions in the audit log", async () => {
    const { res, data } = await callJson("/api/audit-logs?tenant=greenwood", { cookie: schoolSessionCookie });
    assert.equal(res.status, 200);
    const actions = data.logs.map((l: any) => l.action);
    assert.ok(actions.includes("command.lock"), "dispatched commands must be auditable");
    assert.ok(actions.includes("device.enroll"), "device enrolment must be auditable");
  });

  test("Responds to first-boot setup wizard status probe on /api/status", async () => {
    const { res, data } = await callJson("/api/status?tenant=greenwood");
    assert.equal(res.status, 200);
    assert.equal(data.status, "ok");
    assert.equal(data.subdomain, "greenwood");
    assert.equal(data.schoolName, "Greenwood High School");
    assert.equal(data.isActive, true);
  });

  test("Points an enrolled workstation at its own school, whatever host it used", async () => {
    // A workstation may reach the control plane on a host that cannot carry the
    // school name -- the Docker gateway, a *.workers.dev deployment, an IP. The
    // enrolment response must still send it to its school's portal rather than
    // to the public landing page.
    const expectations: Array<[string, RegExp]> = [
      ["greenwood.labkiosk.akbhoi.com", /^https:\/\/greenwood\.labkiosk\.akbhoi\.com\/$/],
      ["labkiosk.akbhoi.com", /^https:\/\/greenwood\.labkiosk\.akbhoi\.com\/$/],
      ["host.docker.internal", /\?tenant=greenwood$/],
      ["my-worker.acct.workers.dev", /\?tenant=greenwood$/]
    ];

    let n = 0;
    for (const [host, expected] of expectations) {
      const res = await worker.fetch(
        // URL and Host agree, as they always do in a real Worker request.
        new Request(`https://${host}/api/devices/enroll`, {
          method: "POST",
          headers: { "Content-Type": "application/json", host },
          body: JSON.stringify({ subdomain: "greenwood", clientId: `PORTALTEST-${++n}`, enrollmentKey })
        }),
        mockEnv
      );
      assert.equal(res.status, 200, `enrolment via ${host} should succeed`);
      const data = (await res.json()) as any;
      assert.match(data.targetUrl, expected, `wrong portal URL for a workstation enrolled via ${host}`);
    }
  });

  test("Only treats a host under DEFAULT_DOMAIN as a school subdomain", async () => {
    // A multi-label host that is not a school must not have its first label read
    // as one: `host.docker.internal` is the Docker gateway, and a worker deployed
    // at `my-worker.acct.workers.dev` serves its own landing page, not a school
    // called "my-worker". Both previously rendered "School Subdomain Not Found".
    for (const host of ["host.docker.internal", "my-worker.acct.workers.dev", "127.0.0.1"]) {
      const res = await worker.fetch(new Request("https://labkiosk.akbhoi.com/", { headers: { host } }), mockEnv);
      assert.equal(res.status, 200, `${host} should serve the landing page`);
      assert.match(await res.text(), /Centralized School Computer Lab/);
    }

    // A real school subdomain under the configured base domain still resolves.
    const school = await worker.fetch(
      new Request("https://labkiosk.akbhoi.com/", { headers: { host: "greenwood.labkiosk.akbhoi.com" } }),
      mockEnv
    );
    assert.equal(school.status, 200);
    assert.match(await school.text(), /Select an Educational Resource/);
  });

  // ---------------------------------------------------------- custom domains

  test("Allows School Admin to request a custom domain and validates domain syntax", async () => {
    // Reject invalid domain format
    const invalid = await callJson("/api/settings/custom-domain?tenant=greenwood", {
      ...json({ domain: "not-a-valid-domain" }),
      cookie: schoolSessionCookie
    });
    assert.equal(invalid.res.status, 400);

    // Accept valid FQDN
    const { res, data } = await callJson("/api/settings/custom-domain?tenant=greenwood", {
      ...json({ domain: "kiosk.greenwood.edu" }),
      cookie: schoolSessionCookie
    });
    assert.equal(res.status, 200);
    assert.equal(data.status, "ok");
    assert.equal(data.requestedCustomDomain, "kiosk.greenwood.edu");
    assert.equal(data.customDomainStatus, "pending");
  });

  test("Allows Super Admin to approve custom domain and routes traffic via Host header", async () => {
    const { res, data } = await callJson("/api/super/tenants/custom-domain/approve", {
      ...json({ subdomain: "greenwood", customDomain: "kiosk.greenwood.edu" }),
      cookie: superSessionCookie
    });
    assert.equal(res.status, 200);
    assert.equal(data.status, "ok");
    assert.equal(data.customDomain, "kiosk.greenwood.edu");

    // Edge routing via Host: kiosk.greenwood.edu now resolves Greenwood's portal
    const portal = await worker.fetch(
      new Request("https://kiosk.greenwood.edu/", { headers: { host: "kiosk.greenwood.edu" } }),
      mockEnv
    );
    assert.equal(portal.status, 200);
    const html = await portal.text();
    assert.match(html, /Protected Kiosk Session/);
    assert.match(html, /<title>Greenwood High School - Student Learning Portal<\/title>/);
    assert.match(html, /Select an Educational Resource/);
    assert.match(html, /Greenwood High School/);
    assert.ok(!html.includes("Centralized School Computer Lab Management"), "custom domain must not render landing page");
  });

  test("Enrols a workstation using customDomain", async () => {
    const { res, data } = await callJson(
      "/api/devices/enroll",
      json({ customDomain: "kiosk.greenwood.edu", clientId: "PC-CUSTOM", enrollmentKey })
    );
    assert.equal(res.status, 200);
    assert.equal(data.status, "ok");
    assert.equal(data.clientId, "PC-CUSTOM");
    assert.equal(data.schoolName, "Greenwood High School");
    assert.ok(data.deviceToken);

    // Verify custom domain is automatically included in client whitelist
    const telem = await callJson("/api/telemetry", { ...json({}), bearer: data.deviceToken });
    assert.equal(telem.res.status, 200);
    assert.ok(telem.data.whitelist.includes("kiosk.greenwood.edu"), "custom domain must be included in client whitelist");
  });

  test("Enrols a workstation using custom server URL or IP via enrollment key", async () => {
    const { res, data } = await callJson(
      "/api/devices/enroll",
      json({ customDomain: "http://host.docker.internal:8787", clientId: "PC-DOCKER", enrollmentKey })
    );
    assert.equal(res.status, 200);
    assert.equal(data.status, "ok");
    assert.equal(data.clientId, "PC-DOCKER");
    assert.equal(data.schoolName, "Greenwood High School");
    assert.ok(data.deviceToken);
  });

  test("Allows School Admin to disconnect custom domain", async () => {
    const { res, data } = await callJson("/api/settings/custom-domain?tenant=greenwood", {
      method: "DELETE",
      cookie: schoolSessionCookie
    });
    assert.equal(res.status, 200);
    assert.equal(data.status, "ok");
  });

  test("Configures Direct Single-Site Lockdown mode with custom URL and auto-whitelisting", async () => {
    // Enrol active workstation to test telemetry
    const { res: enrollRes, data: enrollData } = await callJson(
      "/api/devices/enroll",
      json({ subdomain: "greenwood", enrollmentKey, clientId: "PC-02" })
    );
    assert.equal(enrollRes.status, 200);
    deviceToken = enrollData.deviceToken;

    // 1. Rejects invalid non-http(s) URL
    const { res: badRes, data: badData } = await callJson("/api/settings/mode?tenant=greenwood", {
      ...json({ mode: "single_url", defaultUrl: "javascript:alert(1)" }),
      cookie: schoolSessionCookie
    });
    assert.equal(badRes.status, 400);
    assert.match(badData.error, /valid http\(s\) (URL|address)/i);

    // 2. Accepts valid LMS / exam platform URL
    const { res: okRes, data: okData } = await callJson("/api/settings/mode?tenant=greenwood", {
      ...json({ mode: "single_url", defaultUrl: "https://canvas.institution.edu" }),
      cookie: schoolSessionCookie
    });
    assert.equal(okRes.status, 200);
    assert.equal(okData.status, "ok");
    assert.equal(okData.mode, "single_url");
    assert.equal(okData.defaultUrl, "https://canvas.institution.edu/");

    // 3. Workstation telemetry receives the single-site lockdown target URL and auto-whitelisted domain
    const telem = await callJson("/api/telemetry", { ...json({}), bearer: deviceToken });
    assert.equal(telem.res.status, 200);
    assert.equal(telem.data.targetUrl, "https://canvas.institution.edu/");
    assert.ok(telem.data.whitelist.includes("canvas.institution.edu"), "target domain must be automatically whitelisted");

    // 4. Switching back to portal mode restores portal targetUrl
    const { res: portalRes, data: portalData } = await callJson("/api/settings/mode?tenant=greenwood", {
      ...json({ mode: "portal" }),
      cookie: schoolSessionCookie
    });
    assert.equal(portalRes.status, 200);
    assert.equal(portalData.mode, "portal");
  });

  test("Updates and retrieves institution customization and reflects on student portal", async () => {
    // 1. Update customization settings
    const { res: updateRes, data: updateData } = await callJson("/api/settings/customization?tenant=greenwood", {
      ...json({
        name: "MIT Robotics Lab",
        defaultLockMessage: "Class demonstration in progress. Please focus on the instructor.",
        portalTitle: "Robotics Workstation Portal",
        portalSubtitle: "Department of Mechanical Engineering",
        portalDescription: "Select an engineering simulation tool below:",
        portalFooter: "RESTRICTED LAB ENVIRONMENT • MIT COMPUTING"
      }),
      cookie: schoolSessionCookie
    });
    assert.equal(updateRes.status, 200);
    assert.equal(updateData.status, "ok");
    assert.equal(updateData.name, "MIT Robotics Lab");
    assert.equal(updateData.defaultLockMessage, "Class demonstration in progress. Please focus on the instructor.");

    // 2. GET /api/settings/customization returns the updated branding
    const { res: getRes, data: getData } = await callJson("/api/settings/customization?tenant=greenwood", {
      cookie: schoolSessionCookie
    });
    assert.equal(getRes.status, 200);
    assert.equal(getData.name, "MIT Robotics Lab");
    assert.equal(getData.portalTitle, "Robotics Workstation Portal");
    assert.equal(getData.portalSubtitle, "Department of Mechanical Engineering");
    assert.equal(getData.portalDescription, "Select an engineering simulation tool below:");
    assert.equal(getData.portalFooter, "RESTRICTED LAB ENVIRONMENT • MIT COMPUTING");

    // 3. Student portal renders the customized branding
    const portalHtml = await (await call("/?tenant=greenwood")).text();
    assert.ok(portalHtml.includes("Robotics Workstation Portal"), "portal title must be customized");
    assert.ok(portalHtml.includes("Department of Mechanical Engineering"), "portal subtitle must be customized");
    assert.ok(portalHtml.includes("Select an engineering simulation tool below:"), "portal description must be customized");
    assert.ok(portalHtml.includes("RESTRICTED LAB ENVIRONMENT • MIT COMPUTING"), "portal footer must be customized");

    // 4. Default lock screen announcement is used when no message is specified in lock command
    await callJson("/api/command?tenant=greenwood", {
      ...json({ target: "all", action: "lock" }),
      cookie: schoolSessionCookie
    });
    const telem = await callJson("/api/telemetry", { ...json({}), bearer: deviceToken });
    const lockCmd = telem.data.commands.find((c: any) => c.action === "lock");
    assert.ok(lockCmd);
    assert.equal(lockCmd.message, "Class demonstration in progress. Please focus on the instructor.");

    // Reset name back for remaining tests
    await callJson("/api/settings/customization?tenant=greenwood", {
      ...json({ name: "Greenwood High School" }),
      cookie: schoolSessionCookie
    });
  });

  test("Manages custom broadcast presets and shortcuts per tenant", async () => {
    // 1. Rejects invalid preset URL
    const { res: badRes } = await callJson("/api/broadcast-presets?tenant=greenwood", {
      ...json({ title: "Bad", url: "ftp://not-allowed" }),
      cookie: schoolSessionCookie
    });
    assert.equal(badRes.status, 400);

    // 2. Adds valid preset (also testing scheme-less input resolution)
    const { res: addRes, data: addData } = await callJson("/api/broadcast-presets?tenant=greenwood", {
      ...json({ title: "GitHub Classroom", url: "classroom.github.com" }),
      cookie: schoolSessionCookie
    });
    assert.equal(addRes.status, 200);
    assert.equal(addData.status, "ok");
    assert.ok(addData.preset.id);
    assert.equal(addData.preset.title, "GitHub Classroom");
    assert.equal(addData.preset.url, "https://classroom.github.com/");

    const presetId = addData.preset.id;

    // 2b. Broadcast preset domain is automatically whitelisted in workstation telemetry
    const presetTelem = await callJson("/api/telemetry", { ...json({}), bearer: deviceToken });
    assert.ok(presetTelem.data.whitelist.includes("classroom.github.com"), "broadcast preset domain must be automatically whitelisted");

    // 2c. Active broadcast URL is dynamically whitelisted in telemetry during broadcast
    await callJson("/api/command?tenant=greenwood", {
      ...json({ target: "all", action: "navigate", url: "https://custom-demo.org/simulation" }),
      cookie: schoolSessionCookie
    });
    const broadcastTelem = await callJson("/api/telemetry", { ...json({}), bearer: deviceToken });
    assert.ok(broadcastTelem.data.whitelist.includes("custom-demo.org"), "active broadcast domain must be dynamically whitelisted in telemetry");

    // 2d. Resetting broadcast restores authoritative portal target
    await callJson("/api/command?tenant=greenwood", {
      ...json({ target: "all", action: "navigate", resetPortal: true }),
      cookie: schoolSessionCookie
    });
    const resetTelem = await callJson("/api/telemetry", { ...json({}), bearer: deviceToken });
    assert.equal(resetTelem.data.broadcastUrl, "");

    // 3. Lists presets
    const { res: listRes, data: listData } = await callJson("/api/broadcast-presets?tenant=greenwood", {
      cookie: schoolSessionCookie
    });
    assert.equal(listRes.status, 200);
    const found = listData.presets.find((p: any) => p.id === presetId);
    assert.ok(found);
    assert.equal(found.title, "GitHub Classroom");

    // 4. Teacher dashboard includes the preset in rendered HTML
    const adminHtml = await (await call("/admin?tenant=greenwood", { cookie: schoolSessionCookie })).text();
    assert.ok(adminHtml.includes("GitHub Classroom"));

    // 5. Deletes preset
    const { res: delRes, data: delData } = await callJson(`/api/broadcast-presets/${presetId}?tenant=greenwood`, {
      method: "DELETE",
      cookie: schoolSessionCookie
    });
    assert.equal(delRes.status, 200);
    assert.equal(delData.status, "ok");

    // 6. Deleted preset no longer in list
    const { data: listAfter } = await callJson("/api/broadcast-presets?tenant=greenwood", {
      cookie: schoolSessionCookie
    });
    assert.ok(!listAfter.presets.some((p: any) => p.id === presetId));
  });

  // ------------------------------------------------- security headers & CSP

  test("Every HTML page carries a strict CSP whose nonce matches every script and no inline handlers", async () => {
    const pages: Array<[string, string | undefined]> = [
      ["/", undefined],
      ["/?login=1", undefined],
      ["/?tenant=greenwood", undefined],
      ["/admin?tenant=greenwood", schoolSessionCookie],
      ["/super", superSessionCookie]
    ];
    for (const [path, cookie] of pages) {
      const res = await call(path, cookie ? { cookie } : {});
      assert.equal(res.status, 200, `${path} should render`);
      const csp = res.headers.get("Content-Security-Policy") || "";
      const nonce = /script-src 'nonce-([^']+)'/.exec(csp)?.[1];
      assert.ok(nonce, `${path} must send a nonce-based script-src`);
      assert.match(csp, /frame-ancestors 'none'/);
      assert.match(csp, /object-src 'none'/);
      assert.equal(res.headers.get("Strict-Transport-Security"), "max-age=31536000; includeSubDomains");
      assert.equal(res.headers.get("Cross-Origin-Opener-Policy"), "same-origin");
      assert.ok(res.headers.get("Permissions-Policy"));

      const html = await res.text();
      const scripts = html.match(/<script\b[^>]*>/g) || [];
      assert.ok(scripts.length > 0, `${path} renders at least one script block`);
      for (const tag of scripts) {
        assert.ok(tag.includes(`nonce="${nonce}"`), `${path}: script tag without this response's nonce: ${tag}`);
      }
      // Only attributes inside a tag count; an escaped "&lt;img onerror=" in text is the XSS test doing its job.
      const inlineHandler = /<[a-z][^>]*\son[a-z]+=/i.exec(html);
      assert.equal(inlineHandler, null, `${path} must not contain inline event handler attributes: ${inlineHandler?.[0]}`);
    }
  });

  test("Uses a fresh nonce on every response", async () => {
    const first = (await call("/")).headers.get("Content-Security-Policy");
    const second = (await call("/")).headers.get("Content-Security-Policy");
    assert.notEqual(first, second);
  });

  // ------------------------------------------------------------ CSRF & logout

  test("Refuses a cookie-authenticated mutation from a cross-site origin", async () => {
    const crossSite = await call("/api/command?tenant=greenwood", {
      ...json({ target: "all", action: "unlock" }),
      cookie: schoolSessionCookie,
      headers: { Origin: "https://evil.example" }
    });
    assert.equal(crossSite.status, 403);

    const sameSite = await call("/api/command?tenant=greenwood", {
      ...json({ target: "all", action: "unlock" }),
      cookie: schoolSessionCookie,
      headers: { Origin: "https://greenwood.labkiosk.akbhoi.com" }
    });
    assert.equal(sameSite.status, 200);

    // A bearer-authenticated device never relies on a cookie, so Origin is irrelevant.
    const device = await call("/api/telemetry", {
      ...json({}),
      bearer: deviceToken,
      headers: { Origin: "https://evil.example" }
    });
    assert.equal(device.status, 200);
  });

  test("Signs out only on POST, never on a GET link", async () => {
    const viaGet = await call("/api/auth/logout", { cookie: schoolSessionCookie });
    assert.equal(viaGet.status, 405);
    const still = await callJson("/api/auth/me", { cookie: schoolSessionCookie });
    assert.ok(still.data.user, "a GET must not have ended the session");

    // Sign a throwaway session out properly.
    const { res: loginRes } = await callJson(
      "/api/auth/login",
      json({ email: "teacher@greenwood.edu", password: "SchoolPassword123!" })
    );
    const throwaway = loginRes.headers.get("Set-Cookie")!.split(";")[0];
    const viaPost = await call("/api/auth/logout", { method: "POST", cookie: throwaway });
    assert.equal(viaPost.status, 302);
    assert.match(viaPost.headers.get("Set-Cookie")!, /Max-Age=0/);
    const gone = await callJson("/api/auth/me", { cookie: throwaway });
    assert.equal(gone.data.user, null);
  });

  // ---------------------------------------------------------- password change

  test("Lets a signed-in user change their password and ends their other sessions", async () => {
    const { res: otherLogin } = await callJson(
      "/api/auth/login",
      json({ email: "teacher@riverside.edu", password: "RiversidePass456!" })
    );
    const otherCookie = otherLogin.headers.get("Set-Cookie")!.split(";")[0];

    const wrong = await callJson("/api/auth/change-password", {
      ...json({ currentPassword: "NotThePassword1", newPassword: "RiversideNewPass789!" }),
      cookie: rivalSessionCookie
    });
    assert.equal(wrong.res.status, 400);
    assert.match(wrong.data.error, /Current password is not correct/);

    const weak = await callJson("/api/auth/change-password", {
      ...json({ currentPassword: "RiversidePass456!", newPassword: "short" }),
      cookie: rivalSessionCookie
    });
    assert.equal(weak.res.status, 400);

    const ok = await callJson("/api/auth/change-password", {
      ...json({ currentPassword: "RiversidePass456!", newPassword: "RiversideNewPass789!" }),
      cookie: rivalSessionCookie
    });
    assert.equal(ok.res.status, 200);

    const stillMe = await callJson("/api/auth/me", { cookie: rivalSessionCookie });
    assert.ok(stillMe.data.user, "the session that changed the password stays signed in");
    const otherGone = await callJson("/api/auth/me", { cookie: otherCookie });
    assert.equal(otherGone.data.user, null, "every other session of that user is revoked");

    const oldPassword = await call("/api/auth/login", json({ email: "teacher@riverside.edu", password: "RiversidePass456!" }));
    assert.equal(oldPassword.status, 401);
    const newPassword = await call("/api/auth/login", json({ email: "teacher@riverside.edu", password: "RiversideNewPass789!" }));
    assert.equal(newPassword.status, 200);
  });

  // ------------------------------------------------------ registration rules

  test("Rejects reserved subdomains and implausible emails at registration", async () => {
    for (const subdomain of ["admin", "www", "super", "api"]) {
      const { res, data } = await callJson(
        "/api/auth/register",
        json({ name: "Reserved", email: `reserved-${subdomain}@school.edu`, password: "ReservedPass123!", subdomain })
      );
      assert.equal(res.status, 400, `${subdomain} must be refused`);
      assert.match(data.error, /reserved/);
    }
    const badEmail = await callJson(
      "/api/auth/register",
      json({ name: "Bad Email", email: "not-an-email", password: "BadEmailPass123!", subdomain: "bademail" })
    );
    assert.equal(badEmail.res.status, 400);
    assert.match(badEmail.data.error, /valid email/);

    const tooLong = await callJson(
      "/api/auth/register",
      json({ name: "Long", email: "long@school.edu", password: "LongSlugPass123!", subdomain: "a".repeat(64) })
    );
    assert.equal(tooLong.res.status, 400);
  });

  test("Accepts a scheme-less host:port as a valid URL", async () => {
    const { res, data } = await callJson("/api/broadcast-presets?tenant=greenwood", {
      ...json({ title: "Local LMS", url: "canvas.institution.edu:8080/courses" }),
      cookie: schoolSessionCookie
    });
    assert.equal(res.status, 200);
    assert.equal(data.preset.url, "https://canvas.institution.edu:8080/courses");
    await call(`/api/broadcast-presets/${data.preset.id}?tenant=greenwood`, { method: "DELETE", cookie: schoolSessionCookie });

    // Host:port followed directly by query parameter or hash fragment without trailing slash
    assert.equal(
      safeHttpUrl("canvas.institution.edu:8080?param=1#section"),
      "https://canvas.institution.edu:8080/?param=1#section"
    );
    assert.equal(safeHttpUrl("canvas.institution.edu:8080#section"), "https://canvas.institution.edu:8080/#section");
  });

  test("Checks domain boundaries case-insensitively with isHostUnder", () => {
    assert.equal(isHostUnder("School.LabKiosk.com", "labkiosk.com"), true);
    assert.equal(isHostUnder("SCHOOL.LABKIOSK.COM", ".LabKiosk.COM"), true);
    assert.equal(isHostUnder("greenwood.labkiosk.akbhoi.com", "labkiosk.akbhoi.com"), true);
    assert.equal(isHostUnder("not-labkiosk.com", "labkiosk.com"), false);
    assert.equal(isHostUnder("fakelabkiosk.com", "labkiosk.com"), false);
    assert.equal(isHostUnder("labkiosk.com", undefined), false);
  });

  // --------------------------------------------------------- remote control

  test("Stores the remote-control details a workstation reports and shows them to its teacher", async () => {
    const reported = await callJson("/api/telemetry", {
      ...json({ vncPassword: "s3cr3t42", remoteHost: "PC-02.lab.greenwood.edu" }),
      bearer: deviceToken
    });
    assert.equal(reported.res.status, 200);

    let { data } = await callJson("/api/clients?tenant=greenwood", { cookie: schoolSessionCookie });
    assert.equal(data.clients["PC-02"].vncPassword, "s3cr3t42");
    assert.equal(data.clients["PC-02"].remoteHost, "pc-02.lab.greenwood.edu");

    // A heartbeat that omits them keeps what is known; a garbage host is ignored.
    await callJson("/api/telemetry", { ...json({ remoteHost: "not a host!" }), bearer: deviceToken });
    ({ data } = await callJson("/api/clients?tenant=greenwood", { cookie: schoolSessionCookie }));
    assert.equal(data.clients["PC-02"].vncPassword, "s3cr3t42");
    assert.equal(data.clients["PC-02"].remoteHost, "pc-02.lab.greenwood.edu");

    // Another school's teacher never sees them.
    const rival = await call("/api/clients?tenant=greenwood", { cookie: rivalSessionCookie });
    assert.equal(rival.status, 403);
  });

  test("Keeps broadcast state in the database rather than in worker memory", async () => {
    assert.equal((workerModule as any).tenantBroadcastState, undefined, "the in-memory broadcast map must be gone");
    await callJson("/api/command?tenant=greenwood", {
      ...json({ target: "all", action: "navigate", url: "https://phet.colorado.edu/en/simulations" }),
      cookie: schoolSessionCookie
    });
    const telem = await callJson("/api/telemetry", { ...json({}), bearer: deviceToken });
    assert.equal(telem.data.broadcastUrl, "https://phet.colorado.edu/en/simulations");
    await callJson("/api/command?tenant=greenwood", {
      ...json({ target: "all", action: "navigate", resetPortal: true }),
      cookie: schoolSessionCookie
    });
    const after = await callJson("/api/telemetry", { ...json({}), bearer: deviceToken });
    assert.equal(after.data.broadcastUrl, "");
  });

  // --------------------------------------------------------- suspend school

  test("Lets the super admin suspend and reactivate a school", async () => {
    const meRes = await callJson("/api/auth/me", { cookie: schoolSessionCookie });
    const tenantId = meRes.data.tenant.id;

    const asTeacher = await call("/api/super/tenants/suspend", { ...json({ tenantId }), cookie: schoolSessionCookie });
    assert.equal(asTeacher.status, 403);

    const suspend = await callJson("/api/super/tenants/suspend", { ...json({ tenantId }), cookie: superSessionCookie });
    assert.equal(suspend.res.status, 200);
    assert.equal(suspend.data.tenantStatus, "suspended");

    const portal = await call("/?tenant=greenwood");
    assert.equal(portal.status, 403);
    assert.match(await portal.text(), /School Suspended/);
    const telem = await call("/api/telemetry", { ...json({}), bearer: deviceToken });
    assert.equal(telem.status, 403);
    const enrol = await call("/api/devices/enroll", json({ subdomain: "greenwood", enrollmentKey, clientId: "PC-SUSPENDED" }));
    assert.equal(enrol.status, 403);

    const again = await call("/api/super/tenants/suspend", { ...json({ tenantId }), cookie: superSessionCookie });
    assert.equal(again.status, 400, "a suspended school cannot be suspended twice");

    const reactivate = await callJson("/api/super/tenants/reactivate", { ...json({ tenantId }), cookie: superSessionCookie });
    assert.equal(reactivate.res.status, 200);
    assert.equal((await call("/?tenant=greenwood")).status, 200);
    assert.equal((await call("/api/telemetry", { ...json({}), bearer: deviceToken })).status, 200);
  });

  // ------------------------------------------------------------ housekeeping

  test("Runs the scheduled housekeeping handler", async () => {
    await worker.scheduled({} as ScheduledEvent, mockEnv);
    const me = await callJson("/api/auth/me", { cookie: schoolSessionCookie });
    assert.ok(me.data.user, "a live session survives housekeeping");
  });

  // ---------------------------------------------------- throttles (run last)

  test("Throttles repeated failed enrolments from one address", async () => {
    let throttled = false;
    for (let i = 0; i < 15 && !throttled; i++) {
      const res = await call(
        "/api/devices/enroll",
        json({ subdomain: "greenwood", enrollmentKey: "AAAAA-BBBBB-CCCCC-DDDDD", clientId: `PC-BAD-${i}` })
      );
      if (res.status === 429) throttled = true;
      else assert.equal(res.status, 401);
    }
    assert.ok(throttled, "repeated wrong keys must eventually answer 429");
  });

  test("Throttles repeated registrations from one address", async () => {
    let throttled = false;
    for (let i = 0; i < 15 && !throttled; i++) {
      const res = await call(
        "/api/auth/register",
        json({ name: `Bulk ${i}`, email: `bulk-${i}@school.edu`, password: "BulkRegisterPass123!", subdomain: `bulk-${i}` })
      );
      if (res.status === 429) throttled = true;
      else assert.equal(res.status, 200);
    }
    assert.ok(throttled, "mass registration from one address must eventually answer 429");
  });

  test("Refuses to run without a database binding unless explicitly allowed", async () => {
    await assert.rejects(
      () => worker.fetch(request("/"), { DEFAULT_DOMAIN: "labkiosk.akbhoi.com" } as Env),
      /No D1 database bound/
    );
  });

  test("Refuses to serve a bound database that has not been migrated", async () => {
    const empty = createLocalD1Database();
    await assert.rejects(
      () => worker.fetch(request("/"), { DEFAULT_DOMAIN: "labkiosk.akbhoi.com", DB: empty, SUPER_ADMIN_EMAIL: "a@b.co", SUPER_ADMIN_PASSWORD: "x" } as Env),
      /migrations apply/
    );
  });

  test("Refuses to seed the default super admin against a real database", async () => {
    const migrated = createLocalD1Database();
    await initSchema(migrated);
    await assert.rejects(
      () => worker.fetch(request("/"), { DEFAULT_DOMAIN: "labkiosk.akbhoi.com", DB: migrated } as Env),
      /SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD must both be set/
    );
    await assert.rejects(
      () => worker.fetch(request("/"), { DEFAULT_DOMAIN: "labkiosk.akbhoi.com", DB: migrated, SUPER_ADMIN_EMAIL: "owner@school.edu" } as Env),
      /must both be set/
    );
    // With both secrets present the same database serves normally.
    const res = await worker.fetch(request("/"), {
      DEFAULT_DOMAIN: "labkiosk.akbhoi.com",
      DB: migrated,
      SUPER_ADMIN_EMAIL: "owner@school.edu",
      SUPER_ADMIN_PASSWORD: "OwnerPassword2026!"
    } as Env);
    assert.equal(res.status, 200);
  });

  test("Interface catalogs: only a super admin may upload one", async () => {
    const anonymous = await callJson("/api/super/i18n", json({ tag: "hi-IN", catalog: {} }));
    assert.ok(anonymous.res.status === 401 || anonymous.res.status === 403, "anonymous upload must be refused");

    const schoolAdmin = await callJson("/api/super/i18n", {
      ...json({ tag: "hi-IN", catalog: {} }),
      cookie: schoolSessionCookie
    });
    assert.equal(schoolAdmin.res.status, 403, "a school admin is not a platform admin");
  });

  test("Interface catalogs: a cross-site upload is refused", async () => {
    const res = await worker.fetch(
      new Request(`${BASE}/api/super/i18n`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Cookie: superSessionCookie,
          Origin: "https://evil.example"
        },
        body: JSON.stringify({ tag: "hi-IN", catalog: {} })
      }),
      mockEnv
    );
    assert.equal(res.status, 403);
  });

  test("Interface catalogs: a malformed one is rejected rather than stored", async () => {
    const badTag = await callJson("/api/super/i18n", {
      ...json({ tag: "not a tag", catalog: {} }),
      cookie: superSessionCookie
    });
    assert.equal(badTag.res.status, 400);

    const badValue = await callJson("/api/super/i18n", {
      ...json({ tag: "hi-IN", catalog: { "bar.home": 42 } }),
      cookie: superSessionCookie
    });
    assert.equal(badValue.res.status, 400);
    assert.match(badValue.data.error, /not a string/);

    const notAnObject = await callJson("/api/super/i18n", {
      ...json({ tag: "hi-IN", catalog: ["bar.home"] }),
      cookie: superSessionCookie
    });
    assert.equal(notAnObject.res.status, 400);
  });

  test("Interface catalogs: uploaded once, any workstation can fetch it without a session", async () => {
    const upload = await callJson("/api/super/i18n", {
      ...json({
        tag: "hi-IN",
        name: "\\u0939\\u093f\\u0928\\u094d\\u0926\\u0940",
        catalog: {
          _meta: { name: "\\u0939\\u093f\\u0928\\u094d\\u0926\\u0940", direction: "ltr" },
          "bar.home": "\\u092e\\u0941\\u0916\\u094d\\u092f \\u092a\\u0943\\u0937\\u094d\\u0920"
        }
      }),
      cookie: superSessionCookie
    });
    assert.equal(upload.res.status, 200);
    assert.equal(upload.data.entries, 1, "_meta is not counted as a string");

    // No cookie, no device token: this is what a workstation does before it is
    // enrolled, which is exactly when it needs its interface language.
    const listed = await callJson("/api/i18n");
    assert.equal(listed.res.status, 200);
    assert.ok(listed.data.languages.some((l: any) => l.tag === "hi-IN"));

    const fetched = await callJson("/i18n/hi-IN.json");
    assert.equal(fetched.res.status, 200);
    assert.equal(fetched.data["bar.home"], "\\u092e\\u0941\\u0916\\u094d\\u092f \\u092a\\u0943\\u0937\\u094d\\u0920");
    assert.equal(fetched.data._meta.direction, "ltr");

    const missing = await call("/i18n/zz-ZZ.json");
    assert.equal(missing.status, 404);

    const traversal = await call("/i18n/..%2F..%2Fapi%2Fclients.json");
    assert.equal(traversal.status, 404);
  });

  test("Interface catalogs: only a super admin may withdraw one", async () => {
    const anonymous = await call("/api/super/i18n/hi-IN", { method: "DELETE" });
    assert.ok(anonymous.status === 401 || anonymous.status === 403);

    const removed = await callJson("/api/super/i18n/hi-IN", { method: "DELETE", cookie: superSessionCookie });
    assert.equal(removed.res.status, 200);

    const gone = await call("/i18n/hi-IN.json");
    assert.equal(gone.status, 404);
  });

  test("Interface catalogs: super admin may list catalogs via /api/super/i18n", async () => {
    const anonymous = await call("/api/super/i18n");
    assert.ok(anonymous.status === 401 || anonymous.status === 403);

    const listed = await callJson("/api/super/i18n", { cookie: superSessionCookie });
    assert.equal(listed.res.status, 200);
    assert.ok(Array.isArray(listed.data.languages));
  });

  test("Interface catalogs: super admin console renders catalogs table", async () => {
    await callJson("/api/super/i18n", {
      ...json({
        tag: "fr-FR",
        name: "Français",
        catalog: {
          _meta: { name: "Français", direction: "ltr" },
          "bar.home": "Accueil"
        }
      }),
      cookie: superSessionCookie
    });

    const page = await call("/super/catalogs", { cookie: superSessionCookie });
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.ok(html.includes("Workstation Interface Catalogs (i18n)"));
    assert.ok(html.includes("fr-FR"));
    assert.ok(html.includes("Français"));

    await callJson("/api/super/i18n/fr-FR", { method: "DELETE", cookie: superSessionCookie });
  });

  test("Super console renders one tab at a time", async () => {
    // The four panes were emitted together and hidden with an inline `display`,
    // except the schools directory, which had neither a display rule nor any
    // matching CSS -- so every tenant row rendered on the approvals, catalogs
    // and system pages too.
    const directoryHeading = "Registered Schools &amp; Institutions";

    const schools = await (await call("/super/schools", { cookie: superSessionCookie })).text();
    assert.ok(schools.includes(directoryHeading), "schools tab shows the directory");

    for (const tab of ["/super/approvals", "/super/catalogs", "/super/system"]) {
      const res = await call(tab, { cookie: superSessionCookie });
      assert.equal(res.status, 200);
      const body = await res.text();
      assert.ok(!body.includes(directoryHeading), tab + " must not leak the schools directory");
    }

    const approvals = await (await call("/super/approvals", { cookie: superSessionCookie })).text();
    assert.ok(approvals.includes("Pending Subdomain Requests"));
    const system = await (await call("/super/system", { cookie: superSessionCookie })).text();
    assert.ok(system.includes("Platform Architecture"));
    assert.ok(!system.includes("Pending Subdomain Requests"));
  });

  // ------------------------------------------ modern admin & privacy isolation

  test("Super admin is restricted from school consoles but allowed on demo tenant", async () => {
    // 1. Super admin attempts to access greenwood school console -> 403 Forbidden
    const deniedRes = await call("/admin?tenant=greenwood", { cookie: superSessionCookie });
    assert.equal(deniedRes.status, 403);
    const deniedHtml = await deniedRes.text();
    assert.match(deniedHtml, /You do not have access to that school(?:'|&#39;)s console/);

    // 2. Super admin accesses demo tenant console -> 200 OK
    const demoRes = await call("/admin?tenant=demo", { cookie: superSessionCookie });
    assert.equal(demoRes.status, 200);
    const demoHtml = await demoRes.text();
    assert.match(demoHtml, /Workstation Grid &amp; Remote Control/);
  });

  test("Redirects /admin on apex domain to appropriate tenant subdomain or super console", async () => {
    // School admin without tenant query param on apex -> 302 to https://greenwood.labkiosk.akbhoi.com/admin
    const schoolRes = await call("/admin", { cookie: schoolSessionCookie });
    assert.equal(schoolRes.status, 302);
    assert.equal(schoolRes.headers.get("Location"), "https://greenwood.labkiosk.akbhoi.com/admin");

    // Super admin without tenant query param on apex -> 302 to https://labkiosk.akbhoi.com/super
    const superRes = await call("/admin", { cookie: superSessionCookie });
    assert.equal(superRes.status, 302);
    assert.equal(superRes.headers.get("Location"), "https://labkiosk.akbhoi.com/super");
  });

  test("Renders all dedicated multi-page school admin sub-routes with CSP nonces", async () => {
    const routes = [
      ["/admin/workstations?tenant=greenwood", /Workstation Grid &amp; Remote Control/],
      ["/admin/broadcast?tenant=greenwood", /Lesson Broadcast Center/],
      ["/admin/portal?tenant=greenwood", /Student Learning Portal Manager/],
      ["/admin/whitelist?tenant=greenwood", /Allowed Educational Domains/],
      ["/admin/teachers?tenant=greenwood", /Teachers &amp; Sub-Admin Delegation/],
      ["/admin/settings?tenant=greenwood", /Lab Settings &amp; Configuration/]
    ] as const;

    for (const [route, pattern] of routes) {
      const res = await call(route, { cookie: schoolSessionCookie });
      assert.equal(res.status, 200, `${route} should return 200`);
      const csp = res.headers.get("Content-Security-Policy") || "";
      assert.match(csp, /script-src 'nonce-[^']+'/);
      const html = await res.text();
      assert.match(html, pattern, `${route} should contain expected heading`);
    }
  });

  test("Manages teachers and sub-admin delegation with granular permissions", async () => {
    // 1. School admin creates a sub-admin teacher with specific permissions
    const { res: createRes, data: createData } = await callJson("/api/tenant/teachers?tenant=greenwood", {
      ...json({
        name: "Assistant Teacher Bob",
        email: "bob@greenwood.edu",
        role: "sub_admin",
        permissions: ["workstations", "broadcast"]
      }),
      cookie: schoolSessionCookie
    });
    assert.equal(createRes.status, 200);
    assert.equal(createData.status, "ok");
    const teacherId = createData.teacher.id;
    assert.ok(teacherId);
    assert.equal(createData.teacher.name, "Assistant Teacher Bob");
    assert.deepEqual(createData.teacher.permissions, ["workstations", "broadcast"]);

    // 2. List teachers for the school
    const { res: listRes, data: listData } = await callJson("/api/tenant/teachers?tenant=greenwood", {
      cookie: schoolSessionCookie
    });
    assert.equal(listRes.status, 200);
    assert.ok(Array.isArray(listData.teachers));
    const found = listData.teachers.find((t: any) => t.id === teacherId);
    assert.ok(found);
    assert.equal(found.role, "sub_admin");

    // 3. Update teacher role/permissions
    const { res: updateRes, data: updateData } = await callJson("/api/tenant/teachers/update?tenant=greenwood", {
      ...json({
        id: teacherId,
        role: "teacher",
        permissions: ["workstations"]
      }),
      cookie: schoolSessionCookie
    });
    assert.equal(updateRes.status, 200);
    assert.equal(updateData.status, "ok");

    // 4. Delete the teacher
    const { res: delRes, data: delData } = await callJson(`/api/tenant/teachers/${teacherId}?tenant=greenwood`, {
      method: "DELETE",
      cookie: schoolSessionCookie
    });
    assert.equal(delRes.status, 200);
    assert.equal(delData.status, "ok");

    // 5. Verify deleted from list
    const { data: listAfter } = await callJson("/api/tenant/teachers?tenant=greenwood", {
      cookie: schoolSessionCookie
    });
    assert.ok(!listAfter.teachers.some((t: any) => t.id === teacherId));
  });

  test("Delegated teacher login, session scoping, and granular permissions enforcement", async () => {
    // 1. School admin creates a teacher with password and ONLY workstations permission
    const { res: createRes, data: createData } = await callJson("/api/tenant/teachers?tenant=greenwood", {
      ...json({
        name: "Math Teacher Alice",
        email: "alice@greenwood.edu",
        password: "AlicePassword123!",
        role: "teacher",
        permissions: ["workstations"]
      }),
      cookie: schoolSessionCookie
    });
    assert.equal(createRes.status, 200);
    assert.equal(createData.status, "ok");
    const teacherId = createData.teacher.id;

    // 2. Teacher logs in via /api/auth/login
    const { res: loginRes, data: loginData } = await callJson("/api/auth/login", {
      ...json({
        email: "alice@greenwood.edu",
        password: "AlicePassword123!"
      })
    });
    assert.equal(loginRes.status, 200);
    assert.equal(loginData.status, "ok");
    assert.equal(loginData.subdomain, "greenwood");

    const teacherCookie = loginRes.headers.get("Set-Cookie")!.split(";")[0];

    // 3. /api/auth/me returns permissions and tenantRole
    const { res: meRes, data: meData } = await callJson("/api/auth/me", {
      cookie: teacherCookie
    });
    assert.equal(meRes.status, 200);
    assert.equal(meData.user.email, "alice@greenwood.edu");
    assert.equal(meData.tenantRole, "teacher");
    assert.deepEqual(meData.permissions, ["workstations"]);

    // 4. Allowed: Teacher can view workstations list via /api/clients
    const { res: clientsRes } = await callJson("/api/clients?tenant=greenwood", {
      cookie: teacherCookie
    });
    assert.equal(clientsRes.status, 200);

    // 5. Allowed: Teacher can dispatch workstation lock command
    const { res: lockRes, data: lockData } = await callJson("/api/command?tenant=greenwood", {
      ...json({ target: "all", action: "lock" }),
      cookie: teacherCookie
    });
    assert.equal(lockRes.status, 200);
    assert.equal(lockData.status, "ok");

    // 6. Refused: Teacher without 'broadcast' cannot dispatch navigate command
    const { res: navRes } = await callJson("/api/command?tenant=greenwood", {
      ...json({ target: "all", action: "navigate", url: "https://khanacademy.org" }),
      cookie: teacherCookie
    });
    assert.equal(navRes.status, 403);

    // 7. Refused: Teacher without 'portal' cannot create portal sites
    const { res: portalRes } = await callJson("/api/portal-sites?tenant=greenwood", {
      ...json({ title: "Alice Site", url: "https://alicesite.org" }),
      cookie: teacherCookie
    });
    assert.equal(portalRes.status, 403);

    // 8. Refused: Teacher without 'whitelist' cannot modify allowlist
    const { res: wlRes } = await callJson("/api/whitelist?tenant=greenwood", {
      ...json({ action: "add", domain: "unauthorized.org" }),
      cookie: teacherCookie
    });
    assert.equal(wlRes.status, 403);

    // 9. Refused: Teacher without 'settings' cannot modify subdomain or settings
    const { res: subRes } = await callJson("/api/settings/subdomain?tenant=greenwood", {
      ...json({ subdomain: "hacked" }),
      cookie: teacherCookie
    });
    assert.equal(subRes.status, 403);

    // 10. Dashboard navigation: Visiting /admin/broadcast without broadcast perm redirects to /admin
    const bcastPageRes = await call("/admin/broadcast?tenant=greenwood", {
      cookie: teacherCookie
    });
    assert.equal(bcastPageRes.status, 302);
    assert.match(bcastPageRes.headers.get("Location") || "", /\/admin(\?|$)/);

    // Clean up teacher
    await callJson(`/api/tenant/teachers/${teacherId}?tenant=greenwood`, {
      method: "DELETE",
      cookie: schoolSessionCookie
    });
  });

  test("Unauthenticated /admin on subdomain redirects to landing page with tenant param", async () => {
    // Simulated subdomain request: Host = greenwood.labkiosk.akbhoi.com
    const req = new Request("https://greenwood.labkiosk.akbhoi.com/admin", {
      headers: { Host: "greenwood.labkiosk.akbhoi.com" }
    });
    const res = await worker.fetch(req, mockEnv);
    assert.equal(res.status, 302);
    const loc = res.headers.get("Location") || "";
    assert.equal(loc, "https://labkiosk.akbhoi.com/?login=1&tenant=greenwood");
  });

  test("Allows school admin to update subdomain and enforces slug validation", async () => {
    // 1. Reject invalid subdomain
    const { res: badRes, data: badData } = await callJson("/api/tenant/subdomain?tenant=greenwood", {
      ...json({ subdomain: "ab" }),
      cookie: schoolSessionCookie
    });
    assert.equal(badRes.status, 400);
    assert.match(badData.error, /3-63 characters/);

    // 2. Reject reserved slug
    const { res: resvRes, data: resvData } = await callJson("/api/tenant/subdomain?tenant=greenwood", {
      ...json({ subdomain: "admin" }),
      cookie: schoolSessionCookie
    });
    assert.equal(resvRes.status, 400);
    assert.match(resvData.error, /reserved/);

    // 3. Reject duplicate subdomain (already claimed by riverside)
    const { res: dupRes, data: dupData } = await callJson("/api/tenant/subdomain?tenant=greenwood", {
      ...json({ subdomain: "riverside" }),
      cookie: schoolSessionCookie
    });
    assert.equal(dupRes.status, 400);
    assert.match(dupData.error, /already claimed/);

    // 4. Successfully update subdomain to greenwood-high
    const { res: okRes, data: okData } = await callJson("/api/tenant/subdomain?tenant=greenwood", {
      ...json({ subdomain: "greenwood-high" }),
      cookie: schoolSessionCookie
    });
    assert.equal(okRes.status, 200);
    assert.equal(okData.status, "ok");
    assert.equal(okData.subdomain, "greenwood-high");

    // Restore subdomain back to greenwood for subsequent tests
    await callJson("/api/tenant/subdomain?tenant=greenwood-high", {
      ...json({ subdomain: "greenwood" }),
      cookie: schoolSessionCookie
    });
  });

  test("Updates lab settings including custom home route and tunnel domain", async () => {
    // 1. Update settings
    const { res: setRes, data: setData } = await callJson("/api/tenant/settings?tenant=greenwood", {
      ...json({
        homeRoute: "/home",
        tunnelDomain: "custom-tunnel.school.edu",
        portalTitle: "Greenwood STEM Portal"
      }),
      cookie: schoolSessionCookie
    });
    assert.equal(setRes.status, 200);
    assert.equal(setData.status, "ok");
    assert.equal(setData.updates.home_route, "/home");
    assert.equal(setData.updates.tunnel_domain, "custom-tunnel.school.edu");

    // 2. /home route serves the student portal
    const homeRes = await call("/home?tenant=greenwood");
    assert.equal(homeRes.status, 200);
    const homeHtml = await homeRes.text();
    assert.match(homeHtml, /Greenwood STEM Portal/);

    // Reset settings
    await callJson("/api/tenant/settings?tenant=greenwood", {
      ...json({ homeRoute: "/", tunnelDomain: "" }),
      cookie: schoolSessionCookie
    });
  });

  test("Serves Privacy Policy and Terms of Service compliance pages", async () => {
    // /privacy
    const privRes = await call("/privacy");
    assert.equal(privRes.status, 200);
    const privHtml = await privRes.text();
    assert.match(privHtml, /Privacy Policy/);
    assert.match(privHtml, /FERPA/);
    assert.match(privHtml, /COPPA/);
    assert.match(privHtml, /100% In-Memory RAM Overlay/);
    const privCsp = privRes.headers.get("Content-Security-Policy") || "";
    assert.match(privCsp, /script-src 'nonce-[^']+'/);

    // /terms
    const termsRes = await call("/terms");
    assert.equal(termsRes.status, 200);
    const termsHtml = await termsRes.text();
    assert.match(termsHtml, /Terms of Service/);
    assert.match(termsHtml, /Educational Use/);
    assert.match(termsHtml, /45-Computer/);
    assert.match(termsHtml, /Subscriber Licensing/);
    assert.match(termsHtml, /Institution Responsibilities/);
    const termsCsp = termsRes.headers.get("Content-Security-Policy") || "";
    assert.match(termsCsp, /script-src 'nonce-[^']+'/);
  });
});

/**
 * `SCHEMA_SQL` in db.ts builds the in-memory database the tests and `wrangler
 * dev` run against; `migrations/` is what a deployed D1 actually has. They are
 * two hand-maintained copies of one schema, so they drift silently unless
 * something compares them -- and a drifted adapter makes the whole suite test a
 * shape production does not have.
 */
describe("Schema sources agree", () => {
  const readMigrations = () => {
    // String paths, not URL objects: this project's `URL` is the Workers one,
    // which is not assignable to the `URL` node:fs expects.
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .map((f) => fs.readFileSync(path.join(dir, f), "utf8"))
      .join("\n");
  };

  /** Every table and its column names, as declared by a bundle of SQL. */
  function tableColumns(sql: string): Map<string, Set<string>> {
    const stripped = sql.replace(/--[^\n]*/g, "");
    const tables = new Map<string, Set<string>>();

    const createRe = /CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(([\s\S]*?)\n\s*\);/g;
    for (const [, name, bodyText] of stripped.matchAll(createRe)) {
      const columns = new Set<string>();
      let depth = 0;
      let current = "";
      for (const ch of bodyText) {
        if (ch === "(") depth++;
        if (ch === ")") depth--;
        if (ch === "," && depth === 0) {
          columns.add(current.trim().split(/\s+/)[0]);
          current = "";
        } else {
          current += ch;
        }
      }
      if (current.trim()) columns.add(current.trim().split(/\s+/)[0]);
      // Table-level constraints are not columns.
      for (const keyword of ["UNIQUE", "PRIMARY", "FOREIGN", "CHECK", "CONSTRAINT"]) {
        columns.delete(keyword);
      }
      tables.set(name, columns);
    }

    // Columns added by a later migration belong to the table too.
    const alterRe = /ALTER TABLE\s+(\w+)\s+ADD COLUMN\s+(\w+)/g;
    for (const [, table, column] of stripped.matchAll(alterRe)) {
      tables.get(table)?.add(column);
    }

    return tables;
  }

  test("db.ts SCHEMA_SQL declares the same tables and columns as migrations/", () => {
    const fromMigrations = tableColumns(readMigrations());
    const fromAdapter = tableColumns(SCHEMA_SQL);

    assert.deepEqual(
      [...fromAdapter.keys()].sort(),
      [...fromMigrations.keys()].sort(),
      "SCHEMA_SQL and migrations/ declare different tables"
    );

    for (const [table, migrationColumns] of fromMigrations) {
      assert.deepEqual(
        [...(fromAdapter.get(table) ?? [])].sort(),
        [...migrationColumns].sort(),
        `Columns of "${table}" differ between SCHEMA_SQL and migrations/`
      );
    }
  });
});
