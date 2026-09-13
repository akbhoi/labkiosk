import { test, describe } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index";
import { Env } from "../src/types";

const mockEnv: Env = {
  DEFAULT_DOMAIN: "labkiosk.io",
  SUPER_ADMIN_EMAIL: "admin@labkiosk.io",
  SUPER_ADMIN_PASSWORD: "SuperAdminPassword2026!"
};

describe("Multi-Tenant Lab Kiosk SaaS Platform", () => {
  let schoolSessionCookie = "";
  let superSessionCookie = "";
  let createdSiteId = "";

  test("Serves Public SaaS Landing Page on root /", async () => {
    const req = new Request("https://labkiosk.io/");
    const res = await worker.fetch(req, mockEnv);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Content-Type"), "text/html; charset=utf-8");
    const html = await res.text();
    assert.match(html, /Centralized School Computer Lab/);
    assert.match(html, /Download Kiosk ISO/);
    assert.match(html, /Register School Lab/);
  });

  test("Registers new school admin and claims subdomain", async () => {
    const payload = {
      name: "Greenwood High School",
      email: "teacher@greenwood.edu",
      password: "SchoolPassword123!",
      subdomain: "greenwood"
    };

    const req = new Request("https://labkiosk.io/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });

    const res = await worker.fetch(req, mockEnv);
    assert.equal(res.status, 200);
    const data = (await res.json()) as any;
    assert.equal(data.status, "ok");
    assert.equal(data.subdomain, "greenwood");

    const cookie = res.headers.get("Set-Cookie");
    assert.ok(cookie && cookie.includes("labkiosk_session="));
    schoolSessionCookie = cookie.split(";")[0];
  });

  test("Logs in as Super Admin and accesses Super Admin Console on /super", async () => {
    // 1. Log in with Super Admin credentials
    const loginReq = new Request("https://labkiosk.io/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        email: "admin@labkiosk.io",
        password: "SuperAdminPassword2026!"
      })
    });

    const loginRes = await worker.fetch(loginReq, mockEnv);
    assert.equal(loginRes.status, 200);
    const loginData = (await loginRes.json()) as any;
    assert.equal(loginData.status, "ok");
    assert.equal(loginData.role, "super_admin");

    const cookie = loginRes.headers.get("Set-Cookie");
    assert.ok(cookie);
    superSessionCookie = cookie.split(";")[0];

    // 2. Fetch /super with super admin session
    const superReq = new Request("https://labkiosk.io/super", {
      headers: { Cookie: superSessionCookie }
    });
    const superRes = await worker.fetch(superReq, mockEnv);
    assert.equal(superRes.status, 200);
    const html = await superRes.text();
    assert.match(html, /Super Admin Master Console/);
    assert.match(html, /Greenwood High School/);
  });

  test("Serves Student Learning Portal on school subdomain /", async () => {
    const req = new Request("https://labkiosk.io/?tenant=greenwood");
    const res = await worker.fetch(req, mockEnv);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Content-Type"), "text/html; charset=utf-8");
    const html = await res.text();
    assert.match(html, /Greenwood High School/);
    assert.match(html, /Select an Educational Resource/);
    assert.match(html, /Khan Academy/);
    assert.match(html, /Scratch Studio/);
  });

  test("Adds and deletes a custom app card in Student Portal", async () => {
    // 1. Add GeoGebra 3D calculator app
    const addReq = new Request("https://labkiosk.io/api/portal-sites?tenant=greenwood", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: schoolSessionCookie
      },
      body: JSON.stringify({
        title: "NASA Space Sims",
        url: "https://eyes.nasa.gov/apps/solar-system",
        category: "Astronomy",
        icon: "🚀"
      })
    });

    const addRes = await worker.fetch(addReq, mockEnv);
    assert.equal(addRes.status, 200);
    const addData = (await addRes.json()) as any;
    assert.equal(addData.status, "ok");
    assert.equal(addData.site.title, "NASA Space Sims");
    assert.equal(addData.site.domain, "eyes.nasa.gov");
    createdSiteId = addData.site.id;

    // 2. Verify site appears on student portal
    const portalReq = new Request("https://labkiosk.io/?tenant=greenwood");
    const portalRes = await worker.fetch(portalReq, mockEnv);
    const portalHtml = await portalRes.text();
    assert.match(portalHtml, /NASA Space Sims/);

    // 3. Delete the app card
    const delReq = new Request(`https://labkiosk.io/api/portal-sites/${createdSiteId}?tenant=greenwood`, {
      method: "DELETE",
      headers: { Cookie: schoolSessionCookie }
    });
    const delRes = await worker.fetch(delReq, mockEnv);
    assert.equal(delRes.status, 200);
    const delData = (await delRes.json()) as any;
    assert.equal(delData.status, "ok");
  });

  test("Serves School Teacher Dashboard on /admin for logged-in school admin", async () => {
    const req = new Request("https://labkiosk.io/admin?tenant=greenwood", {
      headers: { Cookie: schoolSessionCookie }
    });
    const res = await worker.fetch(req, mockEnv);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Greenwood High School/);
    assert.match(html, /greenwood\.labkiosk\.io • Lab Console/);
    assert.match(html, /Portal Apps/);
    assert.match(html, /Settings/);
  });

  test("Ingests client telemetry scoped to tenant and dispatches commands", async () => {
    // 1. Post telemetry from workstation PC-01
    const telemPayload = {
      clientId: "PC-01",
      clientNum: 1,
      activeUrl: "https://www.khanacademy.org",
      isLocked: false
    };

    const telemReq = new Request("https://labkiosk.io/api/telemetry?tenant=greenwood", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(telemPayload)
    });

    const telemRes = await worker.fetch(telemReq, mockEnv);
    assert.equal(telemRes.status, 200);
    const telemData = (await telemRes.json()) as any;
    assert.equal(telemData.status, "ok");
    assert.ok(Array.isArray(telemData.whitelist));

    // 2. Teacher locks PC-01
    const cmdReq = new Request("https://labkiosk.io/api/command?tenant=greenwood", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: schoolSessionCookie
      },
      body: JSON.stringify({
        target: "PC-01",
        action: "lock",
        message: "Attention to front"
      })
    });

    const cmdRes = await worker.fetch(cmdReq, mockEnv);
    assert.equal(cmdRes.status, 200);
    const cmdData = (await cmdRes.json()) as any;
    assert.equal(cmdData.status, "ok");

    // 3. PC-01 receives lock command on next poll
    const pollReq = new Request("https://labkiosk.io/api/telemetry?tenant=greenwood", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId: "PC-01" })
    });
    const pollRes = await worker.fetch(pollReq, mockEnv);
    const pollData = (await pollRes.json()) as any;
    assert.equal(pollData.commands.length, 1);
    assert.equal(pollData.commands[0].action, "lock");
  });

  test("Responds to first-boot setup wizard status probe on /api/status", async () => {
    const req = new Request("https://labkiosk.io/api/status?tenant=greenwood");
    const res = await worker.fetch(req, mockEnv);
    assert.equal(res.status, 200);
    const data = (await res.json()) as any;
    assert.equal(data.status, "ok");
    assert.equal(data.subdomain, "greenwood");
    assert.equal(data.schoolName, "Greenwood High School");
    assert.equal(data.isActive, true);
  });
});
