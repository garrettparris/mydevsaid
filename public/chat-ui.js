import { el, shortAddress } from './report.js';

// Local recognition only. These chips do not assert ownership or verification.
export function createDraftPreview(composer) {
  const preview = el('div', 'draft-preview'); preview.hidden = true;
  preview.setAttribute('aria-label', 'Recognized in your unsent message');
  composer.before(preview);
  let signature = '';
  return text => {
    const items = new Map();
    for (const match of text.matchAll(/\b(?:https?:\/\/|www\.|github\.com\/)[^\s<>"']+/gi)) {
      try {
        const url = new URL(/^https?:/i.test(match[0]) ? match[0] : `https://${match[0]}`);
        if (!url.hostname.includes('.') || url.username || url.password) continue;
        const kind = url.hostname === 'github.com' ? 'GitHub' : 'Website';
        items.set(url.hostname, { label: `${kind}: ${url.hostname}`, title: url.hostname });
      } catch { /* Partial links can be completed without interrupting typing. */ }
    }
    for (const [address] of text.matchAll(/\b0x[a-f0-9]{40}\b/gi)) items.set(address.toLowerCase(), { label: `Address: ${shortAddress(address)}`, title: address });
    const next = JSON.stringify([...items]); if (signature === next) return; signature = next;
    preview.replaceChildren(); preview.hidden = !items.size; if (!items.size) return;
    preview.append(el('span', 'draft-label', 'In your message'));
    for (const item of [...items.values()].slice(0, 4)) { const chip = el('span', 'draft-chip', item.label); chip.title = item.title; preview.append(chip); }
    if (items.size > 4) preview.append(el('span', 'draft-overflow', `+${items.size - 4} more`));
  };
}

export function runActivity(run) {
  const activity = el('details', 'run-activity');
  const entries = run.progress || [], running = ['queued', 'running'].includes(run.status);
  const summary = el('summary');
  const copy = el('span', 'activity-copy');
  copy.append(el('strong', '', running ? 'Research in progress' : 'Research activity'));
  copy.append(el('span', 'activity-latest', running ? entries.at(-1) || 'Waiting for the investigation engine.' : `${entries.length} recorded updates`));
  summary.append(el('span', `activity-indicator${running ? ' is-running' : ''}`), copy, el('span', 'activity-chevron'));
  activity.append(summary);
  const list = el('ol', 'run-progress');
  for (const text of entries) list.append(el('li', '', text));
  if (!entries.length) list.append(el('li', '', 'No activity recorded yet.'));
  activity.append(list);
  return activity;
}
