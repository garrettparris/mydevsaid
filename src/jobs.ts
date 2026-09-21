import type { AnalysisResult, InvestigationProgress } from "./engine.ts";
import { Store } from "./store.ts";

export type Investigator = (input: unknown, onProgress?: InvestigationProgress) => Promise<AnalysisResult>;
export class JobQueue {
  private active = 0;
  private stopped = false;
  private readonly pending = new Set<Promise<void>>();
  private readonly store: Store;
  private readonly investigate: Investigator;
  private readonly concurrency: number;
  constructor(store: Store, investigate: Investigator, concurrency = 1) {
    this.store = store; this.investigate = investigate; this.concurrency = concurrency;
    if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4) throw new Error("Job concurrency must be 1 to 4");
    for (const order of store.orders()) {
      if (order.status === "running") {
        order.status = "failed"; order.error = "Investigation interrupted by a server restart. An administrator can retry it.";
        store.saveOrder(order);
      }
    }
  }
  kick() {
    if (this.stopped) return;
    for (const order of this.store.orders()) {
      if (this.active >= this.concurrency) break;
      if (order.status !== "queued" || !["paid", "local_preview"].includes(order.payment)) continue;
      this.store.clearLiveReport(order.id);
      order.liveVersion = (order.liveVersion ?? 0) + 1;
      order.status = "running"; order.error = null; this.store.saveOrder(order); this.active++;
      const task = this.run(order.id);
      this.pending.add(task);
      void task.finally(() => { this.pending.delete(task); this.active--; this.kick(); });
    }
  }
  private async run(id: string) {
    let acceptingProgress = true;
    try {
      const result = await this.investigate(this.store.getOrder(id)!.submission, (message, live) => {
        if (!acceptingProgress || this.store.getOrder(id)?.status !== "running") return;
        if (live) this.store.saveLiveReport(id, live);
        const order = this.store.getOrder(id)!;
        const text = message.slice(0, 500);
        if (order.progress.at(-1) !== text) order.progress = [...order.progress, text].slice(-100);
        this.store.saveOrder(order);
      });
      acceptingProgress = false;
      this.store.saveResult(id, result);
    } catch {
      const order = this.store.getOrder(id)!;
      order.status = "failed"; order.error = "Investigation failed. An administrator can inspect the configuration and retry.";
      this.store.saveOrder(order);
    } finally { acceptingProgress = false; }
  }
  retry(id: string) {
    const order = this.store.getOrder(id);
    if (!order || order.status !== "failed" || order.payment === "pending") throw new Error("Only funded, failed investigations can be retried");
    order.status = "queued"; order.error = null; this.store.saveOrder(order); this.kick();
  }
  async idle() { while (this.pending.size) await Promise.all([...this.pending]); }
  async stop() { this.stopped = true; await this.idle(); }
}
