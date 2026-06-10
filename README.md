# FastLink

FastLink bridges **Claude** (Claude Code, Claude Desktop, or claude.ai web) to a real **Chrome
tab**, so Claude can read page snapshots, click, fill forms, run JS, capture console/network, and
batch-automate the browser the user is actually looking at.

```
Claude  ⇄  MCP server  ⇄  broker (WebSocket)  ⇄  Chrome extension  ⇄  page
```

---

## Install

**See [`docs/INSTALL.md`](docs/INSTALL.md)** — a single, deterministic, cross-platform
(macOS / Windows / Windows+WSL / Linux) guide written to be executed step-by-step by Claude. In
short: install Node ≥ 18, `npm --prefix fast-dxt install`, register the MCP server with Claude
(Claude Code via `claude mcp add`, or Claude Desktop via the `.mcpb`), Load-unpacked the Chrome
extension, then verify with `fast_status`.

---

## Components

### Active (a local install is the first three; the relay is cloud-only)

| Component | Where it runs | What it is |
|---|---|---|
| **`fast-dxt/`** — MCP server + broker | Node, next to Claude | `server/index.js` exposes the `fast_*` tools over MCP (stdio). It **auto-spawns** `broker/index.js`, the WebSocket hub between MCP client(s) and the extension. Also the source of the Claude Desktop `.mcpb` bundle. |
| **`fast-ext/`** — Chrome extension | The user's Chrome | MV3 extension that actually drives the page. Loaded unpacked (Developer mode). |
| **`fastlink-relay/`** — cloud relay | Cloudflare Worker + Durable Objects | **Optional**, only for claude.ai **web** driving the browser. Not part of a local install. Mirrors `fast-dxt/server/tools.js`. |

### Legacy — ignore for development, not part of any install

| Directory | Status |
|---|---|
| `fastlink-cloud-mcp/` | Old Claude-Cloud MCP clone + unrelated scripts. *gitignored.* |
| `fast-ext-dad/` | A 2nd-profile copy of the extension (just sets its broker slot to `secondary`). *gitignored.* |
| `fastlink-proxy/` | Cloud-side auth adapter, superseded by `fastlink-relay/`. |

> **Repo-tidiness recommendation (not performed):** `fastlink-cloud-mcp/` and `fast-ext-dad/` are
> already gitignored; `fastlink-proxy/` is not. To make the repo read clean, consider moving all
> three into a single `legacy/` folder (or gitignoring `fastlink-proxy/` too). This is a
> suggestion only — no files were moved.

---

## Docs

| Doc | Purpose |
|---|---|
| [`docs/INSTALL.md`](docs/INSTALL.md) | Cross-platform, Claude-executable install guide (start here). |
| [`docs/TESTER-INSTALL.md`](docs/TESTER-INSTALL.md) | ~2-minute no-dev-tools tester install that then self-updates. |
| [`docs/AUTO-UPDATE.md`](docs/AUTO-UPDATE.md) | How the update banner + release/pull process keeps the unpacked extension current. |
| [`docs/TOKEN-SECURITY.md`](docs/TOKEN-SECURITY.md) | Cloud-relay device-token auth model and recommended hardening. |

`docs/` also holds design/status notes (scout, speed tiers, vision Set-of-Mark, issue logs).

---

## Repo layout

- `fast-dxt/` — MCP server (`server/`) + auto-spawned broker (`broker/`); tool schemas in
  `server/tools.js`.
- `fast-ext/` — MV3 Chrome extension; action handlers in `src/actions/`.
- `fastlink-relay/` — multi-tenant Cloudflare relay (deploy with `wrangler deploy`).
- `scripts/` — install/update helpers (`install-tester.ps1`, `install-tester.sh`,
  `pull-extension.ps1`, `update-fastlink*.ps1`, `release.sh`, `watch-sync.sh`).
- `docs/` — install + design/status docs. `bench/` — benchmark harnesses.

---

## Notes

- **Ports:** extension slots `9876` (primary) / `9877` (secondary 2nd profile); internal
  MCP↔broker `9870`; optional HTTP transport `9879`.
- **Web Store:** not yet published — use Load-unpacked (Developer mode). Managed/corporate
  machines may block unpacked extensions; see `docs/AUTO-UPDATE.md` for the enterprise route.
- **Optional Gemini key** enables the vision/scout tier (`fast_scout`, `fast_point`,
  `fast_fill_vision`, `fast_do`); everything else works without it.
</content>
