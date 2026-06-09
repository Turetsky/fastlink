import { injectInTab, captureVisiblePinAware } from '../util.js';

// Set-of-Mark: annotate a screenshot of the visible tab with numbered boxes
// over the visible interactive elements, so a multimodal model can name the
// element by NUMBER. The number drawn IS the element's snapshot id (`i`), so
// it maps straight back to a ref / center coords with no separate numbering.
//
// THE KEY SCALING BUG this guards against: snapshot coords (getBoundingClientRect)
// are CSS px, but chrome.tabs.captureVisibleTab produces a DEVICE-px image. On a
// HiDPI display (devicePixelRatio > 1) the image is dpr× larger than the CSS
// viewport, so every x/y/w/h must be multiplied by dpr before drawing or the
// boxes land in the wrong place. We read devicePixelRatio FROM THE PAGE — the
// service worker's global scope has no window.devicePixelRatio.

const MAX_MARKS = 40;

// Pull the viewport snapshot + devicePixelRatio from the page in one inject.
// fast_snapshot(viewport:true) returns items[] each with i, x, y, w, h already
// in outer-page-viewport CSS px (getBoundingClientRect + iframe offset), which
// is exactly the space we annotate in.
function readPage() {
  const dpr = window.devicePixelRatio || 1;
  if (!window.__fastlink || !window.__fastlink.run) {
    return { error: 'FastLink content script not loaded in this tab — reload the tab.', dpr };
  }
  // run() is async; executeScript awaits a returned promise.
  return Promise.resolve(window.__fastlink.run('fast_snapshot', { viewport: true }))
    .then((snap) => ({ dpr, snap }))
    .catch((e) => ({ error: 'snapshot failed: ' + (e?.message || String(e)), dpr }));
}

// Service workers have no FileReader; go via arrayBuffer + btoa instead.
async function blobToDataURL(blob, mime) {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return `data:${mime || 'image/png'};base64,` + btoa(bin);
}

export async function captureMarks(args = {}) {
  try {
    // 1. Snapshot the viewport + read devicePixelRatio from the page.
    const r = await injectInTab({ world: 'MAIN', func: readPage });
    if (r.error) return r;                 // no active tab / restricted URL
    const page = r.result;
    if (!page) return { error: 'fast_marks: injected script returned no value — reload the tab.' };
    if (page.error) return { error: page.error };
    const dpr = page.dpr || 1;
    const snap = page.snap;
    if (!snap || !Array.isArray(snap.items)) {
      return { error: 'fast_marks: no snapshot items returned (page may still be indexing).' };
    }

    // 2. Pick which elements to mark. Default: all visible interactive items.
    //    args.only (array of ids) marks just those. Cap at MAX_MARKS — too many
    //    boxes turns the image into soup and the model can't read the numbers.
    let items = snap.items;
    if (Array.isArray(args.only) && args.only.length) {
      const want = new Set(args.only.map(Number));
      items = items.filter((it) => want.has(it.i));
    }
    let truncated = false;
    if (items.length > MAX_MARKS) {
      items = items.slice(0, MAX_MARKS);
      truncated = true;
    }
    if (!items.length) {
      return { error: 'fast_marks: no interactive elements to mark in the current viewport.' };
    }

    // 3. Capture the target tab (device px). captureVisiblePinAware uses the
    //    quota-aware captureVisibleTab path normally, but when Claude's pinned
    //    tab is backgrounded (relay case) it captures THAT tab via CDP instead —
    //    so we never annotate the wrong (on-screen) tab. Both paths return
    //    device-px so the dpr coord math below holds.
    const dataUrl = await captureVisiblePinAware({ format: 'png' });

    // 4. Annotate with OffscreenCanvas (a normal <canvas> isn't available in an
    //    MV3 service worker). Scale every CSS-px coord by dpr to match the image.
    const blob = await (await fetch(dataUrl)).blob();
    const bmp = await createImageBitmap(blob);
    const cvs = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = cvs.getContext('2d');
    ctx.drawImage(bmp, 0, 0);
    ctx.font = '16px sans-serif';
    ctx.textBaseline = 'alphabetic';

    const marks = [];
    for (const it of items) {
      const x = it.x * dpr, y = it.y * dpr, w = it.w * dpr, h = it.h * dpr;
      // Red box over the element.
      ctx.strokeStyle = 'red';
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, w, h);
      // Label chip at the TOP-LEFT corner (above the box, not over the element),
      // showing the element's id so it maps straight back to the ref.
      const label = String(it.i);
      const labelW = label.length * 10 + 8;
      const labelH = 18;
      // If the box hugs the top edge, drop the chip just inside instead of off-screen.
      const ly = y - labelH >= 0 ? y - labelH : y;
      ctx.fillStyle = 'red';
      ctx.fillRect(x, ly, labelW, labelH);
      ctx.fillStyle = 'white';
      ctx.fillText(label, x + 3, ly + labelH - 4);
      // Center in CSS px — for the lead's fast_click_xy mapping.
      marks.push({ i: it.i, cx: Math.round(it.x + it.w / 2), cy: Math.round(it.y + it.h / 2) });
    }

    const outBlob = await cvs.convertToBlob({ type: 'image/png' });
    const annotated = await blobToDataURL(outBlob, 'image/png');

    return { dataUrl: annotated, marks, dpr, truncated };
  } catch (e) {
    return { error: 'fast_marks failed: ' + (e?.message || String(e)) };
  }
}
