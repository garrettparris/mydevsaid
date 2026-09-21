import { z } from "zod";
import { tokenSchema } from "./investigation.ts";
import { postJsonRpc } from "./fetch-page.ts";

export type Rpc = (url: string, method: string, params: unknown[]) => Promise<unknown>;
const quantity = z.string().regex(/^0x(?:0|[1-9a-f][a-f0-9]*)$/i);
const data = z.string().regex(/^0x(?:[a-f0-9]{2})*$/i);
const word = z.string().regex(/^0x[a-f0-9]{64}$/i);
const blockSchema = z.object({ number: quantity, hash: word });
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
export const PROXY_SLOTS = {
  implementation: "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc",
  admin: "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103",
  beacon: "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50",
} as const;

export const CHAIN_NETWORKS: Readonly<Record<number, { name: string; rpc: string; explorer: string }>> = {
  1: { name: "Ethereum", rpc: "https://ethereum-rpc.publicnode.com", explorer: "https://etherscan.io" },
  8453: { name: "Base", rpc: "https://base-rpc.publicnode.com", explorer: "https://basescan.org" },
  // Mainnet configuration: https://docs.robinhood.com/chain/connecting/
  4663: { name: "Robinhood Chain", rpc: "https://rpc.mainnet.chain.robinhood.com", explorer: "https://robinhoodchain.blockscout.com" },
};

export function rpcUrl(chainId: number): string {
  const network = CHAIN_NETWORKS[chainId];
  if (!network) throw new Error("Only Ethereum (1), Base (8453), and Robinhood Chain (4663) are supported by this collector");
  return process.env[`MYDEVSAID_RPC_${chainId}`] || network.rpc;
}

/** Invalid high bytes and zero words are not interpreted as addresses. */
export function addressWord(value: unknown): string | null {
  const parsed = word.safeParse(value);
  if (!parsed.success || !/^0x0{24}[a-f0-9]{40}$/i.test(parsed.data) || /^0x0{64}$/.test(parsed.data)) return null;
  return `0x${parsed.data.slice(-40).toLowerCase()}`;
}

export type RpcRecord = { method: string; params: unknown[]; result?: unknown; error?: string };

/** Inspects only the submitted address and one ERC-1967 implementation; never executes a transaction. */
export async function collectOnchain(input: z.infer<typeof tokenSchema>, rpc: Rpc = postJsonRpc) {
  const token = tokenSchema.parse(input);
  const url = rpcUrl(token.chainId);
  const records: RpcRecord[] = [];
  const request = async (method: string, params: unknown[]) => {
    try {
      const result = await rpc(url, method, params);
      records.push({ method, params, result });
      return result;
    } catch {
      // Provider URLs can contain server-side API keys; do not persist underlying error messages.
      records.push({ method, params, error: "Provider request failed or exceeded collection limits" });
      throw new Error(`${method} could not be collected`);
    }
  };
  const chain = quantity.parse(await request("eth_chainId", []));
  if (BigInt(chain) !== BigInt(token.chainId)) throw new Error("RPC provider chain does not match the submitted chain");
  const block = blockSchema.parse(await request("eth_getBlockByNumber", ["latest", false]));
  const snapshot = { ...token, blockNumber: BigInt(block.number).toString(), blockHash: block.hash.toLowerCase() };
  const bytecode = data.parse(await request("eth_getCode", [token.address, block.number]));
  const gaps: string[] = [];
  const slots: Record<string, string | null> = {};
  const calls: Record<string, string | null> = {};
  let implementationCode: string | null = null;
  if (bytecode !== "0x") {
    // Fixed-size batches keep provider concurrency at three or fewer reads.
    await Promise.all(Object.entries(PROXY_SLOTS).map(async ([name, slot]) => {
      try { slots[name] = word.parse(await request("eth_getStorageAt", [token.address, slot, block.number])); }
      catch { slots[name] = null; gaps.push(`ERC-1967 ${name} slot was unavailable`); }
    }));
    await Promise.all([["owner", "0x8da5cb5b"], ["totalSupply", "0x18160ddd"]].map(async ([name, selector]) => {
      try { calls[name!] = word.parse(await request("eth_call", [{ to: token.address, data: selector, gas: "0x186a0" }, block.number])); }
      catch { calls[name!] = null; gaps.push(`${name}() did not return a supported value`); }
    }));
    let implementation = addressWord(slots.implementation);
    const beacon = addressWord(slots.beacon);
    if (!implementation && beacon) {
      try {
        calls.beaconImplementation = word.parse(await request("eth_call", [{ to: beacon, data: "0x5c60da1b", gas: "0x186a0" }, block.number]));
        implementation = addressWord(calls.beaconImplementation);
      } catch { gaps.push("Beacon implementation() was unavailable"); }
    }
    if (implementation) {
      try { implementationCode = data.parse(await request("eth_getCode", [implementation, block.number])); }
      catch { gaps.push("Implementation bytecode could not be collected"); }
    }
  }
  const repeated = blockSchema.parse(await request("eth_getBlockByNumber", [block.number, false]));
  if (repeated.hash.toLowerCase() !== block.hash.toLowerCase()) throw new Error("Chain reorganized during collection; rerun the investigation");
  return {
    snapshot, blockTag: block.number, bytecode, slots, calls, implementationCode, records, gaps,
    sourceUrl: `${CHAIN_NETWORKS[token.chainId]!.explorer}/address/${token.address}`,
    providerHost: new URL(url).hostname,
    implementation: addressWord(slots.implementation) ?? addressWord(calls.beaconImplementation),
    ownerCandidate: addressWord(calls.owner), adminCandidate: addressWord(slots.admin),
  };
}

export type ChainObservation = Awaited<ReturnType<typeof collectOnchain>>;

/** Try 128, 16, then 2 blocks when providers reject or exceed bounds; record the actual covered range. */
export async function collectTransfers(chain: ChainObservation, rpc: Rpc = postJsonRpc) {
  const end = BigInt(chain.blockTag);
  const url = rpcUrl(chain.snapshot.chainId);
  const logsSchema = z.array(z.object({
    address: z.string().regex(/^0x[a-f0-9]{40}$/i), topics: z.array(word).min(1).max(4), data,
    blockNumber: quantity, blockHash: word, transactionHash: word, logIndex: quantity, removed: z.boolean().optional(),
  })).max(500);
  let logs: z.infer<typeof logsSchema> | undefined;
  let from = 0n;
  let params: { address: string; fromBlock: string; toBlock: string; topics: string[] }[] = [];
  const attempts: { fromBlock: string; toBlock: string; status: string }[] = [];
  for (const window of [128n, 16n, 2n]) {
    from = end >= window - 1n ? end - window + 1n : 0n;
    params = [{ address: chain.snapshot.address, fromBlock: `0x${from.toString(16)}`, toBlock: chain.blockTag, topics: [TRANSFER_TOPIC] }];
    try {
      logs = logsSchema.parse(await rpc(url, "eth_getLogs", params));
      attempts.push({ fromBlock: from.toString(), toBlock: end.toString(), status: "collected" });
      break;
    } catch { attempts.push({ fromBlock: from.toString(), toBlock: end.toString(), status: "unavailable or exceeded bounds" }); }
  }
  if (!logs) throw new Error("Activity queries could not be collected within the smallest bounded window");
  for (const log of logs) {
    if (log.address.toLowerCase() !== chain.snapshot.address || log.topics[0]?.toLowerCase() !== TRANSFER_TOPIC
      || log.removed || BigInt(log.blockNumber) < from || BigInt(log.blockNumber) > end) throw new Error("RPC returned logs outside the requested canonical window");
    if (BigInt(log.blockNumber) === end && log.blockHash.toLowerCase() !== chain.snapshot.blockHash) throw new Error("Activity block hash does not match the snapshot");
  }
  const finalBlock = blockSchema.parse(await rpc(url, "eth_getBlockByNumber", [chain.blockTag, false]));
  if (finalBlock.hash.toLowerCase() !== chain.snapshot.blockHash) throw new Error("Chain reorganized during activity collection");
  return { fromBlock: from.toString(), toBlock: end.toString(), logs, method: "eth_getLogs", params, attempts };
}
