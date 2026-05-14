import { pushRing, getActiveTab } from './util.js';

const CONSOLE_BUFFER_MAX = 200;
const NETWORK_BUFFER_MAX = 200;
const NETWORK_BODY_BUFFER_MAX = 100;

export const consoleBuffers = new Map();
export const networkBuffers = new Map();
export const networkBodyBuffers = new Map();
const pendingNet = new Map();

export function pendingNetCount(tabId) {
  let n = 0;
  for (const rec of pendingNet.values()) if (rec.tabId === tabId) n++;
  return n;
}

export function startBufferListeners() {
  chrome.runtime.onMessage.addListener((msg, sender) => {
    if (msg?.type === 'fb_console' && sender?.tab) {
      pushRing(consoleBuffers, sender.tab.id, msg.entry, CONSOLE_BUFFER_MAX);
    } else if (msg?.type === 'fb_network_body' && sender?.tab) {
      pushRing(networkBodyBuffers, sender.tab.id, msg.entry, NETWORK_BODY_BUFFER_MAX);
    }
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    consoleBuffers.delete(tabId);
    networkBuffers.delete(tabId);
    networkBodyBuffers.delete(tabId);
    for (const [reqId, rec] of pendingNet) {
      if (rec.tabId === tabId) pendingNet.delete(reqId);
    }
  });

  chrome.webRequest.onBeforeRequest.addListener(onNetStart, { urls: ['<all_urls>'] });
  chrome.webRequest.onCompleted.addListener(onNetEnd,    { urls: ['<all_urls>'] });
  chrome.webRequest.onErrorOccurred.addListener(onNetErr, { urls: ['<all_urls>'] });
}

export async function readBuffer(map, args = {}, extraFilter) {
  const tab = await getActiveTab();
  if (!tab) return { error: 'No active tab' };
  const buf = map.get(tab.id) || [];
  let items = buf.slice();
  if (extraFilter) items = items.filter(extraFilter);
  const limit = typeof args.limit === 'number' && args.limit > 0 ? args.limit : 50;
  items = items.slice(-limit).reverse();
  if (args.clear) map.set(tab.id, []);
  return { tabId: tab.id, count: items.length, total: buf.length, items };
}

function onNetStart(d) {
  if (d.tabId < 0) return;
  pendingNet.set(d.requestId, { url: d.url, method: d.method, type: d.type, tabId: d.tabId, startedAt: d.timeStamp });
}

function onNetEnd(d) {
  const rec = pendingNet.get(d.requestId);
  pendingNet.delete(d.requestId);
  if (!rec) return;
  pushRing(networkBuffers, rec.tabId, {
    url: rec.url, method: rec.method, type: rec.type,
    status: d.statusCode, ok: d.statusCode < 400,
    durationMs: Math.round(d.timeStamp - rec.startedAt),
    ts: Date.now(),
  }, NETWORK_BUFFER_MAX);
}

function onNetErr(d) {
  const rec = pendingNet.get(d.requestId);
  pendingNet.delete(d.requestId);
  if (!rec) return;
  pushRing(networkBuffers, rec.tabId, {
    url: rec.url, method: rec.method, type: rec.type,
    status: 0, ok: false, error: d.error,
    durationMs: Math.round(d.timeStamp - rec.startedAt),
    ts: Date.now(),
  }, NETWORK_BUFFER_MAX);
}
