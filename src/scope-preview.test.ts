import assert from "node:assert/strict";
import { once } from "node:events";
import test from "node:test";
import { createApp } from "./server.ts";
import { Store } from "./store.ts";
import type { ScopeDiscovery } from "./scope-discovery.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const token = `0x${"1".repeat(40)}`;
const fixture: ScopeDiscovery = { mode: "deterministic", pages: [{ url: "https://example.com/", title: "Example",
  excerpt: "This project claims to provide a lending protocol.", capturedAt: "2026-09-15T00:00:00Z", sha256: "a".repeat(64) }],
  documentation: [{ url: "https://example.com/docs", label: "Docs", sourceUrl: "https://example.com/" }],
  candidates: [{ address: token, chainId: 1, context: "Token", sourceUrl: "https://example.com/" }],
  attemptedPages: 1, limitations: ["Unverified website claims only"], failures: [] };
async function harness(discover: (links: string[]) => Promise<ScopeDiscovery>) {
  let runs = 0, checkouts = 0;
  const store = new Store(":memory:");
  const app = createApp({ localMode: false, origin: "http://127.0.0.1:3000", adminToken: "test-administrator-token-at-least-24-characters", modelEnabled: true, publicDir: "public" },
    store, async () => { runs++; throw new Error("Deep analysis must not run in free discovery"); },
    { createCheckout: async () => { checkouts++; return { id: "test-checkout", url: "https://checkout.stripe.com/test" }; }, verifyWebhook: () => null },
    async () => {}, discover);
  app.server.listen(0, "127.0.0.1"); await once(app.server, "listening");
  const address = app.server.address(); assert.ok(address && typeof address === "object");
  const request = (path: string, options: RequestInit = {}) => fetch(`http://127.0.0.1:${address.port}${path}`, options);
  const post = (path: string, value: unknown, capability = "") => request(path, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${capability}` }, body: JSON.stringify(value) });
  return { ...app, store, request, post, counts: () => ({ runs, checkouts }), async close() { await app.queue.stop(); await new Promise<void>(resolve => app.server.close(() => resolve())); store.close(); } };
}

test("Free lookup preserves private access, requires current scope and never selects a token or starts analysis", async () => {
  let lookups = 0;
  const app = await harness(async links => { lookups++; assert.deepEqual(links, ["https://example.com/"]); return fixture; });
  try {
    const created = await (await app.post("/api/scopes", { message: "https://example.com" })).json();
    const path = `/api/scopes/${created.scope.id}`;
    assert.equal(lookups, 0);
    assert.equal((await app.post(`${path}/discovery`, { revision: 1 })).status, 401);
    assert.equal((await app.post(`${path}/discovery`, { revision: 0 }, created.accessToken)).status, 409);
    const result = await (await app.post(`${path}/discovery`, { revision: 1 }, created.accessToken)).json();
    assert.equal(result.scope.revision, 3);
    assert.equal(result.scope.preview.status, "complete");
    assert.equal(result.scope.status, "draft");
    assert.equal(result.scope.submission.token, undefined);
    assert.deepEqual(result.scope.submission.links, ["https://example.com/"]);
    assert.deepEqual(app.counts(), { runs: 0, checkouts: 0 });
    const cached = await (await app.post(`${path}/discovery`, { revision: 1 }, created.accessToken)).json();
    assert.deepEqual(cached.scope, result.scope); assert.equal(lookups, 1);
    const ready = await (await app.post(`${path}/messages`, { message: `Confirm token ${token} on chain 1`, revision: 3 }, created.accessToken)).json();
    assert.equal(ready.scope.status, "ready"); assert.equal(ready.scope.submission.token.address, token);
    const paid = await (await app.post("/api/orders", { scopeId: created.scope.id, scopeRevision: ready.scope.revision, scopeAccessToken: created.accessToken })).json();
    assert.equal(paid.status, "awaiting_payment");
    assert.equal((await app.post(`${path}/discovery`, { revision: ready.scope.revision }, created.accessToken)).status, 409);
    assert.deepEqual(app.store.getOrder(paid.orderId)!.scope!.preview, result.scope.preview);
    assert.deepEqual(app.counts(), { runs: 0, checkouts: 1 });
  } finally { await app.close(); }
});

test("Concurrent lookups share a reservation and checkout cannot pin an unfinished preview", async () => {
  const started = deferred<void>(), release = deferred<ScopeDiscovery>();
  let calls = 0;
  const app = await harness(async () => { calls++; started.resolve(); return release.promise; });
  try {
    const created = await (await app.post("/api/scopes", { message: `https://example.com Ethereum ${token}` })).json();
    const path = `/api/scopes/${created.scope.id}`;
    const one = app.post(`${path}/discovery`, { revision: 1 }, created.accessToken);
    await started.promise;
    const two = app.post(`${path}/discovery`, { revision: 1 }, created.accessToken);
    const running = app.store.getScope(created.scope.id, created.accessToken);
    assert.equal(running.preview!.status, "running");
    assert.equal((await app.post(`${path}/messages`, { revision: running.revision, message: "Base" }, created.accessToken)).status, 409);
    assert.equal((await app.post("/api/orders", { scopeId: created.scope.id, scopeRevision: running.revision, scopeAccessToken: created.accessToken })).status, 409);
    release.resolve(fixture);
    assert.deepEqual(await (await one).json(), await (await two).json());
    assert.equal(calls, 1); assert.equal(app.store.orders().length, 0);
  } finally { release.resolve(fixture); await app.close(); }
});

test("Lookup failures consume the one-shot budget and changed links cannot silently refetch", async () => {
  let calls = 0;
  const app = await harness(async () => { calls++; throw new Error("private-provider-secret"); });
  try {
    const created = await (await app.post("/api/scopes", { message: "https://example.com" })).json();
    const path = `/api/scopes/${created.scope.id}`;
    const failed = await (await app.post(`${path}/discovery`, { revision: 1 }, created.accessToken)).json();
    assert.equal(failed.scope.preview.status, "failed");
    assert.doesNotMatch(JSON.stringify(failed), /private-provider-secret/);
    const changed = await (await app.post(`${path}/messages`, { revision: failed.scope.revision, message: "replace links https://other.example" }, created.accessToken)).json();
    const cached = await (await app.post(`${path}/discovery`, { revision: changed.scope.revision }, created.accessToken)).json();
    assert.deepEqual(cached.scope.preview.seedLinks, ["https://example.com/"]);
    assert.deepEqual(cached.scope.submission.links, ["https://other.example/"]);
    assert.equal(calls, 1);
  } finally { await app.close(); }
});

test("Interrupted reservations expire without refetching or overwriting newer conversation state", () => {
  const store = new Store(":memory:");
  try {
    const created = store.createScope("https://example.com");
    const reserved = store.reserveScopeDiscovery(created.scope.id, created.accessToken, 1).scope;
    reserved.preview!.startedAt = "2000-01-01T00:00:00Z";
    store.db.prepare("UPDATE scopes SET body=? WHERE id=?").run(JSON.stringify(reserved), reserved.id);
    const recovered = store.getScope(reserved.id, created.accessToken);
    assert.equal(recovered.preview!.status, "failed"); assert.equal(recovered.revision, 3);
    const changed = store.updateScope(reserved.id, created.accessToken, "replace links https://other.example", 3);
    const late = store.finishScopeDiscovery(reserved.id, created.accessToken, reserved.revision, fixture);
    assert.deepEqual(late, changed);
    assert.equal(store.reserveScopeDiscovery(reserved.id, created.accessToken, changed.revision).reserved, false);
  } finally { store.close(); }
});

test("Global free lookup concurrency is bounded before consuming another conversation's budget", async () => {
  const starts = Array.from({ length: 5 }, () => deferred<void>());
  const release = deferred<ScopeDiscovery>(); let calls = 0;
  const app = await harness(async () => { starts[calls++]!.resolve(); return release.promise; });
  const pending: Promise<Response>[] = [];
  try {
    for (let i = 0; i < 4; i++) {
      const created = await (await app.post("/api/scopes", { message: "https://example.com" })).json();
      pending.push(app.post(`/api/scopes/${created.scope.id}/discovery`, { revision: 1 }, created.accessToken));
      await starts[i]!.promise;
    }
    const extra = await (await app.post("/api/scopes", { message: "https://example.com" })).json();
    const path = `/api/scopes/${extra.scope.id}/discovery`;
    assert.equal((await app.post(path, { revision: 1 }, extra.accessToken)).status, 429);
    assert.equal(app.store.getScope(extra.scope.id, extra.accessToken).preview, undefined);
    release.resolve(fixture); await Promise.all(pending);
    assert.equal((await app.post(path, { revision: 1 }, extra.accessToken)).status, 200);
    assert.equal(calls, 5);
  } finally { release.resolve(fixture); await Promise.allSettled(pending); await app.close(); }
});
