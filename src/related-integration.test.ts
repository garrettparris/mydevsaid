import assert from "node:assert/strict";
import test from "node:test";
import { runInvestigation } from "./engine.ts";
import { discoverWebsite } from "./discovery.ts";
import { collectProject } from "./collectors.ts";
import type { Rpc } from "./onchain.ts";

const token = { chainId: 1, address: `0x${"1".repeat(40)}` };
const safe = `0x${"2".repeat(40)}`, signer = `0x${"3".repeat(40)}`;
const hash = `0x${"a".repeat(64)}`;
const word = (value: string) => value.replace(/^0x/, "").padStart(64, "0");
const rpc: Rpc = async (_url, method, params) => {
  if (method === "eth_chainId") return "0x1";
  if (method === "eth_getBlockByNumber") return { number: "0x100", hash };
  if (method === "eth_getCode") return "0x6000";
  if (method === "eth_getStorageAt") return `0x${word("0")}`;
  if (method === "eth_call") {
    const call = params[0] as { to: string; data: string };
    if (call.to === safe && call.data === "0xa0e67e2b") return `0x${word("20")}${word("1")}${word(signer)}`;
    if (call.to === safe && call.data === "0xe75235b8") return `0x${word("1")}`;
    return `0x${word("0")}`;
  }
  if (method === "eth_getLogs") return [];
  throw new Error("Unexpected RPC method");
};
async function run(limit?: 0 | 4, adapter: Rpc = rpc) {
  const subject = { links: ["https://example.com"], token, ...(limit === undefined ? {} : { relatedContractLimit: limit }) };
  return runInvestigation(subject, undefined, { modelEnabled: false,
    discover: async input => discoverWebsite(input, { maxPages: 1 }, async url => ({ requestedUrl: url, finalUrl: url,
      status: 200, contentType: "text/html", capturedAt: "2026-09-15T00:00:00Z", redirects: [],
      body: Buffer.from(`<p>Team Safe <a href="https://etherscan.io/address/${safe}">${safe}</a></p>`),
    })),
    collect: (input, discovery, progress) => collectProject(input, discovery, progress, { rpc: adapter, getJson: async () => { throw new Error("offline fixture"); } }),
  });
}

test("Actual harness collects cited related views only within the saved budget", async () => {
  for (const limit of [undefined, 0] as const) {
    let relatedRequests = 0;
    const old = await run(limit, async (url, method, params) => {
      if (JSON.stringify(params).includes(safe)) relatedRequests++;
      return rpc(url, method, params);
    });
    assert.equal(relatedRequests, 0);
    assert.equal(old.investigation.evidence.some(e => e.content.includes('"kind":"related_contract"')), false);
  }
  const result = await run(4);
  const evidence = result.investigation.evidence.find(e => e.content.includes('"kind":"related_contract"'))!;
  assert.equal(evidence.snapshot!.address, safe);
  assert.equal(evidence.snapshot!.blockNumber, "256");
  assert.deepEqual(JSON.parse(evidence.content).safeConfiguration, { threshold: 1, owners: [signer] });
  assert.equal(JSON.parse(evidence.content).snapshotChecks.length, 4);
  assert.ok(result.investigation.checks.find(c => c.area === "contract_control")!.evidenceIds.includes(evidence.id));
  assert.match(result.investigation.findings.find(f => f.supportingEvidenceIds.includes(evidence.id))!.explanation, /threshold of 1/);
  assert.match(result.investigation.findings.find(f => f.supportingEvidenceIds.includes(evidence.id))!.limitations.join(" "), /do not prove Safe identity/);
});

test("Failed related batch consistency cannot promote its partial reads to observations", async () => {
  let chainChecks = 0;
  const result = await run(4, async (url, method, params) => {
    if (method === "eth_chainId" && ++chainChecks === 3) return "0x2105";
    return rpc(url, method, params);
  });
  assert.equal(result.investigation.evidence.some(e => e.content.includes('"kind":"related_contract"')), false);
  assert.match(result.summary.limitations.join(" "), /no batch observations accepted/);
  assert.ok(result.investigation.evidence.some(e => e.content.includes('"kind":"contract_inventory"')));
});
