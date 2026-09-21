import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { z } from "zod";

const text = z.string().trim().min(1).max(20_000);
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const date = z.iso.datetime({ offset: true });
const webUrl = z.url({ protocol: /^https?$/ }).refine((value) => {
  const url = URL.parse(value);
  return url !== null && !url.username && !url.password;
}, "URLs must not contain credentials").transform((value) => new URL(value).href);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const hash = (content: string) => createHash("sha256").update(content).digest("hex");
const ids = z.array(id).max(1_000).refine((values) => new Set(values).size === values.length, "Duplicate references");

export const CHECKS = {
  web_presence: "Inspect website, documentation, domain information, and project claims",
  public_code: "Inspect public repositories and implemented functionality",
  deployment_match: "Establish correspondence between published code and deployments",
  api_behavior: "Test accessible off-chain behavior under recorded conditions",
  contract_control: "Inspect deployed contracts, permissions, and dependencies",
  activity_quality: "Examine activity concentration and potentially coordinated behavior",
} as const;
const area = z.enum(Object.keys(CHECKS) as [keyof typeof CHECKS, ...(keyof typeof CHECKS)[]]);

// Address syntax and normalization only; chain support and deployment existence require collection.
export const tokenSchema = z.strictObject({
  chainId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/)
    .refine((value) => !/^0x0{40}$/.test(value), "A token cannot use the zero address")
    .transform((value) => value.toLowerCase()),
});
export const submissionSchema = z.strictObject({
  links: z.array(webUrl).min(1).max(20).transform((values) => [...new Set(values)]),
  token: tokenSchema.optional(),
  relatedContractLimit: z.union([z.literal(0), z.literal(4)]).optional(),
  domainLookup: z.enum(["exact_host", "registrable_domain"]).optional(),
});
const snapshotSchema = tokenSchema.extend({
  blockNumber: z.string().regex(/^(0|[1-9][0-9]*)$/),
  blockHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/).transform((value) => value.toLowerCase()),
});
const captureSchema = z.strictObject({
  id,
  role: z.enum(["claim", "observation"]),
  medium: z.enum(["website", "documentation", "domain", "repository", "api", "onchain", "activity"]),
  sourceUrl: webUrl,
  capturedAt: date,
  method: text,
  toolVersion: text,
  content: z.string().max(1_000_000),
  snapshot: snapshotSchema.optional(),
  revision: text.optional(),
});
const evidenceSchema = captureSchema.extend({ sha256: digest }).superRefine((evidence, ctx) => {
  if (hash(evidence.content) !== evidence.sha256) {
    ctx.addIssue({ code: "custom", path: ["sha256"], message: "Evidence content does not match its digest" });
  }
  if (["onchain", "activity"].includes(evidence.medium) && !evidence.snapshot) {
    ctx.addIssue({ code: "custom", path: ["snapshot"], message: "On-chain evidence requires a pinned block and address" });
  }
  if (evidence.medium === "repository" && !evidence.revision) {
    ctx.addIssue({ code: "custom", path: ["revision"], message: "Repository evidence requires a source revision" });
  }
});
const checkSchema = z.strictObject({
  area,
  status: z.enum(["pending", "running", "completed", "blocked", "not_applicable"]),
  evidenceIds: ids,
  reason: text.optional(),
}).superRefine((check, ctx) => {
  if (check.status === "completed" && check.evidenceIds.length === 0) {
    ctx.addIssue({ code: "custom", path: ["evidenceIds"], message: "Completed checks require evidence" });
  }
  if (["blocked", "not_applicable"].includes(check.status) && !check.reason) {
    ctx.addIssue({ code: "custom", path: ["reason"], message: "Coverage gaps require a reason" });
  }
});
const findingSchema = z.strictObject({
  id,
  area,
  claim: text,
  status: z.enum(["supported", "partially_supported", "contradicted", "unverified"]),
  severity: z.enum(["informational", "low", "medium", "high", "critical"]),
  explanation: text,
  impact: text,
  claimEvidenceIds: ids,
  supportingEvidenceIds: ids,
  contradictingEvidenceIds: ids,
  limitations: z.array(text).min(1).max(100),
}).superRefine((finding, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: "custom", message });
  if (["supported", "partially_supported"].includes(finding.status) && !finding.supportingEvidenceIds.length) {
    issue("Supported findings require supporting observations");
  }
  if (finding.status === "contradicted" && !finding.contradictingEvidenceIds.length) {
    issue("Contradicted findings require contradicting observations");
  }
  if (finding.status === "supported" && finding.contradictingEvidenceIds.length) {
    issue("A supported finding cannot omit the effect of contradictory evidence; reassess its status");
  }
  if (finding.supportingEvidenceIds.some((ref) => finding.contradictingEvidenceIds.includes(ref))) {
    issue("An observation cannot both support and contradict the same finding");
  }
});

export const investigationSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id,
  createdAt: date,
  subject: submissionSchema,
  checks: z.array(checkSchema).length(Object.keys(CHECKS).length),
  evidence: z.array(evidenceSchema).max(1_000),
  findings: z.array(findingSchema).max(1_000),
}).superRefine((report, ctx) => {
  const issue = (path: (string | number)[], message: string) => ctx.addIssue({ code: "custom", path, message });
  for (const [key, records] of [
    ["checks", report.checks.map((check) => check.area)],
    ["evidence", report.evidence.map((item) => item.id)],
    ["findings", report.findings.map((item) => item.id)],
  ] as const) {
    if (new Set(records).size !== records.length) issue([key], "Duplicate identifiers");
  }
  const evidence = new Map(report.evidence.map((item) => [item.id, item]));
  report.checks.forEach((check, index) => {
    for (const ref of check.evidenceIds) {
      if (!evidence.has(ref)) issue(["checks", index, "evidenceIds"], `Unknown evidence: ${ref}`);
    }
  });
  report.findings.forEach((finding, index) => {
    const check = report.checks.find((item) => item.area === finding.area);
    for (const field of ["claimEvidenceIds", "supportingEvidenceIds", "contradictingEvidenceIds"] as const) {
      for (const ref of finding[field]) {
        const item = evidence.get(ref);
        if (!item) issue(["findings", index, field], `Unknown evidence: ${ref}`);
        else if (item.role !== (field === "claimEvidenceIds" ? "claim" : "observation")) {
          issue(["findings", index, field], "Project assertions cannot substitute for observations");
        }
        if (!check?.evidenceIds.includes(ref)) issue(["findings", index, field], "Evidence must belong to the associated check");
      }
    }
    if (finding.status !== "unverified" && check?.status !== "completed") {
      issue(["findings", index, "status"], "Assessed findings require a completed check");
    }
  });
});

export type Investigation = z.infer<typeof investigationSchema>;
export type Evidence = z.infer<typeof evidenceSchema>;

export function createInvestigation(input: unknown): Investigation {
  return investigationSchema.parse({
    schemaVersion: 1,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    subject: submissionSchema.parse(input),
    checks: Object.keys(CHECKS).map((name) => ({ area: name, status: "pending", evidenceIds: [] })),
    evidence: [],
    findings: [],
  });
}

/** Hashes a collected payload. Integrity is checked; source authenticity is not established here. */
export function captureEvidence(input: z.input<typeof captureSchema>): Evidence {
  const capture = captureSchema.parse(input);
  return evidenceSchema.parse({ ...capture, sha256: hash(capture.content) });
}

/** Structural readiness for review only. This does not publish or certify a report. */
export function assessReadiness(input: unknown, now = new Date()) {
  if (!Number.isFinite(now.getTime())) throw new Error("Review time must be valid");
  const parsed = investigationSchema.safeParse(input);
  if (!parsed.success) {
    return { readyForReview: false, issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`), coverage: null };
  }
  const report = parsed.data;
  const issues: string[] = [];
  if (!report.subject.token) issues.push("Resolve the chain and token address before report review");
  if (Date.parse(report.createdAt) > now.getTime()) issues.push("Investigation creation time is in the future");
  if (!report.findings.length) issues.push("At least one finding is required");
  for (const item of report.evidence) {
    if (Date.parse(item.capturedAt) > now.getTime()) issues.push(`Evidence ${item.id} has a future capture time`);
  }
  for (const check of report.checks) {
    if (["pending", "running"].includes(check.status)) issues.push(`${check.area}: investigation is unfinished`);
    if (check.status === "completed" && !report.findings.some((finding) => finding.area === check.area)) {
      issues.push(`${check.area}: completed check has no finding`);
    }
  }
  const coverage = {
    completed: report.checks.filter((check) => check.status === "completed").length,
    blocked: report.checks.filter((check) => check.status === "blocked").length,
    notApplicable: report.checks.filter((check) => check.status === "not_applicable").length,
    unfinished: report.checks.filter((check) => ["pending", "running"].includes(check.status)).length,
  };
  if (!coverage.completed) issues.push("At least one check must have completed");
  return { readyForReview: issues.length === 0, issues, coverage };
}

// Local intake only: prints a draft and never fetches URLs, calls models, or publishes.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [url, chainId, address, ...extra] = process.argv.slice(2);
    if (!url || Boolean(chainId) !== Boolean(address) || extra.length) {
      throw new Error("Usage: npm run plan -- <website-url> [chain-id token-address]");
    }
    const report = createInvestigation({
      links: [url],
      ...(chainId && address ? { token: { chainId: Number(chainId), address } } : {}),
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
