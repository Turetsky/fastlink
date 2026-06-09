# BUG-4: fast_fill_form executes the fill but the response is lost or stalled on the return path

Severity: **critical**. Blocks all programmatic verification of fills. (Reported from claude.ai relay testing.)

## Symptom
`fast_fill_form` returns `{"error":"Timeout waiting for browser response (30000ms)"}`. Reproduced twice in a row on httpbin.org/forms/post with a single-field fill (`{"Customer name": "ClearTest"}`, `verify:true`).

## What actually happened
The fill is **not** failing. It executes correctly in the page — confirmed by screenshot: "ClearTest" is sitting in the Customer name field after the call "timed out." The action fired, the field received the value, and **the result never made it back to the tool**.

## On the overlay timing numbers
The driving overlay showed "Filling form 1 fields 538372ms" and "111265ms." These are **not** fill-execution time. A static HTML text input does not take nine (or two) minutes to accept eight characters; the identical call completed in 138ms a session earlier. These large numbers are elapsed wall-clock time while the call sat waiting for a response that never returned — they measure the hang, not the work.

## Root cause hypothesis
Same class as BUG-2 (navigate-then-wait timeout): the action executes in the page, but the response channel back through the relay is lost or stalled. The content-script/relay leg that should return the result either died or never resolved its promise. The 30s tool timeout fires while the page-side work is already long done. **Both failing calls had `verify:true`**, so the post-fill re-read step is the prime suspect: the fill writes the value, the verify read is issued, and the verify result never resolves or never routes back. (Handler: `fast-ext/src/actions/page.js:1662`, verify at `:1716`. Outer 30s timeout: `fastlink-relay/src/userRelay.js:278`, `REQUEST_TIMEOUT_MS`.)

## Why it presents as a false "browser timeout"
From the tool side it looks like the browser never responded, implying nothing happened. In reality the browser did the work and only the acknowledgment was lost. **Dangerous:** a caller retrying on this error re-fires an action that already succeeded → duplicate writes (double-typed values, double clicks, double submits).

## Reproduction
1. Open httpbin.org/forms/post, bring it to foreground.
2. `fast_fill_form({"Customer name": "ClearTest"}, verify:true)`.
3. Observe the 30s timeout error.
4. Screenshot the page: the value is present despite the error.

## Tests to isolate it
1. Run `fast_fill_form` with `verify:false`, same field. If it returns cleanly and fast, the hang is in the verify re-read path, not the fill.
2. Run with `verify:true` and snapshot the instant the error returns. If the value lands every time while the call never returns cleanly, it is confirmed response-path, independent of verify.
3. Check the extension service-worker console (chrome://extensions → FastLink → inspect service worker) for an unresolved promise or thrown error during `fast_fill_form` with a matching timestamp.

## Fix direction
- Decouple the fill action from its acknowledgment: the tool should get a fast "action applied" ack, with verify as a **separate awaited step that has its own short timeout and cannot hang the whole call**.
- The response promise needs a guard so a lost return rejects fast with a clear reason, not a 30s blind timeout.
- Because the action is **non-idempotent**, never auto-retry on this timeout until the return path is trustworthy. A retry today means a duplicate write.

## Open items (unchanged)
- **BUG-1** (empty-string fill writes "undefined") still unverified — tested with "ClearTest", not an empty string, so the clear behavior remains untested.
- **fast_screenshot consent gate** is real and working (prompted, approved, captured). Confirm whether the gate is intended so it's logged as a feature, not a bug.
