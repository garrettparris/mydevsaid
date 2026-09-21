import { el, chainName, shortAddress } from './report.js';

// Suggestions come from explicit intake questions and supplied addresses, never inferred identity.
export function questionSpec(question, chat) {
  const spec = { title: 'One detail to clarify', reason: 'Your answer helps narrow the next check.', placeholder: 'Add the missing detail...', choices: [], required: false };
  if (/choose Ethereum|Several networks|Which network/.test(question)) {
    spec.title = 'Which network should I check?'; spec.reason = 'The same address can exist on different networks. Pick the one this project uses.';
    spec.choices = [1, 8453, 4663].map(id => ({ label: chainName(id), detail: 'Mainnet', value: `Confirm network ${chainName(id)}` }));
    spec.placeholder = 'Or explain which network you mean...';
  } else if (/primary token|Several addresses|nonzero EVM/.test(question)) {
    spec.title = 'Which is the project token?'; spec.reason = 'A page can mention many contracts. Confirm the token before including its contract checks.';
    const candidates = [...question.matchAll(/(0x[a-f0-9]{40}) \(chain (1|8453|4663), ([^)]+)\)/gi)];
    spec.choices = candidates.length ? candidates.map(([, address, id, host]) => ({ label: shortAddress(address), detail: `${chainName(Number(id))} / mentioned on ${host}`, value: `Confirm token ${address} on chain ${id}` }))
      : (chat.detected?.addresses || []).slice(0, 4).map(address => ({ label: shortAddress(address), detail: 'Address you supplied', value: `Confirm token ${address}` }));
    spec.placeholder = 'Paste the primary token address...';
  } else if (/GitHub|repository/.test(question)) {
    spec.title = 'Have a link to the source code?'; spec.reason = 'A public repository lets the next investigation inspect the code the project shares.'; spec.placeholder = 'github.com/organization/repository';
  } else if (/Share a project website/.test(question)) {
    spec.title = 'Where should I start looking?'; spec.reason = 'A website, docs page, or explorer link is enough to begin.'; spec.placeholder = 'Paste a project or documentation link...'; spec.required = true;
  }
  return spec;
}

export function createChatSteps(host, { storage, send, busy }) {
  let signature = '', currentChat;
  const key = question => `mydevsaid-step:${currentChat.id}:${question}`;
  const state = question => storage.get(key(question)) || {};
  function syncControls() {
    host.querySelectorAll('button, input, textarea').forEach(control => { control.disabled = busy() || (control.dataset.needsAnswer === 'true' && !control.form?.dataset.answer); });
    const hint = host.querySelector('.question-hint');
    if (hint && hint.dataset.required !== 'true') hint.textContent = currentChat?.runs?.some(run => ['queued', 'running'].includes(run.status)) ? 'Research continues while you answer' : 'You can leave this unknown';
  }
  function save(question, value) { storage.set(key(question), { ...state(question), ...value }); }
  function refresh() { signature = ''; render(currentChat); }
  function questionCard(question, index, total) {
    const spec = questionSpec(question, currentChat), saved = state(question);
    const form = el('form', 'question-card'); form.setAttribute('aria-label', spec.title);
    const heading = el('div', 'question-topline'); heading.append(el('span', 'question-badge', 'A question from mydev'), el('span', 'question-counter', `${index + 1} of ${total}`));
    const title = el('h3', '', spec.title); title.id = 'active-question-title';
    form.setAttribute('aria-labelledby', title.id); form.append(heading, title, el('p', 'question-reason', spec.reason));
    const original = el('details', 'question-context'); original.append(el('summary', '', 'Why this came up'), el('p', '', question)); form.append(original);
    const options = el('fieldset', 'question-options'); const legend = el('legend', 'sr-only', 'Choose an answer'); options.append(legend);
    const input = el('textarea', 'question-input'); input.rows = 2; input.maxLength = 4000; input.placeholder = spec.placeholder; input.setAttribute('aria-label', spec.placeholder); input.value = saved.text || '';
    let selected = saved.selected || '';
    const update = () => { form.dataset.answer = input.value.trim() || selected; save(question, { text: input.value, selected }); syncControls(); };
    for (const choice of spec.choices) {
      const label = el('label', 'question-choice'); const radio = el('input'); radio.type = 'radio'; radio.name = 'answer'; radio.value = choice.value; radio.checked = selected === choice.value;
      const description = el('span'); description.append(el('strong', '', choice.label), el('small', '', choice.detail));
      radio.addEventListener('change', () => { selected = choice.value; input.value = ''; update(); }); label.append(radio, description); options.append(label);
    }
    if (spec.choices.length) form.append(options);
    input.addEventListener('input', () => { selected = ''; options.querySelectorAll('input').forEach(radio => { radio.checked = false; }); update(); });
    if (spec.choices.length) {
      const custom = el('details', 'question-custom'); custom.open = Boolean(saved.text);
      custom.append(el('summary', '', 'Something else? Add your own answer'), input); form.append(custom);
    } else form.append(input);
    input.addEventListener('keydown', event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.isComposing) { event.preventDefault(); form.requestSubmit(); } });
    const footer = el('div', 'question-footer');
    const hint = el('span', 'question-hint', spec.required ? 'Needed to start research' : 'You can leave this unknown'); hint.dataset.required = String(spec.required); footer.append(hint);
    if (!spec.required) {
      const skip = el('button', 'step-skip', 'Leave unknown'); skip.type = 'button';
      skip.addEventListener('click', () => { if (busy()) return; save(question, { deferred: true }); refresh(); host.querySelector('button, textarea')?.focus(); }); footer.append(skip);
    }
    const submit = el('button', 'button primary step-submit', 'Send answer'); submit.type = 'submit'; submit.dataset.needsAnswer = 'true'; footer.append(submit); form.append(footer);
    form.dataset.answer = input.value.trim() || selected;
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (busy() || !form.dataset.answer) return;
      // send() owns request recovery; card answers do not replace the composer's draft.
      await send(form.dataset.answer); syncControls();
    });
    return form;
  }
  function render(chat) {
    currentChat = chat;
    const questions = [...new Set(chat?.questions || [])];
    // Background revisions must not replace a focused input or its selection.
    const nextSignature = JSON.stringify([chat?.id, chat?.detected?.addresses, questions, questions.map(q => state(q).deferred), Boolean(chat?.runs?.some(run => run.result))]);
    if (signature === nextSignature) { syncControls(); return; }
    signature = nextSignature;
    if (!chat) { host.replaceChildren(); return; }
    const current = questions.findIndex(question => !state(question).deferred);
    const cardKey = current < 0 ? '' : JSON.stringify([chat.id, questions[current], current, questions.length, questionSpec(questions[current], chat)]);
    const existing = host.querySelector('.question-card');
    const keep = existing && existing.dataset.questionKey === cardKey;
    for (const child of [...host.children]) if (!keep || child !== existing) child.remove();
    if (current >= 0 && !keep) { const card = questionCard(questions[current], current, questions.length); card.dataset.questionKey = cardKey; host.prepend(card); }
    const deferred = questions.filter(question => state(question).deferred);
    if (deferred.length) {
      const details = el('details', 'deferred-questions'); details.append(el('summary', '', `${deferred.length} detail${deferred.length === 1 ? '' : 's'} left unknown`));
      for (const question of deferred) { const row = el('div'); row.append(el('p', '', question)); const reopen = el('button', 'text-button', 'Answer this'); reopen.type = 'button'; reopen.addEventListener('click', () => { if (busy()) return; save(question, { deferred: false }); refresh(); host.querySelector('input, textarea')?.focus(); }); row.append(reopen); details.append(row); }
      host.append(details);
    }
    if (chat.runs?.some(run => run.result)) {
      const followups = el('div', 'report-followups'); followups.append(el('span', '', 'Explore the report'));
      for (const [label, message] of [['Summarize the findings', 'Summarize the report.'], ['Who has control?', 'Who controls the contracts?'], ['What is still unknown?', 'What limitations and unverified claims remain?']]) {
        const button = el('button', '', label); button.type = 'button'; button.addEventListener('click', () => { if (!busy()) void send(message); }); followups.append(button);
      }
      host.append(followups);
    }
    syncControls();
  }
  return { render, syncControls };
}
