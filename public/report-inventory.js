const ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const validAddress = value => typeof value === 'string' && ADDRESS.test(value) && !/^0x0{40}$/.test(value);
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const validChain = value => Number.isSafeInteger(value) && value > 0;
const unique = values => new Set(values).size === values.length;
const normalize = value => value.toLowerCase();
function parse(value) { try { return JSON.parse(value); } catch { return null; } }
function validSnapshot(value) {
  return value && validChain(value.chainId) && validAddress(value.address) && typeof value.blockNumber === 'string'
    && /^(0|[1-9][0-9]*)$/.test(value.blockNumber) && /^0x[a-fA-F0-9]{64}$/.test(value.blockHash);
}
function sameSnapshot(left, right) {
  return left.chainId === right.chainId && normalize(left.address) === normalize(right.address)
    && left.blockNumber === right.blockNumber && normalize(left.blockHash) === normalize(right.blockHash);
}
function validUrl(value) {
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password; } catch { return false; }
}
function validCandidate(value, known) {
  return value && validAddress(value.address) && Array.isArray(value.chainIds) && value.chainIds.length <= 20
    && value.chainIds.every(validChain) && unique(value.chainIds) && Array.isArray(value.sourceEvidenceIds)
    && value.sourceEvidenceIds.length > 0 && value.sourceEvidenceIds.length <= 20 && unique(value.sourceEvidenceIds)
    && value.sourceEvidenceIds.every(id => validId(id) && known.has(id)) && Array.isArray(value.sourceUrls)
    && value.sourceUrls.length <= 20 && value.sourceUrls.every(validUrl) && typeof value.context === 'string'
    && typeof value.selected === 'boolean' && typeof value.reason === 'string';
}
function settings(value) {
  if (!value || Object.keys(value).sort().join(',') !== 'owners,threshold' || !Array.isArray(value.owners)
    || !value.owners.length || value.owners.length > 20 || !value.owners.every(validAddress)
    || !unique(value.owners.map(normalize)) || !Number.isInteger(value.threshold) || value.threshold < 1 || value.threshold > value.owners.length) return '';
  return ` Safe-compatible calls returned ${value.threshold} required ${value.threshold === 1 ? 'approval' : 'approvals'} and ${value.owners.length} owner ${value.owners.length === 1 ? 'address' : 'addresses'}; actual permissions remain unverified.`;
}
function label(context) {
  return context.replace(/^.*?Contract\s+Address\s+/i, '').replace(/\s+/g, ' ').trim().slice(0, 100) || 'Address listed in project material';
}

/** Build read coverage from validated captures; document labels never establish protocol membership. */
export function inventoryRows(investigation) {
  const empty = { available: false, rows: [], truncated: false, limit: 0, evidenceIds: [], selectedCount: 0, readCount: 0 };
  const records = Array.isArray(investigation?.evidence) ? investigation.evidence : [];
  const counts = new Map();
  for (const record of records) if (validId(record?.id)) counts.set(record.id, (counts.get(record.id) || 0) + 1);
  const evidence = records.filter(record => record && counts.get(record.id) === 1 && Number.isFinite(Date.parse(record.capturedAt)))
    .sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt));
  const known = new Set(evidence.map(record => record.id));
  let inventory, capture;
  for (const record of evidence) {
    if (record.role !== 'observation' || record.medium !== 'website') continue;
    const value = parse(record.content);
    if (value?.kind !== 'contract_inventory' || !Array.isArray(value.candidates) || value.candidates.length > 100
      || ![0, 4].includes(value.limit) || typeof value.truncated !== 'boolean' || !value.candidates.every(candidate => validCandidate(candidate, known))
      || value.candidates.filter(candidate => candidate.selected).length > value.limit) continue;
    inventory = value; capture = record; break;
  }
  if (!inventory) return empty;
  const token = investigation.subject?.token;
  const validToken = token && validAddress(token.address) && validChain(token.chainId);
  const reads = evidence.flatMap(record => {
    if (record.role !== 'observation' || record.medium !== 'onchain' || !validSnapshot(record.snapshot)) return [];
    const value = parse(record.content);
    if (!value || !validSnapshot(value.snapshot) || !sameSnapshot(value.snapshot, record.snapshot)
      || !validToken || value.snapshot.chainId !== token.chainId || !(value.bytecode === null || (typeof value.bytecode === 'string' && value.bytecode.length <= 262146 && /^0x(?:[a-fA-F0-9]{2})*$/.test(value.bytecode)))) return [];
    const primary = normalize(value.snapshot.address) === normalize(token.address);
    if (primary ? value.kind !== undefined : value.kind !== 'related_contract' || !validAddress(value.address) || normalize(value.address) !== normalize(value.snapshot.address)) return [];
    return [{ record, value, primary }];
  });
  const primary = reads.find(read => read.primary);
  const candidates = [...inventory.candidates].sort((a, b) => Number(b.selected) - Number(a.selected));
  if (validToken && !candidates.some(candidate => normalize(candidate.address) === normalize(token.address) && candidate.chainIds.includes(token.chainId))) {
    candidates.unshift({ address: token.address, chainIds: [token.chainId], context: 'Primary token from the paid scope', selected: false, reason: 'Primary token is inspected separately', sourceEvidenceIds: [], sourceUrls: [] });
  }
  const seen = new Set();
  const rows = candidates.slice(0, 100).flatMap(candidate => {
    const address = normalize(candidate.address), chainIds = [...candidate.chainIds].sort((a, b) => a - b), key = `${address}:${chainIds.join(',')}`;
    if (seen.has(key)) return []; seen.add(key);
    const isPrimary = Boolean(validToken && address === normalize(token.address) && chainIds.includes(token.chainId));
    const read = (isPrimary || candidate.selected) && chainIds.includes(token?.chainId) ? reads.find(item => normalize(item.value.snapshot.address) === address
      && (!primary || (item.value.snapshot.blockNumber === primary.value.snapshot.blockNumber && normalize(item.value.snapshot.blockHash) === normalize(primary.value.snapshot.blockHash)))) : undefined;
    const status = read ? read.value.bytecode === null ? 'Read unavailable' : read.value.bytecode === '0x' ? 'No code returned' : 'Basic views captured'
      : isPrimary ? 'Primary token, not collected' : candidate.selected ? 'Selected, not collected' : 'Outside this inspection';
    const summary = read ? read.value.bytecode === null ? 'The capture did not establish whether deployed code was present.'
      : read.value.bytecode === '0x' ? 'No deployed code was returned at this block. Contract views were not established.'
        : `Deployed code was returned. This does not verify behavior or complete control.${settings(read.value.safeConfiguration)}` : candidate.reason.slice(0, 500);
    return [{ address, chainIds, label: label(candidate.context), isPrimary, selected: candidate.selected && !isPrimary, status, summary,
      blockNumber: read?.value.snapshot.blockNumber || null, evidenceIds: [...new Set([capture.id, ...candidate.sourceEvidenceIds, ...(read ? [read.record.id] : [])])], reason: candidate.reason.slice(0, 500) }];
  });
  return { available: true, rows, truncated: inventory.truncated || candidates.length > 100, limit: inventory.limit, evidenceIds: [capture.id],
    selectedCount: rows.filter(row => row.selected).length, readCount: rows.filter(row => row.selected && row.blockNumber !== null).length };
}
function node(tag, className = '', text) {
  const element = document.createElement(tag); element.className = className;
  if (text !== undefined) element.textContent = text; return element;
}
export function renderContractInventory(investigation, citedText) {
  const data = inventoryRows(investigation), wrapper = node('div', 'contract-inventory');
  if (!data.available) { wrapper.append(node('p', 'inventory-note', 'No contract inventory was captured for this report. Connected-module coverage is unknown.')); return wrapper; }
  wrapper.append(citedText({ text: `${data.selectedCount} related addresses were selected; ${data.readCount} have matching recorded read attempts. The primary token is shown separately.`, evidenceIds: data.evidenceIds }, 'p', 'inventory-intro'));
  wrapper.append(node('p', 'inventory-note', "Names below come from project material. They describe claimed roles, not verified protocol membership. Each status describes only this report's captured checks."));
  if (data.truncated) wrapper.append(node('p', 'inventory-note', "The captured inventory was truncated. These addresses are not a complete count of the project's contracts or modules."));
  const renderRow = row => {
    const card = node('article', 'inventory-row'), identity = node('div', 'inventory-identity'), status = node('div', 'inventory-coverage');
    identity.append(node('span', 'inventory-label', row.isPrimary ? 'PRIMARY TOKEN' : 'DOCUMENT LABEL'), node('h4', '', row.label), node('p', 'inventory-address', row.address),
      node('p', 'inventory-note', row.isPrimary ? `Scoped chain: ${investigation.subject.token.chainId}` : row.chainIds.length ? `Explorer-linked ${row.chainIds.length === 1 ? 'chain' : 'chains'}: ${row.chainIds.join(', ')}` : 'Network not established'));
    status.append(node('strong', 'inventory-status', row.status));
    if (row.blockNumber) status.append(node('p', 'inventory-note', `Captured block ${row.blockNumber}`));
    status.append(citedText({ text: row.summary, evidenceIds: row.evidenceIds }, 'p', 'inventory-description')); card.append(identity, status); return card;
  };
  for (const row of data.rows.filter(row => row.selected || row.isPrimary)) wrapper.append(renderRow(row));
  const excluded = data.rows.filter(row => !row.selected && !row.isPrimary);
  if (excluded.length) {
    const details = node('details', 'inventory-excluded'); details.append(node('summary', '', `${excluded.length} additional address candidates outside this inspection`));
    for (const row of excluded) details.append(renderRow(row)); wrapper.append(details);
  }
  return wrapper;
}
