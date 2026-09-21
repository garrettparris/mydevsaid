import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { discoverWebsite } from "./discovery.ts";
import type { AnalysisResult, InvestigationProgress, LiveReport } from "./engine.ts";
import type { Investigator } from "./jobs.ts";
import { buildPresentation } from "./report-model.ts";
import { createApp } from "./server.ts";
import { Store } from "./store.ts";

const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
};
async function fixture(input: unknown): Promise<AnalysisResult> {
  const discovery = await discoverWebsite(input, {}, async (url) => ({ requestedUrl: url, finalUrl: url, status: 200,
    contentType: "text/html", body: Buffer.from(`<title>Example</title><p>RAW_CAPTURE_${"x".repeat(12_000)}</p>`),
    capturedAt: new Date().toISOString(), redirects: [] }));
  const investigation = discovery.investigation;
  investigation.checks = investigation.checks.map((check) => check.area === "web_presence" ? { ...check, status: "completed" }
    : { ...check, status: "blocked", reason: "Fixture has no provider access" });
  return { investigation, discovery, presentation: buildPresentation(investigation), analysisMode: "deterministic",
    generatedAt: new Date().toISOString(), summary: { explanation: "Website captured", keyFindings: [], limitations: [] } };
}
function snapshot(result: AnalysisResult): LiveReport {
  return { updatedAt: result.generatedAt, presentation: result.presentation!, findings: [],
    checks: result.investigation.checks.map((check) => check.area === "web_presence" ? check : { ...check, status: "running" }),
    sources: result.investigation.evidence.map(({ id, sourceUrl, medium, role, capturedAt }) => ({ id, sourceUrl, medium, role, capturedAt })) };
}
async function harness(investigate: Investigator = fixture, filename = ":memory:", localMode = true) {
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

test("compact delivery exposes partials before completion, skips unchanged snapshots and loads full reports separately", async () => {
  const ready = gate(), finish = gate();
  let progress!: InvestigationProgress, live!: LiveReport;
  const app = await harness(async (input, callback) => {
    const result = await fixture(input); live = snapshot(result); progress = callback!;
    progress("Website captured", live); ready.release(); await finish.promise; return result;
  });
  try {
    const created = await app.post("/api/chats?compact=1", { message: "https://example.com", requestId: "stream-create" });
    assert.equal(created.status, 201);
    const { chat: initial } = await created.json(); await ready.promise;
    const path = `/api/chats/${initial.id}`, runId = initial.runs[0].id;
    let { chat } = await (await app.request(`${path}?compact=1`)).json();
    assert.equal(chat.status, "running"); assert.equal(chat.runs[0].result, undefined);
    assert.deepEqual(chat.runs[0].live, live);
    assert.ok(chat.runs[0].live.checks.some((check: { status: string }) => check.status === "running"));
    assert.ok(chat.runs[0].live.sources.every((source: object) => !Object.hasOwn(source, "content")));
    assert.equal((await app.request(`${path}/runs/${runId}`)).status, 409);
    assert.equal(app.store.getOrder(runId)!.reportId, null);
    const version = chat.runs[0].liveVersion;
    const originalLive = app.store.getLiveReport;
    app.store.getLiveReport = () => { throw new Error("Unchanged live payload should not be read"); };
    try {
      ({ chat } = await (await app.request(`${path}?compact=1&live=${runId}:${version}`)).json());
      assert.equal(chat.runs[0].liveVersion, version); assert.ok(!Object.hasOwn(chat.runs[0], "live"));
    } finally { app.store.getLiveReport = originalLive; }
    progress("More sources captured", { ...live, updatedAt: "2026-09-15T15:00:00.000Z" });
    ({ chat } = await (await app.request(`${path}?compact=1&live=${runId}:${version}`)).json());
    assert.ok(chat.runs[0].liveVersion > version); assert.equal(chat.runs[0].live.updatedAt, "2026-09-15T15:00:00.000Z");
    finish.release(); await app.queue.idle();
    const compactResponse = await app.request(`${path}?compact=1`), compactText = await compactResponse.text();
    ({ chat } = JSON.parse(compactText));
    assert.equal(chat.status, "ready"); assert.equal(chat.runs[0].status, "completed");
    assert.equal(chat.runs[0].live, null); assert.equal(chat.runs[0].result, undefined);
    assert.ok(chat.runs[0].summary.sources > 0); assert.ok(chat.runs[0].summary.generatedAt);
    assert.equal(app.store.getLiveReport(runId), undefined);
    const full = await (await app.request(`${path}/runs/${runId}`)).json();
    assert.equal(full.reportId, chat.runs[0].reportId); assert.equal(full.runId, runId);
    assert.ok(full.result.investigation.evidence.some((source: { content: string }) => source.content.includes("RAW_CAPTURE_")));
    assert.ok(compactText.length < JSON.stringify(full).length / 2);
    const legacy = await (await app.request(path)).json(); assert.deepEqual(legacy.chat.runs[0].result, full.result);
    const before = app.store.getOrder(runId); progress("Late callback", live);
    assert.deepEqual(app.store.getOrder(runId), before); assert.equal(app.store.getLiveReport(runId), undefined);
    const originalReport = app.store.getReport;
    app.store.getReport = () => { throw new Error("Compact polls and history must not read full report bodies"); };
    try {
      assert.equal((await app.request(`${path}?compact=1`)).status, 200);
      assert.equal((await app.request("/api/chats")).status, 200);
    } finally { app.store.getReport = originalReport; }
    const other = await (await app.post("/api/chats?compact=1", { message: "I need help", requestId: "stream-other" })).json();
    assert.equal((await app.request(`/api/chats/${other.chat.id}/runs/${runId}`)).status, 404);
    assert.equal((await app.request(`/api/reports/${full.reportId}`)).status, 404);
  } finally { finish.release(); await app.close(); }
});

test("failed partials survive reopening and retry versions reject late callbacks from the previous attempt", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mydevsaid-live-")), filename = join(directory, "test.sqlite");
  let oldProgress!: InvestigationProgress, newProgress!: InvestigationProgress, live!: LiveReport;
  const started = gate(), finish = gate();
  let app = await harness(async (input, callback) => {
    live = snapshot(await fixture(input)); oldProgress = callback!; oldProgress("Captured before failure", live); throw new Error("Provider failed");
  }, filename);
  try {
    const { chat: initial } = await (await app.post("/api/chats?compact=1", { message: "https://example.com", requestId: "failure-create" })).json();
    await app.queue.idle();
    const path = `/api/chats/${initial.id}`, runId = initial.runs[0].id;
    let { chat } = await (await app.request(`${path}?compact=1`)).json();
    assert.equal(chat.status, "failed"); assert.deepEqual(chat.runs[0].live, live);
    const oldVersion = chat.runs[0].liveVersion;
    await app.close();
    app = await harness(async (input, callback) => {
      newProgress = callback!; started.release(); await finish.promise; return fixture(input);
    }, filename);
    ({ chat } = await (await app.request(`${path}?compact=1`)).json());
    assert.equal(chat.runs[0].liveVersion, oldVersion); assert.deepEqual(chat.runs[0].live, live);
    ({ chat } = await (await app.post(`${path}/retry?compact=1`, { revision: chat.revision, runId, requestId: "failure-retry" })).json());
    await started.promise;
    assert.equal(chat.status, "running"); assert.ok(chat.runs[0].liveVersion > oldVersion); assert.equal(chat.runs[0].live, null);
    oldProgress("Stale callback must not touch a closed store", live);
    assert.equal(app.store.getLiveReport(runId), undefined);
    ({ chat } = await (await app.request(`${path}?compact=1&live=${runId}:${oldVersion}`)).json());
    assert.equal(chat.runs[0].live, null);
    newProgress("Fresh attempt", live);
    ({ chat } = await (await app.request(`${path}?compact=1&live=${runId}:${oldVersion}`)).json());
    assert.ok(chat.runs[0].liveVersion > oldVersion + 1); assert.deepEqual(chat.runs[0].live, live);
    finish.release(); await app.queue.idle();
    assert.equal(app.store.getLiveReport(runId), undefined);
  } finally { finish.release(); await app.close(); await rm(directory, { recursive: true, force: true }); }
});

test("legacy summaries are cached once and compact follow-up retries keep citation and request identity", async () => {
  const app = await harness();
  try {
    const { chat: initial } = await (await app.post("/api/chats", { message: "https://example.com", requestId: "legacy-create" })).json();
    await app.queue.idle();
    const path = `/api/chats/${initial.id}`, runId = initial.runs[0].id;
    await app.request(path);
    const order = app.store.getOrder(runId)!; delete order.reportSummary; app.store.saveOrder(order);
    let reads = 0; const original = app.store.getReport;
    app.store.getReport = (id) => { reads++; return original.call(app.store, id); };
    let { chat } = await (await app.request(`${path}?compact=1`)).json();
    assert.equal(reads, 1); assert.ok(chat.runs[0].summary);
    await app.request(`${path}?compact=1`); await app.request("/api/chats"); assert.equal(reads, 1);
    const message = { message: "What evidence did you collect?", revision: chat.revision, requestId: "compact-followup" };
    ({ chat } = await (await app.post(`${path}/messages?compact=1`, message)).json());
    assert.equal(chat.runs[0].result, undefined); assert.equal(chat.runs.length, 1);
    assert.equal(chat.messages.at(-1).reportId, order.reportId);
    const retried = await (await app.post(`${path}/messages`, message)).json();
    assert.equal(retried.chat.messages.length, chat.messages.length); assert.ok(retried.chat.runs[0].result);
    assert.equal(app.store.orders().length, 1);
  } finally { await app.close(); }
});

test("live and full report endpoints retain local access, method and query bounds", async () => {
  const app = await harness();
  try {
    const { chat } = await (await app.post("/api/chats", { message: "https://example.com", requestId: "guard-create" })).json();
    await app.queue.idle();
    const path = `/api/chats/${chat.id}`, reportPath = `${path}/runs/${chat.runs[0].id}`;
    assert.equal((await app.request(reportPath, { method: "POST", headers: { Origin: "https://attacker.test" } })).status, 403);
    const crossOriginRead = await app.request(reportPath, { headers: { Origin: "https://attacker.test" } });
    assert.equal(crossOriginRead.headers.get("access-control-allow-origin"), null);
    assert.equal((await app.post(reportPath, {})).status, 405);
    for (const live of ["bad", "run:-1", "run:1.5", Array.from({ length: 51 }, (_, i) => `run-${i}:1`).join(","), `run:${"9".repeat(4096)}`]) {
      assert.equal((await app.request(`${path}?compact=1&live=${encodeURIComponent(live)}`)).status, 400);
    }
  } finally { await app.close(); }
  const production = await harness(fixture, ":memory:", false);
  try { assert.equal((await production.request("/api/chats/any/runs/any")).status, 404); }
  finally { await production.close(); }
});
