# FastLink

Page snapshots, clicks, console/network capture, and batch browser automation for
Claude, via a paired Chrome extension and an MCP server (packaged as a `.dxt`
Claude Desktop extension).

**Cross-platform:** one codebase runs on Linux, macOS, and Windows. There is no
separate Windows build — the code uses portable APIs (`os.tmpdir()`,
`ELECTRON_RUN_AS_NODE`) that do the right thing on every OS. The only per-OS
difference below is the shell syntax you type to build and install.

The repo has three parts:

| Folder | What it is |
| --- | --- |
| `fast-dxt/` | The MCP server **and** the local WebSocket broker. Packaged into `fastlink.dxt` and installed into Claude Desktop. |
| `fast-ext/` | The Chrome (MV3) extension that pairs with the broker. Loaded unpacked. |
| `fastlink-proxy/` | Optional relay/proxy for remote use. Not required for local automation. |

## How it fits together

```
Claude Desktop ──(stdio)──> MCP server ──(ws://127.0.0.1:9870)──> broker ──(ws://127.0.0.1:9876)──> Chrome extension ──> your tab
```

The MCP server spawns the broker on demand. The broker listens on `9870` for the
MCP server and `9876`/`9877` for the extension.

---

## Prerequisites

- **Node.js ≥ 18** — the `.dxt` runs under Claude Desktop's built-in Node, but you
  need Node locally to install dependencies and build the package.
- **Google Chrome.**
- **Claude Desktop.**

---

## Install

Three steps: build the `.dxt`, install it into Claude Desktop, load the Chrome
extension. The build commands are shown for both shells — pick the one for your OS;
everything else is identical.

### 1. Build the `.dxt`

**Linux / macOS (bash):**

```bash
cd fast-dxt
npm install --omit=dev
npx -y @anthropic-ai/dxt pack . ../fastlink.dxt
```

**Windows (PowerShell):** Node is typically at `C:\Program Files\nodejs\`; adjust if
yours differs.

```powershell
cd fast-dxt
& "C:\Program Files\nodejs\npm.cmd" install --omit=dev
& "C:\Program Files\nodejs\npx.cmd" -y @anthropic-ai/dxt pack . ..\fastlink.dxt
```

### 2. Install into Claude Desktop

Open Claude Desktop → **Settings → Extensions** → **Install extension** and select
`fastlink.dxt` (or drag the file onto the app window). Enable it.

> Recent (cowork) builds of Claude Desktop do **not** read the classic
> `claude_desktop_config.json → mcpServers` block — install through the Extensions
> UI. On install it unpacks to your Claude data dir, e.g.
> `%APPDATA%\Claude\Claude Extensions\…` on Windows or
> `~/.config/Claude/Claude Extensions/…` on Linux.

### 3. Load the Chrome extension

`chrome://extensions` → enable **Developer mode** → **Load unpacked** → select the
`fast-ext/` folder.

### 4. Verify

Start Chrome, then in Claude run `fast_status`. It should report the extension as
connected.

---

## Portability notes

Two assumptions previously made FastLink Linux-only. Both are now handled with
portable APIs that behave correctly on every OS (no `process.platform` branching
needed):

- **Broker spawn.** Under Claude Desktop's built-in Node, `process.execPath` is the
  Electron app (e.g. `Claude.exe`), not a standalone `node`. Spawning it with a
  script argument makes Electron treat it as a file-open / second-instance event (an
  "Attach … to this session?" popup) instead of running the broker. The broker is
  spawned with `ELECTRON_RUN_AS_NODE=1`, which forces the same binary to run as plain
  Node. On Linux/macOS, where `process.execPath` is already real `node`, the variable
  is ignored — same behavior as before.
- **PID file path.** The broker writes its PID to `os.tmpdir()` — `/tmp` on
  Linux/macOS, `%TEMP%` on Windows. (It was previously hardcoded to `/tmp`, which
  resolves to the nonexistent `C:\tmp` on Windows and crashed on startup.)

## Troubleshooting

- **`fast_status` says `ECONNREFUSED 127.0.0.1:9870`** — nothing is listening on the
  broker port. The MCP server spawns the broker lazily; if it can't, check that the
  extension is installed and enabled in Claude Desktop, and restart Claude Desktop so
  it relaunches the server.
- **Extension shows disconnected** — make sure Chrome is running, then open
  `chrome://extensions`, find FastLink, and click its **service worker** link to wake
  it (it connects on port `9876`).
