import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { advanceScope, createScope } from "./scoping.ts";
import { Store } from "./store.ts";

const token = `0x${"a".repeat(40)}`;
test("new domain lookup coverage is visible and pinned while legacy paid scopes retain their lookup mode", () => {
  const store = new Store(":memory:");
  try {
    const created = store.createScope(`https://docs.example.com Ethereum ${token}`);
    assert.equal(created.scope.submission.domainLookup, "registrable_domain");
    assert.match(created.scope.included.join(" "), /one registration lookup.*registrable domain.*first submitted link/);
    assert.match(created.scope.excluded.join(" "), /shared-hosting suffix's registration details/);
    const locked = store.lockScope(created.scope.id, created.accessToken, created.scope.revision, false);
    assert.equal(locked.order.submission.domainLookup, "registrable_domain");
    assert.equal(locked.order.scope?.submission.domainLookup, "registrable_domain");
    locked.order.submission.domainLookup = "exact_host";
    assert.throws(() => store.saveOrder(locked.order), /paid scope cannot change/);
    for (const mode of [undefined, "exact_host"] as const) {
      const candidate = store.createScope(`https://docs.example.com Ethereum ${token}`);
      const legacy = structuredClone(candidate.scope);
      if (mode === undefined) delete legacy.submission.domainLookup; else legacy.submission.domainLookup = mode;
      legacy.included = legacy.included.filter((item) => !item.includes("registration lookup"));
      store.db.prepare("UPDATE scopes SET body=? WHERE id=?").run(JSON.stringify(legacy), legacy.id);
      const first = store.lockScope(legacy.id, candidate.accessToken, legacy.revision, false);
      const retry = store.lockScope(legacy.id, candidate.accessToken, legacy.revision, false);
      assert.equal(retry.order.id, first.order.id); assert.equal(retry.order.submission.domainLookup, mode);
      assert.equal(store.getScope(legacy.id, candidate.accessToken).submission.domainLookup, mode);
      retry.order.submission.domainLookup = "registrable_domain";
      assert.throws(() => store.saveOrder(retry.order), /paid scope cannot change/);
      assert.equal(store.getOrder(first.order.id)!.submission.domainLookup, mode);
      const revised = advanceScope(legacy, "Review domain registration", legacy.revision);
      assert.equal(revised.submission.domainLookup, "registrable_domain"); assert.equal(revised.revision, legacy.revision + 1);
    }
  } finally { store.close(); }
});

test("free scoping retains concerns and asks missing identity before a bounded quote", () => {
  const draft = createScope("https://example.com/ Please look at staking and treasury claims.");
  assert.equal(draft.status, "draft"); assert.equal(draft.questions.length, 2);
  const ready = advanceScope(draft, `Robinhood Chain ${token}`, draft.revision);
  assert.equal(ready.status, "ready"); assert.equal(ready.priceUsd, 100);
  assert.equal(ready.submission.token?.chainId, 4663);
  assert.match(ready.messages[0]!.content, /staking/);
  assert.equal(ready.mode, "deterministic");
  assert.match(draft.messages.at(-1)!.content, /I have not checked the project yet/);
  assert.match(ready.messages.at(-1)!.content, /Review it below/);
  assert.match(ready.included[0]!, /3 public pages/);
  assert.equal(draft.revision, 1);
  assert.throws(() => advanceScope(ready, "more", 1), /changed/);
});
test("scoping does not guess ambiguous networks or reuse an address on another chain", () => {
  let scope = createScope(`https://example.com/ Ethereum ${token}`);
  scope = advanceScope(scope, "Base", scope.revision);
  assert.equal(scope.status, "draft"); assert.equal(scope.submission.token, undefined);
  scope = advanceScope(scope, token, scope.revision);
  assert.equal(scope.submission.token?.chainId, 8453);
  scope = advanceScope(scope, "Ethereum or Robinhood", scope.revision);
  assert.equal(scope.status, "draft"); assert.equal(scope.selection.chainId, undefined);
  scope = advanceScope(scope, "chainId 46630", scope.revision);
  assert.match(scope.questions.join(" "), /not supported/);
  assert.equal(createScope(`https://example.com based on this ${token}`).selection.chainId, undefined);
});
test("scoping bounds messages, links and conversation length without fetching content", () => {
  assert.throws(() => createScope("a".repeat(2001)), /2,000/);
  assert.throws(() => createScope(`https://user:secret@example.com ${token}`), /credentials/);
  assert.throws(() => createScope(`0x${"0".repeat(40)}`), /zero/);
  assert.throws(() => createScope(Array.from({ length: 21 }, (_, i) => `https://example.com/${i}`).join(" ")), /20 links/);
  let scope = createScope("https://example.com");
  for (let i = 1; i < 12; i++) scope = advanceScope(scope, "more context", scope.revision);
  assert.throws(() => advanceScope(scope, "more", scope.revision), /12 messages/);
});
test("persisted capability recovery locks an immutable snapshot without storing bearer secrets", async () => {
  const dir = await mkdtemp(join(tmpdir(), "mydevsaid-scope-")), path = join(dir, "db.sqlite");
  let store = new Store(path);
  try {
    const created = store.createScope(`https://example.com Ethereum ${token}`);
    const locked = store.lockScope(created.scope.id, created.accessToken, created.scope.revision, false);
    assert.throws(() => store.updateScope(created.scope.id, created.accessToken, "change", 1), /locked/);
    locked.order.submission.links = ["https://changed.example/"];
    assert.throws(() => store.saveOrder(locked.order), /cannot change/);
    store.close(); store = new Store(path);
    const recovered = store.getScope(created.scope.id, created.accessToken);
    assert.equal(recovered.orderId, locked.order.id); assert.equal(recovered.status, "locked");
    const retry = store.lockScope(recovered.id, created.accessToken, recovered.revision, false);
    assert.equal(retry.accessToken, locked.accessToken); assert.equal(store.orders().length, 1);
    assert.throws(() => store.getScope(recovered.id, "wrong"), /access token/);
    const persisted = JSON.stringify(store.db.prepare("SELECT * FROM scopes").all()) + JSON.stringify(store.orders());
    assert.ok(!persisted.includes(created.accessToken)); assert.ok(!persisted.includes(locked.accessToken));
  } finally { store.close(); await rm(dir, { recursive: true, force: true }); }
});


test("an invalid token correction clears the previous ready identity until explicitly repaired", () => {
  for (const correction of ["replace token 0x123", `update address 0x${"0".repeat(40)}`, "change the token please"]) {
    const ready = createScope(`https://example.com Ethereum ${token}`);
    const corrected = advanceScope(ready, correction, ready.revision);
    assert.equal(corrected.status, "draft"); assert.equal(corrected.submission.token, undefined);
    assert.equal(corrected.selection.address, undefined); assert.match(corrected.questions.join(" "), /correction/);
    const repaired = advanceScope(corrected, token, corrected.revision);
    assert.equal(repaired.status, "ready"); assert.equal(repaired.submission.token?.address, token);
  }
});

test("the related-contract budget is visible before checkout and pinned with the paid scope", () => {
  const store = new Store(":memory:");
  try {
    const created = store.createScope(`https://example.com Ethereum ${token}`);
    assert.equal(created.scope.submission.relatedContractLimit, 4);
    assert.match(created.scope.included.join(" "), /up to 4 related addresses.*matching-chain explorers.*Safe-compatible approval thresholds and owner lists/);
    assert.match(created.scope.excluded.join(" "), /Comprehensive security and permission analysis.*full treasury or funder tracing/);
    const { order } = store.lockScope(created.scope.id, created.accessToken, created.scope.revision, false);
    assert.equal(order.submission.relatedContractLimit, 4);
    assert.equal(order.scope?.submission.relatedContractLimit, 4);
    assert.equal(order.payment, "pending");
    order.submission.relatedContractLimit = 0;
    assert.throws(() => store.saveOrder(order), /paid scope cannot change/);
    assert.equal(store.getOrder(order.id)?.submission.relatedContractLimit, 4);
  } finally { store.close(); }
});

test("legacy scopes and locked orders cannot silently acquire related-contract work", () => {
  const store = new Store(":memory:");
  try {
    const created = store.createScope(`https://example.com Ethereum ${token}`);
    const legacy = structuredClone(created.scope);
    delete legacy.submission.relatedContractLimit;
    legacy.included = legacy.included.filter((description) => !description.includes("related addresses"));
    store.db.prepare("UPDATE scopes SET body=? WHERE id=?").run(JSON.stringify(legacy), legacy.id);
    const { order } = store.lockScope(legacy.id, created.accessToken, legacy.revision, false);
    assert.equal(order.submission.relatedContractLimit, undefined);
    assert.equal(order.scope?.submission.relatedContractLimit, undefined);
    const recovered = store.getScope(legacy.id, created.accessToken);
    assert.equal(recovered.submission.relatedContractLimit, undefined);
    assert.throws(() => advanceScope(recovered, "add related contracts", recovered.revision), /locked/);
    const retry = store.lockScope(legacy.id, created.accessToken, legacy.revision, false);
    assert.equal(retry.order.submission.relatedContractLimit, undefined);
    retry.order.submission.relatedContractLimit = 4;
    assert.throws(() => store.saveOrder(retry.order), /paid scope cannot change/);
    assert.equal(store.getOrder(order.id)?.submission.relatedContractLimit, undefined);
    const advanced = advanceScope(legacy, "also inspect related contracts", legacy.revision);
    assert.equal(advanced.submission.relatedContractLimit, 4);
    assert.equal(advanced.revision, legacy.revision + 1);
    assert.match(advanced.included.join(" "), /up to 4 related addresses/);
  } finally { store.close(); }
});
