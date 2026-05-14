import { getActiveTab } from '../util.js';

export async function handleTabAction(action, args = {}) {
  if (action === 'fast_tab')    return openTab(args);
  if (action === 'fast_nav')    return navigateTab(args);
  if (action === 'fast_list')   return listTabs();
  if (action === 'fast_close')  return closeTab(args);
  if (action === 'fast_switch') return switchTab(args);
  return { error: `Unknown tab action: ${action}` };
}

async function openTab({ url, background }) {
  const opts = { url, active: !background };
  try {
    const tab = await chrome.tabs.create(opts);
    return { id: tab.id, url: tab.pendingUrl || tab.url };
  } catch (e) {
    if (!/no current window/i.test(e?.message || '')) throw e;
    // Cold-started SW with no current window: pick any normal window, else
    // create one.
    const [win] = await chrome.windows.getAll({ windowTypes: ['normal'] });
    if (win) {
      const tab = await chrome.tabs.create({ ...opts, windowId: win.id });
      return { id: tab.id, url: tab.pendingUrl || tab.url };
    }
    const created = await chrome.windows.create({ url, focused: !background });
    const tab = created.tabs?.[0];
    return { id: tab?.id, url };
  }
}

async function navigateTab({ url }) {
  const tab = await getActiveTab();
  if (!tab) return { error: 'No active tab' };
  await chrome.tabs.update(tab.id, { url });
  return { id: tab.id, url };
}

async function listTabs() {
  let tabs = await chrome.tabs.query({ currentWindow: true });
  if (tabs.length === 0) tabs = await chrome.tabs.query({ windowType: 'normal' });
  return tabs.map(t => ({ id: t.id, url: t.url, title: t.title, active: t.active }));
}

async function findTab({ tabId, match }) {
  if (tabId) {
    try { return await chrome.tabs.get(tabId); } catch {}
  }
  if (match) {
    const m = String(match).toLowerCase();
    const tabs = await chrome.tabs.query({});
    return tabs.find(t => (t.url || '').toLowerCase().includes(m) || (t.title || '').toLowerCase().includes(m));
  }
  return null;
}

async function closeTab(args) {
  const target = await findTab(args);
  if (!target) return { error: 'No matching tab to close' };
  await chrome.tabs.remove(target.id);
  return { closed: { id: target.id, url: target.url, title: target.title } };
}

async function switchTab(args) {
  const target = await findTab(args);
  if (!target) return { error: 'No matching tab found. Try fast_list to see available tabs.' };
  await chrome.tabs.update(target.id, { active: true });
  if (target.windowId !== undefined) await chrome.windows.update(target.windowId, { focused: true });
  return { id: target.id, url: target.url, title: target.title };
}
