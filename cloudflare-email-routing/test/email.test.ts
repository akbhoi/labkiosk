import { test } from "node:test";
import assert from "node:assert/strict";
import { Env, handleEmail, InboundMessage, IntakeResult, MAX_INBOUND_BYTES, pendingKey, rawKey } from "../src/index";

/** An R2 stand-in with the three calls the Worker makes; `failOn` makes a put to matching keys throw. */
function bucket(failOn?: RegExp) {
  const objects = new Map<string, { bytes: Uint8Array; customMetadata?: Record<string, string> }>();
  const fake = {
    objects,
    async put(key: string, value: Uint8Array, options?: { customMetadata?: Record<string, string> }) {
      if (failOn && failOn.test(key)) throw new Error("R2 is down");
      objects.set(key, { bytes: value, customMetadata: options?.customMetadata });
      return {};
    },
    async delete(key: string) {
      objects.delete(key);
    }
  };
  return fake;
}

function message(raw: string, from = "ria@example.org", to = "hello@labkiosk.org", rawSize?: number) {
  const bytes = new TextEncoder().encode(raw);
  const forwarded: { to: string; headers?: Headers }[] = [];
  let rejected: string | null = null;
  let cancelled = false;
  const msg: InboundMessage = {
    from,
    to,
    raw: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
      cancel() {
        cancelled = true;
      }
    }),
    rawSize: rawSize ?? bytes.length,
    setReject(reason: string) {
      rejected = reason;
    },
    async forward(rcptTo: string, headers?: Headers) {
      forwarded.push({ to: rcptTo, headers });
    }
  };
  return { msg, forwarded, rejected: () => rejected, cancelled: () => cancelled };
}

function env(store: ReturnType<typeof bucket>, file: (id: string, from: string, to: string) => Promise<IntakeResult>, forwardTo?: string): Env {
  return { MAIL_ARCHIVE: store as unknown as R2Bucket, CONTROLLER: { file }, SUPPORT_FORWARD_TO: forwardTo };
}

const RAW = "From: Ria <ria@example.org>\r\nSubject: Pricing\r\n\r\nHow much?";

test("Stores the original and its marker, hands it over, and forwards a copy with the reference", async () => {
  const store = bucket();
  const calls: string[][] = [];
  const m = message(RAW);
  await handleEmail(
    m.msg,
    env(store, async (id, from, to) => {
      calls.push([id, from, to]);
      // The controller reads the original the Worker stored before it called.
      assert.ok(store.objects.has(rawKey(id)));
      assert.ok(store.objects.has(pendingKey(id)));
      return { status: "filed", reference: "LK-ABC123" };
    }, "owner@example.com")
  );
  assert.equal(calls.length, 1);
  const [id, from, to] = calls[0];
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(from, "ria@example.org");
  assert.equal(to, "hello@labkiosk.org");
  assert.equal(new TextDecoder().decode(store.objects.get(rawKey(id))!.bytes), RAW);
  assert.deepEqual(store.objects.get(pendingKey(id))!.customMetadata, { from: "ria@example.org", to: "hello@labkiosk.org" });
  assert.equal(m.forwarded.length, 1);
  assert.equal(m.forwarded[0].to, "owner@example.com");
  assert.equal(m.forwarded[0].headers?.get("X-LabKiosk-Reference"), "LK-ABC123");
});

test("Forwards nothing without SUPPORT_FORWARD_TO, and nothing the controller dropped as a loop", async () => {
  const quiet = message(RAW);
  await handleEmail(quiet.msg, env(bucket(), async () => ({ status: "filed", reference: "LK-1" })));
  assert.equal(quiet.forwarded.length, 0);

  const loop = message(RAW, "support@labkiosk.org", "support@labkiosk.org");
  await handleEmail(loop.msg, env(bucket(), async () => ({ status: "dropped" }), "owner@example.com"));
  assert.equal(loop.forwarded.length, 0);
});

test("When the controller fails, the message stays pending and the owner still gets a copy", async () => {
  const store = bucket();
  const m = message(RAW);
  await handleEmail(m.msg, env(store, async () => { throw new Error("controller is down"); }, "owner@example.com"));
  const pending = [...store.objects.keys()].filter((key) => key.startsWith("mail-pending/"));
  assert.equal(pending.length, 1, "left for the hourly sweep");
  assert.equal(m.forwarded.length, 1);
  assert.equal(m.forwarded[0].headers?.get("X-LabKiosk-Reference"), null);

  // Without the controller's answer, mail from the platform's own domain is not forwarded.
  const own = message(RAW, "bounce@labkiosk.org", "support@labkiosk.org");
  await handleEmail(own.msg, env(bucket(), async () => { throw new Error("down"); }, "owner@example.com"));
  assert.equal(own.forwarded.length, 0);
});

test("When R2 fails, the owner's copy is the fallback, and without one the message bounces", async () => {
  const forwarded = message(RAW);
  let called = false;
  await handleEmail(forwarded.msg, env(bucket(/^mail\//), async () => { called = true; return { status: "dropped" }; }, "owner@example.com"));
  assert.equal(called, false, "nothing to hand over");
  assert.equal(forwarded.forwarded.length, 1);

  await assert.rejects(handleEmail(message(RAW).msg, env(bucket(/^mail\//), async () => ({ status: "dropped" }))), /could not be stored/);

  // A marker that cannot be written takes its original back out.
  const store = bucket(/^mail-pending\//);
  await assert.rejects(handleEmail(message(RAW).msg, env(store, async () => ({ status: "dropped" }))), /could not be stored/);
  assert.equal(store.objects.size, 0);
});

test("Rejects a message larger than Email Routing delivers without reading it", async () => {
  const store = bucket();
  const m = message(RAW, undefined, undefined, MAX_INBOUND_BYTES + 1);
  await handleEmail(m.msg, env(store, async () => ({ status: "dropped" }), "owner@example.com"));
  assert.equal(m.rejected(), "Message too large");
  assert.ok(m.cancelled());
  assert.equal(store.objects.size, 0);
  assert.equal(m.forwarded.length, 0);
});
