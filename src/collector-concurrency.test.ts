import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as nextTurn } from "node:timers/promises";
import { collectOnchain, type Rpc } from "./onchain.ts";
import { collectRelatedContracts } from "./related-contracts.ts";

const address = (digit: string) => `0x${digit.repeat(40)}`;
const block = { number: "0x100", hash: `0x${"a".repeat(64)}` };
const zero = `0x${"0".repeat(64)}`;
const fixture: Rpc = async (_url, method) => {
  if (method === "eth_chainId") return "0x1";
  if (method === "eth_getBlockByNumber") return block;
  if (method === "eth_getCode") return "0x6000";
  return zero;
};

test("token reads overlap in bounded batches and settle before snapshot revalidation", async () => {
  let active = 0, peak = 0, finalChecks = 0;
  const result = await collectOnchain({ chainId: 1, address: address("1") }, async (url, method, params) => {
    if (method === "eth_getBlockByNumber" && params[0] !== "latest") { assert.equal(active, 0); finalChecks++; }
    const read = ["eth_getStorageAt", "eth_call"].includes(method);
    if (read) {
      assert.equal(params.at(-1), block.number);
      active++; peak = Math.max(peak, active); await nextTurn(); active--;
      if (method === "eth_call" && (params[0] as { data: string }).data === "0x8da5cb5b") throw new Error("Unavailable owner interface");
    }
    return fixture(url, method, params);
  });
  assert.equal(peak, 3); assert.equal(finalChecks, 1);
  assert.equal(Object.keys(result.slots).length, 3);
  assert.equal(result.calls.totalSupply, zero);
  assert.equal(result.calls.owner, null);
  assert.ok(result.gaps.includes("owner() did not return a supported value"));
});

test("four related contracts overlap while preserving order, request budget and final guards", async () => {
  const chain = await collectOnchain({ chainId: 1, address: address("1") }, fixture);
  const candidates = ["2", "3", "4", "5"].map(digit => ({ address: address(digit) }));
  let active = 0, peak = 0, requests = 0, guards = 0, reads = 0;
  const result = await collectRelatedContracts(chain, candidates, async (url, method, params) => {
    requests++;
    if (["eth_chainId", "eth_getBlockByNumber"].includes(method)) {
      assert.equal(active, 0); guards++;
      if (guards > 2) assert.equal(reads, 16);
    } else {
      assert.equal(params.at(-1), block.number); active++; peak = Math.max(peak, active);
      await nextTurn(); active--; reads++;
    }
    return fixture(url, method, params);
  });
  assert.equal(peak, 4); assert.equal(guards, 4); assert.equal(requests, 20);
  assert.deepEqual(result.contracts.map(item => item.address), candidates.map(item => item.address));
  assert.ok(result.contracts.every(item => item.records.length === 4));
  assert.equal(result.records.length, 20);
});
