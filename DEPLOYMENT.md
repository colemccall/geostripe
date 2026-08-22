# Deploying GeoStripe

Three supported targets. All of them typecheck and test before building, so a broken
commit fails at the build rather than on the live site.

| Target | Command | Output | Base path | Serves at |
| --- | --- | --- | --- | --- |
| **GitHub Pages via Actions** (default) | push to `main` | `dist/` | `/geostripe/` | `https://<user>.github.io/geostripe/` |
| **GitHub Pages via `/docs` branch folder** | `npm run prep:docs` | `docs/` | `/geostripe/` | `https://<user>.github.io/geostripe/` |
| **Custom domain / any static host** | `npm run prep:domain` | `dist/` | `/` | `https://your-domain/` |

Nothing hardcodes an absolute domain, so switching targets never edits source.

---

## 1. GitHub Pages via Actions — the default

**One-time setup**

1. Push the repository to `https://github.com/colemccall/geostripe`.
2. On GitHub: **Settings → Pages → Build and deployment → Source: `GitHub Actions`**.
   (Not "Deploy from a branch" — that is target 2.)

**Every deploy after that**

```bash
git push origin main
```

[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml) installs, typechecks,
tests, builds with base `/geostripe/`, and publishes `dist/`. Watch it under the
repository's **Actions** tab; the run summary links the published URL.

**Verify locally before pushing**

```bash
npm run build:pages
npm run preview          # http://localhost:4173/geostripe/
```

`preview` serves the real production build at the real base path, which is the only way
to catch a base-path mistake before it reaches the live site.

---

## 2. GitHub Pages via the `/docs` folder

Use this if you would rather not run Actions at all. The tradeoff is that build output
gets committed to the repository, so every deploy shows up as a diff of minified assets.

```bash
npm run prep:docs
git add docs
git commit -m "Deploy"
git push
```

**One-time setup:** **Settings → Pages → Build and deployment → Source: `Deploy from a
branch`**, branch `main`, folder `/docs`.

`docs/` is not gitignored precisely because this flow needs it committed. If you stay on
Actions (target 1), just never run `prep:docs` and the folder never appears.

---

## 3. Custom domain, or any other static host

```bash
npm run prep:domain                              # base "/", output in dist/
node scripts/prep-pages.mjs --domain example.com # same, plus a CNAME file
```

Upload the **contents** of `dist/` — not the folder itself — to the web root.

### Pointing a custom domain at GitHub Pages

1. Build with the domain baked in: `node scripts/prep-pages.mjs --domain example.com`.
2. At your DNS provider:
   - apex domain (`example.com`) → four `A` records to `185.199.108.153`,
     `185.199.109.153`, `185.199.110.153`, `185.199.111.153`
   - subdomain (`app.example.com`) → one `CNAME` to `<user>.github.io`
3. On GitHub: **Settings → Pages → Custom domain**, enter the domain, and once DNS
   resolves, tick **Enforce HTTPS**.
4. Switch the Actions workflow to the root base path, so pushes keep working — in
   [`.github/workflows/deploy.yml`](.github/workflows/deploy.yml), change the build step:

   ```yaml
   - name: Build
     run: npm run build:domain
   ```

   A custom domain serves from the root, so a `/geostripe/` base would 404 every asset.
   This is the single step people forget.

---

## How the base path works

`base` is the URL prefix every built asset is requested from. It comes from `VITE_BASE`,
read in [`vite.config.ts`](vite.config.ts) from committed per-mode env files:

| File | Mode | `VITE_BASE` | For |
| --- | --- | --- | --- |
| `.env` | default | `/geostripe/` | fallback when no mode is given |
| `.env.pages` | `pages` | `/geostripe/` | GitHub Pages project site |
| `.env.domain` | `domain` | `/` | custom domain, or a user/org Pages site |

These are build configuration, not secrets, so they are tracked. Only `.env.local` and
`.env.*.local` are ignored.

Mode files rather than inline environment variables, deliberately: `VITE_BASE=/ npm run
build` is bash syntax that silently does nothing in PowerShell, which is exactly the kind
of failure that produces a blank page with no error.

**Symptom to recognise:** the page loads white and the console shows 404s for
`/assets/index-*.js`. The base path does not match where the site is actually served.

---

## What `scripts/prep-pages.mjs` adds

Beyond running the build:

- **`.nojekyll`** — GitHub Pages pipes branch-deployed output through Jekyll, which
  silently drops files and folders starting with an underscore. Vite does not emit those
  today, but a dependency easily could, and it surfaces as a mystery 404 rather than a
  build failure.
- **`CNAME`** — GitHub Pages reads the custom domain from this file in the published
  output. Without it, a branch deploy resets the domain setting.
- **Relocation** — Vite always writes to `dist/`; the script copies to `docs/` when that
  target is selected.
- **A gate** — typecheck and tests run first, so a failing build never publishes.

```text
--target pages | docs | domain    which host to prepare for
--domain <host>                   write a CNAME (implies --target domain)
--base /custom/                   override the base path directly
```

---

## Routing note

GeoStripe uses `HashRouter`, so URLs look like `/geostripe/#/builder`.

GitHub Pages is a static host with no rewrite rules. Under `BrowserRouter`, refreshing or
sharing a deep link to `/geostripe/builder` asks Pages for a file that does not exist and
returns a 404 before any JavaScript runs. Everything after `#` is never sent to the
server, so with `HashRouter` Pages always serves `index.html` and the client router takes
over — deep links and refreshes work unconditionally, with no `404.html` redirect hack,
at any base path or domain.

If pretty URLs matter more later, switching to `BrowserRouter` means adding a `404.html`
that stashes the path and bounces through `index.html`. It is a real tradeoff, not a
straight upgrade: it costs a redirect round-trip, briefly flashes an error page, and
breaks link previews.
