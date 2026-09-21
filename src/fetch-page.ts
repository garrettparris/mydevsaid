import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";
import { z } from "zod";
import { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

const limitsSchema = z.strictObject({
  timeoutMs: z.number().int().min(1).max(30_000).default(8_000),
  maxBytes: z.number().int().min(1).max(250_000).default(250_000),
  maxRedirects: z.number().int().min(0).max(5).default(3),
});
type Address = { address: string; family: number };
type Response = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: AsyncIterable<Uint8Array>;
  close: () => void;
};
export type PageNetwork = {
  resolve: (hostname: string) => Promise<Address[]>;
  request: (url: URL, address: Address, signal: AbortSignal, request?: HttpRequest) => Promise<Response>;
};
type HttpRequest = { method: "GET" | "POST"; accept: string; body?: string; acceptEncoding?: string };
export type FetchedPage = {
  requestedUrl: string;
  finalUrl: string;
  status: number;
  contentType: string;
  body: Buffer;
  capturedAt: string;
  redirects: { from: string; to: string; status: number }[];
  rendering?: { status: "rendered" | "failed"; capturedAt: string; html?: string; requests: number; failures: string[] };
};

const network: PageNetwork = {
  resolve: (hostname) => lookup(hostname, { all: true, verbatim: true }),
  request: (url, address, signal, payload) => new Promise((resolve, reject) => {
    const request = (url.protocol === "https:" ? httpsRequest : httpRequest)(url, {
      method: payload?.method ?? "GET", agent: false, family: address.family,
      signal, maxHeaderSize: 16_384,
      // Pin the checked address while retaining the original Host header and TLS hostname.
      lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
      headers: {
        "User-Agent": "mydevsaid/0.1 (website discovery)",
        Accept: payload?.accept ?? "text/html,application/xhtml+xml;q=0.9", "Accept-Encoding": payload?.acceptEncoding ?? "identity",
        ...(payload?.body ? { "Content-Type": "application/json", "Content-Length": String(Buffer.byteLength(payload.body)) } : {}),
      },
    }, (response) => resolve({
      status: response.statusCode ?? 0, headers: response.headers, body: response,
      close: () => { response.destroy(); },
    }));
    request.on("error", reject);
    request.end(payload?.body);
  }),
};

function target(input: string): URL {
  const url = URL.parse(input);
  if (!url || !["https:", "http:"].includes(url.protocol) || url.username || url.password || url.port) {
    throw new Error("Only HTTP(S) URLs without credentials or nonstandard ports are allowed");
  }
  url.hash = "";
  return url;
}

async function publicAddress(url: URL, resolve: PageNetwork["resolve"]): Promise<Address> {
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const family = isIP(hostname);
  const addresses = family ? [{ address: hostname, family }] : await resolve(hostname);
  if (!addresses.length || addresses.some((item) =>
    !ipaddr.isValid(item.address) || ipaddr.process(item.address).range() !== "unicast"
    || isIP(item.address) !== item.family)) {
    throw new Error("Target resolves to a private, reserved, or invalid address");
  }
  return addresses[0]!;
}

/** Preflight only; each actual request must still resolve and pin its own validated address. */
export async function validatePublicUrl(input: string): Promise<void> {
  const url = target(input);
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Domain validation exceeded its time limit")), 8_000); });
  try { await Promise.race([publicAddress(url, network.resolve), timeout]); }
  finally { clearTimeout(timer!); }
}

function header(response: Response, name: string): string {
  const value = response.headers[name];
  return Array.isArray(value) ? value.join(", ") : value ?? "";
}

/** The optional network adapter is trusted application wiring, never a submission field. */
export async function fetchPage(
  input: string,
  options: z.input<typeof limitsSchema> = {},
  adapter: PageNetwork = network,
): Promise<FetchedPage> {
  return fetchDocument(input, options, adapter, { method: "GET", accept: "text/html,application/xhtml+xml;q=0.9,text/markdown;q=0.8,text/plain;q=0.7" }, false);
}

async function fetchDocument(
  input: string,
  options: z.input<typeof limitsSchema>,
  adapter: PageNetwork,
  payload: HttpRequest,
  json: boolean | "resource",
): Promise<FetchedPage> {
  const limits = (json === "resource" ? limitsSchema.extend({ maxBytes: z.number().int().min(1).max(2_000_000).default(2_000_000) }) : limitsSchema).parse(options);
  const initial = target(input);
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error("Page request exceeded its time limit");
      reject(error);
      controller.abort(error);
    }, limits.timeoutMs);
  });
  const run = async (): Promise<FetchedPage> => {
    let url = initial;
    const visited = new Set<string>();
    const redirects: FetchedPage["redirects"] = [];
    while (true) {
      if (visited.has(url.href)) throw new Error("Redirect loop detected");
      visited.add(url.href);
      const address = await publicAddress(url, adapter.resolve);
      controller.signal.throwIfAborted();
      const response = await adapter.request(url, address, controller.signal, payload);
      try {
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          if (redirects.length >= limits.maxRedirects) throw new Error("Redirect limit exceeded");
          const location = header(response, "location");
          if (!location) throw new Error("Redirect response has no location");
          const next = target(new URL(location, url).href);
          if (url.protocol === "https:" && next.protocol === "http:") throw new Error("HTTPS downgrade blocked");
          redirects.push({ from: url.href, to: next.href, status: response.status });
          url = next;
          continue;
        }
        if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`);
        const contentType = header(response, "content-type");
        const supported = json === "resource" ? /^(text\/(?:html|markdown|plain|javascript|css)|application\/(?:javascript|x-javascript|(?:[\w.-]+\+)?json|xhtml\+xml))(?:\s*;|$)/i
          : json ? /^application\/(?:[\w.-]+\+)?json(?:\s*;|$)/i : /^(text\/(?:html|markdown|plain)|application\/xhtml\+xml)(?:\s*;|$)/i;
        if (!supported.test(contentType)) {
          throw new Error(`Response is not a supported ${json ? "JSON" : "HTML, Markdown, or plain-text"} document`);
        }
        const encoding = header(response, "content-encoding").toLowerCase();
        if (encoding && encoding !== "identity" && (json !== "resource" || !["gzip", "br", "deflate"].includes(encoding))) throw new Error("Compressed responses are not supported by this collector");
        if (Number(header(response, "content-length")) > limits.maxBytes) throw new Error("Page exceeds the byte limit");
        const chunks: Buffer[] = [];
        let bytes = 0;
        const bounded = async function* () {
          let wireBytes = 0;
          for await (const chunk of response.body) {
            wireBytes += chunk.byteLength;
            if (wireBytes > limits.maxBytes) throw new Error("Page exceeds the encoded byte limit");
            yield chunk;
          }
        };
        const decoder = encoding === "gzip" ? createGunzip() : encoding === "br" ? createBrotliDecompress() : encoding === "deflate" ? createInflate() : null;
        const source = Readable.from(bounded());
        if (decoder) source.once("error", error => decoder.destroy(error));
        try { for await (const chunk of decoder ? source.pipe(decoder) : source) {
          controller.signal.throwIfAborted();
          bytes += chunk.byteLength;
          if (bytes > limits.maxBytes) throw new Error("Page exceeds the byte limit");
          chunks.push(Buffer.from(chunk));
        } } finally { source.destroy(); decoder?.destroy(); }
        return {
          requestedUrl: initial.href, finalUrl: url.href, status: response.status, contentType,
          body: Buffer.concat(chunks), capturedAt: new Date().toISOString(), redirects,
        };
      } finally { response.close(); }
    }
  };
  try { return await Promise.race([run(), timeout]); }
  finally { clearTimeout(timer!); }
}

/** Public web resources only. Browser requests use this guarded transport instead of direct networking. */
export async function fetchWebResource(input: string, options: z.input<typeof limitsSchema> = {}, adapter: PageNetwork = network): Promise<FetchedPage> {
  return fetchDocument(input, options, adapter, { method: "GET", accept: "text/html,application/xhtml+xml,text/markdown,text/plain,application/javascript,text/javascript,text/css,application/json", acceptEncoding: "gzip, br, deflate" }, "resource");
}

export type JsonResponse = FetchedPage & { data: unknown };

/** Bounded unauthenticated GET with the same DNS pinning and redirect checks as HTML discovery. */
export async function fetchJson(input: string, options: z.input<typeof limitsSchema> = {}, adapter: PageNetwork = network): Promise<JsonResponse> {
  const page = await fetchDocument(input, options, adapter, { method: "GET", accept: "application/json,application/rdap+json" }, true);
  return { ...page, data: JSON.parse(page.body.toString("utf8")) as unknown };
}

const readMethods = new Set(["eth_chainId", "eth_blockNumber", "eth_getBlockByNumber", "eth_getCode", "eth_getStorageAt", "eth_call", "eth_getLogs"]);

/** RPC URLs come only from trusted server configuration; transactions and redirects are forbidden. */
export async function postJsonRpc(input: string, method: string, params: unknown[], adapter: PageNetwork = network): Promise<unknown> {
  if (!readMethods.has(method)) throw new Error("RPC method is not in the read-only allowlist");
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  if (Buffer.byteLength(body) > 16_384) throw new Error("RPC request exceeds the byte limit");
  const response = await fetchDocument(input, { maxRedirects: 0 }, adapter, { method: "POST", accept: "application/json", body }, true);
  const result = z.object({ jsonrpc: z.literal("2.0"), id: z.literal(1), result: z.unknown().optional(), error: z.unknown().optional() }).parse(JSON.parse(response.body.toString("utf8")));
  if (result.error !== undefined) throw new Error("RPC provider returned an error");
  if (!("result" in result)) throw new Error("RPC response has no result");
  return result.result;
}
