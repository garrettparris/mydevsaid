import { createHash, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { answerReport, mergeIntake, type IntakeSubmission } from "./personal-intake.ts";
import { ScopeError } from "./scoping.ts";
import type { JobQueue } from "./jobs.ts";
import type { Store } from "./store.ts";

type Message = { id: string; role: "user" | "assistant"; content: string; evidenceIds?: string[]; reportId?: string };
type Run = { id: string; afterMessageId: string; announced: boolean };
type Chat = { id: string; title: string; revision: number; messages: Message[]; submission: IntakeSubmission;
  questions: string[]; detected: ReturnType<typeof mergeIntake>["detected"]; runs: Run[]; pendingAfterMessageId?: string; updatedAt: string };
type ReadInput = (req: IncomingMessage) => Promise<unknown>;
type SendJson = (res: ServerResponse, status: number, value: unknown) => void;
const active = (status: string) => status === "queued" || status === "running";

export function createPersonalRouter(store: Store, queue: JobQueue, enabled: boolean) {
  if (enabled) store.db.exec(`CREATE TABLE IF NOT EXISTS personal_chats (id TEXT PRIMARY KEY, body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS personal_requests (id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, fingerprint TEXT NOT NULL);`);
  const save = (chat: Chat) => {
    chat.updatedAt = new Date().toISOString();
    store.db.prepare("INSERT INTO personal_chats VALUES (?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body").run(chat.id, JSON.stringify(chat));
  };
  const get = (id: string): Chat => {
    const row = store.db.prepare("SELECT body FROM personal_chats WHERE id=?").get(id);
    if (!row) throw new ScopeError(404, "Conversation not found");
    return JSON.parse(String(row.body)) as Chat;
  };
  const all = () => store.db.prepare("SELECT body FROM personal_chats ORDER BY rowid DESC").all().map((row) => JSON.parse(String(row.body)) as Chat);
  const transaction = <T>(work: () => T): T => {
    store.db.exec("BEGIN IMMEDIATE");
    try { const result = work(); store.db.exec("COMMIT"); return result; }
    catch (error) { store.db.exec("ROLLBACK"); throw error; }
  };
  const say = (chat: Chat, content: string, extra: Partial<Message> = {}) => {
    chat.messages.push({ id: randomUUID(), role: "assistant", content, ...extra });
  };
  const start = (chat: Chat, afterMessageId: string) => {
    if (chat.runs.length >= 50 || store.orders().filter((order) => active(order.status)).length >= 100) {
      throw new ScopeError(429, "Investigation limit reached. Wait for current work or start a new conversation if this one has 50 runs.");
    }
    const { order } = store.createOrder(chat.submission, true);
    chat.runs.push({ id: order.id, afterMessageId, announced: false });
    delete chat.pendingAfterMessageId;
  };
  const synchronize = (chat: Chat) => {
    let changed = false;
    for (const run of chat.runs) {
      const order = store.getOrder(run.id)!;
      if (run.announced || active(order.status)) continue;
      if (order.reportId) {
        const result = store.getReport(order.reportId)!.result;
        const candidates = result.discovery.pages.flatMap((page) => page.addresses).filter((item) => item.chainId && [1, 8453, 4663].includes(item.chainId)).slice(0, 3);
        const question = chat.questions[0] ?? (!chat.submission.token && candidates.length
          ? `Which is the primary token to check: ${candidates.map((item) => `${item.address} (chain ${item.chainId}, ${new URL(item.sourceUrl).hostname})`).join(", ")}? These are page mentions, not confirmed identities.`
          : result.investigation.checks.some((check) => check.area === "public_code" && check.status === "blocked")
            ? "Do you have a public GitHub repository link for the code checks?" : undefined);
        if (!chat.pendingAfterMessageId) chat.questions = question ? [question] : [];
        say(chat, `The report is ready.${question && !chat.pendingAfterMessageId ? ` ${question}` : ""}`, { reportId: order.reportId });
      } else say(chat, "This investigation could not finish. You can retry it from this conversation.");
      run.announced = true; changed = true;
    }
    if (chat.pendingAfterMessageId && !chat.runs.some((run) => active(store.getOrder(run.id)!.status))) {
      const previous = chat.runs.at(-1);
      if (chat.submission.links.length && JSON.stringify(chat.submission) !== JSON.stringify(previous && store.getOrder(previous.id)!.submission)) {
        if (chat.runs.length >= 50) {
          say(chat, "This conversation reached 50 investigations. Start a new conversation to check the updated inputs.");
          delete chat.pendingAfterMessageId;
        } else if (store.orders().filter((order) => active(order.status)).length < 100) start(chat, chat.pendingAfterMessageId);
      } else delete chat.pendingAfterMessageId;
      changed = true;
    }
    if (changed) save(chat);
  };
  const refresh = () => {
    if (!enabled) return;
    transaction(() => { for (const chat of all()) synchronize(chat); });
    queue.kick();
  };
  const chatStatus = (chat: Chat) => {
    const orders = chat.runs.map((run) => store.getOrder(run.id)!);
    return orders.some((order) => active(order.status)) || chat.pendingAfterMessageId ? "running"
      : orders.at(-1)?.status === "failed" ? "failed" : orders.some((order) => order.reportId) ? "ready" : "waiting";
  };
  const view = (chat: Chat, compact = false, knownLive = new Map<string, number>()) => {
    const runs = chat.runs.map((run) => {
      const order = store.getOrder(run.id)!, report = !compact && order.reportId ? store.getReport(order.reportId) : undefined;
      const liveVersion = order.liveVersion ?? 0;
      const live = order.reportId || !liveVersion ? { live: null }
        : knownLive.get(run.id) === liveVersion ? {} : { live: store.getLiveReport(run.id) ?? null };
      return { id: run.id, afterMessageId: run.afterMessageId, status: order.status === "review" || order.status === "published" ? "completed" : order.status,
        progress: order.progress, error: order.error ? "This investigation could not finish. Retry it to try again." : null,
        reportId: order.reportId, createdAt: order.createdAt, liveVersion, ...live,
        ...(compact && order.reportId ? { summary: store.getReportSummary(run.id) } : {}), ...(report ? { result: report.result } : {}) };
    });
    const { pendingAfterMessageId: _pending, ...visible } = chat;
    return { ...visible, runs, status: chatStatus(chat) };
  };
  const respond = (chat: Chat, message: string) => {
    const merged = mergeIntake(chat.submission, chat.messages.filter((item) => item.role === "user").map((item) => item.content), message);
    const user: Message = { id: randomUUID(), role: "user", content: message };
    chat.messages.push(user); chat.revision++;
    chat.submission = merged.submission; chat.questions = merged.questions; chat.detected = merged.detected;
    if (merged.changed && chat.submission.links.length) {
      if (chat.runs.some((run) => active(store.getOrder(run.id)!.status))) chat.pendingAfterMessageId = user.id;
      else start(chat, user.id);
      say(chat, `${merged.reply} ${chat.pendingAfterMessageId ? "I'll check the updated inputs when the current investigation finishes." : "I've started checking these inputs."}`);
    } else {
      const reportId = [...chat.runs].reverse().map((run) => store.getOrder(run.id)!.reportId).find(Boolean);
      const clarification = merged.questions.length && (merged.detected.addresses.length || merged.detected.chainId !== undefined)
        && !/\?|\b(what|which|where|when|why|how|does|can|explain|summari[sz]e|tell)\b/i.test(message);
      if (reportId && !merged.changed && !clarification) {
        const answer = answerReport(message, store.getReport(reportId)!.result);
        say(chat, answer.text + (merged.questions[0] ? `\n\n${merged.questions[0]}` : ""), { evidenceIds: answer.evidenceIds, reportId });
      } else say(chat, merged.reply);
    }
  };
  const submit = (raw: unknown, id?: string, retry = false) => {
    if (!enabled) throw new ScopeError(404, "Personal conversations are available only in local mode");
    const path = id ? `/api/chats/${id}${retry ? "/retry" : "/messages"}` : "/api/chats";
    refresh();
    if (!raw || typeof raw !== "object") throw new ScopeError(400, "Send a message and request ID");
    const value = raw as Record<string, unknown>;
    if (typeof value.requestId !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(value.requestId)) throw new ScopeError(400, "Send a unique request ID of 8 to 128 letters, numbers, underscores, or hyphens");
    if (!retry && (typeof value.message !== "string" || !value.message.trim() || value.message.length > 20_000)) throw new ScopeError(400, "Send a message of 1 to 20,000 characters");
    const fingerprint = createHash("sha256").update(JSON.stringify([path, value.message ?? null, value.revision ?? null, value.runId ?? null])).digest("hex");
    const chat = transaction(() => {
      const prior = store.db.prepare("SELECT chat_id,fingerprint FROM personal_requests WHERE id=?").get(value.requestId as string);
      if (prior) {
        if (prior.fingerprint !== fingerprint) throw new ScopeError(409, "This request ID was already used for different input");
        return get(String(prior.chat_id));
      }
      const now = new Date().toISOString();
      const chat: Chat = id ? get(id) : { id: randomUUID(), title: String(value.message).trim().slice(0, 80), revision: 0,
        messages: [], submission: { links: [], relatedContractLimit: 4, domainLookup: "registrable_domain" }, questions: [], detected: { links: [], addresses: [] }, runs: [], updatedAt: now };
      if (id && value.revision !== chat.revision) throw new ScopeError(409, "This conversation changed. Reload it before sending another message.");
      if (chat.messages.filter((message) => message.role === "user").length >= 200) throw new ScopeError(409, "Start a new conversation after 200 messages");
      if (retry) {
        const run = chat.runs.at(-1), order = run && store.getOrder(run.id);
        if (!order || order.status !== "failed" || order.payment !== "local_preview" || chat.pendingAfterMessageId
          || (value.runId !== undefined && value.runId !== order.id)) throw new ScopeError(409, "Only this conversation's latest failed investigation can be retried");
        order.status = "queued"; order.error = null; store.saveOrder(order); run!.announced = false; chat.revision++;
        say(chat, "I'm retrying the same investigation inputs.");
      } else respond(chat, (value.message as string).trim());
      save(chat);
      store.db.prepare("INSERT INTO personal_requests VALUES (?,?,?)").run(value.requestId as string, chat.id, fingerprint);
      return chat;
    });
    queue.kick();
    return chat;
  };
  const timer = enabled ? setInterval(() => {
    try { refresh(); } catch { /* A request retries synchronization and reports a safe error. */ }
  }, 500).unref() : undefined;
  return {
    stop() { if (timer) clearInterval(timer); },
    list() { refresh(); return all().map(chat => ({ id: chat.id, title: chat.title, updatedAt: chat.updatedAt, status: chatStatus(chat) })); },
    read(id: string) { refresh(); return view(get(id)); },
    send(value: unknown, id?: string) { return view(submit(value, id)); },
    retry(value: unknown, id: string) { return view(submit(value, id, true)); },
    async handle(req: IncomingMessage, res: ServerResponse, url: URL, input: ReadInput, json: SendJson): Promise<boolean> {
      if (url.pathname !== "/api/chats" && !url.pathname.startsWith("/api/chats/")) return false;
      if (!enabled) throw new ScopeError(404, "Personal conversations are available only in local mode");
      const reportRoute = /^\/api\/chats\/([a-zA-Z0-9-]+)\/runs\/([a-zA-Z0-9-]+)$/.exec(url.pathname);
      if (reportRoute) {
        if (req.method !== "GET") throw new ScopeError(405, "Method not allowed");
        const chat = get(reportRoute[1]!);
        if (!chat.runs.some((run) => run.id === reportRoute[2])) throw new ScopeError(404, "Investigation not found in this conversation");
        const order = store.getOrder(reportRoute[2]!)!;
        if (!order.reportId) throw new ScopeError(409, "The full report is not ready yet");
        const report = store.getReport(order.reportId);
        if (!report) throw new ScopeError(404, "Report not found");
        json(res, 200, { runId: order.id, reportId: report.id, result: report.result }); return true;
      }
      const route = /^\/api\/chats(?:\/([a-zA-Z0-9-]+)(\/(?:messages|retry))?)?$/.exec(url.pathname);
      if (!route) throw new ScopeError(404, "Conversation endpoint not found");
      const compact = url.searchParams.get("compact") === "1", versions = url.searchParams.get("live") ?? "";
      if (versions.length > 4096 || (versions && !/^[a-zA-Z0-9-]+:[0-9]+(?:,[a-zA-Z0-9-]+:[0-9]+){0,49}$/.test(versions))) {
        throw new ScopeError(400, "Send at most 50 investigation IDs and their live versions");
      }
      const knownLive = new Map(versions ? versions.split(",").map((entry) => {
        const [id, version] = entry.split(":"); return [id!, Number(version)] as const;
      }) : []);
      refresh();
      if (req.method === "GET" && !route[2]) {
        if (route[1]) json(res, 200, { chat: view(get(route[1]), compact, knownLive) });
        else json(res, 200, { chats: all().map((chat) => ({ id: chat.id, title: chat.title, updatedAt: chat.updatedAt, status: chatStatus(chat) })) });
        return true;
      }
      if (req.method !== "POST" || (route[1] && !route[2])) throw new ScopeError(405, "Method not allowed");
      const chat = submit(await input(req), route[1], route[2] === "/retry");
      json(res, route[1] ? 200 : 201, { chat: view(chat, compact, knownLive) }); return true;
    },
  };
}
