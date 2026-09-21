import type { discoverWebsite } from "./discovery.ts";
import type { Investigation } from "./investigation.ts";

export type ContractCandidate = {
  address: string; chainIds: number[]; sourceEvidenceIds: string[]; sourceUrls: string[];
  context: string; selected: boolean; reason: string;
};

/** Document links nominate candidates, not verified protocol membership or permissions. */
export function inventoryContracts(discovery: Awaited<ReturnType<typeof discoverWebsite>>, token: NonNullable<Investigation["subject"]["token"]>, limit: 0 | 4) {
  const entries = new Map<string, ContractCandidate>();
  let truncated = false;
  for (const page of discovery.pages) {
    truncated ||= page.addressesTruncated;
    for (const item of page.addresses) {
      let entry = entries.get(item.address);
      if (!entry) {
        if (entries.size >= 100) { truncated = true; continue; }
        const index = page.text.toLowerCase().indexOf(item.address);
        const before = index < 0 ? "" : page.text.slice(Math.max(0, index - 140), index).split(/0x[a-f0-9]{40}/i).at(-1)!.trim();
        entry = { address: item.address, chainIds: [], sourceEvidenceIds: [], sourceUrls: [], context: before.slice(-100), selected: false, reason: "" };
        entries.set(item.address, entry);
      }
      if (item.chainId !== null && !entry.chainIds.includes(item.chainId)) entry.chainIds.push(item.chainId);
      if (!entry.sourceEvidenceIds.includes(page.evidenceId)) entry.sourceEvidenceIds.push(page.evidenceId);
      if (!entry.sourceUrls.includes(page.url)) entry.sourceUrls.push(page.url);
    }
  }
  // Prefer explicit control/custody/staking/bond labels, then preserve discovery order.
  // Labels are untrusted context used only to allocate this bounded inspection budget.
  const priority = (entry: ContractCandidate) => /\b(safe|multisig)\)?\s*$/i.test(entry.context) ? 0
    : /\btreasury(?:\s*\([^)]{0,50}\))?\s*$/i.test(entry.context) ? 1 : /\bstaking(?:\s*\([^)]{0,50}\))?\s*$/i.test(entry.context) ? 2
    : /\b\w*bond(?:depository)?(?:\s*\([^)]{0,50}\))?\s*$/i.test(entry.context) ? 3 : 4;
  const candidates = [...entries.values()].sort((a, b) => priority(a) - priority(b));
  let selected = 0;
  for (const entry of candidates) {
    if (entry.address === token.address) entry.reason = "Primary token is inspected separately";
    else if (!entry.chainIds.length) entry.reason = "No supported explorer link establishes a candidate chain";
    else if (!entry.chainIds.includes(token.chainId)) entry.reason = "Explorer link points to another chain";
    else if (selected >= limit) entry.reason = limit ? "Outside the four-address related-contract budget" : "Related contracts are outside this saved scope";
    else { entry.selected = true; selected++; entry.reason = "Matching-chain explorer candidate selected for bounded read-only views"; }
  }
  return { kind: "contract_inventory" as const, candidates, truncated, limit,
    limitations: ["Project links do not prove that an address belongs to the protocol or has the documented role", "Text-only addresses are not assigned to the submitted chain", "Inventory contains at most 100 addresses from the captured pages; undiscovered modules are not counted"] };
}
