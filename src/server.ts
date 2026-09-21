import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { validatePublicUrl } from "./fetch-page.ts";
import { assessReadiness, submissionSchema, tokenSchema } from "./investigation.ts";
import { JobQueue, type Investigator } from "./jobs.ts";
import { recoverCheckout, stripePayments, type PaymentProvider } from "./payments.ts";
import { CheckoutReviewRequired, Store, secretMatches, type Order, type Report } from "./store.ts";
import { startMonitoring } from "./monitor.ts";
import { ScopeError, type Scope } from "./scoping.ts";
import { CHAIN_NETWORKS, rpcUrl } from "./onchain.ts";
import { gmgnConfiguration } from "./gmgn.ts";
import { discoverScope, type ScopeDiscovery } from "./scope-discovery.ts";
import { createPersonalRouter } from "./personal.ts";

export type ServerConfig = { localMode: boolean; origin: string; adminToken: string; modelEnabled: boolean; publicDir: string; trustedProxyIps?: string[] };
class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.status = status; }
}
const header = (req: IncomingMessage, name: string) => typeof req.headers[name] === "string" ? req.headers[name] as string : "";
const bearer = (req: IncomingMessage) => header(req, "authorization").replace(/^Bearer /, "");
const safeOrder = ({ accessHash: _secret, checkoutId: _checkout, previousCheckoutIds: _previous, checkoutGeneration: _generation,
  checkoutAttemptStartedAt: _attempt, checkoutUrl, ...order }: Order) => ({ ...order, ...(order.payment === "pending" && checkoutUrl ? { checkoutUrl } : {}) });
const summary = (report: Report) => ({ id: report.id, title: new URL(report.result.investigation.subject.links[0]!).hostname,
  token: report.result.investigation.subject.token ?? null, createdAt: report.createdAt, publishedAt: report.publishedAt,
  version: report.version, summary: report.result.summary });
function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}
async function body(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 128_000) throw new HttpError(413, "Request body is too large");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
async function input(req: IncomingMessage): Promise<unknown> {
  if (!header(req, "content-type").startsWith("application/json")) throw new HttpError(415, "Use application/json");
  try { return JSON.parse((await body(req)).toString("utf8")); }
  catch (error) { if (error instanceof HttpError) throw error; throw new HttpError(400, "Invalid JSON"); }
}

export function createApp(config: ServerConfig, store: Store, investigate: Investigator, payments?: PaymentProvider,
  validateUrl: (url: string) => Promise<void> = validatePublicUrl,
  scopeDiscover: (links: string[]) => Promise<ScopeDiscovery> = discoverScope,
  runtime?: { queue: JobQueue; workspace: ReturnType<typeof createPersonalRouter> }) {
  const expectedOrigin = new URL(config.origin).origin;
  if (config.trustedProxyIps?.some((ip) => !isIP(ip))) throw new Error("Trusted proxy entries must be exact IP addresses");
  const adminHash = createHash("sha256").update(config.adminToken).digest("hex");
  const queue = runtime?.queue ?? new JobQueue(store, investigate);
  const personal = runtime?.workspace ?? createPersonalRouter(store, queue, config.localMode);
  const checkouts = new Map<string, Promise<void>>();
  const discoveryJobs = new Map<string, Promise<Scope>>();
  const requests = new Map<string, { count: number; until: number }>();
  const admin = (req: IncomingMessage) => {
    if (config.adminToken.length < 24 || !secretMatches(bearer(req), adminHash)) throw new HttpError(401, "Administrator access required");
  };
  const scopeView = (scope: Scope, capability: string) => {
    const order = scope.orderId ? store.getOrder(scope.orderId) : undefined;
    return { ...scope, ...(order ? { order: { orderId: order.id, accessToken: store.scopeOrderToken(capability, order.id),
      checkoutUrl: order.payment === "pending" ? order.checkoutUrl : undefined, status: order.status, payment: order.payment } } : {}) };
  };
  const checkoutFor = (order: Order) => {
    const existing = checkouts.get(order.id);
    if (existing) return existing;
    const now = Date.now(), key = `checkout:${order.id}`;
    for (const [id, value] of requests) if (value.until <= now) requests.delete(id);
    const rate = requests.get(key) ?? { count: 0, until: now + 60_000 };
    if (rate.count >= 6) throw new HttpError(429, "Checkout refresh limit reached. Wait one minute before retrying this order.");
    rate.count++; requests.set(key, rate);
    const pending = (async () => {
      try {
        await recoverCheckout(store, payments!, order.id);
      } catch (error) {
        const current = store.getOrder(order.id)!;
        if (current.payment !== "pending") return;
        current.status = "failed"; current.error = error instanceof CheckoutReviewRequired ? error.message : "Checkout could not be recovered";
        delete current.checkoutUrl; store.saveOrder(current);
        if (error instanceof CheckoutReviewRequired) throw new HttpError(409, error.message);
        throw new HttpError(502, "Checkout is temporarily unavailable. Retry this conversation to resume the same order.");
      }
    })().finally(() => checkouts.delete(order.id));
    checkouts.set(order.id, pending); return pending;
  };
  const previewFor = (scope: Scope, capability: string, revision: unknown) => {
    if (scope.status === "locked") throw new HttpError(409, "This scope is fixed to an order");
    const existing = discoveryJobs.get(scope.id);
    if (existing) return existing;
    if (scope.preview) return Promise.resolve(scope);
    if (discoveryJobs.size >= 4) throw new HttpError(429, "Free website lookups are busy. Retry shortly.");
    const reserved = store.reserveScopeDiscovery(scope.id, capability, revision);
    if (!reserved.reserved) return Promise.resolve(reserved.scope);
    const pending = (async () => {
      try {
        const result = await scopeDiscover(reserved.scope.preview!.seedLinks);
        return store.finishScopeDiscovery(scope.id, capability, reserved.scope.revision, result);
      } catch { return store.finishScopeDiscovery(scope.id, capability, reserved.scope.revision); }
    })().finally(() => discoveryJobs.delete(scope.id));
    discoveryJobs.set(scope.id, pending);
    return pending;
  };
  const server = createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff"); res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: https://gmgn.ai https://*.gmgn.ai; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const url = new URL(req.url ?? "/", expectedOrigin);
      if (config.localMode && (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress ?? "")
        || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(`http://${header(req, "host")}`).hostname))) {
        throw new HttpError(403, "Local preview only accepts localhost requests");
      }
      if (req.method === "POST" && header(req, "origin") && header(req, "origin") !== expectedOrigin) throw new HttpError(403, "Origin is not allowed");
      if (await personal.handle(req, res, url, input, json)) return;
      if (req.method === "GET" && url.pathname === "/api/config") {
        return json(res, 200, { billingEnabled: Boolean(payments) && !config.localMode, modelEnabled: config.modelEnabled,
          localMode: config.localMode, personalMode: config.localMode, priceUsd: 100, adminReviewRequired: true, supportedChains: Object.keys(CHAIN_NETWORKS).map(Number),
          ...(config.localMode ? { connections: {
            gmgn: gmgnConfiguration(),
            model: { enabled: config.modelEnabled, name: process.env.PI_MODEL?.trim() || null },
            rpcs: Object.entries(CHAIN_NETWORKS).map(([id, network]) => {
              const custom = Boolean(process.env[`MYDEVSAID_RPC_${id}`]), selected = URL.parse(rpcUrl(Number(id)));
              return { chainId: Number(id), name: network.name, custom, automaticFailover: false,
                endpoints: [{ priority: 1, host: selected && ["http:", "https:"].includes(selected.protocol) ? selected.host : "Invalid endpoint", selected: true },
                  ...(custom ? [{ priority: 2, host: new URL(network.rpc).host, selected: false }] : [])] };
            }),
          } } : {}) });
      }
      if (req.method === "POST" && url.pathname === "/api/scopes") {
        const key = `scope:${req.socket.remoteAddress}`, now = Date.now();
        for (const [id, rate] of requests) if (rate.until <= now) requests.delete(id);
        const rate = requests.get(key) ?? { count: 0, until: now + 3_600_000 };
        if (++rate.count > 30) throw new HttpError(429, "Free conversation limit reached. Try again later.");
        requests.set(key, rate);
        const value = await input(req);
        return json(res, 201, store.createScope(value && typeof value === "object" && "message" in value ? value.message : undefined));
      }
      const scopeRoute = /^\/api\/scopes\/([a-zA-Z0-9-]+)(\/(?:messages|discovery))?$/.exec(url.pathname);
      if (scopeRoute && ["GET", "POST"].includes(req.method ?? "")) {
        const capability = bearer(req), scope = store.getScope(scopeRoute[1]!, capability);
        if (req.method === "GET" && !scopeRoute[2]) return json(res, 200, { scope: scopeView(scope, capability) });
        if (req.method === "POST" && scopeRoute[2] === "/discovery") {
          const value = await input(req);
          if (!value || typeof value !== "object" || !("revision" in value) || !Number.isSafeInteger(value.revision)) throw new HttpError(400, "Send the current scope revision");
          return json(res, 200, { scope: await previewFor(scope, capability, value.revision) });
        }
        if (req.method === "POST" && scopeRoute[2] === "/messages") {
          const value = await input(req);
          if (!value || typeof value !== "object" || !("message" in value) || !("revision" in value)) throw new HttpError(400, "Send a message and current revision");
          return json(res, 200, { scope: store.updateScope(scope.id, capability, value.message, value.revision) });
        }
      }
      if (req.method === "POST" && url.pathname === "/api/orders") {
        if (config.localMode) admin(req);
        if (!config.localMode && !payments) throw new HttpError(503, "Paid investigations are not configured yet");
        if (!config.localMode && !config.modelEnabled) throw new HttpError(503, "The investigation model is not configured yet");
        let ip = req.socket.remoteAddress ?? "unknown";
        if (config.trustedProxyIps?.includes(ip)) {
          const forwarded = header(req, "x-forwarded-for").split(",").at(-1)?.trim();
          if (forwarded) {
            if (!isIP(forwarded)) throw new HttpError(400, "Proxy supplied an invalid client address");
            ip = forwarded;
          }
        }
        const now = Date.now();
        for (const [key, value] of requests) if (value.until <= now) requests.delete(key);
        const rate = requests.get(ip) ?? { count: 0, until: now + 3_600_000 };
        if (++rate.count > 10) throw new HttpError(429, "Submission limit reached. Try again later.");
        requests.set(ip, rate);
        if (store.orders().filter((order) => ["queued", "running"].includes(order.status)
          || (order.status === "awaiting_payment" && Date.parse(order.createdAt) > now - 86_400_000)).length >= 100) {
          throw new HttpError(503, "The investigation queue is full");
        }
        const value = await input(req);
        const scoped = value && typeof value === "object" && "scopeId" in value;
        if (!config.localMode && !scoped) throw new HttpError(400, "Review a saved conversation scope before starting a paid investigation");
        let scope: Scope | undefined, scopeToken = "", scopeRevision: unknown;
        if (scoped) {
          if (typeof value.scopeId !== "string" || !("scopeAccessToken" in value) || typeof value.scopeAccessToken !== "string"
            || !("scopeRevision" in value) || Object.keys(value).some((key) => !["scopeId", "scopeAccessToken", "scopeRevision"].includes(key))) throw new HttpError(400, "Provide only the scope ID, access token, and revision");
          scopeToken = value.scopeAccessToken; scopeRevision = value.scopeRevision;
          scope = store.getScope(value.scopeId, scopeToken);
          if (scope.revision !== scopeRevision) throw new HttpError(409, "This scope changed. Review its current version before checkout.");
          if (scope.status === "draft" || scope.preview?.status === "running") throw new HttpError(409, "Finish the conversation scope and any running lookup before checkout");
        }
        const parsed = submissionSchema.safeParse(scope ? scope.submission : value);
        if (!parsed.success) throw new HttpError(400, "Provide 1 to 20 HTTP links and a valid optional chain/token address");
        if (!parsed.data.token) throw new HttpError(400, "A chain and token address are required for a publishable investigation");
        if (!CHAIN_NETWORKS[parsed.data.token.chainId]) throw new HttpError(400, "This release supports Ethereum, Base, and Robinhood Chain mainnet");
        try { await Promise.all(parsed.data.links.map(validateUrl)); }
        catch { throw new HttpError(400, "Links must resolve to public websites on standard HTTP(S) ports"); }
        const created = scope ? store.lockScope(scope.id, scopeToken, scopeRevision, config.localMode) : store.createOrder(parsed.data, config.localMode);
        if (config.localMode) queue.kick();
        else if (created.order.payment === "pending") await checkoutFor(created.order);
        const order = store.getOrder(created.order.id)!;
        return json(res, 201, { orderId: order.id, accessToken: created.accessToken, checkoutUrl: order.payment === "pending" ? order.checkoutUrl : undefined, status: order.status });
      }
      if (req.method === "POST" && url.pathname === "/api/webhooks/stripe") {
        if (!payments || config.localMode) throw new HttpError(503, "Billing is not configured");
        let receipt;
        try { receipt = payments.verifyWebhook(await body(req), header(req, "stripe-signature")); }
        catch { throw new HttpError(400, "Invalid payment notification"); }
        if (receipt) { store.acceptPayment(receipt.eventId, receipt.orderId, receipt.checkoutId); queue.kick(); }
        return json(res, 200, { received: true });
      }
      if (req.method === "GET" && url.pathname === "/api/reports") return json(res, 200, { reports: store.published((url.searchParams.get("query") ?? "").slice(0, 200)).map(summary) });
      const tokenRoute = /^\/api\/tokens\/(\d+)\/(0x[a-fA-F0-9]{40})$/.exec(url.pathname);
      if (req.method === "GET" && tokenRoute) {
        const token = tokenSchema.safeParse({ chainId: Number(tokenRoute[1]), address: tokenRoute[2] });
        if (!token.success) throw new HttpError(400, "Invalid token");
        return json(res, 200, { reports: store.published("", token.data).map(summary) });
      }
      if (req.method === "GET" && url.pathname === "/api/admin/orders") {
        admin(req); return json(res, 200, { orders: store.orders().slice(-100).reverse().map(safeOrder) });
      }
      const orderRoute = /^\/api\/orders\/([a-zA-Z0-9-]+)(\/retry|\/checkout)?$/.exec(url.pathname);
      if (orderRoute) {
        const order = store.getOrder(orderRoute[1]!);
        if (!order) throw new HttpError(404, "Order not found");
        if (req.method === "POST" && orderRoute[2] === "/checkout") {
          if (!secretMatches(bearer(req), order.accessHash)) throw new HttpError(401, "Order access token required");
          if (!payments || config.localMode) throw new HttpError(503, "Billing is not configured");
          if (order.payment === "pending") await checkoutFor(order);
          const current = store.getOrder(order.id)!;
          return json(res, 200, { orderId: current.id, status: current.status, payment: current.payment, checkoutUrl: current.payment === "pending" ? current.checkoutUrl : undefined });
        }
        if (req.method === "POST" && orderRoute[2] === "/retry") {
          admin(req);
          try { queue.retry(order.id); } catch { throw new HttpError(409, "Only funded, failed investigations can be retried"); }
          return json(res, 200, { status: store.getOrder(order.id)!.status });
        }
        if (req.method === "GET" && !orderRoute[2]) {
          if (!secretMatches(bearer(req), order.accessHash)) throw new HttpError(401, "Order access token required");
          const report = order.reportId ? store.getReport(order.reportId) : undefined;
          return json(res, 200, { ...safeOrder(order), ...(report ? { result: report.result, changes: report.changes, readiness: assessReadiness(report.result.investigation) } : {}) });
        }
      }
      const reportRoute = /^\/api\/(admin\/)?reports\/([a-zA-Z0-9-]+)(\/publish|\/recheck)?$/.exec(url.pathname);
      if (reportRoute) {
        const report = store.getReport(reportRoute[2]!);
        if (req.method === "POST" && reportRoute[3] === "/recheck") {
          admin(req);
          if (!report?.publishedAt) throw new HttpError(404, "Published report not found");
          const { order, accessToken } = store.createOrder(report.result.investigation.subject, true);
          order.progress.push(`Administrator requested a fresh observation of report ${report.id}`); store.saveOrder(order);
          queue.kick(); return json(res, 201, { orderId: order.id, accessToken, status: order.status });
        }
        if (req.method === "POST" && reportRoute[3] === "/publish") {
          admin(req);
          const acknowledgement = await input(req);
          if (!acknowledgement || typeof acknowledgement !== "object" || !("acknowledgeLimitations" in acknowledgement)
            || acknowledgement.acknowledgeLimitations !== true) throw new HttpError(400, "Review the report and explicitly acknowledge its limitations");
          if (!report) throw new HttpError(404, "Report not found");
          const readiness = assessReadiness(report.result.investigation);
          if (!readiness.readyForReview) return json(res, 409, { error: "Report is not ready for publication", issues: readiness.issues });
          return json(res, 200, store.publish(report.id));
        }
        if (req.method === "GET" && !reportRoute[3]) {
          if (reportRoute[1]) admin(req);
          if (!report || (!reportRoute[1] && !report.publishedAt)) throw new HttpError(404, "Report not found");
          return json(res, 200, report);
        }
      }
      if (url.pathname.startsWith("/api/")) throw new HttpError(404, "Endpoint not found");
      if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "Method not allowed");
      const assets: Record<string, string> = { "/": "index.html", "/index.html": "index.html", "/app.js": "app.js", "/chat-steps.js": "chat-steps.js", "/styles.css": "styles.css", "/personal.css": "personal.css", "/report.js": "report.js", "/report-map.js": "report-map.js", "/report-inventory.js": "report-inventory.js", "/mascot.svg": "mascot.svg", "/settings": "configuration.html", "/settings/": "configuration.html", "/configuration": "configuration.html", "/configuration/": "configuration.html", "/configuration.js": "configuration.js", "/sidebar.js": "sidebar.js" };
      assets["/chat-ui.js"] = "chat-ui.js";
      assets["/report-verdict.js"] = "report-verdict.js";
      const filename = assets[url.pathname] ?? (/^\/(token|report)\//.test(url.pathname) ? "index.html" : undefined);
      if (!filename) throw new HttpError(404, "Page not found");
      let content: Buffer;
      try { content = await readFile(resolve(config.publicDir, filename)); } catch { throw new HttpError(404, "Page not found"); }
      const mime = filename.endsWith(".svg") ? "image/svg+xml" : filename.endsWith(".css") ? "text/css" : filename.endsWith(".js") ? "text/javascript" : "text/html";
      res.writeHead(200, { "Content-Type": `${mime}; charset=utf-8`, "Cache-Control": "no-cache" });
      res.end(req.method === "HEAD" ? undefined : content);
    } catch (error) {
      if (!res.headersSent) json(res, (error instanceof HttpError || error instanceof ScopeError) ? error.status : 500, { error: (error instanceof HttpError || error instanceof ScopeError) ? error.message : "Request could not be completed" });
      else res.end();
    }
  });
  if (!runtime) server.on("close", personal.stop);
  server.requestTimeout = 20_000; server.headersTimeout = 10_000;
  queue.kick();
  return { server, queue };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const localMode = process.env.LOCAL_MODE !== "false";
  const port = Number(process.env.PORT ?? 3000);
  const origin = process.env.APP_ORIGIN ?? `http://127.0.0.1:${port}`;
  const adminToken = process.env.ADMIN_TOKEN ?? "";
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be 1 to 65535");
  if (!localMode && adminToken.length < 24) throw new Error("Set ADMIN_TOKEN to at least 24 random characters");
  if (!localMode && (!process.env.APP_ORIGIN || new URL(origin).protocol !== "https:")) throw new Error("Production requires an HTTPS APP_ORIGIN");
  const { runInvestigation, isPiConfigured } = await import("./engine.ts");
  const store = new Store(process.env.DATABASE_PATH ?? "data/mydevsaid.sqlite");
  const payments = process.env.STRIPE_SECRET_KEY && process.env.STRIPE_WEBHOOK_SECRET
    ? stripePayments(process.env.STRIPE_SECRET_KEY, process.env.STRIPE_WEBHOOK_SECRET, new URL(origin).origin) : undefined;
  const app = createApp({ localMode, origin, adminToken, modelEnabled: isPiConfigured(),
    trustedProxyIps: (process.env.TRUST_PROXY_IPS ?? "").split(",").map((ip) => ip.trim()).filter(Boolean),
    publicDir: fileURLToPath(new URL("../public/", import.meta.url)) }, store, runInvestigation, payments);
  const monitoring = startMonitoring(store, app.queue, (process.env.MONITOR_REPORT_IDS ?? "").split(",").map((id) => id.trim()).filter(Boolean), Number(process.env.MONITOR_INTERVAL_HOURS ?? 24));
  app.server.listen(port, localMode ? "127.0.0.1" : process.env.HOST ?? "0.0.0.0", () => {
    process.stdout.write(`mydevsaid listening on ${origin}${localMode ? " (personal workspace)" : ""}\n`);
  });
  let stopping = false;
  const stop = () => { if (stopping) return; stopping = true; monitoring.stop(); app.server.close(() => { void app.queue.stop().then(() => store.close()); }); };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
}
