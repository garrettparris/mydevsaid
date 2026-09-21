import { z } from "zod";
import type { Investigation } from "./investigation.ts";
import type { Presentation, ReportStatement } from "./report-model.ts";

const address = z.string().regex(/^0x[a-fA-F0-9]{40}$/).refine(value => !/^0x0{40}$/.test(value)).transform(value => value.toLowerCase());
const snapshot = z.strictObject({ chainId: z.number().int().positive(), address,
  blockNumber: z.string().regex(/^(0|[1-9][0-9]*)$/), blockHash: z.string().regex(/^0x[a-fA-F0-9]{64}$/).transform(value => value.toLowerCase()) });
const configuration = z.strictObject({ threshold: z.number().int().min(1).max(20), owners: z.array(address).min(1).max(20) })
  .refine(value => value.threshold <= value.owners.length && new Set(value.owners).size === value.owners.length);
const observation = z.object({ kind: z.literal("related_contract"), address, snapshot,
  bytecode: z.string().max(262146).regex(/^0x(?:[a-fA-F0-9]{2})+$/), safeConfiguration: configuration });
const LIMITATION = "These Safe-compatible view calls return settings. They do not prove Safe identity, implemented authorization, who controls the signers, or permissions over other protocol contracts. Modules, guards and actual execution paths were not checked.";

/** Display only bounded, block-matched collector observations; never infer protocol authority. */
export function buildControlPresentation(investigation: Investigation): { statements: ReportStatement[]; diagrams: Presentation["diagrams"] } {
  const statements: ReportStatement[] = [], diagrams: Presentation["diagrams"] = [];
  const seen = new Set<string>();
  for (const evidence of investigation.evidence) {
    if (evidence.role !== "observation" || evidence.medium !== "onchain" || !evidence.snapshot) continue;
    let input: unknown;
    try { input = JSON.parse(evidence.content); } catch { continue; }
    const parsed = observation.safeParse(input), recorded = snapshot.safeParse(evidence.snapshot);
    if (!parsed.success || !recorded.success) continue;
    const value = parsed.data, block = value.snapshot;
    if (value.address !== block.address || block.address !== recorded.data.address || block.chainId !== recorded.data.chainId
      || block.blockNumber !== recorded.data.blockNumber || block.blockHash !== recorded.data.blockHash
      || (investigation.subject.token && block.chainId !== investigation.subject.token.chainId)) continue;
    const key = `${block.chainId}:${value.address}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const { threshold, owners } = value.safeConfiguration, evidenceIds = [evidence.id];
    statements.push({ basis: "observation", evidenceIds,
      text: `At block ${block.blockNumber} on chain ${block.chainId}, contract ${value.address} returned ${threshold} as its required approval count from getThreshold(), and ${owners.length} owner ${owners.length === 1 ? "address" : "addresses"} from getOwners(): ${owners.join(", ")}. This reads as a ${threshold}-of-${owners.length} approval setting. ${LIMITATION}` });
    if (diagrams.length < 3) diagrams.push({ id: `approval-settings-${diagrams.length + 1}`, title: "Returned approval settings",
      description: `Read-only calls to ${value.address} at block ${block.blockNumber} on chain ${block.chainId}. The arrows describe returned data, not control over the protocol.`,
      nodes: [{ id: "contract", label: value.address, evidenceIds },
        { id: "owners", label: `${owners.length} reported owner ${owners.length === 1 ? "address" : "addresses"}`, evidenceIds },
        { id: "threshold", label: `${threshold} required ${threshold === 1 ? "approval" : "approvals"} returned`, evidenceIds }],
      edges: [{ id: "owner-list", from: "contract", to: "owners", label: "getOwners() returns the address list", basis: "observation", evidenceIds },
        { id: "approval-count", from: "contract", to: "threshold", label: "getThreshold() returns the approval count", basis: "observation", evidenceIds }],
      limitations: [LIMITATION, "The complete owner addresses are listed in the control explanation and captured evidence. Money flows and relationships with other contracts remain unverified."] });
    if (statements.length >= 4) break;
  }
  return { statements, diagrams };
}
