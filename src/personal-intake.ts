import { parse as parseDomain } from "tldts";
import { investigationSchema, submissionSchema } from "./investigation.ts";

export type IntakeSubmission = {
  links: string[]; token?: { chainId: number; address: string } | undefined; relatedContractLimit?: 0 | 4 | undefined;
  domainLookup?: "exact_host" | "registrable_domain" | undefined;
};
const NETWORKS: Record<number, string> = { 1: "Ethereum", 8453: "Base", 4663: "Robinhood Chain" };
const EXPLORERS: Record<string, number> = { "etherscan.io": 1, "basescan.org": 8453, "robinhoodchain.blockscout.com": 4663 };
const ADDRESS = /(?<![a-z0-9_])0x[a-f0-9]{40}(?![a-z0-9_])/gi;
const ZERO = /^0x0{40}$/;
const ONLY_WEB = /\b(?:just|only) (?:the )?(?:website|web|docs|documentation)\b|\b(?:website|web|docs)[ -]only\b/i;
const RESET_TOKEN = /\b(?:remove|clear|forget)\s+(?:the\s+)?(?:token|address|contract)\b/i;
const CHANGE = /^\s*(?:(?:please|ok|okay)\s+)*(?:(?:confirm|use|set|replace|change|switch|update|correct)\s+(?:(?:the|this|primary|my)\s+){0,2}(?:token|address|contract|chain|network|ethereum|base|robinhood|to\b|0x)|(?:investigate|analy[sz]e|check)\s+(?:(?:the|this|primary)\s+){0,2}(?:token|address|contract)\b)/i;
const trimUrl = (url: string) => url.replace(/[),.;!?]+$/, "");

function parseMessage(message: string) {
  const links: string[] = [], positions = new Map<string, number>(), chains = new Set<number>();
  let invalidLink = false, unsupportedExplorer = false;
  const accept = (raw: string, position: number) => {
    const parsed = submissionSchema.safeParse({ links: [trimUrl(raw)] });
    if (!parsed.success) { invalidLink = true; return; }
    const url = new URL(parsed.data.links[0]!); url.hash = "";
    if (!links.includes(url.href)) links.push(url.href);
    positions.set(url.href, Math.min(positions.get(url.href) ?? position, position));
    const network = EXPLORERS[url.hostname.replace(/^www\./, "")];
    if (network && /^\/(?:address|token)\/0x[a-f0-9]{40}(?:\/|$)/i.test(url.pathname)) chains.add(network);
    if (!network && /(?:^|\.)(?:etherscan\.io|basescan\.org|arbiscan\.io|bscscan\.com|polygonscan\.com)$|testnet.*robinhood/i.test(url.hostname)) unsupportedExplorer = true;
  };
  const withoutUrls = message.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"\]]+/gi, (raw, position: number) => {
    if (/^https?:\/\//i.test(raw)) accept(raw, position); else invalidLink = true;
    return " ".repeat(raw.length);
  });
  // Bare domains are convenience input, not network validation; the fetcher still checks DNS and redirects.
  for (const match of withoutUrls.matchAll(/(?<![a-z0-9_@/.-])(?:[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?\.)+[a-z]{2,63}(?:\/[^\s<>"\]]*)?/gi)) {
    const value = trimUrl(match[0]), domain = parseDomain(value, { allowPrivateDomains: true });
    if (domain.domain && (domain.isIcann || domain.isPrivate)) accept(`https://${value}`, match.index);
  }
  const chainText = withoutUrls.replace(/\b[a-z0-9.-]+\.[a-z]{2,63}(?:\/\S*)?/gi, " ");
  if (/\bethereum\b/i.test(chainText)) chains.add(1);
  if (/\brobinhood(?:\s+chain)?\b/i.test(chainText)) chains.add(4663);
  if ((/\bbase\b/i.test(chainText) && /0x[a-f0-9]{40}/i.test(chainText)) || /\bbase\s+(?:chain|mainnet|network)\b|\b(?:on|chain|network|use|to)\s+base\b/i.test(chainText) || /^\s*base\s*[.!]?\s*$/i.test(chainText)) chains.add(8453);
  for (const [, id] of chainText.matchAll(/\b(?:chain(?:\s*id)?|network)\s*[:=]?\s*(\d+)\b/gi)) chains.add(Number(id));
  if (/^\s*(?:1|8453|4663)\s*$/.test(chainText)) chains.add(Number(chainText));
  const addresses = [...new Set([...message.matchAll(ADDRESS)].map(([value]) => value.toLowerCase()))];
  const invalidAddress = [...message.matchAll(/(?<![a-z0-9_])0x[a-z0-9]*/gi)].some(([value]) => !/^0x[a-f0-9]{40}$/i.test(value) || ZERO.test(value.toLowerCase()));
  const unsupported = unsupportedExplorer || /\btestnet\b/i.test(chainText) || [...chains].some(chain => !NETWORKS[chain]);
  const terse = chainText.replace(ADDRESS, "").replace(/\b(?:chain|id|network|token|address|ethereum|base|robinhood|mainnet|4663|8453|1)\b/gi, "").replace(/[\s:=,.!]/g, "").length === 0;
  return { links: links.sort((a, b) => positions.get(a)! - positions.get(b)!), addresses: addresses.filter(address => !ZERO.test(address)), chains: [...chains], unsupported, invalidAddress,
    invalidLink, explicitIdentity: CHANGE.test(chainText) || terse, onlyWeb: ONLY_WEB.test(chainText), clearToken: RESET_TOKEN.test(chainText) };
}

/** Parse user-authored inputs only. No fetched text, inference model, or network calls participate. */
export function mergeIntake(previous: IntakeSubmission, messages: string[], latest: string) {
  if (typeof latest !== "string" || !latest.trim() || latest.length > 20_000) throw new Error("Send 1 to 20,000 characters.");
  const current = parseMessage(latest), questions: string[] = [];
  const baseLinks = /\breplace\s+(?:the\s+)?links\b/i.test(latest) ? [] : previous.links;
  const newLinks = current.links.filter(link => !baseLinks.includes(link));
  const allLinks = [...new Set(baseLinks.length && newLinks.length
    ? [baseLinks[0]!, ...newLinks, ...baseLinks.slice(1)]
    : [...baseLinks, ...newLinks])];
  const submission: IntakeSubmission = { ...previous, links: allLinks.slice(0, 20) };
  let pendingAddress: string | undefined, pendingChain: number | undefined;
  // Recover incomplete identity across user turns, without treating earlier ambiguity as confirmation.
  if (!previous.token) {
    for (const input of [...messages.slice(-30), latest]) {
      if (typeof input !== "string" || input.length > 20_000) continue;
      const part = parseMessage(input);
      if (part.onlyWeb || part.clearToken) { pendingAddress = undefined; pendingChain = undefined; continue; }
      if (part.unsupported || part.chains.length > 1) { pendingChain = undefined; pendingAddress = undefined; continue; }
      if (part.chains.length === 1) {
        if (pendingChain !== undefined && pendingChain !== part.chains[0] && !part.addresses.length) pendingAddress = undefined;
        pendingChain = part.chains[0];
      }
      if (part.invalidAddress || part.addresses.length > 1) pendingAddress = undefined;
      else if (part.addresses.length === 1) pendingAddress = part.addresses[0];
    }
  } else { pendingAddress = previous.token.address; pendingChain = previous.token.chainId; }
  const identityInput = !previous.token || current.explicitIdentity;
  if (current.onlyWeb || current.clearToken) { delete submission.token; pendingAddress = undefined; pendingChain = undefined; }
  else if (identityInput) {
    if (current.unsupported || current.chains.length > 1) {
      delete submission.token; pendingAddress = undefined; pendingChain = undefined;
      questions.push(current.unsupported ? "For contract checks, choose Ethereum, Base, or Robinhood Chain mainnet. Website analysis can still proceed." : "Several networks were mentioned. Which single network should contract checks use? Website analysis can still proceed.");
    } else {
      if (current.chains.length === 1 && previous.token?.chainId !== undefined && current.chains[0] !== previous.token.chainId) {
        pendingChain = current.chains[0]; pendingAddress = current.addresses.length === 1 ? current.addresses[0] : undefined; delete submission.token;
      }
      if (current.invalidAddress || current.addresses.length > 1) {
        pendingAddress = undefined; delete submission.token;
        questions.push(current.invalidAddress ? "Send one nonzero EVM token address for contract checks. Website analysis can still proceed." : "Several addresses were supplied. Confirm the one primary token address to investigate; website analysis can still proceed.");
      } else if (current.addresses.length === 1) pendingAddress = current.addresses[0];
      if (pendingAddress && pendingChain && NETWORKS[pendingChain]) submission.token = { address: pendingAddress, chainId: pendingChain };
      else delete submission.token;
    }
  }
  if (allLinks.length > 20) questions.push("Only the first 20 links were retained. Use 'replace links' to choose another set.");
  if (current.invalidLink) questions.push("Unsupported or credential-bearing links were skipped. Use an HTTP(S) link or a bare project domain.");
  if (!submission.links.length) questions.push("Share a project website or documentation link to start. A token address is optional.");
  if (!submission.token && !current.onlyWeb && !current.clearToken && !questions.some(question => /contract checks|Several networks/.test(question))) {
    if (pendingAddress) questions.push("Which network is that address on: Ethereum, Base, or Robinhood Chain? Website analysis does not need a token.");
    else if (pendingChain) questions.push(`Confirm the primary token address on ${NETWORKS[pendingChain]} to include contract checks. Website analysis can proceed without it.`);
  }
  const parsed = submission.links.length ? submissionSchema.parse(submission) : submission;
  const changed = JSON.stringify({ links: previous.links, token: previous.token }) !== JSON.stringify({ links: parsed.links, token: parsed.token });
  const detected: { links: string[]; addresses: string[]; chainId?: number } = { links: current.links.slice(0, 20), addresses: current.addresses.slice(0, 20) };
  if (!current.unsupported && current.chains.length === 1) detected.chainId = current.chains[0]!;
  const pageLimit = parsed.links.length > 3 ? " Each investigation attempts the first three links; the remaining links stay saved." : "";
  const reply = `${parsed.links.length ? parsed.token ? `I can investigate the supplied pages and the token on ${NETWORKS[parsed.token.chainId]}.` : "I can start with the supplied website and documentation." : "Send a website, documentation, or an explorer link to start."}${pageLimit} ${questions.join(" ")}`.trim();
  return { submission: parsed, questions, changed, detected, reply };
}

const STOP = new Set("what which where when how does do did is are was were the this that about can you please tell explain more report project token latest now have has had from with and its for any there it my me of to a an be".split(" "));
/** Retrieve cited finding excerpts only; this helper does not run a model or a fresh investigation. */
export function answerReport(question: string, result: unknown): { text: string; evidenceIds: string[] } {
  const wrapper = result && typeof result === "object" ? result as Record<string, unknown> : {};
  const source = wrapper.result && typeof wrapper.result === "object" ? wrapper.result as Record<string, unknown> : wrapper;
  const parsed = investigationSchema.safeParse(source.investigation);
  if (!parsed.success) return { text: "There is no valid captured report to answer from yet. Add a project link to collect evidence.", evidenceIds: [] };
  const investigation = parsed.data;
  const terms = [...new Set((String(question).slice(0, 20_000).toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g) ?? []).filter(term => !STOP.has(term)))];
  const aliases: Record<string, string[]> = { control: ["owner", "admin", "permission", "threshold", "safe"], fee: ["tax", "conversion", "allocation"], activity: ["transfer", "wallet", "organic"], code: ["source", "repository", "bytecode"], domain: ["registration", "rdap", "age"], staking: ["stake", "snet", "rebase"] };
  for (const [key, values] of Object.entries(aliases)) if (terms.some(term => term.includes(key) || values.some(value => term.includes(value)))) terms.push(key, ...values);
  const overview = /\b(?:summary|summarize|overview)\b/i.test(question);
  const selected = investigation.findings.map(finding => {
    const haystack = `${finding.claim} ${finding.explanation} ${finding.area}`.toLowerCase();
    return { finding, score: terms.filter(term => haystack.includes(term)).length };
  }).filter(entry => overview || entry.score > 0).sort((a, b) => b.score - a.score).slice(0, 3).map(entry => entry.finding);
  if (!selected.length) return { text: "I could not find an answer in the captured findings. Share a documentation, repository or API link that explains this claim, and I can include it in the next investigation.", evidenceIds: [] };
  const evidenceIds = [...new Set(selected.flatMap(finding => [...finding.supportingEvidenceIds, ...finding.contradictingEvidenceIds, ...finding.claimEvidenceIds]))];
  return { text: "Here is what the captured report found. These are saved observations, not a fresh check.\n\n" + selected.map(finding =>
    `${finding.status.replaceAll("_", " ")}: ${finding.claim}\n${finding.explanation}\nLimits: ${finding.limitations.slice(0, 2).join(" ")}`).join("\n\n"), evidenceIds };
}
