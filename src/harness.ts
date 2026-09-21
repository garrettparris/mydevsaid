import { closeSync, mkdirSync, openSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { runInvestigation, isPiConfigured } from "./engine.ts";
import { JobQueue, type Investigator } from "./jobs.ts";
import { startMonitoring } from "./monitor.ts";
import { createPersonalRouter } from "./personal.ts";
import { Store } from "./store.ts";

export type HarnessOptions = {
  databasePath?: string;
  concurrency?: number;
  investigate?: Investigator;
  modelEnabled?: boolean;
  monitorReportIds?: string[];
  monitorIntervalHours?: number;
};

/** Owns execution and persistence. No HTTP listener or browser is required. */
export function createHarness(options: HarnessOptions = {}) {
  const filename = options.databasePath ?? process.env.DATABASE_PATH ?? "data/mydevsaid.sqlite";
  const lockPath = filename === ":memory:" ? undefined : `${resolve(filename)}.harness-lock`;
  let release = () => {};
  if (lockPath) {
    mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
    let fd: number;
    try { fd = openSync(lockPath, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Workspace is already locked: ${lockPath}. Stop its harness first. After a crash, confirm the recorded PID is no longer running before removing this lock.`);
      throw error;
    }
    try { writeFileSync(fd, `${process.pid}\n`); }
    catch (error) { unlinkSync(lockPath); throw error; }
    finally { closeSync(fd); }
    release = () => unlinkSync(lockPath);
  }
  let store: Store;
  try { store = new Store(filename); }
  catch (error) { release(); throw error; }
  const investigate = options.investigate ?? runInvestigation;
  const modelEnabled = options.modelEnabled ?? isPiConfigured();
  let workspace: ReturnType<typeof createPersonalRouter> | undefined;
  let monitoring: ReturnType<typeof startMonitoring> | undefined;
  try {
    const queue = new JobQueue(store, investigate, options.concurrency ?? 1);
    workspace = createPersonalRouter(store, queue, true);
    monitoring = startMonitoring(store, queue, options.monitorReportIds ?? [], options.monitorIntervalHours ?? 24);
    queue.kick();
    let closing: Promise<void> | undefined;
    const ownedWorkspace = workspace, ownedMonitoring = monitoring;
    return {
      store, queue, workspace: ownedWorkspace, investigate, modelEnabled,
      close() {
        closing ??= (async () => {
          ownedMonitoring.stop(); ownedWorkspace.stop();
          try { await queue.stop(); }
          finally { store.close(); release(); }
        })();
        return closing;
      },
    };
  } catch (error) {
    monitoring?.stop(); workspace?.stop(); store.close(); release(); throw error;
  }
}
