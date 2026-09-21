import { setupSidebar } from './sidebar.js';

const $ = id => document.getElementById(id);
const el = (tag, className = '', text) => {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
};
const badge = (text, enabled) => el('span', `settings-status${enabled ? ' configured' : ''}`, text);
function field(label, value) {
  const row = el('div', 'configuration-row'), description = el('dd');
  description.append(value);
  row.append(el('dt', '', label), description);
  return row;
}

function render(data) {
  const { gmgn, model, rpcs } = data;
  $('gmgn-fields').replaceChildren(
    field('API key', badge(gmgn.configured ? 'Configured' : 'Not configured', gmgn.configured)),
    field('Key value', el('code', '', gmgn.configured ? '********' : 'Not set')),
    field('Source', gmgn.source === 'environment' ? 'Server environment' : gmgn.source === 'global_config' ? 'Local GMGN config' : 'Not set'),
  );
  const codex = model.enabled && /codex/i.test(model.name || '');
  $('model-fields').replaceChildren(
    field('Codex', badge(codex ? 'Configured' : 'Not configured', codex)),
    field('Analysis model', badge(model.enabled ? 'Configured' : 'Not configured', model.enabled)),
    field('Model name', el('code', '', model.name || 'Not set')),
    field('Harness', 'Pi'),
  );
  $('rpc-networks').replaceChildren(...rpcs.map(chain => {
    const network = el('div', 'rpc-network'), heading = el('div', 'rpc-network-heading'), list = el('ol', 'rpc-endpoints');
    heading.append(el('h3', '', chain.name), el('small', '', `Chain ${chain.chainId}`));
    for (const endpoint of [...chain.endpoints].sort((a, b) => a.priority - b.priority)) {
      const item = el('li', 'rpc-endpoint'), details = el('div');
      item.value = endpoint.priority;
      details.append(el('code', '', endpoint.host), el('small', '', endpoint.selected && chain.custom ? 'Custom endpoint' : 'Built-in endpoint'));
      item.append(el('span', 'rpc-priority', endpoint.priority), details, badge(endpoint.selected ? 'In use' : 'Inactive', endpoint.selected));
      list.append(item);
    }
    network.append(heading, list);
    return network;
  }));
}

async function refresh() {
  const button = $('refresh-config');
  button.disabled = true; button.textContent = 'Refreshing...';
  $('config-error').hidden = true;
  $('config-content').setAttribute('aria-busy', 'true');
  $('config-status').textContent = 'Loading settings...';
  try {
    const response = await fetch('/api/config', { cache: 'no-store', signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error('Could not load settings. Check that the local server is running, then refresh.');
    const config = await response.json();
    if (!config.personalMode || !config.connections) throw new Error('Settings are available on the local personal workspace only.');
    render(config.connections);
    $('config-content').hidden = false;
    $('config-status').textContent = `Updated ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })} from this computer's server.`;
  } catch (error) {
    $('config-content').hidden = true;
    $('config-status').textContent = 'Settings unavailable';
    $('config-error').textContent = error.name === 'TimeoutError' ? 'The server took too long to respond. Try refreshing again.' : error.message;
    $('config-error').hidden = false;
  } finally {
    $('config-content').setAttribute('aria-busy', 'false');
    button.disabled = false; button.textContent = 'Refresh';
  }
}

try {
  const id = JSON.parse(localStorage.getItem('mydevsaid-personal-chat'));
  if (typeof id === 'string' && /^[a-zA-Z0-9-]+$/.test(id)) $('back-to-chat').href = `/#chat/${id}`;
} catch { /* The workspace remains usable when local storage is unavailable. */ }

setupSidebar();
$('refresh-config').addEventListener('click', refresh);
void refresh();
