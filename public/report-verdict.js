const AREAS = ['web_presence', 'public_code', 'deployment_match', 'api_behavior', 'contract_control', 'activity_quality'];
const TECHNICAL = new Set(AREAS.slice(1));

// A scoped reading of checked claims, never a prediction or a security rating.
export function reportVerdict(investigation = {}) {
  const checks = investigation.checks || [], findings = investigation.findings || [];
  const evidence = new Map((investigation.evidence || []).map(item => [item.id, item]));
  const observed = ids => ids?.length && ids.every(id => evidence.get(id)?.role === 'observation');
  const completed = area => checks.some(check => check.area === area && check.status === 'completed');
  const assessed = findings.filter(finding => completed(finding.area) && (
    finding.status === 'contradicted' ? observed(finding.contradictingEvidenceIds)
      : ['supported', 'partially_supported'].includes(finding.status) && observed(finding.supportingEvidenceIds)
  ));
  const refs = items => [...new Set(items.flatMap(item => item.status === 'contradicted' ? item.contradictingEvidenceIds : item.supportingEvidenceIds))];
  const seriousContradictions = assessed.filter(item => item.status === 'contradicted' && ['high', 'critical'].includes(item.severity));
  if (seriousContradictions.length) return {
    state: 'fake', title: 'mydevsaid: looks fake',
    text: 'Captured evidence contradicts important project claims. Read the checked claims below for exactly what failed; this does not establish intent.', evidenceIds: refs(seriousContradictions),
  };
  const unfinished = checks.some(check => ['pending', 'running'].includes(check.status));
  const technical = assessed.filter(item => TECHNICAL.has(item.area) && (item.status === 'contradicted' ? item.contradictingEvidenceIds : item.supportingEvidenceIds)
    .some(id => !['website', 'documentation', 'domain'].includes(evidence.get(id)?.medium)));
  const seriousConcerns = findings.some(item => ['high', 'critical'].includes(item.severity));
  const complete = AREAS.every(area => completed(area) && assessed.some(item => item.area === area));
  if (!unfinished && complete && !seriousConcerns && findings.length === assessed.length
    && assessed.every(item => item.status === 'supported' && ['informational', 'low'].includes(item.severity))
    && AREAS.slice(1).every(area => technical.some(item => item.area === area))) return {
    state: 'good', title: 'mydevsaid: looks good',
    text: 'The claims checked in this report are supported by captured observations. That applies to this scope and snapshot, not the safety of the whole project.', evidenceIds: refs(assessed),
  };
  if (!unfinished && !seriousConcerns && new Set(technical.map(item => item.area)).size >= 2) return {
    state: 'mixed', title: "mydevsaid: idk, it's alright i guess",
    text: 'There is technical evidence to work with, but the results are mixed or important checks remain unresolved. Read the gaps before drawing a conclusion.', evidenceIds: refs(technical),
  };
  return {
    state: 'unknown', title: 'mydevsaid: idk yet',
    text: unfinished ? 'Checks are still running. This take will update when the report has more evidence.'
      : seriousConcerns ? 'Important concerns need resolving before this deserves a positive take. Read the checked claims and coverage gaps below.'
        : 'There is not enough checked technical evidence to call this. A working website and token metadata alone are not enough.', evidenceIds: [],
  };
}
