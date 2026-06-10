# FastLink auto-update (notify + pull)

FastLink is a **self-distributed unpacked Chrome extension** plus a Node MCP
server. It is not in the Chrome Web Store, so Chrome will never silently swap in
a new version. Instead we do the next best thing: the extension **notices** when
a newer version has been published and **tells you**, and a one-command updater
**pulls** it down. This doc explains how the pieces fit together.

> **The recommended update path is git.** For step-by-step setup (clone → Load
> unpacked from the clone → `git pull`), see the canonical guide
> **[`docs/UPDATING.md`](UPDATING.md)**. This doc covers the underlying
> mechanics: the in-extension detector, the release process, and both the
> primary (git) and fallback (download-swap) install methods.

There are three parts:

1. The in-extension **detector** (already built — banner + desktop notification).
2. The **release process** that publishes a newer version for it to detect.
3. The per-machine **update** steps that actually install it.

---

## 1. How the "Update available" banner detects a new version

`fast-ext/src/updateCheck.js` runs inside the extension's service worker. About
**every 6 hours** (and on startup/install) it asks the public repo
`github.com/Turetsky/fastlink` what the latest version is and compares it to the
version the user is currently running (`chrome.runtime.getManifest().version`).

It checks two sources, in order:

1. **PRIMARY — GitHub Releases API:**
   `api.github.com/repos/Turetsky/fastlink/releases/latest` → `tag_name`
   (a leading `v` is stripped, so tag `v0.5.0` → version `0.5.0`).
2. **FALLBACK — raw manifest on `main`:**
   `raw.githubusercontent.com/Turetsky/fastlink/main/fast-ext/manifest.json` →
   `.version`. Used when there are no releases yet, or the API is rate-limited.

If the latest version is **newer** than the running one, the extension:

- stores a record in `chrome.storage.local` that the **popup banner** reads
  ("Update available — vX.Y.Z"), and
- fires **one** desktop notification for that version.

It is **notify-only**. It cannot install the update itself (see the Chrome
constraint at the bottom). The user still pulls + reloads.

> Key takeaway: the banner only fires when the published version is **higher**
> than what's installed. If nobody bumps the version, the banner never appears.

---

## 2. The release process (this is what makes the banner fire)

Run the release script from the WSL/Linux repo:

```bash
scripts/release.sh [patch|minor|major|X.Y.Z]
```

- No argument → **patch** bump (e.g. `0.4.0` → `0.4.1`).
- `minor` → `0.4.0` → `0.5.0`; `major` → `0.4.0` → `1.0.0`.
- Or pass an exact version, e.g. `scripts/release.sh 0.6.2`.

What it does:

1. Reads the current version from `fast-ext/manifest.json`.
2. Writes the bumped version back into `fast-ext/manifest.json`
   (only that one line — nothing else in the JSON changes).
3. Commits `Release vX.Y.Z`, creates an **annotated tag** `vX.Y.Z`, and pushes
   the commit **and** the tag: `git push origin <branch> --follow-tags`.
4. If the GitHub CLI `gh` is installed and logged in, it also publishes a
   **GitHub Release** for the tag — that lights up the detector's PRIMARY
   (Releases-API) path. If `gh` isn't available, the pushed tag plus the
   updated raw `main` manifest still drive the banner via the FALLBACK path.
   The script prints which path will be used.

Safety: the script refuses to run on a **dirty** working tree (commit/stash
first, or pass `--allow-dirty`), and refuses to reuse an existing tag.

> Note: `fast-dxt/manifest.json` has its own, separate version (the MCP
> server / `.mcpb`). The update banner does **not** read it, so `release.sh`
> leaves it alone. Bump it by hand if you cut an MCP-server release.

**No bump = no banner.** Publishing a higher version is the entire trigger.

---

## 3. Updating each machine

After a release is out, each machine pulls it. The **recommended default for all
unpacked installs (any OS)** is the git method; a no-git download-swap fallback
and the WSL dev-box flow follow.

### Primary — git (recommended, AV-safe; see `docs/UPDATING.md`)

Clone the repo and **Load unpacked from the clone's `fast-ext` folder directly**
(e.g. `C:\Users\you\fastlink\fast-ext` or `~/fastlink/fast-ext`). Because Chrome
reads that folder in place, a `git pull` updates the extension where it already
sits — no archive download, no atomic file-swap, no Scheduled Task. `git` is a
signed, trusted tool, so this does **not** trip endpoint protection
(Bitdefender / Defender / EDR). The only requirement is that **git is
installed** (one-time; see `docs/UPDATING.md` for per-OS install).

To update, run the pure-git updater:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\update-extension-git.ps1   # Windows
```

```bash
bash scripts/update-extension-git.sh                                        # macOS / Linux
```

Both do only `git pull --ff-only` (no download, no swap, no scheduled task),
default to the clone they live in, fail gracefully on a dirty/diverged tree, and
take a `-Quiet` / `--quiet` flag so they drop into a login script or `claude`
wrapper. Plain `git -C <clone> pull --ff-only` does the same. Full guide:
**[`docs/UPDATING.md`](UPDATING.md)**.

### Fallback A — download + swap (no git installed)

If git can't be installed, the no-git path downloads the latest `fast-ext` and
atomically swaps it into the loaded folder, scheduled in the background:

- Setup + scheduler: `scripts/install-tester.{ps1,sh}` (see
  `docs/TESTER-INSTALL.md`).
- One-shot: `scripts/pull-extension.{ps1,sh}`.

This works with zero developer tools, **but** the download-an-archive +
modify-extension-folder + register-a-scheduled-task pattern is exactly what
AV/EDR tends to block or quarantine. On a managed/AV machine, prefer the git
method. Use this only where installing git isn't an option.

### WSL dev box (repo in WSL, separate Windows extension copy)

Chrome loads a **mirrored copy** of `fast-ext` on the Windows side (Chrome can't
reliably load from a `\\wsl$\…` path), so a pull alone isn't enough — the copy
has to be re-synced. Use the WSL updater (run from **Windows** PowerShell, since
it also restarts WSL):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\update-fastlink.ps1
```

It pulls in WSL, `npm install`s fast-dxt if its deps changed, mirrors
`fast-ext` → the Windows extension copy, restarts WSL, then reminds you to
reload the extension and re-run `claude --resume`. (`scripts\update-fastlink-windows.ps1`
is the pure-Windows-no-WSL variant: it adds the npm step on top of the git pull.)

**Then finish the update by hand:**

1. Open `chrome://extensions` and click the **reload arrow** on FastLink.
2. If the MCP server runs standalone, restart it / re-run `claude` so it picks
   up the new server code.

---

## The hard Chrome constraint (and the fully-silent route)

Chrome **will not silently reload an unpacked extension** on command. There is no
API for an extension to reinstall or hot-reload itself from disk on demand.
That's why every path above ends in a manual "reload at `chrome://extensions`"
(or waits for the version-bump self-reload). This is a Chrome security boundary,
not a FastLink limitation — notify + pull + reload is the most automation we can
get for unpacked, self-distributed extensions.

For users who shouldn't run Developer-mode unpacked extensions at all, or
hyper-locked corporate policies that block unpacked extensions entirely, the
**Fallback B (enterprise / Web Store)** route is a **signed `.crx` hosted with an
`update_url` in the manifest**, installed via **enterprise policy**
(`ExtensionInstallForcelist`), or a Chrome Web Store listing (TBD). Chrome then
updates that extension silently on its own schedule — no banner, no reload.
That's a heavier setup (signing key, hosted update XML, policy on the machine)
and is out of scope here; this doc covers the unpacked notify + pull flow.
