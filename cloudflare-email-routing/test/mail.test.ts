import { test } from "node:test";
import assert from "node:assert/strict";
import worker, { Env } from "../src/index";
import { handleSend, SendRequest, sendRequestProblem } from "../src/send";
import { MailTemplate, renderMailHtml, TEMPLATE_NAMES } from "../src/templates";
import { esc, isPlainAddress, paragraphs, safeUrl } from "../src/templates/layout";
import { BRAND, SAMPLES } from "./samples";

const HOSTILE = `"><script>alert(1)</script><img src=x onerror=alert(2)>`;

test("Every template renders a whole message in the shared layout", () => {
  assert.deepEqual(
    [...new Set(SAMPLES.map((s) => s.template.name))].sort(),
    [...TEMPLATE_NAMES].sort(),
    "there is a sample of every template"
  );
  for (const sample of SAMPLES) {
    const html = renderMailHtml({ template: sample.template, subject: sample.subject, text: sample.text, brand: BRAND });
    assert.ok(html.startsWith("<!DOCTYPE html>") && html.trimEnd().endsWith("</html>"), `${sample.file} is a document`);
    // The scaffold: the wordmark, the footer and its reply address, on every one.
    assert.ok(html.includes("lk-card") && html.includes(">Lab Kiosk<"), `${sample.file} carries the header`);
    assert.ok(html.includes("Managed browser workstations") && html.includes("mailto:support@labkiosk.org"), `${sample.file} carries the footer`);
    assert.ok(html.includes(`<title>${esc(sample.subject)}</title>`));
    // What a mail client would refuse or strip.
    assert.ok(!/<script|<img|<link|javascript:|\son[a-z]+=/i.test(html), `${sample.file} has nothing active or remote`);
    assert.ok(!html.includes("undefined") && !html.includes("[object"), `${sample.file} has no hole in it`);
  }
});

test("Each template shows what it is for", () => {
  const html = (file: string) => {
    const sample = SAMPLES.find((s) => s.file === file)!;
    return renderMailHtml({ template: sample.template, subject: sample.subject, text: sample.text, brand: BRAND });
  };
  assert.ok(html("code-signup").includes(">482913<") && html("code-signup").includes("Confirm your email address"));
  assert.ok(html("code-sign-in").includes(">730164<") && html("code-sign-in").includes("Works for 10 minutes") && html("code-sign-in").includes("Hello Asha Rao,"));
  assert.ok(html("receipt").includes("Tracking ID") && html("receipt").includes("SUP-7Q2M9X") && html("receipt").includes("We received your message"));
  assert.ok(html("reply").includes("Asha Rao") && html("reply").includes("SAL-K4T8WN"));
  assert.ok(html("reply").includes('<a href="https://labkiosk.org/pricing"'), "an address in a reply is a link");
  assert.ok(html("decision-approved").includes(">Approved<") && html("decision-approved").includes('href="https://greenwood.labkiosk.org/admin"'));
  assert.ok(html("decision-declined").includes(">Not approved<") && !html("decision-declined").includes("Open your console"));
  assert.ok(html("letter").includes("9 October 2026") && html("letter").includes("Ref. LTR-H6V9ZC") && html("letter").includes("Northfield Learning Trust"));
  assert.ok(html("alert").includes("203.0.113.24") && html("alert").includes("New sign-in to your account"));
  assert.ok(html("notice").includes("New registration") && html("notice").includes("Workstations expected: 40"));
});

test("Nothing a person typed reaches a message unescaped", () => {
  const templates: MailTemplate[] = [
    { name: "notice", title: HOSTILE },
    { name: "code", code: HOSTILE, purpose: "sign-in", minutes: 10, recipientName: HOSTILE },
    { name: "receipt", reference: HOSTILE, category: HOSTILE, title: HOSTILE },
    { name: "reply", reference: HOSTILE, category: HOSTILE, author: HOSTILE },
    { name: "decision", reference: HOSTILE, outcome: "approved", title: HOSTILE, category: HOSTILE, action: { label: HOSTILE, url: "javascript:alert(1)" } },
    { name: "letter", reference: HOSTILE, date: HOSTILE, recipientName: HOSTILE, recipientOrganization: HOSTILE, heading: HOSTILE, signatory: HOSTILE, signatoryTitle: HOSTILE },
    { name: "alert", title: HOSTILE, lead: HOSTILE, details: [[HOSTILE, HOSTILE]], advice: HOSTILE }
  ];
  for (const template of templates) {
    const html = renderMailHtml({
      template,
      subject: HOSTILE,
      text: `${HOSTILE}\n\nhttps://example.org/"><script>x</script> javascript:alert(1)`,
      brand: { name: HOSTILE, siteUrl: "javascript:alert(1)", replyAddress: HOSTILE }
    });
    // Escaped, the words are still there as text; what must not be is markup.
    assert.ok(!/<script|<img|href="javascript:/i.test(html) && !html.includes(HOSTILE), `${template.name} lets nothing through`);
  }
  assert.ok(isPlainAddress("support@labkiosk.org"));
  for (const bad of ["support", "@labkiosk.org", "support@", "a@b@c.org", "a b@c.org", 'a"@c.org', "a@c.org>", "a@c.org\n"]) assert.ok(!isPlainAddress(bad), bad);
  // A long run of "@" is answered at once, not after a search through every split of it.
  const started = Date.now();
  assert.ok(!isPlainAddress("!@".repeat(150)));
  assert.ok(!renderMailHtml({ template: { name: "notice" }, subject: "s", text: "t", brand: { ...BRAND, replyAddress: "!@".repeat(50000) } }).includes("mailto:"));
  assert.ok(Date.now() - started < 500);
  assert.equal(safeUrl("https://example.org/a?b=1"), "https://example.org/a?b=1");
  for (const bad of ["javascript:alert(1)", "data:text/html,x", "//example.org", "https://exa mple.org", ""]) assert.equal(safeUrl(bad), null);
  assert.equal(paragraphs("a\nb\n\n\nc"), '<p style="margin:0 0 16px;">a<br>b</p><p style="margin:0 0 16px;">c</p>');
  assert.ok(paragraphs("See https://labkiosk.org/docs.").endsWith("</a>.</p>"), "the full stop stays outside the link");
});

const REQUEST: SendRequest = {
  from: { email: "support@email.labkiosk.org", name: "Lab Kiosk" },
  to: { email: "pat@library.example", name: "Pat Morgan" },
  replyTo: "support@labkiosk.org",
  subject: "[SUP-7Q2M9X] Re: Enrolment",
  text: "Hello Pat,\n\nTry the new key.",
  template: { name: "reply", reference: "SUP-7Q2M9X", category: "Support", author: "Asha" },
  brand: BRAND,
  headers: { "In-Reply-To": "<a@library.example>" }
};

function post(body: unknown, method = "POST"): Request {
  return new Request("https://labkiosk-email-routing/send", { method, body: method === "POST" ? JSON.stringify(body) : undefined });
}

function sender(fail = false) {
  const sent: any[] = [];
  const EMAIL = {
    send: async (message: unknown) => {
      if (fail) throw new Error("destination address not verified");
      sent.push(message);
      return { messageId: "<sent@labkiosk.org>" };
    }
  } as unknown as SendEmail;
  return { sent, EMAIL };
}

test("POST /send renders the message and sends it", async () => {
  const { sent, EMAIL } = sender();
  const res = await handleSend(post(REQUEST), { EMAIL });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { messageId: "<sent@labkiosk.org>" });
  assert.equal(sent.length, 1);
  assert.deepEqual(sent[0].from, REQUEST.from);
  assert.deepEqual(sent[0].to, { email: "pat@library.example", name: "Pat Morgan" });
  assert.equal(sent[0].replyTo, "support@labkiosk.org");
  assert.equal(sent[0].subject, REQUEST.subject);
  assert.equal(sent[0].text, REQUEST.text);
  assert.deepEqual(sent[0].headers, { "In-Reply-To": "<a@library.example>" });
  assert.ok(sent[0].html.includes("SUP-7Q2M9X") && sent[0].html.includes("Try the new key.") && sent[0].html.includes("lk-card"));

  // The Worker's own fetch handler has this one path.
  const env = { EMAIL } as unknown as Env;
  assert.equal((await worker.fetch(post(REQUEST), env)).status, 200);
  assert.equal((await worker.fetch(new Request("https://labkiosk-email-routing/"), env)).status, 404);
});

test("POST /send refuses what it cannot send safely, and says why a send failed", async () => {
  const { sent, EMAIL } = sender();
  const status = async (body: unknown, method = "POST") => (await handleSend(post(body, method), { EMAIL })).status;
  assert.equal(await status(REQUEST, "GET"), 405);
  assert.equal((await handleSend(post(REQUEST), {})).status, 503, "no binding, no sending");
  assert.equal((await handleSend(new Request("https://x/send", { method: "POST", body: "{" }), { EMAIL })).status, 400);

  const refused: Array<[string, Partial<SendRequest> | Record<string, unknown>]> = [
    ["a recipient that is not an address", { to: { email: "pat" } }],
    ["a sender name that starts a header", { from: { email: "a@labkiosk.org", name: "Lab\r\nBcc: x@y.example" } }],
    ["a subject with a line break", { subject: "Hello\r\nBcc: x@y.example" }],
    ["a reply address that is a list", { replyTo: "a@b.example, c@d.example" }],
    ["an empty text", { text: "  " }],
    ["a template it does not have", { template: { name: "newsletter" } }],
    ["no brand", { brand: undefined }],
    ["a header it does not allow", { headers: { Bcc: "x@y.example" } }],
    ["a header with a line break", { headers: { References: "<a@b>\r\nBcc: x@y.example" } }]
  ];
  for (const [what, change] of refused) {
    assert.equal(await status({ ...REQUEST, ...change }), 400, what);
    assert.notEqual(sendRequestProblem({ ...REQUEST, ...change }), null, what);
  }
  assert.equal(sendRequestProblem(REQUEST), null);
  assert.equal(sent.length, 0, "nothing refused was sent");

  const failing = await handleSend(post(REQUEST), { EMAIL: sender(true).EMAIL });
  assert.equal(failing.status, 502);
  assert.deepEqual(await failing.json(), { error: "destination address not verified" });
});
