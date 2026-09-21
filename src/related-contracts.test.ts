import test from "node:test";
import assert from "node:assert/strict";
import { collectRelatedContracts, decodeOwners } from "./related-contracts.ts";
import type { ChainObservation, Rpc } from "./onchain.ts";

const address = (digit: string) => `0x${digit.repeat(40)}`;
const uint = (value: number | bigint) => BigInt(value).toString(16).padStart(64, "0");
const ownersAbi = (owners: string[]) => `0x${uint(32)}${uint(owners.length)}${owners.map(owner => owner.slice(2).padStart(64, "0")).join("")}`;
const ownerList = [address("a"), address("b"), address("c")];
const chain: ChainObservation = {
  snapshot: { chainId: 1, address: address("1"), blockNumber: "256", blockHash: `0x${"a".repeat(64)}` },
  blockTag: "0x100", bytecode: "0x6000", slots: {}, calls: {}, implementationCode: null,
  records: [], gaps: [], sourceUrl: "https://etherscan.io/address/example", providerHost: "example.invalid",
  implementation: null, ownerCandidate: null, adminCandidate: null,
};
const fixture: Rpc = async (_url, method, params) => {
  if (method === "eth_chainId") return "0x1";
  if (method === "eth_getBlockByNumber") return { number: chain.blockTag, hash: chain.snapshot.blockHash };
  if (method === "eth_getCode") return "0x6000";
  if (method === "eth_call") {
    const call = params[0] as { data: string };
    if (call.data === "0x8da5cb5b") return `0x${address("d").slice(2).padStart(64, "0")}`;
    if (call.data === "0xe75235b8") return `0x${uint(2)}`;
    if (call.data === "0xa0e67e2b") return ownersAbi(ownerList);
  }
  throw new Error("Unexpected method");
};
const overrideCall = (selector: string, value: unknown): Rpc => async (url, method, params) =>
  method === "eth_call" && (params[0] as { data: string }).data === selector ? value : fixture(url, method, params);

test("related contracts observe a 2-of-3 fixture at the original block with bounded gas", async () => {
  const result = await collectRelatedContracts(chain, [{ address: address("2") }], async (url, method, params) => {
    if (method === "eth_call") {
      assert.equal((params[0] as { gas: string }).gas, "0x186a0");
      assert.equal(params[1], chain.blockTag);
    }
    if (method === "eth_getCode") assert.equal(params[1], chain.blockTag);
    if (method === "eth_getBlockByNumber") assert.deepEqual(params, [chain.blockTag, false]);
    return fixture(url, method, params);
  });
  const contract = result.contracts[0]!;
  assert.equal(contract.kind, "related_contract");
  assert.deepEqual(contract.safeConfiguration, { threshold: 2, owners: ownerList });
  assert.equal(contract.ownerCandidate, address("d"));
  assert.equal(contract.snapshot.blockHash, chain.snapshot.blockHash);
  assert.equal(contract.snapshot.address, address("2"));
  assert.equal(contract.sourceUrl, `https://etherscan.io/address/${address("2")}`);
  assert.equal(contract.records.length, 4);
  assert.equal(result.records.length, 8);
  assert.match(contract.gaps.join(" "), /do not prove Safe identity/);
  assert.match(contract.gaps.join(" "), /Modules, guards/);
});

test("ABI decoder rejects noncanonical or excessive arrays without trusting their count", () => {
  assert.deepEqual(decodeOwners(ownersAbi(ownerList)), ownerList);
  const invalid = [null, "0x", "garbage", ownersAbi([]), ownersAbi([address("0")]), ownersAbi([address("a"), address("a")]),
    `0x${uint(64)}${ownersAbi(ownerList).slice(66)}`, `0x${uint(32)}${"f".repeat(64)}${uint(1)}`,
    `${ownersAbi(ownerList)}${uint(0)}`, ownersAbi(ownerList).slice(0, -2),
    `0x${uint(32)}${uint(1)}${"f".repeat(24)}${"a".repeat(40)}`,
    ownersAbi(Array.from({ length: 21 }, (_, index) => `0x${(index + 1).toString(16).padStart(40, "0")}`))];
  for (const value of invalid) assert.equal(decodeOwners(value), null);
});

test("invalid thresholds and missing ABI never become a Safe-compatible configuration", async () => {
  for (const value of [`0x${uint(0)}`, `0x${uint(4)}`, `0x${"f".repeat(64)}`, "0x", "0x02"]) {
    const result = await collectRelatedContracts(chain, [{ address: address("2") }], overrideCall("0xe75235b8", value));
    assert.equal(result.contracts[0]!.safeConfiguration, null);
    assert.match(result.contracts[0]!.gaps.join(" "), /could not be established/);
  }
  const missingOwners = await collectRelatedContracts(chain, [{ address: address("2") }], overrideCall("0xa0e67e2b", "0x"));
  assert.equal(missingOwners.contracts[0]!.safeConfiguration, null);
});

test("bytecode failures stay unknown, provider errors stay private, and later contracts still run", async () => {
  const result = await collectRelatedContracts(chain, [{ address: address("2") }, { address: address("3") }], async (url, method, params) => {
    if (method === "eth_getCode" && params[0] === address("2")) throw new Error("https://secret.provider/api-key-secret");
    return fixture(url, method, params);
  });
  assert.equal(result.contracts[0]!.bytecode, null);
  assert.equal(result.contracts[0]!.safeConfiguration, null);
  assert.equal(result.contracts[0]!.records.length, 1);
  assert.match(result.contracts[0]!.gaps.join(" "), /cannot be classified/);
  assert.equal(result.contracts[1]!.safeConfiguration?.threshold, 2);
  assert.doesNotMatch(JSON.stringify(result), /secret.provider|api-key-secret/);
});

test("empty bytecode skips ABI calls without claiming externally owned account identity", async () => {
  const result = await collectRelatedContracts(chain, [{ address: address("2") }], async (url, method, params) =>
    method === "eth_getCode" ? "0x" : fixture(url, method, params));
  assert.equal(result.contracts[0]!.bytecode, "0x");
  assert.equal(result.contracts[0]!.records.length, 1);
  assert.equal(result.contracts[0]!.safeConfiguration, null);
  assert.doesNotMatch(result.contracts[0]!.gaps.join(" "), /externally owned|EOA/);
});

test("both chain checks reject a mismatched provider", async () => {
  for (const failAt of [1, 2]) {
    let calls = 0;
    await assert.rejects(collectRelatedContracts(chain, [{ address: address("2") }], async (url, method, params) => {
      if (method === "eth_chainId" && ++calls === failAt) return "0x2105";
      return fixture(url, method, params);
    }), /chain does not match/);
  }
});

test("both snapshot guards reject changed block hashes or numbers", async () => {
  for (const failAt of [1, 2]) for (const changed of [{ hash: `0x${"b".repeat(64)}` }, { number: "0x101" }]) {
    let calls = 0;
    await assert.rejects(collectRelatedContracts(chain, [{ address: address("2") }], async (url, method, params) => {
      if (method === "eth_getBlockByNumber" && ++calls === failAt) return { number: chain.blockTag, hash: chain.snapshot.blockHash, ...changed };
      return fixture(url, method, params);
    }), /snapshot changed/);
  }
  await assert.rejects(collectRelatedContracts({ ...chain, blockTag: "0x101" }, [{ address: address("2") }], fixture), /snapshot is invalid/);
});

test("selection normalizes, excludes the token, zeros and invalid addresses, and never exceeds20 calls", async () => {
  const candidates = [address("2"), address("3"), address("4"), address("5"), address("0"), address("1"), "invalid", address("2").toUpperCase().replace("0X", "0x")];
  let calls = 0;
  const result = await collectRelatedContracts(chain, candidates.map(address => ({ address })), async (...args) => {
    calls++;
    return fixture(...args);
  });
  assert.equal(result.contracts.length, 4);
  assert.equal(calls, 20);
  calls = 0;
  await assert.rejects(collectRelatedContracts(chain, [...candidates, address("6")].map(address => ({ address })), async (...args) => {
    calls++;
    return fixture(...args);
  }), /at most four/);
  assert.equal(calls, 0);
});

test("unsupported and oversized responses are recorded as unavailable rather than raw junk", async () => {
  const result = await collectRelatedContracts(chain, [{ address: address("2") }], overrideCall("0xa0e67e2b", `0x${"a".repeat(5000)}`));
  assert.equal(result.contracts[0]!.safeConfiguration, null);
  assert.equal(result.contracts[0]!.records.at(-1)!.result, undefined);
  assert.match(result.contracts[0]!.records.at(-1)!.error!, /bounded format/);
});
