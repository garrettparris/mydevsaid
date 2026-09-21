import test from "node:test";
import assert from "node:assert/strict";
import { captureEvidence, createInvestigation } from "./investigation.ts";
import { Store } from "./store.ts";
import { compareInvestigations, startMonitoring } from "./monitor.ts";
import type { AnalysisResult } from "./engine.ts";

function baseline(store: Store) {
  const subject = { links: ["https://example.com/"], token: { chainId: 1, address: `0x${"1".repeat(40)}` } };
  const investigation = createInvestigation(subject);
  investigation.evidence = [captureEvidence({ id: "site", role: "observation", medium: "website", sourceUrl: subject.links[0]!,
    capturedAt: new Date().toISOString(), content: JSON.stringify({ pages: [{ links: [{ url: "https://example.com/docs" }] }] }), method: "Extract links", toolVersion: "test/1" })];
  investigation.checks = investigation.checks.map((check) => ({ ...check, status: "blocked", reason: "Outside test coverage" }));
  investigation.checks[0] = { area: "web_presence", status: "completed", evidenceIds: ["site"] };
  investigation.findings = [{ id: "links", area: "web_presence", claim: "Page contains a docs link", status: "supported", severity: "informational",
    explanation: "Docs link observed", impact: "Docs can be located", claimEvidenceIds: [], supportingEvidenceIds: ["site"], contradictingEvidenceIds: [], limitations: ["Content not verified"] }];
  const result: AnalysisResult = { investigation, analysisMode: "deterministic", generatedAt: new Date().toISOString(), summary: { explanation: "Fixture", keyFindings: [], limitations: ["Fixture"] },
    discovery: { investigation: createInvestigation(subject), pages: [], failures: [], budget: { maxPages: 3, attemptedPages: 0, remainingUrls: [] }, limitations: [] } };
  const { order } = store.createOrder(subject, true); order.status = "running"; store.saveOrder(order);
  return store.publish(store.saveResult(order.id, result).id);
}

test("monitor schedule survives restart and never accumulates unreviewed drafts", () => {
  const store = new Store(":memory:"); const report = baseline(store); let time = 0, kicks = 0;
  let monitor = startMonitoring(store, { kick: () => { kicks++; } }, [report.id], 1, () => time);
  try {
    monitor.tick(); assert.equal(kicks, 0);
    time = 3_600_000; monitor.tick(); monitor.tick(); assert.equal(kicks, 1);
    const order = store.orders().at(-1)!; assert.equal(order.status, "queued"); assert.equal(order.payment, "local_preview");
    monitor.stop(); monitor = startMonitoring(store, { kick: () => { kicks++; } }, [report.id], 1, () => time);
    time += 7_200_000; monitor.tick(); assert.equal(kicks, 1);
    order.status = "failed"; store.saveOrder(order); monitor.tick(); assert.equal(kicks, 2);
    assert.equal(store.getReport(report.id)!.publishedAt, report.publishedAt);
  } finally { monitor.stop(); store.close(); }
});

test("monitor requires a published baseline and bounded frequency", () => {
  const store = new Store(":memory:");
  try {
    assert.throws(() => startMonitoring(store, { kick() {} }, ["missing"], 24), /published/);
    assert.throws(() => startMonitoring(store, { kick() {} }, [], 0), /interval/);
  } finally { store.close(); }
});

test("comparison ignores fresh capture times and reports changed links", () => {
  const store = new Store(":memory:");
  try {
    const report = baseline(store), next = structuredClone(report.result.investigation);
    next.createdAt = new Date().toISOString(); next.evidence[0]!.capturedAt = next.createdAt;
    assert.deepEqual(compareInvestigations(report.result.investigation, next), []);
    next.evidence[0]!.content = JSON.stringify({ pages: [{ links: [{ url: "https://example.com/new-docs" }] }] });
    const changes = compareInvestigations(report.result.investigation, next);
    assert.equal(changes.length, 1); assert.match(changes[0]!.after, /new-docs/);
    next.subject.token!.chainId = 8453;
    assert.throws(() => compareInvestigations(report.result.investigation, next), /different tokens/);
  } finally { store.close(); }
});

test("new report versions compare against published baseline without overwriting it", () => {
  const store = new Store(":memory:");
  try {
    const original = baseline(store), next = structuredClone(original.result);
    const { order } = store.createOrder(next.investigation.subject, true); order.status = "running"; store.saveOrder(order);
    const revision = store.saveResult(order.id, next);
    assert.equal(revision.version, 2); assert.equal(revision.changes?.previousReportId, original.id);
    assert.deepEqual(store.getReport(original.id), original); assert.equal(revision.publishedAt, null);
  } finally { store.close(); }
});
