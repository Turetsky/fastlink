# BUG-5: with two install slots connected, the MCP can't target a specific profile — it pins to `primary`

Severity: **high**. Blocks driving a second Chrome profile while the first is still connected. Hit live on 2026-06-21 while driving an Oracle signup in a `secondary`-slot profile.

> **STATUS: fixed 2026-06-21** (fast-dxt) — added `fast_profile` (sticky per-session routing, fix direction 2) + envelope-tagged dispatch (fix direction 1's plumbing) + deterministic broker routing with a clear "not connected" error (fix direction 3). Takes effect after a broker + MCP-server restart. Implementation notes at the bottom. Relay (option 4) intentionally untouched — slots are a local-broker concept.

## Symptom
Two Chrome profiles are connected at once — `primary` (slot 9876) and `secondary` (slot 9877). `fast_status` confirms **both** `installs.primary.connected` and `installs.secondary.connected` are true, with `routedInstall: "primary"`. The target work is in the `secondary` profile (ytx), but:
- `fast_snapshot` / `fast_list` reads come back from **`primary`** (e.g. `origin: https://www.facebook.com`, the main profile), even though the page I want is in `secondary`.
- Reads and writes appear to land on **different** installs inter-call — a `fast_fill_form` reached `secondary` (the field actually filled, user-confirmed), while the very next `fast_snapshot` reported `primary` (paused). So routing is not just pinned, it's **inconsistent across calls**.
- When `primary` is paused/backgrounded, every read errors `"Paused by the user — driving is stopped"` with the `primary` origin, and there is **no way from the MCP/tool side to say "talk to secondary instead."**

## Root cause
There is no **routed-install selector** exposed to the MCP client. The broker knows both installs (`EXT_PORTS` in `fast-dxt/broker/state.js`, consumed by `extBridge.js`), and the extension reports its slot in the `hello` (`chrome.storage.local.fastlinkInstallId`, default `primary`). But:
- The MCP→broker request path carries **no install target**, so the broker dispatches to a default (`primary`).
- Tools (`fast-dxt/server/tools.js`) have **no `install` / `profile` parameter**, and there's no broker command to set an "active install."
- Result: once both slots are live, `primary` wins everything and `secondary` is unreachable from the tools, regardless of which profile actually holds the target tab.

The inconsistency (write→secondary, read→primary in adjacent calls) suggests the dispatch may also be racing/load-balancing across connected ext sockets rather than deterministically pinning — needs confirmation (see tests).

## Current workaround
None clean. The only lever the user has is to **drop the `primary` connection entirely** (disconnect FastLink on the main profile, or quit that Chrome profile) so the broker falls through to the single remaining install. Note: disconnecting **only the cloud relay** is insufficient — the WSL MCP reaches the browser over the **local broker WS** (`primary` = 9876), so the broker leg must drop too.

## Fix direction
1. **Per-call install target.** Add an optional `install` arg (`"primary"` | `"secondary"`) to the tool schemas in `fast-dxt/server/tools.js` (mirror in `fastlink-relay/tools.js`). Thread it through the MCP→broker request envelope so the broker dispatches to the matching ext socket. Absent arg → current default.
2. **Sticky active-install on the broker.** Add a broker command (e.g. `fast_profile` or a field on `fast_status`) to set/read the routed install, so a session can switch once instead of tagging every call. Persist for the session in broker state.
3. **Deterministic dispatch.** Ensure a request routes to exactly the targeted install's socket — never round-robins across connected sockets. Audit `extBridge.js` dispatch for the write→secondary / read→primary split observed here.
4. **Surface the choice in the popup** (nice-to-have): a "drive this profile" toggle that maps to the slot, so the user has a UI lever symmetric with the options-page Broker slot card.

## Tests to isolate
1. Connect both slots. Call `fast_snapshot` 5× back-to-back with no other action; log `origin` each time. If it alternates primary/secondary, dispatch is racing, not pinning → confirms (3).
2. With both connected, add a temporary hard-coded `install: "secondary"` in the broker request and verify reads come from `secondary` deterministically. Proves the envelope plumbing is the missing piece.
3. Check the broker (`fast-dxt/broker/`) for whether it tracks one ext socket or a set, and whether MCP requests are tagged with a target. Confirms where the arg must be threaded.

## Related
- Install-slot scheme: see `Fastlink/CLAUDE.md` → "Install slots (run two Chrome profiles without colliding)".
- Same response-path fragility family as **BUG-4** (action applies but ack routing is unreliable) — worth checking if the dispatch audit overlaps.

## What was implemented (2026-06-21)
Server-side sticky selection, tagged onto every call envelope — chosen over broker-side sticky state so the pin survives the MCP↔broker socket reconnecting (it does, after host sleep) and a broker restart. Per-session by construction: each MCP server process holds its own selection, so concurrent Claude sessions don't stomp each other.

- **`fast_profile` tool** (`server/tools.js`, handler `handleUseInstall` in `server/handlers.js`): `install: "primary" | "secondary" | "auto"`. Sets/clears `selectedInstall` in `server/brokerClient.js`. Returns the slot's connected state + a hint; warns if you pin an unconnected slot.
- **Envelope tagging** (`server/brokerClient.js`): `callExtension` adds `install: selectedInstall` to every `{type:'call'}` when a pin is set; omits it for auto (back-compat — an old broker ignores the extra field).
- **Deterministic broker dispatch** (`broker/router.js` `dispatchCall` + `broker/mcpBridge.js`): an explicit `install` routes to exactly that slot's socket via `state.getSocketForInstall`, with NO fallback — an unconnected/unknown target returns a clear error (`installs` snapshot included), never silently lands on `primary`. Absent `install` keeps the old auto path (`getExtensionSocket` = ACTIVE-then-any).
- **`fast_status`** now reports `selectedInstall` and, when >1 slot is connected, hints to use `fast_profile`.

Re the write→secondary / read→primary inconsistency (test #1): with both legs now pinned to one slot per session, adjacent calls are deterministic. If a split still shows up it points at the cloud-relay leg driving in parallel, not the local dispatch.
