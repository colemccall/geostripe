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
    version.ts            Editor version, stamped into exported projects
  geo/                    Pure. No React, no MapLibre, no lng/lat past the boundary.
    projection.ts         Local metric tangent plane — the cos(latitude) fix
    offset.ts             Polyline offsetting, miter joins with a bevel fallback
    banding.ts            Centerline + widths -> band polygons and lane markings
    curvature.ts          Warns where a bend is tighter than the offset distance
    measure.ts            Ground distance, length, midpoint, bearing
    geo.test.ts           29 tests, measured with an independent haversine
  library/
    primitives.ts         Lane primitives, NACTO-derived defaults, material colours
    templates.ts          Starter cross-sections, defined as primitive lists
  model/
    types.ts              Street, CrossSection, SectionComponent
    section.ts            Cross-section arithmetic — widths, anchor, boundary offsets
    section.test.ts       17 tests pinning the anchor semantics
    schema.ts             Zod validation for the asset interchange format
    assetFile.ts          Download / upload plumbing
    project.ts            Project GeoJSON: write bands, read only centerlines
    project.test.ts       15 tests on the round-trip and on partial-load reporting
  store/
    useEditorStore.ts     Zustand store, snapshot undo/redo, gesture bracketing
    useEditorStore.test.ts  10 tests on history granularity and aliasing
  map/
    basemaps.ts           Imagery sources, verified against the live services
    designLayers.ts       Document -> map layers, plus the swipe clip
    MapCanvas.tsx         MapLibre wrapper and all pointer interaction
    worker.guard.test.ts  Source-level guard on the MapLibre worker configuration
  components/
    AppShell.tsx          Chrome — units, imagery picker, undo/redo
    CrossSectionSvg.tsx   Shared elevation renderer, both pages
    ComponentStack.tsx    Shared editable stack, both pages
    PrimitivePalette.tsx  Shared add-a-band palette, both pages
    NoticeBar.tsx         File-operation feedback
  routes/
    MapEditor.tsx         "/"
    AssetBuilder.tsx      "/builder"
  styles/
    global.css            Design tokens (light / dark / system) and chrome

scripts/
  prep-pages.mjs          Repeatable build + prep for each deploy target
  sync-maplibre-worker.mjs  Copies MapLibre's worker into public/ verbatim

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

The editor works end to end: draw a street, design its cross-section, check it against
the width that is really there, and save it as GeoJSON you can reopen and keep editing.

#### Done

- **Geometry engine** — local metric tangent plane, polyline offsetting with miter joins
  and a bevel fallback, cross-section banding, curvature warnings. Pure, headless, and
  gated on tests asserting a 3.0 m band measures 3.0 m on every bearing, at 39°N and at
  69°N alike. Adjacent bands share boundary coordinates exactly, so there are no slivers.
- **Map Editor** (`/`) — satellite imagery with a source picker (USGS NAIP by default,
  Esri World Imagery, Esri Clarity, Esri Wayback with a vintage picker, custom XYZ),
  three tools:
  - **Select** — click a band to select its street; drag a centerline vertex to reshape,
    alt-click to remove one, drag a hollow midpoint handle to insert one. A whole drag is
    a single undo step.
  - **Draw street** — click along a centerline, Enter or double-click to finish, Esc to
    cancel, Backspace to drop the last point. The new street gets the template you pick,
    or whatever is open in the Asset Builder.
  - **Measure** — click two points and push the result straight into the fit check.
- **Project save/load** — plain GeoJSON. Centerlines carry their cross-section and are the
  only thing read back; the derived band polygons ride along for QGIS and are regenerated
  on load, which is what keeps a reopened project parametric rather than frozen. A plain
  LineString with no GeoStripe properties imports as a centerline you can design on, so a
  way traced in OSM or QGIS drops straight in.
- **Before/after swipe** — clips the design against a meridian, exact because the map is
  held north-up.
- **Asset Builder** (`/builder`) — lane primitive library, editable component stack, live
  cross-section elevation with dimension lines, asset JSON round-trip with Zod validation
  and readable per-field errors.
- 8 starter cross-section templates, feet/metres toggle, undo/redo with Ctrl+Z.
- **77 unit tests** across geometry, cross-section arithmetic, the project round-trip, and
  store history.

#### Not built yet

Crosswalks, roundabouts, intersection trimming (crossing streets simply overlap for now,
resolved by draw order), snapping, and touch support for vertex dragging.

### Why the geometry is its own phase

`@turf/lineOffset` converts a metric distance to degrees once, then does planar
arithmetic on longitude/latitude with no cosine-of-latitude correction. A north–south
street's bands come out narrow by `cos(latitude)` — at Cincinnati a 3.0 m lane measures
2.33 m — while east–west streets are correct, so the error is invisible unless you
compare two streets. `@turf/buffer` is unaffected (it projects to azimuthal equidistant),
which makes the trap worse: the naive first step looks perfect.

All geometry therefore happens in a local metric tangent plane, in a pure module, gated on
a test asserting that a 3.0 m band measures 3.0 m whichever way the street runs.

### The project file

```jsonc
{
  "type": "FeatureCollection",
  "metadata": { "geostripeProject": 1, "name": "…", "editorVersion": "…" },
  "features": [
    {
      "type": "Feature",
      "properties": {
        "geostripe": "street",          // read back on load
        "name": "Race Street",
        "existingWidthMeters": 16.5,
        "anchorOffsetMeters": null,     // null = derive the travelway midpoint
        "components": [
          { "componentType": "sidewalk", "widthMeters": 2.4, "direction": "none" },
          { "componentType": "travelLane", "widthMeters": 3.0, "direction": "forward" }
        ]
      },
      "geometry": { "type": "LineString", "coordinates": [[-84.5, 39.1], …] }
    },
    { "properties": { "geostripe": "band", … } }   // derived; discarded and rebuilt on load
  ]
}
```

Widths are metres everywhere in the file. Feet exist only at the display boundary — a
stored value is never a converted one.

---

## Licence

MIT — see [`LICENSE`](LICENSE).

Satellite imagery is supplied by third-party tile services under their own terms and is
not covered by this licence. Lane width defaults are derived from published NACTO and
AASHTO guidance; they ship as editable starting values, never as constraints, and are no
substitute for professional engineering judgement.
