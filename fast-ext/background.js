import { startConnection, sendEvent } from './src/connection.js';
import { startBufferListeners } from './src/buffers.js';
import { dispatchAction }        from './src/actions/index.js';

startBufferListeners();
startConnection(dispatchAction);

// Tell the broker (→ MCP server) when the active tab finishes loading, so the
// scout can pre-warm its page map before Claude ever asks. Fires once per full
// load (SPA route changes don't trigger onUpdated 'complete').
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  if (!tab || !tab.active || !/^https?:/.test(tab.url || '')) return;
  sendEvent({ event: 'navigated', url: tab.url, tabId });
});

// Clicking the toolbar icon reloads the extension. Picks up code edits to
// background / connection / actions instantly. Note: content scripts in
// already-open tabs still need a tab refresh to pick up the new injection.
chrome.action.onClicked.addListener(() => chrome.runtime.reload());
