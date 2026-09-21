import { z } from "zod";
import type { Evidence, Investigation } from "./investigation.ts";
import { buildControlPresentation } from "./control-presentation.ts";

const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const text = z.string().trim().min(1).max(2_000);
const references = z.array(identifier).max(20).refine((ids) => new Set(ids).size === ids.length, "Duplicate evidence references");
const basis = z.enum(["project_claim", "observation", "inference", "unknown"]);
const statementSchema = z.strictObject({ text, evidenceIds: references, basis });
export const SECTION_TITLES = {
  purpose: "What this project does",
  money_flow: "How money moves",
  token_role: "What the token is for",
  control: "Who has control",
  activity: "What activity suggests",
  concerns: "Main concerns",
  unknowns: "What remains unknown",
} as const;
const sectionId = z.enum(Object.keys(SECTION_TITLES) as [keyof typeof SECTION_TITLES, ...(keyof typeof SECTION_TITLES)[]]);
export const presentationSchema = z.strictObject({
  overview: statementSchema,
  sections: z.array(z.strictObject({ id: sectionId, title: z.string().trim().min(1).max(80), items: z.array(statementSchema).min(1).max(12) })).length(7),
  diagrams: z.array(z.strictObject({
    kind: z.enum(["money_flow", "contract_control", "dependencies"]).optional(),
    id: identifier, title: z.string().trim().min(1).max(80), description: text,
    nodes: z.array(z.strictObject({ id: identifier, label: z.string().trim().min(1).max(60), evidenceIds: references.min(1) })).min(2).max(9),
    edges: z.array(z.strictObject({ id: identifier, from: identifier, to: identifier, label: z.string().trim().min(1).max(90),
      basis: z.enum(["project_claim", "observation", "inference"]), evidenceIds: references.min(1) })).min(1).max(12),
    limitations: z.array(z.string().trim().min(1).max(1_000)).min(1).max(10),
  })).max(3),
  mode: z.enum(["deterministic", "pi", "reviewed"]),
});
export type Presentation = z.infer<typeof presentationSchema>;
export type ReportStatement = z.infer<typeof statementSchema>;

/** Structure and provenance gates cannot establish that evidence entails every sentence. */
export function validatePresentation(input: unknown, investigation: Investigation): Presentation {
  const presentation = presentationSchema.parse(input);
  const evidence = new Map(investigation.evidence.map((item) => [item.id, item]));
  const unique = (ids: string[]) => { if (new Set(ids).size !== ids.length) throw new Error("Duplicate presentation identifiers"); };
  const cite = (item: { evidenceIds: string[]; basis?: string }) => {
    if (item.evidenceIds.some((id) => !evidence.has(id))) throw new Error("Presentation cites unknown evidence");
    if (item.basis && item.basis !== "unknown" && !item.evidenceIds.length) throw new Error("Presentation statements require evidence");
    if (item.basis === "observation" && !item.evidenceIds.some((id) => {
      const record = evidence.get(id)!;
      return record.role === "observation" && !["website", "documentation"].includes(record.medium);
    })) throw new Error("Project documents cannot establish an observed protocol relationship");
  };
  unique(presentation.sections.map((section) => section.id));
  for (const item of [presentation.overview, ...presentation.sections.flatMap((section) => section.items)]) cite(item);
  unique(presentation.diagrams.map((diagram) => diagram.id));
  for (const diagram of presentation.diagrams) {
    unique(diagram.nodes.map((node) => node.id)); unique(diagram.edges.map((edge) => edge.id));
    const nodes = new Set(diagram.nodes.map((node) => node.id));
    for (const node of diagram.nodes) cite(node);
    for (const edge of diagram.edges) {
      cite(edge);
      if (edge.from === edge.to) throw new Error("Diagram cannot connect a node to itself");
      if (!nodes.has(edge.from) || !nodes.has(edge.to)) throw new Error("Diagram has a dangling relationship");
    }
    for (const node of nodes) {
      if (!diagram.edges.some((edge) => edge.from === node || edge.to === node)) throw new Error("Diagram has an unconnected node");
    }
  }
  return presentation;
}

function documentSentences(evidence: Evidence): string[] {
  if (evidence.role !== "claim" || !["website", "documentation"].includes(evidence.medium)) return [];
  try {
    const parsed: unknown = JSON.parse(evidence.content);
    if (!parsed || typeof parsed !== "object" || !("text" in parsed) || typeof parsed.text !== "string") return [];
    let value = parsed.text.replace(/\s+/g, " ").trim();
    if ("title" in parsed && typeof parsed.title === "string" && value.startsWith(parsed.title)) value = value.slice(parsed.title.length).trim();
    // Quote complete bounded sentences only. This is selection, not a semantic protocol parser.
    return value.split(/(?<=[.!?])\s+(?=[A-Z0-9])/).filter((sentence) => sentence.length >= 35 && sentence.length <= 480 && /[.!?]$/.test(sentence));
  } catch { return []; }
}

/** Useful source excerpts without pretending a model or a mechanism verifier ran. */
export function buildPresentation(investigation: Investigation): Presentation {
  const controls = buildControlPresentation(investigation);
  const documents = investigation.evidence.flatMap((record) => documentSentences(record).map((sentence) => ({ sentence, id: record.id })));
  const claimed = (record: { sentence: string; id: string }): ReportStatement => ({
    text: `Project documentation states: "${record.sentence}"`, evidenceIds: [record.id], basis: "project_claim",
  });
  const unknown = (value: string): ReportStatement => ({ text: value, evidenceIds: [], basis: "unknown" });
  const first = documents.find(({ sentence }) =>
    /\b(?:is|provides|offers)\s+(?:(?:a|an|the)\s+)?(?:[A-Za-z-]+\s+){0,4}(?:protocol|token|platform|application|exchange|marketplace|service|fund|vault)\b/i.test(sentence)
    && !/\b(safe|secure|guaranteed|audited|risk-free)\b/i.test(sentence));
  const excerpts = (pattern: RegExp) => {
    const seenSources = new Set<string>();
    return documents.filter(({ sentence, id }) => sentence !== first?.sentence && pattern.test(sentence) && !seenSources.has(id) && Boolean(seenSources.add(id))).slice(0, 3).map(claimed);
  };
  const overview = first ? claimed(first) : unknown("The captured sources do not provide a clear description of this project's purpose. A reviewer needs substantive documentation before explaining the mechanism.");
  const items: Record<keyof typeof SECTION_TITLES, ReportStatement[]> = {
    purpose: first ? [claimed(first)] : [],
    money_flow: excerpts(/\b(custodies|reserves are|deposits?|withdrawals?|buybacks?|earns? yield|trading fee|payouts?)\b/i),
    token_role: excerpts(/\b(stake [A-Z]|receive [A-Z]|token holders|holders can|holders may|governance|redeem)\b/),
    control: [...controls.statements, ...excerpts(/\b(admin|owner|permissioned|multisig|threshold|whitelist|upgrade)\b/i)],
    activity: [], concerns: [], unknowns: [],
  };
  for (const finding of investigation.findings) {
    const refs = [...new Set([...finding.supportingEvidenceIds, ...finding.contradictingEvidenceIds, ...finding.claimEvidenceIds])].slice(0, 20);
    const observed = refs.some((id) => investigation.evidence.some((e) => e.id === id && e.role === "observation" && !["website", "documentation"].includes(e.medium)));
    const statement: ReportStatement = { text: finding.explanation.slice(0, 2_000), evidenceIds: refs, basis: refs.length ? observed ? "observation" : "inference" : "unknown" };
    if (finding.id.startsWith("gmgn-info-")) items.purpose.push(statement);
    if (finding.id.startsWith("gmgn-pool-")) items.money_flow.push(statement);
    if (finding.area === "activity_quality" && !finding.id.startsWith("gmgn-pool-")) {
      items.activity.push(statement);
      items.activity.push(unknown(finding.limitations.join(" ").slice(0, 2_000)));
    }
    if (finding.area === "contract_control") {
      items.control.push(statement);
      items.control.push(unknown(finding.limitations.join(" ").slice(0, 2_000)));
    }
    if (["medium", "high", "critical"].includes(finding.severity) || finding.status === "contradicted") items.concerns.push(statement);
  }
  items.unknowns = investigation.checks.filter((check) => check.status !== "completed" && check.status !== "not_applicable")
    .map((check) => unknown(check.reason || `The ${check.area.replaceAll("_", " ")} check has not finished.`));
  items.unknowns.push(unknown("Documentation excerpts describe project claims. Connected contracts, actual money flows, and all permission holders have not been established by selecting these excerpts."));
  items.unknowns.push(unknown(controls.diagrams.length
    ? "The generated diagrams show only returned approval settings. The protocol mechanism, money flows and authority between connected contracts still require further evidence and explanation."
    : "No protocol diagram was generated automatically: the current collector does not establish a structured mechanism graph. A cited model or reviewer explanation is required."));
  const gaps: Record<keyof typeof SECTION_TITLES, string> = {
    purpose: "The project's purpose is not clear from the captured material.",
    money_flow: "The captured material does not establish how deposits, fees, reserves and withdrawals connect.",
    token_role: "The token's role is not established by the captured material.",
    control: "The complete set of people and contracts able to change behavior has not been established.",
    activity: "Activity quality has not been established. Transaction counts alone cannot identify independent users.",
    concerns: "This run does not establish whether the project is safe. Material risks may remain outside the completed checks.",
    unknowns: "This is a bounded investigation, not a security audit or a guarantee of future behavior.",
  };
  return validatePresentation({ overview, mode: "deterministic", diagrams: controls.diagrams, sections: Object.entries(SECTION_TITLES).map(([id, title]) => {
    const key = id as keyof typeof SECTION_TITLES;
    return { id, title, items: items[key].length ? items[key].slice(0, 12) : [unknown(gaps[key])] };
  }) }, investigation);
}
