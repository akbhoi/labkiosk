/**
 * Single sign-on (src/sso.ts): ID token verification against generated RSA
 * keys, the start -> callback -> redeem flow with the provider's endpoints
 * stood in for, and the negative cases of every route. Nothing here reaches
 * Google or Microsoft.
 */

import { test, describe, mock, before, after } from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index";
import { Env } from "../src/types";
import { getDatabase } from "../src/database";
import { createTenant, createTenantUser, createUser, deleteTenantUser, updateTenant } from "../src/db";
import { passwordPepper } from "../src/auth";
import { localOutbox } from "../src/mail";
import {
  IdTokenExpectations,
  SsoError,
  forgetSigningKeys,
  parseSsoSettings,
  providerSigningKey,
  purgeExpiredSsoStates,
  verifyIdToken
} from "../src/sso";

const GOOGLE_CLIENT = "google-client.apps.example";
const MICROSOFT_CLIENT = "6f1c0d3e-1111-4222-8333-944455556666";
const ENTRA_TENANT = "72f988bf-86f1-41af-91ab-2d7cd011db47";
const OTHER_ENTRA_TENANT = "0b9f4c2e-5d6a-4e7b-8c9d-0123456789ab";

const env: Env = {
  DEFAULT_DOMAIN: "labkiosk.org",
  SUPER_ADMIN_EMAIL: "admin@labkiosk.org",
  SUPER_ADMIN_PASSWORD: "SuperAdminPassword2026!",
  ALLOW_LOCAL_DB: "1",
  BREACHED_PASSWORD_CHECK: "off",
  GOOGLE_CLIENT_ID: GOOGLE_CLIENT,
  GOOGLE_CLIENT_SECRET: "google-secret",
  MICROSOFT_CLIENT_ID: MICROSOFT_CLIENT,
  MICROSOFT_CLIENT_SECRET: "microsoft-secret"
};
/** The same platform without Microsoft's client. */
const googleOnlyEnv: Env = { ...env, MICROSOFT_CLIENT_ID: undefined, MICROSOFT_CLIENT_SECRET: undefined };
/** And without either. */
const noSsoEnv: Env = { ...googleOnlyEnv, GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: undefined };

const b64url = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64url");
const text = (value: unknown) => b64url(new TextEncoder().encode(JSON.stringify(value)));

interface TestKey {
  kid: string;
  jwk: JsonWebKey;
  privateKey: CryptoKey;
}

async function rsaKey(kid: string): Promise<TestKey> {
  const pair = (await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"]
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return { kid, jwk: { kty: "RSA", n: jwk.n, e: jwk.e, alg: "RS256", use: "sig", kid } as JsonWebKey, privateKey: pair.privateKey };
}

async function signToken(key: TestKey, claims: Record<string, unknown>, header: Record<string, unknown> = {}): Promise<string> {
  const head = text({ alg: "RS256", typ: "JWT", kid: key.kid, ...header });
  const body = text(claims);
  const signature = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key.privateKey, new TextEncoder().encode(`${head}.${body}`)));
  return `${head}.${body}.${b64url(signature)}`;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

function googleClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: "https://accounts.google.com",
    aud: GOOGLE_CLIENT,
    sub: "110000000000000000001",
    email: "Op@Acme.example",
    email_verified: true,
    hd: "acme.example",
    nonce: "nonce-1",
    iat: nowSeconds() - 5,
    exp: nowSeconds() + 3600,
    ...overrides
  };
}

function microsoftClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const tid = (overrides.tid as string) || ENTRA_TENANT;
  return {
    iss: `https://login.microsoftonline.com/${tid}/v2.0`,
    aud: MICROSOFT_CLIENT,
    sub: "AAAAAAAAAAAAAAAAAAAAAIkzqFVrSaSaFHy782bbtaQ",
    tid,
    email: "op@acme.example",
    preferred_username: "op@acme.example",
    nonce: "nonce-1",
    iat: nowSeconds() - 5,
    nbf: nowSeconds() - 5,
    exp: nowSeconds() + 3600,
    ...overrides
  };
}

describe("ID token verification", () => {
  let key: TestKey;
  let otherKey: TestKey;
  const resolver = async (_p: string, kid: string) => (kid === key.kid ? key.jwk : null);
  const googleExpect: IdTokenExpectations = { provider: "google", clientId: GOOGLE_CLIENT, nonce: "nonce-1", googleDomains: ["acme.example"], microsoftTenants: [] };
  const microsoftExpect: IdTokenExpectations = { provider: "microsoft", clientId: MICROSOFT_CLIENT, nonce: "nonce-1", googleDomains: [], microsoftTenants: [ENTRA_TENANT] };

  async function refusal(token: string, expect: IdTokenExpectations): Promise<string> {
    try {
      await verifyIdToken(token, expect, resolver);
    } catch (err) {
      assert.ok(err instanceof SsoError, `an SsoError, not ${String(err)}`);
      return err.reason;
    }
    assert.fail("the token was accepted");
  }

  before(async () => {
    key = await rsaKey("key-1");
    otherKey = await rsaKey("key-2");
  });

  test("A good Google token gives its verified, lower-cased address and Workspace domain", async () => {
    const identity = await verifyIdToken(await signToken(key, googleClaims()), googleExpect, resolver);
    assert.deepEqual(identity, { provider: "google", email: "op@acme.example", subject: "110000000000000000001", hd: "acme.example" });
    // The short issuer form Google also uses.
    await verifyIdToken(await signToken(key, googleClaims({ iss: "accounts.google.com" })), googleExpect, resolver);
  });

  test("A good Entra token gives its address and tenant", async () => {
    const identity = await verifyIdToken(await signToken(key, microsoftClaims()), microsoftExpect, resolver);
    assert.deepEqual(identity, { provider: "microsoft", email: "op@acme.example", subject: "AAAAAAAAAAAAAAAAAAAAAIkzqFVrSaSaFHy782bbtaQ", tid: ENTRA_TENANT });
    // No `email` claim (an account without a mailbox): the UPN, when it is shaped like an address.
    const upn = await verifyIdToken(await signToken(key, microsoftClaims({ email: undefined, preferred_username: "Op@Acme.example" })), microsoftExpect, resolver);
    assert.equal(upn.email, "op@acme.example");
    assert.equal(await refusal(await signToken(key, microsoftClaims({ email: undefined, preferred_username: "not-an-address" })), microsoftExpect), "no_email");
  });

  test("A bad signature, an unknown key or another algorithm is refused", async () => {
    const good = await signToken(key, googleClaims());
    const [h, p] = good.split(".");
    const forged = await signToken(otherKey, googleClaims(), { kid: key.kid });
    assert.equal(await refusal(forged, googleExpect), "signature", "signed by a key the provider does not hold");
    const tampered = `${h}.${text(googleClaims({ email: "owner@acme.example" }))}.${good.split(".")[2]}`;
    assert.equal(await refusal(tampered, googleExpect), "signature", "claims changed after signing");
    assert.equal(await refusal(await signToken(otherKey, googleClaims()), googleExpect), "unknown_key", "a kid the provider does not publish");
    assert.equal(await refusal(`${text({ alg: "none", kid: key.kid })}.${p}.`, googleExpect), "algorithm");
    assert.equal(await refusal(`${text({ alg: "HS256", kid: key.kid })}.${p}.${good.split(".")[2]}`, googleExpect), "algorithm");
    assert.equal(await refusal("not.a-token", googleExpect), "malformed");
    assert.equal(await refusal(`%%%.${p}.${good.split(".")[2]}`, googleExpect), "malformed");
    // The claims are read only once the signature over them holds.
    assert.equal(await refusal(`${h}.%%%.${good.split(".")[2]}`, googleExpect), "signature");
  });

  test("Issuer, audience, nonce and times are each checked", async () => {
    assert.equal(await refusal(await signToken(key, googleClaims({ iss: "https://evil.example" })), googleExpect), "issuer");
    assert.equal(await refusal(await signToken(key, googleClaims({ aud: "someone-else" })), googleExpect), "audience");
    assert.equal(await refusal(await signToken(key, googleClaims({ aud: [GOOGLE_CLIENT, "other"], azp: "other" })), googleExpect), "audience", "several audiences need azp to be ours");
    await verifyIdToken(await signToken(key, googleClaims({ aud: [GOOGLE_CLIENT, "other"], azp: GOOGLE_CLIENT })), googleExpect, resolver);
    assert.equal(await refusal(await signToken(key, googleClaims({ nonce: "nonce-2" })), googleExpect), "nonce");
    assert.equal(await refusal(await signToken(key, googleClaims({ nonce: undefined })), googleExpect), "nonce");
    assert.equal(await refusal(await signToken(key, googleClaims({ exp: nowSeconds() - 600 })), googleExpect), "expired");
    assert.equal(await refusal(await signToken(key, googleClaims({ iat: nowSeconds() + 600 })), googleExpect), "issued_later");
    // A minute of clock difference is tolerated.
    await verifyIdToken(await signToken(key, googleClaims({ exp: nowSeconds() - 60 })), googleExpect, resolver);
    assert.equal(await refusal(await signToken(key, microsoftClaims({ nbf: nowSeconds() + 600 })), microsoftExpect), "not_yet_valid");
    assert.equal(await refusal(await signToken(key, microsoftClaims({ iss: `https://login.microsoftonline.com/${OTHER_ENTRA_TENANT}/v2.0` })), microsoftExpect), "issuer", "the issuer must name the token's own tenant");
    assert.equal(await refusal(await signToken(key, microsoftClaims({ aud: GOOGLE_CLIENT })), microsoftExpect), "audience");
  });

  test("Google: the Workspace domain must be one the organization listed, and the address verified", async () => {
    assert.equal(await refusal(await signToken(key, googleClaims({ hd: "rival.example" })), googleExpect), "directory");
    assert.equal(await refusal(await signToken(key, googleClaims({ hd: undefined, email: "someone@gmail.com" })), googleExpect), "directory", "a personal account has no hd");
    assert.equal(await refusal(await signToken(key, googleClaims({ email_verified: false })), googleExpect), "email_unverified");
  });

  test("Entra: the account's tenant must be one the organization listed", async () => {
    assert.equal(await refusal(await signToken(key, microsoftClaims({ tid: OTHER_ENTRA_TENANT })), microsoftExpect), "directory");
    assert.equal(await refusal(await signToken(key, microsoftClaims({ tid: "not-a-guid", iss: "https://login.microsoftonline.com/not-a-guid/v2.0" })), microsoftExpect), "issuer");
  });

  test("Signing keys are cached, read again for an unknown key at most once a minute, and kept when the provider is down", async () => {
    forgetSigningKeys();
    let calls = 0;
    let served = [key.jwk];
    let down = false;
    const fetcher = (async () => {
      calls++;
      if (down) return new Response("unavailable", { status: 503 });
      return new Response(JSON.stringify({ keys: served }), { headers: { "Content-Type": "application/json" } });
    }) as unknown as typeof fetch;
    const t0 = 1_000_000_000_000;
    assert.equal((await providerSigningKey("google", key.kid, fetcher, t0))?.n, key.jwk.n);
    assert.equal((await providerSigningKey("google", key.kid, fetcher, t0 + 1000))?.n, key.jwk.n);
    assert.equal(calls, 1, "a known key comes from the cache");
    served = [key.jwk, otherKey.jwk];
    assert.equal(await providerSigningKey("google", otherKey.kid, fetcher, t0 + 2000), null, "an unknown key within a minute is not fetched again");
    assert.equal(calls, 1);
    assert.equal((await providerSigningKey("google", otherKey.kid, fetcher, t0 + 61_000))?.n, otherKey.jwk.n, "a rotated key is found after a minute");
    assert.equal(calls, 2);
    down = true;
    assert.equal((await providerSigningKey("google", key.kid, fetcher, t0 + 2 * 3600_000))?.n, key.jwk.n, "the stale set is used while the provider is down");
    forgetSigningKeys();
    await assert.rejects(providerSigningKey("google", key.kid, fetcher, t0), (err: unknown) => err instanceof SsoError && err.reason === "keys_unavailable");
    forgetSigningKeys();
  });

  test("Organization settings are validated on the way in", () => {
    const ok = parseSsoSettings({ google: { enabled: true, domains: [" Acme.Example ", "acme.example"] }, microsoft: { enabled: false, tenants: [] }, requireSso: true });
    assert.ok("settings" in ok);
    assert.deepEqual(ok.settings.googleDomains, ["acme.example"], "trimmed, lower-cased, deduplicated");
    const problems: unknown[] = [
      null,
      { google: { enabled: "yes" }, microsoft: { enabled: false }, requireSso: false },
      { google: { enabled: true, domains: [] }, microsoft: { enabled: false }, requireSso: false },
      { google: { enabled: true, domains: ["gmail.com"] }, microsoft: { enabled: false }, requireSso: false },
      { google: { enabled: true, domains: ["not a domain"] }, microsoft: { enabled: false }, requireSso: false },
      { google: { enabled: true, domains: "acme.example" }, microsoft: { enabled: false }, requireSso: false },
      { google: { enabled: false }, microsoft: { enabled: true, tenants: ["acme"] }, requireSso: false },
      { google: { enabled: false }, microsoft: { enabled: true, tenants: ["9188040d-6c67-4c5b-b112-36a304b66dad"] }, requireSso: false },
      { google: { enabled: false }, microsoft: { enabled: false }, requireSso: true },
      { google: { enabled: true, domains: Array.from({ length: 21 }, (_, i) => `d${i}.example`) }, microsoft: { enabled: false }, requireSso: false }
    ];
    for (const body of problems) assert.ok("error" in parseSsoSettings(body), `refused: ${JSON.stringify(body)?.slice(0, 120)}`);
  });
});

// ------------------------------------------------------------------ the flow

const APEX = "https://labkiosk.org";
const ACME = "https://acme.labkiosk.org";
let ipCounter = 0;

function req(url: string, init: RequestInit & { cookie?: string; origin?: string } = {}): Request {
  const headers = new Headers(init.headers);
  if (init.cookie) headers.set("Cookie", init.cookie);
  if (init.origin) headers.set("Origin", init.origin);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  if (!headers.has("CF-Connecting-IP")) headers.set("CF-Connecting-IP", `203.0.113.${(++ipCounter % 250) + 1}`);
  return new Request(url, { ...init, headers });
}

const send = (url: string, init: RequestInit & { cookie?: string; origin?: string } = {}, e: Env = env) => worker.fetch(req(url, init), e);
const post = (url: string, body: unknown, init: { cookie?: string; origin?: string } = {}, e: Env = env) =>
  send(url, { method: "POST", body: JSON.stringify(body), ...init }, e);

function lastSignInCode(email: string): string {
  const mail = [...localOutbox()].reverse().find((m) => m.to === email.toLowerCase());
  const code = mail?.subject.match(/^(\d{6}) is your Lab Kiosk sign-in code$/)?.[1];
  assert.ok(code, `a sign-in code was emailed to ${email}`);
  return code!;
}

/** The session a sign-in answer leads to, following the handoff to the console's host. */
async function sessionFrom(res: Response): Promise<string> {
  const data = (await res.clone().json()) as { redirect?: string; status?: string };
  assert.equal(data.status, "ok", JSON.stringify(data));
  const direct = res.headers.getSetCookie().find((c) => /^__Host-labkiosk_session=[0-9a-f]/.test(c));
  if (direct) return direct.split(";")[0];
  assert.ok(data.redirect?.includes("/api/auth/handoff?"), `a handoff: ${data.redirect}`);
  const handed = await worker.fetch(new Request(data.redirect!), env);
  const cookie = handed.headers.getSetCookie().find((c) => c.startsWith("__Host-labkiosk_session="));
  assert.ok(cookie, "the handoff sets the session cookie");
  return cookie!.split(";")[0];
}

/** A password sign-in on the apex, through the emailed code when one is asked for. */
async function passwordSignIn(email: string, password: string, e: Env = env): Promise<Response> {
  const res = await post(`${APEX}/api/auth/login`, { email, password }, {}, e);
  if (res.status !== 200) return res;
  const data = (await res.clone().json()) as any;
  if (data.status !== "two_factor") return res;
  return post(`${APEX}/api/auth/login/verify`, { challenge: data.challenge, code: lastSignInCode(email) }, {}, e);
}

describe("Single sign-on flow", () => {
  let key: TestKey;
  /** What the stand-in provider puts in the next ID token, on top of the nonce it was asked for. */
  let nextClaims: (provider: "google" | "microsoft") => Record<string, unknown>;
  let lastAuthorize: URL | null = null;
  const exchanges: URLSearchParams[] = [];
  let fetchMock: ReturnType<typeof mock.method> | null = null;
  const acme = { ownerId: "", tenantId: "", operatorRowId: "" };
  let ownerCookie = "";
  let rivalCookie = "";
  let subAdminCookie = "";
  let operatorCookie = "";

  const ownerEmail = "owner@acme.example";
  const ownerPassword = "AcmeOwnerPassword2026!";
  const operatorEmail = "op@acme.example";
  const operatorPassword = "AcmeOperatorPassword2026!";

  before(async () => {
    forgetSigningKeys();
    key = await rsaKey("flow-key");
    nextClaims = (provider) => (provider === "google" ? googleClaims() : microsoftClaims());
    const realFetch = globalThis.fetch;
    fetchMock = mock.method(globalThis, "fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === "https://www.googleapis.com/oauth2/v3/certs" || url === "https://login.microsoftonline.com/organizations/discovery/v2.0/keys") {
        return new Response(JSON.stringify({ keys: [key.jwk] }), { headers: { "Content-Type": "application/json" } });
      }
      if (url === "https://oauth2.googleapis.com/token" || url === "https://login.microsoftonline.com/organizations/oauth2/v2.0/token") {
        const provider = url.includes("google") ? "google" : "microsoft";
        const form = new URLSearchParams(String(init?.body));
        exchanges.push(form);
        // The provider checks PKCE: the verifier must hash to the challenge it was given.
        const challenge = b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(form.get("code_verifier") || ""))));
        if (!lastAuthorize || challenge !== lastAuthorize.searchParams.get("code_challenge") || form.get("code") === "bad-code") {
          return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400, headers: { "Content-Type": "application/json" } });
        }
        const claims = { ...nextClaims(provider), nonce: lastAuthorize.searchParams.get("nonce") };
        return new Response(JSON.stringify({ id_token: await signToken(key, claims), access_token: "unused" }), { headers: { "Content-Type": "application/json" } });
      }
      return realFetch(input, init);
    });

    await worker.fetch(new Request(`${APEX}/`), env);
    const db = getDatabase(env);
    const pepper = passwordPepper(env);
    const owner = await createUser(db, { email: ownerEmail, password: ownerPassword, name: "Ada Owner" }, pepper);
    const tenant = await createTenant(db, { userId: owner.id, name: "Acme Works", subdomain: "acme", status: "active" });
    acme.ownerId = owner.id;
    acme.tenantId = tenant.id;
    const operator = await createTenantUser(db, { tenantId: tenant.id, email: operatorEmail, name: "Otto Operator", password: operatorPassword, role: "operator", permissions: ["workstations"] }, pepper);
    acme.operatorRowId = operator.id;
    await createTenantUser(db, { tenantId: tenant.id, email: "sub@acme.example", name: "Sam Sub", password: "AcmeSubPassword2026!", role: "sub_admin", permissions: ["settings"] }, pepper);
    const rivalOwner = await createUser(db, { email: "boss@rival.example", password: "RivalOwnerPassword2026!", name: "Rita Rival" }, pepper);
    await createTenant(db, { userId: rivalOwner.id, name: "Rival Co", subdomain: "rival", status: "active" });

    ownerCookie = await sessionFrom(await passwordSignIn(ownerEmail, ownerPassword));
    rivalCookie = await sessionFrom(await passwordSignIn("boss@rival.example", "RivalOwnerPassword2026!"));
    subAdminCookie = await sessionFrom(await passwordSignIn("sub@acme.example", "AcmeSubPassword2026!"));
    operatorCookie = await sessionFrom(await passwordSignIn(operatorEmail, operatorPassword));
  });

  after(() => {
    fetchMock?.mock.restore();
    forgetSigningKeys();
  });

  const settingsBody = (overrides: Record<string, unknown> = {}) => ({
    google: { enabled: true, domains: ["acme.example"] },
    microsoft: { enabled: true, tenants: [ENTRA_TENANT] },
    requireSso: false,
    ...overrides
  });

  /** Start a sign-in from a page on `origin`: the provider's authorize URL and the browser cookie. */
  async function start(provider: "google" | "microsoft", origin = APEX, query = "&tenant=acme", e: Env = env) {
    const res = await send(`${origin}/api/auth/sso/start?provider=${provider}${query}`, {}, e);
    const location = res.headers.get("Location") || "";
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith("labkiosk_sso="));
    return { res, location, browser: cookie ? cookie.split(";")[0] : "" };
  }

  /** Start, then come back from the provider: the callback's answer. */
  async function roundTrip(provider: "google" | "microsoft", origin = APEX, query = "&tenant=acme") {
    const started = await start(provider, origin, query);
    assert.equal(started.res.status, 302, await started.res.clone().text());
    lastAuthorize = new URL(started.location);
    const state = lastAuthorize.searchParams.get("state")!;
    const back = await send(`${APEX}/api/auth/sso/callback?state=${state}&code=good-code`);
    return { started, back, state, landing: back.headers.get("Location") || "" };
  }

  const codeIn = (landing: string) => new URL(landing).searchParams.get("sso") || "";
  const errorIn = (landing: string) => new URL(landing).searchParams.get("sso_error");

  test("The settings route refuses strangers, other organizations, cross-site requests and accounts without the right", async () => {
    const url = `${ACME}/api/settings/sso`;
    for (const res of [await send(url), await post(url, settingsBody())]) {
      assert.ok([401, 403].includes(res.status), `anonymous is refused (${res.status})`);
    }
    assert.equal((await send(url, { cookie: rivalCookie })).status, 403, "another organization's session");
    assert.equal((await post(url, settingsBody(), { cookie: rivalCookie })).status, 403);
    assert.equal((await post(url, settingsBody(), { cookie: ownerCookie, origin: "https://evil.example" })).status, 403, "cross-site Origin");
    assert.equal((await send(url, { cookie: operatorCookie })).status, 403, "no settings permission");
    const read = await send(url, { cookie: subAdminCookie });
    assert.equal(read.status, 200, "settings holders can read it");
    assert.equal(((await read.json()) as any).canEdit, false);
    assert.equal((await post(url, settingsBody(), { cookie: subAdminCookie })).status, 403, "only administrators change it");

    for (const bad of [
      { ...settingsBody(), google: { enabled: true, domains: ["gmail.com"] } },
      { ...settingsBody(), microsoft: { enabled: true, tenants: ["not-a-guid"] } },
      { ...settingsBody(), google: { enabled: true, domains: [] } },
      { google: { enabled: false }, microsoft: { enabled: false }, requireSso: true }
    ]) {
      assert.equal((await post(url, bad, { cookie: ownerCookie })).status, 400, JSON.stringify(bad));
    }
    const notJson = await send(url, { method: "POST", body: "{", cookie: ownerCookie });
    assert.equal(notJson.status, 400);
    const unavailable = await post(url, settingsBody(), { cookie: ownerCookie }, googleOnlyEnv);
    assert.equal(unavailable.status, 409, "a provider the platform has not set up cannot be turned on");
  });

  test("An administrator turns single sign-on on, and the change is audited", async () => {
    const res = await post(`${ACME}/api/settings/sso`, settingsBody(), { cookie: ownerCookie });
    const data = (await res.json()) as any;
    assert.equal(res.status, 200, JSON.stringify(data));
    assert.deepEqual(data.google, { available: true, enabled: true, domains: ["acme.example"] });
    assert.deepEqual(data.microsoft, { available: true, enabled: true, tenants: [ENTRA_TENANT] });
    assert.equal(data.redirectUri, "https://labkiosk.org/api/auth/sso/callback");
    const audit = await getDatabase(env)
      .prepare("SELECT details FROM audit_logs WHERE tenant_id = ? AND action = 'settings.sso' ORDER BY created_at DESC LIMIT 1")
      .bind(acme.tenantId)
      .first<{ details: string }>();
    assert.match(audit?.details || "", /google=on google_domains=acme\.example microsoft=on/);
  });

  test("Only the organization's own sign-in page offers its providers, and only those the platform has", async () => {
    const page = await (await send(`${APEX}/?login=1&tenant=acme`)).text();
    assert.ok(page.includes('href="/api/auth/sso/start?provider=google&amp;tenant=acme"'));
    assert.ok(page.includes("Continue with Microsoft"));
    const onHost = await (await send(`${ACME}/?login=1`)).text();
    assert.ok(onHost.includes("Continue with Google"), "on the organization's own host too");
    assert.ok(!(await (await send(`${APEX}/?login=1`)).text()).includes("Continue with Google"), "no organization, no buttons");
    assert.ok(!(await (await send(`${APEX}/?login=1&tenant=rival`)).text()).includes("Continue with"), "another organization did not turn it on");
    const googleOnly = await (await send(`${APEX}/?login=1&tenant=acme`, {}, googleOnlyEnv)).text();
    assert.ok(googleOnly.includes("Continue with Google") && !googleOnly.includes("Continue with Microsoft"), "never a button the platform cannot serve");
    assert.ok(!(await (await send(`${APEX}/?login=1&tenant=acme`, {}, noSsoEnv)).text()).includes("Continue with"));
  });

  test("Start sends the browser to the provider with PKCE, state and nonce, bound to this browser", async () => {
    const { res, location, browser } = await start("google");
    assert.equal(res.status, 302);
    const target = new URL(location);
    assert.equal(target.origin + target.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
    assert.equal(target.searchParams.get("client_id"), GOOGLE_CLIENT);
    assert.equal(target.searchParams.get("redirect_uri"), "https://labkiosk.org/api/auth/sso/callback");
    assert.equal(target.searchParams.get("scope"), "openid email profile");
    assert.equal(target.searchParams.get("code_challenge_method"), "S256");
    assert.match(target.searchParams.get("code_challenge") || "", /^[A-Za-z0-9_-]{43}$/);
    assert.match(target.searchParams.get("state") || "", /^[A-Za-z0-9_-]{43}$/);
    assert.match(target.searchParams.get("nonce") || "", /^[A-Za-z0-9_-]{43}$/);
    assert.equal(target.searchParams.get("hd"), "acme.example");
    assert.match(browser, /^labkiosk_sso=[0-9a-f]{64}$/);
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith("labkiosk_sso="))!;
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Secure/);
    const row = await getDatabase(env).prepare("SELECT * FROM sso_states WHERE tenant_id = ? ORDER BY created_at DESC LIMIT 1").bind(acme.tenantId).first<any>();
    assert.notEqual(row.state_hash, target.searchParams.get("state"), "only the state's hash is stored");
    assert.equal(row.return_origin, "https://labkiosk.org");

    const ms = new URL((await start("microsoft")).location);
    assert.equal(ms.origin + ms.pathname, "https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize");
    assert.equal(ms.searchParams.get("client_id"), MICROSOFT_CLIENT);

    // A zone that redirects the apex to www answers on CANONICAL_HOST, so the callback is there.
    const www = new URL((await start("google", APEX, "&tenant=acme", { ...env, CANONICAL_HOST: "www.labkiosk.org" })).location);
    assert.equal(www.searchParams.get("redirect_uri"), "https://www.labkiosk.org/api/auth/sso/callback");
  });

  test("Start refuses what it cannot serve", async () => {
    assert.equal((await start("google", APEX, "")).res.status, 400, "no organization named");
    assert.equal((await send(`${APEX}/api/auth/sso/start?provider=github&tenant=acme`)).status, 400);
    const rival = await start("google", APEX, "&tenant=rival");
    assert.equal(errorIn(rival.location), "unavailable", "an organization that did not turn it on");
    const noSecrets = await start("google", APEX, "&tenant=acme", noSsoEnv);
    assert.equal(errorIn(noSecrets.location), "unavailable", "a platform without the provider's client");
    assert.equal(noSecrets.browser, "", "and nothing is started");
    // The host decides the organization: ?tenant= cannot point another organization's page at this one.
    const otherHost = await start("google", "https://rival.labkiosk.org", "&tenant=acme");
    assert.ok(otherHost.location.startsWith("https://rival.labkiosk.org/?login=1&tenant=rival&sso_error=unavailable"), otherHost.location);
  });

  test("An operator signs in with Google: the code works once, on that host, in that browser", async () => {
    const { started, back, landing } = await roundTrip("google");
    assert.equal(back.status, 302);
    assert.ok(landing.startsWith("https://labkiosk.org/?login=1&tenant=acme&sso="), landing);
    const exchange = exchanges[exchanges.length - 1];
    assert.equal(exchange.get("grant_type"), "authorization_code");
    assert.equal(exchange.get("redirect_uri"), "https://labkiosk.org/api/auth/sso/callback");
    assert.equal(exchange.get("client_secret"), "google-secret");
    const code = codeIn(landing);

    assert.equal((await post(`${APEX}/api/auth/sso/redeem`, { code }, { cookie: started.browser, origin: "https://evil.example" })).status, 403, "cross-site");
    const res = await post(`${APEX}/api/auth/sso/redeem`, { code }, { cookie: started.browser, origin: APEX });
    const data = (await res.clone().json()) as any;
    assert.equal(res.status, 200, JSON.stringify(data));
    assert.equal(data.status, "ok", "an operator without a second factor is signed in");
    const session = await sessionFrom(res);
    const me = (await (await send(`${ACME}/api/auth/me`, { cookie: session })).json()) as any;
    assert.equal(me.user.email, operatorEmail);
    assert.equal(me.tenant.subdomain, "acme");
    assert.ok(res.headers.getSetCookie().some((c) => /^labkiosk_sso=;.*Max-Age=0/.test(c)), "the browser cookie is cleared");

    assert.equal((await post(`${APEX}/api/auth/sso/redeem`, { code }, { cookie: started.browser })).status, 401, "a spent code");
    const audit = await getDatabase(env).prepare("SELECT details FROM audit_logs WHERE tenant_id = ? AND action = 'auth.sso' ORDER BY created_at DESC LIMIT 1").bind(acme.tenantId).first<{ details: string }>();
    assert.equal(audit?.details, "provider=google");
  });

  test("A code is refused in another browser, on another host, and after it expires", async () => {
    const first = await roundTrip("google");
    assert.equal((await post(`${APEX}/api/auth/sso/redeem`, { code: codeIn(first.landing) })).status, 401, "no browser cookie");
    assert.equal((await post(`${APEX}/api/auth/sso/redeem`, { code: codeIn(first.landing) }, { cookie: first.started.browser })).status, 401, "and the attempt spent it");

    const second = await roundTrip("google");
    assert.equal((await post(`${APEX}/api/auth/sso/redeem`, { code: codeIn(second.landing) }, { cookie: "labkiosk_sso=" + "a".repeat(64) })).status, 401, "another browser's cookie");

    const third = await roundTrip("google");
    assert.equal((await post(`${ACME}/api/auth/sso/redeem`, { code: codeIn(third.landing) }, { cookie: third.started.browser })).status, 401, "another host than the one the sign-in started on");

    const fourth = await roundTrip("google");
    await getDatabase(env).prepare("UPDATE sso_states SET expires_at = ? WHERE handoff_hash IS NOT NULL").bind(nowSeconds() - 1).run();
    assert.equal((await post(`${APEX}/api/auth/sso/redeem`, { code: codeIn(fourth.landing) }, { cookie: fourth.started.browser })).status, 401, "expired");

    assert.equal((await post(`${APEX}/api/auth/sso/redeem`, { code: "nope" })).status, 400, "malformed");
    assert.equal((await send(`${APEX}/api/auth/sso/redeem`, { method: "POST", body: "{" })).status, 400, "not JSON");
  });

  test("The callback spends its state once, refuses an unknown or expired one, and answers only on the platform host", async () => {
    const started = await start("google");
    lastAuthorize = new URL(started.location);
    const state = lastAuthorize.searchParams.get("state")!;
    const wrongHost = await send(`${ACME}/api/auth/sso/callback?state=${state}&code=good-code`);
    assert.equal(wrongHost.status, 400, "the callback is the platform host's");
    assert.equal((await send(`${APEX}/api/auth/sso/callback?state=${state}&code=good-code`)).status, 400, "and that attempt spent the state");

    assert.equal((await send(`${APEX}/api/auth/sso/callback?state=${"x".repeat(43)}&code=good-code`)).status, 400, "unknown state");
    assert.equal((await send(`${APEX}/api/auth/sso/callback?code=good-code`)).status, 400, "no state");

    const old = await start("google");
    lastAuthorize = new URL(old.location);
    await getDatabase(env).prepare("UPDATE sso_states SET expires_at = ? WHERE used_at IS NULL").bind(nowSeconds() - 1).run();
    assert.equal((await send(`${APEX}/api/auth/sso/callback?state=${lastAuthorize.searchParams.get("state")}&code=good-code`)).status, 400, "expired state");

    const replay = await roundTrip("google");
    assert.equal(replay.back.status, 302);
    assert.equal((await send(`${APEX}/api/auth/sso/callback?state=${replay.state}&code=good-code`)).status, 400, "a used state");

    const cancelled = await start("google");
    const cancelState = new URL(cancelled.location).searchParams.get("state");
    assert.equal(errorIn((await send(`${APEX}/api/auth/sso/callback?state=${cancelState}&error=access_denied`)).headers.get("Location")!), "cancelled");

    const refusedCode = await start("google");
    lastAuthorize = new URL(refusedCode.location);
    const refusedLanding = (await send(`${APEX}/api/auth/sso/callback?state=${lastAuthorize.searchParams.get("state")}&code=bad-code`)).headers.get("Location")!;
    assert.equal(errorIn(refusedLanding), "provider", "the provider refused the code");
  });

  test("Only an existing account of this organization, in an allowed directory, signs in", async () => {
    nextClaims = () => googleClaims({ email: "nobody@acme.example" });
    assert.equal(errorIn((await roundTrip("google")).landing), "no_account", "no account with that address");
    nextClaims = () => googleClaims({ email: "boss@rival.example" });
    assert.equal(errorIn((await roundTrip("google")).landing), "no_account", "another organization's owner");
    nextClaims = () => googleClaims({ hd: "rival.example" });
    assert.equal(errorIn((await roundTrip("google")).landing), "directory", "a Workspace domain the organization did not list");
    nextClaims = () => microsoftClaims({ tid: OTHER_ENTRA_TENANT });
    assert.equal(errorIn((await roundTrip("microsoft")).landing), "directory", "an Entra tenant the organization did not list");
    nextClaims = () => googleClaims({ aud: "someone-else" });
    assert.equal(errorIn((await roundTrip("google")).landing), "identity", "a token for another application");
    nextClaims = (p) => (p === "google" ? googleClaims() : microsoftClaims());
  });

  test("The platform's super admin never signs in with single sign-on, even in a demo it owns", async () => {
    const db = getDatabase(env);
    const demo = await db.prepare("SELECT id FROM tenants WHERE subdomain = 'local-demo'").first<{ id: string }>();
    await db
      .prepare("INSERT INTO sso_settings (tenant_id, google_enabled, google_domains, updated_at) VALUES (?, 1, '[\"labkiosk.org\"]', ?)")
      .bind(demo!.id, nowSeconds())
      .run();
    nextClaims = () => googleClaims({ email: env.SUPER_ADMIN_EMAIL, hd: "labkiosk.org" });
    assert.equal(errorIn((await roundTrip("google", APEX, "&tenant=local-demo")).landing), "no_account");
    nextClaims = (p) => (p === "google" ? googleClaims() : microsoftClaims());
  });

  test("The owner signing in with Microsoft still confirms with the second factor", async () => {
    nextClaims = () => microsoftClaims({ email: ownerEmail });
    const { started, landing } = await roundTrip("microsoft", ACME, "");
    assert.ok(landing.startsWith("https://acme.labkiosk.org/?login=1&tenant=acme&sso="), "back to the host the sign-in started on");
    const res = await post(`${ACME}/api/auth/sso/redeem`, { code: codeIn(landing) }, { cookie: started.browser });
    const data = (await res.json()) as any;
    assert.equal(data.status, "two_factor", "an administrator is always asked");
    assert.equal(data.method, "email");
    assert.ok(!res.headers.getSetCookie().some((c) => c.includes("labkiosk_session=") && !c.includes("Max-Age=0")), "no session before the second factor");
    const verified = await post(`${ACME}/api/auth/login/verify`, { challenge: data.challenge, code: lastSignInCode(ownerEmail) });
    const session = await sessionFrom(verified);
    assert.equal(((await (await send(`${ACME}/api/auth/me`, { cookie: session })).json()) as any).user.email, ownerEmail);
    nextClaims = (p) => (p === "google" ? googleClaims() : microsoftClaims());
  });

  test("Removed staff and suspended organizations are refused, and the lockout applies", async () => {
    const db = getDatabase(env);
    // Removed between the callback and the redeem.
    const pending = await roundTrip("google");
    await deleteTenantUser(db, acme.tenantId, acme.operatorRowId);
    assert.equal((await post(`${APEX}/api/auth/sso/redeem`, { code: codeIn(pending.landing) }, { cookie: pending.started.browser })).status, 401);
    assert.equal(errorIn((await roundTrip("google")).landing), "no_account", "and refused at the callback after that");
    const restored = await createTenantUser(db, { tenantId: acme.tenantId, email: operatorEmail, name: "Otto Operator", role: "operator", permissions: ["workstations"] }, passwordPepper(env));
    acme.operatorRowId = restored.id;

    await db
      .prepare("INSERT INTO login_attempts (identifier, failed_count, last_failed_at, locked_until) VALUES (?, 9, ?, ?) ON CONFLICT(identifier) DO UPDATE SET locked_until = excluded.locked_until")
      .bind(operatorEmail, nowSeconds(), nowSeconds() + 600)
      .run();
    assert.equal(errorIn((await roundTrip("google")).landing), "locked", "a locked account");
    await db.prepare("DELETE FROM login_attempts WHERE identifier = ?").bind(operatorEmail).run();

    await updateTenant(db, acme.tenantId, { status: "suspended" });
    assert.equal(errorIn((await start("google")).location), "unavailable", "a suspended organization");
    await updateTenant(db, acme.tenantId, { status: "active" });
    assert.ok(codeIn((await roundTrip("google")).landing), "and back once it is active");
  });

  test("Require SSO refuses staff passwords, never the owner's, and lifts while no provider is offered", async () => {
    const saved = await post(`${ACME}/api/settings/sso`, settingsBody({ requireSso: true }), { cookie: ownerCookie });
    assert.equal(saved.status, 200);
    assert.equal(((await saved.json()) as any).requireSsoInForce, true);
    const refused = await post(`${APEX}/api/auth/login`, { email: operatorEmail, password: operatorPassword });
    assert.equal(refused.status, 403);
    assert.match(((await refused.json()) as any).error, /Continue with Google/);
    const wrongPassword = await post(`${APEX}/api/auth/login`, { email: operatorEmail, password: "WrongPassword2026!" });
    assert.equal(wrongPassword.status, 401, "a wrong password learns nothing about the rule");
    assert.equal((await passwordSignIn(ownerEmail, ownerPassword)).status, 200, "the owner keeps the password");
    assert.equal((await passwordSignIn(operatorEmail, operatorPassword, noSsoEnv)).status, 200, "no provider offered: passwords work again");
    await post(`${ACME}/api/settings/sso`, settingsBody({ requireSso: false }), { cookie: ownerCookie });
    assert.equal((await passwordSignIn(operatorEmail, operatorPassword)).status, 200);
  });

  test("Turning a provider off stops its sign-ins, even one already under way", async () => {
    const started = await start("google");
    lastAuthorize = new URL(started.location);
    await post(`${ACME}/api/settings/sso`, settingsBody({ google: { enabled: false, domains: ["acme.example"] } }), { cookie: ownerCookie });
    const landing = (await send(`${APEX}/api/auth/sso/callback?state=${lastAuthorize.searchParams.get("state")}&code=good-code`)).headers.get("Location")!;
    assert.equal(errorIn(landing), "unavailable");
    assert.equal(errorIn((await start("google")).location), "unavailable");
    await post(`${ACME}/api/settings/sso`, settingsBody(), { cookie: ownerCookie });
  });

  test("The hourly run purges expired sign-ins", async () => {
    const db = getDatabase(env);
    await start("google");
    await db.prepare("UPDATE sso_states SET expires_at = ?").bind(nowSeconds() - 1).run();
    await purgeExpiredSsoStates(db);
    assert.equal((await db.prepare("SELECT COUNT(*) AS n FROM sso_states").first<{ n: number }>())?.n, 0);
  });
});
