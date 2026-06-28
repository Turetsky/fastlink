# FastLink self-hosted auto-update (signed `.crx`)

This directory is the **auto-update channel** for FastLink installs that run as a
signed `.crx` outside the Chrome Web Store (currently: one trusted user who can't
load the unpacked extension). Everyone else just loads `fast-ext/` unpacked.

## How it works

Chrome polls the `update_url` baked into `fast-ext/manifest.json`:

```
https://raw.githubusercontent.com/Turetsky/fastlink/main/release/updates.xml
```

`updates.xml` names the current `version` and a `codebase` URL pointing at the
signed `.crx`, hosted as a **GitHub Release asset** (public repo → no auth needed
to download). Chrome checks ~every 5 hours, sees a higher version, downloads the
`.crx` from `codebase`, verifies it's signed by the **same key** (same extension
ID `ockcjadbkdfgfllidpcoamcepahfmlpf`), and updates silently.

- **Stable URL** = the `raw.githubusercontent` `updates.xml` (content changes per
  release via commits to `main`).
- **Per-version URL** = the GitHub Release asset (referenced *by* `updates.xml`).

The signing key is `../fastlink-extension-signing-key.pem` (kept at repo root;
git-ignored / never published — re-signing with it preserves the extension ID).

## One-time bootstrap for the user

The currently-installed `.crx` has **no** `update_url`, so it can't auto-update
itself. The user installs `fastlink-0.4.2.crx` **once** (drag onto
`chrome://extensions`). From then on every future release arrives automatically.

## Cutting a new release

1. Bump `"version"` in `fast-ext/manifest.json` (e.g. `0.4.3`).
2. Sync any edited extension files (the manifest + sources are the source of truth).
3. Pack the signed `.crx`:  `release/build-crx.sh 0.4.3`
4. Edit `release/updates.xml`: bump `version` **and** the `codebase` tag to `ext-v0.4.3`.
5. Commit + push (this updates the raw `updates.xml` Chrome polls).
6. Upload the asset:
   `gh release create ext-v0.4.3 "<path>/fastlink-0.4.3.crx" --title "Extension v0.4.3" --notes "..."`

That's it — Chrome pulls it within ~5 hours, no action on the user's end.

## Caveat

`raw.githubusercontent` serves the manifest as `text/plain`; Chrome's updater
accepts that for update checks. If a future Chrome ever rejects it, move
`update_url` to a host that serves `text/xml` (GitHub Pages, or the relay Worker
at `relay.ytx.app/ext/updates.xml`) — only the `update_url` string changes, and
only on the next bootstrap install.
