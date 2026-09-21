import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { discoverWebsite, extractPage } from "./discovery.ts";
import { fetchPage, type FetchedPage, type PageNetwork } from "./fetch-page.ts";
import { assessReadiness, investigationSchema } from "./investigation.ts";

const address = `0x${"ab".repeat(20)}`;
const otherAddress = `0x${"cd".repeat(20)}`;
type Response = Awaited<ReturnType<PageNetwork["request"]>>;

function response(body = "<title>Example</title>", status = 200, headers: Response["headers"] = {}): Response {
  return {
    status, headers: { "content-type": "text/html; charset=utf-8", ...headers },
    body: (async function* () { yield Buffer.from(body); })(), close: () => {},
  };
}

function network(responses: Response[] = [response()]) {
  const requests: { url: string; address: string; signal: AbortSignal }[] = [];
  const lookups: string[] = [];
  const adapter: PageNetwork = {
    resolve: async (host) => { lookups.push(host); return [{ address: "93.184.216.34", family: 4 }]; },
    request: async (url, ip, signal) => {
      requests.push({ url: url.href, address: ip.address, signal });
      const result = responses.shift();
      assert.ok(result, "Unexpected request");
      return result;
    },
  };
  return { adapter, requests, lookups };
}

function page(html: string, url = "https://example.com/"): FetchedPage {
  return {
    requestedUrl: url, finalUrl: url, status: 200, contentType: "text/html; charset=utf-8",
    body: Buffer.from(html), capturedAt: new Date().toISOString(), redirects: [],
  };
}

test("fetch pins a public DNS result and preserves raw response bytes", async () => {
  const fixture = network([response("<p>Evidence &amp; claims</p>")]);
  const result = await fetchPage("https://example.com/#section", {}, fixture.adapter);
  assert.deepEqual(fixture.lookups, ["example.com"]);
  assert.equal(fixture.requests[0]!.address, "93.184.216.34");
  assert.equal(result.finalUrl, "https://example.com/");
  assert.equal(result.body.toString(), "<p>Evidence &amp; claims</p>");
  assert.ok(Number.isFinite(Date.parse(result.capturedAt)));
});

test("fetch blocks private and reserved IP literals before any request", async () => {
  for (const host of [
    "127.0.0.1", "127.1", "2130706433", "0x7f000001", "10.0.0.1", "172.16.0.1", "192.168.1.1",
    "169.254.169.254", "100.64.0.1", "0.0.0.0", "192.0.2.1", "224.0.0.1",
    "[::1]", "[::]", "[fc00::1]", "[fe80::1]", "[::ffff:127.0.0.1]", "[2001:db8::1]",
  ]) {
    const fixture = network();
    await assert.rejects(fetchPage(`http://${host}/`, {}, fixture.adapter), /private, reserved/);
    assert.equal(fixture.requests.length, 0, host);
  }
});

test("DNS answers containing even one private address are rejected", async () => {
  const fixture = network();
  fixture.adapter.resolve = async () => [
    { address: "93.184.216.34", family: 4 }, { address: "127.0.0.1", family: 4 },
  ];
  await assert.rejects(fetchPage("https://example.com", {}, fixture.adapter), /private, reserved/);
  assert.equal(fixture.requests.length, 0);
});

test("empty, malformed, and inconsistent DNS answers fail closed", async () => {
  for (const answers of [[], [{ address: "invalid", family: 4 }], [{ address: "93.184.216.34", family: 6 }]]) {
    const fixture = network();
    fixture.adapter.resolve = async () => answers;
    await assert.rejects(fetchPage("https://example.com", {}, fixture.adapter), /private, reserved/);
    assert.equal(fixture.requests.length, 0);
  }
});

test("fetch accepts public IPv6 addresses without resolving them again", async () => {
  const fixture = network();
  await fetchPage("https://[2606:4700:4700::1111]/", {}, fixture.adapter);
  assert.equal(fixture.lookups.length, 0);
  assert.equal(fixture.requests[0]!.address, "2606:4700:4700::1111");
});

test("fetch rejects credentials, unusual ports, and non-web protocols", async () => {
  for (const url of ["not-a-url", "file:///etc/passwd", "https://user:password@example.com", "https://example.com:8443"]) {
    const fixture = network();
    await assert.rejects(fetchPage(url, {}, fixture.adapter), /Only HTTP/);
    assert.equal(fixture.requests.length, 0);
  }
});

test("redirects are recorded and every hop gets a fresh DNS check", async () => {
  let closed = false;
  const redirect = response("", 302, { location: "https://docs.example.com/start" });
  redirect.close = () => { closed = true; };
  const fixture = network([redirect, response()]);
  const result = await fetchPage("https://example.com", {}, fixture.adapter);
  assert.deepEqual(fixture.lookups, ["example.com", "docs.example.com"]);
  assert.equal(closed, true);
  assert.deepEqual(result.redirects, [{ from: "https://example.com/", to: "https://docs.example.com/start", status: 302 }]);
});

test("redirects cannot access a private destination", async () => {
  const fixture = network([response("", 302, { location: "http://169.254.169.254/latest" })]);
  await assert.rejects(fetchPage("http://example.com", {}, fixture.adapter), /private, reserved/);
  assert.equal(fixture.requests.length, 1);
});

test("same-host redirects cannot rebind to a private address", async () => {
  const fixture = network([response("", 302, { location: "/docs" })]);
  let lookups = 0;
  fixture.adapter.resolve = async () => [{ address: ++lookups === 1 ? "93.184.216.34" : "127.0.0.1", family: 4 }];
  await assert.rejects(fetchPage("https://example.com", {}, fixture.adapter), /private, reserved/);
  assert.equal(fixture.requests.length, 1);
});

test("redirect loops, missing locations, downgrade, and redirect limits are bounded", async () => {
  for (const [reply, pattern] of [
    [response("", 302, { location: "/" }), /Redirect loop/],
    [response("", 302), /no location/],
    [response("", 302, { location: "http://example.com/" }), /downgrade/],
  ] as const) await assert.rejects(fetchPage("https://example.com", {}, network([reply]).adapter), pattern);
  const fixture = network([response("", 301, { location: "/next" })]);
  await assert.rejects(fetchPage("https://example.com", { maxRedirects: 0 }, fixture.adapter), /Redirect limit/);
});

test("error pages, non-HTML responses, and unsolicited compression remain failures", async () => {
  for (const [reply, pattern] of [
    [response("Unavailable", 503), /HTTP 503/],
    [response("{}", 200, { "content-type": "application/json" }), /supported HTML/],
    [response("compressed", 200, { "content-encoding": "gzip" }), /Compressed responses/],
  ] as const) await assert.rejects(fetchPage("https://example.com", {}, network([reply]).adapter), pattern);
});

test("byte limits apply to headers and streamed content and close responses", async () => {
  for (const reply of [response("abc", 200, { "content-length": "10" }), response("123456")]) {
    let closed = false;
    reply.close = () => { closed = true; };
    await assert.rejects(fetchPage("https://example.com", { maxBytes: 5 }, network([reply]).adapter), /byte limit/);
    assert.equal(closed, true);
  }
});

test("time limits include DNS and prevent a late request after timeout", async () => {
  const fixture = network();
  let finish!: (value: { address: string; family: number }[]) => void;
  fixture.adapter.resolve = () => new Promise((resolve) => { finish = resolve; });
  await assert.rejects(fetchPage("https://example.com", { timeoutMs: 10 }, fixture.adapter), /time limit/);
  finish([{ address: "93.184.216.34", family: 4 }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.requests.length, 0);
});

test("time limits abort an in-flight request", async () => {
  const fixture = network();
  let aborted = false;
  fixture.adapter.request = (_url, _ip, signal) => new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => { aborted = true; reject(signal.reason); }, { once: true });
  });
  await assert.rejects(fetchPage("https://example.com", { timeoutMs: 10 }, fixture.adapter), /time limit/);
  assert.equal(aborted, true);
});

test("invalid request limits are rejected before network work", async () => {
  for (const options of [{ timeoutMs: 0 }, { maxBytes: 1_000_000 }, { maxRedirects: 100 }]) {
    const fixture = network();
    await assert.rejects(fetchPage("https://example.com", options, fixture.adapter));
    assert.equal(fixture.requests.length, 0);
  }
});

test("HTML extraction resolves base URLs, decodes entities, and ignores executable links", () => {
  const result = extractPage(page(`<title>Example &amp; Protocol</title><base href="/guide/">
    <a href="start">Read more</a><a href="start#intro">Documentation</a>
    <a href="https://github.com/example/protocol">Source</a><a href="https://api.example.com/v1">API</a>
    <a href="javascript:alert(1)">Bad</a><a href="mailto:help@example.com">Email</a>
    <a href="https://user:password@example.com">Credentials</a><a href="#local">Local</a>
    <script>globalThis.injected = true</script><style>hidden</style><p>Public &amp; readable</p>`));
  assert.equal(result.title, "Example & Protocol");
  assert.deepEqual(result.links.map((link) => [link.url, link.kind]), [
    ["https://example.com/guide/start", "documentation"],
    ["https://github.com/example/protocol", "repository"], ["https://api.example.com/v1", "api"],
  ]);
  assert.match(result.text, /Public & readable/);
  assert.doesNotMatch(result.text, /globalThis|hidden/);
});

test("repository-like hosts and platform landing pages do not become repository candidates", () => {
  const result = extractPage(page(`<a href="https://github.com.evil.example/org/repo">Code</a>
    <a href="https://github.com/example">Org</a><a href="https://github.com/features/actions">Features</a>`));
  assert.ok(result.links.every((link) => link.kind === "website"));
});

test("candidate addresses retain their source and only explorer paths suggest a chain", () => {
  const result = extractPage(page(`<p>${address}</p><p>0x${"ab".repeat(32)}</p>
    <script>${otherAddress}</script><a href="https://basescan.org/address/${address}">Contract</a>
    <a href="https://etherscan.io.evil.example/address/${otherAddress}">Another</a>`));
  assert.deepEqual(result.addresses.map((candidate) => [candidate.address, candidate.chainId]), [
    [address, null], [address, 8453], [otherAddress, null],
  ]);
});

test("explorer query parameters do not assign unrelated addresses to the path's chain", () => {
  const result = extractPage(page(`<a href="https://basescan.org/address/${address}?other=${otherAddress}">Contract</a>`));
  assert.equal(result.addresses.find((item) => item.address === otherAddress)?.chainId, null);
});

test("unusual hostnames cannot inherit explorer metadata from object prototypes", () => {
  const result = extractPage(page(`<a href="https://constructor/address/${address}">Contract</a>`));
  assert.equal(result.addresses[0]?.chainId, null);
});

test("large extractions disclose truncation", () => {
  const anchors = Array.from({ length: 210 }, (_, index) => `<a href="/docs/${index}">Docs</a>`).join("");
  const addresses = Array.from({ length: 110 }, (_, index) => `0x${(index + 1).toString(16).padStart(40, "0")}`).join(" ");
  const result = extractPage(page(`${anchors}<p>${addresses}</p><p>${"x".repeat(21_000)}</p>`));
  assert.equal(result.links.length, 200);
  assert.equal(result.addresses.length, 100);
  assert.equal(result.text.length, 20_000);
  assert.ok(result.linksTruncated && result.addressesTruncated && result.textTruncated);
});

test("transport charset controls decoding while evidence bytes remain unchanged", () => {
  const source = page("");
  source.body = Buffer.from("<title>Caf\xe9</title>", "latin1");
  source.contentType = "text/html; charset=windows-1252";
  assert.equal(extractPage(source).title, "Caf\u00e9");
});

test("discovery follows bounded linked documentation and retains raw evidence", async () => {
  const requested: string[] = [];
  const source = `<a href="/docs">Docs</a><a href="https://docs.external.example">Docs</a>
    <a href="https://github.com/example/protocol">Source</a><p>${address}</p>`;
  const result = await discoverWebsite({ links: ["https://example.com"], token: { chainId: 1, address: otherAddress } }, {}, async (url) => {
    requested.push(url);
    return page(url.endsWith("/docs") ? '<a href="/docs">Docs</a>' : source, url);
  });
  assert.deepEqual(requested, ["https://example.com/", "https://example.com/docs", "https://docs.external.example/"]);
  assert.equal(result.investigation.evidence.length, 6);
  const firstRaw = result.investigation.evidence[0]!;
  assert.equal(firstRaw.role, "claim");
  assert.equal(Buffer.from(JSON.parse(firstRaw.content).bodyBase64, "base64").toString(), source);
  assert.equal(result.investigation.evidence[1]!.role, "observation");
  assert.equal(result.investigation.subject.token?.address, otherAddress);
  assert.equal(result.investigation.findings.length, 0);
  assert.equal(assessReadiness(result.investigation).readyForReview, false);
  assert.equal(investigationSchema.safeParse(result.investigation).success, true);
});

test("page budgets count failures and report unfetched candidates", async () => {
  let calls = 0;
  const result = await discoverWebsite({ links: ["https://example.com"] }, { maxPages: 2 }, async (url) => {
    calls++;
    if (url.endsWith("/docs/one")) throw new Error("HTTP 404");
    return page('<a href="/docs/one">Docs</a><a href="/docs/two">Docs</a>', url);
  });
  assert.equal(calls, 2);
  assert.equal(result.failures[0]?.reason, "HTTP 404");
  assert.deepEqual(result.budget.remainingUrls, ["https://example.com/docs/two"]);
});

test("discovery deduplicates fragment variants and records total failure as blocked", async () => {
  let calls = 0;
  const result = await discoverWebsite({ links: ["https://example.com/#a", "https://example.com/#b"] }, {}, async () => {
    calls++;
    throw new Error("Unavailable");
  });
  assert.equal(calls, 1);
  assert.equal(result.pages.length, 0);
  assert.equal(result.investigation.checks[0]?.status, "blocked");
  assert.equal(result.investigation.evidence.length, 0);
});

test("invalid discovery options fail before collection", async () => {
  let calls = 0;
  await assert.rejects(discoverWebsite({ links: ["https://example.com"] }, { maxPages: 6 }, async () => {
    calls++; return page("");
  }));
  assert.equal(calls, 0);
});

test("CLI rejects local targets with a structured failure and nonzero exit", () => {
  const result = spawnSync(process.execPath, [new URL("./discovery.ts", import.meta.url).pathname, "http://127.0.0.1"], { encoding: "utf8" });
  assert.equal(result.status, 1, result.stderr);
  assert.equal(JSON.parse(result.stdout).pages.length, 0);
  assert.match(JSON.parse(result.stdout).failures[0].reason, /private, reserved/);
});


test("Markdown documentation preserves bytes, reads reference links and excludes code examples", async () => {
  const body = `# Protocol docs
A reserve-backed token. [Contracts][contracts] and [Code](https://github.com/example/protocol).
[contracts]: https://robinhoodchain.blockscout.com/address/${address}

\`\`\`solidity
[Ignore](https://docs.evil.example/) ${otherAddress}
\`\`\`

[Unsafe](javascript:alert(1)) and [Credentials](https://user:secret@example.com)
![Image](https://images.example.com/docs.png)
`;
  const fixture = network([response(body, 200, { "content-type": "text/markdown; charset=utf-8" })]);
  const fetched = await fetchPage("https://docs.example.com", {}, fixture.adapter);
  assert.equal(fetched.body.toString(), body);
  const parsed = extractPage(fetched);
  assert.equal(parsed.title, "Protocol docs");
  assert.match(parsed.text, /reserve-backed token/);
  assert.equal(parsed.links.length, 2);
  assert.equal(parsed.links.find((link) => link.kind === "repository")?.url, "https://github.com/example/protocol");
  assert.ok(parsed.addresses.some((item) => item.address === address && item.chainId === 4663));
  assert.ok(!parsed.addresses.some((item) => item.address === otherAddress));
  assert.ok(!parsed.links.some((link) => /evil|user|images/.test(link.url)));
});

test("plain text tokenization supports autolinks and documents remain bounded", async () => {
  const fixture = network([response("Read <https://docs.example.com/guide>.", 200, { "content-type": "text/plain" })]);
  const parsed = extractPage(await fetchPage("https://example.com", {}, fixture.adapter));
  assert.equal(parsed.links[0]?.url, "https://docs.example.com/guide");
  await assert.rejects(fetchPage("https://example.com", { maxBytes: 3 }, network([response("# Longer", 200, { "content-type": "text/markdown" })]).adapter), /byte limit/);
});

test("Markdown observation exposes readable text and links to original claim bytes", async () => {
  const body = "# Treasury\nThe project claims a reserve floor, not a guaranteed market price.";
  const result = await discoverWebsite({ links: ["https://docs.example.com/"] }, {}, async (url) => ({ ...page(body, url), contentType: "text/markdown" }));
  const [raw, observed] = result.investigation.evidence;
  assert.equal(raw?.role, "claim");
  assert.equal(raw?.medium, "documentation");
  assert.equal(Buffer.from(JSON.parse(raw!.content).bodyBase64, "base64").toString(), body);
  const parsed = JSON.parse(observed!.content);
  assert.equal(parsed.rawEvidenceId, raw?.id);
  assert.match(parsed.text, /project claims a reserve floor/);
  assert.equal(parsed.textTruncated, false);
});

test("linked documentation uses normal network guards and counts blocked fetches", async () => {
  const fixture = network([response('<a href="http://127.0.0.1/docs">Documentation</a>')]);
  const result = await discoverWebsite({ links: ["https://example.com"] }, {}, (url) => fetchPage(url, {}, fixture.adapter));
  assert.equal(result.pages.length, 1);
  assert.equal(result.budget.attemptedPages, 2);
  assert.match(result.failures[0]!.reason, /private, reserved/);
  assert.equal(fixture.requests.length, 1);
});

test("mainnet and testnet explorer hints remain distinct and spoofed hosts are unassigned", () => {
  const result = extractPage(page(`<a href="https://robinhoodchain.blockscout.com/address/${address}">NET</a>
    <a href="https://explorer.testnet.chain.robinhood.com/address/${otherAddress}">Test token</a>
    <a href="https://robinhoodchain.blockscout.com.evil.example/address/${otherAddress}">Lookalike</a>`));
  assert.ok(result.addresses.some((item) => item.chainId === 4663));
  assert.ok(result.addresses.some((item) => item.chainId === 46630));
  assert.equal(result.addresses.find((item) => item.sourceUrl.includes("evil"))?.chainId, null);
});

test("empty static shells disclose the need for rendering instead of implying readable coverage", async () => {
  const result = await discoverWebsite({ links: ["https://example.com/"] }, {}, async (url) => page('<title>App</title><script src="app.js"></script><div id="root"></div>', url));
  assert.equal(result.pages[0]!.text, "");
  assert.ok(result.limitations.some((item) => item.includes("no readable static text")));
});
