import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverWebsite } from "./discovery.ts";
import type { AnalysisResult } from "./engine.ts";
import type { Investigator } from "./jobs.ts";
import { createApp } from "./server.ts";
import { Store } from "./store.ts";

async function fixture(input: unknown): Promise<AnalysisResult> {
  const discovery = await discoverWebsite(input, {}, async (url) => ({ requestedUrl: url, finalUrl: url, status: 200,
    contentType: "text/html", body: Buffer.from("<title>Example</title><p>Protocol documentation</p>"), capturedAt: new Date().toISOString(), redirects: [] }));
  const investigation = discovery.investigation;
  investigation.checks = investigation.checks.map((check) => check.area === "web_presence" ? { ...check, status: "completed" }
    : { ...check, status: "blocked", reason: "Fixture has no provider access" });
  investigation.findings.push({ id: "website-observed", area: "web_presence", claim: "A website is available", status: "supported",
    severity: "informational", explanation: "The website returned protocol documentation", impact: "The documentation can be read",
    claimEvidenceIds: [], supportingEvidenceIds: [discovery.pages[0]!.observationId], contradictingEvidenceIds: [], limitations: ["Does not verify technical claims"] });
  return { investigation, discovery, analysisMode: "deterministic", generatedAt: new Date().toISOString(),
    summary: { explanation: "The project website contains documentation.", keyFindings: ["Website available"], limitations: ["Other checks unavailable"] } };
}
async function harness(investigate: Investigator = fixture, localMode = true, filename = ":memory:") {
  const store = new Store(filename);
  const app = createApp({ localMode, origin: "http://127.0.0.1:3000", adminToken: "", modelEnabled: false, publicDir: "public" }, store, investigate);
  app.server.listen(0, "127.0.0.1"); await once(app.server, "listening");
  const address = app.server.address(); assert.ok(address && typeof address === "object");
  const request = (path: string, options: RequestInit = {}) => fetch(`http://127.0.0.1:${address.port}${path}`, options);
  const post = (path: string, value: unknown) => request(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
  return { ...app, store, request, post, async close() {
    await new Promise<void>((resolve) => app.server.close(() => resolve())); await app.queue.stop(); store.close();
  } };
}

test("personal endpoints are local only and inherit origin and host guards", async () => {
  const production = await harness(fixture, false);
  try {
    assert.equal((await production.post("/api/chats", { message: "https://example.com", requestId: "production-create" })).status, 404);
    assert.equal((await production.request("/api/chats")).status, 404);
    assert.equal((await (await production.request("/api/config")).json()).personalMode, false);
    assert.equal(production.store.orders().length, 0);
  } finally { await production.close(); }
  const app = await harness();
  try {
    assert.equal((await app.request("/api/chats", { method: "POST", headers: { Origin: "https://attacker.test" } })).status, 403);
    const address = app.server.address(); assert.ok(address && typeof address === "object");
    assert.equal(await new Promise<number | undefined>((resolve, reject) => {
      httpRequest({ hostname: "127.0.0.1", port: address.port, path: "/api/chats", headers: { Host: "attacker.test" } },
        (response) => { response.resume(); resolve(response.statusCode); }).on("error", reject).end();
    }), 403);
    assert.equal((await (await app.request("/api/config")).json()).personalMode, true);
    const response = await app.post("/api/chats", { message: "https://example.com", requestId: "local-no-admin" });
    assert.equal(response.status, 201); await app.queue.idle();
    const { chat } = await response.json();
    const order = app.store.getOrder(chat.runs[0].id)!;
    assert.equal(order.payment, "local_preview"); assert.equal(order.submission.token, undefined);
    assert.equal((await app.request(`/api/reports/${order.reportId}`)).status, 404);
  } finally { await app.close(); }
});

test("partial input persists, website-only input runs, and evidence questions do not rerun", async () => {
  let runs = 0;
  const app = await harness(async (input, progress) => { runs++; progress?.("Fetched the website"); return fixture(input); });
  try {
    let { chat } = await (await app.post("/api/chats", { message: "Can you check this project?", requestId: "partial-create" })).json();
    assert.equal(chat.status, "waiting"); assert.equal(chat.runs.length, 0); assert.ok(chat.questions.length);
    ({ chat } = await (await app.post(`/api/chats/${chat.id}/messages`, { message: "https://example.com", revision: chat.revision, requestId: "partial-link" })).json());
    assert.equal(chat.runs.length, 1); assert.equal(chat.runs[0].afterMessageId, chat.messages.filter((item: { role: string }) => item.role === "user").at(-1).id);
    await app.queue.idle();
    ({ chat } = await (await app.request(`/api/chats/${chat.id}`)).json());
    assert.equal(chat.status, "ready"); assert.equal(chat.runs[0].status, "completed"); assert.ok(chat.runs[0].reportId);
    assert.ok(chat.runs[0].progress.includes("Fetched the website"));
    ({ chat } = await (await app.post(`/api/chats/${chat.id}/messages`, { message: "What evidence is there for the website?", revision: chat.revision, requestId: "partial-question" })).json());
    assert.equal(runs, 1); assert.equal(chat.runs.length, 1);
    assert.ok(chat.messages.at(-1).evidenceIds.length); assert.equal(chat.messages.at(-1).reportId, chat.runs[0].reportId);
    const listed = await (await app.request("/api/chats")).json();
    assert.equal(listed.chats[0].id, chat.id); assert.equal(listed.chats[0].status, "ready");
    assert.ok(!JSON.stringify(chat).includes("accessHash")); assert.ok(!JSON.stringify(chat).includes("checkout"));
  } finally { await app.close(); }
});

test("in-flight follow-ups retain immutable snapshots and coalesce into one next investigation", async () => {
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  const inputs: unknown[] = [];
  const app = await harness(async (input) => { inputs.push(structuredClone(input)); if (inputs.length === 1) await barrier; return fixture(input); });
  try {
    let { chat } = await (await app.post("/api/chats", { message: "https://example.com", requestId: "inflight-initial" })).json();
    const first = chat.runs[0].id;
    ({ chat } = await (await app.post(`/api/chats/${chat.id}/messages`, { message: "Also https://example.org/docs", revision: chat.revision, requestId: "inflight-second" })).json());
    ({ chat } = await (await app.post(`/api/chats/${chat.id}/messages`, { message: "Also https://example.net/api", revision: chat.revision, requestId: "inflight-third" })).json());
    assert.equal(chat.runs.length, 1); assert.deepEqual(app.store.getOrder(first)!.submission.links, ["https://example.com/"]);
    assert.equal(chat.submission.links.length, 3);
    release(); await app.queue.idle();
    ({ chat } = await (await app.request(`/api/chats/${chat.id}`)).json());
    await app.queue.idle();
    ({ chat } = await (await app.request(`/api/chats/${chat.id}`)).json());
    assert.equal(chat.runs.length, 2); assert.equal(inputs.length, 2);
    assert.equal(app.store.getOrder(chat.runs[1].id)!.submission.links.length, 3);
    assert.equal(chat.runs[1].afterMessageId, chat.messages.filter((item: { role: string }) => item.role === "user").at(-1).id);
  } finally { release(); await app.close(); }
});

test("persisted request IDs deduplicate concurrent create/message retries and reject stale revisions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mydevsaid-personal-")), filename = join(directory, "test.sqlite");
  let app = await harness(fixture, true, filename);
  try {
    const initial = { message: "https://example.com", requestId: "durable-create" };
    const responses = await Promise.all([app.post("/api/chats", initial), app.post("/api/chats", initial)]);
    const created = await Promise.all(responses.map((response) => response.json()));
    assert.equal(created[0].chat.id, created[1].chat.id); assert.equal(app.store.orders().length, 1);
    let chat = created[0].chat;
    const followup = { message: "What does the website show?", revision: chat.revision, requestId: "durable-message" };
    await app.queue.idle();
    assert.equal((await app.post(`/api/chats/${chat.id}/messages`, followup)).status, 200);
    await app.close(); app = await harness(fixture, true, filename);
    ({ chat } = await (await app.post("/api/chats", initial)).json());
    assert.equal(chat.runs.length, 1); assert.equal(chat.status, "ready");
    assert.equal((await app.post(`/api/chats/${chat.id}/messages`, followup)).status, 200);
    assert.equal((await app.post(`/api/chats/${chat.id}/messages`, { ...followup, requestId: "stale-message" })).status, 409);
    assert.equal((await app.post("/api/chats", { ...initial, message: "https://different.test" })).status, 409);
    ({ chat } = await (await app.request(`/api/chats/${chat.id}`)).json());
    assert.equal(chat.messages.filter((item: { role: string }) => item.role === "user").length, 2);
    assert.equal(app.store.orders().length, 1);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test("failed personal runs retry their original order once, without touching legacy orders", async () => {
  let calls = 0;
  const app = await harness(async (input) => { if (++calls === 1) throw new Error("provider-secret"); return fixture(input); });
  try {
    let { chat } = await (await app.post("/api/chats", { message: "https://example.com", requestId: "failed-create" })).json();
    await app.queue.idle();
    ({ chat } = await (await app.request(`/api/chats/${chat.id}`)).json());
    assert.equal(chat.status, "failed"); assert.ok(!JSON.stringify(chat).includes("provider-secret"));
    const orderId = chat.runs[0].id, retry = { revision: chat.revision, requestId: "failed-retry" };
    assert.equal((await app.post(`/api/chats/${chat.id}/retry`, retry)).status, 200);
    assert.equal((await app.post(`/api/chats/${chat.id}/retry`, retry)).status, 200);
    await app.queue.idle();
    ({ chat } = await (await app.request(`/api/chats/${chat.id}`)).json());
    assert.equal(chat.status, "ready"); assert.equal(chat.runs.length, 1); assert.equal(chat.runs[0].id, orderId); assert.equal(calls, 2);
    const legacy = app.store.createOrder({ links: ["https://example.org"] }, false).order;
    assert.equal((await app.post(`/api/chats/${legacy.id}/retry`, { revision: 1, requestId: "legacy-retry" })).status, 404);
    assert.equal(app.store.getOrder(legacy.id)!.payment, "pending");
  } finally { await app.close(); }
});

test("missing network clarification stays in chat without rerunning a website report", async () => {
  const app = await harness();
  try {
    let { chat } = await (await app.post("/api/chats", { message: "https://example.com", requestId: "clarify-create" })).json();
    await app.queue.idle();
    ({ chat } = await (await app.request(`/api/chats/${chat.id}`)).json());
    assert.equal(chat.questions.length, 1); assert.match(chat.messages.at(-1).content, /GitHub/);
    ({ chat } = await (await app.post(`/api/chats/${chat.id}/messages`, { message: `0x${"1".repeat(40)}`, revision: chat.revision, requestId: "clarify-address" })).json());
    assert.match(chat.messages.at(-1).content, /Which network/); assert.equal(chat.runs.length, 1);
    assert.equal((await app.post(`/api/chats/${chat.id}/messages`, { message: "x".repeat(20_001), revision: chat.revision, requestId: "oversize-message" })).status, 400);
    ({ chat } = await (await app.post(`/api/chats/${chat.id}/messages`, { message: "Base", revision: chat.revision, requestId: "clarify-network" })).json());
    assert.equal(chat.submission.token.chainId, 8453); assert.equal(chat.runs.length, 2);
  } finally { await app.close(); }
});

test("interrupted personal jobs recover on restart and remain retryable with saved conversation inputs", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mydevsaid-restart-")), filename = join(directory, "test.sqlite");
  let app = await harness(fixture, true, filename);
  try {
    const { chat } = await (await app.post("/api/chats", { message: "https://example.com", requestId: "restart-create" })).json();
    await app.queue.idle();
    const order = app.store.getOrder(chat.runs[0].id)!;
    order.status = "running"; order.reportId = null; app.store.saveOrder(order);
    await app.close(); app = await harness(fixture, true, filename);
    const restored = (await (await app.request(`/api/chats/${chat.id}`)).json()).chat;
    assert.equal(restored.status, "failed"); assert.deepEqual(restored.submission.links, ["https://example.com/"]);
    assert.equal((await app.post(`/api/chats/${chat.id}/retry`, { runId: "wrong-order", revision: restored.revision, requestId: "wrong-retry" })).status, 409);
    assert.equal((await app.post(`/api/chats/${chat.id}/retry`, { runId: order.id, revision: restored.revision, requestId: "restart-retry" })).status, 200);
    await app.queue.idle();
    const completed = (await (await app.request(`/api/chats/${chat.id}`)).json()).chat;
    assert.equal(completed.status, "ready"); assert.equal(completed.runs[0].id, order.id);
  } finally { await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test("an unresolved token network does not block saved API or source answers", async () => {
  let runs = 0;
  const app = await harness(async (input) => {
    runs++;
    const result = await fixture(input);
    result.investigation.findings.push({ ...result.investigation.findings[0]!, id: "api-source-observed",
      claim: "The website mentions API documentation and source code", explanation: "The captured page describes an API and source repository, whose behavior remains unchecked." });
    return result;
  });
  try {
    let { chat } = await (await app.post("/api/chats", { message: `https://example.com 0x${"1".repeat(40)}`, requestId: "unresolved-create" })).json();
    await app.queue.idle();
    ({ chat } = await (await app.request(`/api/chats/${chat.id}`)).json());
    assert.equal(chat.submission.token, undefined); assert.match(chat.questions[0], /Which network/);
    for (const [index, message] of ["What did you find about the API?", "Explain the source code findings"].entries()) {
      ({ chat } = await (await app.post(`/api/chats/${chat.id}/messages`, { message, revision: chat.revision, requestId: `unresolved-answer-${index}` })).json());
      const reply = chat.messages.at(-1);
      assert.match(reply.content, /captured page describes an API and source repository/);
      assert.equal((reply.content.match(/Which network/g) ?? []).length, 1);
      assert.ok(reply.evidenceIds.length); assert.equal(reply.reportId, chat.runs[0].reportId);
      assert.equal(runs, 1); assert.equal(chat.runs.length, 1); assert.equal(chat.submission.token, undefined);
    }
    ({ chat } = await (await app.post(`/api/chats/${chat.id}/messages`, { message: `0x${"1".repeat(40)}`, revision: chat.revision, requestId: "unresolved-repeat-address" })).json());
    assert.match(chat.messages.at(-1).content, /Which network/);
    assert.equal(chat.messages.at(-1).reportId, undefined); assert.equal(runs, 1);
  } finally { await app.close(); }
});

test("a pending update at the per-chat run cap cannot poison other conversations", async () => {
  const app = await harness();
  try {
    const { chat } = await (await app.post("/api/chats", { message: "Check a project", requestId: "capped-create" })).json();
    const raw = JSON.parse(String(app.store.db.prepare("SELECT body FROM personal_chats WHERE id=?").get(chat.id)!.body));
    for (let index = 0; index < 50; index++) {
      const order = app.store.createOrder({ links: ["https://example.com/"] }, true).order;
      order.status = "failed"; app.store.saveOrder(order);
      raw.runs.push({ id: order.id, afterMessageId: raw.messages[0].id, announced: index < 49 });
    }
    raw.submission.links = ["https://example.org/"]; raw.pendingAfterMessageId = raw.messages[0].id;
    app.store.db.prepare("UPDATE personal_chats SET body=? WHERE id=?").run(JSON.stringify(raw), chat.id);
    let response = await app.request(`/api/chats/${chat.id}`); assert.equal(response.status, 200);
    let current = (await response.json()).chat;
    assert.equal(current.runs.length, 50); assert.notEqual(current.status, "running");
    assert.match(current.messages.at(-1).content, /reached 50 investigations/);
    const saved = JSON.parse(String(app.store.db.prepare("SELECT body FROM personal_chats WHERE id=?").get(chat.id)!.body));
    assert.equal(saved.pendingAfterMessageId, undefined);
    response = await app.request(`/api/chats/${chat.id}`); current = (await response.json()).chat;
    assert.equal(current.messages.filter((item: { content: string }) => item.content.includes("reached 50 investigations")).length, 1);
    assert.equal((await app.request("/api/chats")).status, 200);
    assert.equal((await app.post(`/api/chats/${chat.id}/messages`, { message: "https://example.net", revision: current.revision, requestId: "cap-new-input" })).status, 429);
    response = await app.post("/api/chats", { message: "https://example.net", requestId: "cap-other-create" });
    assert.equal(response.status, 201); await app.queue.idle();
    const other = (await response.json()).chat;
    assert.equal((await (await app.request(`/api/chats/${other.id}`)).json()).chat.status, "ready");
  } finally { await app.close(); }
});

test("a full global queue leaves pending updates recoverable while chats remain readable", async () => {
  const app = await harness();
  try {
    const { chat } = await (await app.post("/api/chats", { message: "Check a project", requestId: "full-queue-chat" })).json();
    await app.queue.stop(); // Hold capacity fixed while testing the persisted scheduling boundary.
    const raw = JSON.parse(String(app.store.db.prepare("SELECT body FROM personal_chats WHERE id=?").get(chat.id)!.body));
    const prior = app.store.createOrder({ links: ["https://example.com/"] }, true).order;
    prior.status = "failed"; app.store.saveOrder(prior);
    raw.runs.push({ id: prior.id, afterMessageId: raw.messages[0].id, announced: true });
    raw.submission.links = ["https://example.org/"]; raw.pendingAfterMessageId = raw.messages[0].id;
    app.store.db.prepare("UPDATE personal_chats SET body=? WHERE id=?").run(JSON.stringify(raw), chat.id);
    const occupied = Array.from({ length: 100 }, () => app.store.createOrder({ links: ["https://example.net/"] }, true).order);
    assert.equal((await app.request("/api/chats")).status, 200);
    let current = (await (await app.request(`/api/chats/${chat.id}`)).json()).chat;
    assert.equal(current.status, "running"); assert.equal(current.runs.length, 1);
    assert.equal((await app.post("/api/chats", { message: "https://example.net", requestId: "full-new-input" })).status, 429);
    const other = await app.post("/api/chats", { message: "I will add a link later", requestId: "full-other-chat" });
    assert.equal(other.status, 201);
    assert.equal((await app.request(`/api/chats/${(await other.json()).chat.id}`)).status, 200);
    occupied[0]!.status = "failed"; app.store.saveOrder(occupied[0]!);
    current = (await (await app.request(`/api/chats/${chat.id}`)).json()).chat;
    assert.equal(current.runs.length, 2); assert.equal(current.runs[1].status, "queued");
    assert.deepEqual(app.store.getOrder(current.runs[1].id)!.submission.links, ["https://example.org/"]);
    const saved = JSON.parse(String(app.store.db.prepare("SELECT body FROM personal_chats WHERE id=?").get(chat.id)!.body));
    assert.equal(saved.pendingAfterMessageId, undefined);
    assert.equal((await (await app.request(`/api/chats/${chat.id}`)).json()).chat.runs.length, 2);
  } finally { await app.close(); }
});
