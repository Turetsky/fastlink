export async function takeScreenshot(args = {}) {
  const format = (args.format || 'png').toLowerCase();
  const opts = { format };
  if (format === 'jpeg' && typeof args.quality === 'number') opts.quality = args.quality;
  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(undefined, opts);
  } catch (e) {
    // Intermittent "image readback failed"/timeout right after heavy work — an
    // immediate retry succeeds. Wait a beat and retry exactly once.
    await new Promise((r) => setTimeout(r, 300));
    dataUrl = await chrome.tabs.captureVisibleTab(undefined, opts);
  }
  return { dataUrl, format };
}
