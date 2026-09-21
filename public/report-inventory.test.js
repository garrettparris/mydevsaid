import test from 'node:test';
import assert from 'node:assert/strict';
import { inventoryRows } from './report-inventory.js';
const address = value => `0x${value.toString(16).padStart(40, '0')}`;
const snapshot = value => ({ chainId: 1, address: address(value), blockNumber: '100', blockHash: `0x${'a'.repeat(64)}` });
const capture = (id, medium, content, extra = {}) => ({ id, medium, role: 'observation', capturedAt: '2026-09-15T07:00:00Z', content: JSON.stringify(content), ...extra });
const candidate = (value, extra = {}) => ({ address: address(value), chainIds: [1], sourceEvidenceIds: ['docs'], sourceUrls: ['https://example.com/docs'], context: 'Juniper Treasury', selected: true, reason: 'Selected for bounded views', ...extra });
const read = (value, extra = {}, metadata = {}) => capture(`read-${value}`, 'onchain', { kind: 'related_contract', address: address(value), snapshot: snapshot(value), bytecode: '0x6000', ...extra }, { snapshot: snapshot(value), ...metadata });
function fixture(candidates = [candidate(2)]) {
  return { subject: { token: { chainId: 1, address: address(1) } }, evidence: [
    capture('docs', 'documentation', { text: 'Juniper contract list' }, { role: 'claim' }),
    capture('inventory', 'website', { kind: 'contract_inventory', candidates, limit: 4, truncated: false }),
    capture('primary', 'onchain', { snapshot: snapshot(1), bytecode: '0x6000' }, { snapshot: snapshot(1) }), read(2),
  ] };
}
const relatedRow = investigation => inventoryRows(investigation).rows.find(row => !row.isPrimary);

test('inventory separates primary token and evidenced basic reads from claimed role labels', () => {
  const result = inventoryRows(fixture());
  assert.equal(result.available, true); assert.equal(result.selectedCount, 1); assert.equal(result.readCount, 1);
  assert.equal(result.rows.find(row => row.isPrimary).status, 'Basic views captured');
  const row = result.rows.find(row => !row.isPrimary);
  assert.equal(row.label, 'Juniper Treasury'); assert.equal(row.blockNumber, '100');
  assert.deepEqual(row.evidenceIds, ['inventory', 'docs', 'read-2']);
  assert.match(row.summary, /does not verify behavior/);
});

test('missing reads, empty bytecode and unavailable code remain distinct', () => {
  const missing = fixture(); missing.evidence.pop();
  assert.equal(relatedRow(missing).status, 'Selected, not collected');
  for (const [bytecode, status] of [['0x', 'No code returned'], [null, 'Read unavailable'], ['0xz', 'Selected, not collected']]) {
    const value = fixture(); value.evidence[3] = read(2, { bytecode }); assert.equal(relatedRow(value).status, status);
  }
});

test('wrong media, roles, addresses, chains and block snapshots cannot establish collected views', () => {
  const changes = [
    read(2, {}, { role: 'claim' }), read(2, {}, { medium: 'website' }), read(2, { address: address(3) }),
    read(2, { snapshot: { ...snapshot(2), blockNumber: '101' } }),
    read(2, { snapshot: { ...snapshot(2), blockNumber: '101' } }, { snapshot: { ...snapshot(2), blockNumber: '101' } }),
    read(2, { snapshot: { ...snapshot(2), blockHash: `0x${'b'.repeat(64)}` } }),
    read(2, { snapshot: { ...snapshot(2), chainId: 8453 } }, { snapshot: { ...snapshot(2), chainId: 8453 } }),
  ];
  for (const record of changes) { const value = fixture(); value.evidence[3] = record; assert.equal(relatedRow(value).status, 'Selected, not collected'); }
  const otherChain = fixture([candidate(2, { chainIds: [8453], selected: false, reason: 'Different explorer chain' })]);
  assert.equal(relatedRow(otherChain).status, 'Outside this inspection'); assert.equal(relatedRow(otherChain).blockNumber, null);
});

test('Safe-compatible settings are described only when bounded canonical owner data is valid', () => {
  const valid = fixture(); valid.evidence[3] = read(2, { safeConfiguration: { threshold: 2, owners: [address(3), address(4), address(5)] } });
  assert.match(relatedRow(valid).summary, /2 required approvals and 3 owner addresses/);
  for (const config of [{ threshold: 0, owners: [address(3)] }, { threshold: 2, owners: [address(3)] }, { threshold: 1, owners: [address(3), address(3)] }, { threshold: 1, owners: [address(0)] }, { threshold: '1', owners: [address(3)] }]) {
    const value = fixture(); value.evidence[3] = read(2, { safeConfiguration: config }); assert.doesNotMatch(relatedRow(value).summary, /Safe-compatible/);
  }
});

test('latest valid inventory wins and malformed evidence or duplicate identifiers do not provide citations', () => {
  const value = fixture();
  value.evidence.push(capture('newer', 'website', { kind: 'contract_inventory', candidates: [candidate(3)], limit: 4, truncated: true }, { capturedAt: '2026-09-15T08:00:00Z' }));
  value.evidence.push(capture('bad-latest', 'website', { kind: 'contract_inventory', candidates: [null], limit: 4, truncated: false }, { capturedAt: '2026-09-15T09:00:00Z' }));
  assert.equal(relatedRow(value).address, address(3)); assert.equal(inventoryRows(value).truncated, true);
  const duplicateRead = fixture(); duplicateRead.evidence.push(structuredClone(duplicateRead.evidence[3]));
  assert.equal(relatedRow(duplicateRead).status, 'Selected, not collected');
  const duplicateDocs = fixture(); duplicateDocs.evidence.push(structuredClone(duplicateDocs.evidence[0]));
  assert.equal(inventoryRows(duplicateDocs).available, false);
  assert.equal(inventoryRows({ evidence: [{ id: 'bad', content: '{' }] }).available, false);
});

test('row counts and plain-text labels stay bounded without hardcoding a project', () => {
  const rows = Array.from({ length: 100 }, (_, i) => candidate(i + 2, { selected: false }));
  const result = inventoryRows(fixture(rows)); assert.equal(result.rows.length, 100); assert.equal(result.truncated, true);
  assert.equal(inventoryRows(fixture([...rows, candidate(200, { selected: false })])).available, false);
  const text = '<img src=x onerror=alert(1)> Treasury';
  assert.equal(relatedRow(fixture([candidate(2, { context: `Contract Address ${text}` })])).label, text);
  assert.equal(relatedRow(fixture([candidate(2, { context: 'x'.repeat(1000) })])).label.length, 100);
  assert.equal(inventoryRows(fixture([candidate(2), candidate(2)])).rows.filter(row => !row.isPrimary).length, 1);
});
