import { renderProjectMap, renderProtocolDiagrams, BASIS_LABELS } from './report-map.js';
import { renderContractInventory } from './report-inventory.js';
import { reportVerdict } from './report-verdict.js';

export const AREA_NAMES = { web_presence: 'Website and documentation', public_code: 'Public code', deployment_match: 'Code and deployment match', api_behavior: 'Off-chain API behavior', contract_control: 'Contract control', activity_quality: 'Activity quality' };
const CHAIN_NAMES = { 1: 'Ethereum', 8453: 'Base', 4663: 'Robinhood Chain', 42161: 'Arbitrum', 10: 'Optimism', 137: 'Polygon', 56: 'BNB Chain' };
export const label = value => String(value || 'unknown').replaceAll('_', ' ').replace(/^./, first => first.toUpperCase());
export const chainName = id => CHAIN_NAMES[id] || `Chain ${id}`;
export const shortAddress = value => value ? `${value.slice(0, 8)}...${value.slice(-6)}` : 'Token not attached';
export const dateText = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Not recorded';

export function el(tag, className = '', text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = String(text);
  return element;
}

function assetSvg() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('width', '24'); svg.setAttribute('height', '24');
  return svg;
}
function shape(svg, tag, attributes) {
  const node = document.createElementNS(svg.namespaceURI, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
  svg.append(node);
}
export function chainBadge(chainId) {
  const name = chainName(chainId), badge = el('span', 'asset-badge chain-badge');
  const icon = el('span', `asset-icon chain-icon chain-${Number(chainId)}`);
  icon.setAttribute('aria-hidden', 'true');
  const svg = assetSvg();
  if (Number(chainId) === 1) {
    shape(svg, 'path', { d: 'M12 2 5 12l7 4 7-4Z', fill: '#b9c4f2' });
    shape(svg, 'path', { d: 'm5 14 7 8 7-8-7 4Z', fill: '#8493c7' });
  } else if (Number(chainId) === 8453) {
    shape(svg, 'circle', { cx: 12, cy: 12, r: 12, fill: '#0052ff' });
    shape(svg, 'path', { d: 'M4 11h16v2H4Z', fill: '#fff' });
  } else {
    icon.append(el('span', 'chain-monogram', ({4663:'R',42161:'AR',10:'OP',137:'P',56:'B'})[chainId] || '#'));
  }
  if (svg.childNodes.length) icon.append(svg);
  badge.append(icon, document.createTextNode(name));
  return badge;
}
export function tokenBadge(token, investigation) {
  let metadata;
  for (const evidence of [...(investigation?.evidence || [])].reverse()) {
    if (!evidence.method?.startsWith('Data from GMGN')) continue;
    try {
      const record = JSON.parse(evidence.content), candidate = record.data?.metadata;
      if (record.provider === 'GMGN' && record.kind === 'info' && candidate?.chainId === token.chainId
        && candidate.tokenAddress?.toLowerCase() === token.address.toLowerCase()) { metadata = candidate; break; }
    } catch { /* Older or incomplete evidence uses the address identicon. */ }
  }
  const badge = el('span', 'asset-badge token-badge');
  const icon = el('span', 'asset-icon token-icon'); icon.setAttribute('aria-hidden', 'true');
  const svg = assetSvg(), seed = `${token.chainId}:${token.address.toLowerCase()}`;
  let hash = 2166136261;
  for (const char of seed) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0;
  const fill = `hsl(${hash % 360} 38% 68%)`;
  shape(svg, 'rect', { width: 24, height: 24, rx: 5, fill: '#303030' });
  for (let y = 0; y < 5; y++) for (let x = 0; x < 3; x++) {
    if (!(hash & (1 << (y * 3 + x)))) continue;
    for (const column of x === 2 ? [x] : [x, 4 - x]) shape(svg, 'rect', { x: 2 + column * 4, y: 2 + y * 4, width: 4, height: 4, fill });
  }
  icon.append(svg);
  const name = typeof metadata?.symbol === 'string' ? metadata.symbol.slice(0, 20) : '';
  badge.title = `${token.address}${metadata ? ' / Data from GMGN; metadata is unverified' : ' / Address-based identicon'}`;
  const logo = safeUrl(metadata?.logoUrl);
  if (logo) {
    const url = new URL(logo);
    if (url.protocol === 'https:' && !url.port && (url.hostname === 'gmgn.ai' || url.hostname.endsWith('.gmgn.ai'))) {
      const image = el('img'); image.alt = ''; image.width = 24; image.height = 24;
      image.loading = 'eager'; image.decoding = 'async'; image.referrerPolicy = 'no-referrer';
      image.hidden = true;
      image.addEventListener('load', () => { image.hidden = false; });
      image.addEventListener('error', () => image.remove(), { once: true });
      image.src = url.href; icon.append(image);
    }
  }
  badge.append(icon, document.createTextNode(name ? `${name} / ${shortAddress(token.address)}` : shortAddress(token.address)));
  return badge;
}

export function safeUrl(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function linkTo(value, text, className = '') {
  const url = safeUrl(value);
  if (!url) return el('span', className, text);
  const anchor = el('a', className, text);
  anchor.href = url;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  return anchor;
}

export function downloadJson(data, filename) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const link = el('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function list(items, className = 'plain-list') {
  const ul = el('ul', className);
  for (const item of items || []) ul.append(el('li', '', item));
  return ul;
}

function evidenceDetails(evidence, prefix) {
  const details = el('details', 'evidence-item');
  details.id = `${prefix}-evidence-${evidence.id}`;
  details.append(el('summary', '', `${label(evidence.medium)} / ${label(evidence.role)} / ${evidence.id.slice(0, 8)}`));
  const body = el('div', 'evidence-content');
  body.append(linkTo(evidence.sourceUrl, evidence.sourceUrl));
  const metadata = el('dl');
  const fields = [['Captured', dateText(evidence.capturedAt)], ['Method', evidence.method], ['Collector', evidence.toolVersion], ['SHA-256', evidence.sha256]];
  if (evidence.revision) fields.push(['Revision', evidence.revision]);
  if (evidence.snapshot) fields.push(['Network', chainName(evidence.snapshot.chainId)], ['Address', evidence.snapshot.address], ['Block', evidence.snapshot.blockNumber], ['Block hash', evidence.snapshot.blockHash]);
  for (const [name, value] of fields) metadata.append(el('dt', '', name), el('dd', '', value));
  const content = el('pre', '', evidence.content.slice(0, 20000));
  const download = el('button', 'button secondary', 'Download full evidence');
  download.type = 'button';
  download.addEventListener('click', () => downloadJson(evidence, `evidence-${evidence.id}.json`));
  body.append(metadata, content);
  if (evidence.content.length > 20000) body.append(el('p', 'evidence-truncation', 'Showing the first 20,000 characters. Download contains the complete evidence record.'));
  body.append(download);
  details.append(body);
  return details;
}

function findingCard(finding, investigation, prefix) {
  const card = el('details', 'finding');
  const head = el('summary', 'finding-head');
  const tags = el('span', 'finding-tags');
  tags.append(el('span', `tag ${finding.status}`, label(finding.status)), el('span', `tag ${finding.severity}`, `${label(finding.severity)} severity`), el('span', 'tag', AREA_NAMES[finding.area] || label(finding.area)));
  head.append(tags, el('span', 'finding-title', finding.claim), el('span', 'finding-expand', 'Read explanation, evidence and limits'));
  const explanation = el('div', 'finding-explanation');
  explanation.append(el('p', '', finding.explanation), el('p', 'finding-impact', `Why it matters: ${finding.impact}`));
  const details = el('details');
  const ids = [...new Set([...finding.claimEvidenceIds, ...finding.supportingEvidenceIds, ...finding.contradictingEvidenceIds])];
  details.append(el('summary', '', `Inspect evidence and limitations (${ids.length} sources)`));
  const body = el('div', 'finding-detail');
  for (const [title, refs] of [['Project claims', finding.claimEvidenceIds], ['Supporting observations', finding.supportingEvidenceIds], ['Contradicting observations', finding.contradictingEvidenceIds]]) {
    if (!refs.length) continue;
    body.append(el('h4', '', title));
    const links = el('div', 'evidence-links');
    for (const id of refs) {
      const item = investigation.evidence.find(entry => entry.id === id);
      const anchor = el('a', 'evidence-link', `${label(item?.medium)} / ${id.slice(0, 8)}`);
      anchor.href = `#${prefix}-evidence-${id}`;
      anchor.addEventListener('click', event => {
        event.preventDefault();
        const target = document.getElementById(`${prefix}-evidence-${id}`);
        if (target) { target.open = true; target.scrollIntoView({ block: 'start' }); target.querySelector('summary')?.focus(); }
      });
      links.append(anchor);
    }
    body.append(links);
  }
  body.append(el('h4', '', 'What this finding does not establish'), list(finding.limitations));
  details.append(body);
  card.append(head, explanation, details);
  return card;
}

export function renderReport(record, options = {}) {
  const result = record.result || record;
  const investigation = result.investigation;
  const article = el('article', `report-document${options.embedded ? ' embedded' : ''}`);
  if (!investigation) { article.append(el('p', 'error-message', 'This report has no readable investigation data.')); return article; }
  const prefix = `${options.embedded ? 'draft' : 'public'}-${investigation.id}`;
  const token = investigation.subject.token;
  const presentation = result.presentation;
  const title = record.title || result.discovery?.pages?.[0]?.title || new URL(investigation.subject.links[0]).hostname;
  if (!options.embedded) { const back = el('a', 'report-back', 'Back to all investigations'); back.href = '#reports'; article.append(back); }
  article.append(el('div', 'eyebrow', options.personal ? 'MYDEVSAID / PERSONAL REPORT' : record.publishedAt ? 'MYDEVSAID / PUBLIC EVIDENCE RECORD' : 'MYDEVSAID / PRIVATE DRAFT'));
  const heading = el('div', 'report-heading');
  heading.append(el(options.embedded ? 'h2' : 'h1', '', title), el('span', 'tag', options.personal ? 'Saved report' : record.publishedAt ? `Version ${record.version || 1}` : 'Awaiting review'));
  const citedText = (item, tag, className) => {
    const block = el(tag, className, item.text);
    for (const id of item.evidenceIds || []) {
      const sourceNumber = investigation.evidence.findIndex(source => source.id === id) + 1;
      if (!sourceNumber) continue;
      const anchor = el('a', 'evidence-link', ` [${sourceNumber}]`);
      anchor.setAttribute('aria-label', `Read source ${sourceNumber}`);
      anchor.href = `#${prefix}-evidence-${id}`;
      anchor.addEventListener('click', event => {
        event.preventDefault();
        const target = document.getElementById(`${prefix}-evidence-${id}`);
        if (target) { target.open = true; target.scrollIntoView({ block: 'start' }); target.querySelector('summary')?.focus(); }
      });
      block.append(anchor);
    }
    return block;
  };
  const introduction = presentation?.mode === 'deterministic' && result.narration?.explanation ? result.narration.explanation : presentation?.overview || result.narration?.explanation;
  article.append(heading);
  const verdict = reportVerdict(investigation);
  const take = el('section', 'glance-card report-verdict');
  take.setAttribute('aria-label', 'mydevsaid verdict');
  take.dataset.verdict = verdict.state;
  take.append(el('h3', '', verdict.title), citedText(verdict, 'p', ''));
  article.append(take);
  if (introduction?.basis) article.append(el('span', `statement-basis ${introduction.basis}`, BASIS_LABELS[introduction.basis] || label(introduction.basis)));
  article.append(introduction ? citedText(introduction, 'p', 'report-deck') : el('p', 'report-deck', result.summary?.explanation || 'A plain-English explanation is not available.'));
  const meta = el('div', 'report-meta');
  meta.append(el('span', '', `Report prepared ${dateText(result.generatedAt || investigation.createdAt)}`));
  if (token) {
    const tokenLink = el('a', 'evidence-link token-identity-link');
    tokenLink.append(tokenBadge(token, investigation));
    tokenLink.title = token.address;
    if (!options.personal) tokenLink.href = `/token/${token.chainId}/${encodeURIComponent(token.address)}`;
    meta.append(chainBadge(token.chainId), tokenLink);
  }
  else meta.append(el('span', '', 'Token identity unresolved'));
  const captured = investigation.evidence.map(item => item.capturedAt).filter(Boolean).sort();
  if (captured.length) meta.append(el('span', '', `Evidence captured ${dateText(captured[0])} to ${dateText(captured.at(-1))}`));
  const blocks = [...new Set(investigation.evidence.filter(item => item.snapshot).map(item => `${chainName(item.snapshot.chainId)} block ${item.snapshot.blockNumber}`))];
  for (const block of blocks) meta.append(el('span', '', block));
  article.append(meta);
  article.append(el('p', 'report-method', presentation?.mode === 'reviewed' ? 'Editorial explanation prepared from captured evidence. Automated checks cover only the stated scope; the connected protocol has not been independently audited.' : result.analysisMode === 'pi' ? 'Model-assisted explanation. Check each statement against its sources; citations alone do not prove a claim.' : 'Guided evidence summary. No model interpretation was run. Quoted project descriptions are claims, not verified behavior.'));
  const nav = el('nav', 'report-nav');
  nav.setAttribute('aria-label', 'Report sections');
  for (const [id, name] of [['overview', 'At a glance'], ['map', 'How it works'], ...(presentation ? [['control', 'Who has control'], ['unknowns', 'Unknowns']] : []), ['modules', 'Contract scope'], ['findings', 'Checked claims'], ['coverage', 'Check coverage'], ['evidence', 'Sources']]) {
    const anchor = el('a', '', name);
    anchor.href = `#${prefix}-${id}`;
    anchor.addEventListener('click', event => { event.preventDefault(); const target = document.getElementById(`${prefix}-${id}`); if (target) { target.tabIndex = -1; target.focus({ preventScroll: true }); target.scrollIntoView({ block: 'start' }); } });
    nav.append(anchor);
  }
  article.append(nav);
  const section = (id, headingText) => { const element = el('section', 'report-section'); element.id = `${prefix}-${id}`; element.append(el('h2', '', headingText)); article.append(element); return element; };
  const overview = section('overview', 'At a glance');
  if (presentation) {
    const keySections = ['purpose', 'concerns'];
    const cards = el('div', 'report-glance');
    for (const id of keySections) {
      const entry = presentation.sections.find(item => item.id === id);
      if (!entry) continue;
      const card = el('section', 'glance-card');
      card.append(el('h3', '', entry.title));
      for (const item of entry.items) {
        const statement = el('div', 'report-statement');
        statement.append(el('span', `statement-basis ${item.basis}`, BASIS_LABELS[item.basis] || label(item.basis)), citedText(item, 'p', ''));
        card.append(statement);
      }
      cards.append(card);
    }
    overview.append(cards);
  } else if (result.narration?.keyFindings?.length) {
    const points = el('ul', 'key-findings');
    for (const item of result.narration.keyFindings) points.append(citedText(item, 'li', ''));
    overview.append(points);
  } else overview.append(list(result.summary?.keyFindings || ['No summary findings are available.'], 'key-findings'));
  const mechanism = section('map', 'How it works');
  mechanism.append(renderProtocolDiagrams(presentation, investigation, citedText));
  for (const entry of presentation?.sections || []) {
    if (['purpose', 'concerns'].includes(entry.id)) continue;
    const chapter = section(entry.id, entry.title);
    for (const item of entry.items) {
      const statement = el('div', 'report-statement');
      statement.append(el('span', `statement-basis ${item.basis}`, BASIS_LABELS[item.basis] || label(item.basis)), citedText(item, 'p', ''));
      chapter.append(statement);
    }
  }
  const inventorySection = section('modules', 'Contracts in the automated collection');
  if (presentation?.mode === 'reviewed') inventorySection.append(el('p', 'inventory-note', 'This table describes the original automated collection. Separate follow-up checks are described in the report with their own source dates and blocks.'));
  inventorySection.append(renderContractInventory(investigation, citedText));
  if (record.changes) {
    const changes = section('changes', 'Changes since the previous report');
    const previous = el('a', 'evidence-link', 'Read the previous report');
    previous.href = `#report/${encodeURIComponent(record.changes.previousReportId)}`;
    changes.append(previous);
    if (!record.changes.items.length) changes.append(el('p', '', 'No changes were identified in the compared observations. Coverage limits still apply.'));
    for (const item of record.changes.items) {
      const change = el('article', 'coverage-item');
      change.append(el('h3', '', item.label), el('p', '', `Previously: ${item.before}`), el('p', '', `Now: ${item.after}`));
      changes.append(change);
    }
  }
  const references = el('details', 'source-inventory');
  references.append(el('summary', '', 'Explore discovered website links and address mentions'), renderProjectMap(result));
  mechanism.append(references);
  const findings = section('findings', 'Claims, checked');
  findings.append(el('p', '', 'Each result applies to the stated claim, not the whole project. Open a row for the explanation, sources and limits. Severity describes potential impact.'));
  const guide = el('details', 'finding-guide'); guide.append(el('summary', '', 'What the result labels mean'));
  const definitions = el('dl');
  for (const [name, meaning] of [['Supported', 'The captured evidence supports this specific claim within the recorded scope.'], ['Partially supported', 'Evidence supports part of the claim; the explanation identifies what remains unresolved.'], ['Contradicted', 'The captured evidence conflicts with this claim.'], ['Unverified', 'The available checks did not establish this claim. Missing evidence is not a pass.']]) definitions.append(el('dt', '', name), el('dd', '', meaning));
  guide.append(definitions); findings.append(guide);
  for (const finding of investigation.findings) findings.append(findingCard(finding, investigation, prefix));
  if (!investigation.findings.length) findings.append(el('p', 'notice', 'No assessed findings are available in this investigation.'));
  const coverage = section('coverage', 'What we checked. What remains unknown.');
  const grid = el('div', 'coverage-grid');
  for (const check of investigation.checks) {
    const item = el('div', 'coverage-item');
    item.append(el('span', `tag ${check.status}`, label(check.status)), el('h3', '', AREA_NAMES[check.area] || label(check.area)), el('p', '', check.reason || `${check.evidenceIds.length} evidence records. See findings for the check's scope and limitations.`));
    grid.append(item);
  }
  coverage.append(grid);
  const limits = [...new Set([...(result.summary?.limitations || []), ...(result.discovery?.limitations || [])])];
  if (limits.length) coverage.append(list(limits));
  const evidenceSection = section('evidence', `Evidence record (${investigation.evidence.length})`);
  evidenceSection.append(el('p', '', 'Source snapshots and collector observations. Hashes record content integrity; they do not establish that a source is truthful.'));
  investigation.evidence.forEach((item, index) => { const details = evidenceDetails(item, prefix); details.querySelector('summary').prepend(document.createTextNode(`Source ${index + 1} / `)); evidenceSection.append(details); });
  const actions = el('div', 'actions');
  const download = el('button', 'button secondary', 'Download report JSON');
  download.type = 'button';
  download.addEventListener('click', () => downloadJson(record, `mydevsaid-${investigation.id}.json`));
  actions.append(download);
  const html = el('button', 'button primary', 'Download HTML report');
  html.type = 'button';
  html.addEventListener('click', async () => {
    html.disabled = true;
    try {
      const response = await fetch('/styles.css');
      if (!response.ok) throw new Error('Styles could not be loaded');
      const content = reportHtml(article, await response.text());
      const url = URL.createObjectURL(new Blob([content], { type: 'text/html' }));
      const link = el('a'); link.href = url; link.download = `mydevsaid-${investigation.id}.html`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { html.textContent = 'Export failed. Try again.'; }
    finally { html.disabled = false; }
  });
  actions.append(html);
  if (record.publishedAt && options.onRecheck) {
    const recheck = el('button', 'button secondary', 'Run a new investigation');
    recheck.type = 'button';
    recheck.addEventListener('click', async () => {
      recheck.disabled = true;
      try { await options.onRecheck(record.id); }
      catch (error) { recheck.textContent = `Could not start: ${error.message}`; recheck.disabled = false; }
    });
    actions.append(recheck);
  }
  if (record.publishedAt && navigator.clipboard) {
    const share = el('button', 'button secondary', 'Copy report link');
    share.type = 'button';
    share.addEventListener('click', async () => { try { await navigator.clipboard.writeText(`${location.origin}/report/${encodeURIComponent(record.id)}`); share.textContent = 'Link copied'; } catch { share.textContent = 'Copy the address from your browser'; } });
    actions.append(share);
  }
  article.append(actions);
  return article;
}

export function reportHtml(article, css) {
  const copy = article.cloneNode(true);
  copy.querySelectorAll('.token-icon img').forEach(image => image.remove());
  copy.querySelectorAll('.actions,button,.report-back,.source-inventory').forEach(item => item.remove());
  copy.querySelectorAll('details').forEach(item => { item.open = item.classList.contains('diagram-text'); });
  copy.querySelectorAll('.evidence-truncation').forEach(item => { item.textContent = 'Only the first 20,000 characters of this record are embedded in this HTML. The full evidence record is available through the app JSON download.'; });
  copy.classList.remove('embedded');
  copy.querySelectorAll('a[href^="/"],a[href^="#report/"]').forEach(link => link.removeAttribute('href'));
  const style = document.createElement('style');
  style.textContent = css + '\n.report-document{padding-bottom:60px}.report-document>details{margin-top:24px}';
  const page = document.implementation.createHTMLDocument('mydevsaid / Evidence report');
  page.documentElement.lang = 'en';
  const charset = page.createElement('meta'); charset.setAttribute('charset', 'utf-8');
  const viewport = page.createElement('meta'); viewport.name = 'viewport'; viewport.content = 'width=device-width, initial-scale=1';
  const policy = page.createElement('meta'); policy.httpEquiv = 'Content-Security-Policy'; policy.content = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'";
  page.head.prepend(charset, viewport, policy); page.head.append(style);
  page.body.append(copy);
  return '<!doctype html>\n' + page.documentElement.outerHTML;
}
