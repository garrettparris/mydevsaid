import { setupSidebar } from './sidebar.js';
import { createChatSteps } from './chat-steps.js';
import { createDraftPreview, runActivity } from './chat-ui.js';
import { el, chainBadge, tokenBadge, dateText, renderReport } from './report.js';

const $ = id => document.getElementById(id);
const storage = {
  get(key) { try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Server history remains available. */ } },
};
let chat = null, config, saving = false, loading = false, connected = false, timer, viewVersion = 0, historyVersion = 0;
let pending = storage.get('mydevsaid-personal-pending');
const nodes = new Map();
const active = () => chat?.status === 'running' || chat?.runs?.some(run => ['queued', 'running'].includes(run.status));
const draftKey = () => `mydevsaid-chat-draft:${chat?.id || 'new'}`;
const steps = createChatSteps($('chat-decisions'), { storage, send: message => send(message), busy: () => saving || loading || !connected || !config?.personalMode || Boolean(pending) });
const setNavigation = setupSidebar();
const previewDraft = createDraftPreview($('chat-form'));
function newInvestigation() {
  if (saving || loading || pending) return;
  setNavigation(false, false); history.replaceState(null, '', location.pathname); void openChat(null); $('chat-message').focus();
}
function documentIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(svg.namespaceURI, 'path'); path.setAttribute('d', 'M5 3h9l5 5v13H5V3Zm9 0v6h5M8 13h8m-8 4h5'); svg.append(path); return svg;
}

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers }, signal: AbortSignal.timeout(30000) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(data.error || `Request failed (${response.status}).`); error.status = response.status; throw error; }
  return data;
}
function showError(message, retry = false) {
  $('chat-error').textContent = message; $('chat-error').hidden = !message;
  $('retry-send').hidden = !retry; $('reconnect').hidden = !message || retry;
  syncMascot();
}
function syncMascot() {
  const latest = chat?.runs?.at(-1);
  const state = !$('chat-error').hidden ? 'error' : saving || loading || !config ? 'thinking'
    : !connected || latest?.status === 'failed' ? 'error'
    : active() ? latest?.status === 'queued' ? 'thinking' : 'scanning'
    : $('chat-decisions').querySelector('.question-card') ? 'waiting'
    : latest?.status === 'completed' ? 'happy' : 'idle';
  const labels = { idle: 'Ready when you are.', thinking: 'Getting things ready...', scanning: 'Checking the evidence...',
    waiting: 'A detail needs your input.', happy: 'Report ready. Let\'s take a look.', error: 'Something needs attention.' };
  document.querySelectorAll('[data-mascot]').forEach(node => { if (node.dataset.mascot !== state) node.dataset.mascot = state; });
  const status = `mydev: ${labels[state]}`;
  if ($('mascot-status').textContent !== status) $('mascot-status').textContent = status;
}
function controls() {
  previewDraft($('chat-message').value);
  $('chat-message').disabled = loading;
  $('send-message').disabled = saving || loading || !connected || !config?.personalMode || !$('chat-message').value.trim();
  $('send-message').firstChild.textContent = saving ? 'Sending' : 'Send';
  $('new-chat').disabled = saving || loading || Boolean(pending);
  $('mobile-new-chat').disabled = $('new-chat').disabled;
  document.querySelectorAll('[data-prompt]').forEach(button => { button.disabled = saving || loading; });
  $('retry-send').disabled = saving;
  steps.syncControls();
  $('composer-context').textContent = saving ? 'Saving your message...' : active() ? 'Research is running. You can keep adding context.' : chat ? 'Ask a follow-up or add more information' : 'Start with any project link';
  syncMascot();
}
function sourceButton(id, reportId) {
  const evidence = chat?.runs?.find(run => (!reportId || run.reportId === reportId) && run.result?.investigation?.evidence?.some(item => item.id === id))?.result.investigation.evidence.find(item => item.id === id);
  let label = 'View source';
  try { if (evidence?.sourceUrl) label = new URL(evidence.sourceUrl).hostname; } catch { /* Keep the generic label for non-URL evidence. */ }
  const button = el('button', 'text-button', label); button.type = 'button';
  button.setAttribute('aria-label', `View source: ${evidence?.title || label}`);
  button.addEventListener('click', () => {
    const run = chat?.runs?.find(item => (!reportId || item.reportId === reportId) && item.result?.investigation?.evidence?.some(e => e.id === id));
    const card = run && nodes.get(`run:${run.id}`)?.node;
    const attachment = card?.querySelector('.report-attachment');
    if (!attachment) return;
    attachment.open = true;
    const target = [...attachment.querySelectorAll('.evidence-item')].find(item => item.id.endsWith(`-evidence-${id}`));
    if (target) { target.open = true; target.scrollIntoView({ block: 'start' }); target.querySelector('summary')?.focus(); }
  });
  return button;
}
function messageNode(message) {
  const block = el('article', `conversation-message ${message.role === 'user' ? 'user' : 'assistant'}`);
  block.append(el('span', 'author', message.role === 'user' ? 'You' : 'mydev'));
  let text = String(message.content || '');
  if (message.role === 'assistant' && message.id === chat?.messages.filter(item => item.role === 'assistant').at(-1)?.id) {
    for (const question of chat.questions || []) text = text.replace(question, '');
    text = text.replace(/ {2,}/g, ' ').trim();
  }
  if (text.length > 1100 && message.role === 'user') {
    block.append(el('p', '', text.slice(0, 500) + '...'));
    const details = el('details', 'paste-detail'); details.append(el('summary', '', 'Show full message'), el('pre', '', text)); block.append(details);
  } else block.append(el('p', '', text));
  if (message.evidenceIds?.length) { const sources = el('div', 'message-sources'); for (const id of message.evidenceIds) sources.append(sourceButton(id, message.reportId)); block.append(sources); }
  return block;
}
function runNode(run, index) {
  const card = el('article', 'investigation-run'); card.id = `run-${run.id}`; card.dataset.state = run.status;
  const running = ['queued', 'running'].includes(run.status), done = Boolean(run.result);
  const heading = el('div', 'run-heading');
  heading.append(el('h2', '', `Investigation ${index + 1}`), el('span', `run-state ${running ? 'active' : ''}`, done ? 'Report ready' : run.status === 'failed' ? 'Interrupted' : run.status === 'queued' ? 'Queued' : 'Researching'));
  heading.querySelector('h2').prepend(documentIcon());
  const body = el('div', 'run-body');
  if (done) {
    body.append(el('p', '', run.result.presentation?.overview?.text || run.result.summary?.explanation || 'Your evidence report is ready.'));
    const investigation = run.result.investigation;
    const counts = el('div', 'run-counts');
    const date = el('time', '', dateText(run.result.generatedAt)); date.dateTime = run.result.generatedAt;
    counts.append(el('span', '', `${investigation.evidence.length} sources`), el('span', '', `${investigation.findings.length} findings`), date); body.append(counts);
    body.append(runActivity(run));
  } else if (run.status === 'failed') {
    body.append(el('p', '', run.error || 'This investigation stopped before the report was ready. Your information is saved.'));
    const retry = el('button', 'button secondary', 'Retry investigation'); retry.type = 'button';
    retry.addEventListener('click', () => retryRun(run, retry)); if (run.id === chat.runs.at(-1)?.id) body.append(retry);
    body.append(runActivity(run));
  } else body.append(runActivity(run));
  card.append(heading, body);
  if (done) {
    const attachment = el('details', 'report-attachment');
    const summary = el('summary'); const fileIcon = el('span', 'report-file-icon'); fileIcon.append(documentIcon());
    const label = el('div'); label.append(el('span', '', 'Read the report'), el('small', '', 'Findings, explanations, and source evidence'));
    summary.append(fileIcon, label); attachment.append(summary);
    const report = renderReport({ id: run.reportId || run.id, title: chat.title, result: run.result }, { embedded: true, personal: true });
    attachment.append(report); card.append(attachment);
  }
  return card;
}
function scrollLatest() {
  const last = $('chat-decisions').lastElementChild || $('chat-thread').lastElementChild; if (!last) return;
  const viewport = $('workspace-scroll');
  const overlap = last.getBoundingClientRect().bottom - Math.min(viewport.getBoundingClientRect().bottom, $('composer-dock').getBoundingClientRect().top) + 20;
  if (overlap > 0) viewport.scrollTo({ top: viewport.scrollTop + overlap, behavior: 'instant' });
}
function draw() {
  const thread = $('chat-thread'), viewport = $('workspace-scroll');
  const nearBottom = viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 260;
  $('main').classList.toggle('has-conversation', Boolean(chat)); $('chat-welcome').hidden = Boolean(chat);
  $('workspace-title').textContent = chat?.title || 'New investigation';
  document.querySelectorAll('.history-item').forEach(button => button.setAttribute('aria-current', button.dataset.chatId === chat?.id ? 'page' : 'false'));
  $('composer-help').firstChild.textContent = chat ? 'Add context or ask about your report. ' : 'A link is enough to start. ';
  $('connection-state').textContent = !connected ? 'Offline' : active() ? 'Research in progress' : chat ? 'Saved on this computer' : 'Private on this computer';
  $('connection-state').dataset.active = String(Boolean(active()));
  $('chat-message').placeholder = chat ? 'Ask about the report, add a link, or fill in a missing detail...' : 'Paste a website, contract address, or anything you want checked...';
  const ordered = [];
  const add = (key, signature, build) => {
    let cached = nodes.get(key);
    if (!cached || cached.signature !== signature) {
      const node = build();
      for (const selector of ['.report-attachment', '.run-activity']) if (cached?.node.querySelector(`${selector}[open]`)) { const detail = node.querySelector(selector); if (detail) detail.open = true; }
      cached = { signature, node }; nodes.set(key, cached);
    }
    ordered.push(cached.node);
  };
  for (const message of chat?.messages || []) {
    add(`message:${message.id}`, JSON.stringify([message, message.role === 'assistant' ? chat.questions : null]), () => messageNode(message));
    for (const [index, run] of (chat.runs || []).entries()) if (run.afterMessageId === message.id) add(`run:${run.id}`, JSON.stringify([run.status, run.progress, run.error, run.result?.generatedAt]), () => runNode(run, index));
  }
  for (const [index, run] of (chat?.runs || []).entries()) if (!chat.messages.some(message => message.id === run.afterMessageId)) add(`run:${run.id}`, JSON.stringify([run.status, run.progress, run.error, run.result?.generatedAt]), () => runNode(run, index));
  for (const child of [...thread.children]) if (!ordered.includes(child)) child.remove();
  ordered.forEach((node, index) => { if (thread.children[index] !== node) thread.insertBefore(node, thread.children[index] || null); });
  const detected = $('detected-info'); detected.replaceChildren();
  if (chat?.submission?.links?.length || chat?.submission?.token) {
    detected.append(el('span', 'detected-label', 'Working with'));
    if (chat.submission.links.length) detected.append(el('span', '', `${chat.submission.links.length} link${chat.submission.links.length === 1 ? '' : 's'}`));
    const token = chat.submission.token;
    if (token) {
      const investigation = [...(chat.runs || [])].reverse().find(run => run.result?.investigation)?.result.investigation;
      detected.append(chainBadge(token.chainId), tokenBadge(token, investigation));
    }
    else if (chat.detected?.chainId) detected.append(chainBadge(chat.detected.chainId));
  }
  detected.hidden = !detected.children.length;
  steps.render(chat);
  controls();
  if (nearBottom) scrollLatest();
}
async function loadHistory() {
  const version = ++historyVersion;
  try {
    const { chats } = await api('/api/chats'); if (version !== historyVersion) return;
    $('history-count').textContent = chats?.length ? String(chats.length) : '';
    $('chat-history').replaceChildren(...(chats?.length ? chats.map(item => {
      const button = el('button', 'history-item'); button.type = 'button'; button.dataset.chatId = item.id; button.setAttribute('aria-current', item.id === chat?.id ? 'page' : 'false');
      button.append(el('span', '', item.title), el('small', '', dateText(item.updatedAt)));
      button.addEventListener('click', () => { if (!saving && !pending) { setNavigation(false); location.hash = `chat/${item.id}`; } }); return button;
    }) : [el('p', 'history-empty', 'Your investigations will appear here.')]));
  } catch { $('chat-history').replaceChildren(el('p', 'history-empty', 'History is unavailable. Reconnect to try again.')); }
}
function schedulePoll() { clearTimeout(timer); if (active()) timer = setTimeout(poll, 1200); }
async function poll() {
  clearTimeout(timer); if (!chat || saving) { schedulePoll(); return; }
  const version = viewVersion, id = chat.id;
  try {
    const { chat: next } = await api(`/api/chats/${encodeURIComponent(id)}`);
    if (version !== viewVersion || saving) return;
    const wasActive = active(); chat = next; connected = true; draw();
    if (wasActive && !active()) { $('reply-announcement').textContent = 'Your investigation finished. The report is available in this conversation.'; void loadHistory(); }
    schedulePoll();
  } catch (error) { if (version === viewVersion) { connected = false; showError(`Progress could not be refreshed: ${error.message}`); draw(); } }
}
async function openChat(id, saveDraft = true) {
  clearTimeout(timer); const version = ++viewVersion; if (saveDraft) storage.set(draftKey(), $('chat-message').value); loading = true; controls();
  if (!id) { loading = false; chat = null; nodes.clear(); $('chat-thread').replaceChildren(); $('chat-message').value = storage.get(draftKey()) || ''; storage.set('mydevsaid-personal-chat', null); draw(); return; }
  try {
    const response = await api(`/api/chats/${encodeURIComponent(id)}`); if (version !== viewVersion) return;
    chat = response.chat; connected = true; storage.set('mydevsaid-personal-chat', id);
    $('chat-message').value = storage.get(draftKey()) || ''; nodes.clear(); $('chat-thread').replaceChildren(); showError(''); draw(); schedulePoll();
  } catch (error) { if (version === viewVersion) { connected = false; showError(`Could not open this conversation: ${error.message}`); } }
  finally { if (version === viewVersion) { loading = false; controls(); } }
}
async function send(stepAnswer) {
  if (saving || loading || !config?.personalMode) return;
  const message = (stepAnswer ?? $('chat-message').value).trim(); if (!message && !pending) return;
  if (!pending) pending = { message, requestId: crypto.randomUUID(), chatId: chat?.id || null, revision: chat?.revision, preserveDraft: typeof stepAnswer === 'string' };
  storage.set('mydevsaid-personal-pending', pending); saving = true; clearTimeout(timer); controls(); showError('');
  try {
    const response = await api(pending.chatId ? `/api/chats/${encodeURIComponent(pending.chatId)}/messages` : '/api/chats', { method: 'POST', body: JSON.stringify({ message: pending.message, requestId: pending.requestId, ...(pending.chatId ? { revision: pending.revision } : {}) }) });
    const nextDraft = !pending.preserveDraft && $('chat-message').value.trim() === pending.message ? '' : $('chat-message').value;
    storage.set(draftKey(), ''); chat = response.chat; connected = true; ++viewVersion;
    storage.set('mydevsaid-personal-chat', chat.id); storage.set('mydevsaid-personal-pending', null); pending = null;
    $('chat-message').value = nextDraft; storage.set(draftKey(), nextDraft);
    history.replaceState(null, '', `#chat/${chat.id}`); draw(); void loadHistory();
    $('reply-announcement').textContent = chat.messages.filter(m => m.role === 'assistant').at(-1)?.content || 'Message saved.';
    scrollLatest();
  } catch (error) {
    if (error.status === 409) {
      pending = null; storage.set('mydevsaid-personal-pending', null);
      if (chat) { const latest = await api(`/api/chats/${encodeURIComponent(chat.id)}`).catch(() => null); if (latest) chat = latest.chat; }
      showError('The conversation changed in another tab. Your message is still here. Send it again to add it to the latest version.');
    } else if (error.status && error.status < 500) { pending = null; storage.set('mydevsaid-personal-pending', null); showError(error.message); }
    else showError(`Your message could not be confirmed: ${error.message} Retry to recover the same request.`, true);
  } finally { saving = false; draw(); schedulePoll(); }
}
async function retryRun(run, button) {
  if (saving) return;
  const id = chat.id, version = viewVersion; button.disabled = true;
  try { const response = await api(`/api/chats/${id}/retry`, { method: 'POST', body: JSON.stringify({ runId: run.id, revision: chat.revision, requestId: crypto.randomUUID() }) }); if (version === viewVersion) { chat = response.chat; draw(); schedulePoll(); } }
  catch (error) { showError(error.message); button.disabled = false; }
}
$('chat-form').addEventListener('submit', event => { event.preventDefault(); void send(); });
$('chat-message').addEventListener('input', () => { storage.set(draftKey(), $('chat-message').value); controls(); });
$('chat-message').addEventListener('keydown', event => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) { event.preventDefault(); $('chat-form').requestSubmit(); } });
$('new-chat').addEventListener('click', newInvestigation);
$('mobile-new-chat').addEventListener('click', newInvestigation);
document.querySelector('.wordmark').addEventListener('click', event => { event.preventDefault(); newInvestigation(); });
document.querySelectorAll('[data-prompt]').forEach(button => button.addEventListener('click', () => {
  if (saving || loading) return;
  const input = $('chat-message'), prompt = button.dataset.prompt.replaceAll('\\n', '\n');
  if (!input.value.startsWith(prompt)) {
    if (input.value.length + prompt.length > input.maxLength) { showError('There is no room for a starter prompt. Your current draft is kept.'); input.focus(); return; }
    input.value = prompt + input.value;
  }
  input.dispatchEvent(new Event('input')); input.focus(); input.setSelectionRange(input.value.length, input.value.length);
}));
window.addEventListener('keydown', event => {
  if (event.key.toLowerCase() === 'n' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.isComposing && !event.target.closest('input, textarea, select, [contenteditable]')) { event.preventDefault(); newInvestigation(); }
});
$('retry-send').addEventListener('click', () => void send());
$('reconnect').addEventListener('click', async () => { showError(''); connected = true; const id = /^#chat\/([a-zA-Z0-9-]+)$/.exec(location.hash)?.[1]; await (id ? openChat(id) : chat ? poll() : init()); controls(); });
$('history-menu').addEventListener('toggle', () => { if ($('history-menu').open) void loadHistory(); });
window.addEventListener('hashchange', () => { const id = /^#chat\/([a-zA-Z0-9-]+)$/.exec(location.hash)?.[1]; if (id && !saving && !pending) void openChat(id); });
async function init() {
  try {
    config = await api('/api/config'); connected = true;
    if (!config.personalMode) { showError('This personal workspace is available on the local instance.'); controls(); return; }
    $('model-note').textContent = config.modelEnabled ? 'Reports can use model-assisted explanations. Chat follow-ups currently retrieve captured findings and their sources.' : 'This instance uses automatic evidence checks and matching findings for follow-ups. A conversational AI model is not configured.';
    await loadHistory();
    const id = /^#chat\/([a-zA-Z0-9-]+)$/.exec(location.hash)?.[1] || storage.get('mydevsaid-personal-chat');
    if (id) await openChat(id, false); else { $('chat-message').value = storage.get(draftKey()) || ''; draw(); }
    if (pending) { if (!pending.preserveDraft && !$('chat-message').value) $('chat-message').value = pending.message; showError(`A previous message needs confirmation: "${pending.message.slice(0, 100)}". Retry to recover it; your current draft will be kept.`, true); }
    controls();
  } catch (error) { connected = false; showError(`The investigation service is unavailable: ${error.message}`); draw(); }
}
new MutationObserver(syncMascot).observe($('chat-decisions'), { childList: true });
void init();
