import { createHash } from "node:crypto";
import ipaddr from "ipaddr.js";
import { z } from "zod";
import { discoverWebsite } from "./discovery.ts";
import { fetchPage, type FetchedPage } from "./fetch-page.ts";

// Static URL checks complement, but never replace, the fetcher's DNS and redirect guards.
const sourceUrl = z.url({ protocol: /^https?$/ }).refine((value) => {
  const url = new URL(value);
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return !url.username && !url.password && !url.port && host !== "localhost" && !host.endsWith(".localhost")
    && (!ipaddr.isValid(host) || ipaddr.process(host).range() === "unicast");
}, "A public HTTP(S) source URL is required").transform((value) => {
  const url = new URL(value); url.hash = ""; return url.href;
});

export const scopeDiscoverySchema = z.strictObject({
  mode: z.literal("deterministic"),
  pages: z.array(z.strictObject({
    url: sourceUrl, title: z.string().max(160), excerpt: z.string().max(400),
    capturedAt: z.iso.datetime({ offset: true }), sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })).max(2),
  documentation: z.array(z.strictObject({ url: sourceUrl, label: z.string().max(100), sourceUrl })).max(6),
  candidates: z.array(z.strictObject({
    address: z.string().regex(/^0x[a-f0-9]{40}$/).refine((value) => !/^0x0{40}$/.test(value)),
    chainId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
    context: z.string().max(100), sourceUrl,
  })).max(8),
  attemptedPages: z.number().int().min(0).max(2),
  limitations: z.array(z.string().max(400)).max(20),
  failures: z.array(z.strictObject({ url: sourceUrl, reason: z.string().max(160) })).max(2),
});
export type ScopeDiscovery = z.infer<typeof scopeDiscoverySchema>;

function shortContext(text: string, address: string): string {
  const location = text.toLowerCase().indexOf(address);
  const prefix = location < 0 ? text : text.slice(0, location);
  // Do not carry a preceding table row's address into this candidate's nearby label.
  const previousAddress = [...prefix.matchAll(/(?<![a-z0-9_])0x[a-f0-9]{40}(?![a-z0-9_])/gi)].at(-1);
  const nearby = previousAddress ? prefix.slice(previousAddress.index! + previousAddress[0].length) : prefix;
  const compact = nearby.replace(/\s+/g, " ").trim();
  const tableHeader = [...compact.matchAll(/\b(?:Contract|Module)\s+Address\b/gi)].at(-1);
  const fragment = (tableHeader ? compact.slice(tableHeader.index! + tableHeader[0].length) : compact).trim();
  if (fragment.length <= 100) return fragment;
  // A source fragment can be shortened, but never begin halfway through a word.
  const tail = fragment.slice(-97).replace(/^\S*\s*/, "").trim();
  return tail ? `...${tail}` : "...";
}

/** Free static discovery only. Candidates require user confirmation and are not verified identities. */
export async function discoverScope(
  links: string[],
  getPage: (url: string) => Promise<FetchedPage> = (url) => fetchPage(url, { timeoutMs: 4_000, maxBytes: 100_000, maxRedirects: 2 }),
): Promise<ScopeDiscovery> {
  const seeds = [...new Set(z.array(sourceUrl).min(1).max(20).parse(links))].slice(0, 2);
  const discovery = await discoverWebsite({ links: seeds }, { maxPages: 2 }, async (url) => {
    const safeUrl = sourceUrl.parse(url);
    const page = await getPage(safeUrl);
    const finalUrl = sourceUrl.parse(page.finalUrl);
    if (page.status < 200 || page.status >= 300 || page.body.length > 100_000 || page.redirects.length > 2
      || !/^(text\/(?:html|markdown|plain)|application\/xhtml\+xml)(?:\s*;|$)/i.test(page.contentType)) {
      throw new Error("Unsupported preview response");
    }
    return { ...page, finalUrl };
  });
  const documentation = new Map<string, ScopeDiscovery["documentation"][number]>();
  const candidates = new Map<string, ScopeDiscovery["candidates"][number]>();
  for (const page of discovery.pages) {
    for (const link of page.links) {
      if (link.kind === "documentation" && sourceUrl.safeParse(link.url).success && !documentation.has(link.url)) {
        documentation.set(link.url, { url: link.url, label: link.label.slice(0, 100), sourceUrl: page.url });
      }
    }
    // Explorer paths retain their chain hints; a bare address always remains chain-ambiguous.
    for (const candidate of [...page.addresses].sort((a, b) => Number(b.chainId !== null) - Number(a.chainId !== null))) {
      const key = `${candidate.chainId}:${candidate.address}`;
      if (candidates.has(key)) continue;
      const label = candidate.source === "link" ? page.links.find((link) => link.url === candidate.sourceUrl)?.label : page.text;
      const rawLabelContext = shortContext(label || "", candidate.address);
      const labelContext = /[\p{L}\p{N}]/u.test(rawLabelContext) ? rawLabelContext : "";
      const nearbyContext = page.text.toLowerCase().includes(candidate.address) ? shortContext(page.text, candidate.address) : "";
      candidates.set(key, {
        address: candidate.address, chainId: candidate.chainId,
        context: labelContext || nearbyContext || "Address candidate", sourceUrl: page.url,
      });
    }
  }
  return scopeDiscoverySchema.parse({
    mode: "deterministic",
    pages: discovery.pages.map((page) => {
      // Resolve the page's own capture, even when separate seeds redirect to the same final URL.
      const capture = discovery.investigation.evidence.find((evidence) => evidence.id === page.evidenceId)!;
      const raw = JSON.parse(capture.content) as { bodyBase64: string };
      return { url: page.url, title: page.title.slice(0, 160), excerpt: page.text.slice(0, 400),
        capturedAt: capture.capturedAt, sha256: createHash("sha256").update(Buffer.from(raw.bodyBase64, "base64")).digest("hex") };
    }),
    documentation: [...documentation.values()].slice(0, 6),
    candidates: [...candidates.values()].sort((a, b) => Number(b.chainId !== null) - Number(a.chainId !== null)).slice(0, 8),
    attemptedPages: discovery.budget.attemptedPages,
    failures: discovery.failures.filter((failure) => sourceUrl.safeParse(failure.url).success)
      .map(({ url }) => ({ url, reason: "Page unavailable or unsupported for this bounded preview" })),
    limitations: [
      "This is deterministic static discovery, not a live scoping model or a technical investigation.",
      "Website text and labels are untrusted project claims. Address candidates are not confirmed project or token identities; ask the user to confirm.",
      "Explorer paths suggest a chain, including test networks; page-text addresses do not establish a chain.",
      "At most two pages are attempted, including failures. Submitted links take priority over linked documentation.",
      "No RPC, domain history, repository, API, contract, activity, or model checks run during this free preview.",
      "Only static HTML, Markdown, and plain text are read; scripts, code blocks, authenticated content, and images are not executed or analyzed.",
      ...(discovery.pages.some((page) => !page.text.trim()) ? ["A page returned no readable static text; JavaScript rendering was not performed."] : []),
      ...(links.length > 2 || discovery.budget.remainingUrls.length ? ["More submitted or linked pages remain outside this preview's two-page budget."] : []),
      ...(documentation.size > 6 || candidates.size > 8 || discovery.pages.some((page) => page.linksTruncated || page.addressesTruncated || page.textTruncated)
        ? ["The preview omits some text, links, or address candidates to stay within its display limits."] : []),
      ...(discovery.failures.length ? ["One or more pages could not be collected; no claim is made about their contents."] : []),
    ],
  });
}
