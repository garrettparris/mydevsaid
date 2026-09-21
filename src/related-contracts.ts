import { addressWord, CHAIN_NETWORKS, rpcUrl, type ChainObservation, type Rpc, type RpcRecord } from "./onchain.ts";
import { postJsonRpc } from "./fetch-page.ts";

const ADDRESS = /^0x[a-f0-9]{40}$/i;
const WORD = /^0x[a-f0-9]{64}$/i;
const QUANTITY = /^0x(?:0|[1-9a-f][a-f0-9]*)$/i;
const MAX_CONTRACTS = 4;
const MAX_REQUESTS = 20;
const LIMITATIONS = [
  "Matching getOwners() and getThreshold() views do not prove Safe identity or which protocol permissions this address holds.",
  "Modules, guards, implementation identity, signer independence, and permission relationships were not checked.",
  "This is a read-only snapshot; owner() alone does not establish complete control or the absence of other privileged roles.",
];
// Official signatures: safe-global/safe-smart-account contracts/base/OwnerManager.sol.
const SELECTORS = { owner: "0x8da5cb5b", threshold: "0xe75235b8", owners: "0xa0e67e2b" };

/** Decode only canonical, bounded ABI address arrays; never allocate from an unchecked count. */
export function decodeOwners(value: unknown): string[] | null {
  if (typeof value !== "string" || value.length > 2 + 64 * 22 || !/^0x[a-f0-9]+$/i.test(value)
    || value.length < 2 + 64 * 3 || (value.length - 2) % 64 !== 0) return null;
  if (BigInt(`0x${value.slice(2, 66)}`) !== 32n) return null;
  const count = BigInt(`0x${value.slice(66, 130)}`);
  if (count < 1n || count > 20n || value.length !== 2 + 64 * (2 + Number(count))) return null;
  const owners: string[] = [];
  for (let index = 0; index < Number(count); index++) {
    const owner = addressWord(`0x${value.slice(130 + index * 64, 194 + index * 64)}`);
    if (!owner || owners.includes(owner)) return null;
    owners.push(owner);
  }
  return owners;
}

export type RelatedContractObservation = {
  kind: "related_contract";
  address: string;
  snapshot: ChainObservation["snapshot"];
  blockTag: string;
  sourceUrl: string;
  providerHost: string;
  bytecode: string | null;
  ownerCandidate: string | null;
  safeConfiguration: { threshold: number; owners: string[] } | null;
  records: RpcRecord[];
  gaps: string[];
};

/** Inspect at most four supplied addresses, on the token observation's exact canonical block. */
export async function collectRelatedContracts(chain: ChainObservation, candidates: { address: string }[], rpc: Rpc = postJsonRpc) {
  const addresses = [...new Set(candidates.map(({ address }) => address.toLowerCase()).filter(address =>
    ADDRESS.test(address) && !/^0x0{40}$/.test(address) && address !== chain.snapshot.address.toLowerCase()))];
  if (addresses.length > MAX_CONTRACTS) throw new Error("Related-contract collection accepts at most four unique addresses");
  if (!QUANTITY.test(chain.blockTag) || !/^\d+$/.test(chain.snapshot.blockNumber)
    || BigInt(chain.blockTag) !== BigInt(chain.snapshot.blockNumber) || !WORD.test(chain.snapshot.blockHash)) {
    throw new Error("Related-contract snapshot is invalid");
  }
  const records: RpcRecord[] = [];
  const contracts: RelatedContractObservation[] = [];
  const gaps: string[] = [];
  const result = { contracts, records, gaps, snapshot: chain.snapshot, blockTag: chain.blockTag };
  if (addresses.length === 0) return result;
  const url = rpcUrl(chain.snapshot.chainId);
  let providerHost: string;
  try { providerHost = new URL(url).hostname; }
  catch { throw new Error("Related-contract RPC configuration is invalid"); }
  let requests = 0;
  const request = async (method: string, params: unknown[], valid: (value: unknown) => boolean, local?: RpcRecord[]) => {
    if (++requests > MAX_REQUESTS) throw new Error("Related-contract request budget exceeded");
    let value: unknown;
    let error: string | undefined;
    try { value = await rpc(url, method, params); }
    catch { error = "Provider request failed or exceeded collection limits"; }
    if (!error && !valid(value)) error = "Provider response did not match the expected bounded format";
    // Only validated response data is persisted, never provider error text or oversized malformed output.
    const record: RpcRecord = error ? { method, params, error } : { method, params, result: value };
    records.push(record);
    local?.push(record);
    if (error) throw new Error(`${method} could not be collected`);
    return value;
  };
  const verifySnapshot = async () => {
    const actualChain = await request("eth_chainId", [], value => typeof value === "string" && value.length <= 66 && QUANTITY.test(value));
    if (BigInt(actualChain as string) !== BigInt(chain.snapshot.chainId)) throw new Error("Related-contract RPC chain does not match the submitted chain");
    const block = await request("eth_getBlockByNumber", [chain.blockTag, false], value => {
      if (!value || typeof value !== "object") return false;
      const candidate = value as Record<string, unknown>;
      return typeof candidate.number === "string" && candidate.number.length <= 66 && QUANTITY.test(candidate.number)
        && typeof candidate.hash === "string" && WORD.test(candidate.hash);
    }) as { number: string; hash: string };
    if (BigInt(block.number) !== BigInt(chain.snapshot.blockNumber) || block.hash.toLowerCase() !== chain.snapshot.blockHash.toLowerCase()) {
      throw new Error("Related-contract snapshot changed or does not match; rerun the investigation");
    }
  };
  await verifySnapshot();
  // At most four addresses in flight; each address keeps its dependent reads sequential.
  const observations = await Promise.all(addresses.map(async address => {
    const observation: RelatedContractObservation = {
      kind: "related_contract", address, snapshot: { ...chain.snapshot, address }, blockTag: chain.blockTag,
      sourceUrl: `${CHAIN_NETWORKS[chain.snapshot.chainId]!.explorer}/address/${address}`, providerHost,
      bytecode: null, ownerCandidate: null, safeConfiguration: null, records: [], gaps: [...LIMITATIONS],
    };
    const call = (selector: string, valid: (value: unknown) => boolean) => request("eth_call", [
      { to: address, data: selector, gas: "0x186a0" }, chain.blockTag,
    ], valid, observation.records);
    try {
      observation.bytecode = await request("eth_getCode", [address, chain.blockTag], value => typeof value === "string"
        && value.length <= 262146 && /^0x(?:[a-f0-9]{2})*$/i.test(value), observation.records) as string;
    } catch { observation.gaps.push("Bytecode was unavailable; this address cannot be classified as having or lacking deployed code."); }
    if (observation.bytecode && observation.bytecode !== "0x") {
      try {
        observation.ownerCandidate = addressWord(await call(SELECTORS.owner, value => typeof value === "string" && WORD.test(value)));
        if (!observation.ownerCandidate) observation.gaps.push("owner() did not return a nonzero canonical address; no ownership conclusion is available.");
      } catch { observation.gaps.push("owner() did not return a supported value."); }
      let threshold: bigint | null = null;
      let owners: string[] | null = null;
      try { threshold = BigInt(await call(SELECTORS.threshold, value => typeof value === "string" && WORD.test(value)) as string); }
      catch { observation.gaps.push("getThreshold() did not return a supported value."); }
      try { owners = decodeOwners(await call(SELECTORS.owners, value => decodeOwners(value) !== null)); }
      catch { observation.gaps.push("getOwners() did not return a canonical list of 1 to 20 unique nonzero addresses."); }
      if (owners && threshold !== null && threshold >= 1n && threshold <= BigInt(owners.length)) {
        observation.safeConfiguration = { threshold: Number(threshold), owners };
      } else { observation.gaps.push("A consistent Safe-compatible owner list and approval threshold could not be established."); }
    } else if (observation.bytecode === "0x") {
      observation.gaps.push("No deployed bytecode was returned at this block; contract view calls were skipped.");
    } else { observation.gaps.push("Contract view calls were skipped because bytecode was unavailable."); }
    return observation;
  }));
  await verifySnapshot();
  contracts.push(...observations);
  return result;
}
