import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createApp } from "./server.ts";
import { Store } from "./store.ts";
import type { PaymentProvider } from "./payments.ts";

const adminToken = "test-administrator-token-at-least-24-characters";
const submission = { links: ["https://example.com/"], token: { chainId: 1, address: `0x${"1".repeat(40)}` } };
const message = `https://example.com Ethereum ${submission.token.address}`;
async function harness(localMode = false) {
  const store = new Store(":memory:"); const counts = { validations: 0, checkouts: 0, runs: 0, retrievals: 0 };
  const payments: PaymentProvider = {
    async createCheckout(id) { counts.checkouts++; return { id: `cs_${id}`, url: "https://checkout.stripe.com/test" }; },
    async retrieveCheckout(id) { counts.retrievals++; return { id, orderId: id.slice(3), status: "open", paymentStatus: "unpaid", url: "https://checkout.stripe.com/test" }; },
    verifyWebhook() { return null; },
  };
  const app = createApp({ localMode, origin: "http://127.0.0.1:3000", adminToken, modelEnabled: true, publicDir: "public" }, store,
    async () => { counts.runs++; throw new Error("Fixture stops after queue entry"); }, payments, async () => { counts.validations++; });
  app.server.listen(0, "127.0.0.1"); await once(app.server, "listening"); const address = app.server.address(); assert.ok(address && typeof address !== "string");
  const request = (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${address.port}${path}`, init);
  const post = (path: string, value: unknown, token?: string) => request(path, { method: "POST", headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(value) });
  const scope = async (text = message) => {
    const response = await post("/api/scopes", { message: text }); assert.equal(response.status, 201);
    const created = await response.json();
    return { scopeId: created.scope.id as string, scopeAccessToken: created.accessToken as string, scopeRevision: created.scope.revision as number };
  };
  return { ...app, store, counts, request, post, scope, async close() { await app.queue.stop(); await new Promise<void>((resolve) => app.server.close(() => resolve())); store.close(); } };
}

test("production direct intake is rejected before validation, payment creation, storage, or queue, including administrator requests", async () => {
  const app = await harness();
  try {
    for (const token of [undefined, adminToken]) {
      const response = await app.post("/api/orders", submission, token);
      assert.equal(response.status, 400); assert.match((await response.json()).error, /saved conversation scope/);
    }
    assert.deepEqual(app.counts, { validations: 0, checkouts: 0, runs: 0, retrievals: 0 });
    assert.equal(app.store.orders().length, 0);
  } finally { await app.close(); }
});

test("incomplete, stale, unauthorized, and client-mutated scopes cannot reach checkout", async () => {
  const app = await harness();
  try {
    const draft = await app.scope("https://example.com");
    assert.equal((await app.post("/api/orders", draft)).status, 409);
    const ready = await app.scope();
    assert.equal((await app.post("/api/orders", { ...ready, scopeAccessToken: "incorrect" }, adminToken)).status, 401);
    assert.equal((await app.post("/api/orders", { ...ready, scopeRevision: ready.scopeRevision - 1 })).status, 409);
    assert.equal((await app.post("/api/orders", { ...ready, links: ["https://changed.example/"] })).status, 400);
    const current = app.store.updateScope(ready.scopeId, ready.scopeAccessToken, "Also inspect documented APIs", ready.scopeRevision);
    assert.equal((await app.post("/api/orders", ready)).status, 409);
    app.store.reserveScopeDiscovery(ready.scopeId, ready.scopeAccessToken, current.revision);
    assert.equal((await app.post("/api/orders", { ...ready, scopeRevision: current.revision + 1 })).status, 409);
    assert.deepEqual(app.counts, { validations: 0, checkouts: 0, runs: 0, retrievals: 0 });
    assert.equal(app.store.orders().length, 0);
  } finally { await app.close(); }
});

test("reviewed scope creates one immutable order and locked same-scope checkout resumes", async () => {
  const app = await harness();
  try {
    const scoped = await app.scope();
    const response = await app.post("/api/orders", scoped); assert.equal(response.status, 201); const first = await response.json();
    const original = app.store.getOrder(first.orderId)!;
    assert.equal(original.payment, "pending"); assert.equal(original.scope!.revision, scoped.scopeRevision);
    assert.equal((await app.post("/api/orders", { ...scoped, token: { ...submission.token, chainId: 8453 } })).status, 400);
    assert.equal((await app.post(`/api/scopes/${scoped.scopeId}/messages`, { message: "Use a different token", revision: scoped.scopeRevision }, scoped.scopeAccessToken)).status, 409);
    const resumed = await app.post("/api/orders", scoped); assert.equal(resumed.status, 201);
    assert.deepEqual(await resumed.json(), first);
    assert.equal(app.counts.checkouts, 1); assert.equal(app.counts.retrievals, 1); assert.equal(app.counts.runs, 0);
    assert.equal(app.store.orders().length, 1); assert.deepEqual(app.store.getOrder(first.orderId)!.scope, original.scope);
  } finally { await app.close(); }
});

test("authenticated local direct intake and legacy production order capability recovery remain available", async () => {
  const local = await harness(true);
  try {
    assert.equal((await local.post("/api/orders", submission)).status, 401);
    assert.equal((await local.post("/api/orders", submission, adminToken)).status, 201);
    await local.queue.idle(); assert.equal(local.counts.runs, 1); assert.equal(local.counts.checkouts, 0);
  } finally { await local.close(); }
  const production = await harness();
  try {
    const legacy = production.store.createOrder(submission, false);
    production.store.recordCheckout(legacy.order.id, 0, { id: `cs_${legacy.order.id}`, url: "https://checkout.stripe.com/test" });
    const headers = { Authorization: `Bearer ${legacy.accessToken}` };
    assert.equal((await production.request(`/api/orders/${legacy.order.id}`, { headers })).status, 200);
    const response = await production.request(`/api/orders/${legacy.order.id}/checkout`, { method: "POST", headers });
    assert.equal(response.status, 200); assert.equal((await response.json()).payment, "pending");
    assert.equal(production.counts.retrievals, 1); assert.equal(production.counts.checkouts, 0); assert.equal(production.counts.runs, 0);
  } finally { await production.close(); }
});
