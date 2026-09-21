import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseEnv } from "node:util";
import { captureEvidence, tokenSchema, type Evidence, type Investigation } from "./investigation.ts";

const origin = "https://openapi.gmgn.ai";
const chains: Record<number, string> = { 1: "eth", 8453: "base", 4663: "robinhood" };
const routes = { info: "/v1/token/info", security: "/v1/token/security", pool: "/v1/token/pool_info",
  holders: "/v1/market/token_top_holders", traders: "/v1/market/token_top_traders" } as const;
type Kind = keyof typeof routes;
type ObjectData = Record<string, unknown>;
export type GmgnObservation = { evidence: Evidence; finding: Investigation["findings"][number] };
export type GmgnOptions = { apiKey?: string; fetch?: typeof fetch; schedule?: (weight: number) => Promise<void> };
const limits = ["Data from GMGN is a third-party indexer observation, not an independent verification. Missing values mean unknown.",
  "GMGN data is captured at request time and is not pinned to our RPC snapshot. Website, social and launchpad metadata do not establish official project identity.",
  "Wallet labels and shared funding do not prove common ownership, manipulation or fraud. Pools, exchanges and protocol contracts can dominate holder rankings."];
let nextRequestAt = 0, cooldownUntil = 0;
async function schedule(weight: number) {
  const now = Date.now(), start = Math.max(now, nextRequestAt) + weight * 220;
  if (now < cooldownUntil || start - now > 10_000) throw new Error("GMGN rate budget unavailable; try a later investigation");
  // Five weight units per second, shared across investigations, with a small margin.
  nextRequestAt = start;
  if (start > now) await delay(start - now);
  if (Date.now() < cooldownUntil) throw new Error("GMGN is cooling down after a rate limit");
}
function apiKey() {
  if (process.env.GMGN_API_KEY !== undefined) return process.env.GMGN_API_KEY.trim();
  try { return parseEnv(readFileSync(join(homedir(), ".config/gmgn/.env"), "utf8")).GMGN_API_KEY?.trim() ?? ""; }
  catch { return ""; }
}
/** Sidebar status uses the collector's credential resolution without exposing any part of the key. */
export function gmgnConfiguration() {
  const configured = Boolean(apiKey());
  return { configured, source: process.env.GMGN_API_KEY !== undefined ? "environment" : configured ? "global_config" : "none" };
}
const object = (value: unknown): ObjectData => value && typeof value === "object" && !Array.isArray(value) ? value as ObjectData : {};
const text = (value: unknown, max = 160) => typeof value === "string" && value.trim() ? value.trim().slice(0, max) : null;
const address = (value: unknown) => typeof value === "string" && /^0x[a-fA-F0-9]{40}$/.test(value) ? value.toLowerCase() : null;
const numeric = (value: unknown) => (typeof value === "number" || typeof value === "string" && /^\d+(\.\d+)?$/.test(value))
  && Number.isFinite(Number(value)) && Number(value) >= 0 ? String(value) : null;
const ratio = (value: unknown) => numeric(value) !== null && Number(value) <= 1 ? Number(value) : null;
const percent = (value: unknown) => ratio(value) === null ? "not reported" : `${(Number(value) * 100).toFixed(2)}%`;
const flag = (value: unknown) => value === true || value === 1 || value === "yes" ? "yes"
  : value === false || value === 0 || value === "no" ? "no" : "unknown";
const tags = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && /^[a-zA-Z0-9_-]{1,60}$/.test(item)).slice(0, 20) : [];
function website(value: unknown) {
  const url = typeof value === "string" && value.length <= 2000 ? URL.parse(value) : null;
  return url && ["http:", "https:"].includes(url.protocol) && !url.username && !url.password ? url.href : null;
}
function normalize(kind: Kind, data: unknown, token: { chainId: number; address: string }): ObjectData {
  const row = object(data), chain = chains[token.chainId]!;
  if (row.chain !== undefined && row.chain !== chain || row.chain_id !== undefined && String(row.chain_id) !== String(token.chainId)) throw new Error("GMGN returned a different chain");
  if (["info", "security", "pool"].includes(kind) && address(kind === "pool" ? row.base_address ?? row.address : row.address) !== token.address) {
    throw new Error("GMGN returned a different or missing token address");
  }
  if (kind === "info") {
    const link = object(row.link), username = text(link.twitter_username);
    return { metadata: { name: text(row.name), symbol: text(row.symbol), logoUrl: website(row.logo), tokenAddress: address(row.address),
      chain, chainId: token.chainId, chainBasis: "Requested network; not independent chain verification",
      launchpad: text(row.launchpad), launchpadPlatform: text(row.launchpad_platform), website: website(link.website),
      twitter: username && /^@?[A-Za-z0-9_]{1,15}$/.test(username) ? `https://x.com/${username.replace(/^@/, "")}` : null },
      holderCount: numeric(row.holder_count), liquidityUsd: numeric(row.liquidity), top10SupplyShare: ratio(object(row.stat).top_10_holder_rate) };
  }
  if (kind === "security") return { tokenAddress: address(row.address), honeypot: flag(row.is_honeypot ?? row.honeypot),
    sourceVerified: flag(row.is_open_source ?? row.open_source), ownershipRenounced: flag(row.is_renounced ?? row.renounced ?? row.owner_renounced),
    buyTax: ratio(row.buy_tax), sellTax: ratio(row.sell_tax), top10SupplyShare: ratio(row.top_10_holder_rate), privileges: tags(row.privileges) };
  if (kind === "pool") return { tokenAddress: token.address, poolAddress: address(row.pool_address), exchange: text(row.exchange),
    quoteAddress: address(row.quote_address), quoteSymbol: text(row.quote_symbol), liquidityUsd: numeric(row.liquidity), createdAtUnix: numeric(row.creation_timestamp) };
  if (!Array.isArray(row.list) || row.list.length > 100) throw new Error("GMGN returned an unsupported wallet list");
  const wallets = new Map<string, ObjectData>();
  for (const item of row.list) {
    const wallet = object(item), id = address(wallet.address);
    if (!id) throw new Error("GMGN returned an invalid wallet address");
    const funding = object(wallet.native_transfer);
    wallets.set(id, { address: id, supplyShare: ratio(wallet.amount_percentage), balance: numeric(wallet.balance),
      addressType: numeric(wallet.addr_type) !== null && [0, 1, 2].includes(Number(wallet.addr_type)) ? Number(wallet.addr_type) : null,
      tags: [...new Set([...tags(wallet.tags), ...tags(wallet.maker_token_tags)])],
      buyCount: numeric(wallet.buy_tx_count_cur), sellCount: numeric(wallet.sell_tx_count_cur),
      funding: { address: address(funding.from_address ?? funding.address), timestamp: numeric(funding.timestamp), transaction: text(funding.tx_hash) } });
  }
  const fundingGroups = new Map<string, string[]>();
  for (const wallet of wallets.values()) {
    const funder = object(wallet.funding).address;
    if (typeof funder === "string") fundingGroups.set(funder, [...(fundingGroups.get(funder) ?? []), String(wallet.address)]);
  }
  return { sampleLimit: 100, wallets: [...wallets.values()], fundingCoverage: [...wallets.values()].filter((wallet) => object(wallet.funding).address).length,
    sharedFunding: [...fundingGroups].filter(([, members]) => members.length > 1).map(([funder, members]) => ({ funder, wallets: members })) };
}
function observation(kind: Kind, data: ObjectData, sourceUrl: string, token: { chainId: number; address: string }): GmgnObservation {
  const evidence = captureEvidence({ id: randomUUID(), role: "observation", medium: "api", sourceUrl,
    capturedAt: new Date().toISOString(), toolVersion: "mydevsaid-gmgn/0.1.0", method: `Data from GMGN: bounded ${kind} query; normalized allowlisted fields; no project links followed`,
    content: JSON.stringify({ provider: "GMGN", attribution: "Data from GMGN", kind, requestedToken: token, data, limitations: limits }) });
  let explanation: string;
  if (kind === "info") {
    const m = object(data.metadata);
    explanation = `Data from GMGN: ${m.name ?? "Name not reported"} (${m.symbol ?? "symbol not reported"}). Requested chain: ${m.chain} (${m.chainId}); token: ${m.tokenAddress}. Launchpad: ${m.launchpadPlatform ?? m.launchpad ?? "not reported"}. Website: ${m.website ?? "not reported"}. Twitter: ${m.twitter ?? "not reported"}. These metadata links are unverified.`;
  } else if (kind === "security") explanation = `Data from GMGN: honeypot flag: ${data.honeypot}; source verified: ${data.sourceVerified}; ownership renounced: ${data.ownershipRenounced}; buy tax: ${percent(data.buyTax)}; sell tax: ${percent(data.sellTax)}. Reported privileges: ${(data.privileges as string[]).join(", ") || "not reported"}. These provider signals require independent verification.`;
  else if (kind === "pool") explanation = `Data from GMGN: exchange: ${data.exchange ?? "not reported"}; pool: ${data.poolAddress ?? "not reported"}; reported liquidity: ${data.liquidityUsd === null ? "not reported" : `$${data.liquidityUsd}`}; quote asset: ${data.quoteSymbol ?? "not reported"}. Pool availability does not establish withdrawal safety.`;
  else explanation = `Data from GMGN: ${(data.wallets as unknown[]).length} unique ${kind} returned from a sample capped at 100. Funding sources were available for ${data.fundingCoverage}. Shared funding groups in this sample: ${(data.sharedFunding as unknown[]).length}. These are sampled indexer records, not proof of independent users or coordinated ownership.`;
  return { evidence, finding: { id: `gmgn-${kind}-${randomUUID()}`, area: kind === "info" ? "web_presence" : kind === "security" ? "contract_control" : "activity_quality",
    claim: `Data from GMGN: ${kind === "info" ? "token metadata" : kind}`, status: "unverified", severity: "informational", explanation,
    impact: "Use this attributed provider data to guide further checks; it does not verify project identity or technical legitimacy.",
    claimEvidenceIds: [], supportingEvidenceIds: [evidence.id], contradictingEvidenceIds: [], limitations: limits } };
}

/** Credentials go only to fixed GMGN read endpoints. Remote metadata never chooses tools or request destinations. */
export async function collectGmgn(input: { chainId: number; address: string } | undefined, options: GmgnOptions = {},
  onObservation: (value: GmgnObservation) => void = () => {}): Promise<{ observations: GmgnObservation[]; limitations: string[] }> {
  const result: { observations: GmgnObservation[]; limitations: string[] } = { observations: [], limitations: [] };
  if (!input) return { ...result, limitations: ["GMGN metadata requires a confirmed chain and token address; names alone are not resolved."] };
  const token = tokenSchema.parse(input), chain = chains[token.chainId], key = options.apiKey ?? apiKey();
  if (!chain || !key) return { ...result, limitations: [!chain ? "GMGN: this chain is not configured" : "GMGN: no API key configured; enrichment was not run"] };
  for (const kind of Object.keys(routes) as Kind[]) {
    try {
      await (options.schedule ?? schedule)(kind === "holders" || kind === "traders" ? 5 : 1);
      const url = new URL(routes[kind], origin);
      url.search = new URLSearchParams({ chain, address: token.address, ...(["holders", "traders"].includes(kind) ? { limit: "100", order_by: "amount_percentage", direction: "desc" } : {}) }).toString();
      const sourceUrl = url.href;
      url.searchParams.set("timestamp", String(Math.floor(Date.now() / 1000))); url.searchParams.set("client_id", randomUUID());
      const response = await (options.fetch ?? fetch)(url, { method: "GET", redirect: "error", signal: AbortSignal.timeout(8000),
        headers: { "X-APIKEY": key, Accept: "application/json", "User-Agent": "mydevsaid/0.1" } });
      if (response.status === 429) {
        await response.body?.cancel();
        const reset = Number(response.headers.get("x-ratelimit-reset")) * 1000;
        cooldownUntil = Math.max(cooldownUntil, Math.min(Date.now() + 900_000, Math.max(Date.now() + 300_000, Number.isFinite(reset) ? reset : 0)));
        result.limitations.push("GMGN rate limit reached; remaining queries skipped without retrying"); break;
      }
      if (!response.ok) { await response.body?.cancel(); result.limitations.push(`GMGN ${kind}: HTTP ${response.status}; data unavailable`); if (kind === "info" || [401, 403].includes(response.status)) break; else continue; }
      const reader = response.body?.getReader(); if (!reader) throw new Error("Missing response");
      const chunks: Uint8Array[] = []; let bytes = 0;
      try { for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.byteLength;
        if (bytes > 500_000) throw new Error("Response budget exceeded"); chunks.push(next.value); } }
      finally { await reader.cancel(); }
      const envelope = object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (envelope.code !== 0) {
        result.limitations.push(`GMGN ${kind}: provider returned an error; data unavailable`);
        if (envelope.code === 429) cooldownUntil = Math.max(cooldownUntil, Date.now() + 300_000);
        if (kind === "info" || [401, 403, 429].includes(Number(envelope.code))) break; else continue;
      }
      const entry = observation(kind, normalize(kind, envelope.data, token), sourceUrl, token);
      result.observations.push(entry); onObservation(entry);
    } catch {
      result.limitations.push(`GMGN ${kind}: response unavailable, mismatched or outside collection limits`);
      if (kind === "info") break;
    }
  }
  return result;
}
