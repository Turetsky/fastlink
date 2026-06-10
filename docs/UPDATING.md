# Keeping FastLink up to date

This is the canonical guide for updating an **unpacked** FastLink install (the
Chrome extension + the local MCP server). FastLink isn't in the Chrome Web
Store, so Chrome will never silently swap in a new version — you keep it current
yourself. The recommended way is **git**.

> **TL;DR — the recommended default for every unpacked install (dev, tester,
> managed machine, any OS):** `git clone` the repo, **Load unpacked from
> `<clone>/fast-ext` directly**, and keep it current with `git pull` (or the
> `update-extension-git.*` wrapper). Because Chrome reads that folder in place, a
> pull updates the extension where it already sits — no download, no file-swap,
> no scheduled task. The extension then self-reloads on the next release version
> bump.

There are three ways to update, in order of preference:

1. **Git (recommended, default)** — `git pull` on a clone Chrome loads directly.
2. **Download + swap (fallback, no git)** — the `pull-extension.*` worker + the
   `install-tester.*` background scheduler. Works without git, but can trip
   AV/EDR (see below).
3. **Chrome Web Store** — for truly non-technical / public users (when listed).

---

## 1. Git — the recommended default (any OS)

### Why this is the default

- **One trusted tool.** `git` is a signed, whitelisted developer tool. A plain
  `git pull` over HTTPS is something endpoint protection (Bitdefender, Microsoft
  Defender, other EDR) already trusts — it does **not** trip AV.
- **Simpler.** Chrome loads the extension straight from the clone's `fast-ext`
  folder, so `git pull` updates the files **in place**. There is no archive
  download, no atomic file-swap into a browser-extension folder, and no
  Scheduled Task / cron / launchd job — i.e. none of the moving parts the
  download-swap path needs (and none of the parts AV flags).
- **Self-finishing.** On the next release **version bump**, the extension's own
  service worker calls `chrome.runtime.reload()` and Chrome re-reads the
  freshly-pulled folder from disk. That reload is Chrome's own behavior, driven
  from inside the extension — no external process touches Chrome, so it is
  **AV-immune**.

> **The strongest motivator:** on a machine with Bitdefender / Defender / other
> EDR, the download-swap path (method 2) is exactly the pattern AV heuristics
> flag — download a zip from the internet + modify a browser-extension folder +
> register a persistence task reads like a dropper. The git path avoids all of
> that. But the git path is recommended for **everyone**, not just locked-down
> machines — it's also just less machinery.

### One requirement: git must be installed

This is the only prerequisite. Git is widely available and a one-time install:

- **Windows:** Git for Windows — https://git-scm.com/download/win (or
  `winget install Git.Git`).
- **macOS:** `git` ships with the Xcode Command Line Tools (`xcode-select
  --install`), or `brew install git`.
- **Linux:** your package manager, e.g. `sudo apt install git`.

Verify: `git --version`.

### Setup (once)

1. **Clone the repo:**

   ```bash
   git clone https://github.com/Turetsky/fastlink.git
   ```

2. **Load unpacked from the clone directly.** Open `chrome://extensions`, turn
   **Developer mode** ON (top-right), click **Load unpacked**, and select the
   clone's **`fast-ext`** folder — e.g. `C:\Users\you\fastlink\fast-ext` (Windows)
   or `~/fastlink/fast-ext` (macOS/Linux). Point Chrome at that folder **itself**,
   not a copy of it — that's what makes a later `git pull` update the live
   extension in place.

   > **Windows + WSL caveat:** Chrome cannot reliably load from a `\\wsl$\…`
   > path. If your clone lives in WSL, either clone again on the **Windows** side
   > and load from there, or use the download-swap fallback (method 2) to
   > populate a Windows folder.

### Update (whenever a new version is out)

Run the AV-safe updater for your OS — it does only a fast-forward `git pull`:

- **Windows:**

  ```powershell
  powershell -ExecutionPolicy Bypass -File scripts\update-extension-git.ps1
  ```

- **macOS / Linux:**

  ```bash
  bash scripts/update-extension-git.sh
  ```

Both default `-RepoPath` / `--repo-dir` to the repo the script lives in, so you
can run them from the clone with no arguments. They refuse to run on a dirty
working tree or a diverged branch (clear message instead of a forced merge).
Plain `git -C <clone> pull --ff-only` does the same thing if you prefer.

**Wire it into login / the `claude` wrapper (optional, fully hands-off).** Both
scripts take a `-Quiet` / `--quiet` flag that suppresses normal output so they
drop cleanly into an existing login script or the `claude` launcher wrapper —
the extension stays current every time you start a session, with no extra step.

```bash
# in a login script / claude wrapper
bash /path/to/fastlink/scripts/update-extension-git.sh --quiet
```

After a pull, the extension is current on disk. It **self-reloads on the next
release version bump**; to apply an update immediately, open `chrome://extensions`
and click the reload arrow on FastLink (Chrome can't reload an unpacked
extension on its own).

> **MCP server note:** a `git pull` also updates `fast-dxt/` (the MCP server). If
> the server runs standalone here, restart it / re-run `claude` so it picks up
> the new server code, and run `npm --prefix fast-dxt install` if its
> dependencies changed. (The git updater stays pure-git and does **not** run npm
> — keeping its footprint to a single trusted command is the point. The heavier
> `update-fastlink-windows.ps1` does include the npm step if you want it.)

---

## 2. Download + swap — the fallback when git isn't installed

If you can't install git, FastLink ships a no-git updater that downloads the
latest `fast-ext` and atomically swaps it into the loaded folder, plus an
installer that schedules it to run in the background:

- **Setup + background scheduler:** `scripts/install-tester.ps1` (Windows) /
  `scripts/install-tester.sh` (macOS/Linux) — see `docs/TESTER-INSTALL.md`.
- **One-shot pull:** `scripts/pull-extension.ps1` / `scripts/pull-extension.sh`.

This works with zero developer tools, and the self-reload still applies. **But**
it downloads an archive from the internet, swaps files into a browser-extension
folder, and registers a Scheduled Task / cron / launchd job — the exact pattern
that endpoint protection (Bitdefender / Defender / EDR) tends to block or
quarantine. On a managed/AV machine, prefer method 1 (git). Use this fallback
only where installing git isn't an option.

---

## 3. Chrome Web Store — for non-technical / public users

For users who shouldn't be running Developer-mode unpacked extensions at all —
or on hyper-locked corporate policies that block unpacked extensions entirely
(no Developer mode, `BlockExternalExtensions`) — the only path is the **Chrome
Web Store** listing (TBD) or an enterprise force-install policy
(`ExtensionInstallForcelist` with a signed `.crx` + hosted `update_url`). Chrome
then updates silently on its own. That's the heaviest setup; see
`docs/AUTO-UPDATE.md` "Fallback B (enterprise / Web Store)".

---

## The hard Chrome constraint

Chrome **will not silently reload an unpacked extension** on command — there's no
API for an extension to reinstall itself from disk on demand. The version-bump
self-reload above is the most automation possible for unpacked installs; an
immediate update still ends in a manual reload at `chrome://extensions`. This is
a Chrome security boundary, not a FastLink limitation. The only fully-silent
route is the Web Store / enterprise policy (method 3).
