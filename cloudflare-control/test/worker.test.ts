import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import worker from "../src/index";
import { SCHEMA_SQL } from "../src/db";
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
    for (const id of ["vnc-modal", "url-modal", "lock-modal", "whitelist-modal", "portal-modal", "settings-modal"]) {
      const start = body.indexOf(`<div class="modal-overlay" id="${id}">`);
      assert.notEqual(start, -1, `${id} overlay not found in the rendered dashboard`);
      const before = body.slice(0, start);
      const depth = (before.match(/<div\b/g) || []).length - (before.match(/<\/div>/g) || []).length;
      assert.equal(depth, 0, `${id} must not be nested inside another modal`);
    }
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
      ["/api/audit-logs?tenant=greenwood", {}]
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
    assert.match(html, /Select an Educational Resource/);
    assert.match(html, /Greenwood High School/);
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

  test("Refuses to run without a database binding unless explicitly allowed", async () => {
    await assert.rejects(
      () => worker.fetch(request("/"), { DEFAULT_DOMAIN: "labkiosk.akbhoi.com" } as Env),
      /No D1 database bound/
    );
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
