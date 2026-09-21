import { randomUUID } from "node:crypto";
import { submissionSchema, tokenSchema } from "./investigation.ts";
import type { ScopeDiscovery } from "./scope-discovery.ts";

export type Scope = {
  id: string; revision: number; status: "draft" | "ready" | "locked"; mode: "deterministic";
  messages: { role: "user" | "assistant"; content: string }[];
  submission: ReturnType<typeof submissionSchema.parse>;
  selection: { chainId?: number; address?: string };
  summary: string; included: string[]; excluded: string[]; questions: string[]; priceUsd: 100;
  orderId?: string;
  preview?: { status: "running" | "complete" | "failed"; startedAt: string; seedLinks: string[]; result?: ScopeDiscovery; error?: string };
};
export class ScopeError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
const networks: Record<number, string> = { 1: "Ethereum", 8453: "Base", 4663: "Robinhood Chain" };
export function scopeMessage(input: unknown): string {
  if (typeof input !== "string" || !input.trim() || input.length > 2000) throw new ScopeError(400, "Send a message of 1 to 2,000 characters");
  return input.trim();
}
export function createScope(message: unknown): Scope {
  return advanceScope({ id: randomUUID(), revision: 0, status: "draft", mode: "deterministic", messages: [],
    submission: { links: [] }, selection: {}, summary: "", included: [], excluded: [], questions: [], priceUsd: 100 }, message, 0);
}
export function advanceScope(previous: Scope, input: unknown, revision: unknown): Scope {
  if (previous.status === "locked") throw new ScopeError(409, "This scope is locked to an order. Start a new conversation to change it.");
  if (previous.preview?.status === "running") throw new ScopeError(409, "The free website lookup is still running. Reload the conversation shortly.");
  if (revision !== previous.revision) throw new ScopeError(409, "This conversation changed. Reload it before sending another message.");
  if (previous.messages.filter((message) => message.role === "user").length >= 12) throw new ScopeError(409, "The free scoping limit is 12 messages. Start a new conversation if needed.");
  const message = scopeMessage(input), scope = structuredClone(previous);
  const urls = [...message.matchAll(/https?:\/\/[^\s<>"\]]+/gi)].map(([url]) => url.replace(/[),.;!?]+$/, ""));
  const links = /\breplace (?:the )?links\b/i.test(message) ? [] : [...scope.submission.links];
  for (const url of urls) {
    const parsed = submissionSchema.safeParse({ links: [url] });
    if (!parsed.success) throw new ScopeError(400, "Use HTTP(S) links without embedded credentials");
    if (!links.includes(parsed.data.links[0]!)) links.push(parsed.data.links[0]!);
  }
  if (links.length > 20) throw new ScopeError(400, "A scope can contain at most 20 links");
  const foundChains = new Set<number>();
  if (/\bethereum\b/i.test(message)) foundChains.add(1);
  if (/\bbase\b/i.test(message)) foundChains.add(8453);
  if (/\brobinhood(?: chain)?\b/i.test(message)) foundChains.add(4663);
  for (const [, id] of message.matchAll(/\bchain(?:\s*id)?\s*[:=]?\s*(\d+)\b/gi)) foundChains.add(Number(id));
  if (/^\s*(1|8453|4663)\s*$/.test(message)) foundChains.add(Number(message));
  const questions: string[] = [];
  if (/\btestnet\b/i.test(message) || [...foundChains].some((id) => !networks[id])) {
    delete scope.selection.chainId; questions.push("Choose Ethereum, Base, or Robinhood Chain mainnet. Testnets and other networks are not supported.");
  } else if (foundChains.size > 1) {
    delete scope.selection.chainId; questions.push("Which single network should this report cover: Ethereum, Base, or Robinhood Chain?");
  } else if (foundChains.size === 1) scope.selection.chainId = [...foundChains][0]!;
  const addresses = [...new Set(message.match(/\b0x[a-fA-F0-9]{40}\b/g)?.map((address) => address.toLowerCase()) ?? [])];
  const invalidAddressMention = (message.match(/\b0x[a-zA-Z0-9]*/g) ?? []).some((value) => !/^0x[a-fA-F0-9]{40}$/.test(value) || /^0x0{40}$/.test(value));
  const tokenCorrection = /\b(?:replace|change|correct|update|remove|clear)\s+(?:the\s+)?(?:token|address|contract)\b/i.test(message);
  if ((invalidAddressMention || (tokenCorrection && !addresses.length)) && previous.selection.address) {
    delete scope.selection.address;
    questions.push("The token address needs correction. Send one nonzero EVM address (0x followed by 40 hexadecimal characters).");
  } else if (addresses.length > 1) { delete scope.selection.address; questions.push("Send the one primary token address to attach this report to."); }
  else if (addresses.length === 1) {
    if (/^0x0{40}$/.test(addresses[0]!)) throw new ScopeError(400, "The token address cannot be the zero address");
    scope.selection.address = addresses[0]!;
  }
  if (previous.selection.chainId && scope.selection.chainId !== previous.selection.chainId && !addresses.length) {
    delete scope.selection.address;
    questions.push("Confirm the primary token address on the newly selected network.");
  }
  const token = tokenSchema.safeParse(scope.selection);
  scope.submission = { links, ...(token.success ? { token: token.data } : {}), relatedContractLimit: 4, domainLookup: "registrable_domain" };
  if (!links.length) questions.push("Share the project's website and any documentation links.");
  if (!scope.selection.chainId && !questions.some((question) => /network|mainnet/.test(question))) questions.push("Which network is the token on: Ethereum, Base, or Robinhood Chain?");
  if (!scope.selection.address && !questions.some((question) => /address/.test(question))) questions.push("Send the primary token's EVM contract address (0x followed by 40 hexadecimal characters).");
  scope.questions = questions; scope.status = questions.length ? "draft" : "ready"; scope.revision++;
  scope.messages.push({ role: "user", content: message });
  scope.included = ["Read up to 3 public pages from the supplied links and discovered documentation.",
    "Make one registration lookup for the registrable domain of the first submitted link.",
    "Check the primary token's deployed code, standard control signals, and available source-verification evidence.",
    "Inspect up to 4 related addresses linked to matching-chain explorers for deployed code, owner signals, and Safe-compatible approval thresholds and owner lists.",
    "Sample recent token transfers and describe concentration with its limits.",
    "Inspect up to 2 public GitHub repositories with 3 selected source excerpts each, and make up to 3 public JSON API GET probes when supported and accessible."];
  scope.excluded = ["A security audit, proof of safety, investment advice, or a guarantee that all claims are true.",
    "Attributing a shared-hosting suffix's registration details to an individual project.",
    "Independent source compilation, proof that a GitHub revision matches deployment, and custom API business-logic testing.",
    "Comprehensive security and permission analysis of connected protocol modules, full treasury or funder tracing, private APIs, active exploitation, and continuous monitoring.",
    "Twitter and other social-media analysis. Free scoping may read up to 2 static pages once per conversation; it does not verify project claims."];
  const subject = links.length ? new URL(links[0]!).hostname : "your project";
  const selectedLinks = Math.min(3, links.length);
  scope.summary = `A report on ${subject}${token.success ? ` and its ${networks[token.data.chainId]} token` : ", once its network and token are supplied"}. ${selectedLinks ? `We will start with your first ${selectedLinks} ${selectedLinks === 1 ? "link" : "links"}, within a 3-page limit.` : "Share a link to start; the report covers up to 3 pages."} Your concerns are saved; this report covers only the checks listed below.`;
  const reply = questions.length ? questions.join(" ") : "I have enough details to prepare a scope. Review it below before starting the $100 investigation.";
  scope.messages.push({ role: "assistant", content: `${previous.revision === 0 ? "This is guided scoping; I have not checked the project yet. " : ""}${reply}` });
  return scope;
}
