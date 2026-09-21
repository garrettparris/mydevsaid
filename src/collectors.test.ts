import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { fetchJson, postJsonRpc, type JsonResponse, type PageNetwork } from "./fetch-page.ts";
import { collectOnchain, collectTransfers, addressWord, PROXY_SLOTS, TRANSFER_TOPIC, type Rpc } from "./onchain.ts";
import { analyzeTransfers } from "./activity.ts";
import { collectProject } from "./collectors.ts";
import { discoverWebsite } from "./discovery.ts";
import { investigationSchema, createInvestigation, assessReadiness } from "./investigation.ts";

const token = { chainId: 1, address: `0x${"1".repeat(40)}` };
const implementation = `0x${"2".repeat(40)}`;
const blockHash = `0x${"a".repeat(64)}`;
const word = (value: string) => `0x${value.replace(/^0x/, "").padStart(64, "0")}`;
const block = { number: "0x100", hash: blockHash };
const stamp = "2026-09-14T00:00:00.000Z";
const json = (url: string, data: unknown): JsonResponse => ({ requestedUrl: url, finalUrl: url, status: 200, contentType: "application/json", body: Buffer.from(JSON.stringify(data)), capturedAt: stamp, redirects: [], data });
const network = (data: unknown, status = 200, headers: Record<string, string> = {}): PageNetwork => ({
  resolve: async () => [{ address: "93.184.216.34", family: 4 }],
  request: async () => ({ status, headers: { "content-type": "application/json", ...headers }, body: (async function* () { yield Buffer.from(JSON.stringify(data)); })(), close: () => {} }),
});
const rpc: Rpc = async (_url, method, params) => {
  if (method === "eth_chainId") return "0x1";
  if (method === "eth_getBlockByNumber") return block;
  if (method === "eth_getCode") return "0x6000";
  if (method === "eth_getStorageAt") return params[1] === PROXY_SLOTS.implementation ? word(implementation) : word("0");
  if (method === "eth_call") return word("0");
  if (method === "eth_getLogs") return [];
  throw new Error("unexpected method");
};

test("JSON fetch uses DNS pinning and rejects private addresses", async () => {
  const result = await fetchJson("https://example.com/api", {}, network({ ok: true }));
  assert.deepEqual(result.data, { ok: true });
  await assert.rejects(fetchJson("http://127.0.0.1/api", {}, network({})), /private/);
  const mixed = network({});
  mixed.resolve = async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.1", family: 4 }];
  await assert.rejects(fetchJson("https://example.com", {}, mixed), /private/);
});

test("JSON collection enforces byte limits, JSON content types, and redirect guards", async () => {
  await assert.rejects(fetchJson("https://example.com", { maxBytes: 5 }, network({ too: "large" })), /byte limit/);
  await assert.rejects(fetchJson("https://example.com", {}, network({}, 200, { "content-type": "text/html" })), /JSON/);
  await assert.rejects(fetchJson("https://example.com", {}, network({}, 302, { location: "http://localhost/" })), /downgrade/);
  await assert.rejects(fetchJson("https://example.com", {}, network({}, 302, { location: "https://127.0.0.1/" })), /private/);
});

test("RPC accepts only read methods, checks response identity, and never redirects", async () => {
  await assert.rejects(postJsonRpc("https://rpc.example.com", "eth_sendRawTransaction", [], network({})), /allowlist/);
  await assert.rejects(postJsonRpc("https://rpc.example.com", "eth_chainId", [], network({ jsonrpc: "2.0", id: 2, result: "0x1" })));
  await assert.rejects(postJsonRpc("https://rpc.example.com", "eth_chainId", [], network({}, 302, { location: "https://other.example.com" })), /Redirect limit/);
  await assert.rejects(postJsonRpc("https://rpc.example.com", "eth_chainId", [], network({ jsonrpc: "2.0", id: 1, error: { message: "bad" } })), /provider returned/);
  const adapter = network({ jsonrpc: "2.0", id: 1, result: "0x1" });
  const original = adapter.request;
  adapter.request = async (url, address, signal, request) => {
    assert.equal(request?.method, "POST");
    assert.equal(JSON.parse(request!.body!).method, "eth_chainId");
    return original(url, address, signal, request);
  };
  assert.equal(await postJsonRpc("https://rpc.example.com", "eth_chainId", [], adapter), "0x1");
});

test("RPC state is pinned and the standard implementation is followed once", async () => {
  const chain = await collectOnchain(token, async (url, method, params) => {
    if (["eth_getCode", "eth_getStorageAt", "eth_call"].includes(method)) assert.equal(params.at(-1), "0x100");
    return rpc(url, method, params);
  });
  assert.equal(chain.snapshot.blockNumber, "256");
  assert.equal(chain.implementation, implementation);
  assert.equal(chain.implementationCode, "0x6000");
  assert.equal(chain.ownerCandidate, null);
  assert.equal(chain.records.filter((record) => record.method === "eth_getCode").length, 2);
});

test("RPC chain mismatch and reorganizations invalidate snapshots", async () => {
  await assert.rejects(collectOnchain(token, async (url, method, params) => method === "eth_chainId" ? "0x2105" : rpc(url, method, params)), /does not match/);
  await assert.rejects(collectOnchain(token, async (url, method, params) => method === "eth_getBlockByNumber" && params[0] !== "latest" ? { ...block, hash: word("b") } : rpc(url, method, params)), /reorganized/);
  await assert.rejects(collectOnchain({ ...token, chainId: 137 }, rpc), /Only Ethereum/);
});

test("Robinhood mainnet records its chain and explorer without relabeling Ethereum or testnet", async () => {
  const mainnet = { ...token, chainId: 4663 };
  const chain = await collectOnchain(mainnet, async (url, method, params) => {
    assert.equal(url, "https://rpc.mainnet.chain.robinhood.com");
    return method === "eth_chainId" ? "0x1237" : rpc(url, method, params);
  });
  assert.equal(chain.snapshot.chainId, 4663);
  assert.equal(chain.sourceUrl, `https://robinhoodchain.blockscout.com/address/${token.address}`);
  for (const actualChainId of ["0x1", "0xb626"]) {
    const calls: string[] = [];
    await assert.rejects(collectOnchain(mainnet, async (_url, method) => {
      calls.push(method); return actualChainId;
    }), /does not match/);
    assert.deepEqual(calls, ["eth_chainId"]);
  }
  await assert.rejects(collectOnchain({ ...token, chainId: 46630 }, rpc), /supported by this collector/);
});

test("Failed optional control probes produce gaps without inventing privileges", async () => {
  const result = await collectOnchain(token, async (url, method, params) => {
    if (method === "eth_call") throw new Error("https://secret-provider/key-do-not-leak");
    return rpc(url, method, params);
  });
  assert.equal(result.ownerCandidate, null);
  assert.equal(result.gaps.length, 2);
  assert.doesNotMatch(JSON.stringify(result), /key-do-not-leak/);
  assert.equal(addressWord(`0x1${"0".repeat(63)}`), null);
});

test("Beacon proxy resolves its implementation through read-only eth_call", async () => {
  const chain = await collectOnchain(token, async (url, method, params) => {
    if (method === "eth_getStorageAt") return params[1] === PROXY_SLOTS.beacon ? word(implementation) : word("0");
    if (method === "eth_call" && (params[0] as { data: string }).data === "0x5c60da1b") return word(token.address);
    return rpc(url, method, params);
  });
  assert.equal(chain.implementation, token.address);
});

const log = (index: number, from = "3", to = "4") => ({ address: token.address, topics: [TRANSFER_TOPIC, word(from.repeat(40)), word(to.repeat(40))], data: word("1"), blockNumber: "0x100", blockHash, transactionHash: word(String(index + 1)), logIndex: `0x${index.toString(16)}` });

test("Transfer collection enforces its address/window/log budget and reorg check", async () => {
  const chain = await collectOnchain(token, rpc);
  const sample = await collectTransfers(chain, async (url, method, params) => {
    if (method === "eth_getLogs") {
      assert.deepEqual(params, [{ address: token.address, fromBlock: "0x81", toBlock: "0x100", topics: [TRANSFER_TOPIC] }]);
      return [log(0)];
    }
    return rpc(url, method, params);
  });
  assert.equal(sample.fromBlock, "129");
  for (const logs of [[{ ...log(0), address: implementation }], [{ ...log(0), blockNumber: "0x80" }], [{ ...log(0), removed: true }], Array.from({ length: 501 }, (_, index) => log(index))]) {
    await assert.rejects(collectTransfers(chain, async (url, method, params) => method === "eth_getLogs" ? logs : rpc(url, method, params)));
  }
  await assert.rejects(collectTransfers(chain, async (url, method, params) => method === "eth_getBlockByNumber" ? { ...block, hash: word("b") } : rpc(url, method, params)), /reorganized/);
});

test("Activity analysis excludes duplicate, mint, burn, malformed, and NFT events", () => {
  const sample = { fromBlock: "129", toBlock: "256", method: "eth_getLogs", params: [], attempts: [], logs: [log(0), log(0), log(1, "0"), log(2, "3", "0"), { ...log(3), topics: [...log(3).topics, word("8")] }, { ...log(4), data: "0x01" }] };
  const analysis = analyzeTransfers(sample);
  assert.equal(analysis.transfers, 1);
  assert.equal(analysis.mintEvents, 1);
  assert.equal(analysis.burnEvents, 1);
  assert.equal(analysis.excludedEvents, 3);
  assert.equal(analysis.topSenderShare, 1);
  assert.match(analysis.limitations.join(" "), /not common gas funders/);
});

test("Activity patterns expose reciprocal pairs and shared senders without ownership claims", () => {
  const analysis = analyzeTransfers({ fromBlock: "1", toBlock: "128", method: "eth_getLogs", params: [], attempts: [], logs: [log(0, "3", "4"), log(1, "3", "5"), log(2, "3", "6"), log(3, "4", "3")] });
  assert.equal(analysis.sharedTokenSenders[0]?.distinctRecipients, 3);
  assert.equal(analysis.reciprocalPairs.length, 1);
  assert.equal(analysis.repeatedAmounts[0]?.count, 4);
  assert.equal(analysis.topSenderShare, 0.75);
  assert.equal(analyzeTransfers({ fromBlock: "1", toBlock: "128", method: "eth_getLogs", params: [], attempts: [], logs: [] }).topSenderShare, null);
});

async function discovered(links = '<a href="https://github.com/example/protocol">GitHub</a><a href="https://api.example.com/status">API</a>') {
  return discoverWebsite({ links: ["https://example.com"], token }, {}, async (url) => ({ ...json(url, {}), contentType: "text/html", body: Buffer.from(`<html><body>${links}</body></html>`) }));
}

const getJson = async (url: string): Promise<JsonResponse> => {
  if (url.includes("rdap.org")) return json(url, { objectClassName: "domain", ldhName: "example.com", events: [{ eventAction: "registration", eventDate: "2000-01-01T00:00:00Z" }], entities: [{ privateContact: "omit me" }] });
  if (url.includes("/commits/")) return json(url, { sha: "f".repeat(40) });
  if (url.includes("api.github.com")) return json(url, { full_name: "example/protocol", private: false, default_branch: "main" });
  if (url.includes("sourcify")) return json(url, { chainId: "1", address: url.includes(implementation) ? implementation : token.address, runtimeMatch: "exact_match", runtimeBytecode: { onchainBytecode: "0x6000" } });
  return json(url, { ok: true });
};

test("Integrated collection produces valid cited findings and bounded meaningful gaps", async () => {
  const discovery = await discovered();
  const result = await collectProject(discovery.investigation.subject, discovery, undefined, { getJson, rpc });
  const report = investigationSchema.parse({ ...createInvestigation(discovery.investigation.subject), checks: result.checks, evidence: result.evidence, findings: result.findings });
  assert.equal(report.checks.length, 6);
  assert.equal(report.checks.every((check) => check.status === "completed"), true);
  assert.equal(result.findings.filter((finding) => finding.area === "deployment_match").every((finding) => finding.status === "partially_supported"), true);
  assert.doesNotMatch(result.evidence.find((e) => e.medium === "domain")!.content, /omit me/);
  assert.equal(assessReadiness(report).readyForReview, true);
});

test("Robinhood evidence and coverage retain the submitted network and reject other-chain source records", async () => {
  const discovery = await discovered("");
  const subject = { ...discovery.investigation.subject, token: { ...token, chainId: 4663 } };
  const result = await collectProject(subject, discovery, undefined, { getJson,
    rpc: async (url, method, params) => method === "eth_chainId" ? "0x1237" : rpc(url, method, params) });
  assert.match(result.checks.find((check) => check.area === "contract_control")!.reason!, /Robinhood Chain/);
  const snapshots = result.evidence.filter((item) => item.snapshot);
  assert.ok(snapshots.length > 0);
  assert.ok(snapshots.every((item) => item.snapshot!.chainId === 4663 && item.sourceUrl.startsWith("https://robinhoodchain.blockscout.com/")));
  assert.equal(result.checks.find((check) => check.area === "deployment_match")!.status, "blocked");
  assert.equal(result.findings.filter((finding) => finding.area === "deployment_match").length, 0);
});

test("Unavailable services become blocked coverage, never successful verification", async () => {
  const discovery = await discovered("");
  const result = await collectProject(discovery.investigation.subject, discovery, undefined, { getJson: async () => { throw new Error("offline"); }, rpc: async () => { throw new Error("offline"); } });
  assert.equal(result.checks.filter((check) => check.status === "blocked").length, 5);
  assert.equal(result.findings.length, 1);
  assert.match(result.limitations.join(" "), /Source verification/);
});

test("Source records for a different address are rejected; unmatched code remains unverified", async () => {
  const discovery = await discovered("");
  const result = await collectProject(discovery.investigation.subject, discovery, undefined, { rpc, getJson: async (url) => {
    const response = await getJson(url);
    if (url.includes("sourcify")) response.data = { chainId: "1", address: token.address, runtimeMatch: "exact_match", runtimeBytecode: { onchainBytecode: "0x9999" } };
    return response;
  } });
  const findings = result.findings.filter((finding) => finding.area === "deployment_match");
  assert.equal(findings.length, 1);
  assert.equal(findings[0]?.status, "unverified");
});

test("API collection skips query-bearing and action endpoints and enforces a three-candidate budget", async () => {
  const discovery = await discovered('<a href="https://api.example.com/withdraw">API</a><a href="https://api.example.com/status?key=secret">API</a><a href="https://api.example.com/status">API</a><a href="https://api.example.com/extra">API</a>');
  const apiCalls: string[] = [];
  const result = await collectProject(discovery.investigation.subject, discovery, undefined, { rpc, getJson: async (url) => { if (url.startsWith("https://api.example.com")) apiCalls.push(url); return getJson(url); } });
  assert.deepEqual(apiCalls, ["https://api.example.com/status"]);
  assert.match(result.limitations.join(" "), /skipped query-bearing/);
});

test("Repository sources are pinned, blob-verified, bounded, and kept separate from website claims", async () => {
  const discovery = await discovered('Our project does amazing things.<a href="https://github.com/example/protocol">GitHub</a>');
  const content = "pragma solidity ^0.8.0; contract Example {}";
  const sha = createHash("sha1").update(`blob ${Buffer.byteLength(content)}\0${content}`).digest("hex");
  const paths = ["contracts/A.sol", "contracts/B.sol", "contracts/C.sol", "contracts/D.sol", "node_modules/E.sol"];
  const fetched: string[] = [];
  const result = await collectProject(discovery.investigation.subject, discovery, undefined, { rpc, getJson: async (url) => {
    if (url.includes("/git/trees/")) return json(url, { truncated: false, tree: paths.map((path) => ({ path, sha, type: "blob", size: content.length })) });
    if (url.includes("/contents/")) {
      fetched.push(url);
      return json(url, { type: "file", encoding: "base64", sha, size: content.length, content: Buffer.from(content).toString("base64") });
    }
    return getJson(url);
  } });
  assert.equal(fetched.length, 3);
  assert.equal(fetched.every((url) => url.endsWith(`?ref=${"f".repeat(40)}`)), true);
  assert.equal(result.evidence.filter((item) => item.medium === "repository" && JSON.parse(item.content).path).length, 3);
  const claims = result.evidence.filter((item) => item.role === "claim");
  assert.match(claims[0]!.content, /amazing things/);
  assert.equal(result.findings.some((finding) => finding.supportingEvidenceIds.includes(claims[0]!.id)), false);
});

test("Repository source with a false blob hash is rejected", async () => {
  const discovery = await discovered();
  const result = await collectProject(discovery.investigation.subject, discovery, undefined, { rpc, getJson: async (url) => {
    if (url.includes("/git/trees/")) return json(url, { truncated: false, tree: [{ path: "contracts/A.sol", sha: "a".repeat(40), type: "blob", size: 3 }] });
    if (url.includes("/contents/")) return json(url, { type: "file", encoding: "base64", sha: "a".repeat(40), size: 3, content: "YWJj" });
    return getJson(url);
  } });
  assert.equal(result.evidence.filter((item) => item.medium === "repository").length, 1);
  assert.match(result.limitations.join(" "), /A.sol: source could not be captured/);
});

test("Busy activity windows shrink explicitly instead of truncating log results", async () => {
  const chain = await collectOnchain(token, rpc);
  let attempts = 0;
  const sample = await collectTransfers(chain, async (url, method, params) => {
    if (method === "eth_getLogs") { attempts++; return attempts === 1 ? Array.from({ length: 501 }, (_, index) => log(index)) : [log(0)]; }
    return rpc(url, method, params);
  });
  assert.equal(sample.fromBlock, "241");
  assert.equal(sample.attempts.length, 2);
  assert.equal(sample.logs.length, 1);
});


test("RDAP registrable-domain policy handles suffix boundaries and records its derivation", async () => {
  const discovery = await discovered("");
  for (const [host, target] of [
    ["docs.netnet.capital", "netnet.capital"], ["docs.example.co.uk", "example.co.uk"],
    ["PROJECT.COM.", "project.com"], ["docs.bücher.de", "xn--bcher-kva.de"],
  ]) {
    const calls: string[] = [];
    const result = await collectProject({ links: [`https://${host}`], token, domainLookup: "registrable_domain" }, discovery, undefined, {
      rpc, getJson: async (url) => {
        if (!url.startsWith("https://rdap.org/")) return getJson(url);
        calls.push(url);
        return json(url, { objectClassName: "domain", ldhName: target!.toUpperCase(), entities: [{ secret: "private registrant" }] });
      },
    });
    assert.deepEqual(calls, [`https://rdap.org/domain/${target}`]);
    const entry = result.evidence.find((item) => item.medium === "domain")!;
    const content = JSON.parse(entry.content);
    assert.equal(content.lookup.queriedDomain, target);
    assert.equal(content.lookup.inputHostname, new URL(`https://${host}`).hostname);
    assert.equal(content.lookup.policy, "registrable_domain");
    assert.match(content.lookup.suffixParser, /tldts\/7\.4\.13/);
    assert.doesNotMatch(entry.content, /private registrant/);
    const finding = result.findings.find((item) => item.supportingEvidenceIds.includes(entry.id))!;
    assert.match(finding.limitations.join(" "), /not the creation date or ownership of a subdomain/);
  }
});

test("RDAP skips private hosting and non-registrable inputs without attributing provider age", async () => {
  const discovery = await discovered("");
  for (const host of ["project.github.io", "docs.project.pages.dev", "co.uk", "localhost", "name.invalid", "example.com", "home.arpa", "93.184.216.34"]) {
    const calls: string[] = [];
    const result = await collectProject({ links: [`https://${host}`], token, domainLookup: "registrable_domain" }, discovery, undefined, {
      rpc, getJson: async (url) => { calls.push(url); return getJson(url); },
    });
    assert.equal(calls.some((url) => url.startsWith("https://rdap.org/")), false, host);
    assert.equal(result.evidence.some((item) => item.medium === "domain"), false);
    assert.ok(result.limitations.some((item) => item.includes("no lookup")));
  }
});

test("Legacy scopes retain exact-host RDAP lookup and mismatched records remain unsupported", async () => {
  const discovery = await discovered("");
  for (const domainLookup of [undefined, "exact_host", "registrable_domain"] as const) {
    const calls: string[] = [];
    const result = await collectProject({ links: ["https://docs.project.com"], token, ...(domainLookup ? { domainLookup } : {}) }, discovery, undefined, {
      rpc, getJson: async (url) => {
        if (url.startsWith("https://rdap.org/")) { calls.push(url); return json(url, { objectClassName: "domain", ldhName: "unrelated.com" }); }
        return getJson(url);
      },
    });
    assert.deepEqual(calls, [`https://rdap.org/domain/${domainLookup === "registrable_domain" ? "project.com" : "docs.project.com"}`]);
    assert.equal(result.evidence.some((item) => item.medium === "domain"), false);
    assert.ok(result.limitations.some((item) => item.startsWith("Domain registration:") && item.includes("was queried")));
  }
});
