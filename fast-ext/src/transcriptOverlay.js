// FastLink transcript overlay — DEPRECATED / NEUTRALIZED.
//
// This used to be a SEPARATE floating box (top-left) that mirrored the claude.ai
// transcript + current-action + permission Allow/Deny while the relay drove the
// browser. It has been MERGED into the single driving panel (src/overlay.js):
// that one box now shows the "Claude is driving this tab" header, the
// activity/current-action, the structured transcript lines, and the permission
// Allow/Deny block together. background.js routes the {fastlink:'transcript'}
// pushes straight to overlay.js (the manifest-injected ISOLATED content script on
// every tab) and no longer injects this file.
//
// Kept as a harmless no-op so that if any build path or stale tab still injects
// it, it simply REMOVES any orphaned second-box host left by a previous version
// instead of rendering a duplicate panel. All of its rendering logic now lives in
// src/overlay.js.
(() => {
  try { document.getElementById('__fastlink_transcript_host__')?.remove(); } catch {}
  try { window.__fastlinkTranscriptTeardown?.(); } catch {}
  window.__fastlinkTranscriptInstalled = false;
  window.__fastlinkTranscriptTeardown = () => {};
})();
