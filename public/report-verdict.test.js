import assert from 'node:assert/strict';
import test from 'node:test';
import { reportVerdict } from './report-verdict.js';

function fixture() {
  const areas = ['web_presence', 'public_code', 'deployment_match', 'api_behavior', 'contract_control', 'activity_quality'];
  return {
    checks: areas.map(area => ({ area, status: 'completed' })),
    findings: areas.map(area => ({ area, status: 'supported', severity: 'informational', supportingEvidenceIds: [area], contradictingEvidenceIds: [] })),
    evidence: areas.map(id => ({ id, role: 'observation', medium: 'rpc' })),
  };
}

test('positive take requires completed coverage and observed support across technical areas', () => {
  assert.equal(reportVerdict(fixture()).state, 'good');
  const partial = fixture(); partial.checks[2].status = 'blocked';
  assert.equal(reportVerdict(partial).state, 'mixed');
  const running = fixture(); running.checks[2].status = 'running';
  assert.equal(reportVerdict(running).state, 'unknown');
});

test('missing evidence, project claims, and website-only evidence cannot earn a positive take', () => {
  assert.equal(reportVerdict().state, 'unknown');
  for (const modify of [data => { data.evidence = []; }, data => data.evidence.forEach(item => { item.role = 'claim'; }), data => data.evidence.forEach(item => { item.medium = 'website'; })]) {
    const data = fixture(); modify(data); assert.equal(reportVerdict(data).state, 'unknown');
  }
});

test('looks fake requires a material contradiction and cites its actual evidence', () => {
  const data = fixture();
  Object.assign(data.findings[2], {status: 'contradicted', severity: 'high', supportingEvidenceIds: [], contradictingEvidenceIds: ['deployment_match']});
  assert.equal(reportVerdict(data).state, 'fake');
  assert.deepEqual(reportVerdict(data).evidenceIds, ['deployment_match']);
  data.findings[2].contradictingEvidenceIds = ['missing'];
  assert.equal(reportVerdict(data).state, 'unknown');
});

test('supported findings about serious risks cannot become a positive or casual mixed verdict', () => {
  const data = fixture(); data.findings[3].severity = 'critical';
  assert.equal(reportVerdict(data).state, 'unknown');
  data.findings[3].severity = 'informational'; data.findings[3].status = 'unverified';
  assert.equal(reportVerdict(data).state, 'mixed');
});
