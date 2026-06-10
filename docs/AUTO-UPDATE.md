# FastLink auto-update (Option 1: notify + pull)

FastLink is a **self-distributed unpacked Chrome extension** plus a Node MCP
server. It is not in the Chrome Web Store, so Chrome will never silently swap in
a new version. Instead we do the next best thing: the extension **notices** when
a newer version has been published and **tells you**, and a one-command updater
**pulls** it down. This doc explains how the pieces fit together.

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

After a release is out, each machine pulls it. Pick the row that matches the
machine.

### WSL machine (the dev box — repo in WSL, separate Windows extension copy)

Chrome loads a **mirrored copy** of `fast-ext` on the Windows side, so a pull
alone isn't enough — the copy has to be re-synced. Use the existing WSL updater
(run from **Windows** PowerShell, since it also restarts WSL):

```powershell
powershell -ExecutionPolicy Bypass -File scripts\update-fastlink.ps1
```

It pulls in WSL, `npm install`s fast-dxt if its deps changed, mirrors
`fast-ext` → the Windows extension copy, restarts WSL, then reminds you to
reload the extension and re-run `claude --resume`.

### Pure-Windows machine ("dad" — no WSL)

Set this up **once** so updates are trivial:

- Clone the repo on Windows, and in Chrome **Load unpacked** pointing directly
  at the repo's `fast-ext` folder (e.g. `C:\Users\dad\fastlink\fast-ext`).
  Because Chrome reads that folder in place, a `git pull` updates the extension
  files where they already sit — no copying needed.

Then, to update:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\update-fastlink-windows.ps1
```

It runs `git pull --ff-only` in the repo, `npm install`s fast-dxt only if its
deps changed (best-effort — skipped if Node/npm isn't installed), and prints the
reminders below. Pass `-RepoPath C:\path\to\fastlink` if you run it from
somewhere other than the clone.

**Then, on either machine, finish the update by hand:**

1. Open `chrome://extensions` and click the **reload arrow** on FastLink.
2. If the MCP server runs standalone, restart it / re-run `claude` so it picks
   up the new server code.

---

## The hard Chrome constraint (and the future fully-silent route)

Chrome **will not silently reload an unpacked extension.** There is no API for an
extension to reinstall or hot-reload itself from disk. That's why every path
above ends in a manual "reload at `chrome://extensions`." This is a Chrome
security boundary, not a FastLink limitation — Option 1 (notify + pull + manual
reload) is the most automation we can get for unpacked, self-distributed
extensions.

For machines where even that manual reload is unacceptable (e.g. a locked-down
or managed PC), the future **Option 2** is a **signed `.crx` hosted with an
`update_url` in the manifest**, installed via **enterprise policy**
(`ExtensionInstallForcelist`). Chrome then updates that extension silently on its
own schedule — no banner, no reload. That's a heavier setup (signing key, hosted
update XML, policy on the machine) and is out of scope here; this doc covers
Option 1.
