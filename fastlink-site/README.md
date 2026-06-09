# FastLink — marketing site

A static, single-page marketing site for **FastLink** (the Chrome extension that lets
Claude read and drive your active tab). Plain HTML + CSS + a little vanilla JS — **no
build step, no toolchain, no dependencies** (fonts load from Google Fonts).

## Files

| File          | Purpose                                                            |
|---------------|-------------------------------------------------------------------|
| `index.html`  | The whole page (semantic sections, inline SVG logo + icons).      |
| `styles.css`  | All styling. **The entire brand lives in the `:root` block.**     |
| `main.js`     | Scroll reveals, mobile menu, typewriter, transcript loop, consent demo. |
| `favicon.svg` | Logo mark, reused as the favicon.                                 |
| `_headers`    | Cloudflare Pages security + cache headers.                        |
| `_redirects`  | Cloudflare Pages redirects (placeholder for the Web Store link).  |

## Brand = one `:root` block

Every color, radius, spacing and type token is a CSS custom property at the top of
`styles.css`. To reconcile with the extension UI palette, **edit only `:root`** — the
whole site re-skins. Keep the *meaning* of the functional state colors even if you
change their hue:

- `--fl-success` green → **connected / done**
- `--fl-working` (= `--fl-primary`) blue → **working / busy**
- `--fl-warn` yellow → **caution / read-only**
- `--fl-stuck` orange → **stuck / needs you**
- `--fl-danger` red → **blocked / error**

## Preview locally

No server strictly required — open `index.html` in a browser. For correct relative
paths and headers behaviour, serve it:

```bash
cd fastlink-site
python3 -m http.server 8080
# → http://localhost:8080
```

(or `npx serve .`, or any static server.)

## Deploy to Cloudflare Pages

**Dashboard (drag-and-drop):**
1. Cloudflare dashboard → **Workers & Pages** → **Create** → **Pages** → **Upload assets**.
2. Drop the `fastlink-site/` folder. No build command, no framework preset.
3. Deploy. `_headers` and `_redirects` are applied automatically.

**Git-connected:** point Pages at the repo, set the **root/output directory** to
`fastlink-site`, and leave the **build command empty** (it's a static site).

**Wrangler CLI** (this project already uses Cloudflare for its relay):
```bash
cd fastlink-site
wrangler pages deploy . --project-name fastlink-site
```

### After the extension ships
Add the Chrome Web Store link in two places: the `#addChrome` / "Add to Chrome" /
"Get FastLink" CTAs in `index.html`, and the `/install` redirect in `_redirects`.

## Notes
- Responsive (mobile → desktop), semantic landmarks, visible focus states,
  `prefers-reduced-motion` respected.
- No analytics or trackers included.
