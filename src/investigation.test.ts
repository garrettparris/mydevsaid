import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import {
  assessReadiness, captureEvidence, CHECKS, createInvestigation,
  investigationSchema, submissionSchema, type Investigation,
} from "./investigation.ts";

const token = { chainId: 1, address: `0x${"aB".repeat(20)}` };
const observedAt = "2026-01-01T00:00:00.000Z";

test("domain lookup scope is explicit and legacy submissions retain exact-host behavior", () => {
  const legacy = { links: ["https://docs.example.com/"], token };
  const subject = createInvestigation(legacy).subject;
  assert.equal(subject.domainLookup ?? "exact_host", "exact_host");
  assert.ok(!Object.hasOwn(subject, "domainLookup"));
  for (const domainLookup of ["exact_host", "registrable_domain"] as const) {
    assert.equal(createInvestigation({ ...legacy, domainLookup }).subject.domainLookup, domainLookup);
  }
  for (const domainLookup of ["parent", "all_domains", "", null, true, 1]) {
    assert.equal(submissionSchema.safeParse({ ...legacy, domainLookup }).success, false);
  }
});

function observation() {
  return captureEvidence({
    id: "docs-response", role: "observation", medium: "website",
    sourceUrl: "https://example.com/docs", capturedAt: observedAt,
    method: "GET /docs; record status and body", toolVersion: "fixture/1",
    content: '{"status":200,"body":"Protocol documentation"}',
  });
}

// Synthetic data proves validation behavior, not any real project's legitimacy.
function reviewableReport(): Investigation {
  const report = createInvestigation({ links: ["https://example.com"], token });
  report.evidence.push(observation());
  report.checks = report.checks.map((check) => check.area === "web_presence"
    ? { ...check, status: "completed", evidenceIds: ["docs-response"] }
    : { ...check, status: "blocked", reason: "Collector is not implemented in this fixture" });
  report.findings.push({
    id: "docs-exist", area: "web_presence", claim: "Documentation is accessible",
    status: "supported", severity: "informational", explanation: "The recorded request returned a documentation page",
    impact: "Readers can inspect the published explanation",
    claimEvidenceIds: [], supportingEvidenceIds: ["docs-response"], contradictingEvidenceIds: [],
    limitations: ["Availability alone does not establish that the explanation is accurate"],
  });
  return report;
}

function expectInvalid(report: unknown, message: RegExp) {
  const result = assessReadiness(report);
  assert.equal(result.readyForReview, false);
  assert.match(result.issues.join("\n"), message);
}

test("intake normalizes URLs and addresses without losing chain identity", () => {
  const first = createInvestigation({ links: ["https://EXAMPLE.com", "https://example.com/"], token });
  const second = createInvestigation({ links: ["https://example.com"], token: { ...token, chainId: 8453 } });
  assert.deepEqual(first.subject.links, ["https://example.com/"]);
  assert.equal(first.subject.token?.address, token.address.toLowerCase());
  assert.notDeepEqual(first.subject.token, second.subject.token);
  assert.notEqual(first.id, second.id);
});

test("intake accepts links before a token has been resolved", () => {
  const report = createInvestigation({ links: ["https://example.com"] });
  assert.equal(report.subject.token, undefined);
  assert.deepEqual(report.checks.map((check) => check.area), Object.keys(CHECKS));
  assert.ok(report.checks.every((check) => check.status === "pending"));
  expectInvalid(report, /Resolve the chain/);
});

test("intake rejects malformed links, credentials, identities, and unexpected fields", () => {
  for (const input of [
    { links: [] }, { links: ["not-a-url"] }, { links: ["https://["] },
    { links: ["file:///etc/passwd"] }, { links: ["javascript:alert(1)"] },
    { links: ["https://user:secret@example.com"] },
    { links: ["https://example.com"], token: { ...token, chainId: -1 } },
    { links: ["https://example.com"], token: { ...token, chainId: 1.5 } },
    { links: ["https://example.com"], token: { ...token, chainId: Number.MAX_SAFE_INTEGER + 1 } },
    { links: ["https://example.com"], token: { ...token, address: "0x1234" } },
    { links: ["https://example.com"], token: { ...token, address: `0x${"0".repeat(40)}` } },
    { links: ["https://example.com"], publish: true },
  ]) assert.equal(submissionSchema.safeParse(input).success, false);
});

test("related-contract collection is explicit and restricted to the reviewed budget", () => {
  const legacy = { links: ["https://example.com/"], token };
  const parsed = submissionSchema.parse(legacy);
  assert.equal(parsed.relatedContractLimit, undefined);
  assert.equal(parsed.relatedContractLimit ?? 0, 0);
  assert.ok(!Object.hasOwn(createInvestigation(legacy).subject, "relatedContractLimit"));
  for (const relatedContractLimit of [0, 4] as const) {
    assert.equal(createInvestigation({ ...legacy, relatedContractLimit }).subject.relatedContractLimit, relatedContractLimit);
  }
  for (const relatedContractLimit of [-1, 1, 3, 5, 100, 4.5, "4", null, true]) {
    assert.equal(submissionSchema.safeParse({ ...legacy, relatedContractLimit }).success, false);
  }
});

test("a new investigation cannot qualify for review", () => {
  const result = assessReadiness(createInvestigation({ links: ["https://example.com"], token }));
  assert.equal(result.readyForReview, false);
  assert.equal(result.coverage?.unfinished, 6);
});

test("explicit partial coverage can reach review without hiding blocked checks", () => {
  const result = assessReadiness(reviewableReport());
  assert.equal(result.readyForReview, true);
  assert.deepEqual(result.coverage, { completed: 1, blocked: 5, notApplicable: 0, unfinished: 0 });
});

test("tampered captures fail integrity validation", () => {
  const report = reviewableReport();
  report.evidence[0]!.content = "Altered response";
  expectInvalid(report, /does not match its digest/);
});

test("on-chain and activity captures require a pinned block", () => {
  for (const medium of ["onchain", "activity"] as const) {
    const { sha256: _digest, ...capture } = observation();
    assert.throws(() => captureEvidence({ ...capture, medium }), /pinned block/);
    assert.ok(captureEvidence({
      ...capture, medium,
      snapshot: { ...token, blockNumber: "21000000", blockHash: `0x${"ab".repeat(32)}` },
    }).snapshot);
  }
});

test("repository captures require a revision", () => {
  const { sha256: _digest, ...capture } = observation();
  assert.throws(() => captureEvidence({ ...capture, medium: "repository" }), /source revision/);
});

test("future timestamps cannot reach review", () => {
  const report = reviewableReport();
  report.evidence[0]!.capturedAt = "9999-01-01T00:00:00Z";
  expectInvalid(report, /future capture time/);
  report.createdAt = "9999-01-01T00:00:00Z";
  expectInvalid(report, /creation time is in the future/);
  assert.throws(() => assessReadiness(report, new Date("invalid")), /Review time must be valid/);
});

test("duplicate IDs and missing coverage areas are rejected", () => {
  const report = reviewableReport();
  report.evidence.push(observation());
  expectInvalid(report, /Duplicate identifiers/);
  report.evidence.pop();
  report.checks[1] = { ...report.checks[0]! };
  expectInvalid(report, /Duplicate identifiers/);
  report.checks.pop();
  assert.equal(investigationSchema.safeParse(report).success, false);
});

test("invented citations are rejected", () => {
  const report = reviewableReport();
  report.findings[0]!.supportingEvidenceIds = ["invented"];
  expectInvalid(report, /Unknown evidence: invented/);
});

test("project assertions cannot stand in for test observations", () => {
  const report = reviewableReport();
  report.evidence[0]!.role = "claim";
  expectInvalid(report, /assertions cannot substitute/);
});

test("findings must cite evidence assigned to their check", () => {
  const report = reviewableReport();
  report.evidence.push({ ...observation(), id: "unrelated" });
  report.findings[0]!.supportingEvidenceIds = ["unrelated"];
  expectInvalid(report, /associated check/);
});

test("supported and contradicted statuses require appropriate observations", () => {
  for (const status of ["supported", "partially_supported", "contradicted"] as const) {
    const report = reviewableReport();
    report.findings[0]!.status = status;
    report.findings[0]!.supportingEvidenceIds = [];
    expectInvalid(report, /require.*observations/);
  }
});

test("contradictory evidence prevents a fully supported label", () => {
  const report = reviewableReport();
  report.evidence.push({ ...observation(), id: "contradiction" });
  report.checks[0]!.evidenceIds.push("contradiction");
  report.findings[0]!.contradictingEvidenceIds.push("contradiction");
  expectInvalid(report, /reassess its status/);
  report.findings[0]!.status = "partially_supported";
  assert.equal(assessReadiness(report).readyForReview, true);
});

test("an observation cannot support and contradict the same claim", () => {
  const report = reviewableReport();
  report.findings[0]!.status = "partially_supported";
  report.findings[0]!.contradictingEvidenceIds = ["docs-response"];
  expectInvalid(report, /both support and contradict/);
});

test("blocked checks cannot produce assessed findings", () => {
  const report = reviewableReport();
  report.checks[0]!.status = "blocked";
  report.checks[0]!.reason = "Request failed";
  expectInvalid(report, /require a completed check/);
});

test("completed checks require both evidence and findings", () => {
  const report = reviewableReport();
  report.checks[1] = { area: "public_code", status: "completed", evidenceIds: ["docs-response"] };
  expectInvalid(report, /completed check has no finding/);
  report.checks[1].evidenceIds = [];
  expectInvalid(report, /Completed checks require evidence/);
});

test("unverified findings and coverage exceptions preserve visible limitations", () => {
  const report = reviewableReport();
  report.findings.push({
    ...report.findings[0]!, id: "api-unknown", area: "api_behavior", status: "unverified",
    claim: "The API implements advertised behavior", supportingEvidenceIds: [],
    explanation: "No API collector ran", impact: "API behavior is unknown", limitations: ["No live tests"],
  });
  assert.equal(assessReadiness(report).readyForReview, true);
  report.findings[1]!.limitations = [];
  expectInvalid(report, /limitations/);
});

test("blocked and not-applicable checks require explanations", () => {
  for (const status of ["blocked", "not_applicable"] as const) {
    const report = reviewableReport();
    report.checks[1] = { area: "public_code", status, evidenceIds: [] };
    expectInvalid(report, /Coverage gaps require a reason/);
  }
});

test("unknown fields cannot inject a publication flag", () => {
  expectInvalid({ ...reviewableReport(), published: true }, /Unrecognized key/);
});

test("CLI produces a draft and returns a nonzero exit for invalid input", () => {
  const cli = new URL("./investigation.ts", import.meta.url);
  const valid = spawnSync(process.execPath, [cli.pathname, "https://example.com", "1", token.address], { encoding: "utf8" });
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(investigationSchema.parse(JSON.parse(valid.stdout)).checks.length, 6);
  for (const args of [[], ["https://example.com", "1"], ["not-a-url"]]) {
    const invalid = spawnSync(process.execPath, [cli.pathname, ...args], { encoding: "utf8" });
    assert.equal(invalid.status, 1);
    assert.equal(invalid.stdout, "");
    assert.ok(invalid.stderr.length);
  }
});
