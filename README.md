# GeoStripe

A free, browser-based editor for sketching street and intersection redesigns as real
vector data (GeoJSON) on top of satellite imagery — inspired by Streetcraft Studio's
satellite-overlay workflow, but open, free, and data-first instead of image-first.

> **Personal / portfolio project.** Not affiliated with, endorsed by, or connected to
> Streetcraft or Streetcraft Studio in any way. "Streetcraft" is referenced only to
> describe the workflow that inspired this project.

---

## What it does

Trace a real street on satellite imagery, drop a cross-section onto it, and the design
renders as measurable polygons — not a flattened picture. Because the output is real
GeoJSON, a redesign can be measured, reopened and edited parametrically, or pulled into
QGIS. The argument a street redesign has to win is *"this fits in the width you already
have"*, and that only holds up if the geometry is honest.

Two workspaces:

| Route | Page | What it is |
| --- | --- | --- |
| `/` | **Map editor** | Satellite imagery, drawn centerlines, placed cross-sections, edited in place |
| `/builder` | **Asset builder** | Streetmix-style assembler for reusable cross-sections, saved as small JSON files |

No accounts, no backend. Files are the sharing mechanism.

---

## Getting started

Requires Node `^18 || ^20 || >=22` (Vite 6). CI builds on Node 24.

```bash
npm install
npm run dev        # http://localhost:5173/geostripe/
```

| Script | What it does |
| --- | --- |
| `npm run dev` | Vite dev server |
| `npm run build` | Typecheck, then production build into `dist/` |
| `npm run build:pages` | Build for GitHub Pages project site (base `/geostripe/`) |
| `npm run build:domain` | Build for a custom domain / root host (base `/`) |
| `npm run prep:pages` | Typecheck + test + build + `.nojekyll` → `dist/` |
| `npm run prep:docs` | Same, output to `docs/` for branch-based Pages |
| `npm run prep:domain` | Same, base `/`, for a custom domain |
| `npm run preview` | Serve the production build locally at the real base path |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Vitest, single run |
| `npm run test:watch` | Vitest, watch mode |

---

## Deployment

Full walkthrough in **[DEPLOYMENT.md](DEPLOYMENT.md)**. Short version — three targets, no
absolute domain hardcoded anywhere, so switching between them never edits source:

| Target | Command | Base path |
| --- | --- | --- |
| GitHub Pages via Actions *(default)* | push to `main` | `/geostripe/` |
| GitHub Pages via `/docs` branch folder | `npm run prep:docs` | `/geostripe/` |
| Custom domain / any static host | `npm run prep:domain` | `/` |

One-time repository setup for the default path: **Settings → Pages → Build and
deployment → Source: GitHub Actions**.

Verify a build locally before pushing — `npm run preview` serves the real production
bundle at the real base path, which is the only way to catch a base-path mistake before
it reaches the live site.

> Moving to a custom domain has one easy-to-miss step: the Actions workflow must switch
> to `npm run build:domain`, because a root-served site 404s every asset under a
> `/geostripe/` base. DEPLOYMENT.md covers it.

### Routing

GeoStripe uses **`HashRouter`**, giving URLs like `/geostripe/#/builder`.

GitHub Pages serves static files with no rewrite rules. Under `BrowserRouter`, a hard
refresh or a shared deep link to `/geostripe/builder` asks Pages for a file that does not
exist, and it returns a 404 before any JavaScript runs. The usual workaround is a
`404.html` that stashes the path in `sessionStorage` and bounces through `index.html` —
prettier URLs, but it depends on a redirect round-trip, briefly flashes an error page, and
breaks link previews.

With `HashRouter` everything after `#` is never sent to the server, so Pages always serves
`index.html` and the client router takes over. Deep links and refreshes work
unconditionally, and the same build runs correctly at any base path or domain. The cost is
the `#` in the URL, which is a fair trade for a static host.

---

## Project layout

```text
src/
  main.tsx                React entry
  App.tsx                 HashRouter + lazy route table
  lib/
    units.ts              Metres <-> feet; storage is always metres
  library/
    primitives.ts         Lane primitives, NACTO-derived defaults, material colours
    templates.ts          Starter cross-sections, defined as primitive lists
  model/
    types.ts              CrossSection, SectionComponent
    section.ts            Cross-section arithmetic — widths, anchor, boundary offsets
    section.test.ts       17 tests pinning the anchor semantics
    schema.ts             Zod validation for the asset interchange format
    assetFile.ts          Download / upload plumbing
  store/
    useEditorStore.ts     Zustand store with snapshot undo/redo
  map/
    basemaps.ts           Imagery sources, verified against the live services
    MapCanvas.tsx         MapLibre wrapper
  components/
    AppShell.tsx          Chrome — units, imagery picker, undo/redo
    CrossSectionSvg.tsx   Shared elevation renderer, both pages
    ComponentStack.tsx    Shared editable stack, both pages
    NoticeBar.tsx         File-operation feedback
  routes/
    MapEditor.tsx         "/"
    AssetBuilder.tsx      "/builder"
  styles/
    global.css            Design tokens (light / dark / system) and chrome

scripts/
  prep-pages.mjs          Repeatable build + prep for each deploy target

.env, .env.pages, .env.domain    Base path per target (tracked; not secrets)
```

Geometry is deliberately absent from the route layer. `model/section.ts` computes *where*
each boundary sits along the cross-section; turning those distances into polygons on a
real centerline belongs in pure, headless, unit-tested modules under `src/geo/`, and the
routes will only render what those produce.

`CrossSectionSvg` and `ComponentStack` are shared by both pages rather than duplicated —
the Asset Builder renders them large and the Map Editor inspector small, from the same
state.

---

## Status

Everything that does not require geodesy is built and working.

#### Done

- Asset Builder (`/builder`) — lane primitive library, editable component stack with
  reorder and direction, live cross-section elevation with engineering dimension lines,
  travelway-anchored centerline marker, asset JSON download and upload with Zod
  validation and readable per-field errors
- Map Editor (`/`) — live satellite imagery with a source picker (Esri, USGS NAIP,
  custom XYZ), scale bar, attribution, cursor and zoom readout, imagery toggle,
  right-of-way fit check, and the shared cross-section inspector
- 8 starter cross-section templates, feet/metres toggle, undo/redo with Ctrl+Z
- 17 unit tests covering cross-section arithmetic and anchor semantics

**Next — the geometry engine.** Local metric projection, polyline offsetting,
cross-section banding, and curvature warnings, built headless and unit-tested before any
drawing UI, because it is the whole technical risk. Once it lands, the Map Editor gets
centerline drawing and the rendered design layer.

**After that:** GeoJSON project save/load round-trip, before/after swipe, crosswalks,
roundabouts.

### Why the geometry is its own phase

`@turf/lineOffset` converts a metric distance to degrees once, then does planar
arithmetic on longitude/latitude with no cosine-of-latitude correction. A north–south
street's bands come out narrow by `cos(latitude)` — at Cincinnati a 3.0 m lane measures
2.33 m — while east–west streets are correct, so the error is invisible unless you
compare two streets. `@turf/buffer` is unaffected (it projects to azimuthal equidistant),
which makes the trap worse: the naive first step looks perfect.

All geometry will therefore happen in a local metric tangent plane, in a pure module,
gated on a test asserting that a 3.0 m band measures 3.0 m whichever way the street runs.

---

## Licence

MIT — see [`LICENSE`](LICENSE).

Satellite imagery is supplied by third-party tile services under their own terms and is
not covered by this licence. Lane width defaults are derived from published NACTO and
AASHTO guidance; they ship as editable starting values, never as constraints, and are no
substitute for professional engineering judgement.
