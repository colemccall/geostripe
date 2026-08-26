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
    curve.ts              Arcs and splines: control points -> the line everything uses
    junctions.ts          Junction detection; identity that survives every edit
    intersection.ts       Curb returns, crossings, corner treatments, trimming boundaries
    merge.ts              Where a road joins another instead of crossing it
    snap.ts               Where a drawn point should actually land
    glyphs.ts             Pavement symbols, authored in metres in a lane-local frame
    markings.ts           Stripes, repeating lane symbols, junction approach arrows
    derived.ts            The memoised pipeline everything on the map comes out of
    measure.ts            Ground distance, length, midpoint, bearing
    geo.test.ts           29 tests, measured with an independent haversine
  library/
    primitives.ts         96 lane primitives across 10 categories, with as-built defaults
    templates.ts          157 cross-section presets; systematic families are generated
    landcover.ts          Land-cover materials for non-street polygons
    catalogue.test.ts     Integrity of a library too long to review by eye
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
    LibraryTree.tsx       The two-level browser all three libraries share
    ApproachEditor.tsx    Lane assignment and turn pockets for one junction approach
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
- **Curved alignments** — `rounded` is tangent-arc-tangent at a stated radius, the way a
  road alignment is really specified; `smooth` is a centripetal Catmull-Rom for tracing a
  street that genuinely curves. Shift-click pins a control point as a hard corner.
- **Land cover** — closed polygons carrying a material (grass, plaza, water, canopy,
  parking lot and more), drawn beneath the design so a redesign can cover the imagery it
  replaces rather than just annotate it.
- **96 lane primitives and 157 cross-section presets**, each categorised and searchable by
  label, category, purpose, and — for presets — by the components they contain.
- **Paths as first-class alignments** — greenways, side paths, rail trails, boardwalks,
  towpaths, separated walking-and-cycling corridors. A path has no roadway at all, so it is
  not a narrow street: the anchor falls back to the geometric centre and nothing in the
  junction code treats it as carriageway.
- **Road markings.** Longitudinal stripes are derived from what sits either side of each
  boundary — double yellow between opposing directions, dashed white between same-direction
  lanes, solid against a bike lane or parking, nothing at a kerb — and any boundary can be
  overridden. Pavement symbols repeat along a band: bicycles in a bike lane, diamonds in a
  bus lane, sharrows in a shared lane, alternating arrows in a two-way left-turn lane. Every
  glyph is authored in real metres, and one too wide for its lane is suppressed rather than
  drawn spilling over the stripe.
- **Lane assignment and turn pockets.** Each junction approach lists its own lanes, in the
  order the driver sees them, and each one carries the movements it is allowed to make; the
  lane-use arrow follows. A turn pocket is applied to the leg *before* any geometry is
  built, so it moves the kerb, the corner return and the crossing with it — and the crossing
  distance the inspector reports goes up by exactly what the pocket costs.
- **Straight segments and arcs, while you draw.** The pen has a shape: `S` places hard
  corners, `C` curves through each point at a stated radius, and you toggle between them
  mid-line — straight down the block, round the bend, straight again. The rubber band
  previews the *arc*, not the control polygon, so a bend is judged on screen rather than in
  your head. A line drawn entirely straight is stored as a plain polyline.
- **Intersections you place.** The `Intersection` tool drops a node where you click, and
  from then on that node is in charge: the junction is *at* it, keyed by *it*, and you can
  select it, drag it, name it, disable it or delete it. Dragging one carries along any
  street that ENDS there and lets a street that passes through slide under it. A node set
  to **no junction** is the one thing nothing else in the model could say — two roads that
  cross without meeting. One button places a node at every crossing there is, so the graph
  becomes yours without redrawing anything, and a mode switch turns automatic detection off
  entirely if you want nothing to be an intersection unless you put one there.
- **Merges.** A road that joins another instead of crossing it is drawn as a merge, not an
  intersection: the road being joined is never cut, and the junction is the taper between
  the two kerbs, with a gore at the nose. Below 40° it is classified automatically —
  nobody draws a twenty-degree crossroads — and either reading can be forced from the
  inspector for the ambiguous band around thirty. The wedge is stated as *the ramp's
  corridor minus the road it joins*, which is what makes it correct when the ramp is the
  wider of the two.
- **Snapping.** Points snap to control points and to centerlines while drawing, measuring
  and covering ground; Shift adds 15° angle snapping, Alt turns it all off. This is more
  than a convenience here: junctions are derived from where centerlines actually meet, so a
  vertex that lands where it was aimed is the difference between a junction at the crossing
  and one at a near miss.
- **Controls on the map, not beside it.** A vertical dock holds the tools, the actions for
  whatever is selected, and undo/redo; a contextual bar appears at the top only while a
  modal tool is running; a selection strip under the map shows what is selected and the fit
  check it has to answer to; and view controls bottom-right carry zoom, framing, the
  before/after swipe, and switches for every layer plus imagery opacity. The side rail
  collapses entirely, so the map can have the window. Fading the imagery back is how you
  check that the bands actually sit on the pavement, which is the claim the tool is making.
- **A browsable library.** 96 primitives and 157 presets in a two-level tree — category,
  then group — with search that flattens the whole thing and covers each entry's purpose,
  not just its name. Recently used sits above the tree, because assembling one street uses
  the same three or four lanes over and over.
- **Junctions that are not a tidy four-way.** Five and six legs, acute corners, and the
  staggered intersection: two T-junctions close enough that a driver reads them as one
  place. Those stay two junctions on purpose — averaging them would put both side streets
  somewhere neither of them is — and the pair is reported, with any crossing that would land
  inside the neighbour suppressed. One slider moves the threshold in both directions.
- **Grade separation, along a street rather than across all of it.** `level` marks a whole
  street as a tunnel or a viaduct, which is enough to stop a freeway carving a hole through
  the road beneath it but cannot say the thing every real overpass does: climb, cross, come
  back down. A street elevated end to end has no ramps, and meets nothing anywhere.
  A **grade profile** is a handful of breakpoints along the centerline with the level
  straight-lined between them — so an overpass is four points, and the two sloping stretches
  are its ramps. Levels are checked per crossing, so a street flies over the one road it was
  raised for and still meets everything at either end. That is what makes an **interchange**
  buildable out of parts that already exist: a flyover, the merges the ramps make where they
  rejoin, and ordinary junctions at the feet. Set crossing by crossing from the street
  inspector — every road this one meets, with an under / at-grade / over switch.
  Deliberately not an elevation in metres: the question is which of two things is on top,
  which is ordinal, and a real height would invite a gradient check this tool has no
  business claiming to do.
- **Performance, measured against a real ten-street downtown project.** Three things were
  costing an order of magnitude more than they needed to, and all three got worse as a
  project grew, which is what "it slows down the further you go" actually means:
  - **Curves were sampled to a chord length, not an error.** A 1.2 m chord on a gentle
    200 m bend moves the line by less than a millimetre; one traced street resolved to 309
    points and cost more than the other nine together. Sampling to a *sagitta* — never more
    than 5 cm from the true curve, an eighth of a pixel at working zoom — put that street
    at 96 points and made the number a guarantee rather than a guess.
  - **Every band was trimmed against every junction**, including ones across the map. Now a
    junction cuts only the streets that meet there, which is also a correctness fix: a
    street running past an intersection it does not join used to have a bite taken out of it.
  - **The trim cache was keyed on every junction at once**, so one corner radius rebuilt the
    whole project — and the key grew with the project while the edit stayed the same size.
    Keyed per street, an edit costs what the edit is worth.
  - Mid-drag, neighbours keep the trim they had; the street under the cursor is always
    exact. A vertex drag went from **85 ms a frame to 27**.
- **855 unit tests** across geometry, curves, junction detection, intersection geometry,
  complex and staggered junctions, merges, snapping, joining, road markings, the
  memoisation that keeps dragging affordable, cross-section arithmetic, the dimensional
  audit, the asset catalogue, the project round-trip, store history, and a baseline suite
  that holds the real downtown project to budgets for vertex count and edit latency.

- **Joining** — a line drawn over imagery never stops exactly where it was aimed, and the
  three ways it misses all read as "the intersections are a mess": an overshoot of one
  metre turns a T into a four-way with a phantom leg; an undershoot leaves a strip of bare
  imagery between the two; and past the detector's tolerance nothing is found at all.
  Finishing a street welds its ends onto whatever they were drawn to meet — trimming a
  tail that never escapes the junction box, extending along the street's own heading, or
  closing an L between two dead ends. The weld moves the centerline rather than loosening
  the detector, so what is stored stays what is drawn stays what is measured, and it undoes
  like any other edit. Ends that still do not meet are ringed in orange with a Join button
  beside them.
- **Intersections** — detected automatically wherever centerlines cross, with no node to
  place or maintain. Each junction carries its legs sorted by bearing and a corner between
  each adjacent pair.
  - **Curb returns** at a per-corner radius, clamped with a warning when the legs meeting
    there are too short or too acute to carry it.
  - **Two-boundary trimming.** Roadway components are cut at the kerb-to-kerb box and the
    junction fills it, so asphalt reads as one continuous surface; everything else is cut
    at the wider footprint, which is drawn underneath, so the footway turns the corner.
    The stacking order is the boolean — no per-corner polygon is computed.
  - **Crossing distance** per leg, the pedestrian counterpart to the fit check.
  - A radial inspector: click the corner you can see, not "corner 3" in a list.
  - Customisation is keyed by which streets meet, not by position or vertex index, so it
    survives dragging the crossing, inserting vertices, and reversing a centerline.

## Roadmap

Phases are ordered by dependency, not by appeal. Anything that other work builds on is
proven headless and unit-tested before it gets a UI — the geometry engine was, and so was
junction detection.

| | Phase | State |
|---|---|---|
| 1 | Prototype, shell, map, imagery | done |
| 2 | Geometry core — projection, offsetting, banding, curvature | done |
| 3 | Drawing — centerline authoring, vertex editing | done |
| 4 | Library and cross-sections | done |
| 5 | Editing — inspector, measure tool, fit check | done |
| 6 | Save / load — GeoJSON round-trip | done |
| 7 | Templates and palette | done |
| 8 | Asset Builder page | done |
| 9 | Before / after swipe | done |
| A | Junction detection | done |
| B | Derived-geometry cache | done |
| C | Intersection footprint, curb returns, trimming | done |
| D | Intersection inspector | done |
| E | Crosswalks and stop bars | done |
| F | Corner treatments — bulb-outs, daylighting | done |
| J | Curved alignments — arcs and splines | done |
| K | Land cover polygons | done |
| L | Asset library — 96 primitives, 157 presets, grade separation | done |
| M | Paths and shared-use paths as their own kind of alignment | done |
| N | Road markings — stripes, lane symbols, lane-use arrows | done |
| O | Complex junctions — 5/6-way, staggered pairs, lane assignment, turn pockets | done |
| R | Merges — a road joining another, with a taper and a gore instead of a box | done |
| S | Snapping — to vertices, to centerlines, and to 15° increments | done |
| T | Library browser — a two-level tree, search, recents, per-band actions | done |
| U | On-map controls — dock, context bar, selection strip, layer switches | done |
| V | Placed intersections — nodes you own, drag, disable, delete | done |
| W | Straight/arc segments while drawing, and a stale-build notice | done |
| X | Joining — welding loose ends onto the streets they were drawn to meet | done |
| Y | Every shortcut has a button, and a reference sheet that says which | done |
| Z | Performance — error-bounded curves, per-street junction trimming | done |
| AA | Grade profiles — an overpass that climbs, crosses and comes back down | done |
| G | Protected (Dutch) intersection, incl. the corner refuge island | next |
| H | Roundabout, as a junction form | planned |
| P | Signal phasing — which movements run together, and the conflicts left over | planned |
| I | Swept-path / design-vehicle check | stretch |
| Q | Text pavement markings (ONLY, BUS, STOP) — needs glyph outlines, not a font | stretch |

Also outstanding, smaller: touch support for vertex dragging (mouse only today), point
components such as trees and signals, and asymmetric template generators (everything
generated today is mirrored about the centerline, so "parking on one side" is still
hand-authored).

### What each of the finished phases actually decided

Worth recording, because these are the calls that would be quietly re-litigated otherwise.

- **Junctions are derived, never authored** (A). Identity is the set of streets that meet
  there plus an ordinal, so customisation survives dragging the crossing, inserting a
  vertex, or reversing a centerline.
- **The stacking order is the boolean** (C). Roadway is cut at the kerb-to-kerb box and
  everything else at the wider footprint, drawn underneath — so the corner sidewalk appears
  with no per-corner polygon computed anywhere.
- **Curves resolve before everything** (J), junction detection included. Detecting against
  the control polygon would place junctions where the pavement never reaches.
- **A path is not a narrow street** (M). It has no roadway, so it gets no kerb line, no
  travelway anchor, and no carriageway treatment at a junction.
- **Nothing is assigned by default** (O). An unassigned lane gets no arrow. Painting a
  guess on the road and calling it a design is the failure mode this tool exists against;
  the conventional assignment is one button away and labelled as a convention.
- **A staggered pair stays two junctions** (O), reported rather than merged.
- **A merge is a boolean, not a walk** (R). The first version walked the ramp's kerbs
  outward to the mainline's and stitched four points together, which works only while the
  ramp is the narrower road. Stating the wedge as *ramp corridor minus mainline* has no
  special cases and produces the nose for free.
- **A vertex beats an edge** (S), even when the edge is marginally nearer. An existing
  control point is a decision somebody made; a point on a segment is not.
- **The pen has a shape, the street has a curve** (W). A control point and its cornering
  are separate facts, so they are stored separately: the point is where the street goes,
  the pin is how it gets there. That is what lets a finished street be switched wholesale
  between straight and curved without losing which corners were deliberately kept square.
- **Both junction models, and neither wins quietly** (V). Detection is still the default,
  because a design has to work before anyone has thought about intersections. A node is
  authoritative in its own neighbourhood and the crossing there is dropped — two junctions
  on one piece of asphalt would each carve the other's streets. A node's id is its junction
  key, which is the most durable key there is: the streets can be deleted and redrawn and
  the corner radii stay where they were put.
- **Deselecting is as easy as selecting** (U). Clicking bare ground used to hold the
  selection, on the grounds that losing the inspector by missing a band by two pixels is
  maddening. The reverse was worse: with no other way out, the panel could not be put down
  at all. Escape does it too, and Delete removes whatever is selected.
- **The map is the workspace** (U). Every control that acts on what is under the cursor
  lives over the imagery, because a side rail costs a glance away from the thing being
  traced once per action, and drawing one street is a hundred actions. Tool selection lives
  in the dock and nowhere else — two controls for one piece of state is how they end up
  disagreeing.
- **The centerline hides itself** (T). It is an editing handle, not part of the design —
  the one line on the map that does not exist on the ground — so it appears only for the
  street you have selected, with a toggle for when you want them all.

Deliberately out of scope for v1: image/PNG export, accounts, a backend, 3D, and traffic
simulation.

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
