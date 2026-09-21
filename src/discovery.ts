import { loadBuffer } from "cheerio";
import { Marked } from "marked";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { captureEvidence, createInvestigation, investigationSchema } from "./investigation.ts";
import { type FetchedPage } from "./fetch-page.ts";
import { crawlWebBatch, type CrawlResult } from "./web-crawler.ts";

type LinkKind = "documentation" | "repository" | "explorer" | "api" | "website";
type DiscoveredLink = { url: string; label: string; kind: LinkKind };
type AddressCandidate = { address: string; source: "page_text" | "link"; chainId: number | null; sourceUrl: string };
const explorers: Record<string, number> = {
  "robinhoodchain.blockscout.com": 4663, "explorer.testnet.chain.robinhood.com": 46630,
  "etherscan.io": 1, "basescan.org": 8453, "arbiscan.io": 42161,
  "bscscan.com": 56, "polygonscan.com": 137, "optimistic.etherscan.io": 10,
};
const optionsSchema = z.strictObject({
  maxPages: z.number().int().min(1).max(5).default(3),
});

function linkUrl(value: string, base: string): URL | null {
  const url = URL.parse(value, base);
  if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password) return null;
  url.hash = "";
  return url;
}

function classify(url: URL, label: string): LinkKind {
  const host = url.hostname.replace(/^www\./, "");
  const parts = url.pathname.split("/").filter(Boolean);
  if (["github.com", "gitlab.com", "bitbucket.org"].includes(host) && parts.length >= 2
    && !["features", "orgs", "topics", "settings", "login", "marketplace", "search", "sponsors"].includes(parts[0]!)) return "repository";
  if (Object.hasOwn(explorers, host)) return "explorer";
  if (/\b(docs?|documentation|whitepaper)\b/i.test(label) || /^docs?\./i.test(host)
    || /\/(docs?|documentation|whitepaper)(\/|\.|$)/i.test(url.pathname)) return "documentation";
  if (/^api\./i.test(host) || /\/(api|swagger)(\/|$)|\/openapi\.(json|ya?ml)$/i.test(url.pathname)) return "api";
  return "website";
}

const markdown = new Marked({ gfm: true });

type DocumentParts = { title: string; text: string; base: string; anchors: { href: string; label: string }[] };

function documentParts(page: FetchedPage): DocumentParts {
  const charset = /charset\s*=\s*["']?([^\s;"']+)/i.exec(page.contentType)?.[1];
  if (/^text\/(markdown|plain)(?:\s*;|$)/i.test(page.contentType)) {
    const text = new TextDecoder(charset || "utf-8").decode(page.body);
    const anchors: DocumentParts["anchors"] = [];
    const parts: string[] = [];
    let title = "";
    // Tokenize only: no generated HTML, extensions, scripts, or code blocks are executed.
    markdown.walkTokens(markdown.lexer(text), (token) => {
      if (token.type === "heading" && token.depth === 1 && !title) title = token.text.slice(0, 500);
      if (token.type === "link") anchors.push({ href: token.href, label: token.text });
      if ((token.type === "text" && !token.tokens?.length) || token.type === "codespan") parts.push(token.text);
    });
    return { title, text: parts.join(" ").replace(/\s+/g, " ").trim(), base: page.finalUrl, anchors };
  }
  const $ = loadBuffer(page.body, { encoding: charset ? { transportLayerEncodingLabel: charset } : {} });
  const title = $("title").first().text().replace(/\s+/g, " ").trim().slice(0, 500);
  const base = linkUrl($("base[href]").first().attr("href") ?? page.finalUrl, page.finalUrl)?.href ?? page.finalUrl;
  $("script,style,template,svg,[hidden],[aria-hidden='true']").remove();
  const anchors: DocumentParts["anchors"] = [];
  $("a[href]").each((_index, element) => {
    const anchor = $(element);
    anchors.push({ href: anchor.attr("href") || "", label: anchor.text().trim() || anchor.attr("aria-label") || anchor.attr("title") || "" });
  });
  $("p,div,section,li,br,h1,h2,h3,h4,h5,h6,td,tr").append(" ");
  return { title, base, anchors, text: $("body").text().replace(/\s+/g, " ").trim() };
}

/** Parses captured HTTP documents or rendered snapshots without executing their contents. */
export function extractPage(page: FetchedPage) {
  const document = page.rendering?.html ? { ...page, body: Buffer.from(page.rendering.html), contentType: "text/html; charset=utf-8" } : page;
  const { title, text: allText, base, anchors } = documentParts(document);
  const links = new Map<string, DiscoveredLink>();
  let linksTruncated = false;
  for (const anchor of anchors) {
    const value = anchor.href.trim();
    if (!value || value.startsWith("#")) continue;
    const url = linkUrl(value, base);
    if (!url) continue;
    const label = anchor.label.replace(/\s+/g, " ").slice(0, 500);
    const kind = classify(url, label);
    const previous = links.get(url.href);
    if (previous) {
      if (previous.kind === "website" && kind !== "website") links.set(url.href, { url: url.href, label, kind });
    } else if (links.size < 200) links.set(url.href, { url: url.href, label, kind });
    else linksTruncated = true;
  }
  const candidates = new Map<string, AddressCandidate>();
  let addressesTruncated = false;
  const findAddresses = (content: string, source: AddressCandidate["source"], sourceUrl: string, chainId: number | null) => {
    const pathAddress = chainId === null ? null : new URL(sourceUrl).pathname.split("/")[2]?.toLowerCase();
    for (const match of content.matchAll(/(?<![a-z0-9_])0x[a-f0-9]{40}(?![a-z0-9_])/gi)) {
      const address = match[0].toLowerCase();
      if (/^0x0{40}$/.test(address)) continue;
      const candidateChain = address === pathAddress ? chainId : null;
      const key = `${address}:${candidateChain}:${sourceUrl}`;
      if (!candidates.has(key)) {
        if (candidates.size < 100) candidates.set(key, { address, source, sourceUrl, chainId: candidateChain });
        else addressesTruncated = true;
      }
    }
  };
  findAddresses(allText, "page_text", page.finalUrl, null);
  for (const link of links.values()) {
    const url = new URL(link.url);
    const host = url.hostname.replace(/^www\./, "");
    const explorerChain = Object.hasOwn(explorers, host) ? explorers[host] : null;
    const chainId = explorerChain && /^\/(address|token)\/0x[a-f0-9]{40}(?:\/|$)/i.test(url.pathname) ? explorerChain : null;
    findAddresses(link.url, "link", link.url, chainId);
  }
  return {
    url: page.finalUrl, title, text: allText.slice(0, 20_000), textTruncated: allText.length > 20_000,
    links: [...links.values()], linksTruncated, addresses: [...candidates.values()], addressesTruncated,
  };
}

function navigationCandidate(link: DiscoveredLink, source: string) {
  const url = new URL(link.url);
  let path = url.pathname;
  try { path = decodeURIComponent(path); } catch { /* The fetcher still validates the URL. */ }
  const topic = `${path.replace(/[-_/]/g, " ")} ${link.label}`;
  const technical = /\b(contracts?|deployments?|addresses|architecture|integrations?|developers?|security|audits?|tokenomics|protocol|reference|mechanism|treasury|vaults?|staking|oracles?|lending|bridges?)\b/i.test(topic);
  const priority = /\b(contracts?|deployments?|addresses)\b/i.test(topic) ? 0 : technical ? 1 : 2;
  const document = link.kind === "documentation" || (link.kind === "website" && url.origin === new URL(source).origin && technical);
  const reason = !document ? "Outside documentation and same-origin technical-page discovery"
    : url.search ? "Query-bearing navigation is not automatically followed"
      : /\/(logout|signout|login|signin|delete|remove|revoke|execute|withdraw|claim|approve|swap|buy|sell)(?:\/|$)/i.test(path) ? "Potential account or state-changing route"
        : /\.(pdf|zip|gz|png|jpe?g|gif|svg|webp|mp4|exe|dmg)$/i.test(path) ? "Unsupported static-document format"
          : null;
  return { url: link.url, sourceUrl: source, eligible: reason === null, reason: reason ?? "Linked document candidate; project membership is unverified", priority };
}

export async function discoverWebsite(
  input: unknown,
  options: z.input<typeof optionsSchema> = {},
  getPage?: (url: string) => Promise<FetchedPage>,
) {
  const { maxPages } = optionsSchema.parse(options);
  const investigation = createInvestigation(input);
  const queue = investigation.subject.links.map((link) => { const url = new URL(link); url.hash = ""; return url.href; });
  const seeds = new Set(queue), priorities = new Map<string, number>();
  const skipped = new Set<string>();
  const visited = new Set<string>();
  const pages: (ReturnType<typeof extractPage> & { evidenceId: string; observationId: string })[] = [];
  const failures: { url: string; reason: string }[] = [];
  const renderingLimitations: string[] = [];
  let attempts = 0;
  while (queue.length && attempts < maxPages) {
    const batch: string[] = [];
    while (queue.length && attempts < maxPages && batch.length < (getPage ? 1 : 3)) {
      const url = queue.shift()!;
      if (visited.has(url)) continue;
      visited.add(url); attempts++; batch.push(url);
    }
    if (!batch.length) break;
    const results: CrawlResult[] = getPage ? await Promise.all(batch.map(async url => {
      try { return { url, page: await getPage(url) }; }
      catch (error) { return { url, error: error instanceof Error ? error.message : String(error) }; }
    })) : await crawlWebBatch(batch);
    for (const { url, page, error } of results) {
      if (!page) { failures.push({ url, reason: error ?? "Page unavailable" }); continue; }
      try {
        if (page.rendering?.failures.length) renderingLimitations.push(`${page.finalUrl}: browser capture ${page.rendering.status}; ${page.rendering.failures.join("; ")}`);
        const extracted = extractPage(page);
        const navigation = extracted.links.map(link => navigationCandidate(link, page.finalUrl));
        visited.add(page.finalUrl);
        const medium = classify(new URL(page.finalUrl), "") === "documentation" ? "documentation" : "website";
        const raw = captureEvidence({
          id: randomUUID(), role: "claim", medium, sourceUrl: page.finalUrl,
          capturedAt: page.capturedAt, method: "HTTP GET; decoded response bytes preserved as base64; rendered DOM retained separately when attempted",
          toolVersion: "mydevsaid-discovery/0.4.0; crawlee/3.18.1; playwright/1.63.0",
          content: JSON.stringify({
            requestedUrl: page.requestedUrl, finalUrl: page.finalUrl, status: page.status,
            contentType: page.contentType, redirects: page.redirects, bodyBase64: page.body.toString("base64"), rendering: page.rendering,
          }),
        });
        const observed = captureEvidence({
          id: randomUUID(), role: "observation", medium, sourceUrl: page.finalUrl,
          capturedAt: page.rendering?.capturedAt ?? page.capturedAt, method: "Extract document anchors or Markdown link candidates and addresses; classify links heuristically",
          toolVersion: "mydevsaid-discovery/0.4.0; cheerio/1.2.0; marked/18.0.5",
          content: JSON.stringify({
            rawEvidenceId: raw.id, rawSha256: raw.sha256, title: extracted.title,
            extractionMethod: page.rendering?.html ? "rendered_dom" : "static_document",
            text: extracted.text, textTruncated: extracted.textTruncated,
            links: extracted.links, addresses: extracted.addresses,
            linksTruncated: extracted.linksTruncated, addressesTruncated: extracted.addressesTruncated,
            navigation,
          }),
        });
        investigation.evidence.push(raw, observed);
        pages.push({ ...extracted, evidenceId: raw.id, observationId: observed.id });
        for (const candidate of navigation) {
          if (!candidate.eligible) { skipped.add(candidate.url); continue; }
          priorities.set(candidate.url, Math.min(priorities.get(candidate.url) ?? 2, candidate.priority));
          if (!visited.has(candidate.url) && !queue.includes(candidate.url)) queue.push(candidate.url);
        }
        queue.sort((a, b) => Number(seeds.has(b)) - Number(seeds.has(a)) || (priorities.get(a) ?? 2) - (priorities.get(b) ?? 2));
      } catch (error) {
        failures.push({ url, reason: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  investigation.checks = investigation.checks.map((check) => check.area === "web_presence" ? {
    ...check, status: pages.length ? "running" : "blocked",
    evidenceIds: investigation.evidence.map((item) => item.id),
    reason: pages.length ? "Discovery collected evidence; domain lookup and claims review remain unfinished"
      : "No submitted page could be collected; inspect discovery failures",
  } : check);
  const remainingUrls = queue.filter(url => !visited.has(url));
  return {
    investigation: investigationSchema.parse(investigation), pages, failures,
    budget: { maxPages, attemptedPages: attempts, remainingUrls },
    limitations: [
      `Discovery coverage: ${pages.length} pages captured, ${failures.length} attempts failed, ${remainingUrls.length} queued URLs remain unvisited. ${skipped.size} unique linked URLs were excluded from automatic navigation; per-link reasons are recorded in parsed page evidence. These counts do not measure total protocol coverage.`,
      ...(pages.some(page => page.linksTruncated || page.addressesTruncated || page.textTruncated) ? ["At least one captured page exceeded extraction limits; some links, address candidates, or text are omitted."] : []),
      ...(pages.some((page) => !page.text.trim()) ? [getPage ? "At least one page returned no readable static text; it may require JavaScript rendering, which was not performed" : "At least one page returned no readable text after available extraction; its content remains unknown"] : []),
      ...renderingLimitations,
      "Markdown code blocks, images, and embedded HTML are not analyzed as project documentation",
      getPage ? "Static HTML, Markdown, and plain text only; JavaScript-rendered content and authenticated pages are not inspected" : "HTTP first, with bounded headless rendering for sparse HTML. Up to three pages fetch concurrently; transient failures retry once. Authenticated pages and interactive product flows are not inspected.",
      "Link categories and addresses are candidates, not proof of ownership, deployment, or functionality",
      "Explorer links suggest a chain; addresses in page text remain unassigned",
      "Submitted URLs take priority, followed by linked technical pages and documentation. Same-origin contracts, deployments, architecture, integrations, and security pages are candidates; external documentation links do not prove shared ownership.",
      "Unlinked pages, sitemaps, repository deployment manifests, and runtime dependencies are not discovered by this bounded crawl. Query-bearing, account-action, and unsupported document links are not automatically followed.",
      "Website discovery alone does not validate domains, repositories, APIs, contracts, or activity; consult the separate collector findings for that coverage",
    ],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [url, chainId, address, ...extra] = process.argv.slice(2);
    if (!url || Boolean(chainId) !== Boolean(address) || extra.length) {
      throw new Error("Usage: npm run discover -- <website-url> [chain-id token-address]");
    }
    const result = await discoverWebsite({
      links: [url], ...(chainId && address ? { token: { chainId: Number(chainId), address } } : {}),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (!result.pages.length) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
