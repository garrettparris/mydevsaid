import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Stripe from "stripe";
import { discoverWebsite } from "./discovery.ts";
import { validatePublicUrl } from "./fetch-page.ts";
import type { AnalysisResult } from "./engine.ts";
import { JobQueue, type Investigator } from "./jobs.ts";
import { stripePayments, type PaymentProvider } from "./payments.ts";
import { createApp } from "./server.ts";
import { Store } from "./store.ts";

const adminToken = "test-administrator-token-at-least-24-characters";
const submission = { links: ["https://example.com/"], token: { chainId: 1, address: `0x${"1".repeat(40)}` } };
async function fixture(): Promise<AnalysisResult> {
  const discovery = await discoverWebsite(submission, {}, async (url) => ({ requestedUrl: url, finalUrl: url,
    status: 200, contentType: "text/html", body: Buffer.from("<title>Example</title><body>Protocol documentation</body>"),
    capturedAt: new Date().toISOString(), redirects: [] }));
  const investigation = discovery.investigation;
  investigation.checks = investigation.checks.map((check) => check.area === "web_presence"
    ? { ...check, status: "completed" } : { ...check, status: "blocked", reason: "Not covered by test fixture" });
  investigation.findings.push({ id: "web-observed", area: "web_presence", claim: "A website is available",
    status: "supported", severity: "informational", explanation: "Observed a successful page response", impact: "Documentation can be read",
    claimEvidenceIds: [], supportingEvidenceIds: [discovery.pages[0]!.observationId], contradictingEvidenceIds: [],
    limitations: ["Does not verify technical claims"] });
  return { investigation, discovery, summary: { explanation: "Example fixture", keyFindings: ["Website available"], limitations: ["Other checks unavailable"] },
    analysisMode: "deterministic", generatedAt: new Date().toISOString() };
}
async function harness(localMode = true, payments?: PaymentProvider, investigator?: Investigator, modelEnabled = !localMode,
  validateUrl: (url: string) => Promise<void> = async () => {}) {
  const store = new Store(":memory:");
  const app = createApp({ localMode, origin: "http://127.0.0.1:3000", adminToken, modelEnabled, publicDir: "public" },
    store, investigator ?? fixture, payments, validateUrl);
  app.server.listen(0, "127.0.0.1"); await once(app.server, "listening");
  const address = app.server.address(); assert.ok(address && typeof address === "object");
  const request = (path: string, options: RequestInit = {}) => fetch(`http://127.0.0.1:${address.port}${path}`, options);
  const post = (path: string, value: unknown, token?: string) => request(path, { method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(value) });
  return { ...app, store, request, post, async close() { await app.queue.stop(); await new Promise<void>((resolve) => app.server.close(() => resolve())); store.close(); } };
}

test("local configuration reports credential presence and RPC precedence without exposing secrets", async () => {
  const names = ["GMGN_API_KEY", "PI_MODEL", "MYDEVSAID_RPC_1", "MYDEVSAID_RPC_4663", "MYDEVSAID_RPC_8453"];
  const saved = names.map((name) => process.env[name]);
  process.env.GMGN_API_KEY = "fixture-private-gmgn-key"; process.env.PI_MODEL = "gpt-5.3-codex";
  process.env.MYDEVSAID_RPC_1 = "https://private-user:private-pass@rpc.example.com/v2/private-path?key=private-query#private-fragment";
  delete process.env.MYDEVSAID_RPC_4663; delete process.env.MYDEVSAID_RPC_8453;
  const app = await harness(true, undefined, undefined, true), hosted = await harness(false);
  try {
    const config = await (await app.request("/api/config")).json();
    assert.deepEqual(config.connections.gmgn, { configured: true, source: "environment" });
    assert.deepEqual(config.connections.model, { enabled: true, name: "gpt-5.3-codex" });
    const ethereum = config.connections.rpcs.find((rpc: { chainId: number }) => rpc.chainId === 1);
    assert.equal(ethereum.custom, true); assert.equal(ethereum.automaticFailover, false);
    assert.deepEqual(ethereum.endpoints, [{ priority: 1, host: "rpc.example.com", selected: true },
      { priority: 2, host: "ethereum-rpc.publicnode.com", selected: false }]);
    const base = config.connections.rpcs.find((rpc: { chainId: number }) => rpc.chainId === 8453);
    assert.equal(base.custom, false); assert.deepEqual(base.endpoints, [{ priority: 1, host: "base-rpc.publicnode.com", selected: true }]);
    assert.doesNotMatch(JSON.stringify(config), /private-|fixture-private-gmgn-key/);
    assert.equal((await (await hosted.request("/api/config")).json()).connections, undefined);
    process.env.GMGN_API_KEY = " "; process.env.MYDEVSAID_RPC_1 = "invalid-private-rpc";
    const disabled = await (await app.request("/api/config")).json();
    assert.deepEqual(disabled.connections.gmgn, { configured: false, source: "environment" });
    assert.equal(disabled.connections.rpcs.find((rpc: { chainId: number }) => rpc.chainId === 1).endpoints[0].host, "Invalid endpoint");
    assert.doesNotMatch(JSON.stringify(disabled), /invalid-private-rpc/);
  } finally {
    await app.close(); await hosted.close();
    names.forEach((name, index) => { if (saved[index] === undefined) delete process.env[name]; else process.env[name] = saved[index]; });
  }
});

test("local preview requires administrator auth and rejects cross-origin submissions", async () => {
  const app = await harness();
  try {
    assert.equal((await app.post("/api/orders", submission)).status, 401);
    assert.equal((await app.request("/api/orders", { method: "POST", headers: { Origin: "https://attacker.example", Authorization: `Bearer ${adminToken}` } })).status, 403);
    const config = await (await app.request("/api/config")).json();
    assert.equal(config.localMode, true); assert.equal(config.billingEnabled, false);
    assert.ok(!JSON.stringify(config).includes(adminToken));
  } finally { await app.close(); }
});

test("Robinhood mainnet is offered and paid orders retain it while testnet is rejected before checkout", async () => {
  let checkouts = 0, runs = 0;
  const payments: PaymentProvider = { async createCheckout() { checkouts++; return { id: "cs_robinhood", url: "https://checkout.stripe.com/test" }; }, verifyWebhook() { return null; } };
  const app = await harness(false, payments, async () => { runs++; return fixture(); });
  try {
    const config = await (await app.request("/api/config")).json();
    assert.deepEqual([...config.supportedChains].sort((a, b) => a - b), [1, 4663, 8453]);
    const scope = await (await app.post("/api/scopes", { message: `https://example.com Robinhood Chain ${submission.token.address}` })).json();
    const response = await app.post("/api/orders", { scopeId: scope.scope.id, scopeAccessToken: scope.accessToken, scopeRevision: scope.scope.revision });
    assert.equal(response.status, 201);
    const created = await response.json();
    assert.equal(app.store.getOrder(created.orderId)!.submission.token!.chainId, 4663);
    assert.equal(created.status, "awaiting_payment");
    const testnet = await (await app.post("/api/scopes", { message: `https://example.com chain 46630 ${submission.token.address}` })).json();
    assert.equal((await app.post("/api/orders", { scopeId: testnet.scope.id, scopeAccessToken: testnet.accessToken, scopeRevision: testnet.scope.revision })).status, 409);
    await app.queue.idle();
    assert.equal(checkouts, 1); assert.equal(runs, 0);
  } finally { await app.close(); }
});

test("private drafts need order capability; human publication unlocks immutable public reports", async () => {
  const app = await harness();
  try {
    const created = await app.post("/api/orders", submission, adminToken); assert.equal(created.status, 201);
    const order = await created.json(); await app.queue.idle();
    assert.equal((await app.request(`/api/orders/${order.orderId}`)).status, 401);
    assert.equal((await app.request(`/api/orders/${order.orderId}`, { headers: { Authorization: `Bearer ${adminToken}` } })).status, 401);
    const progress = await (await app.request(`/api/orders/${order.orderId}`, { headers: { Authorization: `Bearer ${order.accessToken}` } })).json();
    assert.equal(progress.status, "review"); assert.equal(progress.payment, "local_preview");
    assert.ok(!("accessHash" in progress)); assert.ok(!("checkoutId" in progress));
    const reportId = progress.reportId;
    assert.equal((await app.request(`/api/reports/${reportId}`)).status, 404);
    assert.deepEqual(await (await app.request("/api/reports")).json(), { reports: [] });
    assert.equal((await app.post(`/api/reports/${reportId}/publish`, { acknowledgeLimitations: true })).status, 401);
    assert.equal((await app.post(`/api/reports/${reportId}/publish`, {}, adminToken)).status, 400);
    const published = await app.post(`/api/reports/${reportId}/publish`, { acknowledgeLimitations: true }, adminToken);
    assert.equal(published.status, 200);
    const publicReport = await (await app.request(`/api/reports/${reportId}`)).json();
    assert.deepEqual(publicReport.result, progress.result); assert.ok(publicReport.publishedAt);
    const tokenReports = await (await app.request(`/api/tokens/1/${submission.token.address}`)).json();
    assert.equal(tokenReports.reports.length, 1); assert.equal(tokenReports.reports[0].version, 1);
    assert.equal((await app.request(`/api/tokens/8453/${submission.token.address}`)).status, 200);
    assert.equal((await (await app.request(`/api/tokens/8453/${submission.token.address}`)).json()).reports.length, 0);
    assert.equal(app.store.publish(reportId).publishedAt, publicReport.publishedAt);
    assert.equal((await app.post(`/api/reports/${reportId}/recheck`, {})).status, 401);
    const refreshed = await app.post(`/api/reports/${reportId}/recheck`, {}, adminToken);
    assert.equal(refreshed.status, 201); await app.queue.idle();
    const refreshOrder = app.store.getOrder((await refreshed.json()).orderId)!;
    assert.equal(app.store.getReport(refreshOrder.reportId!)!.version, 2);
    assert.deepEqual(app.store.getReport(reportId)!.result, publicReport.result);
  } finally { await app.close(); }
});

test("production never queues without billing or a verified payment", async () => {
  let runs = 0;
  const unavailable = await harness(false);
  try { assert.equal((await unavailable.post("/api/orders", submission)).status, 503); }
  finally { await unavailable.close(); }
  let orderId = "";
  const payments: PaymentProvider = {
    async createCheckout(id) { orderId = id; return { id: "cs_test", url: "https://checkout.stripe.com/test" }; },
    verifyWebhook(body, signature) { if (signature !== "valid" || body.toString() !== "exact bytes") throw new Error("Invalid");
      return { eventId: "evt_test", orderId, checkoutId: "cs_test" }; },
  };
  const modelUnavailable = await harness(false, payments, undefined, false);
  try { assert.equal((await modelUnavailable.post("/api/orders", submission)).status, 503); }
  finally { await modelUnavailable.close(); }
  const app = await harness(false, payments, async () => { runs++; return fixture(); });
  try {
    const scope = await (await app.post("/api/scopes", { message: `https://example.com Ethereum ${submission.token.address}` })).json();
    const response = await app.post("/api/orders", { scopeId: scope.scope.id, scopeAccessToken: scope.accessToken, scopeRevision: scope.scope.revision }); assert.equal(response.status, 201);
    const created = await response.json(); assert.equal(created.status, "awaiting_payment");
    app.queue.kick(); await app.queue.idle(); assert.equal(runs, 0);
    assert.equal((await app.request(`/?order=${orderId}&checkout=returned`)).status, 200);
    assert.equal(app.store.getOrder(orderId)!.payment, "pending");
    assert.equal((await app.post("/api/orders/" + orderId + "/retry", {}, adminToken)).status, 409);
    assert.equal((await app.request("/api/webhooks/stripe", { method: "POST", body: "exact bytes" })).status, 400);
    for (let i = 0; i < 2; i++) {
      assert.equal((await app.request("/api/webhooks/stripe", { method: "POST", headers: { "stripe-signature": "valid" }, body: "exact bytes" })).status, 200);
      await app.queue.idle();
    }
    assert.equal(runs, 1); assert.equal(app.store.getOrder(orderId)!.payment, "paid");
  } finally { await app.close(); }
});

test("Stripe requires valid raw-body signature and exact paid amount, currency, and order", () => {
  const stripe = new Stripe("sk_test_not_real");
  const secret = "whsec_test_not_real";
  const provider = stripePayments("sk_test_not_real", secret, "https://example.com");
  const session = { id: "cs_123", mode: "payment", payment_status: "paid", amount_total: 10000, currency: "usd",
    client_reference_id: "order-123", metadata: { orderId: "order-123" } };
  const signed = (overrides: Record<string, unknown> = {}) => {
    const body = JSON.stringify({ id: "evt_123", type: "checkout.session.completed", data: { object: { ...session, ...overrides } } });
    return { body: Buffer.from(body), signature: stripe.webhooks.generateTestHeaderString({ payload: body, secret }) };
  };
  const valid = signed();
  assert.deepEqual(provider.verifyWebhook(valid.body, valid.signature), { eventId: "evt_123", checkoutId: "cs_123", orderId: "order-123" });
  assert.throws(() => provider.verifyWebhook(Buffer.from("{}"), valid.signature));
  for (const override of [{ amount_total: 1 }, { currency: "eur" }, { mode: "subscription" }, { metadata: { orderId: "other" } }]) {
    const invalid = signed(override); assert.throws(() => provider.verifyWebhook(invalid.body, invalid.signature));
  }
  const unpaid = signed({ payment_status: "unpaid" }); assert.equal(provider.verifyWebhook(unpaid.body, unpaid.signature), null);
});

test("webhook order mismatch rolls back event and cannot unlock another checkout", () => {
  const store = new Store(":memory:");
  try {
    const { order } = store.createOrder(submission, false); order.checkoutId = "cs_correct"; store.saveOrder(order);
    assert.throws(() => store.acceptPayment("evt_1", order.id, "cs_wrong"));
    assert.equal(store.getOrder(order.id)!.payment, "pending");
    assert.equal(store.acceptPayment("evt_1", order.id, "cs_correct"), true);
    assert.equal(store.acceptPayment("evt_1", order.id, "cs_correct"), false);
    assert.equal(store.acceptPayment("evt_2", order.id, "cs_correct"), false);
  } finally { store.close(); }
});

test("restart preserves data and makes interrupted work explicitly retryable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mydevsaid-store-")); const filename = join(dir, "db.sqlite");
  let store = new Store(filename);
  const { order } = store.createOrder(submission, true); order.status = "running"; store.saveOrder(order); store.close();
  store = new Store(filename); const queue = new JobQueue(store, fixture);
  try {
    assert.equal(store.getOrder(order.id)!.status, "failed");
    queue.retry(order.id); await queue.idle(); assert.equal(store.getOrder(order.id)!.status, "review");
    const first = store.getReport(store.getOrder(order.id)!.reportId!)!;
    const second = store.createOrder(submission, true); queue.kick(); await queue.idle();
    assert.equal(store.getReport(store.getOrder(second.order.id)!.reportId!)!.version, 2);
    assert.deepEqual(store.getReport(first.id), first);
  } finally { await queue.stop(); store.close(); await rm(dir, { recursive: true, force: true }); }
});

test("queue limits concurrency and does not run unfunded work", async () => {
  const store = new Store(":memory:"); let active = 0; let peak = 0; let runs = 0;
  const queue = new JobQueue(store, async () => { active++; peak = Math.max(peak, active); runs++;
    await new Promise((resolve) => setTimeout(resolve, 5)); active--; return fixture(); }, 2);
  try {
    for (let i = 0; i < 5; i++) store.createOrder(submission, true);
    const unpaid = store.createOrder(submission, false); unpaid.order.status = "queued"; store.saveOrder(unpaid.order);
    queue.kick(); await queue.idle(); assert.equal(peak, 2); assert.equal(runs, 5);
  } finally { await queue.stop(); store.close(); }
});

test("unfinished evidence cannot be published even by administrator", async () => {
  const result = await fixture(); result.investigation.checks[1]!.status = "running";
  const app = await harness(true, undefined, async () => result);
  try {
    const order = await (await app.post("/api/orders", submission, adminToken)).json(); await app.queue.idle();
    const reportId = app.store.getOrder(order.orderId)!.reportId!;
    assert.equal((await app.post(`/api/reports/${reportId}/publish`, { acknowledgeLimitations: true }, adminToken)).status, 409);
  } finally { await app.close(); }
});

test("invalid submissions are rejected before checkout and static paths cannot escape public assets", async () => {
  let checkouts = 0;
  const payments: PaymentProvider = { async createCheckout() { checkouts++; return { id: "cs", url: "https://checkout.stripe.com" }; }, verifyWebhook() { return null; } };
  const app = await harness(false, payments, undefined, true, validatePublicUrl);
  try {
    assert.equal((await app.post("/api/orders", { links: ["file:///etc/passwd"] })).status, 400);
    assert.equal((await app.post("/api/orders", { links: ["https://example.com"] })).status, 400);
    assert.equal((await app.post("/api/orders", { ...submission, token: { ...submission.token, chainId: 56 } })).status, 400);
    assert.equal((await app.post("/api/orders", { ...submission, links: ["http://127.0.0.1"] })).status, 400);
    assert.equal(checkouts, 0);
    assert.equal((await app.request("/%2e%2e/package.json")).status, 404);
    assert.equal((await app.request("/api/admin/orders")).status, 401);
    assert.equal((await app.post("/api/orders", { ...submission, links: [`https://example.com/${"a".repeat(130000)}`] })).status, 413);
  } finally { await app.close(); }
});

test("only explicitly trusted proxies can select a client rate-limit bucket", async () => {
  for (const trusted of [false, true]) {
    const store = new Store(":memory:");
    const app = createApp({ localMode: true, origin: "http://127.0.0.1:3000", adminToken, modelEnabled: false,
      publicDir: "public", trustedProxyIps: trusted ? ["127.0.0.1"] : [] }, store, fixture, undefined, async () => {});
    app.server.listen(0, "127.0.0.1"); await once(app.server, "listening");
    const address = app.server.address(); assert.ok(address && typeof address === "object");
    try {
      for (let i = 0; i < 11; i++) {
        const response: Response = await fetch(`http://127.0.0.1:${address.port}/api/orders`, { method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${adminToken}`, "X-Forwarded-For": `1.1.1.1, 8.8.8.${i + 1}` }, body: "{}" });
        assert.equal(response.status, i === 10 && !trusted ? 429 : 400);
      }
    } finally { await app.queue.stop(); await new Promise<void>((resolve) => app.server.close(() => resolve())); store.close(); }
  }
});


test("free scope recovers privately and stale edits or checkout cannot change its quote", async () => {
  let runs = 0, validations = 0;
  const app = await harness(true, undefined, async () => { runs++; return fixture(); }, false, async () => { validations++; });
  try {
    const start = await app.post("/api/scopes", { message: "https://example.com/ Look at treasury claims." });
    assert.equal(start.status, 201);
    const created = await start.json(), path = `/api/scopes/${created.scope.id}`;
    assert.equal((await app.request(path)).status, 401);
    const updated = await (await app.post(`${path}/messages`, { message: `Ethereum ${submission.token.address}`, revision: 1 }, created.accessToken)).json();
    assert.equal(updated.scope.status, "ready"); assert.equal(updated.scope.revision, 2);
    assert.equal((await app.post(`${path}/messages`, { message: "Base", revision: 1 }, created.accessToken)).status, 409);
    const headers = { Authorization: `Bearer ${created.accessToken}` };
    assert.deepEqual((await (await app.request(path, { headers })).json()).scope, updated.scope);
    assert.equal(runs, 0); assert.equal(validations, 0); assert.equal(app.store.orders().length, 0);
    const checkout = { scopeId: created.scope.id, scopeRevision: 1, scopeAccessToken: created.accessToken };
    assert.equal((await app.post("/api/orders", checkout, adminToken)).status, 409);
    checkout.scopeRevision = 2;
    const order = await (await app.post("/api/orders", checkout, adminToken)).json();
    await app.queue.idle(); assert.equal(runs, 1);
    assert.equal((await app.post(`${path}/messages`, { message: "change scope", revision: 2 }, created.accessToken)).status, 409);
    const recovered = (await (await app.request(path, { headers })).json()).scope;
    assert.equal(recovered.order.orderId, order.orderId); assert.equal(recovered.order.accessToken, order.accessToken);
    assert.equal(app.store.getOrder(order.orderId)!.scope!.revision, 2);
  } finally { await app.close(); }
});

test("failed and abandoned scoped checkout retries the same order and only one paid event starts work", async () => {
  let checkouts = 0, runs = 0, orderId = "";
  const payments: PaymentProvider = {
    async createCheckout(id) { orderId = id; checkouts++; if (checkouts === 1) throw new Error("provider unavailable");
      await new Promise((resolve) => setTimeout(resolve, 10)); return { id: "cs_scope", url: "https://checkout.stripe.com/scope" }; },
    async retrieveCheckout(id) { return { id, orderId, status: "open", paymentStatus: "unpaid", url: "https://checkout.stripe.com/scope" }; },
    verifyWebhook(body) { return body.toString() === "paid" ? { eventId: "evt_scope", orderId, checkoutId: "cs_scope" } : null; },
  };
  const app = await harness(false, payments, async () => { runs++; return fixture(); });
  try {
    const created = await (await app.post("/api/scopes", { message: `https://example.com/ Ethereum ${submission.token.address}` })).json();
    const checkout = { scopeId: created.scope.id, scopeRevision: 1, scopeAccessToken: created.accessToken };
    assert.equal((await app.post("/api/orders", checkout)).status, 502);
    const scopePath = `/api/scopes/${created.scope.id}`, headers = { Authorization: `Bearer ${created.accessToken}` };
    const failed = (await (await app.request(scopePath, { headers })).json()).scope;
    assert.equal(failed.status, "locked"); assert.equal(failed.order.status, "failed"); assert.equal(runs, 0);
    const retries = await Promise.all([app.post("/api/orders", checkout), app.post("/api/orders", checkout)]);
    const first = await retries[0]!.json(), second = await retries[1]!.json();
    assert.equal(first.orderId, failed.order.orderId); assert.deepEqual(first, second);
    assert.equal(checkouts, 2); assert.equal(app.store.orders().length, 1);
    const resumed = (await (await app.request(scopePath, { headers })).json()).scope;
    assert.equal(resumed.order.checkoutUrl, "https://checkout.stripe.com/scope");
    assert.equal((await app.request(`/api/orders/${first.orderId}`, { headers: { Authorization: `Bearer ${first.accessToken}` } })).status, 200);
    assert.equal((await app.post("/api/orders", checkout)).status, 201); assert.equal(checkouts, 2);
    await app.request("/api/webhooks/stripe", { method: "POST", body: "failed-payment" });
    await app.queue.idle(); assert.equal(runs, 0); assert.equal(app.store.getOrder(orderId)!.payment, "pending");
    for (let i = 0; i < 2; i++) {
      assert.equal((await app.request("/api/webhooks/stripe", { method: "POST", body: "paid" })).status, 200);
      await app.queue.idle();
    }
    assert.equal(runs, 1); assert.equal(app.store.getOrder(orderId)!.payment, "paid");
    assert.equal(app.store.getOrder(orderId)!.scope!.messages[0]!.content, created.scope.messages[0].content);
  } finally { await app.close(); }
});
