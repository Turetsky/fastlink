# FastLink — Install Guide

> **This guide is written to be executed by Claude (an AI agent) installing FastLink for a user.**
> It is deterministic and per-platform. Follow it top-to-bottom. Where a step branches by OS,
> do **only** the branch that matches the detected environment. Commands are copy-pasteable.

Data path for a local install:

```
Claude  ⇄  MCP server  ⇄  broker (WebSocket)  ⇄  Chrome extension  ⇄  page
```

Two things get installed: **(A)** the Node **MCP server** (which auto-spawns the broker) so
Claude gets the `fast_*` tools, and **(B)** the **Chrome extension** that actually drives the
page. Both must be present and talking to each other.

---

## Step 0 — Detect the environment

Run these and record the answers; later steps branch on them.

```bash
# OS family
uname -s            # Darwin = macOS, Linux = Linux/WSL
# Distinguish native-Linux from Windows+WSL:
grep -qi microsoft /proc/version 2>/dev/null && echo "WSL" || echo "not-WSL"
```

On **native Windows** (PowerShell, no WSL): `node -v` and `where.exe node`.

The three target environments:

| Environment | Where node runs | How config invokes it |
|---|---|---|
| **macOS** | native `node` | `node /abs/path/...` |
| **Windows native** | native `node` (installed in Windows) | `node C:\...\index.js` |
| **Windows + WSL** | `node` inside WSL; Claude/Chrome on Windows | usually `node` with the WSL path (if Claude runs in WSL too), or `wsl.exe -e node /home/...` only when the Claude process is Windows-side |

---

## Step 1 — Prerequisites: Node

The MCP server + broker require **Node ≥ 18** (the repo ships ESM importing
`@modelcontextprotocol/sdk`, `express`, `ws`). Record the **absolute** node path — some
configs hard-code it.

```bash
command -v node && node -v     # macOS / Linux / WSL
# Windows native (PowerShell):
where.exe node ; node -v
```

If Node is missing or < 18, install it first (https://nodejs.org, or `nvm`/`brew`/`winget`),
**in the same environment that will run the server** (macOS shell, Windows shell, or WSL shell —
match where `node` lives).

---

## Step 2 — Clone the repo

```bash
git clone https://github.com/Turetsky/fastlink.git
cd fastlink
```

On **Windows + WSL**, clone inside WSL (e.g. `~/code/Fastlink`) if Claude/node run in WSL.
Record the **absolute repo path** — you'll use it in the MCP config and when loading the extension.

---

## Step 3 — Install server dependencies

From the repo root, in the SAME environment that will run the server:

```bash
npm --prefix fast-dxt install
```

This installs into `fast-dxt/node_modules`. If you skip it, the server exits immediately with
`Cannot find module '@modelcontextprotocol/sdk'` (or `express` / `ws`).

---

## Step 4 — Register the MCP server with Claude

The server is launched **by Claude**, not by you. The only thing that differs per OS is **how
`node` is invoked**. Do the sub-step for the surface in use (Claude Code and/or Claude Desktop).

### 4a. Claude Code (CLI) — all platforms

Use `claude mcp add`, or edit `~/.claude.json` directly.

**macOS / Windows-native / Claude-Code-in-WSL** (native node, direct path):

```bash
claude mcp add fastlink node /ABSOLUTE/PATH/TO/Fastlink/fast-dxt/server/index.js
```

**Windows-side Claude reaching a WSL node** (only when the Claude process is on Windows and node
lives in WSL — *not* needed if Claude Code itself runs inside WSL):

```bash
claude mcp add fastlink wsl.exe -- -e node /home/<user>/code/Fastlink/fast-dxt/server/index.js
```

Equivalent `~/.claude.json` entry (proven-working local form — `node` direct, absolute server
path, optional HTTP flags, optional env):

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
    "GEMINI_API_KEY": "<optional, see Step 7>"
  }
}
```

The `--http` / `--http-port=9879` flags are **optional** (they expose an HTTP transport; the
default stdio transport works without them). After editing config, restart Claude Code or run
`/mcp` to reconnect.

### 4b. Claude Desktop (.mcpb bundle)

The bundle is `fast-dxt/` (manifest + `server/`); the built artifact is `fast-dxt/fastlink.mcpb`.
The **shipped** `fast-dxt/manifest.json` is **portable** — it invokes node directly:

```json
"mcp_config": {
  "command": "node",
  "args": ["${__dirname}/server/index.js"]
}
```

This is correct for **macOS** and **Windows-native** as-is — **do not change it**. Install the
`.mcpb` by double-clicking it / dragging it into Claude Desktop's Extensions settings.

**Windows + WSL special case:** Claude Desktop runs on Windows but node + the repo live in WSL.
In that one configuration, after installing the `.mcpb`, edit the **installed** copy's
`manifest.json` (at the Claude Extensions install dir, e.g.
`…/Claude/Claude Extensions/local.mcpb.<id>.fastlink/manifest.json`) to wrap with `wsl.exe`:

```json
"mcp_config": {
  "command": "wsl.exe",
  "args": ["-e", "node", "/home/<user>/code/Fastlink/fast-dxt/server/index.js"]
}
```

Do this **only** on Windows+WSL. Keep the repo's shipped manifest portable so macOS /
native-Windows installs work out of the box.

> The broker **auto-spawns** when the server first needs it (detached) and is reused if already
> running — you never start it by hand. Ports: extension slots **9876** (primary) / **9877**
> (secondary 2nd Chrome profile), internal MCP↔broker **9870**, optional HTTP **9879**. The
> broker binds `0.0.0.0`, multiplexes all MCP clients onto one extension socket, and self-exits
> after ~60s idle.

---

## Step 5 — Install the Chrome extension

Two parts: **load it unpacked once**, then **set up the auto-updater** so the on-disk files keep
themselves current.

### 5a. Load unpacked (one-time, all platforms)

1. Open `chrome://extensions`.
2. Toggle **Developer mode** ON (top-right). *Required* — FastLink is not (yet) in the Web Store.
3. Click **Load unpacked** → select the extension folder.
   - **macOS / Linux / Windows-native:** point at the repo's **`fast-ext/`** folder directly. A
     `git pull` then updates the extension in place.
   - **Windows + WSL:** Chrome cannot reliably load from a `\\wsl$\…` path. Use the auto-updater
     (5b) to populate a **Windows** folder (default `C:\Users\<you>\FastLink\extension`) and load
     **that** copy.
4. The toolbar icon appears: **red** until an MCP client connects, **yellow** at 1 client,
   **green** at 2+.

**Reload rule:** any change to extension source requires a reload at `chrome://extensions`
(circular reload arrow on the FastLink card). Content scripts only re-inject on reload + page
refresh.

> **Managed / corporate machines** may block unpacked extensions by policy
> (`BlockExternalExtensions`, no Developer mode). On those, Load-unpacked will fail — the path
> forward is the Chrome Web Store listing (TBD) or an enterprise force-install policy
> (`ExtensionInstallForcelist` with a signed `.crx`). See `docs/AUTO-UPDATE.md` "Option 2".

### 5b. Auto-updater (keeps the folder current with zero clicks afterward)

Run the installer for the detected OS. It downloads the current extension into the target folder
and schedules a background pull so it stays current; the extension then notices the new version
and reloads itself. (Details: `docs/TESTER-INSTALL.md`, `docs/AUTO-UPDATE.md`.)

- **Windows (native or for the WSL Windows-side copy):**

  ```powershell
  powershell -ExecutionPolicy Bypass -File scripts\install-tester.ps1
  ```

  Default install folder `C:\Users\<you>\FastLink\extension` (override with `-ExtDir`). Uninstall
  with `... install-tester.ps1 -Uninstall -RemoveFiles`.

- **macOS / Linux:**

  ```bash
  bash scripts/install-tester.sh
  ```

  > `scripts/install-tester.sh` is the macOS/Linux counterpart of the PowerShell installer (being
  > added alongside `scripts/install-tester.ps1`). If it is not yet present, skip this sub-step and
  > update by `git pull` in the repo, then reload at `chrome://extensions`.

After 5b, load-unpacked (5a) the folder the installer populated. From then on updates land in the
background and the extension reloads itself — no further `chrome://extensions` visits.

---

## Step 6 — Verify

1. Chrome is open with at least one normal `http(s)://` tab; the FastLink extension is loaded
   (icon visible).
2. In Claude, call **`fast_status`**. Expect `connected: true` and an extension client count ≥ 1.
3. Smoke test: `fast_snapshot` (or `fast_scout`) on the active tab returns page content.

If `fast_status` shows not-connected, see Troubleshooting below.

---

## Step 7 — Optional: Gemini API key (vision / scout tier)

`fast_scout`, `fast_point`, `fast_fill_vision`, `fast_do` use a fast multimodal model. Without a
key they report `disabled`; everything else works.

- Get a **free** key: https://aistudio.google.com/apikey
- Provide it either way:
  - Set `GEMINI_API_KEY` in the MCP `env` (Step 4a JSON), **or**
  - Put `GEMINI_API_KEY=...` in `~/fastlink-secrets.txt` (the portable default the server reads;
    override the path with `FASTLINK_SECRETS_FILE`).

Default model is `gemini-2.5-flash-lite` (override with `FASTLINK_GEMINI_MODEL`).

---

## Step 8 — Optional: second Chrome profile (slots)

To drive two Chrome profiles without collision, install the extension in the 2nd profile and set
its **Broker slot** to `secondary` on the extension's **options page** → it uses port `9877`
instead of the default `9876`. No source edits. A fresh install is `primary` (9876) with zero
config.

---

## Troubleshooting

1. **`wsl.exe` wrapper on a non-WSL machine** (server never starts on macOS / Windows-native).
   - Check: is the MCP `command` literally `wsl.exe` while `uname -s` is `Darwin` or you're on
     native Windows with no WSL? Then it's wrong.
   - Fix: use `command: "node"` with the absolute server path. Reserve `wsl.exe -e node` for the
     Windows-side-Claude→WSL-node case only.

2. **Missing Node deps** — server exits with `Cannot find module '@modelcontextprotocol/sdk'`
   (or `express`/`ws`).
   - Fix: `npm --prefix fast-dxt install` in the environment where node runs.

3. **Hardcoded foreign paths** (`/mnt/c/Users/<someone>/…`, `/tmp/…`).
   - Shipped defaults are portable: secrets `~/fastlink-secrets.txt` (`os.homedir()`),
     screenshots/PID/timing in `os.tmpdir()`. Check: `grep -rn -e '/mnt/c' -e "'/tmp/" fast-dxt
     fast-ext` should return nothing in shipped code.

4. **Hardcoded WSL VM IP** leaked in `HOSTS` (`fast-ext/src/connection.js`).
   - Shipped default is `HOSTS = ['127.0.0.1']`. WSL-only: if localhost-forwarding breaks after a
     Windows sleep, run `restart-wsl.bat` (the real cure), or as a stopgap append the current WSL
     VM IP (`ip addr show eth0`). Do **not** commit a machine-specific IP.

5. **Extension not reloaded after an edit** — changes have no effect / tools time out.
   - Fix: reload at `chrome://extensions`, then refresh the target tab. On Windows+WSL, also
     re-sync `fast-ext/` to the Windows folder Chrome loads.

6. **Two brokers / wrong-side broker (Windows+WSL)** — separate localhost stacks.
   - Ensure every MCP session reaches the **same** broker (the WSL one is the shared default).
     Compare the `fast_status` client count between the extension's broker and your Claude session.

---

## Platform-specific helper files

- `restart-wsl.bat` — **WSL-only** recovery helper (WSL shutdown + restart). Ignore on
  macOS / Windows-native.
- `scripts/update-fastlink.ps1` (WSL dev box), `scripts/update-fastlink-windows.ps1` (pure
  Windows), `scripts/pull-extension.ps1` (downloads the extension, used by the installer) — see
  `docs/AUTO-UPDATE.md`.
- `fastlink-cloud-mcp/`, `fast-ext-dad/`, `fastlink-proxy/` — **legacy**, not part of a fresh
  install (see the README component map).
</content>
</invoke>
