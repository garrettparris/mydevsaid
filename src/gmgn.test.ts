import assert from "node:assert/strict";
import test from "node:test";
import { collectGmgn, type GmgnOptions } from "./gmgn.ts";
import { collectProject, type CollectionResult } from "./collectors.ts";
import { discoverWebsite } from "./discovery.ts";
import { investigationSchema } from "./investigation.ts";
import { buildPresentation } from "./report-model.ts";

const token = { chainId: 4663, address: `0x${"1".repeat(40)}` };
const wallet = (n: number) => `0x${String(n).repeat(40)}`;
const info = { address: token.address, name: "Example", symbol: "EX", launchpad: "", launchpad_platform: "",
  link: { website: "https://example.com", twitter_username: "exampletoken" }, stat: { top_10_holder_rate: "0.7" } };
const replies: Record<string, unknown> = {
  "/v1/token/info": info,
  "/v1/token/security": { address: token.address, is_honeypot: true, is_open_source: true, is_renounced: false, buy_tax: "0.05", sell_tax: null },
  "/v1/token/pool_info": { address: token.address, pool_address: wallet(2), exchange: "uniswap_v2", liquidity: "1234.56" },
  "/v1/market/token_top_holders": { list: [3, 4].map((n) => ({ address: wallet(n), amount_percentage: 0.2, native_transfer: { address: wallet(5), timestamp: 123 }, tags: ["bundler"] })) },
  "/v1/market/token_top_traders": { list: [{ address: wallet(6), native_transfer: null }] },
};
const json = (data: unknown, status = 200) => new Response(JSON.stringify({ code: 0, data }), { status, headers: { "Content-Type": "application/json" } });
const fixture = (override: Partial<GmgnOptions> = {}): GmgnOptions => ({ apiKey: "fixture-secret", schedule: async () => {},
  fetch: async (url) => json(replies[new URL(String(url)).pathname]), ...override });

test("GMGN queries fixed read routes, attributes metadata and preserves unknown launchpad and missing risk fields", async () => {
  const weights: number[] = [], paths: string[] = [];
  const result = await collectGmgn(token, fixture({ schedule: async (weight) => { weights.push(weight); }, fetch: async (input, init) => {
    const url = new URL(String(input)); paths.push(url.pathname);
    assert.equal(url.origin, "https://openapi.gmgn.ai"); assert.equal(init?.method, "GET"); assert.equal(init.redirect, "error");
    assert.equal(new Headers(init.headers).get("X-APIKEY"), "fixture-secret");
    assert.equal(url.searchParams.get("chain"), "robinhood"); assert.equal(url.searchParams.get("address"), token.address);
    assert.ok(url.searchParams.has("timestamp")); assert.ok(url.searchParams.has("client_id"));
    if (url.pathname.includes("top_")) assert.equal(url.searchParams.get("limit"), "100");
    return json(replies[url.pathname]);
  } }));
  assert.deepEqual(weights, [1, 1, 1, 5, 5]); assert.equal(paths.length, 5); assert.equal(result.observations.length, 5);
  assert.ok(!JSON.stringify(result).includes("fixture-secret"));
  for (const { evidence, finding } of result.observations) {
    assert.match(evidence.method, /^Data from GMGN/); assert.match(finding.explanation, /^Data from GMGN/);
    assert.equal(finding.status, "unverified"); assert.equal(evidence.snapshot, undefined);
    assert.ok(!evidence.sourceUrl.includes("timestamp="));
  }
  const metadata = JSON.parse(result.observations[0]!.evidence.content).data.metadata;
  assert.equal(metadata.launchpad, null); assert.equal(metadata.launchpadPlatform, null);
  assert.equal(metadata.website, "https://example.com/"); assert.equal(metadata.twitter, "https://x.com/exampletoken");
  assert.equal(metadata.chainId, 4663); assert.match(metadata.chainBasis, /Requested/);
  assert.match(result.observations[1]!.finding.explanation, /buy tax: 5.00%; sell tax: not reported/);
  const holders = JSON.parse(result.observations[3]!.evidence.content).data;
  assert.equal(holders.fundingCoverage, 2); assert.equal(holders.sharedFunding.length, 1);
  const traders = JSON.parse(result.observations[4]!.evidence.content).data;
  assert.equal(traders.fundingCoverage, 0);
});

test("GMGN rejects mismatched identity and unsafe metadata links without following any returned URL", async () => {
  for (const bad of [{ ...info, address: wallet(9) }, { ...info, chain: "base" }, { ...info, chain_id: 8453 }, {}]) {
    let calls = 0;
    const result = await collectGmgn(token, fixture({ fetch: async () => { calls++; return json(bad); } }));
    assert.equal(calls, 1); assert.equal(result.observations.length, 0); assert.equal(result.limitations.length, 1);
  }
  const result = await collectGmgn(token, fixture({ fetch: async (url) => {
    const path = new URL(String(url)).pathname;
    return json(path.endsWith("/info") ? { ...info, name: "<script>steal()</script>",
      link: { website: "javascript:steal()", twitter_username: "example/../../bad" }, secret: "unlisted-field" } : replies[path]);
  } }));
  const record = JSON.parse(result.observations[0]!.evidence.content);
  assert.equal(record.data.metadata.website, null); assert.equal(record.data.metadata.twitter, null);
  assert.equal(record.data.metadata.name, "<script>steal()</script>"); assert.ok(!JSON.stringify(result).includes("unlisted-field"));
});

test("GMGN treats empty wallets as an empty sample and rejects oversized or malformed responses", async () => {
  const empty = await collectGmgn(token, fixture({ fetch: async (url) => {
    const path = new URL(String(url)).pathname; return json(path.includes("top_") ? { list: [] } : replies[path]);
  } }));
  assert.match(empty.observations[3]!.finding.explanation, /0 unique holders/);
  assert.doesNotMatch(empty.observations[3]!.finding.explanation, /no risk|safe/i);
  for (const response of [() => new Response("x".repeat(500_001)), () => new Response("not json"), () => json(null)]) {
    const result = await collectGmgn(token, fixture({ fetch: async () => response() }));
    assert.equal(result.observations.length, 0); assert.equal(result.limitations.length, 1);
  }
  const partial = await collectGmgn(token, fixture({ fetch: async (url) => {
    const path = new URL(String(url)).pathname;
    return json(path.includes("top_") ? { list: Array.from({ length: 101 }, () => ({ address: wallet(2) })) } : replies[path]);
  } }));
  assert.equal(partial.observations.length, 3); assert.equal(partial.limitations.length, 2);
});

test("concurrent GMGN investigations stay within five weight units in every rolling second", { timeout: 10_000 }, async () => {
  const arrivals: { at: number; weight: number }[] = [];
  const options: GmgnOptions = { apiKey: "fixture-secret", fetch: async (url) => {
    const path = new URL(String(url)).pathname;
    arrivals.push({ at: Date.now(), weight: path.includes("top_") ? 5 : 1 }); return json(replies[path]);
  } };
  const results = await Promise.all([collectGmgn(token, options), collectGmgn(token, options)]);
  assert.ok(results.every((result) => result.observations.length === 5));
  for (const arrival of arrivals) {
    assert.ok(arrivals.filter((item) => item.at > arrival.at - 1000 && item.at <= arrival.at).reduce((sum, item) => sum + item.weight, 0) <= 5);
  }
});

test("GMGN skips unconfigured inputs and stops on auth or rate failures without leaking upstream messages", async () => {
  const noRequest = fixture({ fetch: async () => { throw new Error("Must not request"); } });
  assert.equal((await collectGmgn(token, { ...noRequest, apiKey: "" })).observations.length, 0);
  assert.equal((await collectGmgn(undefined, noRequest)).observations.length, 0);
  assert.equal((await collectGmgn({ ...token, chainId: 999 }, noRequest)).observations.length, 0);
  for (const status of [401, 403, 429]) {
    let calls = 0;
    const result = await collectGmgn(token, fixture({ fetch: async () => { calls++; return new Response("fixture-secret", { status }); } }));
    assert.equal(calls, 1); assert.equal(result.observations.length, 0); assert.ok(!JSON.stringify(result).includes("fixture-secret"));
  }
});

test("GMGN incremental evidence remains valid and never promotes failed independent checks", async () => {
  const discovery = await discoverWebsite({ links: ["https://example.com"], token }, {}, async (url) => ({
    requestedUrl: url, finalUrl: url, status: 200, contentType: "text/html", body: Buffer.from("<title>Example</title>"),
    capturedAt: new Date().toISOString(), redirects: [] }));
  const snapshots: CollectionResult[] = [];
  const result = await collectProject(discovery.investigation.subject, discovery, undefined, {
    getJson: async () => { throw new Error("offline"); }, rpc: async () => { throw new Error("offline"); }, gmgn: fixture(),
    onPartial: (value) => { snapshots.push(value); },
  });
  const merge = (value: CollectionResult) => investigationSchema.parse({ ...discovery.investigation,
    checks: value.checks, findings: [...discovery.investigation.findings, ...value.findings], evidence: [...discovery.investigation.evidence, ...value.evidence] });
  for (const value of snapshots) merge(value);
  const investigation = merge(result);
  assert.equal(investigation.findings.filter((finding) => finding.id.startsWith("gmgn-")).length, 5);
  assert.equal(investigation.checks.find((check) => check.area === "contract_control")!.status, "blocked");
  assert.equal(investigation.checks.find((check) => check.area === "activity_quality")!.status, "blocked");
  assert.ok(snapshots.some((value) => value.findings.some((finding) => finding.id.startsWith("gmgn-info-"))));
  const presentation = buildPresentation(investigation);
  assert.ok(presentation.sections.find((section) => section.id === "purpose")!.items.some((item) => /Data from GMGN/.test(item.text)));
  assert.ok(presentation.sections.find((section) => section.id === "money_flow")!.items.some((item) => /Data from GMGN/.test(item.text)));
  assert.deepEqual(investigation.subject.links, ["https://example.com/"]);
});
