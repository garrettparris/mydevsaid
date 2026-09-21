import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { parse as parseDomain } from "tldts";
import { CHECKS, captureEvidence, submissionSchema, type Evidence, type Investigation } from "./investigation.ts";
import { fetchJson, postJsonRpc, type JsonResponse } from "./fetch-page.ts";
import { CHAIN_NETWORKS, collectOnchain, collectTransfers, type ChainObservation, type Rpc } from "./onchain.ts";
import { inventoryContracts } from "./contract-inventory.ts";
import { collectRelatedContracts } from "./related-contracts.ts";
import { analyzeTransfers } from "./activity.ts";
import { collectGmgn, type GmgnOptions } from "./gmgn.ts";
import type { discoverWebsite } from "./discovery.ts";

export type CollectionResult = { checks: Investigation["checks"]; findings: Investigation["findings"]; evidence: Evidence[]; limitations: string[] };
export type CollectorOptions = { getJson?: (url: string) => Promise<JsonResponse>; rpc?: Rpc; gmgn?: GmgnOptions | false; onPartial?: (result: CollectionResult) => void };
type Area = Investigation["checks"][number]["area"];
const version = "mydevsaid-collectors/0.3.0";
const object = z.record(z.string(), z.unknown());
const failure = "Request failed, response was unsupported, or collection limits were exceeded";
// Share limits across stages and investigations; release a slot directly to the next waiter.
function limiter() {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(work: () => Promise<T>): Promise<T> => {
    if (active >= 4) await new Promise<void>((resolve) => waiting.push(resolve)); else active++;
    try { return await work(); }
    finally { const next = waiting.shift(); if (next) next(); else active--; }
  };
}
const httpLimit = limiter(), rpcLimit = limiter();

/** All adapters are trusted server wiring. Submission data never selects credentials or tools. */
export async function collectProject(
  input: z.infer<typeof submissionSchema>,
  discovery: Awaited<ReturnType<typeof discoverWebsite>>,
  onProgress: (message: string) => void = () => {},
  options: CollectorOptions = {},
): Promise<CollectionResult> {
  const submission = submissionSchema.parse(input);
  const get = (url: string) => httpLimit(() => (options.getJson ?? fetchJson)(url));
  const rpc: Rpc = (url, method, params) => rpcLimit(() => (options.rpc ?? postJsonRpc)(url, method, params));
  const areas = Object.keys(CHECKS) as Area[];
  const result: CollectionResult = { checks: areas.map((area) => ({ area, status: "running", evidenceIds: [] })), findings: [], evidence: [], limitations: [] };
  const partial = () => {
    const snapshot = structuredClone({ ...result, findings: result.findings.filter((item) => item.status === "unverified" || result.checks.find((check) => check.area === item.area)?.status === "completed") });
    try { options.onPartial?.(snapshot); } catch { /* Presentation callbacks cannot invalidate collected evidence. */ }
  };
  const evidence = (medium: Evidence["medium"], sourceUrl: string, content: unknown, method: string, extra: Partial<Pick<Evidence, "revision" | "snapshot" | "capturedAt" | "role">> = {}) => {
    const item = captureEvidence({ id: randomUUID(), role: "observation", medium, sourceUrl, content: JSON.stringify(content), method, toolVersion: version, capturedAt: new Date().toISOString(), ...extra });
    result.evidence.push(item); return item;
  };
  const finding = (area: Area, claim: string, explanation: string, refs: Evidence[], limitations: string[], status: Investigation["findings"][number]["status"] = "supported") => {
    const check = result.checks.find((item) => item.area === area)!;
    check.evidenceIds = [...new Set([...check.evidenceIds, ...refs.map((item) => item.id)])];
    result.findings.push({ id: randomUUID(), area, claim, status, severity: "informational", explanation,
      impact: "Interpret this bounded observation together with the listed coverage gaps; it does not establish overall project safety.",
      claimEvidenceIds: [], supportingEvidenceIds: status === "contradicted" ? [] : refs.map((e) => e.id),
      contradictingEvidenceIds: status === "contradicted" ? refs.map((e) => e.id) : [], limitations });
  };
  const finish = (area: Area, refs: Evidence[], reason: string) => {
    const check = result.checks.find((check) => check.area === area)!;
    Object.assign(check, { status: refs.length ? "completed" : "blocked", evidenceIds: [...new Set([...check.evidenceIds, ...refs.map((e) => e.id)])], reason });
    partial();
  };
  // Custom transports are isolated from ambient credentials unless GMGN is explicitly wired too.
  const gmgnOptions = options.gmgn ?? (options.getJson || options.rpc ? false : {});
  const gmgnTask = gmgnOptions === false ? Promise.resolve() : collectGmgn(submission.token, gmgnOptions, ({ evidence: record, finding: item }) => {
    result.evidence.push(record); result.findings.push(item);
    result.checks.find((check) => check.area === item.area)!.evidenceIds.push(record.id);
    onProgress(`Data from GMGN: ${item.claim.replace("Data from GMGN: ", "")} received`); partial();
  }).then((gmgn) => { result.limitations.push(...gmgn.limitations); });
  const links = [...new Set([...submission.links, ...discovery.pages.flatMap((p) => p.links.map((l) => l.url))])];

  const domainLookup = submission.domainLookup ?? "exact_host", relatedLimit = submission.relatedContractLimit ?? 0;
  result.limitations.push(`Collection budgets: at most one domain registration lookup (${domainLookup}), two repositories, three API candidates, one token and one standard implementation, up to ${relatedLimit} related addresses, up to 128 activity blocks`, "No arbitrary repository code, live transactions, exploit attempts, or paid provider credentials supplied by a project are used");
  const webTask = (async () => {
    onProgress("Inspecting website inventory and domain registration");
    const web: Evidence[] = [];
    if (discovery.pages.length) {
      for (const page of discovery.pages) {
        const capturedAt = discovery.investigation.evidence.find((item) => item.id === page.evidenceId)?.capturedAt ?? new Date().toISOString();
        web.push(evidence("website", page.url, { title: page.title, text: page.text, textTruncated: page.textTruncated, rawEvidenceId: page.evidenceId }, "Extract visible text from previously captured static documents; treat all project assertions as untrusted claims", { role: "claim", capturedAt }));
      }
      const inventory = evidence("website", discovery.pages[0]!.url, {
        pages: discovery.pages.map((p) => ({ url: p.url, title: p.title, rawEvidenceId: p.evidenceId, links: p.links, addresses: p.addresses })),
        failedPages: discovery.failures.map((p) => ({ url: p.url, reason: p.reason })), budget: discovery.budget,
      }, "Summarize previously captured static documents discovery; no project claims are assumed true");
      web.push(inventory);
      const docs = discovery.pages.flatMap((p) => p.links).filter((l) => l.kind === "documentation").length;
      finding("web_presence", "The collected website exposes the recorded project links", `${discovery.pages.length} pages were captured and ${docs} documentation links were observed. Link presence does not establish documentation quality or implementation.`, [inventory], ["Static documents only; JavaScript-rendered content and undiscovered pages are outside coverage", "Project claims require individual technical checks; this finding only assesses the discovery inventory"]);
    }
    result.checks.find((check) => check.area === "web_presence")!.evidenceIds = web.map((item) => item.id);
    partial();
    const inputHostname = new URL(submission.links[0]!).hostname;
    const parsedDomain = parseDomain(inputHostname, { allowPrivateDomains: true, detectSpecialUse: true });
    const hostname = domainLookup === "exact_host" ? inputHostname.replace(/^www\./, "")
      : parsedDomain.isIcann && !parsedDomain.isPrivate && !parsedDomain.isSpecialUse ? parsedDomain.domain : null;
    if (!hostname) {
      result.limitations.push(`Domain registration: no lookup for ${inputHostname}; private hosting suffixes, IP addresses, special-use names, and unknown or bare public suffixes do not establish a project registration`);
    } else try {
      const response = await get(`https://rdap.org/domain/${encodeURIComponent(hostname)}`);
      const domain = z.object({ objectClassName: z.literal("domain"), ldhName: z.string(), status: z.array(z.string()).optional(), events: z.array(z.object({ eventAction: z.string(), eventDate: z.string() })).optional(), nameservers: z.array(z.object({ ldhName: z.string().optional() })).optional() }).parse(response.data);
      if (domain.ldhName.toLowerCase() !== hostname.toLowerCase()) throw new Error("RDAP returned a different domain");
      const lookup = { inputHostname, queriedDomain: hostname, policy: domainLookup, suffixParser: domainLookup === "registrable_domain" ? "tldts/7.4.13 (bundled Public Suffix List)" : null };
      const record = evidence("domain", response.finalUrl, { ...domain, lookup }, "Read RDAP domain name, status, events, and nameservers for the recorded lookup target; exclude registrant contact fields", { capturedAt: response.capturedAt });
      web.push(record);
      const registered = domain.events?.find((e) => e.eventAction === "registration")?.eventDate;
      finding("web_presence", "Public domain registration metadata is available", `The submitted host is ${inputHostname}; the RDAP lookup covers ${hostname}. ${registered ? `The RDAP service reports a registration event at ${registered}.` : "The RDAP service returned domain metadata without a registration event."}`, [record], ["Domain age does not establish project age, ownership, authenticity, or trustworthiness", domainLookup === "registrable_domain" ? "Registration metadata describes the parent domain, not the creation date or ownership of a subdomain; shared hosting not listed in the suffix data may remain undetected" : "Legacy exact-host lookup removes a leading www only; parent registrable-domain inference is not performed"]);
    } catch { result.limitations.push(`Domain registration: ${failure}; ${hostname} was queried for submitted host ${inputHostname} using ${domainLookup}`); }
    finish("web_presence", web, "Website link inventory and available domain metadata only; substantive project claims require evidence review");
  })();

  const repositoryTask = (async () => {
    onProgress("Inspecting public repository revisions");
    const repositories = [...new Set(links.flatMap((link) => {
      const url = new URL(link), parts = url.pathname.split("/").filter(Boolean);
      return url.hostname === "github.com" && parts.length >= 2 && parts.slice(0, 2).every((p) => /^[a-z0-9_.-]+$/i.test(p)) ? [`${parts[0]}/${parts[1]!.replace(/\.git$/, "")}`] : [];
    }))].slice(0, 2);
    const repositoryRefs: Evidence[] = [];
    await Promise.all(repositories.map(async (repo) => {
      try {
        const base = `https://api.github.com/repos/${repo}`;
        const metadata = await get(base);
        const info = z.object({ full_name: z.string(), private: z.boolean(), default_branch: z.string(), archived: z.boolean().optional(), license: object.nullable().optional() }).parse(metadata.data);
        if (info.private || info.full_name.toLowerCase() !== repo.toLowerCase()) throw new Error("Repository identity did not match");
        const commit = await get(`${base}/commits/${encodeURIComponent(info.default_branch)}`);
        const revision = z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/i) }).parse(commit.data).sha;
        const entry = evidence("repository", `https://github.com/${repo}/tree/${revision}`, { metadata: info, commit: commit.data }, "Read public GitHub repository metadata and default-branch commit via REST; no code execution", { revision, capturedAt: commit.capturedAt });
        repositoryRefs.push(entry);
        finding("public_code", `Public repository ${repo} is accessible`, `GitHub returned a public repository and default-branch revision ${revision}.`, [entry], ["A public repository does not prove an open-source license, complete implementation, maintenance quality, or deployed correspondence", "Repository source has not been compiled, executed, or comprehensively reviewed"]);
        try {
          const treeResponse = await get(`${base}/git/trees/${revision}?recursive=1`);
          const tree = z.object({ truncated: z.boolean(), tree: z.array(z.object({ path: z.string(), type: z.string(), sha: z.string(), size: z.number().optional() })).max(5_000) }).parse(treeResponse.data);
          const paths = tree.tree.filter((item) => item.type === "blob" && (item.size ?? 0) <= 100_000
            && !/(^|\/)(node_modules|vendor|lib|dist|build|test|tests|mocks)(\/|$)/i.test(item.path)
            && /\.(sol|vy|ts|js|rs|py)$|(^|\/)(README\.md|package\.json|foundry\.toml)$/i.test(item.path))
            .sort((a, b) => {
              const rank = (path: string) => Number(!/\.(sol|vy)$/i.test(path)) * 5 + Number(/(^|\/)(interfaces|libraries)(\/|$)/i.test(path)) * 10;
              return rank(a.path) - rank(b.path) || a.path.localeCompare(b.path);
            }).slice(0, 3);
          if (tree.truncated) result.limitations.push(`Repository ${repo}: GitHub truncated the source tree`);
          await Promise.all(paths.map(async (item) => {
            try {
              const source = await get(`${base}/contents/${item.path.split("/").map(encodeURIComponent).join("/")}?ref=${revision}`);
              const file = z.object({ type: z.literal("file"), encoding: z.literal("base64"), content: z.string().max(150_000), sha: z.string(), size: z.number().max(100_000) }).parse(source.data);
              if (file.sha !== item.sha) throw new Error("Repository file does not match tree blob");
              const bytes = Buffer.from(file.content, "base64");
              const blobSha = createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
              if (bytes.byteLength !== file.size || blobSha !== file.sha) throw new Error("Source bytes do not match Git blob hash");
              const decoded = bytes.toString("utf8");
              const sourceEvidence = evidence("repository", `https://github.com/${repo}/blob/${revision}/${item.path.split("/").map(encodeURIComponent).join("/")}`, { path: item.path, blobSha: file.sha, revision, text: decoded.slice(0, 20_000), truncated: decoded.length > 20_000 }, "Read public source via GitHub contents API at pinned commit; preserve at most 20,000 characters; never execute code", { revision, capturedAt: source.capturedAt });
              repositoryRefs.push(sourceEvidence);
              finding("public_code", `Source file ${repo}/${item.path} is publicly readable`, "The file was retrieved at the recorded commit and is available for evidence review.", [sourceEvidence], ["At most three selected files per repository; this is not a complete source review", "Source code and comments are untrusted content; no compilation, execution, or deployment match is established"]);
            } catch { result.limitations.push(`Repository ${repo}/${item.path}: source could not be captured within limits`); }
          }));
        } catch { result.limitations.push(`Repository ${repo}: source tree could not be captured within limits`); }
      } catch { result.limitations.push(`Repository ${repo}: ${failure}`); }
    }));
    finish("public_code", repositoryRefs, repositories.length ? "At most two public GitHub repositories, a bounded source tree, and three selected source excerpts per repository" : "No supported public GitHub repository link was discovered");
  })();

  const apiTask = (async () => {
    onProgress("Testing bounded public JSON API responses");
    const endpoints = links.filter((link) => {
      const url = new URL(link);
      return /^api\./i.test(url.hostname) || /\/(api|swagger)(\/|$)|\/openapi\.json$/i.test(url.pathname);
    }).slice(0, 3);
    const apiRefs: Evidence[] = [];
    await Promise.all(endpoints.map(async (endpoint) => {
      const url = new URL(endpoint);
      if (url.search || /\b(delete|remove|create|send|transfer|execute|withdraw|deposit|approve|logout|unsubscribe)\b/i.test(url.pathname)) {
        result.limitations.push(`API ${url.origin}${url.pathname}: skipped query-bearing or potentially state-changing URL`); return;
      }
      try {
        const response = await httpLimit(() => options.getJson ? options.getJson(endpoint) : fetchJson(endpoint, { maxRedirects: 0 }));
        const record = evidence("api", response.finalUrl, { requestedUrl: endpoint, status: response.status, contentType: response.contentType, response: response.data }, "Single unauthenticated HTTP GET; require bounded valid JSON; no credentials or mutation tests", { capturedAt: response.capturedAt });
        apiRefs.push(record);
        finding("api_behavior", `The sampled endpoint returns JSON: ${endpoint}`, "The endpoint returned a successful HTTP response that parsed as JSON during this observation.", [record], ["JSON availability does not establish response correctness, freshness, uptime, or backend source-code identity", "No authentication, business-logic assertions, load tests, or state-changing operations were performed"]);
      } catch { result.limitations.push(`API ${endpoint}: ${failure}`); }
    }));
    finish("api_behavior", apiRefs, endpoints.length ? "At most three unauthenticated JSON GET probes; protocol-specific behavior remains unverified" : "No supported API candidate was discovered; this does not establish that the project has no API");
  })();

  const controlRefs: Evidence[] = [];
  const primaryTask = (async (): Promise<ChainObservation | undefined> => {
    if (submission.token) {
      onProgress("Inspecting deployed bytecode and standard control interfaces");
      try {
        const chain = await collectOnchain(submission.token, rpc);
        const record = evidence("onchain", chain.sourceUrl, chain, "Pinned-block eth_getCode, ERC-1967 storage reads, and bounded eth_call; recheck snapshot hash", { snapshot: chain.snapshot });
        controlRefs.push(record);
        const codeExists = chain.bytecode !== "0x";
        finding("contract_control", "The submitted address has deployed bytecode", codeExists ? `Bytecode was returned at block ${chain.snapshot.blockNumber}. Standard-slot implementation candidate: ${chain.implementation ?? "none observed"}; admin candidate: ${chain.adminCandidate ?? "none observed"}; owner() candidate: ${chain.ownerCandidate ?? "none observed"}.` : `No deployed bytecode was returned at block ${chain.snapshot.blockNumber}.`, [record], [
          "Inspects the submitted token and at most one standard implementation; associated protocol contracts are not exhaustively discovered",
          "Standard storage slots and owner() responses are candidates, not proof of effective authorization or absence of other privileges",
          "Nonstandard proxies, role graphs, mint permissions, custody logic, withdrawal behavior, and economic exploits remain unverified",
          "Supply responses are raw observations and do not prove fixed supply or absence of minting",
          ...chain.gaps,
        ], codeExists ? "supported" : "contradicted");
        partial(); return chain;
      } catch { result.limitations.push(`Contract inspection: ${failure}; chain identity or snapshot validation may have failed`); }
    }
    partial(); return undefined;
  })();
  const controlTask = (async () => {
    const chain = await primaryTask;
    if (submission.token && relatedLimit) {
      const inventory = inventoryContracts(discovery, submission.token, relatedLimit);
      const inventoryRecord = evidence("website", submission.links[0]!, inventory, "Inventory captured address candidates and matching-chain explorer links; rank document context within the saved four-address budget");
      const selected = inventory.candidates.filter((candidate) => candidate.selected);
      if (chain) {
        controlRefs.push(inventoryRecord);
        finding("contract_control", "Related-address inspection scope is recorded", `${inventory.candidates.length} address candidates were inventoried; ${selected.length} were selected for related-contract views. ${inventory.candidates.filter((candidate) => !candidate.selected && candidate.address !== submission.token!.address).length} additional candidates were excluded from related-contract views. Selection is not a completed inspection or proof of protocol membership.`, [inventoryRecord], inventory.limitations);
        if (selected.length) {
          onProgress("Reading selected related contracts at the token snapshot block");
          try {
            const related = await collectRelatedContracts(chain, selected, rpc);
            for (const contract of related.contracts) {
              const record = evidence("onchain", contract.sourceUrl, { ...contract, snapshotChecks: related.records.filter((entry) => ["eth_chainId", "eth_getBlockByNumber"].includes(entry.method)) }, "Pinned-block bytecode, owner(), getThreshold() and getOwners() views; validate chain and block before and after the bounded batch", { snapshot: contract.snapshot });
              controlRefs.push(record);
              const configuration = contract.safeConfiguration;
              const description = contract.bytecode === null ? "Bytecode could not be read. Deployment status is unknown."
                : contract.bytecode === "0x" ? "No bytecode was returned at this address."
                : `Bytecode was returned. owner() candidate: ${contract.ownerCandidate ?? "none established"}. ${configuration ? `Safe-compatible views returned a threshold of ${configuration.threshold} required approvals and ${configuration.owners.length} owner addresses.` : "A valid Safe-compatible threshold and owner list were not established."}`;
              finding("contract_control", `Bounded related-contract views for ${contract.address}`, `At block ${contract.snapshot.blockNumber}, ${contract.address}: ${description}`, [record], contract.gaps.length ? contract.gaps : ["Interface responses do not establish effective protocol permissions"], contract.bytecode === null ? "unverified" : "supported");
            }
          } catch { result.limitations.push(`Related-contract inspection: ${failure}; no batch observations accepted without consistent chain and block guards`); }
        }
      } else result.limitations.push("Related-address inventory is available, but related-contract views require a valid primary-token snapshot");
      result.limitations.push(...inventory.limitations);
    }
    finish("contract_control", controlRefs, submission.token ? `${CHAIN_NETWORKS[submission.token.chainId]?.name ?? `Chain ${submission.token.chainId}`} token and standard proxy introspection; up to ${relatedLimit} related addresses receive bounded interface views` : "No chain and token address were submitted");
  })();

  const deploymentTask = (async () => {
    const chain = await primaryTask;
    const deploymentRefs: Evidence[] = [];
    if (submission.token && !chain) result.limitations.push("Source verification: a validated primary-token snapshot is required before requesting and comparing source records");
    if (submission.token && chain) {
      onProgress("Checking Sourcify source verification records");
      const addresses = [...new Set([submission.token.address, ...(chain?.implementation ? [chain.implementation] : [])])];
      await Promise.all(addresses.map(async (address) => {
        try {
          const url = `https://sourcify.dev/server/v2/contract/${chain.snapshot.chainId}/${address}?fields=runtimeBytecode.onchainBytecode,compilation`;
          const response = await get(url);
          const verified = z.object({ chainId: z.string(), address: z.string(), runtimeMatch: z.enum(["match", "exact_match"]).nullable(), runtimeBytecode: z.object({ onchainBytecode: z.string().regex(/^0x(?:[a-f0-9]{2})*$/i) }).optional() }).passthrough().parse(response.data);
          if (verified.chainId !== String(chain.snapshot.chainId) || verified.address.toLowerCase() !== address) throw new Error("Source service returned a different deployment");
          const observedCode = address === chain.snapshot.address ? chain.bytecode : chain.implementationCode;
          const codeMatchesSnapshot = Boolean(observedCode && observedCode !== "0x" && verified.runtimeBytecode?.onchainBytecode.toLowerCase() === observedCode.toLowerCase());
          const record = evidence("api", response.finalUrl, { sourcify: verified, codeMatchesSnapshot, snapshot: chain?.snapshot ?? null }, "Read Sourcify v2 verification record and compare stored runtime bytecode with collected bytecode when available", { capturedAt: response.capturedAt });
          deploymentRefs.push(record);
          finding("deployment_match", `Source verification correspondence for ${address}`, `Sourcify reports the runtime verification status as ${verified.runtimeMatch ?? "unavailable"}. Its stored bytecode ${codeMatchesSnapshot ? "matches" : "has not been matched to"} the collected snapshot.`, [record], ["Third-party verification record; this investigation did not independently recompile source", "Does not connect a GitHub revision to this deployment or establish implementation correctness", "A proxy's source verification does not verify its implementation; each address must be assessed separately"], verified.runtimeMatch && codeMatchesSnapshot ? "partially_supported" : "unverified");
        } catch { result.limitations.push(`Source verification ${address}: ${failure}; absence of a record is not proof that no verified source exists elsewhere`); }
      }));
    }
    finish("deployment_match", deploymentRefs, "Third-party source verification and optional bytecode comparison; repository-to-deployment correspondence remains unverified");
  })();

  const activityTask = (async () => {
    const chain = await primaryTask;
    const activityRefs: Evidence[] = [];
    if (chain && chain.bytecode !== "0x") {
      onProgress("Analyzing a bounded window of token transfer events");
      try {
        const sample = await collectTransfers(chain, rpc), analysis = analyzeTransfers(sample);
        const record = evidence("activity", chain.sourceUrl, { sample, analysis }, "Read up to 128 blocks of Transfer logs and count concentration, repeated amounts, and reciprocal pairs", { snapshot: chain.snapshot });
        activityRefs.push(record);
        finding("activity_quality", "Recent token transfer activity has been sampled", `${analysis.transfers} non-mint/burn ERC-20-shaped transfers involving ${analysis.participants} addresses were observed from block ${analysis.fromBlock} to ${analysis.toBlock}. ${analysis.topSenderShare === null ? "No sender share can be calculated." : `The largest sender accounts for ${(analysis.topSenderShare * 100).toFixed(1)}% of counted transfers.`}`, [record], analysis.limitations);
      } catch { result.limitations.push(`Activity: ${failure}; oversized, inconsistent, or reorganized log windows are rejected`); }
    }
    finish("activity_quality", activityRefs, "Requires a collected contract snapshot and a successful bounded log query; common gas funding and lifetime activity are not assessed");
  })();
  await Promise.all([webTask, repositoryTask, apiTask, controlTask, deploymentTask, activityTask, gmgnTask]);
  result.findings.sort((a, b) => areas.indexOf(a.area) - areas.indexOf(b.area) || a.claim.localeCompare(b.claim));
  const evidenceArea = (item: Evidence) => result.checks.findIndex((check) => check.evidenceIds.includes(item.id));
  result.evidence.sort((a, b) => evidenceArea(a) - evidenceArea(b) || a.sourceUrl.localeCompare(b.sourceUrl) || a.sha256.localeCompare(b.sha256));
  result.limitations.sort();
  partial();
  return result;
}
