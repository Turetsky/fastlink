export const getActiveTab = async () => {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (tab) return tab;
  // MV3 cold-start: a freshly-woken service worker has no "last focused
  // window" until a focus/activate event fires in its lifetime. Fall back to
  // the active tab of the first normal window.
  const wins = await chrome.windows.getAll({ windowTypes: ['normal'], populate: true });
  for (const w of wins) {
    const t = w.tabs?.find(t => t.active);
    if (t) return t;
  }
  return undefined;
};

export const isInjectableUrl = (url) => /^https?:|^file:/.test(url || '');

export async function getInjectableTab() {
  const tab = await getActiveTab();
  if (!tab) return { error: 'No active tab' };
  if (!isInjectableUrl(tab.url)) return { error: `Restricted URL: ${tab.url}` };
  return { tab };
}

export async function injectInTab({ world = 'MAIN', func, args = [] }) {
  const got = await getInjectableTab();
  if (got.error) return got;
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId: got.tab.id }, world, func, args,
  });
  return { tab: got.tab, result };
}

export const pushRing = (map, key, entry, max) => {
  if (!key) return;
  let buf = map.get(key);
  if (!buf) { buf = []; map.set(key, buf); }
  buf.push(entry);
  if (buf.length > max) buf.splice(0, buf.length - max);
};
