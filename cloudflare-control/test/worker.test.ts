import { test, describe } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import worker from "../src/index";
import * as workerModule from "../src/index";
import { SCHEMA_SQL, initSchema, assertSchemaCurrent, ensureDemoTenants, createUser, createTenant, findTenantBySubdomain } from "../src/db";
import { DEMO_SLUGS } from "../src/demo";
import { createLocalD1Database } from "../src/d1_adapter";
import { DatabaseSync } from "node:sqlite";
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

/**
 * Exact membership of a domain in an allowlist the API returned. `list.includes()`
 * would silently turn into a substring test if the list ever came back as a string.
 */
function allowlistHas(list: unknown, domain: string): boolean {
  assert.ok(Array.isArray(list), "the allowlist is an array of domains");
  return new Set(list).has(domain);
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
  let orgSessionCookie = "";
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
    assert.match(html, /Turn Any Computer Into a/);
    assert.match(html, /Download Kiosk ISO/);
    assert.match(html, /Register Your Organization/);
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
      json({ name: "Weak Organization", email: "weak@example.com", password: "short", subdomain: "weakorganization" })
    );
    assert.equal(res.status, 400);
    assert.match(data.error, /at least 12 characters/);
  });

  test("Registers new organization admin and claims subdomain", async () => {
    const { res, data } = await callJson(
      "/api/auth/register",
      json({
        name: "Greenwood Holdings",
        email: "operator@greenwood.example",
        password: "OrganizationPassword123!",
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
    orgSessionCookie = cookie!.split(";")[0];
  });

  test("Registers a second, unrelated organization for isolation checks", async () => {
    const { res } = await callJson(
      "/api/auth/register",
      json({
        name: "Riverside Academy",
        email: "operator@riverside.example",
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
    assert.match(html, /Greenwood Holdings/);
  });

  test("Refuses the Super Admin Console without a super admin session", async () => {
    const anonymous = await call("/super");
    assert.equal(anonymous.status, 401);

    const asOperator = await call("/super", { cookie: orgSessionCookie });
    assert.equal(asOperator.status, 401);
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
      await callJson("/api/auth/login", json({ email: "throttle@example.com", password: "WrongPassword1" }));
    }
    const { res, data } = await callJson(
      "/api/auth/login",
      json({ email: "throttle@example.com", password: "WrongPassword1" })
    );
    assert.equal(res.status, 429);
    assert.match(data.error, /Too many failed sign-in attempts/);
  });

  // ------------------------------------------------------------------- XSS

  test("Escapes a hostile organization name in the Super Admin Console", async () => {
    const hostileName = '<img src=x onerror=alert(1)>';
    const { res } = await callJson(
      "/api/auth/register",
      json({
        name: hostileName,
        email: "attacker@evil.test",
        password: "AttackerPass789!",
        subdomain: "evilorganization"
      })
    );
    assert.equal(res.status, 200);

    const html = await (await call("/super", { cookie: superSessionCookie })).text();
    assert.ok(!html.includes(hostileName), "raw script-bearing tag must never reach the super admin console");
    assert.match(html, /&lt;img src=x onerror=alert\(1\)&gt;/);
  });

  // ---------------------------------------------------------- user portal

  test("Serves the User Portal at /home on an organization subdomain", async () => {
    const res = await call("/home?tenant=greenwood");
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("Content-Type"), "text/html; charset=utf-8");
    const html = await res.text();
    assert.match(html, /Greenwood Holdings/);
    assert.match(html, /Select an Approved Resource/);
    assert.match(html, /Khan Academy/);
    assert.match(html, /Scratch Studio/);
  });

  test("The subdomain root is the organization homepage, and /portal is gone", async () => {
    // The root used to render the app grid, the same page as /home and /portal.
    // It is the organization's own page now.
    const home = await call("/?tenant=greenwood");
    assert.equal(home.status, 200);
    const html = await home.text();
    assert.match(html, /Greenwood Holdings/);
    assert.match(html, /Open User Portal/);
    // It is not the app grid.
    assert.doesNotMatch(html, /Select an Approved Resource/);
    // And it links to where the grid actually is.
    assert.match(html, /href="\/home\?tenant=greenwood"/);

    // /portal was dropped. It must not quietly render something else.
    const gone = await call("/portal?tenant=greenwood");
    assert.notEqual(gone.status, 200, "/portal must no longer serve a page");
  });

  test("An organization edits its homepage, and the editor is guarded", async () => {
    const payload = {
      headline: "Welcome to Greenwood Computing",
      intro: "Pages run here every weekday.",
      blocks: [
        { title: "Library", body: "Open at break.", url: "library.greenwood.example" },
        { title: "", body: "", url: "https://dropped.example" },
        { title: "No link", body: "Just a notice." }
      ]
    };

    // Anonymous callers are refused. An anonymous request that names another
    // organization is refused at tenant resolution (403) rather than at the guard.
    const anon = await call("/api/tenant/homepage?tenant=greenwood", json(payload));
    assert.ok(anon.status === 401 || anon.status === 403, `anonymous got ${anon.status}`);

    // And so is a signed-in account that does not own this organization. Rule 2 keeps
    // the super admin out of every organization but demo.
    const asSuper = await call("/api/tenant/homepage?tenant=greenwood", {
      ...json(payload),
      cookie: superSessionCookie
    });
    assert.ok(asSuper.status === 401 || asSuper.status === 403, `super admin got ${asSuper.status}`);

    const saved = await callJson("/api/tenant/homepage?tenant=greenwood", {
      ...json(payload),
      cookie: orgSessionCookie
    });
    assert.equal(saved.res.status, 200);
    // The empty block is dropped and the scheme-less URL is repaired.
    assert.equal(saved.data.blocks.length, 2);
    assert.equal(saved.data.blocks[0].url, "https://library.greenwood.example/");
    assert.equal(saved.data.blocks[1].url, null);

    const html = await (await call("/?tenant=greenwood")).text();
    assert.match(html, /Welcome to Greenwood Computing/);
    assert.match(html, /Pages run here every weekday/);
    assert.match(html, /Open at break/);
    assert.match(html, /Just a notice/);
  });

  test("A hostile homepage block cannot break out of the page", async () => {
    const hostileTitle = '</h3><script>alert("xss")</script>';
    await callJson("/api/tenant/homepage?tenant=greenwood", {
      ...json({
        headline: '</h1><img src=x onerror="alert(1)">',
        intro: "",
        blocks: [{ title: hostileTitle, body: "ok", url: "javascript:alert(1)" }]
      }),
      cookie: orgSessionCookie
    });

    const html = await (await call("/?tenant=greenwood")).text();
    assert.ok(!html.includes(hostileTitle), "a hostile block title must not render as markup");
    assert.ok(!html.includes('onerror="alert(1)"'), "a hostile headline must not render as an attribute");
    assert.ok(!html.includes("javascript:alert(1)"), "a non-http(s) link must be dropped, not rendered");
    assert.match(html, /&lt;\/h3&gt;/);

    // Put it back so later tests see a normal page.
    await callJson("/api/tenant/homepage?tenant=greenwood", {
      ...json({ headline: "", intro: "", blocks: [] }),
      cookie: orgSessionCookie
    });
  });

  test("Returns 404 for an unknown subdomain without reflecting it as markup", async () => {
    const res = await call("/?tenant=%3Cimg%20src=x%20onerror=alert(1)%3E");
    assert.equal(res.status, 404);
    const html = await res.text();
    assert.ok(!html.includes("<img src=x"), "the requested subdomain must not be reflected as raw HTML");
  });

  // ------------------------------------------------------------ portal apps

  test("Adds and deletes a custom app card in User Portal", async () => {
    const { res: addRes, data: addData } = await callJson("/api/portal-sites?tenant=greenwood", {
      ...json({
        title: "NASA Space Sims",
        url: "https://eyes.nasa.gov/apps/solar-system",
        category: "Astronomy",
        icon: "\u{1F680}"
      }),
      cookie: orgSessionCookie
    });

    assert.equal(addRes.status, 200);
    assert.equal(addData.status, "ok");
    assert.equal(addData.site.title, "NASA Space Sims");
    assert.equal(addData.site.domain, "eyes.nasa.gov");
    createdSiteId = addData.site.id;

    const portalHtml = await (await call("/home?tenant=greenwood")).text();
    assert.match(portalHtml, /NASA Space Sims/);

    const { res: delRes, data: delData } = await callJson(
      `/api/portal-sites/${createdSiteId}?tenant=greenwood`,
      { method: "DELETE", cookie: orgSessionCookie }
    );
    assert.equal(delRes.status, 200);
    assert.equal(delData.status, "ok");
  });

  test("Rejects a portal app whose URL is not http(s)", async () => {
    const { res, data } = await callJson("/api/portal-sites?tenant=greenwood", {
      ...json({ title: "Bad", url: "javascript:alert(1)" }),
      cookie: orgSessionCookie
    });
    assert.equal(res.status, 400);
    assert.match(data.error, /valid http\(s\) address/);
  });

  test("Escapes a hostile app title on the user portal", async () => {
    const hostileTitle = "</script><script>alert(1)</script>";
    await callJson("/api/portal-sites?tenant=greenwood", {
      ...json({ title: hostileTitle, url: "https://example.org/page" }),
      cookie: orgSessionCookie
    });

    const html = await (await call("/home?tenant=greenwood")).text();
    assert.ok(!html.includes(hostileTitle), "a hostile title must not break out of the portal markup");
    assert.match(html, /&lt;\/script&gt;/);
  });

  // -------------------------------------------------------------- dashboard

  test("Serves Organization Admin console on /admin for logged-in organization admin", async () => {
    const res = await call("/admin?tenant=greenwood", { cookie: orgSessionCookie });
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Greenwood Holdings/);
    assert.match(html, /greenwood\.labkiosk\.akbhoi\.com/);
    assert.match(html, /Apps &amp; Web/);
    assert.match(html, /Settings/);
  });

  test("Dashboard markup is well formed so every modal is reachable", async () => {
    const html = await (await call("/admin?tenant=greenwood", { cookie: orgSessionCookie })).text();
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
    for (const page of ["/admin/apps-web", "/admin/settings"]) {
      assert.ok(body.includes(`href="${page}"`), `the toolbar must link to ${page}`);
    }
  });

  test("Every CSS class the consoles render is declared by the shared shell", async () => {
    // `input-field` was used fourteen times and declared nowhere, which is how a
    // white-on-white form ended up inside a dark console. Nothing catches that
    // but a render, so render every page and compare the two sets.
    const pages = [
      ["/admin/workstations?tenant=greenwood", orgSessionCookie],
      ["/admin/apps-web?tenant=greenwood", orgSessionCookie],
      ["/admin/staff?tenant=greenwood", orgSessionCookie],
      ["/admin/settings?tenant=greenwood", orgSessionCookie],
      ["/super/organizations", superSessionCookie],
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
    // different product from the organization one. The shell provides lkToast,
    // lkConfirm and lkPrompt instead.
    const pages = [
      ["/admin/workstations?tenant=greenwood", orgSessionCookie],
      ["/admin/apps-web?tenant=greenwood", orgSessionCookie],
      ["/admin/staff?tenant=greenwood", orgSessionCookie],
      ["/admin/settings?tenant=greenwood", orgSessionCookie],
      ["/super/organizations", superSessionCookie],
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

  test("Every API path a page script calls is a route the worker serves", () => {
    // The allowlist tab called /api/settings/whitelist, which never existed: add,
    // remove and every preset pack answered 404, and the markup tests were happy.
    const srcDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
    const router = fs.readFileSync(path.join(srcDir, "index.ts"), "utf8");
    const routes = [...router.matchAll(/path (?:===|\.startsWith\() ?"(\/api\/[^"]*)"/g)].map((m) => m[1]);
    const called = new Set<string>();
    for (const f of fs.readdirSync(srcDir).filter((f) => /^ui.*\.ts$/.test(f))) {
      const source = fs.readFileSync(path.join(srcDir, f), "utf8");
      for (const m of source.matchAll(/(?:labkioskApi|fetch)\(\s*"(\/api\/[^"?]*)/g)) called.add(m[1]);
    }
    assert.ok(called.size > 10, "the scan found the console's API calls");
    const missing = [...called].filter(
      (p) => !routes.some((r) => r === p || r === p.replace(/\/$/, "") || (r.endsWith("/") && p.startsWith(r)))
    );
    assert.deepEqual(missing, [], "page scripts call paths no route serves");
  });

  test("Every inline script on every page actually parses", async () => {
    // A stray brace in the user portal clock made its whole <script> block a
    // syntax error, so the clock never started. Nothing caught it: the block
    // lives inside a template literal, so tsc never sees it as code, and
    // rendering a page does not run it. new Function parses without executing.
    const pages: Array<[string, string | undefined]> = [
      ["/", undefined],
      ["/home?tenant=greenwood", undefined],
      ["/privacy", undefined],
      ["/terms", undefined],
      ["/admin/workstations?tenant=greenwood", orgSessionCookie],
      ["/admin/apps-web?tenant=greenwood", orgSessionCookie],
      ["/admin/staff?tenant=greenwood", orgSessionCookie],
      ["/admin/settings?tenant=greenwood", orgSessionCookie],
      ["/super/organizations", superSessionCookie],
      ["/super/approvals", superSessionCookie],
      ["/super/catalogs", superSessionCookie],
      ["/super/system", superSessionCookie]
    ];

    let parsed = 0;
    for (const [page, cookie] of pages) {
      const res = await call(page, cookie ? { cookie } : {});
      assert.equal(res.status, 200, `${page} did not render`);
      const html = await res.text();

      for (const chunk of html.split("<script").slice(1)) {
        const opens = chunk.indexOf(">");
        const closes = chunk.indexOf("</script>");
        if (opens < 0 || closes < 0) continue;
        const body = chunk.slice(opens + 1, closes);
        if (!body.trim()) continue;
        try {
          new Function(body);
        } catch (err) {
          assert.fail(`${page} has a <script> that does not parse: ${(err as Error).message}`);
        }
        parsed++;
      }
    }

    // Guard the guard: if the extraction ever stops finding scripts, this test
    // would pass by checking nothing.
    assert.ok(parsed >= pages.length, `only ${parsed} scripts were parsed across ${pages.length} pages`);
  });

  test("Every data- control in the context panel is one the panel script reads", async () => {
    // The panel shipped once as markup with no behaviour at all, and later a
    // density toggle was added whose attribute was left out of the delegated
    // selector -- so the buttons rendered, highlighted on hover, and did
    // nothing. Neither failure shows up in a typecheck.
    const pages = [
      "/admin/workstations?tenant=greenwood",
      "/admin/apps-web?tenant=greenwood",
      "/admin/staff?tenant=greenwood",
      "/admin/settings?tenant=greenwood"
    ];

    for (const page of pages) {
      const html = await (await call(page, { cookie: orgSessionCookie })).text();
      const panel = html.match(/<aside class="sub-panel"[\s\S]*?<\/aside>/);
      assert.ok(panel, `${page} has no context panel`);

      const used = new Set((panel![0].match(/\sdata-(focus|density|filter|action|preset|quick-domain)=/g) || []).map((a) => a.trim().slice(0, -1)));
      assert.ok(used.size > 0, `${page} renders a panel with no controls at all`);

      // The one selector the delegated listener matches against.
      const selector = html.match(/event\.target\.closest\("([^"]+)"\)/);
      assert.ok(selector, `${page} does not delegate panel clicks`);

      for (const attribute of used) {
        assert.ok(
          selector![1].includes(`[${attribute}]`),
          `${page} renders ${attribute} but the panel listener never matches it`
        );
      }
    }
  });

  test("Every link the console renders goes somewhere, and the portal preview goes to the grid", async () => {
    // Moving the app grid from / to /home left the context panel's "Preview
    // User Portal" link pointing at /, which had quietly become the organization
    // homepage. It did not 404 and it did not fail a typecheck -- it simply
    // opened the wrong page, which is the whole failure mode Rule 5g warns
    // about: these paths are somewhere a link, or a workstation, is pinned.
    // On the organization's own host, which is where the console lives in production
    // and what its host-relative links are written against.
    const host = "greenwood.labkiosk.akbhoi.com";
    const open = (path: string) => call(path, { cookie: orgSessionCookie, headers: { host } });
    const pages = [
      "/admin/workstations",
      "/admin/apps-web",
      "/admin/staff",
      "/admin/settings"
    ];

    const targets = new Map<string, string>();
    let portalHtml = "";
    for (const page of pages) {
      const html = await (await open(page)).text();
      if (page === "/admin/apps-web") portalHtml = html;
      for (const match of html.matchAll(/href="(\/[^"#]*)"/g)) targets.set(match[1], page);
    }
    assert.ok(targets.size > 0, "no internal links were found at all");

    for (const [target, page] of targets) {
      const res = await open(target);
      assert.notEqual(res.status, 404, `${page} links to ${target}, which does not exist`);
    }

    // The two preview links on the portal manager open the same thing, and it
    // is the app grid rather than the organization's own homepage.
    const previews = [...portalHtml.matchAll(/href="([^"]+)"[^>]*>[\s\S]{0,400}?Preview User Portal/g)].map((m) => m[1]);
    assert.equal(previews.length, 2, `expected both preview links, found ${previews.length}`);
    for (const href of previews) {
      assert.ok(href.startsWith("/home"), `a "Preview User Portal" link points at ${href}, not the app grid`);
    }

    const grid = await (await open(previews[0])).text();
    assert.match(grid, /Select an Approved Resource/, "the preview link must reach the app grid");
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

    // Anonymous and organization-admin callers are refused.
    assert.equal((await call("/api/super/audit-logs")).status, 401);
    const asOrganization = await call("/api/super/audit-logs", { cookie: orgSessionCookie });
    assert.ok(asOrganization.status === 401 || asOrganization.status === 403, `organization admin got ${asOrganization.status}`);

    await callJson("/api/super/i18n/de-DE", { method: "DELETE", cookie: superSessionCookie });
  });

  test("Platform history never exposes an organization's own activity", async () => {
    // Rule 2 keeps super admins out of organization data. The query matches on who
    // acted, never on which organization was acted upon, so an operator adding a portal
    // card must not appear here even though that row carries a tenant_id.
    await callJson("/api/portal-sites?tenant=greenwood", {
      ...json({ title: "Private Lab Tool", url: "https://internal.greenwood.example" }),
      cookie: orgSessionCookie
    });

    const { logs } = (await (await call("/api/super/audit-logs?limit=200", { cookie: superSessionCookie })).json()) as {
      logs: Array<{ action: string; details?: string | null }>;
    };
    // Prove the row exists before asserting it is absent, so this cannot pass
    // just because nothing was written.
    const own = (await (await call("/api/audit-logs?tenant=greenwood&limit=200", { cookie: orgSessionCookie })).json()) as {
      logs: Array<{ action: string; details?: string | null }>;
    };
    assert.ok(
      own.logs.some((entry) => (entry.details || "").includes("Private Lab Tool")),
      "the organization must be able to see its own action"
    );

    const leaked = logs.find((entry) => (entry.details || "").includes("Private Lab Tool"));
    assert.equal(leaked, undefined, "an organization's own action leaked into the platform history");
  });

  test("An organization can read what the platform did to its lab", async () => {
    // The answer to \"who changed our subdomain\". The super admin acts with the
    // organization's tenant_id on the row, so it belongs in that organization's own log.
    const meRes = await callJson("/api/auth/me", { cookie: orgSessionCookie });
    const greenwoodTenantId = meRes.data.tenant.id;

    const before = await (await call("/api/audit-logs?tenant=greenwood&limit=200", { cookie: orgSessionCookie })).json();
    assert.ok(Array.isArray((before as { logs: unknown[] }).logs));

    await callJson("/api/super/tenants/suspend", { ...json({ tenantId: greenwoodTenantId }), cookie: superSessionCookie });
    await callJson("/api/super/tenants/reactivate", { ...json({ tenantId: greenwoodTenantId }), cookie: superSessionCookie });

    const { logs } = (await (await call("/api/audit-logs?tenant=greenwood&limit=200", { cookie: orgSessionCookie })).json()) as {
      logs: Array<{ action: string }>;
    };
    assert.ok(logs.some((entry) => entry.action === "tenant.suspend"), "the suspension must be visible to the organization");
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

  test("Refuses cross-tenant access from an operator at another organization", async () => {
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
      cookie: orgSessionCookie
    });
    assert.equal(res.status, 400);
    assert.match(data.error, /valid http\(s\) URL/);
  });

  test("Rejects an unsupported command action", async () => {
    const { res } = await callJson("/api/command?tenant=greenwood", {
      ...json({ target: "all", action: "rm -rf" }),
      cookie: orgSessionCookie
    });
    assert.equal(res.status, 400);
  });

  // --------------------------------------------------------- device enrolment

  test("Reveals the enrollment key to the organization admin only", async () => {
    const { res, data } = await callJson("/api/settings/enrollment-key?tenant=greenwood", {
      cookie: orgSessionCookie
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
    assert.equal(data.organizationName, "Greenwood Holdings");
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
        // A hostile client claiming another organization and another PC is ignored:
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
    assert.ok(allowlistHas(data.whitelist, "khanacademy.org"));

    const { data: clients } = await callJson("/api/clients?tenant=greenwood", { cookie: orgSessionCookie });
    assert.ok(clients.clients["PC-01"], "telemetry must be recorded against the enrolled client id");
    assert.ok(!clients.clients["PC-EVIL"], "a client id supplied in the body must be ignored");
  });

  test("Delivers a broadcast command to each workstation exactly once", async () => {
    const { res: cmdRes } = await callJson("/api/command?tenant=greenwood", {
      ...json({ target: "all", action: "lock", message: "Attention to front" }),
      cookie: orgSessionCookie
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
      cookie: orgSessionCookie
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
      cookie: orgSessionCookie
    });
    assert.equal(resetRes.status, 200);

    const telemAfter = await callJson("/api/telemetry", { ...json({}), bearer: deviceToken });
    assert.equal(telemAfter.res.status, 200);
    assert.equal(telemAfter.data.targetUrl, "https://greenwood.labkiosk.akbhoi.com/");
    assert.equal(telemAfter.data.broadcastUrl, "");
    // The reset command sends the workstation to its own portal, not to wherever
    // the operator reached the console: a console on http://localhost once sent
    // every workstation to http://localhost, which on a workstation is itself.
    const fromLocalConsole = await worker.fetch(
      new Request("http://localhost:8787/api/command?tenant=greenwood", {
        method: "POST",
        headers: { Cookie: orgSessionCookie, "Content-Type": "application/json", Origin: "http://localhost:8787" },
        body: JSON.stringify({ target: "all", action: "navigate", resetPortal: true })
      }),
      mockEnv
    );
    assert.equal(fromLocalConsole.status, 200);
    const delivered = await callJson("/api/telemetry", { ...json({}), bearer: deviceToken });
    const reset = delivered.data.commands.find((c: any) => c.action === "navigate");
    assert.ok(reset, "the reset is delivered as a navigate command");
    assert.equal(reset.url, "https://greenwood.labkiosk.akbhoi.com/");
    assert.equal(reset.url, delivered.data.targetUrl);
    assert.equal(reset.portal, undefined, "the internal marker is not sent to the agent");
  });

  test("Drops an oversized screen thumbnail instead of storing it", async () => {
    const huge = "data:image/jpeg;base64," + "A".repeat(300 * 1024);
    const { res } = await callJson("/api/telemetry", { ...json({ thumbnail: huge }), bearer: deviceToken });
    assert.equal(res.status, 200);

    const { data } = await callJson("/api/clients?tenant=greenwood", { cookie: orgSessionCookie });
    const thumb = data.clients["PC-01"].thumbnail;
    assert.ok(!thumb || thumb.length < 300 * 1024, "an oversized thumbnail must not be persisted");
  });

  test("Revokes the device token when a workstation is decommissioned", async () => {
    const { res: removeRes } = await callJson("/api/clients/remove?tenant=greenwood", {
      ...json({ clientId: "PC-01" }),
      cookie: orgSessionCookie
    });
    assert.equal(removeRes.status, 200);

    const afterRemoval = await call("/api/telemetry", { ...json({}), bearer: deviceToken });
    assert.equal(afterRemoval.status, 401, "a decommissioned workstation must not be able to re-register itself");
  });

  // ---------------------------------------------------------------- misc

  test("Keeps the domain allowlist separate per organization", async () => {
    await callJson("/api/whitelist?tenant=greenwood", {
      ...json({ action: "add", domain: "https://nasa.gov/education" }),
      cookie: orgSessionCookie
    });

    const { data: greenwood } = await callJson("/api/whitelist?tenant=greenwood", {
      cookie: orgSessionCookie
    });
    assert.ok(allowlistHas(greenwood.whitelist, "nasa.gov"), "the domain should be normalized to a bare hostname");

    const { data: riverside } = await callJson("/api/whitelist?tenant=riverside", {
      cookie: rivalSessionCookie
    });
    assert.ok(!allowlistHas(riverside.whitelist, "nasa.gov"), "one organization's allowlist must not leak into another's");
  });

  test("Records privileged actions in the audit log", async () => {
    const { res, data } = await callJson("/api/audit-logs?tenant=greenwood", { cookie: orgSessionCookie });
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
    assert.equal(data.organizationName, "Greenwood Holdings");
    assert.equal(data.isActive, true);
  });

  test("Points an enrolled workstation at its own organization, whatever host it used", async () => {
    // A workstation may reach the control plane on a host that cannot carry the
    // organization name -- the Docker gateway, a *.workers.dev deployment, an IP. The
    // enrolment response must still send it to its organization's portal rather than
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

  test("Only treats a host under DEFAULT_DOMAIN as an organization subdomain", async () => {
    // A multi-label host that is not an organization must not have its first label read
    // as one: `host.docker.internal` is the Docker gateway, and a worker deployed
    // at `my-worker.acct.workers.dev` serves its own landing page, not an organization
    // called "my-worker". Both previously rendered "Organization Subdomain Not Found".
    for (const host of ["host.docker.internal", "my-worker.acct.workers.dev", "127.0.0.1"]) {
      const res = await worker.fetch(new Request("https://labkiosk.akbhoi.com/", { headers: { host } }), mockEnv);
      assert.equal(res.status, 200, `${host} should serve the landing page`);
      assert.match(await res.text(), /Turn Any Computer Into a/);
    }

    // A real organization subdomain under the configured base domain still resolves.
    const organization = await worker.fetch(
      new Request("https://labkiosk.akbhoi.com/", { headers: { host: "greenwood.labkiosk.akbhoi.com" } }),
      mockEnv
    );
    assert.equal(organization.status, 200);
    // The root is the organization homepage now; the app grid is at /home.
    assert.match(await organization.text(), /Open User Portal/);
  });

  // ---------------------------------------------------------- custom domains

  test("Allows Organization Admin to request a custom domain and validates domain syntax", async () => {
    // Reject invalid domain format
    const invalid = await callJson("/api/settings/custom-domain?tenant=greenwood", {
      ...json({ domain: "not-a-valid-domain" }),
      cookie: orgSessionCookie
    });
    assert.equal(invalid.res.status, 400);

    // Accept valid FQDN
    const { res, data } = await callJson("/api/settings/custom-domain?tenant=greenwood", {
      ...json({ domain: "kiosk.greenwood.example" }),
      cookie: orgSessionCookie
    });
    assert.equal(res.status, 200);
    assert.equal(data.status, "ok");
    assert.equal(data.requestedCustomDomain, "kiosk.greenwood.example");
    assert.equal(data.customDomainStatus, "pending");
  });

  test("Allows Super Admin to approve custom domain and routes traffic via Host header", async () => {
    const { res, data } = await callJson("/api/super/tenants/custom-domain/approve", {
      ...json({ subdomain: "greenwood", customDomain: "kiosk.greenwood.example" }),
      cookie: superSessionCookie
    });
    assert.equal(res.status, 200);
    assert.equal(data.status, "ok");
    assert.equal(data.customDomain, "kiosk.greenwood.example");

    // Edge routing via Host: kiosk.greenwood.example now resolves Greenwood's portal
    const portal = await worker.fetch(
      new Request("https://kiosk.greenwood.example/", { headers: { host: "kiosk.greenwood.example" } }),
      mockEnv
    );
    assert.equal(portal.status, 200);
    const html = await portal.text();
    // The custom domain root is the organization homepage, same as the subdomain root.
    assert.match(html, /Open User Portal/);
    assert.match(html, /Greenwood Holdings/);
    assert.ok(!html.includes("Secure Browser Workstations for Any Organization"), "custom domain must not render landing page");

    // And /home on that domain is the app grid.
    const grid = await worker.fetch(
      new Request("https://kiosk.greenwood.example/home", { headers: { host: "kiosk.greenwood.example" } }),
      mockEnv
    );
    assert.equal(grid.status, 200);
    const gridHtml = await grid.text();
    assert.match(gridHtml, /Protected Kiosk Session/);
    assert.match(gridHtml, /<title>Greenwood Holdings - User Portal<\/title>/);
    assert.match(gridHtml, /Select an Approved Resource/);
  });

  test("Enrols a workstation using customDomain", async () => {
    const { res, data } = await callJson(
      "/api/devices/enroll",
      json({ customDomain: "kiosk.greenwood.example", clientId: "PC-CUSTOM", enrollmentKey })
    );
    assert.equal(res.status, 200);
    assert.equal(data.status, "ok");
    assert.equal(data.clientId, "PC-CUSTOM");
    assert.equal(data.organizationName, "Greenwood Holdings");
    assert.ok(data.deviceToken);

    // Verify custom domain is automatically included in client whitelist
    const telem = await callJson("/api/telemetry", { ...json({}), bearer: data.deviceToken });
    assert.equal(telem.res.status, 200);
    assert.ok(allowlistHas(telem.data.whitelist, "kiosk.greenwood.example"), "custom domain must be included in client whitelist");
  });

  test("Enrols a workstation using custom server URL or IP via enrollment key", async () => {
    const { res, data } = await callJson(
      "/api/devices/enroll",
      json({ customDomain: "http://host.docker.internal:8787", clientId: "PC-DOCKER", enrollmentKey })
    );
    assert.equal(res.status, 200);
    assert.equal(data.status, "ok");
    assert.equal(data.clientId, "PC-DOCKER");
    assert.equal(data.organizationName, "Greenwood Holdings");
    assert.ok(data.deviceToken);
  });

  test("Allows Organization Admin to disconnect custom domain", async () => {
    const { res, data } = await callJson("/api/settings/custom-domain?tenant=greenwood", {
      method: "DELETE",
      cookie: orgSessionCookie
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
      cookie: orgSessionCookie
    });
    assert.equal(badRes.status, 400);
    assert.match(badData.error, /valid http\(s\) (URL|address)/i);

    // 2. Accepts valid LMS / assessment platform URL
    const { res: okRes, data: okData } = await callJson("/api/settings/mode?tenant=greenwood", {
      ...json({ mode: "single_url", defaultUrl: "https://canvas.example.com" }),
      cookie: orgSessionCookie
    });
    assert.equal(okRes.status, 200);
    assert.equal(okData.status, "ok");
    assert.equal(okData.mode, "single_url");
    assert.equal(okData.defaultUrl, "https://canvas.example.com/");

    // 3. Workstation telemetry receives the single-site lockdown target URL and auto-whitelisted domain
    const telem = await callJson("/api/telemetry", { ...json({}), bearer: deviceToken });
    assert.equal(telem.res.status, 200);
    assert.equal(telem.data.targetUrl, "https://canvas.example.com/");
    assert.ok(allowlistHas(telem.data.whitelist, "canvas.example.com"), "target domain must be automatically whitelisted");

    // 4. Switching back to portal mode restores portal targetUrl
    const { res: portalRes, data: portalData } = await callJson("/api/settings/mode?tenant=greenwood", {
      ...json({ mode: "portal" }),
      cookie: orgSessionCookie
    });
    assert.equal(portalRes.status, 200);
    assert.equal(portalData.mode, "portal");
  });

  test("Updates and retrieves organization customization and reflects on user portal", async () => {
    // 1. Update customization settings
    const { res: updateRes, data: updateData } = await callJson("/api/settings/customization?tenant=greenwood", {
      ...json({
        name: "MIT Robotics Lab",
        defaultLockMessage: "Class demonstration in progress. Please focus on the operator.",
        portalTitle: "Robotics Workstation Portal",
        portalSubtitle: "Department of Mechanical Engineering",
        portalDescription: "Select an engineering simulation tool below:",
        portalFooter: "RESTRICTED LAB ENVIRONMENT • MIT COMPUTING"
      }),
      cookie: orgSessionCookie
    });
    assert.equal(updateRes.status, 200);
    assert.equal(updateData.status, "ok");
    assert.equal(updateData.name, "MIT Robotics Lab");
    assert.equal(updateData.defaultLockMessage, "Class demonstration in progress. Please focus on the operator.");

    // 2. GET /api/settings/customization returns the updated branding
    const { res: getRes, data: getData } = await callJson("/api/settings/customization?tenant=greenwood", {
      cookie: orgSessionCookie
    });
    assert.equal(getRes.status, 200);
    assert.equal(getData.name, "MIT Robotics Lab");
    assert.equal(getData.portalTitle, "Robotics Workstation Portal");
    assert.equal(getData.portalSubtitle, "Department of Mechanical Engineering");
    assert.equal(getData.portalDescription, "Select an engineering simulation tool below:");
    assert.equal(getData.portalFooter, "RESTRICTED LAB ENVIRONMENT • MIT COMPUTING");

    // 3. User Portal renders the customized branding
    const portalHtml = await (await call("/home?tenant=greenwood")).text();
    assert.ok(portalHtml.includes("Robotics Workstation Portal"), "portal title must be customized");
    assert.ok(portalHtml.includes("Department of Mechanical Engineering"), "portal subtitle must be customized");
    assert.ok(portalHtml.includes("Select an engineering simulation tool below:"), "portal description must be customized");
    assert.ok(portalHtml.includes("RESTRICTED LAB ENVIRONMENT • MIT COMPUTING"), "portal footer must be customized");

    // 4. Default lock screen announcement is used when no message is specified in lock command
    await callJson("/api/command?tenant=greenwood", {
      ...json({ target: "all", action: "lock" }),
      cookie: orgSessionCookie
    });
    const telem = await callJson("/api/telemetry", { ...json({}), bearer: deviceToken });
    const lockCmd = telem.data.commands.find((c: any) => c.action === "lock");
    assert.ok(lockCmd);
    assert.equal(lockCmd.message, "Class demonstration in progress. Please focus on the operator.");

    // Reset name back for remaining tests
    await callJson("/api/settings/customization?tenant=greenwood", {
      ...json({ name: "Greenwood Holdings" }),
      cookie: orgSessionCookie
    });
  });

  test("Manages custom broadcast presets and shortcuts per tenant", async () => {
    // 1. Rejects invalid preset URL
    const { res: badRes } = await callJson("/api/broadcast-presets?tenant=greenwood", {
      ...json({ title: "Bad", url: "ftp://not-allowed" }),
      cookie: orgSessionCookie
    });
    assert.equal(badRes.status, 400);

    // 2. Adds valid preset (also testing scheme-less input resolution)
    const { res: addRes, data: addData } = await callJson("/api/broadcast-presets?tenant=greenwood", {
      ...json({ title: "GitHub Room", url: "room.github.com" }),
      cookie: orgSessionCookie
    });
    assert.equal(addRes.status, 200);
    assert.equal(addData.status, "ok");
    assert.ok(addData.preset.id);
    assert.equal(addData.preset.title, "GitHub Room");
    assert.equal(addData.preset.url, "https://room.github.com/");

    const presetId = addData.preset.id;

    // 2b. Broadcast preset domain is automatically whitelisted in workstation telemetry
    const presetTelem = await callJson("/api/telemetry", { ...json({}), bearer: deviceToken });
    assert.ok(allowlistHas(presetTelem.data.whitelist, "room.github.com"), "broadcast preset domain must be automatically whitelisted");

    // 2c. Active broadcast URL is dynamically whitelisted in telemetry during broadcast
    await callJson("/api/command?tenant=greenwood", {
      ...json({ target: "all", action: "navigate", url: "https://custom-demo.org/simulation" }),
      cookie: orgSessionCookie
    });
    const broadcastTelem = await callJson("/api/telemetry", { ...json({}), bearer: deviceToken });
    assert.ok(allowlistHas(broadcastTelem.data.whitelist, "custom-demo.org"), "active broadcast domain must be dynamically whitelisted in telemetry");

    // 2d. Resetting broadcast restores authoritative portal target
    await callJson("/api/command?tenant=greenwood", {
      ...json({ target: "all", action: "navigate", resetPortal: true }),
      cookie: orgSessionCookie
    });
    const resetTelem = await callJson("/api/telemetry", { ...json({}), bearer: deviceToken });
    assert.equal(resetTelem.data.broadcastUrl, "");

    // 3. Lists presets
    const { res: listRes, data: listData } = await callJson("/api/broadcast-presets?tenant=greenwood", {
      cookie: orgSessionCookie
    });
    assert.equal(listRes.status, 200);
    const found = listData.presets.find((p: any) => p.id === presetId);
    assert.ok(found);
    assert.equal(found.title, "GitHub Room");

    // 4. Admin console includes the preset in rendered HTML
    const adminHtml = await (await call("/admin?tenant=greenwood", { cookie: orgSessionCookie })).text();
    assert.ok(adminHtml.includes("GitHub Room"));

    // 5. Deletes preset
    const { res: delRes, data: delData } = await callJson(`/api/broadcast-presets/${presetId}?tenant=greenwood`, {
      method: "DELETE",
      cookie: orgSessionCookie
    });
    assert.equal(delRes.status, 200);
    assert.equal(delData.status, "ok");

    // 6. Deleted preset no longer in list
    const { data: listAfter } = await callJson("/api/broadcast-presets?tenant=greenwood", {
      cookie: orgSessionCookie
    });
    assert.ok(!listAfter.presets.some((p: any) => p.id === presetId));
  });

  // ------------------------------------------------- security headers & CSP

  test("Every HTML page carries a strict CSP whose nonce matches every script and no inline handlers", async () => {
    // The third element says whether this page is expected to carry a script.
    // A page with none is legitimate -- the organization homepage has no script at
    // all -- but every script that does render must carry this nonce.
    const pages: Array<[string, string | undefined, boolean]> = [
      ["/", undefined, true],
      ["/?login=1", undefined, true],
      ["/?tenant=greenwood", undefined, false],
      ["/home?tenant=greenwood", undefined, true],
      ["/admin?tenant=greenwood", orgSessionCookie, true],
      ["/super", superSessionCookie, true]
    ];
    for (const [path, cookie, expectsScript] of pages) {
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
      const scripts = html.match(/<script\b[^>]*>/gi) || [];
      if (expectsScript) {
        assert.ok(scripts.length > 0, `${path} renders at least one script block`);
      }
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
      cookie: orgSessionCookie,
      headers: { Origin: "https://evil.example" }
    });
    assert.equal(crossSite.status, 403);

    const sameSite = await call("/api/command?tenant=greenwood", {
      ...json({ target: "all", action: "unlock" }),
      cookie: orgSessionCookie,
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
    const viaGet = await call("/api/auth/logout", { cookie: orgSessionCookie });
    assert.equal(viaGet.status, 405);
    const still = await callJson("/api/auth/me", { cookie: orgSessionCookie });
    assert.ok(still.data.user, "a GET must not have ended the session");

    // Sign a throwaway session out properly.
    const { res: loginRes } = await callJson(
      "/api/auth/login",
      json({ email: "operator@greenwood.example", password: "OrganizationPassword123!" })
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
      json({ email: "operator@riverside.example", password: "RiversidePass456!" })
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

    const oldPassword = await call("/api/auth/login", json({ email: "operator@riverside.example", password: "RiversidePass456!" }));
    assert.equal(oldPassword.status, 401);
    const newPassword = await call("/api/auth/login", json({ email: "operator@riverside.example", password: "RiversideNewPass789!" }));
    assert.equal(newPassword.status, 200);
  });

  // ------------------------------------------------------ registration rules

  test("Rejects reserved subdomains and implausible emails at registration", async () => {
    for (const subdomain of ["admin", "www", "super", "api"]) {
      const { res, data } = await callJson(
        "/api/auth/register",
        json({ name: "Reserved", email: `reserved-${subdomain}@example.com`, password: "ReservedPass123!", subdomain })
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
      json({ name: "Long", email: "long@example.com", password: "LongSlugPass123!", subdomain: "a".repeat(64) })
    );
    assert.equal(tooLong.res.status, 400);
  });

  test("Accepts a scheme-less host:port as a valid URL", async () => {
    const { res, data } = await callJson("/api/broadcast-presets?tenant=greenwood", {
      ...json({ title: "Local LMS", url: "canvas.example.com:8080/courses" }),
      cookie: orgSessionCookie
    });
    assert.equal(res.status, 200);
    assert.equal(data.preset.url, "https://canvas.example.com:8080/courses");
    await call(`/api/broadcast-presets/${data.preset.id}?tenant=greenwood`, { method: "DELETE", cookie: orgSessionCookie });

    // Host:port followed directly by query parameter or hash fragment without trailing slash
    assert.equal(
      safeHttpUrl("canvas.example.com:8080?param=1#section"),
      "https://canvas.example.com:8080/?param=1#section"
    );
    assert.equal(safeHttpUrl("canvas.example.com:8080#section"), "https://canvas.example.com:8080/#section");
  });

  test("Checks domain boundaries case-insensitively with isHostUnder", () => {
    assert.equal(isHostUnder("Organization.LabKiosk.com", "labkiosk.com"), true);
    assert.equal(isHostUnder("ORGANIZATION.LABKIOSK.COM", ".LabKiosk.COM"), true);
    assert.equal(isHostUnder("greenwood.labkiosk.akbhoi.com", "labkiosk.akbhoi.com"), true);
    assert.equal(isHostUnder("not-labkiosk.com", "labkiosk.com"), false);
    assert.equal(isHostUnder("fakelabkiosk.com", "labkiosk.com"), false);
    assert.equal(isHostUnder("labkiosk.com", undefined), false);
  });

  // --------------------------------------------------------- remote control

  test("Stores the remote-control details a workstation reports and shows them to its operator", async () => {
    const reported = await callJson("/api/telemetry", {
      ...json({ vncPassword: "s3cr3t42", remoteHost: "PC-02.lab.greenwood.example" }),
      bearer: deviceToken
    });
    assert.equal(reported.res.status, 200);

    let { data } = await callJson("/api/clients?tenant=greenwood", { cookie: orgSessionCookie });
    assert.equal(data.clients["PC-02"].vncPassword, "s3cr3t42");
    assert.equal(data.clients["PC-02"].remoteHost, "pc-02.lab.greenwood.example");

    // A heartbeat that omits them keeps what is known; a garbage host is ignored.
    await callJson("/api/telemetry", { ...json({ remoteHost: "not a host!" }), bearer: deviceToken });
    ({ data } = await callJson("/api/clients?tenant=greenwood", { cookie: orgSessionCookie }));
    assert.equal(data.clients["PC-02"].vncPassword, "s3cr3t42");
    assert.equal(data.clients["PC-02"].remoteHost, "pc-02.lab.greenwood.example");

    // Another organization's operator never sees them.
    const rival = await call("/api/clients?tenant=greenwood", { cookie: rivalSessionCookie });
    assert.equal(rival.status, 403);
  });

  test("Keeps broadcast state in the database rather than in worker memory", async () => {
    assert.equal((workerModule as any).tenantBroadcastState, undefined, "the in-memory broadcast map must be gone");
    await callJson("/api/command?tenant=greenwood", {
      ...json({ target: "all", action: "navigate", url: "https://phet.colorado.edu/en/simulations" }),
      cookie: orgSessionCookie
    });
    const telem = await callJson("/api/telemetry", { ...json({}), bearer: deviceToken });
    assert.equal(telem.data.broadcastUrl, "https://phet.colorado.edu/en/simulations");
    await callJson("/api/command?tenant=greenwood", {
      ...json({ target: "all", action: "navigate", resetPortal: true }),
      cookie: orgSessionCookie
    });
    const after = await callJson("/api/telemetry", { ...json({}), bearer: deviceToken });
    assert.equal(after.data.broadcastUrl, "");
  });

  // --------------------------------------------------------- suspend organization

  test("Lets the super admin suspend and reactivate an organization", async () => {
    const meRes = await callJson("/api/auth/me", { cookie: orgSessionCookie });
    const tenantId = meRes.data.tenant.id;

    const asOperator = await call("/api/super/tenants/suspend", { ...json({ tenantId }), cookie: orgSessionCookie });
    assert.equal(asOperator.status, 403);

    const suspend = await callJson("/api/super/tenants/suspend", { ...json({ tenantId }), cookie: superSessionCookie });
    assert.equal(suspend.res.status, 200);
    assert.equal(suspend.data.tenantStatus, "suspended");

    const portal = await call("/?tenant=greenwood");
    assert.equal(portal.status, 403);
    assert.match(await portal.text(), /Organization Suspended/);
    const telem = await call("/api/telemetry", { ...json({}), bearer: deviceToken });
    assert.equal(telem.status, 403);
    const enrol = await call("/api/devices/enroll", json({ subdomain: "greenwood", enrollmentKey, clientId: "PC-SUSPENDED" }));
    assert.equal(enrol.status, 403);

    const again = await call("/api/super/tenants/suspend", { ...json({ tenantId }), cookie: superSessionCookie });
    assert.equal(again.status, 400, "a suspended organization cannot be suspended twice");

    const reactivate = await callJson("/api/super/tenants/reactivate", { ...json({ tenantId }), cookie: superSessionCookie });
    assert.equal(reactivate.res.status, 200);
    assert.equal((await call("/?tenant=greenwood")).status, 200);
    assert.equal((await call("/api/telemetry", { ...json({}), bearer: deviceToken })).status, 200);
  });

  // ------------------------------------------------------------ housekeeping

  test("Runs the scheduled housekeeping handler", async () => {
    await worker.scheduled({} as ScheduledEvent, mockEnv);
    const me = await callJson("/api/auth/me", { cookie: orgSessionCookie });
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
        json({ name: `Bulk ${i}`, email: `bulk-${i}@example.com`, password: "BulkRegisterPass123!", subdomain: `bulk-${i}` })
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
      () => worker.fetch(request("/"), { DEFAULT_DOMAIN: "labkiosk.akbhoi.com", DB: migrated, SUPER_ADMIN_EMAIL: "owner@example.com" } as Env),
      /must both be set/
    );
    // With both secrets present the same database serves normally.
    const res = await worker.fetch(request("/"), {
      DEFAULT_DOMAIN: "labkiosk.akbhoi.com",
      DB: migrated,
      SUPER_ADMIN_EMAIL: "owner@example.com",
      SUPER_ADMIN_PASSWORD: "OwnerPassword2026!"
    } as Env);
    assert.equal(res.status, 200);
  });

  test("Interface catalogs: only a super admin may upload one", async () => {
    const anonymous = await callJson("/api/super/i18n", json({ tag: "hi-IN", catalog: {} }));
    assert.ok(anonymous.res.status === 401 || anonymous.res.status === 403, "anonymous upload must be refused");

    const organizationAdmin = await callJson("/api/super/i18n", {
      ...json({ tag: "hi-IN", catalog: {} }),
      cookie: orgSessionCookie
    });
    assert.equal(organizationAdmin.res.status, 403, "an organization admin is not a platform admin");
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
    // except the organizations directory, which had neither a display rule nor any
    // matching CSS -- so every tenant row rendered on the approvals, catalogs
    // and system pages too.
    const directoryHeading = "Registered Organizations (";

    const organizations = await (await call("/super/organizations", { cookie: superSessionCookie })).text();
    assert.ok(organizations.includes(directoryHeading), "organizations tab shows the directory");

    for (const tab of ["/super/approvals", "/super/catalogs", "/super/system"]) {
      const res = await call(tab, { cookie: superSessionCookie });
      assert.equal(res.status, 200);
      const body = await res.text();
      assert.ok(!body.includes(directoryHeading), tab + " must not leak the organizations directory");
    }

    const approvals = await (await call("/super/approvals", { cookie: superSessionCookie })).text();
    assert.ok(approvals.includes("Pending Subdomain Requests"));
    const system = await (await call("/super/system", { cookie: superSessionCookie })).text();
    assert.ok(system.includes("Platform Architecture"));
    assert.ok(!system.includes("Pending Subdomain Requests"));
  });

  // ------------------------------------------ modern admin & privacy isolation

  test("The platform has three demos, the super admin opens each, and the old demo is gone", async () => {
    for (const slug of DEMO_SLUGS) {
      const res = await call(`/admin/workstations?tenant=${slug}`, { cookie: superSessionCookie });
      assert.equal(res.status, 200, `the super admin opens ${slug}`);
    }
    const retired = await call("/admin/workstations?tenant=demo", { cookie: superSessionCookie });
    assert.notEqual(retired.status, 200, "there is no `demo` organization any more");

    const directory = await (await call("/super/organizations", { cookie: superSessionCookie })).text();
    for (const slug of DEMO_SLUGS) assert.match(directory, new RegExp(`${slug}\\.labkiosk\\.akbhoi\\.com`));
    assert.equal((directory.match(/>Open Console</g) || []).length, 3, "one Open Console per demo");
    assert.doesNotMatch(directory, />demo\.labkiosk\.akbhoi\.com/);
  });

  test("The local demos have no domain and no tunnel, even when the deployment sets one", async () => {
    const withTunnel = { ...mockEnv, TUNNEL_DOMAIN: "tunnels.example.com" } as Env;
    const settings = async (tenant: string, cookie: string) =>
      (await worker.fetch(request(`/admin/settings?tenant=${tenant}&tab=domains`, { cookie }), withTunnel)).text();
    const tunnelOf = (html: string) => html.match(/id="setting-tunnel-domain" value="([^"]*)"/)![1];

    for (const slug of ["local-demo", "docker-demo"]) {
      const html = await settings(slug, superSessionCookie);
      assert.equal(tunnelOf(html), "", `${slug} has no tunnel domain`);
      assert.match(html, /<input type="text" class="form-input" id="setting-custom-domain" placeholder=/, `${slug} has no custom domain`);
    }
    assert.equal(tunnelOf(await settings("web-demo", superSessionCookie)), "demo.labkiosk.akbhoi.com", "the hosted demo keeps its own tunnel");
    assert.equal(tunnelOf(await settings("greenwood", orgSessionCookie)), "tunnels.example.com", "an ordinary organization still inherits it");
  });

  test("No organization can take a demo name, and a demo cannot be renamed or suspended", async () => {
    for (const subdomain of ["demo", ...DEMO_SLUGS]) {
      const res = await call("/api/auth/register", json({
        name: "Squatter", email: `squatter-${subdomain}@example.com`, password: "SquatterPassword123!", subdomain
      }));
      assert.equal(res.status, 400, `${subdomain} is reserved`);
      const rename = await call("/api/tenant/subdomain?tenant=greenwood", {
        ...json({ subdomain }), cookie: orgSessionCookie
      });
      assert.equal(rename.status, 400, `an organization cannot rename itself to ${subdomain}`);
    }

    const renameDemo = await call("/api/tenant/subdomain?tenant=web-demo", {
      ...json({ subdomain: "web-demo-2" }), cookie: superSessionCookie
    });
    assert.equal(renameDemo.status, 400);

    const directory = await (await call("/super/organizations", { cookie: superSessionCookie })).text();
    const row = directory.slice(directory.indexOf("web-demo.labkiosk.akbhoi.com"));
    const demoId = row.match(/data-tenant="([^"]+)"/)![1];
    const suspend = await call("/api/super/tenants/suspend", { ...json({ tenantId: demoId }), cookie: superSessionCookie });
    assert.equal(suspend.status, 400);
    const reject = await call("/api/super/tenants/reject", { ...json({ tenantId: demoId }), cookie: superSessionCookie });
    assert.equal(reject.status, 400);
    const reassign = await call("/api/super/tenants/approve", {
      ...json({ tenantId: demoId, subdomain: "renamed-demo" }), cookie: superSessionCookie
    });
    assert.equal(reassign.status, 400);
  });

  test("Startup never adopts a demo name another organization already holds", async () => {
    const db = createLocalD1Database();
    await initSchema(db);
    const platform = await createUser(db, { email: "platform@example.com", password: "PlatformPassword123!", name: "Platform", role: "super_admin" });
    const earlierPlatform = await createUser(db, { email: "old-platform@example.com", password: "PlatformPassword123!", name: "Old", role: "super_admin" });
    const stranger = await createUser(db, { email: "stranger@example.com", password: "StrangerPassword123!", name: "Stranger" });
    await createTenant(db, { userId: stranger.id, name: "Someone Else", subdomain: "web-demo", status: "active" });
    await createTenant(db, { userId: earlierPlatform.id, name: "Local VM Demo", subdomain: "local-demo", status: "active" });

    const demos = await ensureDemoTenants(db, platform.id);
    assert.deepEqual(demos.map((t) => t.subdomain).sort(), ["docker-demo", "local-demo"], "web-demo is not the platform's");
    assert.equal((await findTenantBySubdomain(db, "web-demo"))!.user_id, stranger.id, "left exactly as it was");
    assert.equal((await findTenantBySubdomain(db, "local-demo"))!.user_id, platform.id, "an earlier super admin's demo moves over");
    const docker = (await findTenantBySubdomain(db, "docker-demo"))!;
    assert.equal(docker.user_id, platform.id);
    assert.equal(docker.status, "active");
  });

  test("Super admin is restricted from organization consoles but allowed on the demo organizations", async () => {
    // 1. Super admin attempts to access greenwood organization console -> 403 Forbidden
    const deniedRes = await call("/admin?tenant=greenwood", { cookie: superSessionCookie });
    assert.equal(deniedRes.status, 403);
    const deniedHtml = await deniedRes.text();
    // The refusal has to say which refusal it is. Telling a platform admin
    // "you do not have access" reads like a broken account rather than the
    // privacy isolation it actually is, and gives no route onward.
    assert.match(deniedHtml, /Platform administrators cannot open an organization console/);
    assert.match(deniedHtml, /only the demo organizations \(web-demo, local-demo, docker-demo\) are available for testing/);
    assert.match(deniedHtml, /Super Admin console/);
    // And it must not claim the account lacks access.
    assert.doesNotMatch(deniedHtml, /You do not have access to that organization(?:'|&#39;)s console/);

    // 2. Super admin accesses demo tenant console -> 200 OK
    const demoRes = await call("/admin?tenant=web-demo", { cookie: superSessionCookie });
    assert.equal(demoRes.status, 200);
    const demoHtml = await demoRes.text();
    assert.match(demoHtml, /Workstation Grid &amp; Remote Control/);
  });

  test("Sign-in lands where the request came from, not always on /super", async () => {
    // The landing page used to decide this itself and sent every super admin to
    // /super whatever host they had signed in on. Signing in on demo.<domain> to
    // reach the demo console threw you to the platform console, and nothing in
    // the UI led back. The server decides now: it is the only side that knows
    // the host and which consoles the account may open.
    const login = (body: object, headers: Record<string, string> = {}) =>
      call("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...headers },
        body: JSON.stringify(body)
      });

    const superCreds = { email: mockEnv.SUPER_ADMIN_EMAIL!, password: mockEnv.SUPER_ADMIN_PASSWORD! };

    // On the apex, a super admin belongs in the platform console.
    const onApex = await (await login(superCreds)).json();
    assert.equal((onApex as { redirect: string }).redirect, "/super");

    // On the demo subdomain, they belong in the console they were looking at.
    const onDemo = await (await login(superCreds, { host: "web-demo.labkiosk.akbhoi.com" })).json();
    assert.equal(
      (onDemo as { redirect: string }).redirect,
      "https://web-demo.labkiosk.akbhoi.com/admin",
      "a super admin signing in on demo must land on the demo console"
    );

    // On any other organization, Rule 2 applies: they may not open it, so /super.
    const onGreenwood = await (await login(superCreds, { host: "greenwood.labkiosk.akbhoi.com" })).json();
    assert.equal(
      (onGreenwood as { redirect: string }).redirect,
      "/super",
      "a super admin must never be sent into an organization they cannot open"
    );

    // An organization admin still lands on their own console wherever they signed in.
    const asOrganization = await (await login(
      { email: "operator@greenwood.example", password: "OrganizationPassword123!" },
      { host: "labkiosk.akbhoi.com" }
    )).json();
    assert.equal((asOrganization as { redirect: string }).redirect, "https://greenwood.labkiosk.akbhoi.com/admin");
  });

  test("Sign-in honours the organization the page was showing, not just the host", async () => {
    // The first version of this fix only read the Host header, and the sign-in
    // POST goes to /api/auth/login with no query string. So on a dev host, and
    // on the apex with ?tenant=web-demo, the server still saw no organization and sent a
    // super admin to /super -- which is the whole complaint, unfixed. The page
    // now sends the organization it was showing.
    const login = (body: object) =>
      call("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });

    const creds = { email: mockEnv.SUPER_ADMIN_EMAIL!, password: mockEnv.SUPER_ADMIN_PASSWORD! };

    const viaBody = await (await login({ ...creds, tenant: "web-demo" })).json();
    assert.equal(
      (viaBody as { redirect: string }).redirect,
      "https://web-demo.labkiosk.akbhoi.com/admin",
      "the page said it was showing demo, so that is where the sign-in belongs"
    );

    // The hint is a hint. It cannot open an organization Rule 2 keeps them out of.
    const notAllowed = await (await login({ ...creds, tenant: "greenwood" })).json();
    assert.equal(
      (notAllowed as { redirect: string }).redirect,
      "/super",
      "a client-supplied organization must not route a super admin into it"
    );

    // Nor does an organization admin get moved by one.
    const operator = await (await login({
      email: "operator@greenwood.example",
      password: "OrganizationPassword123!",
      tenant: "web-demo"
    })).json();
    assert.equal(
      (operator as { redirect: string }).redirect,
      "https://greenwood.labkiosk.akbhoi.com/admin",
      "an organization admin goes to their own console whatever the page claimed"
    );
  });

  test("A signed-out operator can follow /admin all the way to a sign-in form", async () => {
    // The whole chain, because every link in it was broken independently and
    // each one on its own looked fine.

    // 1. /admin while signed out redirects to the sign-in page, naming the organization.
    const bounced = await call("/admin", { headers: { host: "web-demo.labkiosk.akbhoi.com" } });
    assert.equal(bounced.status, 302);
    const target = bounced.headers.get("Location")!;
    assert.match(target, /login=1/);
    assert.match(target, /tenant=web-demo/);

    // 2. That target must actually render a sign-in form. Naming an organization used
    //    to route it to that organization's own page -- the portal before the
    //    homepage existed, the homepage after -- so this link never reached one.
    const page = await call(new URL(target).pathname + new URL(target).search);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /id="login-form"/, "the sign-in redirect must reach a sign-in form");
    assert.doesNotMatch(html, /Open User Portal/, "it must not be the organization homepage");
    // Not asserting the absence of the app grid text here: the landing page's
    // own live simulator mimics the portal and legitimately contains it.

    // 3. And the page has to tell the server which organization it was showing, or the
    //    sign-in lands on /super however the rest of this works.
    assert.match(html, /currentTenantSlug/, "the page must send its tenant with the sign-in");
  });

  test("Redirects /admin on apex domain to appropriate tenant subdomain or super console", async () => {
    // Organization admin without tenant query param on apex -> 302 to https://greenwood.labkiosk.akbhoi.com/admin
    const organizationRes = await call("/admin", { cookie: orgSessionCookie });
    assert.equal(organizationRes.status, 302);
    assert.equal(organizationRes.headers.get("Location"), "https://greenwood.labkiosk.akbhoi.com/admin");

    // Super admin without tenant query param on apex -> 302 to https://labkiosk.akbhoi.com/super
    const superRes = await call("/admin", { cookie: superSessionCookie });
    assert.equal(superRes.status, 302);
    assert.equal(superRes.headers.get("Location"), "https://labkiosk.akbhoi.com/super");

    // Super admin accessing organization admin sub-routes (/admin/workstations, /admin/broadcast, etc.)
    // without tenant query param -> 302 to demo organization console (NOT to /super)
    const superWorkstationsRes = await call("/admin/workstations", { cookie: superSessionCookie });
    assert.equal(superWorkstationsRes.status, 302);
    assert.equal(superWorkstationsRes.headers.get("Location"), "https://labkiosk.akbhoi.com/admin/workstations?tenant=web-demo");

    const superAppsWebRes = await call("/admin/apps-web", { cookie: superSessionCookie });
    assert.equal(superAppsWebRes.status, 302);
    assert.equal(superAppsWebRes.headers.get("Location"), "https://labkiosk.akbhoi.com/admin/apps-web?tenant=web-demo");

    const superLegacyBroadcastRes = await call("/admin/broadcast", { cookie: superSessionCookie });
    assert.equal(superLegacyBroadcastRes.status, 302);
    assert.equal(superLegacyBroadcastRes.headers.get("Location"), "https://labkiosk.akbhoi.com/admin/apps-web?tab=broadcast");

    // Super admin on dev host visiting /admin/workstations without tenant param -> 302 to ?tenant=web-demo
    const devReq = new Request("http://localhost:8787/admin/workstations", {
      headers: { Cookie: superSessionCookie, Host: "localhost:8787" }
    });
    const devRes = await worker.fetch(devReq, mockEnv);
    assert.equal(devRes.status, 302);
    assert.equal(devRes.headers.get("Location"), "http://localhost:8787/admin/workstations?tenant=local-demo");

    // Super admin in demo console on apex domain preserves ?tenant=web-demo across all navigation links
    const demoApexRes = await call("/admin?tenant=web-demo", { cookie: superSessionCookie });
    assert.equal(demoApexRes.status, 200);
    const demoApexHtml = await demoApexRes.text();
    assert.match(demoApexHtml, /href="\/admin\/workstations\?tenant=web-demo"/);
    assert.match(demoApexHtml, /href="\/admin\/apps-web\?tenant=web-demo"/);
    assert.match(demoApexHtml, /href="\/admin\/staff\?tenant=web-demo"/);
    assert.match(demoApexHtml, /href="\/admin\/settings\?tenant=web-demo"/);
  });

  test("Renders all dedicated multi-page organization admin sub-routes with CSP nonces", async () => {
    const routes = [
      ["/admin/workstations?tenant=greenwood", /Workstation Grid &amp; Remote Control/],
      ["/admin/apps-web?tenant=greenwood", /Apps &amp; Web Control/],
      ["/admin/staff?tenant=greenwood", /Staff &amp; Delegation/],
      ["/admin/settings?tenant=greenwood", /Settings &amp; Configuration/]
    ] as const;

    for (const [route, pattern] of routes) {
      const res = await call(route, { cookie: orgSessionCookie });
      assert.equal(res.status, 200, `${route} should return 200`);
      const csp = res.headers.get("Content-Security-Policy") || "";
      assert.match(csp, /script-src 'nonce-[^']+'/);
      const html = await res.text();
      assert.match(html, pattern, `${route} should contain expected heading`);
    }

    // Legacy routes 302 redirect to /admin/apps-web?tab=...
    for (const legacy of ["/admin/broadcast", "/admin/portal", "/admin/whitelist"]) {
      const res = await call(`${legacy}?tenant=greenwood`, { cookie: orgSessionCookie });
      assert.equal(res.status, 302, `${legacy} should return 302`);
      assert.match(res.headers.get("Location") || "", /\/admin\/apps-web\?/);
    }
  });

  test("Manages operators and sub-admin delegation with granular permissions", async () => {
    // 1. Organization admin creates a sub-admin operator with specific permissions
    const { res: createRes, data: createData } = await callJson("/api/tenant/staff?tenant=greenwood", {
      ...json({
        name: "Assistant Operator Bob",
        email: "bob@greenwood.example",
        role: "sub_admin",
        permissions: ["workstations", "broadcast"]
      }),
      cookie: orgSessionCookie
    });
    assert.equal(createRes.status, 200);
    assert.equal(createData.status, "ok");
    const operatorId = createData.operator.id;
    assert.ok(operatorId);
    assert.equal(createData.operator.name, "Assistant Operator Bob");
    assert.deepEqual(createData.operator.permissions, ["workstations", "broadcast"]);

    // 2. List operators for the organization
    const { res: listRes, data: listData } = await callJson("/api/tenant/staff?tenant=greenwood", {
      cookie: orgSessionCookie
    });
    assert.equal(listRes.status, 200);
    assert.ok(Array.isArray(listData.staff));
    const found = listData.staff.find((t: any) => t.id === operatorId);
    assert.ok(found);
    assert.equal(found.role, "sub_admin");

    // 3. Update operator role/permissions
    const { res: updateRes, data: updateData } = await callJson("/api/tenant/staff/update?tenant=greenwood", {
      ...json({
        id: operatorId,
        role: "operator",
        permissions: ["workstations"]
      }),
      cookie: orgSessionCookie
    });
    assert.equal(updateRes.status, 200);
    assert.equal(updateData.status, "ok");

    // 4. Delete the operator
    const { res: delRes, data: delData } = await callJson(`/api/tenant/staff/${operatorId}?tenant=greenwood`, {
      method: "DELETE",
      cookie: orgSessionCookie
    });
    assert.equal(delRes.status, 200);
    assert.equal(delData.status, "ok");

    // 5. Verify deleted from list
    const { data: listAfter } = await callJson("/api/tenant/staff?tenant=greenwood", {
      cookie: orgSessionCookie
    });
    assert.ok(!listAfter.staff.some((t: any) => t.id === operatorId));
  });

  test("Delegated operator login, session scoping, and granular permissions enforcement", async () => {
    // 1. Organization admin creates an operator with password and ONLY workstations permission
    const { res: createRes, data: createData } = await callJson("/api/tenant/staff?tenant=greenwood", {
      ...json({
        name: "Math Operator Alice",
        email: "alice@greenwood.example",
        password: "AlicePassword123!",
        role: "operator",
        permissions: ["workstations"]
      }),
      cookie: orgSessionCookie
    });
    assert.equal(createRes.status, 200);
    assert.equal(createData.status, "ok");
    const operatorId = createData.operator.id;

    // 2. Operator logs in via /api/auth/login
    const { res: loginRes, data: loginData } = await callJson("/api/auth/login", {
      ...json({
        email: "alice@greenwood.example",
        password: "AlicePassword123!"
      })
    });
    assert.equal(loginRes.status, 200);
    assert.equal(loginData.status, "ok");
    assert.equal(loginData.subdomain, "greenwood");

    const operatorCookie = loginRes.headers.get("Set-Cookie")!.split(";")[0];

    // 3. /api/auth/me returns permissions and tenantRole
    const { res: meRes, data: meData } = await callJson("/api/auth/me", {
      cookie: operatorCookie
    });
    assert.equal(meRes.status, 200);
    assert.equal(meData.user.email, "alice@greenwood.example");
    assert.equal(meData.tenantRole, "operator");
    assert.deepEqual(meData.permissions, ["workstations"]);

    // 4. Allowed: Operator can view workstations list via /api/clients
    const { res: clientsRes } = await callJson("/api/clients?tenant=greenwood", {
      cookie: operatorCookie
    });
    assert.equal(clientsRes.status, 200);

    // 5. Allowed: Operator can dispatch workstation lock command
    const { res: lockRes, data: lockData } = await callJson("/api/command?tenant=greenwood", {
      ...json({ target: "all", action: "lock" }),
      cookie: operatorCookie
    });
    assert.equal(lockRes.status, 200);
    assert.equal(lockData.status, "ok");

    // 6. Refused: Operator without 'broadcast' cannot dispatch navigate command
    const { res: navRes } = await callJson("/api/command?tenant=greenwood", {
      ...json({ target: "all", action: "navigate", url: "https://khanacademy.org" }),
      cookie: operatorCookie
    });
    assert.equal(navRes.status, 403);

    // 7. Refused: Operator without 'portal' cannot create portal sites
    const { res: portalRes } = await callJson("/api/portal-sites?tenant=greenwood", {
      ...json({ title: "Alice Site", url: "https://alicesite.org" }),
      cookie: operatorCookie
    });
    assert.equal(portalRes.status, 403);

    // 8. Refused: Operator without 'whitelist' cannot modify allowlist
    const { res: wlRes } = await callJson("/api/whitelist?tenant=greenwood", {
      ...json({ action: "add", domain: "unauthorized.org" }),
      cookie: operatorCookie
    });
    assert.equal(wlRes.status, 403);

    // 9. Refused: Operator without 'settings' cannot modify subdomain or settings
    const { res: subRes } = await callJson("/api/settings/subdomain?tenant=greenwood", {
      ...json({ subdomain: "hacked" }),
      cookie: operatorCookie
    });
    assert.equal(subRes.status, 403);

    // 10. Dashboard navigation: Visiting /admin/apps-web without apps-web perm redirects to /admin
    const appsWebPageRes = await call("/admin/apps-web?tenant=greenwood", {
      cookie: operatorCookie
    });
    assert.equal(appsWebPageRes.status, 302);
    assert.match(appsWebPageRes.headers.get("Location") || "", /\/admin(\?|$)/);

    // 10b. Legacy /admin/broadcast redirects to /admin/apps-web?tab=broadcast
    const bcastPageRes = await call("/admin/broadcast?tenant=greenwood", {
      cookie: operatorCookie
    });
    assert.equal(bcastPageRes.status, 302);
    assert.match(bcastPageRes.headers.get("Location") || "", /\/admin\/apps-web\?.*tab=broadcast/);

    // Clean up operator
    await callJson(`/api/tenant/staff/${operatorId}?tenant=greenwood`, {
      method: "DELETE",
      cookie: orgSessionCookie
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

  test("Allows organization admin to update subdomain and enforces slug validation", async () => {
    // 1. Reject invalid subdomain
    const { res: badRes, data: badData } = await callJson("/api/tenant/subdomain?tenant=greenwood", {
      ...json({ subdomain: "ab" }),
      cookie: orgSessionCookie
    });
    assert.equal(badRes.status, 400);
    assert.match(badData.error, /3-63 characters/);

    // 2. Reject reserved slug
    const { res: resvRes, data: resvData } = await callJson("/api/tenant/subdomain?tenant=greenwood", {
      ...json({ subdomain: "admin" }),
      cookie: orgSessionCookie
    });
    assert.equal(resvRes.status, 400);
    assert.match(resvData.error, /reserved/);

    // 3. Reject duplicate subdomain (already claimed by riverside)
    const { res: dupRes, data: dupData } = await callJson("/api/tenant/subdomain?tenant=greenwood", {
      ...json({ subdomain: "riverside" }),
      cookie: orgSessionCookie
    });
    assert.equal(dupRes.status, 400);
    assert.match(dupData.error, /already claimed/);

    // 4. Successfully update subdomain to greenwood-high
    const { res: okRes, data: okData } = await callJson("/api/tenant/subdomain?tenant=greenwood", {
      ...json({ subdomain: "greenwood-high" }),
      cookie: orgSessionCookie
    });
    assert.equal(okRes.status, 200);
    assert.equal(okData.status, "ok");
    assert.equal(okData.subdomain, "greenwood-high");

    // Restore subdomain back to greenwood for subsequent tests
    await callJson("/api/tenant/subdomain?tenant=greenwood-high", {
      ...json({ subdomain: "greenwood" }),
      cookie: orgSessionCookie
    });
  });

  test("Updates Settings including custom home route and tunnel domain", async () => {
    // 1. Update settings
    const { res: setRes, data: setData } = await callJson("/api/tenant/settings?tenant=greenwood", {
      ...json({
        homeRoute: "/home",
        tunnelDomain: "custom-tunnel.example.com",
        portalTitle: "Greenwood STEM Portal"
      }),
      cookie: orgSessionCookie
    });
    assert.equal(setRes.status, 200);
    assert.equal(setData.status, "ok");
    assert.equal(setData.updates.home_route, "/home");
    assert.equal(setData.updates.tunnel_domain, "custom-tunnel.example.com");

    // 2. /home route serves the user portal
    const homeRes = await call("/home?tenant=greenwood");
    assert.equal(homeRes.status, 200);
    const homeHtml = await homeRes.text();
    assert.match(homeHtml, /Greenwood STEM Portal/);

    // Reset settings
    await callJson("/api/tenant/settings?tenant=greenwood", {
      ...json({ homeRoute: "/", tunnelDomain: "" }),
      cookie: orgSessionCookie
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
    assert.match(termsHtml, /Organization Responsibilities/);
    const termsCsp = termsRes.headers.get("Content-Security-Policy") || "";
    assert.match(termsCsp, /script-src 'nonce-[^']+'/);
  });

  test("Manages workstation groups and assigns client devices", async () => {
    // 0. Enrol PC-01 and report initial telemetry
    const enrollRes = await callJson("/api/devices/enroll", {
      ...json({ subdomain: "greenwood", enrollmentKey, clientId: "PC-01" }),
      headers: { "CF-Connecting-IP": "198.51.100.99" }
    });
    assert.equal(enrollRes.res.status, 200);
    deviceToken = enrollRes.data.deviceToken;
    await callJson("/api/telemetry", {
      ...json({ activeUrl: "https://khanacademy.org" }),
      bearer: deviceToken
    });

    // 1. Create a group
    const { res: createRes, data: createData } = await callJson("/api/groups?tenant=greenwood", {
      ...json({ name: "Row 1" }),
      cookie: orgSessionCookie
    });
    assert.equal(createRes.status, 200);
    assert.equal(createData.status, "ok");
    assert.equal(createData.group.name, "Row 1");
    const groupId = createData.group.id;

    // 2. List groups
    const { res: listRes, data: listData } = await callJson("/api/groups?tenant=greenwood", {
      cookie: orgSessionCookie
    });
    assert.equal(listRes.status, 200);
    assert.ok(listData.groups.some((g: any) => g.id === groupId && g.name === "Row 1"));

    // 3. Assign client PC-01 to "Row 1"
    const { res: assignRes, data: assignData } = await callJson("/api/clients/group?tenant=greenwood", {
      ...json({ clientIds: ["PC-01"], groupName: "Row 1" }),
      cookie: orgSessionCookie
    });
    assert.equal(assignRes.status, 200);
    assert.equal(assignData.status, "ok");

    // 4. Verify client list includes groupName
    const { res: clientsRes, data: clientsData } = await callJson("/api/clients?tenant=greenwood", {
      cookie: orgSessionCookie
    });
    assert.equal(clientsRes.status, 200);
    assert.equal(clientsData.clients["PC-01"].groupName, "Row 1");

    // 5. Delete group and verify client group is unassigned
    const { res: delRes, data: delData } = await callJson(`/api/groups/${groupId}?tenant=greenwood`, {
      method: "DELETE",
      cookie: orgSessionCookie
    });
    assert.equal(delRes.status, 200);
    assert.equal(delData.status, "ok");

    const { data: clientsAfterDel } = await callJson("/api/clients?tenant=greenwood", {
      cookie: orgSessionCookie
    });
    assert.equal(clientsAfterDel.clients["PC-01"].groupName, undefined);
  });

  test("Dispatches batch commands across multiple selected workstation targets", async () => {
    // Enrol PC-02
    const enrollRes2 = await callJson("/api/devices/enroll", {
      ...json({ subdomain: "greenwood", enrollmentKey, clientId: "PC-02" }),
      headers: { "CF-Connecting-IP": "198.51.100.98" }
    });
    assert.equal(enrollRes2.res.status, 200);
    const token2 = enrollRes2.data.deviceToken;
    await callJson("/api/telemetry", {
      ...json({ activeUrl: "https://khanacademy.org" }),
      bearer: token2
    });

    const { res, data } = await callJson("/api/command?tenant=greenwood", {
      ...json({
        targets: ["PC-01", "PC-02"],
        action: "lock",
        message: "Assessment in progress"
      }),
      cookie: orgSessionCookie
    });
    assert.equal(res.status, 200);
    assert.equal(data.status, "ok");
    assert.equal(data.count, 2);
    assert.equal(data.commandIds.length, 2);

    // Verify both PC-01 and PC-02 receive the lock command on their next telemetry heartbeat
    const pc1Telem = await callJson("/api/telemetry", { ...json({}), bearer: deviceToken });
    const pc2Telem = await callJson("/api/telemetry", { ...json({}), bearer: token2 });

    const pc1Lock = pc1Telem.data.commands.find((c: any) => c.action === "lock");
    const pc2Lock = pc2Telem.data.commands.find((c: any) => c.action === "lock");

    assert.ok(pc1Lock, "PC-01 must receive the lock command");
    assert.equal(pc1Lock.message, "Assessment in progress");
    assert.ok(pc2Lock, "PC-02 must receive the lock command");
    assert.equal(pc2Lock.message, "Assessment in progress");

    // Also dispatch batch shutdown command
    const { res: shutRes, data: shutData } = await callJson("/api/command?tenant=greenwood", {
      ...json({
        targets: ["PC-01", "PC-02"],
        action: "shutdown"
      }),
      cookie: orgSessionCookie
    });
    assert.equal(shutRes.status, 200);
    assert.equal(shutData.status, "ok");
    assert.equal(shutData.count, 2);

    const pc1ShutTelem = await callJson("/api/telemetry", { ...json({}), bearer: deviceToken });
    const pc1Shut = pc1ShutTelem.data.commands.find((c: any) => c.action === "shutdown");
    assert.ok(pc1Shut, "PC-01 must receive the shutdown command");
  });

  test("Workstations console sidebar renders Workstation Groups and removes duplicate commands", async () => {
    const res = await call("/admin/workstations?tenant=greenwood", { cookie: orgSessionCookie });
    assert.equal(res.status, 200);
    const html = await res.text();

    // Verify sidebar has Workstation Groups
    assert.match(html, /Workstation Groups/);
    assert.match(html, /data-filter="group:all"/);
    assert.match(html, /data-filter="group:__ungrouped__"/);
    assert.match(html, /data-action="new-group"/);

    // Verify duplicate "Batch Commands" block is absent from sidebar
    assert.ok(!html.includes("Batch Commands"));
    assert.ok(!html.includes("data-action=\"open-lock-all\""));

    // Verify toolbar has Select All and targeted buttons
    assert.match(html, /id="btn-select-all"/);
    assert.match(html, /id="selection-summary"/);
    assert.match(html, /id="btn-move-group"/);
    assert.match(html, /id="btn-lock-label">Lock</);
    assert.match(html, /id="btn-unlock-label">Unlock</);
    assert.match(html, /id="btn-reboot-label">Reboot</);
    assert.match(html, /id="btn-shutdown-label">Shutdown</);
    assert.match(html, /id="btn-shutdown-all"/);
  });

  test("Staff console sidebar renders Role filter and standard form-checkbox styling", async () => {
    const res = await call("/admin/staff?tenant=greenwood", {
      cookie: orgSessionCookie
    });
    assert.equal(res.status, 200);
    const html = await res.text();

    // 1. Context subpanel renders "Role" section and filter options
    assert.match(html, /<div class="sub-section-title"[^>]*>Role<\/div>/);
    assert.match(html, /id="sub-role-list"/);
    assert.match(html, /data-filter="all"/);
    assert.match(html, /data-filter="operator"/);
    assert.match(html, /data-filter="assistant"/);
    assert.match(html, /data-filter="content_manager"/);
    assert.match(html, /data-filter="org_admin"/);

    // 2. Form uses standard .form-checkbox and .form-checkbox-label styling
    assert.match(html, /class="form-checkbox"/);
    assert.match(html, /class="form-checkbox-label"/);

    // 3. Table rows are tagged with data-role for client-side filtering
    assert.match(html, /id="staff-tbody"/);
    assert.match(html, /id="staff-count"/);
  });

  test("Settings console renders tabbed panes and horizontal card grouping", async () => {
    const res = await call("/admin/settings?tenant=greenwood", {
      cookie: orgSessionCookie
    });
    assert.equal(res.status, 200);
    const html = await res.text();

    // 1. Context subpanel renders tab switching buttons (not scrolling anchor jumps)
    assert.match(html, /data-action="tab-general"/);
    assert.match(html, /data-action="tab-domains"/);
    assert.match(html, /data-action="tab-homepage"/);
    assert.match(html, /data-action="tab-security"/);

    // 2. All 4 tab panes exist with horizontal 2-column card grouping
    assert.match(html, /id="pane-general"/);
    assert.match(html, /id="pane-domains"/);
    assert.match(html, /id="pane-homepage"/);
    assert.match(html, /id="pane-security"/);

    // 3. Script wires window.labkioskSwitchTab
    assert.match(html, /window\.labkioskSwitchTab = switchTab/);

    // 4. Recent Lab Activity table uses table-scrollable container
    assert.match(html, /class="table-container table-scrollable"/);
  });

  // ------------------------------------------------ staff delegation limits

  test("A delegate who manages staff cannot promote themselves or grant beyond their own permissions", async () => {
    const password = "DelegatePassword123!";
    const { res: createRes } = await callJson("/api/tenant/staff?tenant=greenwood", {
      ...json({ name: "Dee Legate", email: "dee@greenwood.example", password, role: "operator", permissions: ["workstations", "staff"] }),
      cookie: orgSessionCookie
    });
    assert.equal(createRes.status, 200);

    const loginRes = await call("/api/auth/login", json({ email: "dee@greenwood.example", password }));
    assert.equal(loginRes.status, 200);
    const delegateCookie = loginRes.headers.get("Set-Cookie")!.split(";")[0];

    const { data: list } = await callJson("/api/tenant/staff?tenant=greenwood", { cookie: delegateCookie });
    const self = list.staff.find((t: any) => t.email === "dee@greenwood.example");
    assert.ok(self);

    // Self-promotion to co-administrator, whose permissions are "*".
    const promote = await call("/api/tenant/staff/update?tenant=greenwood", {
      ...json({ id: self.id, role: "org_admin" }),
      cookie: delegateCookie
    });
    assert.equal(promote.status, 403);

    // Settings stay out of reach afterwards.
    const settings = await call("/api/tenant/settings?tenant=greenwood", { ...json({}), cookie: delegateCookie });
    assert.equal(settings.status, 403);

    // Appointing a new co-administrator, or granting a permission not held.
    const coAdmin = await call("/api/tenant/staff?tenant=greenwood", {
      ...json({ name: "Mallory", email: "mallory@greenwood.example", password, role: "org_admin" }),
      cookie: delegateCookie
    });
    assert.equal(coAdmin.status, 403);
    const beyond = await call("/api/tenant/staff?tenant=greenwood", {
      ...json({ name: "Mallory", email: "mallory@greenwood.example", password, role: "operator", permissions: ["settings"] }),
      cookie: delegateCookie
    });
    assert.equal(beyond.status, 403);

    // Within their own permissions a delegate may still add staff.
    const within = await call("/api/tenant/staff?tenant=greenwood", {
      ...json({ name: "Lab Aide", email: "aide@greenwood.example", password, role: "assistant", permissions: ["workstations"] }),
      cookie: delegateCookie
    });
    assert.equal(within.status, 200);
  });

  test("Staff permissions are validated, and a wildcard can never be stored", async () => {
    const wildcard = await call("/api/tenant/staff?tenant=greenwood", {
      ...json({ name: "Wild", email: "wild@greenwood.example", password: "WildPassword123!", permissions: ["*"] }),
      cookie: orgSessionCookie
    });
    assert.equal(wildcard.status, 400);

    const badRole = await call("/api/tenant/staff?tenant=greenwood", {
      ...json({ name: "Wild", email: "wild@greenwood.example", password: "WildPassword123!", role: "owner" }),
      cookie: orgSessionCookie
    });
    assert.equal(badRole.status, 400);

    const weak = await call("/api/tenant/staff?tenant=greenwood", {
      ...json({ name: "Weak", email: "weak@greenwood.example", password: "short" }),
      cookie: orgSessionCookie
    });
    assert.equal(weak.status, 400);
  });

  test("Adding staff never links an account that already exists", async () => {
    // Riverside's administrator must not become a member of Greenwood.
    const res = await call("/api/tenant/staff?tenant=greenwood", {
      ...json({ name: "Poached", email: "operator@riverside.example", password: "PoachedPassword123!" }),
      cookie: orgSessionCookie
    });
    assert.equal(res.status, 409);
  });

  test("Removing a staff account ends the sessions it holds", async () => {
    const password = "RemovedPassword123!";
    await call("/api/tenant/staff?tenant=greenwood", {
      ...json({ name: "Soon Gone", email: "gone@greenwood.example", password, role: "operator", permissions: ["workstations"] }),
      cookie: orgSessionCookie
    });
    const loginRes = await call("/api/auth/login", json({ email: "gone@greenwood.example", password }));
    const goneCookie = loginRes.headers.get("Set-Cookie")!.split(";")[0];
    assert.equal((await call("/api/clients?tenant=greenwood", { cookie: goneCookie })).status, 200);

    const { data: list } = await callJson("/api/tenant/staff?tenant=greenwood", { cookie: orgSessionCookie });
    const gone = list.staff.find((t: any) => t.email === "gone@greenwood.example");
    const del = await call(`/api/tenant/staff/${gone.id}?tenant=greenwood`, { method: "DELETE", cookie: orgSessionCookie });
    assert.equal(del.status, 200);

    // Refused whichever way: no session (401), or a named organization it may not act on (403).
    assert.ok([401, 403].includes((await call("/api/clients?tenant=greenwood", { cookie: goneCookie })).status));
    const { data: me } = await callJson("/api/auth/me", { cookie: goneCookie });
    assert.ok(!me.user);
  });

  test("A staff name must be text, is trimmed, and is capped like a registration's", async () => {
    const add = (fields: Record<string, unknown>) =>
      callJson("/api/tenant/staff?tenant=greenwood", {
        ...json({ email: `named-${Math.random().toString(36).slice(2)}@greenwood.example`, password: "NamedPassword123!", ...fields }),
        cookie: orgSessionCookie
      });
    for (const name of [42, "   ", { first: "A" }]) {
      const { res, data } = await add({ name });
      assert.equal(res.status, 400, `name ${JSON.stringify(name)} is refused`);
      assert.equal(data.error, "Name and email are required");
    }
    const { res, data } = await add({ name: `  ${"N".repeat(300)}  ` });
    assert.equal(res.status, 200);
    const { data: list } = await callJson("/api/tenant/staff?tenant=greenwood", { cookie: orgSessionCookie });
    const created = list.staff.find((s: any) => s.id === data.operator?.id || s.email === data.operator?.email);
    assert.ok(created, "the new staff member is listed");
    assert.equal(created.name, "N".repeat(120));
  });

  test("The organization's owner can appoint a co-administrator", async () => {
    // The owner has no tenant_users row of their own; getTenantUserPermissions()
    // must still answer "*" for them, or they could not delegate at all.
    const res = await call("/api/tenant/staff?tenant=greenwood", {
      ...json({ name: "Co Admin", email: "coadmin@greenwood.example", password: "CoAdminPassword123!", role: "org_admin" }),
      cookie: orgSessionCookie
    });
    assert.equal(res.status, 200);
  });

  test("Remote Control never borrows the demo tunnel or puts the VNC password in a query string", async () => {
    // An organization without a tunnel of its own used to fall back to the demo
    // organization's, sending its VNC password to <pc>.demo.<domain>.
    const ws = await (await call("/admin/workstations?tenant=greenwood", { cookie: orgSessionCookie })).text();
    assert.doesNotMatch(ws, /TUNNEL_DOMAIN = "demo\./, "another organization's tunnel is never the default");
    assert.doesNotMatch(ws, /params\.set\("password"/, "the password goes in the fragment, never the query");
    const settings = await (await call("/admin/settings?tenant=greenwood&tab=domains", { cookie: orgSessionCookie })).text();
    assert.match(settings, /id="setting-tunnel-domain" value=""/, "no tunnel domain is pre-filled");
  });

  test("Workstation groups are rendered on the Workstations page", async () => {
    const name = "Rendered Group";
    assert.equal((await call("/api/groups?tenant=greenwood", { ...json({ name }), cookie: orgSessionCookie })).status, 200);
    const html = await (await call("/admin/workstations?tenant=greenwood", { cookie: orgSessionCookie })).text();
    assert.ok(html.includes(name), "a group the organization created appears on the page");
  });

  test("The staff list is readable only with the staff permission", async () => {
    const password = "ListPassword1234!";
    await call("/api/tenant/staff?tenant=greenwood", {
      ...json({ name: "Only Screens", email: "screens@greenwood.example", password, role: "assistant", permissions: ["workstations"] }),
      cookie: orgSessionCookie
    });
    const loginRes = await call("/api/auth/login", json({ email: "screens@greenwood.example", password }));
    const cookie = loginRes.headers.get("Set-Cookie")!.split(";")[0];
    assert.equal((await call("/api/tenant/staff?tenant=greenwood", { cookie })).status, 403);
  });

  // --------------------------------------------- groups and batch commands

  test("Workstation group routes refuse anonymous, cross-organization and cross-site callers", async () => {
    // Anonymous: 401 without an organization, 403 once an organization is named on a production host.
    const refused = (status: number) => status === 401 || status === 403;
    assert.ok(refused((await call("/api/groups")).status));
    assert.ok(refused((await call("/api/groups?tenant=greenwood")).status));
    assert.ok(refused((await call("/api/groups?tenant=greenwood", json({ name: "Anon" }))).status));
    assert.ok(refused((await call("/api/clients/group?tenant=greenwood", json({ clientIds: ["PC-01"], groupName: null }))).status));

    // Riverside's administrator naming Greenwood.
    assert.equal((await call("/api/groups?tenant=greenwood", { cookie: rivalSessionCookie })).status, 403);
    assert.equal(
      (await call("/api/groups?tenant=greenwood", { ...json({ name: "Rival" }), cookie: rivalSessionCookie })).status,
      403
    );

    const crossSite = await call("/api/groups?tenant=greenwood", {
      ...json({ name: "Forged" }),
      cookie: orgSessionCookie,
      headers: { Origin: "https://evil.example" }
    });
    assert.equal(crossSite.status, 403);
  });

  test("Workstation groups have unique names and only existing groups can be assigned or deleted", async () => {
    const first = await call("/api/groups?tenant=greenwood", { ...json({ name: "Lab B" }), cookie: orgSessionCookie });
    assert.equal(first.status, 200);
    const duplicate = await call("/api/groups?tenant=greenwood", { ...json({ name: "lab b" }), cookie: orgSessionCookie });
    assert.equal(duplicate.status, 409);
    const tooLong = await call("/api/groups?tenant=greenwood", { ...json({ name: "x".repeat(51) }), cookie: orgSessionCookie });
    assert.equal(tooLong.status, 400);

    const phantom = await call("/api/clients/group?tenant=greenwood", {
      ...json({ clientIds: ["PC-01"], groupName: "Nowhere" }),
      cookie: orgSessionCookie
    });
    assert.equal(phantom.status, 404);

    const missing = await call("/api/groups/no-such-group?tenant=greenwood", { method: "DELETE", cookie: orgSessionCookie });
    assert.equal(missing.status, 404);

    // More ids than one D1 statement can bind are written in slices.
    const many = Array.from({ length: 150 }, (_, i) => `PC-${i}`);
    const bulk = await call("/api/clients/group?tenant=greenwood", {
      ...json({ clientIds: many, groupName: "Lab B" }),
      cookie: orgSessionCookie
    });
    assert.equal(bulk.status, 200);
  });

  test("Batch commands are capped, and a broadcast to all is queued once", async () => {
    const tooMany = await call("/api/command?tenant=greenwood", {
      ...json({ targets: Array.from({ length: 501 }, (_, i) => `PC-${i}`), action: "reload" }),
      cookie: orgSessionCookie
    });
    assert.equal(tooMany.status, 400);

    const { res, data } = await callJson("/api/command?tenant=greenwood", {
      ...json({ targets: ["all", "PC-01", "PC-01"], action: "reload" }),
      cookie: orgSessionCookie
    });
    assert.equal(res.status, 200);
    assert.equal(data.count, 1);

    // A full batch is queued by one statement, one command per workstation.
    const full = Array.from({ length: 500 }, (_, i) => `BATCH-${i}`);
    const batch = await callJson("/api/command?tenant=greenwood", {
      ...json({ targets: full, action: "reload" }),
      cookie: orgSessionCookie
    });
    assert.equal(batch.res.status, 200);
    assert.equal(batch.data.count, 500);
    assert.equal(new Set(batch.data.commandIds).size, 500);
  });

  test("A localhost origin is not same-site for a production host", async () => {
    const res = await call("/api/groups?tenant=greenwood", {
      ...json({ name: "From Localhost" }),
      cookie: orgSessionCookie,
      headers: { Origin: "http://localhost:3000" }
    });
    assert.equal(res.status, 403);
  });

  test("Console client scripts call no server-side escaping helpers", async () => {
    // escapeHtml/escapeAttr exist only on the server. A client script that
    // calls them throws at runtime, as the workstation group list once did.
    for (const page of ["workstations", "apps-web", "staff", "settings"]) {
      const html = await (await call(`/admin/${page}?tenant=greenwood`, { cookie: orgSessionCookie })).text();
      // Case-insensitive, and tolerant of `</script >`, as an HTML parser is: a
      // block spelt any other way would slip past this check.
      const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\b[^>]*>/gi)].map((m) => m[1]).join("\n");
      assert.doesNotMatch(scripts, /\bescape(Html|Attr)\(/, `${page} calls a server-only helper in the browser`);
    }
  });

  // --------------------------------------------------- broadcasts that stick

  test("A broadcast to selected workstations survives their heartbeats, and resets outrank older broadcasts", async () => {
    const tokens: Record<string, string> = {};
    for (const [i, id] of ["BC-1", "BC-2", "BC-3"].entries()) {
      const { res, data } = await callJson("/api/devices/enroll", {
        ...json({ subdomain: "greenwood", enrollmentKey, clientId: id }),
        headers: { "CF-Connecting-IP": `198.51.100.${40 + i}` }
      });
      assert.equal(res.status, 200);
      tokens[id] = data.deviceToken;
    }
    const beat = async (id: string) =>
      (await callJson("/api/telemetry", { ...json({ activeUrl: "https://khanacademy.org" }), bearer: tokens[id] })).data;
    const command = async (body: Record<string, unknown>) => {
      await new Promise((r) => setTimeout(r, 5)); // distinct epochs, as real clicks are
      const { res } = await callJson("/api/command?tenant=greenwood", { ...json(body), cookie: orgSessionCookie });
      assert.equal(res.status, 200);
    };
    for (const id of Object.keys(tokens)) await beat(id);

    const pageA = "https://phet.colorado.edu/page-a";
    const pageB = "https://scratch.mit.edu/page-b";

    // 1. Selected workstations: the second and third heartbeats must not undo it.
    await command({ targets: ["BC-1", "BC-2"], action: "navigate", url: pageA });
    for (let n = 0; n < 3; n++) {
      const hb = await beat("BC-1");
      assert.equal(hb.targetUrl, pageA, `heartbeat ${n + 1} sent BC-1 away from the broadcast`);
      assert.ok(hb.broadcastEpoch > 0);
    }
    const bystander = await beat("BC-3");
    assert.notEqual(bystander.targetUrl, pageA, "an unselected workstation must not follow the broadcast");
    assert.equal(bystander.broadcastEpoch, 0);

    // 2. A newer organization-wide broadcast outranks the per-workstation one.
    await command({ target: "all", action: "navigate", url: pageB });
    assert.equal((await beat("BC-1")).targetUrl, pageB);
    assert.equal((await beat("BC-3")).targetUrl, pageB);

    // 3. Resetting one workstation outranks the older organization-wide broadcast for it alone.
    await command({ targets: ["BC-2"], action: "navigate", resetPortal: true });
    const reset = await beat("BC-2");
    assert.notEqual(reset.targetUrl, pageB);
    assert.equal(reset.broadcastEpoch, 0);
    assert.equal((await beat("BC-1")).targetUrl, pageB, "a reset of BC-2 must not stop BC-1's broadcast");

    // 4. Stopping the broadcast for everyone clears every screen.
    await command({ target: "all", action: "navigate", resetPortal: true });
    for (const id of Object.keys(tokens)) {
      const hb = await beat(id);
      assert.equal(hb.broadcastEpoch, 0, `${id} still has a broadcast after Stop`);
    }

    // 5. A later broadcast to one workstation still sticks.
    await command({ targets: ["BC-3"], action: "navigate", url: pageA });
    assert.equal((await beat("BC-3")).targetUrl, pageA);
    assert.equal((await beat("BC-3")).targetUrl, pageA);
  });

  // ------------------------------------------------------------ clear session

  test("Clear Session is queued for the selected workstations and delivered on their next heartbeat", async () => {
    const { res, data } = await callJson("/api/command?tenant=greenwood", {
      ...json({ targets: ["PC-01"], action: "clear-session" }),
      cookie: orgSessionCookie
    });
    assert.equal(res.status, 200);
    assert.equal(data.count, 1);

    const { data: heartbeat } = await callJson("/api/telemetry", { ...json({}), bearer: deviceToken });
    assert.ok(
      heartbeat.commands.some((c: any) => c.action === "clear-session"),
      "PC-01 must receive clear-session"
    );
  });

  test("Clear Session requires the workstations permission and refuses anonymous callers", async () => {
    const anonymous = await call("/api/command?tenant=greenwood", json({ targets: ["PC-01"], action: "clear-session" }));
    assert.ok(anonymous.status === 401 || anonymous.status === 403);

    const password = "BroadcastOnly123!";
    await call("/api/tenant/staff?tenant=greenwood", {
      ...json({ name: "Broadcast Only", email: "broadcaster@greenwood.example", password, role: "operator", permissions: ["broadcast"] }),
      cookie: orgSessionCookie
    });
    const loginRes = await call("/api/auth/login", json({ email: "broadcaster@greenwood.example", password }));
    const cookie = loginRes.headers.get("Set-Cookie")!.split(";")[0];
    const refused = await call("/api/command?tenant=greenwood", {
      ...json({ targets: ["PC-01"], action: "clear-session" }),
      cookie
    });
    assert.equal(refused.status, 403);

    // The console offers the control, confirmed, next to Reboot and Shutdown.
    const html = await (await call("/admin/workstations?tenant=greenwood", { cookie: orgSessionCookie })).text();
    assert.match(html, /id="btn-clear-session-all"/);
    assert.match(html, /sendCommand\(targets, "clear-session"\)/);
  });

  // ------------------------------------------------ organization vocabulary

  test("The old staff and super-console paths redirect to their new names", async () => {
    const staff = await call("/admin/teachers?tenant=greenwood", { cookie: orgSessionCookie, redirect: "manual" });
    assert.equal(staff.status, 302);
    assert.match(staff.headers.get("location") || "", /\/admin\/staff\?tenant=greenwood$/);

    const orgs = await call("/super/schools", { cookie: superSessionCookie, redirect: "manual" });
    assert.equal(orgs.status, 302);
    assert.match(orgs.headers.get("location") || "", /\/super\/organizations$/);

    const page = await call("/admin/staff?tenant=greenwood", { cookie: orgSessionCookie });
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Staff &amp; Delegation/);
  });

  test("Workstations still get schoolName alongside organizationName, for agents installed before the rename", async () => {
    const { data } = await callJson("/api/status?tenant=greenwood");
    assert.equal(data.organizationName, "Greenwood Holdings");
    assert.equal(data.schoolName, data.organizationName);
  });

  test("No console, portal or organization page speaks of schools, teachers, students or lessons", async () => {
    // The landing page (which has an Education audience) and the legal pages
    // (which quote the license's educational grant) are deliberately excluded.
    const pages: [string, string?][] = [
      ["/admin/workstations?tenant=greenwood", orgSessionCookie],
      ["/admin/apps-web?tenant=greenwood", orgSessionCookie],
      ["/admin/staff?tenant=greenwood", orgSessionCookie],
      ["/admin/settings?tenant=greenwood", orgSessionCookie],
      ["/super", superSessionCookie],
      ["/super/organizations", superSessionCookie],
      ["/super/approvals", superSessionCookie],
      ["/super/catalogs", superSessionCookie],
      ["/super/system", superSessionCookie],
      ["/home?tenant=greenwood"],
      ["/?tenant=greenwood"]
    ];
    // Also the leftovers a word-for-word rename produces: an education footer,
    // "Enter the Lab", and a noun doubled where "Schools & Organizations" was.
    const wrong = new RegExp(
      [
        String.raw`\b(schools?|teachers?|students?|lessons?|classrooms?|instructors?)\b`,
        String.raw`\beducational\b`,
        String.raw`\b(FERPA|COPPA)\b`,
        String.raw`\b(enter the lab|lab (activity|configuration))\b`,
        String.raw`\b(?<noun>\w{4,}) (?:&amp;|&|and) \k<noun>\b`
      ].join("|"),
      "i"
    );
    for (const [path, cookie] of pages) {
      const res = await call(path, cookie ? { cookie } : {});
      assert.equal(res.status, 200, `${path} did not render`);
      const html = await res.text();
      const hit = html.match(wrong);
      assert.equal(hit, null, `${path} still says "${hit?.[0]}" near: ${hit ? html.slice(Math.max(0, hit.index! - 80), hit.index! + 40) : ""}`);
    }
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

  // ---------------------------------------------------- the real engine

  const migrationDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "migrations");
  const migrationFiles = () => fs.readdirSync(migrationDir).filter((f) => f.endsWith(".sql")).sort();

  /**
   * Apply migrations the way D1 does: foreign keys enforced, each file as one
   * unit (so defer_foreign_keys lasts for exactly that file).
   */
  function migratedDb(upTo?: string): DatabaseSync {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys = ON;");
    for (const f of migrationFiles()) {
      if (upTo && f >= upTo) break;
      db.exec("BEGIN;");
      db.exec(fs.readFileSync(path.join(migrationDir, f), "utf8"));
      db.exec("COMMIT;");
    }
    return db;
  }

  /** Everything SQLite knows about a table that a column-name comparison misses. */
  function describeSchema(db: DatabaseSync): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const tables = db
      .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'd1_%'")
      .all() as { name: string; sql: string }[];
    for (const { name, sql } of tables) {
      out[name] = {
        columns: (db.prepare(`PRAGMA table_info(${name})`).all() as any[])
          .map((c) => `${c.name} ${c.type} notnull=${c.notnull} default=${c.dflt_value} pk=${c.pk}`)
          .sort(),
        foreignKeys: (db.prepare(`PRAGMA foreign_key_list(${name})`).all() as any[])
          .map((k) => `${k.from}->${k.table}.${k.to} ${k.on_delete}`)
          .sort(),
        indexes: (db.prepare(`PRAGMA index_list(${name})`).all() as any[])
          .filter((i) => i.origin === "c")
          .map((i) => `${i.name}${i.unique ? " UNIQUE" : ""}`)
          .sort(),
        checks: [...sql.matchAll(/CHECK\s*\(([^()]*(?:\([^()]*\))?[^()]*)\)/g)].map((m) => m[1].replace(/\s+/g, " ")).sort()
      };
    }
    return out;
  }

  test("SCHEMA_SQL builds exactly the schema migrations/ builds: types, defaults, keys, indexes and CHECKs", () => {
    // The column-name test above could not see that SCHEMA_SQL had made
    // idx_tenants_custom_domain non-unique while production had it UNIQUE.
    const fromSchema = new DatabaseSync(":memory:");
    fromSchema.exec(SCHEMA_SQL);
    assert.deepEqual(describeSchema(fromSchema), describeSchema(migratedDb()));
  });

  /** Just enough of D1 for assertSchemaCurrent(), over a real SQLite database. */
  function asD1(db: DatabaseSync): D1Database {
    const statement = (sql: string) => ({
      bind: () => statement(sql),
      run: async () => { db.prepare(sql).all(); return { success: true, results: [], meta: {} }; },
      first: async () => (db.prepare(sql).get() as unknown) ?? null
    });
    return { prepare: statement } as unknown as D1Database;
  }

  test("A worker refuses a database that has not had 0011 or 0012 applied, and accepts one that has", async () => {
    await assert.rejects(assertSchemaCurrent(asD1(migratedDb("0011"))), /missing the current schema/);
    await assert.rejects(assertSchemaCurrent(asD1(migratedDb("0012"))), /missing the current schema/);
    await assertSchemaCurrent(asD1(migratedDb()));
  });

  test("0013 removes the old demo and everything in it, and nothing else", async () => {
    const db = migratedDb("0013");
    const seed = (t: string, owner: string) => `
      INSERT INTO tenants (id, user_id, name, subdomain, status, created_at, updated_at) VALUES ('${t}', '${owner}', '${t}', '${t === "t-demo" ? "demo" : "acme"}', 'active', 1, 1);
      INSERT INTO sessions (token, user_id, tenant_id, role, expires_at) VALUES ('s-${t}', '${owner}', '${t}', 'org_admin', 99999999999);
      INSERT INTO portal_sites (id, tenant_id, title, url, domain, created_at) VALUES ('p-${t}', '${t}', 'Docs', 'https://docs.example', 'docs.example', 1);
      INSERT INTO client_devices (id, tenant_id, client_id, last_seen, created_at, updated_at) VALUES ('${t}:PC', '${t}', 'PC', 1, 1, 1);
      INSERT INTO commands (id, tenant_id, target, action, created_at, expires_at) VALUES ('c-${t}', '${t}', 'PC', 'lock', 1, 99);
      INSERT INTO command_deliveries (command_id, client_id, delivered_at) VALUES ('c-${t}', 'PC', 1);
      INSERT INTO audit_logs (id, tenant_id, user_id, action, created_at) VALUES ('a-${t}', '${t}', '${owner}', 'auth.login', 1);
      INSERT INTO device_tokens (id, token_hash, tenant_id, client_id, created_at, last_used_at) VALUES ('d-${t}', 'h-${t}', '${t}', 'PC', 1, 1);
      INSERT INTO tenant_whitelist (id, tenant_id, domain, created_at) VALUES ('w-${t}', '${t}', 'docs.example', 1);
      INSERT INTO broadcast_presets (id, tenant_id, title, url, created_at) VALUES ('b-${t}', '${t}', 'Handbook', 'https://docs.example/h', 1);
      INSERT INTO workstation_groups (id, tenant_id, name, created_at) VALUES ('g-${t}', '${t}', 'Floor 1', 1);
    `;
    db.exec(`
      INSERT INTO users (id, email, password_hash, salt, role, name, created_at) VALUES
        ('u-super', 'root@example.com', 'h', 's', 'super_admin', 'Root', 1),
        ('u-acme', 'owner@acme.example', 'h', 's', 'org_admin', 'Owner', 1);
      ${seed("t-demo", "u-super")}
      ${seed("t-acme", "u-acme")}
    `);
    await assert.rejects(assertSchemaCurrent(asD1(db)), /missing the current schema/, "a database still holding demo is refused");

    db.exec("BEGIN;");
    db.exec(fs.readFileSync(path.join(migrationDir, "0013_retire_demo_tenant.sql"), "utf8"));
    db.exec("COMMIT;");

    const tables: [string, string][] = [
      ["tenants", "id"], ["sessions", "tenant_id"], ["portal_sites", "tenant_id"], ["client_devices", "tenant_id"],
      ["commands", "tenant_id"], ["audit_logs", "tenant_id"], ["device_tokens", "tenant_id"],
      ["tenant_whitelist", "tenant_id"], ["broadcast_presets", "tenant_id"], ["workstation_groups", "tenant_id"]
    ];
    for (const [table, column] of tables) {
      const count = (t: string) => (db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${column} = ?`).get(t) as any).n;
      assert.equal(count("t-demo"), 0, `${table} still holds the demo's rows`);
      assert.equal(count("t-acme"), 1, `${table} lost another organization's row`);
    }
    const deliveries = (id: string) => (db.prepare("SELECT count(*) AS n FROM command_deliveries WHERE command_id = ?").get(id) as any).n;
    assert.equal(deliveries("c-t-demo"), 0, "the demo's delivery receipts are gone");
    assert.equal(deliveries("c-t-acme"), 1);
    assert.equal((db.prepare("SELECT count(*) AS n FROM audit_logs WHERE tenant_id IS NULL").get() as any).n, 0,
      "no demo history is left behind as platform history");
    assert.equal((db.prepare("SELECT count(*) AS n FROM users").get() as any).n, 2, "user accounts are kept");
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    await assertSchemaCurrent(asD1(db));
  });

  test("0012 folds duplicate group names into one group and keeps every member grouped", () => {
    const db = migratedDb("0012");
    db.exec(`
      INSERT INTO users (id, email, password_hash, salt, role, name, created_at) VALUES ('u1', 'owner@example.com', 'h', 's', 'org_admin', 'Owner', 1);
      INSERT INTO tenants (id, user_id, name, subdomain, status, created_at, updated_at) VALUES ('t1', 'u1', 'Acme', 'acme', 'active', 1, 1);
      INSERT INTO tenants (id, user_id, name, subdomain, status, created_at, updated_at) VALUES ('t2', 'u1', 'Other', 'other', 'active', 1, 1);
      INSERT INTO workstation_groups (id, tenant_id, name, created_at) VALUES ('g-old', 't1', 'Floor 1', 10);
      INSERT INTO workstation_groups (id, tenant_id, name, created_at) VALUES ('g-new', 't1', 'floor 1', 20);
      INSERT INTO workstation_groups (id, tenant_id, name, created_at) VALUES ('g-t2', 't2', 'Floor 1', 5);
      INSERT INTO client_devices (id, tenant_id, client_id, last_seen, group_name, created_at, updated_at) VALUES ('t1:A', 't1', 'A', 1, 'Floor 1', 1, 1);
      INSERT INTO client_devices (id, tenant_id, client_id, last_seen, group_name, created_at, updated_at) VALUES ('t1:B', 't1', 'B', 1, 'floor 1', 1, 1);
      INSERT INTO client_devices (id, tenant_id, client_id, last_seen, group_name, created_at, updated_at) VALUES ('t2:C', 't2', 'C', 1, 'Floor 1', 1, 1);
    `);

    db.exec("BEGIN;");
    db.exec(fs.readFileSync(path.join(migrationDir, "0012_unique_workstation_group_names.sql"), "utf8"));
    db.exec("COMMIT;");

    const groups = db.prepare("SELECT id FROM workstation_groups ORDER BY id").all().map((r: any) => r.id);
    assert.deepEqual(groups, ["g-old", "g-t2"], "the oldest group of each name survives, per organization");
    const members = db.prepare("SELECT id, group_name FROM client_devices ORDER BY id").all().map((r: any) => `${r.id}=${r.group_name}`);
    assert.deepEqual(members, ["t1:A=Floor 1", "t1:B=Floor 1", "t2:C=Floor 1"]);

    assert.throws(() => db.exec("INSERT INTO workstation_groups (id, tenant_id, name, created_at) VALUES ('dup', 't1', 'FLOOR 1', 30)"));
    db.exec("INSERT INTO workstation_groups (id, tenant_id, name, created_at) VALUES ('ok', 't1', 'Floor 2', 30)");
  });

  // @vocab-keep-start: this test seeds the pre-0011 values on purpose.
  test("0011 renames the stored roles without losing a single row or breaking a reference", () => {
    const db = migratedDb("0011");
    const now = 1_700_000_000;
    const oldLock = "Screens locked by the instructor. Please look to the front.";
    db.exec(`
      INSERT INTO users (id, email, password_hash, salt, role, name, created_at) VALUES
        ('u-super', 'root@example.com', 'h', 's', 'super_admin', 'Root', ${now}),
        ('u-owner', 'owner@example.com', 'h', 's', 'school_admin', 'Owner', ${now}),
        ('u-op', 'op@example.com', 'h', 's', 'school_admin', 'Op', ${now}),
        ('u-asst', 'asst@example.com', 'h', 's', 'school_admin', 'Asst', ${now});
      INSERT INTO tenants (id, user_id, name, subdomain, status, custom_domain, created_at, updated_at) VALUES
        ('t1', 'u-owner', 'Acme', 'acme', 'active', 'kiosk.acme.example', ${now}, ${now});
      INSERT INTO tenants (id, user_id, name, subdomain, status, default_lock_message, created_at, updated_at) VALUES
        ('t2', 'u-super', 'Demo', 'demo', 'active', 'Custom message kept', ${now}, ${now});
      INSERT INTO sessions (token, user_id, tenant_id, role, expires_at) VALUES
        ('s-owner', 'u-owner', 't1', 'school_admin', ${now + 999}),
        ('s-super', 'u-super', NULL, 'super_admin', ${now + 999});
      INSERT INTO tenant_users (id, tenant_id, user_id, role, permissions, created_at) VALUES
        ('tu-op', 't1', 'u-op', 'teacher', '["workstations","teachers"]', ${now}),
        ('tu-asst', 't1', 'u-asst', 'lab_assistant', '["workstations"]', ${now});
      INSERT INTO portal_sites (id, tenant_id, title, url, domain, created_at) VALUES ('p1', 't1', 'Docs', 'https://docs.example', 'docs.example', ${now});
      INSERT INTO client_devices (id, tenant_id, client_id, last_seen, group_name, broadcast_url, broadcast_epoch, created_at, updated_at)
        VALUES ('t1:PC-01', 't1', 'PC-01', ${now}, 'Floor 1', 'https://docs.example', 5, ${now}, ${now});
      INSERT INTO commands (id, tenant_id, target, action, created_at, expires_at) VALUES ('c1', 't1', 'PC-01', 'lock', ${now}, ${now + 60});
      INSERT INTO audit_logs (id, tenant_id, user_id, action, created_at) VALUES ('a1', 't1', 'u-owner', 'auth.login', ${now});
      INSERT INTO device_tokens (id, token_hash, tenant_id, client_id, created_at, last_used_at) VALUES ('d1', 'hash', 't1', 'PC-01', ${now}, ${now});
      INSERT INTO tenant_whitelist (id, tenant_id, domain, created_at) VALUES ('w1', 't1', 'docs.example', ${now});
      INSERT INTO broadcast_presets (id, tenant_id, title, url, created_at) VALUES ('b1', 't1', 'Handbook', 'https://docs.example/h', ${now});
      INSERT INTO workstation_groups (id, tenant_id, name, created_at) VALUES ('g1', 't1', 'Floor 1', ${now});
    `);
    const tables = [
      "users", "tenants", "sessions", "portal_sites", "client_devices", "commands", "audit_logs",
      "device_tokens", "tenant_whitelist", "broadcast_presets", "tenant_users", "workstation_groups"
    ];
    const counts = () => Object.fromEntries(tables.map((t) => [t, (db.prepare(`SELECT count(*) AS n FROM ${t}`).get() as any).n]));
    const before = counts();

    db.exec("BEGIN;");
    db.exec(fs.readFileSync(path.join(migrationDir, "0011_organization_vocabulary.sql"), "utf8"));
    db.exec("COMMIT;");

    assert.deepEqual(counts(), before, "a table lost or gained rows");
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), [], "a reference was left dangling");
    const leftovers = db.prepare("SELECT name FROM sqlite_master WHERE name LIKE '_hold_%'").all();
    assert.deepEqual(leftovers, [], "holding tables must be dropped");

    const value = (sql: string) => db.prepare(sql).get() as any;
    assert.equal(value("SELECT role FROM users WHERE id = 'u-owner'").role, "org_admin");
    assert.equal(value("SELECT role FROM users WHERE id = 'u-super'").role, "super_admin");
    assert.equal(value("SELECT role FROM sessions WHERE token = 's-owner'").role, "org_admin");
    assert.equal(value("SELECT role FROM tenant_users WHERE id = 'tu-op'").role, "operator");
    assert.equal(value("SELECT role FROM tenant_users WHERE id = 'tu-asst'").role, "assistant");
    assert.deepEqual(JSON.parse(value("SELECT permissions FROM tenant_users WHERE id = 'tu-op'").permissions), ["workstations", "staff"]);
    assert.equal(
      value("SELECT default_lock_message AS m FROM tenants WHERE id = 't1'").m,
      "This screen has been locked by an administrator. Please wait."
    );
    assert.equal(value("SELECT default_lock_message AS m FROM tenants WHERE id = 't2'").m, "Custom message kept");
    assert.notEqual(oldLock, "");
    const device = value("SELECT group_name, broadcast_url, broadcast_epoch FROM client_devices WHERE id = 't1:PC-01'");
    assert.deepEqual({ ...device }, { group_name: "Floor 1", broadcast_url: "https://docs.example", broadcast_epoch: 5 });

    // The new CHECKs are in force, and the old values can no longer be written.
    assert.throws(() => db.exec(`INSERT INTO users (id, email, password_hash, salt, role, name, created_at) VALUES ('x', 'x@example.com', 'h', 's', 'school_admin', 'X', ${now})`));
    assert.throws(() => db.exec(`UPDATE tenant_users SET role = 'teacher' WHERE id = 'tu-op'`));
    // And the custom domain is unique again.
    assert.throws(() => db.exec(`UPDATE tenants SET custom_domain = 'kiosk.acme.example' WHERE id = 't2'`));
    // Deleting an organization still cascades to its own rows only.
    db.exec("DELETE FROM tenants WHERE id = 't1'");
    assert.equal(value("SELECT count(*) AS n FROM client_devices").n, 0);
    assert.equal(value("SELECT count(*) AS n FROM users").n, 4);
  });
  // @vocab-keep-end
});
