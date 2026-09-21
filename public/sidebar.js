// Shared inset navigation for the chat, reports, and settings surfaces.
export function setupSidebar() {
  const sidebar = document.getElementById('workspace-sidebar');
  const trigger = document.getElementById('toggle-sidebar');
  const close = document.getElementById('close-sidebar');
  const backdrop = document.getElementById('sidebar-backdrop');
  const surface = document.querySelector('.workspace-surface');
  const scrollArea = document.createElement('div');
  scrollArea.id = 'workspace-scroll'; scrollArea.className = 'workspace-scroll';
  const main = surface.querySelector('main');
  main.before(scrollArea); scrollArea.append(main);
  const mobile = matchMedia('(max-width: 860px)');
  const storageKey = 'mydevsaid-sidebar-collapsed';
  let collapsed = false, mobileOpen = false;
  try { collapsed = localStorage.getItem(storageKey) === 'true'; } catch { /* Use the expanded default. */ }

  document.body.classList.add('inset-workspace');
  sidebar.dataset.variant = 'inset';
  surface.dataset.sidebar = 'inset';
  trigger.setAttribute('aria-keyshortcuts', 'Control+b Meta+b');

  const settings = sidebar.querySelector('a[href="/settings"]') || document.createElement('a');
  settings.href = '/settings'; settings.id = 'workspace-connections';
  settings.className = 'configuration-link'; settings.textContent = 'Settings';
  const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  icon.setAttribute('viewBox', '0 0 24 24'); icon.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(icon.namespaceURI, 'path');
  path.setAttribute('d', 'M4 7h16M4 17h16M8 4v6m8 4v6'); icon.append(path);
  settings.prepend(icon);
  sidebar.querySelector('.sidebar-footer').prepend(settings);
  const group = document.createElement('p');
  group.className = 'sidebar-group-label';
  group.textContent = document.getElementById('config-content') ? 'Settings' : 'Workspace';
  sidebar.querySelector('.new-investigation').before(group);

  function render() {
    const drawer = mobile.matches && mobileOpen;
    const expanded = mobile.matches ? drawer : !collapsed;
    document.body.classList.toggle('sidebar-collapsed', !mobile.matches && collapsed);
    document.body.classList.toggle('sidebar-open', drawer);
    sidebar.dataset.state = expanded ? 'expanded' : 'collapsed';
    sidebar.inert = !expanded;
    surface.inert = drawer;
    backdrop.hidden = !drawer;
    trigger.setAttribute('aria-expanded', String(expanded));
    const label = mobile.matches ? 'Open navigation' : expanded ? 'Collapse sidebar' : 'Expand sidebar';
    trigger.setAttribute('aria-label', label);
    trigger.title = `${label} (Ctrl or Cmd + B)`;
    if (drawer) {
      sidebar.setAttribute('role', 'dialog');
      sidebar.setAttribute('aria-modal', 'true');
    } else {
      sidebar.removeAttribute('role'); sidebar.removeAttribute('aria-modal');
    }
  }
  function setNavigation(open, returnFocus = true) {
    mobileOpen = mobile.matches && open;
    render();
    if (mobileOpen) close.focus();
    else if (returnFocus && mobile.matches) trigger.focus();
  }
  function toggle() {
    if (mobile.matches) return setNavigation(!mobileOpen);
    collapsed = !collapsed;
    try { localStorage.setItem(storageKey, String(collapsed)); } catch { /* Keep state for this page. */ }
    render(); trigger.focus();
  }
  trigger.addEventListener('click', toggle);
  close.addEventListener('click', () => setNavigation(false));
  backdrop.addEventListener('click', () => setNavigation(false));
  sidebar.querySelectorAll('a[href^="#"]').forEach(link => link.addEventListener('click', () => {
    if (!mobile.matches) return;
    setNavigation(false);
  }));
  document.addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'b' && !event.altKey && !event.isComposing && !event.repeat) {
      event.preventDefault(); toggle(); return;
    }
    if (!mobile.matches || !mobileOpen) return;
    if (event.key === 'Escape') { event.preventDefault(); setNavigation(false); }
    if (event.key === 'Tab') {
      const items = [...sidebar.querySelectorAll('a, button:not(:disabled), summary')].filter(item => item.getClientRects().length);
      if (event.shiftKey && document.activeElement === items[0]) { event.preventDefault(); items.at(-1)?.focus(); }
      else if (!event.shiftKey && document.activeElement === items.at(-1)) { event.preventDefault(); items[0]?.focus(); }
    }
  });
  mobile.addEventListener('change', () => {
    const focusWasInSidebar = sidebar.contains(document.activeElement);
    mobileOpen = false; render();
    if (sidebar.inert && focusWasInSidebar) trigger.focus();
  });
  window.addEventListener('storage', event => {
    if (event.key !== storageKey) return;
    collapsed = event.newValue === 'true';
    const focusWasInSidebar = sidebar.contains(document.activeElement);
    render();
    if (sidebar.inert && focusWasInSidebar) trigger.focus();
  });
  render();
  return setNavigation;
}
