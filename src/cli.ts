import { spawn } from "node:child_process";
import { createServer as createProbe } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { createHarness } from "./harness.ts";
import { createApp } from "./server.ts";

/** A service launcher, not a terminal chat interface. */
export async function launch(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: {
    headless: { type: "boolean", default: false },
    port: { type: "string" }, database: { type: "string" },
    help: { type: "boolean", short: "h" },
  } });
  if (values.help) {
    process.stdout.write(`mydevsaid - local investigation harness\n\nUsage: npm start -- [options]\n\n  --headless          Run the service without opening a browser\n  --port <number>     Local API/UI port (default: PORT or 3000)\n  --database <path>   Saved workspace (default: DATABASE_PATH or data/mydevsaid.sqlite)\n  --help              Show this help\n\nThe UI and API share one runtime. Closing the browser does not stop jobs.\nHeadless clients use POST /api/chats and GET /api/chats/:id.\nStop the service with SIGINT or SIGTERM; active work drains before shutdown.\n`);
    return;
  }
  if (process.env.LOCAL_MODE === "false") throw new Error("This launcher is for a local personal harness. Use npm run serve for the hosted server.");
  const port = Number(values.port ?? process.env.PORT ?? 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Port must be 1 to 65535");
  // Reject an occupied listener before touching the saved queue's restart state.
  const probe = createProbe();
  await new Promise<void>((resolve, reject) => { probe.once("error", reject); probe.listen(port, "127.0.0.1", resolve); });
  await new Promise<void>((resolve, reject) => probe.close(error => error ? reject(error) : resolve()));
  const harness = createHarness({
    ...(values.database ? { databasePath: values.database } : {}),
    monitorReportIds: (process.env.MONITOR_REPORT_IDS ?? "").split(",").map(id => id.trim()).filter(Boolean),
    monitorIntervalHours: Number(process.env.MONITOR_INTERVAL_HOURS ?? 24),
  });
  const origin = `http://127.0.0.1:${port}`;
  let app: ReturnType<typeof createApp> | undefined;
  let closing: Promise<void> | undefined;
  const close = () => {
    closing ??= (async () => {
      process.off("SIGINT", stop); process.off("SIGTERM", stop);
      try {
        if (app?.server.listening) await new Promise<void>((resolve, reject) => app!.server.close(error => error ? reject(error) : resolve()));
      } finally { await harness.close(); }
    })();
    return closing;
  };
  const stop = () => {
    process.stderr.write("Stopping the harness; waiting for active investigations to finish.\n");
    void close().catch(error => { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; });
  };
  try {
    app = createApp({ localMode: true, origin, adminToken: process.env.ADMIN_TOKEN ?? "", modelEnabled: harness.modelEnabled,
      publicDir: fileURLToPath(new URL("../public/", import.meta.url)) }, harness.store, harness.investigate, undefined, undefined, undefined, harness);
    await new Promise<void>((resolve, reject) => { app!.server.once("error", reject); app!.server.listen(port, "127.0.0.1", resolve); });
    process.on("SIGINT", stop); process.on("SIGTERM", stop);
    process.stdout.write(`mydevsaid harness running at ${origin}\n${harness.modelEnabled ? "Pi explanations enabled." : "Collector checks enabled; Pi explanations are not configured."}\n`);
    if (!values.headless) {
      const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32.exe" : "xdg-open";
      const openArgs = process.platform === "win32" ? ["url.dll,FileProtocolHandler", origin] : [origin];
      const child = spawn(command, openArgs, { stdio: "ignore" });
      child.once("error", () => process.stderr.write(`Open the UI at ${origin}\n`));
      child.once("exit", code => { if (code) process.stderr.write(`Open the UI at ${origin}\n`); });
      child.unref();
    }
    return { ...harness, server: app.server, origin, close };
  } catch (error) { await close(); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await launch(); }
  catch (error) { process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`); process.exitCode = 1; }
}
