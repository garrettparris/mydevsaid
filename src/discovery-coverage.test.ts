import assert from "node:assert/strict";
import test from "node:test";
import { discoverWebsite } from "./discovery.ts";
import { inventoryContracts } from "./contract-inventory.ts";
import type { FetchedPage } from "./fetch-page.ts";

function page(url: string, html: string): FetchedPage {
  return { requestedUrl: url, finalUrl: url, status: 200, contentType: "text/html", capturedAt: "2026-09-15T12:00:00.000Z", redirects: [], body: Buffer.from(html) };
}

test("technical pages outrank generic docs and feed discovered contracts into the inventory", async () => {
  const address = `0x${"ab".repeat(20)}`, requested: string[] = [];
  const discovery = await discoverWebsite({ links: ["https://project.example/"] }, { maxPages: 2 }, async url => {
    requested.push(url);
    return page(url, url.endsWith("/contracts") ? `<p>Treasury ${address}</p><a href="https://etherscan.io/address/${address}">Treasury</a>`
      : '<a href="/docs">Docs</a><a href="/contracts">Contracts</a><a href="/integrations">Integrations</a>');
  });
  assert.deepEqual(requested, ["https://project.example/", "https://project.example/contracts"]);
  assert.deepEqual(discovery.budget.remainingUrls, ["https://project.example/integrations", "https://project.example/docs"]);
  const inventory = inventoryContracts(discovery, { address: `0x${"cd".repeat(20)}`, chainId: 1 }, 4);
  assert.equal(inventory.candidates[0]?.address, address); assert.equal(inventory.candidates[0]?.selected, true);
  const parsed = JSON.parse(discovery.investigation.evidence[1]!.content);
  assert.equal(parsed.navigation.find((item: { url: string }) => item.url.endsWith("/contracts")).sourceUrl, "https://project.example/");
  assert.match(discovery.limitations[0]!, /2 queued URLs remain unvisited/);
});

test("all explicit seeds take precedence over discovered links", async () => {
  const requested: string[] = [];
  await discoverWebsite({ links: ["https://project.example/", "https://second.example/"] }, { maxPages: 2 }, async url => {
    requested.push(url); return page(url, '<a href="/contracts">Contracts</a>');
  });
  assert.deepEqual(requested, ["https://project.example/", "https://second.example/"]);
});

test("navigation records exclusions and does not follow unrelated external or action links", async () => {
  const requested: string[] = [];
  const discovery = await discoverWebsite({ links: ["https://docs.project.example/"] }, { maxPages: 5 }, async url => {
    requested.push(url);
    return page(url, '<a href="/logout">Docs</a><a href="/delete">Docs</a><a href="/docs?execute=1">Docs</a><a href="/audit.pdf">Audit</a><a href="https://unrelated.example/contracts">Contracts</a>');
  });
  assert.equal(requested.length, 1);
  const parsed = JSON.parse(discovery.investigation.evidence[1]!.content);
  assert.equal(parsed.navigation.length, 5);
  assert.ok(parsed.navigation.every((item: { eligible: boolean; reason: string }) => !item.eligible && item.reason));
  assert.match(discovery.limitations[0]!, /5 unique linked URLs were excluded/);
});

test("failed technical pages spend the budget without masquerading as completed coverage", async () => {
  const discovery = await discoverWebsite({ links: ["https://project.example/"] }, { maxPages: 2 }, async url => {
    if (url.endsWith("/deployments")) throw new Error("Unavailable");
    return page(url, '<a href="/deployments">Deployments</a><a href="/architecture">Architecture</a>');
  });
  assert.equal(discovery.pages.length, 1); assert.equal(discovery.failures.length, 1);
  assert.equal(discovery.budget.attemptedPages, 2);
  assert.deepEqual(discovery.budget.remainingUrls, ["https://project.example/architecture"]);
  assert.match(discovery.limitations[0]!, /1 attempts failed/);
});
