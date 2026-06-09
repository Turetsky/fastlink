# BUG-2 (confirmed): fast_batch does not re-bind the content script to the new document after a navigating step

Severity: **high**. Breaks the common click/submit → navigate → wait pattern inside a batch. Confirmed via claude.ai relay testing under controlled conditions (snapshot before/after every step, tab held in steady foreground). This supersedes the earlier "navigating fast_click never returns its ack" diagnosis, which was **wrong** — the click returns fine; the failure is in the batch's inter-step handling.

## Repro (clean)
`fast_batch([ submit-button fast_click (navigates to a results page), then fast_wait for text on the results page ])`, tab held foreground.
- Filled httpbin.org/forms/post (4/4 fields verified), clicked Submit.
- Submit **did** navigate to httpbin.org/post (snapshot confirms the JSON echo of all submitted fields + both topping checkboxes).
- But step 1's `fast_wait` for the word "form" **timed out at 30s** — even though the word "form" is present in the results-page JSON.

## Cause
After the navigating step, the **next batch step is dispatched to the OLD document's content script**, which was torn down by the navigation. It never re-binds to the new page, so the `fast_wait` listens on the dead page and times out while the target text sits on the new page. `fast_nav` already solves this race with a post-navigation content-script health check (fresh/reinjected/stale); the batch's **inter-step** path never got that fix.

## Sub-bug: willNavigate misprediction
The Submit `fast_click` reported `willNavigate:false`, but it **did** navigate. So a re-bind triggered off the `willNavigate` flag would miss this case — the re-bind must key off **actual** navigation (URL/document change between steps), not the prediction. (Separately, willNavigate should be improved to predict form-submit navigations, but that's secondary.)

## Fix direction
- In the batch loop (local server `runBatch` + relay `runBatch`), after **each** step detect whether the tab actually navigated (compare `location.href` / document identity before vs after the step — do not trust `willNavigate`). If it navigated, **wait for the new document's content script to be ready** (mirror `fast_nav`'s health-check) **before dispatching the next step**, so the next step binds to the new page.
- Extend the existing post-navigation settle to fire on *actual* navigation from any step, not only explicit nav actions.
- Minor: improve `willNavigate` so a form-submit click predicts navigation.

## Session note (diagnostic honesty)
The earlier theories this session — fill response-path hang (BUG-4), per-character typing-loop hang, fast_switch-doesn't-foreground, latency — did **not** reproduce under controlled conditions and were tab-state confusion / test-design artifacts, not tool bugs. Confirmed working: fast_tab/fast_switch (both foreground), fast_fill_form (4/4 verified, twice), non-navigating fast_click, end-to-end form submission, snapshot/status/list, vision tier. Confirmed fixed earlier: BUG-1 (empty-string fill), BUG-3 (pinned-id leak). The only real actionable items are this BUG-2 (batch inter-step re-bind) and the willNavigate misprediction.
