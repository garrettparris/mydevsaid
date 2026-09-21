import assert from "node:assert/strict";
import test from "node:test";
import { collectProject, type CollectionResult } from "./collectors.ts";
import { discoverWebsite } from "./discovery.ts";
import type { JsonResponse } from "./fetch-page.ts";
import { CHECKS, createInvestigation, investigationSchema } from "./investigation.ts";
import { PROXY_SLOTS, type Rpc } from "./onchain.ts";

const token = { chainId: 1, address: `0x${"1".repeat(40)}` }, implementation = `0x${"2".repeat(40)}`;
const related = [3, 4, 5, 6].map((digit) => `0x${String(digit).repeat(40)}`);
const block = { number: "0x100", hash: `0x${"a".repeat(64)}` };
const word = (value: string) => `0x${value.replace(/^0x/, "").padStart(64, "0")}`;
const json = (url: string, data: unknown): JsonResponse => ({ requestedUrl: url, finalUrl: url, status: 200,
  contentType: "application/json", body: Buffer.from(JSON.stringify(data)), capturedAt: "2026-09-15T00:00:00.000Z", redirects: [], data });
const gate = () => { let release!: () => void; const promise = new Promise<void>((resolve) => { release = resolve; }); return { promise, release }; };
async function discovery() {
  const links = ["https://github.com/example/one", "https://github.com/example/two", ...[1, 2, 3].map((id) => `https://api.example.com/status${id}`),
    ...related.map((address) => `https://etherscan.io/address/${address}`)];
  return discoverWebsite({ links: ["https://example.com"], token, relatedContractLimit: 4 }, {}, async (url) => ({ ...json(url, {}),
    contentType: "text/html", body: Buffer.from(links.map((link) => `<a href="${link}">Contract documentation</a>`).join("")) }));
}
const getJson = async (url: string): Promise<JsonResponse> => {
  if (url.includes("rdap.org")) return json(url, { objectClassName: "domain", ldhName: "example.com" });
  if (url.includes("/commits/")) return json(url, { sha: "f".repeat(40) });
  if (url.includes("/git/trees/")) return json(url, { truncated: false, tree: [] });
  if (url.includes("api.github.com")) return json(url, { full_name: url.includes("/one") ? "example/one" : "example/two", private: false, default_branch: "main" });
  if (url.includes("sourcify.dev")) return json(url, { chainId: "1", address: url.includes(implementation) ? implementation : token.address,
    runtimeMatch: "exact_match", runtimeBytecode: { onchainBytecode: "0x6000" } });
  return json(url, { ok: true });
};
const rpc: Rpc = async (_url, method, params) => {
  if (method === "eth_chainId") return "0x1";
  if (method === "eth_getBlockByNumber") return block;
  if (method === "eth_getCode") return "0x6000";
  if (method === "eth_getStorageAt") return params[1] === PROXY_SLOTS.implementation ? word(implementation) : word("0");
  if (method === "eth_call") return word("0");
  if (method === "eth_getLogs") return [];
  throw new Error("Unexpected fixture RPC method");
};

test("independent stages overlap, HTTP calls share four slots, and website evidence arrives first", { timeout: 5_000 }, async () => {
  const captured = await discovery(), httpHold = gate(), rpcHold = gate(), fourHttp = gate(), firstRpc = gate();
  const calls: string[] = [], snapshots: CollectionResult[] = [];
  let active = 0, peak = 0;
  const work = collectProject(captured.investigation.subject, captured, undefined, {
    getJson: async (url) => {
      calls.push(url); peak = Math.max(peak, ++active); if (active === 4) fourHttp.release();
      try { await httpHold.promise; return await getJson(url); } finally { active--; }
    },
    rpc: async (url, method, params) => { firstRpc.release(); await rpcHold.promise; return rpc(url, method, params); },
    onPartial: (value) => snapshots.push(value),
  });
  try {
    await Promise.all([fourHttp.promise, firstRpc.promise]);
    assert.equal(calls.length, 4); assert.equal(peak, 4);
    assert.ok(calls.some((url) => url.includes("rdap"))); assert.ok(calls.some((url) => url.includes("github")));
    assert.ok(calls.some((url) => url.includes("api.example")));
    assert.ok(snapshots[0]!.evidence.some((item) => item.medium === "website"));
    assert.equal(snapshots[0]!.checks.find((check) => check.area === "web_presence")!.status, "running");
    assert.equal(snapshots[0]!.findings.length, 0);
    const original = JSON.stringify(snapshots[0]);
    httpHold.release(); rpcHold.release(); const result = await work;
    assert.equal(JSON.stringify(snapshots[0]), original);
    for (const { checks, evidence, findings } of snapshots) investigationSchema.parse({ ...createInvestigation(captured.investigation.subject), checks, evidence, findings });
    for (let index = 1; index < snapshots.length; index++) {
      assert.ok(snapshots[index - 1]!.evidence.every((item) => snapshots[index]!.evidence.some((next) => next.id === item.id)));
    }
    assert.equal(peak, 4); assert.equal(new Set(calls).size, calls.length);
    assert.deepEqual(result.checks.map((check) => check.area), Object.keys(CHECKS));
    snapshots.at(-1)!.evidence[0]!.content = "consumer mutation";
    assert.notEqual(result.evidence[0]!.content, "consumer mutation");
  } finally { httpHold.release(); rpcHold.release(); await work; }
});

test("related views, source verification, and transfers overlap using one validated snapshot and four RPC slots", { timeout: 5_000 }, async () => {
  const captured = await discovery(), hold = gate(), sourceStarted = gate(), relatedStarted = gate(), logsStarted = gate(), fourRpc = gate();
  let active = 0, peak = 0, latest = 0, validated = false;
  const work = collectProject(captured.investigation.subject, captured, undefined, {
    getJson: async (url) => {
      if (url.includes("sourcify")) { assert.equal(validated, true); sourceStarted.release(); await hold.promise; }
      return getJson(url);
    },
    rpc: async (url, method, params) => {
      peak = Math.max(peak, ++active); if (active === 4) fourRpc.release();
      try {
        if (method === "eth_getBlockByNumber" && params[0] === "latest") latest++;
        if (method === "eth_getLogs") { assert.equal(validated, true); logsStarted.release(); await hold.promise; }
        if (method === "eth_getCode" && related.includes(String(params[0]))) { assert.equal(validated, true); relatedStarted.release(); await hold.promise; }
        if (["eth_getStorageAt", "eth_getCode", "eth_call"].includes(method)) assert.equal(params.at(-1), "0x100");
        const value = await rpc(url, method, params);
        if (method === "eth_getBlockByNumber" && params[0] === "0x100") validated = true;
        return value;
      } finally { active--; }
    },
  });
  try {
    await Promise.all([sourceStarted.promise, relatedStarted.promise, logsStarted.promise, fourRpc.promise]);
    assert.equal(latest, 1); assert.equal(peak, 4);
    hold.release(); const result = await work;
    assert.equal(latest, 1); assert.equal(peak, 4);
    for (const item of result.evidence.filter((entry) => entry.snapshot)) {
      assert.equal(item.snapshot!.blockHash, block.hash); assert.equal(item.snapshot!.blockNumber, "256");
    }
    for (const item of result.evidence.filter((entry) => entry.sourceUrl.includes("sourcify"))) {
      const value = JSON.parse(item.content); assert.equal(value.snapshot.blockHash, block.hash); assert.equal(value.codeMatchesSnapshot, true);
    }
    investigationSchema.parse({ ...createInvestigation(captured.investigation.subject), checks: result.checks, evidence: result.evidence, findings: result.findings });
  } finally { hold.release(); await work; }
});

test("stage failures and failing presentation callbacks cannot erase independent evidence", async () => {
  const captured = await discovery(); let sourceCalls = 0;
  const result = await collectProject(captured.investigation.subject, captured, undefined, {
    getJson: async (url) => {
      if (url.includes("sourcify")) sourceCalls++;
      if (url.includes("rdap") || url.includes("github")) throw new Error("private-provider-secret");
      return getJson(url);
    },
    rpc: async () => "0x2105", onPartial: () => { throw new Error("presentation failed"); },
  });
  assert.equal(sourceCalls, 0);
  assert.equal(result.checks.find((check) => check.area === "api_behavior")!.status, "completed");
  assert.equal(result.checks.find((check) => check.area === "web_presence")!.status, "completed");
  for (const area of ["contract_control", "deployment_match", "activity_quality", "public_code"]) assert.equal(result.checks.find((check) => check.area === area)!.status, "blocked");
  assert.doesNotMatch(JSON.stringify(result), /private-provider-secret|presentation failed/);
  investigationSchema.parse({ ...createInvestigation(captured.investigation.subject), checks: result.checks, evidence: result.evidence, findings: result.findings });
});

test("a reorganized related batch is rejected without blocking concurrent source and activity evidence", async () => {
  const captured = await discovery(); let relatedPhase = false, relatedBlockChecks = 0, chains = 0;
  const result = await collectProject(captured.investigation.subject, captured, undefined, { getJson, rpc: async (url, method, params) => {
    if (method === "eth_chainId" && ++chains > 1) relatedPhase = true;
    if (relatedPhase && method === "eth_getBlockByNumber" && params[0] === "0x100" && ++relatedBlockChecks >= 3) return { ...block, hash: `0x${"b".repeat(64)}` };
    return rpc(url, method, params);
  } });
  assert.ok(result.limitations.some((item) => item.startsWith("Related-contract inspection:")));
  assert.ok(!result.evidence.some((item) => item.medium === "onchain" && JSON.parse(item.content).kind === "related_contract"));
  assert.equal(result.checks.find((check) => check.area === "deployment_match")!.status, "completed");
  assert.equal(result.checks.find((check) => check.area === "activity_quality")!.status, "completed");
});
