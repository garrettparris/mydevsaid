import { BasicCrawler, Configuration, Log, LogLevel, NonRetryableError } from "@crawlee/basic";
import { loadBuffer } from "cheerio";
import { chromium, type Browser } from "playwright";
import { randomUUID } from "node:crypto";
import { fetchWebResource, type FetchedPage } from "./fetch-page.ts";

type Fetcher = (url: string) => Promise<FetchedPage>;
export type CrawlResult = { url: string; page?: FetchedPage; error?: string };

export function needsBrowser(page: FetchedPage): boolean {
  if (!/html/i.test(page.contentType)) return false;
  const $ = loadBuffer(page.body), scripts = $("script").length;
  $("script,style,template,svg,nav,header,footer,[hidden]").remove();
  const text = ($("main,article").first().text() || $("body").text()).replace(/\s+/g, " ").trim();
  return scripts > 0 && text.length < 160;
}

let browserPromise: Promise<Browser> | undefined;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let renderTail: Promise<unknown> = Promise.resolve();

export async function closeWebBrowser(): Promise<void> {
  if (idleTimer) clearTimeout(idleTimer);
  const pending = browserPromise; browserPromise = undefined;
  if (pending) await pending.then(browser => browser.close(), () => {});
}

/** One isolated browser context at a time; no request may use direct browser networking. */
export function renderWebPage(raw: FetchedPage, resource: Fetcher = fetchWebResource): Promise<FetchedPage> {
  const work = renderTail.then(async () => {
    if (idleTimer) clearTimeout(idleTimer);
    const failures: string[] = [];
    let requests = 0, bytes = 0;
    const fail = (message: string) => { if (failures.length < 20) failures.push(message.slice(0, 300)); };
    try {
      browserPromise ??= chromium.launch({ headless: true, timeout: 10_000, args: ["--disable-quic", "--force-webrtc-ip-handling-policy=disable_non_proxied_udp"] });
      const browser = await browserPromise;
      const context = await browser.newContext({ serviceWorkers: "block", acceptDownloads: false });
      const deadline = setTimeout(() => { void context.close().catch(() => {}); }, 12_000);
      try {
        await context.routeWebSocket("**/*", socket => socket.close());
        await context.route("**/*", async route => {
          const request = route.request(), url = request.url();
          try {
            if (request.method() !== "GET" || !["document", "script", "stylesheet", "xhr", "fetch"].includes(request.resourceType())) {
              if (["xhr", "fetch"].includes(request.resourceType())) fail(`Blocked ${request.method()} request; browser fallback does not submit actions`);
              await route.abort(); return;
            }
            if (++requests > 40 || bytes >= 8_000_000) throw new Error("Browser resource budget exhausted");
            if (request.resourceType() === "document" && url !== raw.finalUrl) throw new Error("Secondary browser navigation is outside this page capture");
            const response = request.resourceType() === "document" ? raw : await resource(url);
            bytes += response.body.length;
            if (bytes > 8_000_000) throw new Error("Browser byte budget exhausted");
            await route.fulfill({ status: response.status, contentType: response.contentType, body: response.body });
          } catch (error) {
            fail(`${url}: ${error instanceof Error ? error.message : "Resource unavailable"}`);
            await route.abort().catch(() => {});
          }
        });
        const page = await context.newPage();
        await page.goto(raw.finalUrl, { waitUntil: "domcontentloaded", timeout: 8_000 });
        await page.waitForFunction(() => (document.body?.innerText.trim().length ?? 0) >= 80, undefined, { timeout: 3_000 }).catch(() => {
          fail("Rendered page did not reach the minimum readable-text signal within the wait budget");
        });
        const html = await page.content();
        if (Buffer.byteLength(html) > 2_000_000) throw new Error("Rendered document exceeds the byte limit");
        return { ...raw, rendering: { status: "rendered" as const, capturedAt: new Date().toISOString(), html, requests, failures } };
      } finally { clearTimeout(deadline); await context.close().catch(() => {}); }
    } catch (error) {
      fail(error instanceof Error ? error.message : "Browser unavailable");
      return { ...raw, rendering: { status: "failed" as const, capturedAt: new Date().toISOString(), requests, failures } };
    } finally {
      idleTimer = setTimeout(() => { void closeWebBrowser(); }, 2_000); idleTimer.unref();
    }
  });
  renderTail = work.catch(() => {});
  return work;
}

/** Crawlee owns retry/concurrency; callers submit only the next budgeted discovery batch. */
export async function crawlWebBatch(urls: string[], options: { fetch?: Fetcher; render?: (page: FetchedPage) => Promise<FetchedPage> } = {}): Promise<CrawlResult[]> {
  const fetcher = options.fetch ?? fetchWebResource, render = options.render ?? renderWebPage;
  const results = new Map<string, CrawlResult>();
  const id = randomUUID();
  const config = new Configuration({ persistStorage: false, purgeOnStart: false,
    storageClientOptions: { persistStorage: false, writeMetadata: false }, defaultRequestQueueId: id, defaultKeyValueStoreId: id, defaultDatasetId: id });
  const crawler = new BasicCrawler({
    minConcurrency: Math.min(3, Math.max(1, urls.length)), maxConcurrency: 3, maxRequestRetries: 1, useSessionPool: false,
    requestHandlerTimeoutSecs: 60, log: new Log({ level: LogLevel.OFF }),
    async requestHandler({ request }) {
      let page: FetchedPage;
      try {
        page = await fetcher(request.url);
        if (!/^(text\/(?:html|markdown|plain)|application\/xhtml\+xml)(?:\s*;|$)/i.test(page.contentType)) throw new Error("Not a supported page document");
      } catch (error) {
        const message = error instanceof Error ? error.message : "Page unavailable";
        if (/HTTP (408|429|5\d\d)|time limit|ECONNRESET|ETIMEDOUT|EAI_AGAIN/.test(message)) throw error;
        throw new NonRetryableError(message);
      }
      if (needsBrowser(page)) page = await render(page);
      results.set(request.url, { url: request.url, page });
    },
    async errorHandler() { await new Promise(resolve => setTimeout(resolve, 400)); },
    async failedRequestHandler({ request }, error) { results.set(request.url, { url: request.url, error: error.message }); },
  }, config);
  try { await crawler.run([...new Set(urls)]); }
  finally { await config.getStorageClient().teardown?.(); }
  return urls.map(url => results.get(url) ?? { url, error: "Crawl ended without a page capture" });
}
