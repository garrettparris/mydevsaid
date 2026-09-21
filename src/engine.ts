import { buildPresentation, type Presentation } from "./report-model.ts";
import { pathToFileURL } from "node:url";
import { discoverWebsite } from "./discovery.ts";
import { collectProject, type CollectionResult } from "./collectors.ts";
import { investigationSchema, submissionSchema, type Investigation } from "./investigation.ts";
import { isPiConfigured, narrateWithPi, validateNarration, type Narration } from "./pi-runner.ts";

export { isPiConfigured } from "./pi-runner.ts";
export type AnalysisResult = {
  investigation: Investigation;
  summary: { explanation: string; keyFindings: string[]; limitations: string[] };
  discovery: Awaited<ReturnType<typeof discoverWebsite>>;
  analysisMode: "pi" | "deterministic";
  generatedAt: string;
  narration?: Narration;
  presentation?: Presentation;
};
export type LiveReport = {
  updatedAt: string;
  presentation: Presentation;
  checks: Investigation["checks"];
  sources: Pick<Investigation["evidence"][number], "id" | "sourceUrl" | "medium" | "role" | "capturedAt">[];
  findings: Investigation["findings"];
};
export type InvestigationProgress = (message: string, live?: LiveReport) => void;
type Dependencies = {
  discover?: typeof discoverWebsite;
  collect?: typeof collectProject;
  narrate?: (investigation: Investigation) => Promise<Narration>;
  modelEnabled?: boolean;
};

export async function runInvestigation(input: unknown, onProgress: InvestigationProgress = () => {}, dependencies: Dependencies = {}): Promise<AnalysisResult> {
  const subject = submissionSchema.parse(input);
  onProgress("Inspecting submitted websites and documentation.");
  const discovery = await (dependencies.discover ?? discoverWebsite)(subject, { maxPages: 5 });
  const publishPartial = (partial: CollectionResult) => {
    const checks = new Map(discovery.investigation.checks.map(check => [check.area, check]));
    for (const check of partial.checks) checks.set(check.area, check);
    const snapshot = investigationSchema.parse({ ...discovery.investigation, checks: [...checks.values()],
      evidence: [...discovery.investigation.evidence, ...partial.evidence], findings: [...discovery.investigation.findings, ...partial.findings] });
    onProgress("Live report updated with captured evidence.", {
      updatedAt: new Date().toISOString(), presentation: buildPresentation(snapshot), checks: snapshot.checks,
      sources: snapshot.evidence.map(({ id, sourceUrl, medium, role, capturedAt }) => ({ id, sourceUrl, medium, role, capturedAt })),
      findings: snapshot.findings,
    });
  };
  onProgress("Collecting repository, domain, API and on-chain observations.");
  const collected = await (dependencies.collect ?? collectProject)(subject, discovery, onProgress, { onPartial: publishPartial });
  const merged = new Map(discovery.investigation.checks.map((check) => [check.area, check]));
  for (const check of collected.checks) merged.set(check.area, check);
  const checks = [...merged.values()].map((check) => ["running", "pending"].includes(check.status)
    ? { ...check, status: "blocked" as const, reason: "This check did not finish within the available collection scope." } : check);
  const investigation = investigationSchema.parse({ ...discovery.investigation, checks,
    evidence: [...discovery.investigation.evidence, ...collected.evidence],
    findings: [...discovery.investigation.findings, ...collected.findings],
  });
  const limitations = [...new Set([...discovery.limitations, ...collected.limitations,
    ...checks.flatMap((check) => check.status === "blocked" && check.reason ? [check.reason] : []),
    "This is a bounded technical investigation at the recorded time and blocks. It is not a security audit or a guarantee of future behavior.",
  ])];
  const presentation = buildPresentation(investigation);
  const result: AnalysisResult = {
    investigation, discovery, presentation, analysisMode: "deterministic", generatedAt: new Date().toISOString(),
    summary: {
      explanation: presentation.overview.text,
      keyFindings: investigation.findings.slice(0, 8).map((finding) => finding.explanation), limitations,
    },
  };
  if (dependencies.modelEnabled ?? isPiConfigured()) {
    onProgress("Pi is preparing an evidence-cited explanation for review.");
    try {
      const narration = validateNarration(await (dependencies.narrate ?? narrateWithPi)(investigation), investigation);
      result.analysisMode = "pi"; result.narration = narration;
      if (narration.presentation) result.presentation = narration.presentation;
      result.summary = { explanation: narration.explanation.text, keyFindings: narration.keyFindings.map((item) => item.text),
        limitations: [...new Set([...limitations, ...narration.limitations, "AI-written explanations require reviewer verification against their cited evidence."])] };
    } catch {
      result.summary.limitations.push("Pi explanation was unavailable or failed validation. This report contains collector observations and labeled project excerpts.");
      onProgress("Collector evidence is retained; Pi explanation was unavailable.");
    }
  } else result.summary.limitations.push("Pi is not configured. This report contains collector observations and labeled project excerpts without an AI explanation.");
  onProgress("Evidence collection finished. The draft is ready for coverage review.");
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [url, chain, address, ...extra] = process.argv.slice(2);
  if (!url || Boolean(chain) !== Boolean(address) || extra.length) {
    process.stderr.write("Usage: npm run investigate -- <website-url> [chain-id token-address]\n"); process.exitCode = 1;
  } else {
    try {
      const result = await runInvestigation({ links: [url], ...(chain && address ? { token: { chainId: Number(chain), address } } : {}) },
        (message) => process.stderr.write(`${message}\n`));
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
  }
}
