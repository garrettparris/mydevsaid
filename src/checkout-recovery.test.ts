import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { mock } from "node:test";
import Stripe from "stripe";
import { checkoutKey, recoverCheckout, stripePayments, type CheckoutState, type PaymentProvider } from "./payments.ts";
import { createApp } from "./server.ts";
import { CheckoutReviewRequired, Store } from "./store.ts";

const submission = { links: ["https://example.com/"], token: { chainId: 1, address: `0x${"1".repeat(40)}` } };
const checkoutUrl = "https://checkout.stripe.com/session";
function provider(orderId: string, state: Partial<CheckoutState> = {}) {
  const calls: number[] = [];
  const payments: PaymentProvider = {
    async createCheckout(_id, generation = 0) { calls.push(generation); return { id: `cs_${generation}`, url: checkoutUrl }; },
    async retrieveCheckout(id) { return { id, orderId, status: "expired", paymentStatus: "unpaid", url: null, ...state }; },
    verifyWebhook() { return null; },
  };
  return { calls, payments };
}
function scoped(store: Store) {
  const created = store.createScope(`https://example.com Ethereum ${submission.token.address}`);
  return { ...created, ...store.lockScope(created.scope.id, created.accessToken, created.scope.revision, false), scopeToken: created.accessToken };
}
function existing(store: Store) {
  const created = scoped(store); store.reserveCheckout(created.order.id); store.recordCheckout(created.order.id, 0, { id: "cs_0", url: checkoutUrl }); return created;
}

test("failed creation and restart reuse the durably reserved generation and provider key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mydevsaid-checkout-")); const path = join(directory, "db.sqlite");
  let store = new Store(path); const created = scoped(store); const generations: number[] = [];
  const payments: PaymentProvider = { async createCheckout(id, generation = 0) {
    assert.equal(store.getOrder(id)!.checkoutGeneration, generation); generations.push(generation);
    if (generations.length === 1) throw new Error("Response lost after Stripe accepted creation");
    return { id: "cs_original", url: checkoutUrl };
  }, verifyWebhook() { return null; } };
  try {
    await assert.rejects(recoverCheckout(store, payments, created.order.id)); store.close(); store = new Store(path);
    await recoverCheckout(store, payments, created.order.id);
    assert.deepEqual(generations, [0, 0]); assert.equal(checkoutKey(created.order.id, 0), `investigation-${created.order.id}`);
    assert.equal(store.getOrder(created.order.id)!.checkoutId, "cs_original"); assert.equal(store.orders().length, 1);
  } finally { store.close(); await rm(directory, { recursive: true, force: true }); }
});

test("expired checkout replacement persists generation before network and preserves scoped order", async () => {
  const store = new Store(":memory:"); const created = existing(store); const original = store.getOrder(created.order.id)!;
  const { calls, payments } = provider(created.order.id);
  payments.createCheckout = async (_id, generation = 0) => {
    assert.equal(store.getOrder(created.order.id)!.checkoutGeneration, 1);
    assert.equal(store.getOrder(created.order.id)!.checkoutId, null);
    calls.push(generation); if (calls.length === 1) throw new Error("Temporary creation failure");
    return { id: "cs_1", url: checkoutUrl };
  };
  try {
    await assert.rejects(recoverCheckout(store, payments, created.order.id));
    await recoverCheckout(store, payments, created.order.id);
    const current = store.getOrder(created.order.id)!;
    assert.deepEqual(calls, [1, 1]); assert.deepEqual(current.previousCheckoutIds, ["cs_0"]);
    assert.equal(current.checkoutId, "cs_1"); assert.equal(current.payment, "pending");
    assert.throws(() => store.recordCheckout(current.id, 1, { id: "cs_0", url: checkoutUrl }));
    assert.deepEqual(current.scope, original.scope); assert.deepEqual(current.submission, original.submission);
    assert.throws(() => store.saveOrder({ ...current, submission: { ...current.submission, links: ["https://other.example/"] } }));
    assert.equal(store.lockScope(created.scope.id, created.scopeToken, created.scope.revision, false).order.id, created.order.id);
  } finally { store.close(); }
});

test("open checkout reuses provider URL; complete or paid sessions wait for webhook without replacement", async () => {
  for (const state of [
    { status: "open", paymentStatus: "unpaid", url: checkoutUrl },
    { status: "complete", paymentStatus: "unpaid", url: null },
    { status: "complete", paymentStatus: "paid", url: null },
    { status: "expired", paymentStatus: "paid", url: null },
  ] as const) {
    const store = new Store(":memory:"); const created = existing(store); const { calls, payments } = provider(created.order.id, state);
    try {
      await recoverCheckout(store, payments, created.order.id);
      const current = store.getOrder(created.order.id)!;
      assert.deepEqual(calls, []); assert.equal(current.payment, "pending"); assert.equal(current.status, "awaiting_payment");
      assert.equal(current.checkoutUrl, state.status === "open" ? checkoutUrl : undefined);
    } finally { store.close(); }
  }
});

test("unknown states, wrong identity, missing retrieval, and retrieval failures cannot create replacement", async () => {
  for (const scenario of ["identity", "checkout", "state", "missing", "failure", "port"] as const) {
    const store = new Store(":memory:"); const created = existing(store); const { calls, payments } = provider(created.order.id);
    if (scenario === "missing") delete payments.retrieveCheckout;
    else payments.retrieveCheckout = async () => {
      if (scenario === "failure") throw new Error("Provider unavailable");
      return { id: scenario === "checkout" ? "cs_other" : "cs_0", orderId: scenario === "identity" ? "other-order" : created.order.id,
        status: scenario === "state" ? "unknown" as CheckoutState["status"] : scenario === "port" ? "open" : "expired", paymentStatus: "unpaid", url: scenario === "port" ? "https://checkout.stripe.com:444/session" : null };
    };
    try { await assert.rejects(recoverCheckout(store, payments, created.order.id)); assert.deepEqual(calls, []); assert.equal(store.getOrder(created.order.id)!.checkoutGeneration, 0); }
    finally { store.close(); }
  }
});

test("replacement cap and expired uncertain idempotency window fail closed", async () => {
  const store = new Store(":memory:"); const created = existing(store); const { calls, payments } = provider(created.order.id);
  try {
    const order = store.getOrder(created.order.id)!; order.checkoutGeneration = 8; store.saveOrder(order);
    await assert.rejects(recoverCheckout(store, payments, order.id), CheckoutReviewRequired); assert.deepEqual(calls, []);
    const uncertain = store.createOrder(submission, false).order;
    uncertain.checkoutAttemptStartedAt = new Date(Date.now() - 24 * 3_600_000).toISOString(); store.saveOrder(uncertain);
    await assert.rejects(recoverCheckout(store, payments, uncertain.id), CheckoutReviewRequired); assert.deepEqual(calls, []);
  } finally { store.close(); }
});

test("order recovery coalesces concurrent requests and a late paid webhook wins over replacement", async () => {
  const store = new Store(":memory:"); const created = existing(store); let runs = 0, creates = 0;
  let release!: () => void; const paused = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void; const started = new Promise<void>((resolve) => { entered = resolve; });
  const { payments } = provider(created.order.id);
  payments.createCheckout = async (_id, generation) => { creates++; assert.equal(generation, 1); entered(); await paused; return { id: "cs_1", url: checkoutUrl }; };
  payments.verifyWebhook = () => ({ eventId: "evt_paid", orderId: created.order.id, checkoutId: "cs_0" });
  const app = createApp({ localMode: false, origin: "http://127.0.0.1:3000", adminToken: "administrator-token-long-enough", modelEnabled: true, publicDir: "public" },
    store, async () => { runs++; throw new Error("Test stops after observing queue entry"); }, payments, async () => {});
  app.server.listen(0, "127.0.0.1"); await once(app.server, "listening"); const address = app.server.address(); assert.ok(address && typeof address !== "string");
  const request = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${address.port}${path}`, init);
  const refresh = () => request(`/api/orders/${created.order.id}/checkout`, { method: "POST", headers: { Authorization: `Bearer ${created.accessToken}` } });
  try {
    assert.equal((await request(`/api/orders/${created.order.id}/checkout`, { method: "POST" })).status, 401);
    assert.equal((await request(`/api/orders/${created.order.id}/checkout`, { method: "POST", headers: { Origin: "https://attacker.example" } })).status, 403);
    const first = refresh(); await started; const second = refresh();
    await new Promise((resolve) => setTimeout(resolve, 10));
    for (let index = 0; index < 2; index++) assert.equal((await request("/api/webhooks/stripe", { method: "POST", body: "signed fixture" })).status, 200);
    release(); await app.queue.idle();
    for (const response of await Promise.all([first, second])) {
      assert.equal(response.status, 200); const value = await response.json(); assert.equal(value.payment, "paid"); assert.equal(value.checkoutUrl, undefined);
    }
    assert.equal(creates, 1); assert.equal(runs, 1); assert.equal(store.getOrder(created.order.id)!.checkoutUrl, undefined);
    const scope = await (await request(`/api/scopes/${created.scope.id}`, { headers: { Authorization: `Bearer ${created.scopeToken}` } })).json();
    assert.equal(scope.scope.order.checkoutUrl, undefined);
    const order = await (await request(`/api/orders/${created.order.id}`, { headers: { Authorization: `Bearer ${created.accessToken}` } })).json();
    assert.equal(order.checkoutUrl, undefined);
    for (const name of ["previousCheckoutIds", "checkoutGeneration", "checkoutAttemptStartedAt"]) assert.equal(order[name], undefined);
    assert.equal((await refresh()).status, 200); assert.equal(creates, 1);
    const uncertain = store.createOrder(submission, false);
    uncertain.order.checkoutAttemptStartedAt = new Date(Date.now() - 24 * 3_600_000).toISOString(); store.saveOrder(uncertain.order);
    const review = await request(`/api/orders/${uncertain.order.id}/checkout`, { method: "POST", headers: { Authorization: `Bearer ${uncertain.accessToken}` } });
    assert.equal(review.status, 409); assert.match((await review.json()).error, /Contact support for review/); assert.equal(creates, 1);
  } finally { release(); await app.queue.stop(); await new Promise<void>((resolve) => app.server.close(() => resolve())); store.close(); }
});

test("Stripe adapter validates authoritative retrieval and preserves generation idempotency request parameters", async () => {
  const stripe = new Stripe("sk_test_not_real"); const sessions = stripe.checkout.sessions;
  const requested: { metadata: unknown; key: unknown }[] = [];
  const base = { id: "cs_sdk", mode: "payment", amount_total: 10000, currency: "usd", client_reference_id: "order-sdk",
    metadata: { orderId: "order-sdk" }, status: "open", payment_status: "unpaid", url: checkoutUrl };
  const create = mock.method(sessions, "create", async (params: { metadata: object }, options: { idempotencyKey: string }) => {
    requested.push({ metadata: params.metadata, key: options.idempotencyKey }); return { ...base, metadata: params.metadata };
  });
  let returned: Record<string, unknown> = base;
  const retrieve = mock.method(sessions, "retrieve", async () => returned);
  try {
    const payments = stripePayments("sk_test_not_real", "whsec_test", "https://example.com", stripe);
    await payments.createCheckout("order-sdk", 0); await payments.createCheckout("order-sdk", 1); await payments.createCheckout("order-sdk", 1);
    assert.deepEqual(requested.map((item) => item.key), ["investigation-order-sdk", "investigation-order-sdk-1", "investigation-order-sdk-1"]);
    assert.deepEqual(requested[0]!.metadata, { orderId: "order-sdk" });
    await assert.rejects(payments.createCheckout("different-order", 0));
    assert.equal((await payments.retrieveCheckout!("cs_sdk")).orderId, "order-sdk");
    for (const invalid of [{ id: "wrong" }, { amount_total: 1 }, { currency: "eur" }, { metadata: { orderId: "wrong" } }, { status: "unknown" }]) {
      returned = { ...base, ...invalid }; await assert.rejects(payments.retrieveCheckout!("cs_sdk"));
    }
  } finally { create.mock.restore(); retrieve.mock.restore(); }
});

test("checkout refresh is limited per order and resumes after its window without another charge", async (context) => {
  context.mock.timers.enable({ apis: ["Date"], now: Date.now() });
  const store = new Store(":memory:"), created = existing(store); let retrievals = 0;
  const { calls, payments } = provider(created.order.id, { status: "open", url: checkoutUrl });
  const retrieve = payments.retrieveCheckout!;
  payments.retrieveCheckout = async id => { retrievals++; return retrieve(id); };
  const app = createApp({ localMode: false, origin: "http://127.0.0.1:3000", adminToken: "administrator-token-long-enough", modelEnabled: true, publicDir: "public" },
    store, async () => { throw new Error("Unpaid work must not run"); }, payments, async () => {});
  app.server.listen(0, "127.0.0.1"); await once(app.server, "listening"); const address = app.server.address(); assert.ok(address && typeof address !== "string");
  const refresh = (token = created.accessToken) => fetch(`http://127.0.0.1:${address.port}/api/orders/${created.order.id}/checkout`,
    { method: "POST", headers: { Authorization: `Bearer ${token}` } });
  try {
    assert.equal((await refresh("incorrect-token")).status, 401);
    for (let index = 0; index < 6; index++) assert.equal((await refresh()).status, 200);
    const limited = await refresh(); assert.equal(limited.status, 429); assert.match((await limited.json()).error, /Wait one minute/);
    assert.equal(retrievals, 6); assert.deepEqual(calls, []);
    context.mock.timers.tick(60_001);
    assert.equal((await refresh()).status, 200); assert.equal(retrievals, 7);
    assert.equal(store.getOrder(created.order.id)!.payment, "pending"); assert.deepEqual(calls, []);
  } finally { await app.queue.stop(); await new Promise<void>(resolve => app.server.close(() => resolve())); store.close(); }
});
