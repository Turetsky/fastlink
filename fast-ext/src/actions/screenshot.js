export async function takeScreenshot(args = {}) {
  const format = (args.format || 'png').toLowerCase();
  const opts = { format };
  if (format === 'jpeg' && typeof args.quality === 'number') opts.quality = args.quality;
  const dataUrl = await chrome.tabs.captureVisibleTab(undefined, opts);
  return { dataUrl, format };
}
