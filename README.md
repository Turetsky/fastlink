# FastLink

FastLink bridges **Claude** (Claude Code, Claude Desktop, or claude.ai web) to a real **Chrome tab**, so Claude can read page snapshots, click, fill forms, run JS, capture console/network, and batch-automate the browser the user is actually looking at.

> **This README is written to be executed by Claude (an AI agent) installing FastLink for a user.** It is deterministic and per-platform. Follow it top-to-bottom. Where a step branches by OS, do only the branch that matches the detected environment.

---

## Components

| Component | Where it runs | What it is |
|---|---|---|
| **Chrome extension** (`fast-ext/`) | The user's Chrome | MV3 extension that actually drives the page. Loaded unpacked. |
| **MCP server** (`fast-dxt/server/index.js`) | Node, next to Claude | Exposes the `fast_*` tools to Claude over MCP (stdio). |
| **Local broker** (`fast-dxt/broker/index.js`) | Node, **auto-spawned** by the server | WebSocket hub between MCP server(s) and the extension. You never start it by hand. |
| **Cloud relay** (`fastlink-relay/`) | Cloudflare (optional) | Only needed for claude.ai **web** driving the browser. Not part of a local install. |

Data path for a local install: `Claude ⇄ MCP server ⇄ broker (WS) ⇄ Chrome extension ⇄ page`.

---

## Step 0 — Detect environment and locate Node

Run these and record the answers; later steps branch on them.

```bash
# OS
uname -s            # Darwin = macOS, Linux = Linux/WSL
# Distinguish native-Linux vs WSL:
grep -qi microsoft /proc/version 2>/dev/null && echo "WSL" || echo "not-WSL"
# Node (must be >= 18). Record the ABSOLUTE path — you'll hard-code it in config.
command -v node && node -v
```

On **native Windows** (PowerShell, no WSL): `node -v` and `where.exe node`.

Three target environments this README supports:

- **macOS** — native `node`.
- **Windows native** — native `node` (Node installed in Windows).
- **Windows + WSL** — Claude/Chrome on Windows, Node inside WSL → invoke via `wsl.exe -e node`.

**Install Node ≥ 18 first if missing.** Then install server dependencies (the repo ships ESM that imports `@modelcontextprotocol/sdk`, `express`, `ws`):

```bash
# from the repo root, in the SAME environment that will run the server
# (macOS shell, Windows shell, or WSL shell — match where `node` lives)
npm --prefix fast-dxt install
```

---

## Step 1 — Install the Chrome extension (all platforms)

1. Open `chrome://extensions`.
2. Toggle **Developer mode** ON (top-right).
3. Click **Load unpacked** → select the **`fast-ext/`** folder of this repo.
   - On **Windows + WSL**, Chrome runs on Windows and cannot reliably load from a `\\wsl$\…` path. Copy `fast-ext/` to a Windows path (e.g. `C:\Users\<you>\FastLink\extension\`) and load *that* copy. **After any later edit to `fast-ext/`, re-copy the changed files AND reload the extension** — editing only the WSL copy does nothing.
4. The toolbar icon appears. It is **red** until an MCP client connects, **yellow** at 1 client, **green** at 2+.

> Web Store listing: **TBD** (not yet published — use Load unpacked for now).

**Reload rule:** any change to extension source (`fast-ext/`) requires a reload at `chrome://extensions` (click the circular reload arrow on the FastLink card). Content scripts are only re-injected on reload + page refresh.

---

## Step 2 — Configure the MCP server

The server is launched by Claude. The **only** thing that differs per OS is **how `node` is invoked**.

### 2a. Claude Code (CLI) — all platforms

Use `claude mcp add`, or edit `~/.claude.json` directly. Pick the invocation for the detected OS:

**macOS / Windows-native** (native node):

```bash
claude mcp add fastlink node /ABSOLUTE/PATH/TO/Fastlink/fast-dxt/server/index.js
```

**Windows + WSL** (node lives in WSL; Claude Code itself usually runs inside WSL too — in that case use the macOS/native form with the WSL path). Only use the `wsl.exe` wrapper when the Claude process is on the **Windows** side and must reach into WSL:

```bash
# Windows-side Claude reaching a WSL node:
claude mcp add fastlink wsl.exe -- -e node /home/<user>/code/Fastlink/fast-dxt/server/index.js
```

Equivalent `~/.claude.json` entry (this is the proven-working local form — note `node` direct, absolute server path, optional HTTP flags, and env):

```json
"fastlink": {
  "type": "stdio",
  "command": "node",
  "args": [
    "/ABSOLUTE/PATH/TO/Fastlink/fast-dxt/server/index.js",
    "--http",
    "--http-port=9879"
  ],
  "env": {
    "FASTLINK_TOKEN": "<optional shared secret>",
    "GEMINI_API_KEY": "<optional, see Step 4>"
  }
}
```

After editing config, restart Claude Code (or `/mcp` reconnect).

### 2b. Claude Desktop (.mcpb bundle)

The bundle is `fast-dxt/` (manifest + `server/`). The **shipped** `fast-dxt/manifest.json` is **portable** — it invokes node directly:

```json
"server": {
  "type": "node",
  "entry_point": "server/index.js",
  "mcp_config": {
    "command": "node",
    "args": ["${__dirname}/server/index.js"]
  }
}
```

This is correct for **macOS** and **Windows-native** as-is — do **not** change it.

**Windows + WSL special case:** Claude Desktop runs on Windows but the user's Node + this repo live in WSL. In that one configuration, after installing the `.mcpb`, edit the **installed** copy's `manifest.json` (at the Claude Extensions install dir, e.g. `…/Claude/Claude Extensions/local.mcpb.<id>.fastlink/manifest.json`) to wrap with `wsl.exe`:

```json
"mcp_config": {
  "command": "wsl.exe",
  "args": ["-e", "node", "/home/<user>/code/Fastlink/fast-dxt/server/index.js"]
}
```

Do this **only** on Windows+WSL. Keep the repo's shipped manifest portable so macOS / native-Windows installs work out of the box.

---

## Step 3 — The broker (auto-spawns; nothing to start)

- The MCP server **auto-spawns** the broker on first need (`fast-dxt/server/brokerClient.js` → `process.execPath … broker/index.js`, detached). If one is already listening, it reuses it.
- **Ports:**
  - Extension-facing slots: **primary `9876`**, **secondary `9877`** (a 2nd Chrome profile). The slot is chosen in the extension's options page (stored as `fastlinkInstallId`), no source edit needed — a fresh install is `primary`.
  - MCP↔broker internal port: `9870`. Optional HTTP transport: `9879`.
- The broker binds `0.0.0.0` and multiplexes **all** MCP clients to the same extension socket, so multiple Claude sessions can drive one browser. It self-exits after 60s idle.

**Second profile:** install the extension in the 2nd Chrome profile, set its slot to `secondary` in the options page → it uses port `9877`. No code edits.

---

## Step 4 — Optional: Gemini API key (vision / scout tier)

`fast_scout`, `fast_point`, `fast_fill_vision`, `fast_do` use a fast multimodal model. Without a key these tools report `disabled` but everything else works.

- Get a **free** key: https://aistudio.google.com/apikey
- Provide it either way:
  - Set `GEMINI_API_KEY` in the MCP `env` (Step 2a JSON), **or**
  - Put `GEMINI_API_KEY=...` in `~/fastlink-secrets.txt` (the portable default the server reads; override path with `FASTLINK_SECRETS_FILE`).

---

## Step 5 — Verify

1. Chrome open with at least one normal `http(s)://` tab; FastLink extension loaded.
2. In Claude, call **`fast_status`**. Expect `connected: true` and an extension client count ≥ 1.
3. Quick smoke test: `fast_snapshot` (or `fast_scout`) on the active tab returns page content.

If `fast_status` shows not-connected, work the troubleshooting checklist below.

---

## Troubleshooting / known pitfalls

These are the exact failure modes from a prior install. Each has a check Claude can run.

1. **`wsl.exe` wrapper on a non-WSL machine** (server never starts on macOS / Windows-native).
   - Check: is the MCP `command` literally `wsl.exe` while `uname -s` is `Darwin`, or you're on native Windows with no WSL? If so it's wrong.
   - Fix: use `command: "node"` with the absolute server path. Reserve the `wsl.exe -e node` form for the Windows+WSL case **only** (Step 2b special case).

2. **Hardcoded foreign paths** (e.g. `/mnt/c/Users/<someone>/…`, `/tmp/…`).
   - These were removed from shipped defaults: secrets file now defaults to `~/fastlink-secrets.txt` (`os.homedir()`), screenshots/PID/timing files use `os.tmpdir()` (→ `%TEMP%` on Windows, `/tmp` elsewhere).
   - Check: `grep -rn -e '/mnt/c' -e "'/tmp/" fast-dxt fast-ext` should return nothing in shipped code (comments aside). If you added a path, make it `os.homedir()`/`os.tmpdir()`/env-based.

3. **Hardcoded WSL VM IP** (a private `172.x.y.z` leaked in `HOSTS`).
   - The shipped default in `fast-ext/src/connection.js` is now `HOSTS = ['127.0.0.1']` only. The failover mechanism is preserved (each non-opening dial rotates to the next host).
   - WSL-only: if localhost-forwarding breaks after a Windows sleep, either run `restart-wsl.bat` (the real cure — **WSL-only helper script**) or, as a stopgap, append the current WSL VM IP: `HOSTS = ['127.0.0.1', '172.x.y.z']` (get it with `ip addr show eth0` in WSL). Do **not** commit a machine-specific IP.

4. **Content script / extension not reloaded after an edit.**
   - Symptom: code changes have no effect; tools time out or behave like the old version.
   - Fix: reload at `chrome://extensions` (reload arrow on the FastLink card), then refresh the target tab. On Windows+WSL, also re-copy `fast-ext/` to the Windows path that Chrome actually loads.

5. **Two brokers / wrong-side broker (Windows+WSL).**
   - Windows and WSL have separate localhost stacks. If an MCP session on the Windows side spawns its own broker, it won't see the WSL-reached extension.
   - Fix: ensure every MCP session reaches the **same** broker (the WSL one is the shared default in this repo's setup). Check `fast_status` client count — the extension and your Claude session must show on the same broker.

6. **Missing Node deps.**
   - Symptom: server exits immediately with `Cannot find module '@modelcontextprotocol/sdk'` (or `express`/`ws`).
   - Fix: `npm --prefix fast-dxt install` in the environment where node runs.

---

## Platform-specific helper files

- `restart-wsl.bat`, `restart-wsl` references — **WSL-only** recovery helpers. Ignore on macOS / Windows-native.
- `fastlink-cloud-mcp/`, `fastlink-proxy/` — legacy/secondary copies; **not** part of a fresh install.
