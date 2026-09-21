import { createHash } from "node:crypto";
import type { Investigation } from "./investigation.ts";
import type { Store } from "./store.ts";
import type { JobQueue } from "./jobs.ts";

type Change = { label: string; before: string; after: string };
function facts(report: Investigation): Map<string, string> {
  const values = new Map<string, string>();
  for (const check of report.checks) values.set(`Coverage: ${check.area}`, check.status);
  const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  for (const item of report.evidence) {
    if (item.role !== "observation") continue;
    let data: Record<string, unknown>;
    try { data = JSON.parse(item.content) as Record<string, unknown>; if (!data || typeof data !== "object") continue; } catch { continue; }
    const key = `${item.medium}: ${item.sourceUrl}`;
    if (item.medium === "repository") values.set(key, item.revision ?? "unknown");
    if (item.medium === "onchain") {
      for (const field of ["implementation", "ownerCandidate", "adminCandidate"])
        if (field in data) values.set(`${key} / ${field}`, String(data[field] ?? "none observed"));
      for (const field of ["bytecode", "implementationCode"])
        if (field in data) values.set(`${key} / ${field}`, data[field] ? digest(data[field]) : "unavailable");
    }
    if (item.medium === "domain") values.set(key, digest(data));
    if (item.medium === "website" && Array.isArray(data.pages)) {
      const urls = data.pages.flatMap((page: { links?: { url: string }[] }) => page.links?.map((link) => link.url) ?? []);
      values.set(`${key} / discovered links`, [...new Set(urls)].sort().join("\n"));
    }
    if (item.medium === "api" && "response" in data) {
      const response = data.response;
      const shape = response === null ? "null" : Array.isArray(response) ? "array" : typeof response === "object" ? Object.keys(response as object).sort().join(", ") : typeof response;
      values.set(`${key} / top-level response shape`, `${data.status}: ${shape}`);
    }
  }
  return values;
}

/** Compares selected stable observations; it does not infer behavior from changed hashes. */
export function compareInvestigations(before: Investigation, after: Investigation): Change[] {
  if (JSON.stringify(before.subject.token) !== JSON.stringify(after.subject.token)) throw new Error("Cannot compare different tokens");
  // Source URLs can include pinned repository revisions: normalize those before matching.
  const normalize = (source: Map<string, string>) => new Map([...source].map(([key, value]) => [key.replace(/\/tree\/[a-f0-9]{40}/gi, "/tree/[revision]").replace(/\/blob\/[a-f0-9]{40}/gi, "/blob/[revision]"), value]));
  const previous = normalize(facts(before)), current = normalize(facts(after));
  const changes: Change[] = [];
  for (const key of new Set([...previous.keys(), ...current.keys()])) {
    const old = previous.get(key) ?? "Not observed", next = current.get(key) ?? "Not observed";
    if (old !== next) changes.push({ label: key, before: old.slice(0, 2_000), after: next.slice(0, 2_000) });
  }
  return changes.slice(0, 100);
}

/** Opt-in monitoring runs inside the single server process and preserves a durable schedule. */
export function startMonitoring(store: Store, queue: Pick<JobQueue, "kick">, reportIds: string[], intervalHours = 24, now: () => number = Date.now) {
  if (!Number.isFinite(intervalHours) || intervalHours < 1 || intervalHours > 720) throw new Error("Monitoring interval must be 1 to 720 hours");
  if (reportIds.length > 20 || reportIds.some((id) => !/^[a-zA-Z0-9-]{1,100}$/.test(id))) throw new Error("Monitoring accepts at most 20 published report IDs");
  const interval = intervalHours * 3_600_000;
  store.db.exec("CREATE TABLE IF NOT EXISTS monitoring (report_id TEXT PRIMARY KEY, next_at INTEGER NOT NULL, order_id TEXT)");
  for (const id of new Set(reportIds)) {
    const report = store.getReport(id);
    if (!report?.publishedAt) throw new Error(`Monitoring requires a published report: ${id}`);
    store.db.prepare("INSERT OR IGNORE INTO monitoring VALUES (?,?,NULL)").run(id, now() + interval);
  }
  const tick = () => {
    for (const id of new Set(reportIds)) {
      const row = store.db.prepare("SELECT next_at,order_id FROM monitoring WHERE report_id=?").get(id);
      if (!row || Number(row.next_at) > now()) continue;
      const prior = row.order_id ? store.getOrder(String(row.order_id)) : undefined;
      // Do not accumulate unreviewed drafts or overlap a running observation.
      if (prior && ["queued", "running", "review"].includes(prior.status)) continue;
      const report = store.getReport(id);
      if (!report?.publishedAt) continue;
      store.db.exec("BEGIN IMMEDIATE");
      try {
        const { order } = store.createOrder(report.result.investigation.subject, true);
        order.progress.push(`Scheduled observation of published report ${id}; administrator sponsored`);
        store.saveOrder(order);
        store.db.prepare("UPDATE monitoring SET next_at=?,order_id=? WHERE report_id=?").run(now() + interval, order.id, id);
        store.db.exec("COMMIT");
      } catch (error) { store.db.exec("ROLLBACK"); throw error; }
      queue.kick();
    }
  };
  const timer = setInterval(() => { try { tick(); } catch { process.stderr.write("Scheduled observation failed; inspect monitoring configuration and database.\n"); } }, 60_000);
  timer.unref();
  return { tick, stop: () => clearInterval(timer) };
}
