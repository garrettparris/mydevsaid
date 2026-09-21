import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AnalysisResult, LiveReport } from "./engine.ts";
import { assessReadiness, investigationSchema, submissionSchema } from "./investigation.ts";
import { advanceScope, createScope, ScopeError, type Scope } from "./scoping.ts";
import { compareInvestigations } from "./monitor.ts";
import { scopeDiscoverySchema, type ScopeDiscovery } from "./scope-discovery.ts";

export type OrderStatus = "awaiting_payment" | "queued" | "running" | "review" | "published" | "failed";
export class CheckoutReviewRequired extends Error {}
type ReportSummary = { text: string; sources: number; findings: number; generatedAt: string };
const summarizeResult = (result: AnalysisResult): ReportSummary => ({
  text: result.presentation?.overview.text ?? result.summary.explanation,
  sources: result.investigation.evidence.length, findings: result.investigation.findings.length, generatedAt: result.generatedAt,
});
export type Order = {
  id: string; accessHash: string; submission: ReturnType<typeof submissionSchema.parse>;
  status: OrderStatus; payment: "pending" | "paid" | "local_preview"; checkoutId: string | null;
  scope?: Scope; checkoutUrl?: string;
  checkoutGeneration?: number; checkoutAttemptStartedAt?: string; previousCheckoutIds?: string[];
  createdAt: string; updatedAt: string; progress: string[]; reportId: string | null; error: string | null;
  liveVersion?: number; reportSummary?: ReportSummary;
};
export type Report = { id: string; orderId: string; version: number; createdAt: string; publishedAt: string | null; result: AnalysisResult;
  changes?: { previousReportId: string; items: ReturnType<typeof compareInvestigations> } };
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export function secretMatches(value: string, expectedHash: string): boolean {
  const actual = Buffer.from(hash(value));
  const expected = Buffer.from(expectedHash);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export class Store {
  readonly db: DatabaseSync;
  constructor(filename: string) {
    if (filename !== ":memory:") mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS scopes (id TEXT PRIMARY KEY, access_hash TEXT NOT NULL, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS live_reports (id TEXT PRIMARY KEY, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reports (id TEXT PRIMARY KEY, chain INTEGER, address TEXT, published_at TEXT, body TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS payment_events (id TEXT PRIMARY KEY);
      CREATE INDEX IF NOT EXISTS token_reports ON reports(chain,address,published_at);`);
  }
  close() { this.db.close(); }
  getOrder(id: string): Order | undefined {
    const row = this.db.prepare("SELECT body FROM orders WHERE id=?").get(id);
    return row ? JSON.parse(String(row.body)) as Order : undefined;
  }
  orders(): Order[] {
    return this.db.prepare("SELECT body FROM orders ORDER BY rowid").all().map((row) => JSON.parse(String(row.body)) as Order);
  }
  getLiveReport(id: string): LiveReport | undefined {
    const row = this.db.prepare("SELECT body FROM live_reports WHERE id=?").get(id);
    return row ? JSON.parse(String(row.body)) as LiveReport : undefined;
  }
  saveLiveReport(id: string, live: LiveReport) {
    const order = this.getOrder(id);
    if (!order || order.status !== "running") return;
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO live_reports VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body").run(id, JSON.stringify(live));
      order.liveVersion = (order.liveVersion ?? 0) + 1; this.saveOrder(order);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  clearLiveReport(id: string) { this.db.prepare("DELETE FROM live_reports WHERE id=?").run(id); }
  getReportSummary(id: string): ReportSummary | undefined {
    const order = this.getOrder(id);
    if (!order?.reportId) return;
    if (!order.reportSummary) {
      const report = this.getReport(order.reportId);
      if (!report) return;
      order.reportSummary = summarizeResult(report.result); this.saveOrder(order);
    }
    return order.reportSummary;
  }
  saveOrder(order: Order) {
    const existing = this.getOrder(order.id);
    if (existing?.scope && (JSON.stringify(existing.scope) !== JSON.stringify(order.scope)
      || JSON.stringify(existing.submission) !== JSON.stringify(order.submission))) throw new Error("An order's paid scope cannot change");
    order.updatedAt = new Date().toISOString();
    this.db.prepare("INSERT INTO orders VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body").run(order.id, JSON.stringify(order));
  }
  createOrder(input: unknown, localMode: boolean) {
    const accessToken = randomBytes(32).toString("base64url");
    const now = new Date().toISOString();
    const order: Order = { id: randomUUID(), accessHash: hash(accessToken), submission: submissionSchema.parse(input),
      status: localMode ? "queued" : "awaiting_payment", payment: localMode ? "local_preview" : "pending",
      checkoutId: null, createdAt: now, updatedAt: now, progress: [], reportId: null, error: null };
    this.saveOrder(order);
    return { order, accessToken };
  }
  reserveCheckout(id: string, expiredId?: string): Order | null {
    const order = this.getOrder(id);
    if (!order || order.payment !== "pending") return null;
    if (expiredId) {
      if (order.checkoutId !== expiredId) return null;
      if ((order.checkoutGeneration ?? 0) >= 8) throw new CheckoutReviewRequired("This order has reached its checkout recovery limit. Contact support for review before paying.");
      order.previousCheckoutIds = [...new Set([...(order.previousCheckoutIds ?? []), expiredId])].slice(-8);
      order.checkoutGeneration = (order.checkoutGeneration ?? 0) + 1;
      order.checkoutId = null; delete order.checkoutUrl;
      order.checkoutAttemptStartedAt = new Date().toISOString();
    } else {
      if (order.checkoutId) return null;
      if (Date.now() - Date.parse(order.checkoutAttemptStartedAt ?? order.createdAt) >= 23 * 3_600_000) throw new CheckoutReviewRequired("This checkout could not be confirmed within its retry window. Contact support for review before paying.");
      order.checkoutGeneration ??= 0; order.checkoutAttemptStartedAt ??= order.createdAt;
    }
    this.saveOrder(order); return order;
  }
  recordCheckout(id: string, generation: number, checkout: { id: string; url: string }) {
    const order = this.getOrder(id);
    if (!order || order.payment !== "pending" || (order.checkoutGeneration ?? 0) !== generation) return;
    if (order.previousCheckoutIds?.includes(checkout.id)) throw new Error("Replacement checkout reused an expired session");
    if (order.checkoutId && order.checkoutId !== checkout.id) throw new Error("Checkout changed during recovery");
    order.checkoutId = checkout.id; order.checkoutUrl = checkout.url; order.error = null; order.status = "awaiting_payment";
    this.saveOrder(order);
  }
  withholdCheckout(id: string) {
    const order = this.getOrder(id);
    if (!order || order.payment !== "pending") return;
    delete order.checkoutUrl; order.error = null; order.status = "awaiting_payment";
    this.saveOrder(order);
  }
  createScope(message: unknown) {
    const scope = createScope(message), accessToken = randomBytes(32).toString("base64url");
    this.db.prepare("INSERT INTO scopes VALUES (?,?,?)").run(scope.id, hash(accessToken), JSON.stringify(scope));
    return { scope, accessToken };
  }
  getScope(id: string, accessToken: string): Scope {
    const row = this.db.prepare("SELECT access_hash,body FROM scopes WHERE id=?").get(id);
    if (!row || !secretMatches(accessToken, String(row.access_hash))) throw new ScopeError(401, "Conversation access token required");
    const scope = JSON.parse(String(row.body)) as Scope;
    if (scope.preview?.status === "running" && !(Date.now() - Date.parse(scope.preview.startedAt) < 30_000)) {
      scope.preview = { ...scope.preview, status: "failed", error: "The free lookup was interrupted. Its page budget is used; you can still supply links and a token manually." };
      scope.revision++;
      this.db.prepare("UPDATE scopes SET body=? WHERE id=?").run(JSON.stringify(scope), id);
    }
    return scope;
  }
  updateScope(id: string, accessToken: string, message: unknown, revision: unknown): Scope {
    const scope = advanceScope(this.getScope(id, accessToken), message, revision);
    this.db.prepare("UPDATE scopes SET body=? WHERE id=?").run(JSON.stringify(scope), id);
    return scope;
  }
  reserveScopeDiscovery(id: string, accessToken: string, revision: unknown) {
    const scope = this.getScope(id, accessToken);
    if (scope.status === "locked") throw new ScopeError(409, "This scope is fixed to an order; free discovery cannot change it");
    if (scope.preview) return { scope, reserved: false };
    if (scope.revision !== revision) throw new ScopeError(409, "This conversation changed. Reload before looking up its links.");
    if (!scope.submission.links.length) throw new ScopeError(400, "Add a project link before the free lookup");
    scope.preview = { status: "running", startedAt: new Date().toISOString(), seedLinks: scope.submission.links.slice(0, 2) };
    scope.revision++;
    this.db.prepare("UPDATE scopes SET body=? WHERE id=?").run(JSON.stringify(scope), id);
    return { scope, reserved: true };
  }
  finishScopeDiscovery(id: string, accessToken: string, revision: number, result?: ScopeDiscovery) {
    const scope = this.getScope(id, accessToken);
    if (scope.status === "locked" || scope.revision !== revision || scope.preview?.status !== "running") return scope;
    scope.preview = result ? { ...scope.preview, status: "complete", result: scopeDiscoverySchema.parse(result) }
      : { ...scope.preview, status: "failed", error: "The free lookup could not finish. Its page budget is used; continue by supplying links and the token manually." };
    scope.revision++;
    this.db.prepare("UPDATE scopes SET body=? WHERE id=?").run(JSON.stringify(scope), id);
    return scope;
  }
  scopeOrderToken(scopeToken: string, orderId: string) { return hash(`scope-order:${scopeToken}:${orderId}`); }
  lockScope(id: string, scopeToken: string, revision: unknown, localMode: boolean) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const scope = this.getScope(id, scopeToken);
      if (revision !== scope.revision) throw new ScopeError(409, "This scope changed. Review its current version before checkout.");
      if (scope.orderId) {
        const order = this.getOrder(scope.orderId)!;
        this.db.exec("COMMIT");
        return { order, accessToken: this.scopeOrderToken(scopeToken, order.id) };
      }
      if (scope.preview?.status === "running") throw new ScopeError(409, "Wait for the free website lookup before reviewing checkout");
      if (scope.status !== "ready") throw new ScopeError(409, "Complete the scope before checkout");
      const created = this.createOrder(scope.submission, localMode);
      const accessToken = this.scopeOrderToken(scopeToken, created.order.id);
      created.order.accessHash = hash(accessToken);
      created.order.scope = structuredClone(scope);
      this.saveOrder(created.order);
      scope.status = "locked"; scope.orderId = created.order.id;
      this.db.prepare("UPDATE scopes SET body=? WHERE id=?").run(JSON.stringify(scope), id);
      this.db.exec("COMMIT");
      return { order: created.order, accessToken };
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  acceptPayment(eventId: string, orderId: string, checkoutId: string): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (this.db.prepare("SELECT id FROM payment_events WHERE id=?").get(eventId)) { this.db.exec("COMMIT"); return false; }
      const order = this.getOrder(orderId);
      if (!order || (order.checkoutId !== checkoutId && !order.previousCheckoutIds?.includes(checkoutId)) || order.payment === "local_preview") throw new Error("Payment does not match an order");
      this.db.prepare("INSERT INTO payment_events VALUES (?)").run(eventId);
      const accepted = order.payment === "pending";
      if (accepted) { order.payment = "paid"; order.status = "queued"; delete order.checkoutUrl; this.saveOrder(order); }
      this.db.exec("COMMIT");
      return accepted;
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  getReport(id: string): Report | undefined {
    const row = this.db.prepare("SELECT body FROM reports WHERE id=?").get(id);
    return row ? JSON.parse(String(row.body)) as Report : undefined;
  }
  saveResult(orderId: string, result: AnalysisResult): Report {
    const order = this.getOrder(orderId);
    if (!order || order.status !== "running") throw new Error("Order is not running");
    investigationSchema.parse(result.investigation);
    if (JSON.stringify(order.submission) !== JSON.stringify(result.investigation.subject)) throw new Error("Result subject does not match the order");
    const token = result.investigation.subject.token;
    const previous = token ? this.db.prepare("SELECT COUNT(*) AS count FROM reports WHERE chain=? AND address=?").get(token.chainId, token.address) : undefined;
    const report: Report = { id: randomUUID(), orderId, version: Number(previous?.count ?? 0) + 1,
      createdAt: new Date().toISOString(), publishedAt: null, result };
    const baseline = token ? this.published("", token)[0] : undefined;
    if (baseline) report.changes = { previousReportId: baseline.id, items: compareInvestigations(baseline.result.investigation, result.investigation) };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO reports VALUES (?,?,?,?,?)").run(report.id, token?.chainId ?? null, token?.address ?? null, null, JSON.stringify(report));
      order.reportId = report.id; order.status = "review"; order.progress.push("Investigation complete. Awaiting human review.");
      order.reportSummary = summarizeResult(result); this.clearLiveReport(orderId);
      this.saveOrder(order); this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return report;
  }
  publish(id: string): Report {
    const report = this.getReport(id);
    if (!report) throw new Error("Report not found");
    const readiness = assessReadiness(report.result.investigation);
    if (!readiness.readyForReview) throw new Error(`Report is not ready: ${readiness.issues.join("; ")}`);
    if (report.publishedAt) return report;
    report.publishedAt = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("UPDATE reports SET published_at=?,body=? WHERE id=?").run(report.publishedAt, JSON.stringify(report), id);
      const order = this.getOrder(report.orderId)!; order.status = "published"; this.saveOrder(order);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return report;
  }
  published(query = "", token?: { chainId: number; address: string }): Report[] {
    const rows = token
      ? this.db.prepare("SELECT body FROM reports WHERE published_at IS NOT NULL AND chain=? AND address=? ORDER BY published_at DESC LIMIT 100").all(token.chainId, token.address)
      : this.db.prepare("SELECT body FROM reports WHERE published_at IS NOT NULL ORDER BY published_at DESC LIMIT 100").all();
    const reports = rows.map((row) => JSON.parse(String(row.body)) as Report);
    return query ? reports.filter((report) => JSON.stringify(report.result.investigation.subject).toLowerCase().includes(query.toLowerCase())) : reports;
  }
}
