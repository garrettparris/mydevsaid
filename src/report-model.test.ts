import test from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { createInvestigation, captureEvidence } from "./investigation.ts";
import { buildPresentation, presentationSchema, validatePresentation, type Presentation } from "./report-model.ts";

function fixture() {
  const investigation = createInvestigation({ links: ["https://example.com/docs"] });
  const claim = captureEvidence({ id: "docs", role: "claim", medium: "documentation", sourceUrl: "https://example.com/docs",
    capturedAt: "2026-09-15T01:00:00Z", method: "Fixture", toolVersion: "test/1",
    content: JSON.stringify({ title: "Juniper", text: "Juniper Juniper is a lending protocol for stablecoins. Users deposit stablecoins into the lending pool. Users receive JUSD receipts for their deposits. A multisig admin can upgrade the lending pool." }) });
  investigation.evidence.push(claim);
  const presentation = buildPresentation(investigation);
  presentation.diagrams = [{ id: "deposits", title: "Documented deposits", description: "A project-described relationship.",
    nodes: [{ id: "user", label: "User", evidenceIds: [claim.id] }, { id: "pool", label: "Lending pool", evidenceIds: [claim.id] }],
    edges: [{ id: "deposit", from: "user", to: "pool", label: "Deposits stablecoins", basis: "project_claim", evidenceIds: [claim.id] }],
    limitations: ["This diagram describes documentation, not verified execution."],
  }];
  return { investigation, presentation };
}

test("deterministic presentation categorizes a non-NetNet project without inventing a diagram", () => {
  const { investigation } = fixture();
  const result = buildPresentation(investigation);
  assert.equal(result.mode, "deterministic");
  assert.equal(result.overview.basis, "project_claim");
  assert.match(result.overview.text, /Juniper is a lending protocol/);
  assert.deepEqual(result.overview.evidenceIds, ["docs"]);
  assert.match(result.sections.find((section) => section.id === "money_flow")!.items[0]!.text, /deposit stablecoins/);
  assert.match(result.sections.find((section) => section.id === "control")!.items[0]!.text, /multisig admin/);
  assert.deepEqual(result.diagrams, []);
  assert.match(result.sections.find((section) => section.id === "unknowns")!.items.map((item) => item.text).join(" "), /No protocol diagram/);
});

test("raw capture bytes and parsed observations do not become deterministic protocol facts", () => {
  const { investigation } = fixture();
  const { sha256: _sha256, ...capture } = investigation.evidence[0]!;
  investigation.evidence = [captureEvidence({ ...capture, id: "raw", content: JSON.stringify({ bodyBase64: "made-up", title: "Protocol" }) }),
    captureEvidence({ ...capture, id: "parsed", role: "observation" })];
  const result = buildPresentation(investigation);
  assert.equal(result.overview.basis, "unknown");
  assert.deepEqual(result.diagrams, []);
});

test("cited claim graph round-trips with stable node and relationship order", () => {
  const { investigation, presentation } = fixture();
  assert.deepEqual(validatePresentation(JSON.parse(JSON.stringify(presentation)), investigation), presentation);
  const schema = z.toJSONSchema(presentationSchema);
  assert.equal(schema.type, "object");
});

test("diagram validation rejects dangling, duplicate, unconnected and uncited relationships", () => {
  const mutations: ((value: Presentation) => void)[] = [
    (value) => { value.diagrams[0]!.edges[0]!.to = "missing"; },
    (value) => { value.diagrams[0]!.edges[0]!.to = value.diagrams[0]!.edges[0]!.from; },
    (value) => { value.diagrams[0]!.edges = Array.from({ length: 17 }, (_, index) => ({ ...value.diagrams[0]!.edges[0]!, id: `edge-${index}` })); },
    (value) => { value.diagrams[0]!.nodes.push(value.diagrams[0]!.nodes[0]!); },
    (value) => { value.diagrams[0]!.edges.push(value.diagrams[0]!.edges[0]!); },
    (value) => { value.diagrams[0]!.nodes.push({ id: "orphan", label: "Unconnected", evidenceIds: ["docs"] }); },
    (value) => { value.diagrams[0]!.edges[0]!.evidenceIds = []; },
    (value) => { value.diagrams[0]!.nodes[0]!.evidenceIds = ["missing"]; },
    (value) => { value.diagrams[0]!.edges[0]!.label = "x".repeat(91); },
    (value) => { value.diagrams[0]!.nodes[0]!.label = " "; },
  ];
  for (const mutate of mutations) {
    const { investigation, presentation } = fixture(); mutate(presentation);
    assert.throws(() => validatePresentation(presentation, investigation));
  }
});

test("claim captures and parsed document observations cannot verify a protocol connection", () => {
  for (const role of ["claim", "observation"] as const) {
    const { investigation, presentation } = fixture();
    investigation.evidence[0] = { ...investigation.evidence[0]!, role };
    presentation.diagrams[0]!.edges[0]!.basis = "observation";
    assert.throws(() => validatePresentation(presentation, investigation), /Project documents/);
  }
});

test("presentation requires complete categories and citations for assertions", () => {
  const { investigation, presentation } = fixture();
  assert.throws(() => validatePresentation({ ...presentation, sections: presentation.sections.slice(1) }, investigation));
  assert.throws(() => validatePresentation({ ...presentation, overview: { ...presentation.overview, evidenceIds: [] } }, investigation));
  assert.throws(() => validatePresentation({ ...presentation, sections: presentation.sections.map(() => presentation.sections[0]) }, investigation));
  assert.throws(() => validatePresentation({ ...presentation, html: "<script>bad()</script>" }, investigation));
});


test("deterministic overview does not promote a safety or ownership claim into a purpose summary", () => {
  const { investigation } = fixture();
  const { sha256: _sha256, ...capture } = investigation.evidence[0]!;
  investigation.evidence = [captureEvidence({ ...capture, content: JSON.stringify({
    text: "This is a safe and audited protocol with no owner functions. The contract is immutable and cannot be controlled by anyone. Juniper is a lending protocol for stablecoins.",
  }) })];
  assert.match(buildPresentation(investigation).overview.text, /Juniper is a lending protocol/);
  investigation.evidence = [captureEvidence({ ...capture, content: JSON.stringify({ text: "This is a safe and audited protocol with no owner functions." }) })];
  assert.equal(buildPresentation(investigation).overview.basis, "unknown");
});
