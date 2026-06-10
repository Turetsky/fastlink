# FastLink — Tester Install (≈2 minutes, then it updates itself)

Install **once**. After that, FastLink keeps itself up to date in the
background — you never have to update it by hand again.

You do **not** need any developer tools. No "git", no Node, no admin rights.

---

## What you're setting up

- A tiny background task downloads the latest FastLink to a folder on your PC
  every few hours (and each time you log in).
- The extension notices when a new version has arrived and **reloads itself**.

So the **only** manual step ever is the one-time "Load unpacked" below. After
that it's hands-off.

---

## Install (do this once)

### 1. Run the installer

1. Download / copy the FastLink `scripts` folder to your PC.
2. Right-click **`install-tester.ps1`** → **Run with PowerShell**.
   - If Windows blocks it, open PowerShell and run:
     ```
     powershell -ExecutionPolicy Bypass -File install-tester.ps1
     ```
3. It downloads the extension and sets up the background updater, then prints
   the steps below.

By default it installs to:

```
C:\Users\<you>\FastLink\extension
```

### 2. Load it into Chrome (the one-time manual step)

1. Open Chrome and go to: **`chrome://extensions`**
2. Turn **ON** "Developer mode" (toggle in the top-right corner).
3. Click **"Load unpacked"**.
4. Select the folder the installer printed (by default
   `C:\Users\<you>\FastLink\extension`).

> **Why "Developer mode"?** FastLink isn't in the Chrome Web Store yet, so Chrome
> loads it as an unpacked extension and shows a small "Developer mode extensions"
> note. That's expected and harmless.

### 3. You're done

That's it. From now on:

- The background task downloads new versions automatically.
- The extension reloads itself onto the new version.
- **You never touch `chrome://extensions` again.**

---

## How the self-update works (optional, for the curious)

```
  Background task     downloads the latest extension files to your folder
        |
        v
  The extension       notices the new version and reloads itself
        |
        v
  Chrome              loads the freshly downloaded files — no clicks from you
```

The background task only keeps the **files on disk** current. The extension and
Chrome handle the reload.

---

## The one caveat

Only the **very first** install is manual (running the installer + the one-time
"Load unpacked"). **Everything after that is automatic** — you don't reload, you
don't re-download, you don't click anything.

If you ever want to force an immediate update instead of waiting for the next
background run, just run `pull-extension.ps1` once:

```
powershell -ExecutionPolicy Bypass -File pull-extension.ps1
```

---

## Uninstall

To remove the background updater **and** the extension files:

```
powershell -ExecutionPolicy Bypass -File install-tester.ps1 -Uninstall -RemoveFiles
```

(Leave off `-RemoveFiles` to remove only the background task and keep the files.)

Then open **`chrome://extensions`** and click **Remove** on FastLink to finish.

---

## Troubleshooting

- **"Running scripts is disabled on this system."** Use the
  `-ExecutionPolicy Bypass` form shown above — it runs the script without
  changing any system setting.
- **It didn't update.** Updates run every few hours and at login. Check the log
  at `C:\Users\<you>\FastLink\pull-extension.log`, or force one with the
  `pull-extension.ps1` command above.
- **The extension disappeared after I closed Chrome.** Reopen `chrome://extensions`;
  unpacked extensions stay loaded across restarts as long as Developer mode is on.
