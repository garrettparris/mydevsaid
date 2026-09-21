import assert from 'node:assert/strict';
import test from 'node:test';
import { diagramRows, layoutDiagram } from './report-map.js';

const graph = () => ({
  nodes: [{ id: 'user', label: 'Token holder', evidenceIds: ['doc'] }, { id: 'staking', label: 'Staking contract', evidenceIds: ['doc'] }],
  edges: [{ id: 'deposit', from: 'user', to: 'staking', label: 'Deposits tokens', basis: 'project_claim', evidenceIds: ['doc'] }],
});

function fixture(pairs) {
  return {
    nodes: [...new Set(pairs.flat())].map(id => ({ id, label: id, evidenceIds: ['doc'] })),
    edges: pairs.map(([from, to], index) => ({ id: `edge-${index}`, from, to, label: 'Calls', basis: 'project_claim', evidenceIds: ['doc'] })),
  };
}

for (const [name, pairs] of Object.entries({
  chain: [['a', 'b'], ['b', 'c']],
  control: [['admin', 'vault'], ['admin', 'token'], ['admin', 'router']],
  diamond: [['app', 'api'], ['app', 'vault'], ['api', 'oracle'], ['vault', 'oracle']],
  bypass: [['a', 'b'], ['b', 'c'], ['a', 'c']],
  parallel: [['a', 'b'], ['a', 'b']],
})) test(`${name}: layout retains all directed edges with distinct ports and avoids unrelated nodes`, () => {
  const input = fixture(pairs), snapshot = structuredClone(input), layout = layoutDiagram(input);
  assert.ok(layout); assert.deepEqual(input, snapshot);
  assert.equal(layout.nodes.length, input.nodes.length); assert.equal(layout.edges.length, input.edges.length);
  const starts = new Set(), ends = new Set();
  for (const edge of layout.edges) {
    const source = layout.nodes.find(item => item.id === edge.from), target = layout.nodes.find(item => item.id === edge.to);
    assert.equal(edge.points[0][1], source.y + source.height); assert.equal(edge.points.at(-1)[1], target.y);
    assert.ok(edge.points[0][0] > source.x && edge.points[0][0] < source.x + source.width);
    assert.ok(edge.points.at(-1)[0] > target.x && edge.points.at(-1)[0] < target.x + target.width);
    const start = edge.points[0].join(','), end = edge.points.at(-1).join(',');
    assert.ok(!starts.has(start)); assert.ok(!ends.has(end)); starts.add(start); ends.add(end);
    for (let i = 1; i < edge.points.length; i++) {
      const [x1, y1] = edge.points[i - 1], [x2, y2] = edge.points[i];
      assert.ok(x1 === x2 || y1 === y2);
      assert.ok(x2 >= 0 && x2 <= layout.width && y2 >= 0 && y2 <= layout.height);
      for (const item of layout.nodes) {
        const crosses = x1 === x2 ? x1 > item.x && x1 < item.x + item.width && Math.max(y1, y2) > item.y && Math.min(y1, y2) < item.y + item.height
          : y1 > item.y && y1 < item.y + item.height && Math.max(x1, x2) > item.x && Math.min(x1, x2) < item.x + item.width;
        assert.ok(!crosses, `${edge.id} crosses ${item.id}`);
      }
    }
  }
  assert.deepEqual(layoutDiagram({ ...input, nodes: [...input.nodes].reverse() }), layout);
});

test('cyclic and legacy oversized diagrams fall back without changing their data', () => {
  const cyclic = fixture([['a', 'b'], ['b', 'a']]);
  assert.ok(diagramRows(cyclic, evidence)); assert.equal(layoutDiagram(cyclic), null);
  const large = fixture(Array.from({ length: 9 }, (_, i) => [`n${i}`, `n${i + 1}`]));
  assert.ok(diagramRows(large, evidence)); assert.equal(layoutDiagram(large), null);
});

test('dense layouts never render overlapping connector segments', () => {
  const pairs = [['a', 'b'], ['a', 'c'], ['a', 'd'], ['b', 'c'], ['b', 'd'], ['c', 'd']];
  for (let mask = 1; mask < 64; mask++) {
    const input = fixture(pairs.filter((_, i) => mask & (1 << i))), layout = layoutDiagram(input);
    if (!layout) { assert.ok(diagramRows(input, evidence)); continue; }
    const segments = layout.edges.flatMap(edge => edge.points.slice(1).map((b, i) => ({id: edge.id, a: edge.points[i], b})));
    for (const a of segments) for (const b of segments) {
      if (a.id === b.id) continue;
      if (a.a[0] === a.b[0] && b.a[0] === b.b[0] && a.a[0] === b.a[0]) {
        assert.ok(Math.min(Math.max(a.a[1], a.b[1]), Math.max(b.a[1], b.b[1])) <= Math.max(Math.min(a.a[1], a.b[1]), Math.min(b.a[1], b.b[1])));
      }
      if (a.a[1] === a.b[1] && b.a[1] === b.b[1] && a.a[1] === b.a[1]) {
        assert.ok(Math.min(Math.max(a.a[0], a.b[0]), Math.max(b.a[0], b.b[0])) <= Math.max(Math.min(a.a[0], a.b[0]), Math.min(b.a[0], b.b[0])));
      }
    }
  }
});
const evidence = new Set(['doc']);
test('diagram layout preserves source direction, meaning, basis and citations', () => {
  const input = graph();
  const rows = diagramRows(input, evidence);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].from.label, 'Token holder');
  assert.equal(rows[0].to.label, 'Staking contract');
  assert.equal(rows[0].edge.basis, 'project_claim');
  assert.deepEqual(rows[0].edge.evidenceIds, ['doc']);
  assert.deepEqual(diagramRows(input, evidence), rows);
  assert.deepEqual(input, graph());
});
test('diagram renderer withholds missing sources, duplicate identities and dangling relationships', () => {
  for (const corrupt of [
    value => value.nodes.push(value.nodes[0]),
    value => value.edges.push(value.edges[0]),
    value => { value.edges[0].to = 'missing'; },
    value => { value.edges[0].to = 'user'; },
    value => { value.edges[0].evidenceIds = ['not-captured']; },
    value => { value.nodes[0].evidenceIds = []; },
    value => { value.edges[0].basis = 'verified_safe'; },
    value => { value.kind = '__proto__'; },
    value => { value.nodes[0] = null; },
    value => { value.edges[0] = null; },
  ]) {
    const input = graph(); corrupt(input);
    assert.equal(diagramRows(input, evidence), null);
  }
});
test('diagram layout refuses empty or oversized data while retaining text as data', () => {
  assert.equal(diagramRows(null, evidence), null);
  assert.equal(diagramRows({ nodes: [], edges: [] }, evidence), null);
  const oversized = graph(); oversized.nodes[0].label = 'a'.repeat(101);
  assert.equal(diagramRows(oversized, evidence), null);
  const input = graph(); input.nodes[0].label = '<img src=x onerror=alert(1)>';
  assert.equal(diagramRows(input, evidence)[0].from.label, input.nodes[0].label);
});
