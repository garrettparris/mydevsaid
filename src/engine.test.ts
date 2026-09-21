import test from "node:test";
import assert from "node:assert/strict";
import { createInvestigation, captureEvidence } from "./investigation.ts";
import { runInvestigation } from "./engine.ts";
import { buildPresentation } from "./report-model.ts";
import { validateNarration } from "./pi-runner.ts";
import type { discoverWebsite } from "./discovery.ts";
import type { CollectionResult } from "./collectors.ts";

const subject = { links: ["https://example.com/"], token: { chainId: 1, address: `0x${"1".repeat(40)}` } };
function fixture() {
  const investigation = createInvestigation(subject);
  const observation = captureEvidence({ id: "web-observation", role: "observation", medium: "website", sourceUrl: subject.links[0]!,
    capturedAt: new Date().toISOString(), content: "Page has a documentation link", method: "Fixture extraction", toolVersion: "test/1" });
  const discovery: Awaited<ReturnType<typeof discoverWebsite>> = {
    investigation, pages: [], failures: [], budget: { maxPages: 3, attemptedPages: 0, remainingUrls: [] }, limitations: ["Static HTML only"],
  };
  const collected: CollectionResult = {
    evidence: [observation], limitations: ["Domain registration unavailable"],
    checks: [{ area: "web_presence", status: "completed", evidenceIds: [observation.id] }],
    findings: [{ id: "docs", area: "web_presence", claim: "A documentation link is present", status: "supported", severity: "informational",
      explanation: "The captured page has a documentation link.", impact: "Readers can locate the docs.", claimEvidenceIds: [], supportingEvidenceIds: [observation.id], contradictingEvidenceIds: [], limitations: ["The documentation has not been verified"] }],
  };
  const narration = { explanation: { text: "The website links to documentation.", evidenceIds: [observation.id] },
    keyFindings: [{ text: "Documentation was linked.", evidenceIds: [observation.id] }], limitations: ["We did not verify implementation"] };
  return { discovery, collected, narration };
}

test("engine preserves collected evidence and makes unfinished coverage explicit", async () => {
  const { discovery, collected } = fixture();
  const progress: string[] = [];
  const result = await runInvestigation(subject, (message) => progress.push(message), {
    discover: async () => discovery, collect: async () => collected, modelEnabled: false,
  });
  assert.equal(result.analysisMode, "deterministic");
  assert.equal(result.investigation.checks.filter((check) => check.status === "blocked").length, 5);
  assert.deepEqual(result.investigation.evidence, collected.evidence);
  assert.ok(result.summary.limitations.includes("Domain registration unavailable"));
  assert.ok(progress.length >= 3);
});

test("Pi narration cannot erase coverage gaps or alter verification results", async () => {
  const { discovery, collected, narration } = fixture();
  const result = await runInvestigation(subject, undefined, { discover: async () => discovery, collect: async () => collected,
    modelEnabled: true, narrate: async () => narration });
  assert.equal(result.analysisMode, "pi");
  assert.deepEqual(result.investigation.findings, collected.findings);
  assert.ok(result.summary.limitations.includes("Domain registration unavailable"));
  assert.deepEqual(result.narration, narration);
});

test("invented Pi citations fall back to the preserved collector report", async () => {
  const { discovery, collected, narration } = fixture();
  narration.explanation.evidenceIds = ["invented"];
  const result = await runInvestigation(subject, undefined, { discover: async () => discovery, collect: async () => collected,
    modelEnabled: true, narrate: async () => narration });
  assert.equal(result.analysisMode, "deterministic");
  assert.equal(result.narration, undefined);
  assert.match(result.summary.limitations.join(" "), /failed validation/);
});

test("model output cannot smuggle new finding statuses into narration", () => {
  const { discovery, narration } = fixture();
  assert.throws(() => validateNarration({ ...narration, status: "safe" }, discovery.investigation));
});

test("collector evidence integrity errors fail the job before narration", async () => {
  const { discovery, collected } = fixture();
  collected.evidence[0]!.content = "Tampered payload";
  let called = false;
  await assert.rejects(runInvestigation(subject, undefined, { discover: async () => discovery, collect: async () => collected,
    modelEnabled: true, narrate: async () => { called = true; throw new Error("should not run"); } }));
  assert.equal(called, false);
});

test("invalid submission does not invoke network collectors", async () => {
  await assert.rejects(runInvestigation({ links: ["file:///etc/passwd"] }, undefined, {
    discover: async () => { assert.fail("must not fetch invalid input"); },
  }));
});


test("engine adds a categorized fallback and replaces it only with validated Pi presentation", async () => {
  const { discovery, collected, narration } = fixture();
  const evidenceInvestigation = { ...discovery.investigation, evidence: collected.evidence };
  const presentation = { ...buildPresentation(evidenceInvestigation), mode: "pi" as const };
  const result = await runInvestigation(subject, undefined, { discover: async () => discovery, collect: async () => collected,
    modelEnabled: true, narrate: async () => ({ ...narration, presentation }) });
  assert.equal(result.presentation?.mode, "pi");
  assert.equal(result.presentation.sections.length, 7);
  presentation.overview = { text: "Unsupported relationship", basis: "observation", evidenceIds: ["web-observation"] };
  const fallback = await runInvestigation(subject, undefined, { discover: async () => discovery, collect: async () => collected,
    modelEnabled: true, narrate: async () => ({ ...narration, presentation }) });
  assert.equal(fallback.analysisMode, "deterministic");
  assert.equal(fallback.presentation?.mode, "deterministic");
  assert.match(fallback.summary.limitations.join(" "), /failed validation/);
});


test("live reports arrive before collection finishes and omit raw evidence bodies", async () => {
  const { discovery, collected } = fixture();
  const snapshots: import("./engine.ts").LiveReport[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let emitted!: () => void;
  const emission = new Promise<void>(resolve => { emitted = resolve; });
  let finished = false;
  const task = runInvestigation(subject, (_message, live) => { if (live) snapshots.push(live); }, {
    discover: async () => discovery, modelEnabled: false,
    collect: async (_input, _discovery, _progress, options) => {
      options?.onPartial?.(collected); emitted(); await gate; return collected;
    },
  }).then(result => { finished = true; return result; });
  try {
    await emission; assert.equal(finished, false); assert.equal(snapshots.length, 1);
    const snapshot = snapshots[0]!;
    assert.equal(snapshot.sources[0]!.id, collected.evidence[0]!.id);
    assert.equal("content" in snapshot.sources[0]!, false);
    assert.equal(snapshot.findings[0]!.id, "docs");
    assert.equal(snapshot.checks.find(check => check.area === "web_presence")!.status, "completed");
    assert.ok(snapshot.checks.some(check => ["pending", "running"].includes(check.status)));
    assert.equal(snapshot.presentation.mode, "deterministic");
  } finally { release(); }
  assert.equal((await task).investigation.checks.filter(check => check.status === "blocked").length, 5);
});
