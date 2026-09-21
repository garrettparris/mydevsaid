import assert from "node:assert/strict";
import test from "node:test";
import { discoverWebsite } from "./discovery.ts";
import { inventoryContracts } from "./contract-inventory.ts";

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const token = { chainId: 1, address: address(1) };
async function discover(body: string) {
  return discoverWebsite({ links: ["https://example.com"], token }, { maxPages: 1 }, async (url) => ({
    requestedUrl: url, finalUrl: url, status: 200, contentType: "text/html", body: Buffer.from(body),
    capturedAt: "2026-09-15T00:00:00Z", redirects: [],
  }));
}
const link = (n: number, label: string, host = "etherscan.io") => `<p>${label} <a href="https://${host}/address/${address(n)}">${address(n)}</a></p>`;

test("Related candidates require matching-chain links and preserve excluded modules", async () => {
  const d = await discover(link(1, "Token") + link(2, "Other", "basescan.org") + `<p>Unlinked ${address(3)}</p>` + link(4, "Safe") + link(5, "Treasury"));
  const result = inventoryContracts(d, token, 4);
  assert.deepEqual(result.candidates.filter(c => c.selected).map(c => c.address), [address(4), address(5)]);
  assert.match(result.candidates.find(c => c.address === address(2))!.reason, /another chain/);
  assert.match(result.candidates.find(c => c.address === address(3))!.reason, /No supported explorer/);
  assert.equal(result.candidates.find(c => c.address === address(1))!.selected, false);
  assert.ok(result.candidates.every(c => c.sourceEvidenceIds.includes(d.pages[0]!.evidenceId)));
});

test("Four-address budget prioritizes control and core roles without treating labels as facts", async () => {
  const d = await discover(link(2, "Peripheral") + link(3, "Treasury") + link(4, "Staking") + link(5, "BondDepository") + link(6, "Team multisig (Safe)") + link(7, "Safe"));
  const result = inventoryContracts(d, token, 4);
  assert.deepEqual(result.candidates.filter(c => c.selected).map(c => c.address), [address(6), address(7), address(3), address(4)]);
  assert.equal(result.candidates.filter(c => !c.selected).length, 2);
  assert.match(result.limitations.join(" "), /do not prove/);
  assert.equal(inventoryContracts(d, token, 0).candidates.filter(c => c.selected).length, 0);
});

test("Inventory deduplicates candidates, bounds context and reports discovery truncation", async () => {
  const d = await discover(link(2, "X".repeat(500)) + link(2, "Again"));
  d.pages[0]!.addressesTruncated = true;
  const result = inventoryContracts(d, token, 4);
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0]!.context.length, 100);
  assert.equal(result.candidates[0]!.sourceEvidenceIds.length, 1);
  assert.equal(result.truncated, true);
});


test("Nearby mention of Safe does not promote a separately named vault", async () => {
  const d = await discover(link(2, "Pending the Safe allocator grant. Contract Address Credit vault") + link(3, "Treasury") + link(4, "Staking") + link(5, "BondDepository (primary offerings)") + link(6, "Team multisig (Safe)"));
  assert.deepEqual(inventoryContracts(d, token, 4).candidates.filter(c => c.selected).map(c => c.address), [address(6), address(3), address(4), address(5)]);
});
