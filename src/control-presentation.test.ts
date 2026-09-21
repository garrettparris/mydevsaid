import test from "node:test";
import assert from "node:assert/strict";
import { captureEvidence, createInvestigation, type Evidence } from "./investigation.ts";
import { buildPresentation } from "./report-model.ts";
import { buildControlPresentation } from "./control-presentation.ts";

const contract = `0x${"a".repeat(40)}`;
const owners = [1, 2, 3].map(value => `0x${String(value).repeat(40)}`);
const snapshot = { chainId: 1, address: contract, blockNumber: "21000000", blockHash: `0x${"b".repeat(64)}` };
function payload() {
  return { kind: "related_contract", address: contract, snapshot: { ...snapshot }, bytecode: "0x6000",
    safeConfiguration: { threshold: 2, owners: [...owners] }, ownerCandidate: null, records: [], gaps: [] };
}
function fixture(content: unknown = payload(), overrides: Partial<Evidence> = {}) {
  const investigation = createInvestigation({ links: ["https://example.com/"], token: { chainId: 1, address: `0x${"c".repeat(40)}` } });
  const captured = captureEvidence({ id: "related-view", role: "observation", medium: "onchain", sourceUrl: `https://etherscan.io/address/${contract}`,
    capturedAt: "2026-09-15T01:00:00Z", method: "Pinned fixture calls", toolVersion: "fixture/1", snapshot, content: JSON.stringify(content) });
  investigation.evidence.push({ ...captured, ...overrides });
  return investigation;
}

test("a 2-of-3 view observation produces a cited settings diagram without claiming protocol control", () => {
  const result = buildPresentation(fixture());
  assert.equal(result.diagrams.length, 1);
  const graph = result.diagrams[0]!;
  assert.equal(graph.edges.length, 2);
  assert.ok(graph.edges.every(edge => edge.basis === "observation" && edge.from === "contract"));
  assert.ok(graph.edges.every(edge => edge.evidenceIds[0] === "related-view"));
  assert.ok(graph.nodes.every(node => node.evidenceIds[0] === "related-view"));
  assert.match(graph.edges[0]!.label, /getOwners/);
  assert.match(graph.edges[1]!.label, /getThreshold/);
  assert.match(graph.limitations.join(" "), /do not prove Safe identity.*authorization/);
  const control = result.sections.find(section => section.id === "control")!.items[0]!;
  assert.equal(control.basis, "observation"); assert.deepEqual(control.evidenceIds, ["related-view"]);
  assert.match(control.text, /2-of-3 approval setting/);
  for (const owner of owners) assert.ok(control.text.includes(owner));
  const unknowns = result.sections.find(section => section.id === "unknowns")!.items.map(item => item.text).join(" ");
  assert.match(unknowns, /mechanism, money flows and authority.*still require/);
  assert.doesNotMatch(unknowns, /No protocol diagram/);
});

test("invalid configuration and bytecode cannot produce approval settings or diagrams", () => {
  const invalid = [null, { threshold: 0, owners }, { threshold: 4, owners }, { threshold: 1.5, owners },
    { threshold: "2", owners }, { threshold: 1, owners: [] }, { threshold: 1, owners: [owners[0], owners[0]] },
    { threshold: 1, owners: [contract, contract.toUpperCase().replace("0X", "0x")] },
    { threshold: 1, owners: [`0x${"0".repeat(40)}`] }, { threshold: 1, owners: ["0x123"] },
    { threshold: 1, owners, verifiedSafe: true }, { threshold: 1, owners: Array.from({ length: 21 }, (_, index) => `0x${(index + 1).toString(16).padStart(40, "0")}`) }];
  for (const safeConfiguration of invalid) assert.deepEqual(buildControlPresentation(fixture({ ...payload(), safeConfiguration })), { statements: [], diagrams: [] });
  for (const bytecode of [null, "0x", "0x0", "0xzz", "malformed"]) {
    assert.deepEqual(buildControlPresentation(fixture({ ...payload(), bytecode })), { statements: [], diagrams: [] });
  }
});

test("claim media and forged or mismatched block identities cannot become observed diagrams", () => {
  for (const overrides of [{ role: "claim" }, { medium: "documentation" }, { medium: "website" }, { snapshot: undefined }] as Partial<Evidence>[]) {
    assert.deepEqual(buildControlPresentation(fixture(payload(), overrides)), { statements: [], diagrams: [] });
  }
  for (const changed of [{ chainId: 8453 }, { address: owners[0]! }, { blockNumber: "21000001" }, { blockHash: `0x${"d".repeat(64)}` }]) {
    const content = { ...payload(), snapshot: { ...snapshot, ...changed } };
    assert.deepEqual(buildControlPresentation(fixture(content)), { statements: [], diagrams: [] });
  }
  assert.deepEqual(buildControlPresentation(fixture({ ...payload(), address: owners[0] })), { statements: [], diagrams: [] });
  const anotherChain = { ...snapshot, chainId: 8453 };
  assert.deepEqual(buildControlPresentation(fixture({ ...payload(), snapshot: anotherChain }, { snapshot: anotherChain })), { statements: [], diagrams: [] });
  assert.deepEqual(buildControlPresentation(fixture({ ...payload(), kind: "project_claim" })), { statements: [], diagrams: [] });
});

test("four distinct settings observations retain bounded diagrams and full readable control settings", () => {
  const investigation = fixture();
  for (let i = 4; i <= 6; i++) {
    const address = `0x${i.toString().repeat(40)}`;
    const block = { ...snapshot, address };
    investigation.evidence.push(...fixture({ ...payload(), address, snapshot: block }, { id: `related-${i}`, snapshot: block }).evidence);
  }
  const duplicate = structuredClone(investigation.evidence[0]!); duplicate.id = "duplicate";
  investigation.evidence.push(duplicate);
  const result = buildPresentation(investigation);
  assert.equal(result.diagrams.length, 3);
  const controls = result.sections.find(section => section.id === "control")!.items;
  assert.equal(controls.length, 4);
  assert.equal(new Set(result.diagrams.map(graph => graph.id)).size, 3);
  assert.ok(controls.every(item => item.text.includes("2-of-3")));
});

test("maximum-size owner lists fit the presentation contract without truncating addresses", () => {
  const manyOwners = Array.from({ length: 20 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, "0")}`);
  const result = buildPresentation(fixture({ ...payload(), safeConfiguration: { threshold: 20, owners: manyOwners } }));
  const control = result.sections.find(section => section.id === "control")!.items[0]!;
  assert.match(control.text, /20-of-20/);
  assert.ok(manyOwners.every(owner => control.text.includes(owner)));
});
