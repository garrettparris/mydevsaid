function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function safeLink(url, label) {
  try {
    const parsed = new URL(url);
    if (!['https:', 'http:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error();
    const link = node('a', '', label || parsed.hostname);
    link.href = parsed.href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    return link;
  } catch {
    return node('strong', '', label || 'Unavailable source');
  }
}

export function renderProjectMap(result) {
  const wrapper = node('div');
  const pages = result.discovery?.pages || [];
  const edges = [];
  const seen = new Set();
  for (const page of pages) {
    for (const link of page.links || []) {
      if (link.url === page.url) continue;
      const key = `${page.url}|${link.url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ source: page.url, target: link.url, label: link.label || link.url, kind: link.kind, relation: 'Linked from page' });
    }
    for (const candidate of page.addresses || []) {
      const key = `${page.url}|${candidate.address}|${candidate.chainId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edges.push({ source: page.url, target: candidate.sourceUrl, label: candidate.address, kind: 'address', relation: candidate.chainId ? `Address candidate / chain ${candidate.chainId}` : 'Address candidate / chain unresolved' });
    }
  }
  const categories = [['all', 'All links'], ['documentation', 'Docs'], ['repository', 'Code'], ['api', 'APIs'], ['address', 'Addresses']];
  const filters = node('div', 'map-filters');
  filters.setAttribute('aria-label', 'Filter discovered relationships');
  const surface = node('div', 'map-surface');
  const origin = node('div', 'map-origin');
  origin.append(node('span', 'eyebrow', 'INVESTIGATED WEBSITE'));
  origin.append(safeLink(result.investigation.subject.links[0], pages[0]?.title || result.investigation.subject.links[0]));
  const grid = node('div', 'map-grid');
  const caption = node('p', 'map-caption');
  const draw = (kind) => {
    const selected = edges.filter(edge => kind === 'all' || edge.kind === kind);
    grid.replaceChildren();
    for (const edge of selected.slice(0, 24)) {
      const card = node('article', 'map-connection');
      card.append(node('div', 'eyebrow', `${edge.kind.toUpperCase()} / ${edge.relation}`));
      card.append(safeLink(edge.target, edge.label));
      card.append(node('p', '', `Source: ${edge.source}`));
      grid.append(card);
    }
    if (!selected.length) grid.append(node('p', 'map-caption', 'No relationships of this type were collected.'));
    caption.textContent = `${Math.min(selected.length, 24)} of ${selected.length} collected relationships shown. Links and address mentions establish references, not ownership, verified deployments, or working integrations.`;
    for (const button of filters.children) button.setAttribute('aria-pressed', String(button.dataset.kind === kind));
  };
  for (const [kind, label] of categories) {
    const button = node('button', 'button secondary', label);
    button.type = 'button';
    button.dataset.kind = kind;
    button.addEventListener('click', () => draw(kind));
    filters.append(button);
  }
  surface.append(origin, grid);
  wrapper.append(filters, surface, caption);
  draw('all');
  return wrapper;
}

export const BASIS_LABELS = { project_claim: 'Project claim', observation: 'Observed', inference: 'Interpretation', unknown: 'Not established' };

// Refuse malformed imported graphs before layout; content is always rendered as text.
export function diagramRows(graph, evidenceIds) {
  if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges) || graph.nodes.length > 12 || graph.edges.length > 16 || !graph.edges.length) return null;
  if (graph.kind !== undefined && !['money_flow', 'contract_control', 'dependencies'].includes(graph.kind)) return null;
  const validText = value => typeof value === 'string' && value.trim().length > 0 && value.length <= 100;
  const validRefs = refs => Array.isArray(refs) && refs.length > 0 && refs.length <= 20 && refs.every(id => evidenceIds.has(id));
  const nodes = new Map();
  for (const item of graph.nodes) {
    if (!item || !validText(item.id) || !validText(item.label) || nodes.has(item.id) || !validRefs(item.evidenceIds)) return null;
    nodes.set(item.id, item);
  }
  const edges = new Set();
  const rows = [];
  for (const edge of graph.edges) {
    if (!edge || !validText(edge.id) || edges.has(edge.id) || !nodes.has(edge.from) || !nodes.has(edge.to) || edge.from === edge.to || !validText(edge.label)
      || !['project_claim', 'observation', 'inference'].includes(edge.basis) || !validRefs(edge.evidenceIds)) return null;
    edges.add(edge.id);
    rows.push({ from: nodes.get(edge.from), to: nodes.get(edge.to), edge });
  }
  if (graph.nodes.some(item => !rows.some(row => row.from.id === item.id || row.to.id === item.id))) return null;
  return rows;
}

// Layout only: identities, direction and relationships are never rewritten.
export function layoutDiagram(graph) {
  if (!graph.nodes.length || graph.nodes.length > 9 || graph.edges.length > 12) return null;
  const ids = graph.nodes.map(item => item.id).sort();
  const rank = new Map(ids.map(id => [id, 0]));
  const incoming = id => graph.edges.filter(edge => edge.to === id);
  const outgoing = id => graph.edges.filter(edge => edge.from === id);
  const remaining = new Map(ids.map(id => [id, incoming(id).length]));
  const ready = ids.filter(id => !remaining.get(id)), ordered = [];
  while (ready.length) {
    const id = ready.shift(); ordered.push(id);
    for (const edge of outgoing(id)) {
      rank.set(edge.to, Math.max(rank.get(edge.to), rank.get(id) + 1));
      remaining.set(edge.to, remaining.get(edge.to) - 1);
      if (!remaining.get(edge.to)) { ready.push(edge.to); ready.sort(); }
    }
  }
  if (ordered.length !== ids.length) return null; // Cycles retain the full connection list.
  const levels = Array.from({ length: Math.max(...rank.values()) + 1 }, (_, level) => ids.filter(id => rank.get(id) === level));
  const boxWidth = Math.max(192, ...ids.map(id => Math.max(incoming(id).length, outgoing(id).length) * 24 + 32));
  const boxHeight = 88, spacing = 32, margin = 24;
  const contentWidth = Math.max(...levels.map(level => level.length * (boxWidth + spacing) - spacing));
  const tracks = levels.map((_, level) => graph.edges.filter(edge => rank.get(edge.from) === level || rank.get(edge.to) - 1 === level));
  const y = [margin];
  for (let level = 1; level < levels.length; level++) y.push(y[level - 1] + boxHeight + 64 + tracks[level - 1].length * 20);
  const nodes = levels.flatMap((level, index) => level.map((id, column) => ({
    ...graph.nodes.find(item => item.id === id), rank: index,
    x: margin + (contentWidth - (level.length * (boxWidth + spacing) - spacing)) / 2 + column * (boxWidth + spacing),
    y: y[index], width: boxWidth, height: boxHeight,
  })));
  const byId = new Map(nodes.map(item => [item.id, item]));
  let bypass = 0;
  const edges = graph.edges.map((edge, index) => {
    const source = byId.get(edge.from), target = byId.get(edge.to);
    const port = (item, links) => item.x + item.width / 2 + (links.findIndex(link => link.id === edge.id) - (links.length - 1) / 2) * 24;
    const sx = port(source, outgoing(source.id)), tx = port(target, incoming(target.id));
    const start = source.y + boxHeight, finish = target.y;
    const track = level => y[level] + boxHeight + 40 + tracks[level].findIndex(link => link.id === edge.id) * 20;
    const points = [[sx, start], [sx, track(source.rank)]];
    if (target.rank > source.rank + 1) {
      const lane = margin + contentWidth + 24 + bypass++ * 20;
      points.push([lane, track(source.rank)], [lane, track(target.rank - 1)], [tx, track(target.rank - 1)]);
    } else points.push([tx, track(source.rank)]);
    points.push([tx, finish]);
    return { ...edge, number: index + 1, points };
  });
  const segments = edges.flatMap(edge => edge.points.slice(1).map((point, index) => ({ id: edge.id, a: edge.points[index], b: point })))
    .filter(segment => segment.a[0] !== segment.b[0] || segment.a[1] !== segment.b[1]);
  for (let i = 0; i < segments.length; i++) for (let j = i + 1; j < segments.length; j++) {
    const a = segments[i], b = segments[j], axis = a.a[0] === a.b[0] ? 0 : 1, other = 1 - axis;
    if (a.id !== b.id && b.a[axis] === b.b[axis] && a.a[axis] === b.a[axis]
      && Math.min(Math.max(a.a[other], a.b[other]), Math.max(b.a[other], b.b[other])) > Math.max(Math.min(a.a[other], a.b[other]), Math.min(b.a[other], b.b[other]))) return null;
  }
  return { nodes, edges, width: contentWidth + margin * 2 + (bypass ? 24 + bypass * 20 : 0), height: y.at(-1) + boxHeight + margin };
}

let diagramSequence = 0;
function diagramSvg(graph) {
  const layout = layoutDiagram(graph); if (!layout) return null;
  const prefix = `protocol-design-${++diagramSequence}`;
  const svg = (tag, attributes = {}, value) => {
    const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [key, val] of Object.entries(attributes)) element.setAttribute(key, String(val));
    if (value !== undefined) element.textContent = value;
    return element;
  };
  const ink = 'var(--diagram-ink, #202020)', muted = 'var(--diagram-muted, #666666)', paper = 'var(--diagram-paper, #ffffff)';
  const drawing = svg('svg', { class: 'protocol-diagram', viewBox: `0 0 ${layout.width} ${layout.height}`, width: layout.width, height: layout.height, role: 'img', 'aria-labelledby': `${prefix}-title ${prefix}-description` });
  drawing.style.setProperty('--diagram-width', `${layout.width}px`);
  drawing.append(svg('title', { id: `${prefix}-title` }, graph.title), svg('desc', { id: `${prefix}-description` }, `${graph.description} Numbered arrows correspond to the complete connections and sources below.`));
  const definitions = svg('defs'), marker = svg('marker', { id: `${prefix}-arrow`, markerWidth: 8, markerHeight: 8, refX: 8, refY: 4, orient: 'auto' });
  marker.append(svg('path', { d: 'M0 0L8 4L0 8Z', fill: muted })); definitions.append(marker); drawing.append(definitions);
  for (const edge of layout.edges) {
    const d = edge.points.map(([x, y], index) => `${index ? 'L' : 'M'}${x} ${y}`).join(' ');
    // A paper under-stroke makes crossings bridges, never junctions.
    drawing.append(svg('path', { d, fill: 'none', stroke: paper, 'stroke-width': 5 }));
    const path = svg('path', { d, fill: 'none', stroke: muted, 'stroke-width': 1.5, 'stroke-dasharray': edge.basis === 'observation' ? 'none' : edge.basis === 'inference' ? '2 4' : '6 4', 'marker-end': `url(#${prefix}-arrow)`, 'data-edge': edge.id });
    path.append(svg('title', {}, `${edge.number}. ${edge.label} (${BASIS_LABELS[edge.basis]})`)); drawing.append(path);
  }
  const measure = document.createElement('canvas').getContext('2d');
  for (const item of layout.nodes) {
    const family = /^0x[a-f0-9]+$/i.test(item.label) ? 'monospace' : 'sans-serif';
    if (measure) measure.font = `14px ${family}`;
    const lines = []; let line = '';
    for (const character of item.label) {
      const candidate = line + character;
      if (line && (measure ? measure.measureText(candidate).width : candidate.length * 14) > item.width - 32) {
        const boundary = candidate.lastIndexOf(' ');
        lines.push(boundary > 0 ? candidate.slice(0, boundary) : line);
        line = boundary > 0 ? candidate.slice(boundary + 1) : character;
      } else line = candidate;
    }
    if (line) lines.push(line);
    if (lines.length > 4) return null;
    drawing.append(svg('rect', { x: item.x, y: item.y, width: item.width, height: item.height, rx: 6, fill: paper, stroke: 'var(--diagram-rule, #bbbbbb)', 'stroke-width': 1, 'data-node': item.id }));
    const text = svg('text', { x: item.x + 16, y: item.y + item.height / 2 - (lines.length - 1) * 9 + 5, fill: ink, 'font-size': 14, 'font-family': family });
    lines.forEach((value, index) => text.append(svg('tspan', { x: item.x + 16, dy: index ? 18 : 0 }, value)));
    drawing.append(text);
  }
  for (const edge of layout.edges) drawing.append(svg('text', { x: edge.points[0][0] - 8, y: edge.points[0][1] + 22, fill: muted, 'text-anchor': 'end', 'font-size': 11, 'font-family': 'sans-serif' }, edge.number));
  return drawing;
}

export function renderProtocolDiagrams(presentation, investigation, cite) {
  const wrapper = node('div', 'protocol-diagrams');
  const graphs = presentation?.diagrams || [];
  const known = new Set(investigation.evidence.map(item => item.id));
  if (!graphs.length) {
    wrapper.append(node('p', 'notice', 'A protocol flow has not been established from these checks. Website links alone cannot show how funds move or who controls them.'));
    return wrapper;
  }
  for (const graph of graphs.slice(0, 3)) {
    const rows = diagramRows(graph, known);
    if (!rows) { wrapper.append(node('p', 'notice', 'A diagram was withheld because its relationships or evidence references are incomplete.')); continue; }
    const figure = node('figure', 'protocol-figure');
    const caption = node('figcaption');
    const templates = { money_flow: 'Money flow', contract_control: 'Contract control', dependencies: 'System dependencies' };
    caption.append(node('p', 'eyebrow', templates[graph.kind] || 'Protocol relationships'), node('h3', '', graph.title), node('p', '', graph.description));
    const flow = node('div', 'protocol-canvas');
    const drawing = diagramSvg(graph);
    if (drawing) {
      flow.append(drawing);
      flow.tabIndex = 0; flow.setAttribute('role', 'region'); flow.setAttribute('aria-label', 'Protocol diagram. Connections and sources follow below.');
      caption.append(node('p', 'diagram-layout-note', 'Follow the numbered arrows. Solid: observed. Dashed: project claim. Dotted: interpretation. Crossings are not connections.'));
      caption.append(node('p', 'diagram-mobile-note', 'Connections are listed below for this screen size.'));
    } else caption.append(node('p', 'diagram-layout-note', 'This graph uses the complete connection list below; no relationships have been removed.'));
    const connections = node('ol', 'diagram-connections');
    connections.setAttribute('aria-label', 'Connections and source evidence');
    for (const { from, to, edge } of rows) {
      const entry = node('li');
      entry.append(node('strong', '', `${from.label} to ${to.label}`), node('span', 'diagram-basis', BASIS_LABELS[edge.basis]),
        citedTextForConnection(edge, from, to, cite));
      connections.append(entry);
    }
    figure.append(caption, flow, connections);
    for (const limit of graph.limitations || []) figure.append(node('p', 'diagram-limit', limit));
    wrapper.append(figure);
  }
  return wrapper;
}

function citedTextForConnection(edge, from, to, cite) {
  return cite({ text: edge.label, evidenceIds: [...new Set([...from.evidenceIds, ...edge.evidenceIds, ...to.evidenceIds])] }, 'p', '');
}
