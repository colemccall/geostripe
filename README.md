# GeoStripe

A browser-based editor for designing real streets the way a city-building game builds them —
pick a road type, click where it goes, and the junctions form themselves — except the map is
satellite imagery of a real place and the output is measurable GeoJSON.

> **Personal / portfolio project.** Not affiliated with, endorsed by, or connected to any
> commercial road-design tool or game.

---

## What it does

Choose an asset from the palette. Click a start, click an end, and there is a road. Click
partway along one and it splits, so the road you draw next genuinely meets it. Where roads
share a node there is a junction, and it is drawn from the kerbs that meet there.

Everything you place is an *instance of a type*. Widen the "four-lane arterial" asset and
every four-lane arterial in the project widens with it. That is the difference between this
and a drawing program, and it is why a redesign can be argued about at the level people
actually argue about it: not "this block", but "streets like this one".

The output is real GeoJSON — centerlines, nodes and the polygons derived from them — so a
design can be measured, reopened and edited parametrically, or pulled into QGIS.

### The three things it is built on

**A road is its centerline, drawn many times.** A four-lane street with footways is one
LineString emitted eight times over, each copy carrying the width and sideways offset of one
band. MapLibre does the offsetting and the joins on the GPU, at metre-exact scale, every
frame. Nothing is turned into a polygon to be looked at.

**Nothing is detected and nothing is cut out of anything.** Two roads are joined when they
share a node, and not otherwise. A junction is not subtracted from the roads that meet it —
the roads run into the node, and the junction's paved ground is drawn *on top of* them. The
stacking order does the work a polygon boolean used to do, which is both faster and the
reason a fork is drawn as a fork rather than as a hole.

**A stretch of road that differs is a different road.** There is no mechanism for varying a
cross-section along a street, because there does not need to be one: split the segment fifty
metres back and give the stub an asset with a turn lane in it. That is how it is built in
the real world, and how it is built in a game.

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

---

## Using it

| Tool | What it does |
| --- | --- |
| **Select** | Click a road, junction or ground shape. Drag a node to move it and everything attached follows; drag a bend to reshape one road. |
| **Build** | Click to place the active asset, node to node. Landing on a node joins there; landing on a road splits it; landing on open ground makes a new node. The end of one road is the start of the next, so a run of blocks is one gesture. |
| **Ground** | Click a shape for a park, plaza or water. Double-click or Enter closes it. |
| **Bulldoze** | Click to remove. |

| Key | |
| --- | --- |
| `Page Up` / `Page Down` | Raise or lower what you are about to build — bridges and tunnels |
| `Shift` while building | Snap to 15° |
| `Esc` | Abandon the road in progress |
| `Delete` | Remove what is selected |
| `Ctrl` + `Z` / `Shift` + `Ctrl` + `Z` | Undo / redo |

Editing an asset — the pencil beside it in the palette, or **Edit asset** on a selected
road — opens the cross-section editor beside the map. The panel says how many roads in the
project are built from it, because that is how many will change.

---

## Deployment

Full walkthrough in **[DEPLOYMENT.md](DEPLOYMENT.md)**. Three targets, no absolute domain
hardcoded anywhere, so switching between them never edits source:

| Target | Command | Base path |
| --- | --- | --- |
| GitHub Pages via Actions *(default)* | push to `main` | `/geostripe/` |
| GitHub Pages via `/docs` branch folder | `npm run prep:docs` | `/geostripe/` |
| Custom domain / any static host | `npm run prep:domain` | `/` |

One-time repository setup for the default path: **Settings → Pages → Build and
deployment → Source: GitHub Actions**.

Verify a build locally before pushing — `npm run preview` serves the real production bundle
at the real base path, which is the only way to catch a base-path mistake before it reaches
the live site.

### Routing

GeoStripe uses **`HashRouter`**, giving URLs like `/geostripe/#/`.

GitHub Pages serves static files with no rewrite rules, so under `BrowserRouter` a hard
refresh or a shared deep link asks Pages for a file that does not exist and gets a 404
before any JavaScript runs. With `HashRouter` everything after `#` is never sent to the
server, so Pages always serves `index.html` and the client router takes over — and the same
build runs correctly at any base path or domain.

---

## Project layout

```text
src/
  model/                  The document. Everything here is authored; nothing is inferred.
    doc.ts                Nodes, segments, areas — and the edits: split, join, merge, move
    asset.ts              What the palette holds: a line asset, or a ground material
    section.ts            Cross-section arithmetic — widths, anchor, boundary offsets
    io.ts                 GeoJSON in and out, plus conversion from the old street model
    schema.ts             Zod validation for the interchange format
    types.ts              SectionComponent and CrossSection
  geo/                    Pure. No React, no MapLibre.
    projection.ts         Local metric tangent plane — the cos(latitude) fix
    curve.ts              Control points -> the line everything is drawn along
    junction.ts           The ground a junction owns: where the kerbs meet, rounded
    bands.ts              Band polygons. Export only — the map never calls this
    offset.ts             Polyline offsetting, for the same
    markings.ts           Which stripe belongs on which boundary
    glyphs.ts             Pavement symbols, authored in metres in a lane-local frame
    measure.ts            Ground distance, length, bearing
  map/
    paint.ts              The document -> map layers. The whole renderer
    glyphImages.ts        Pavement symbols rasterised once, placed as icons
    MapCanvas.tsx         MapLibre wrapper and every pointer gesture
    basemaps.ts           Imagery sources, verified against the live services
    layerGroups.ts        What the view switches own
  library/
    assets.ts             The starting palette, built from the preset and material libraries
    primitives.ts         96 lane primitives across 10 categories, with as-built defaults
    templates.ts          157 cross-section presets; systematic families are generated
    landcover.ts          Ground materials
  components/
    AssetPalette.tsx      Pick what to build with
    Inspector.tsx         What is selected, and the asset editor
    CrossSectionSvg.tsx   The section elevation
    ComponentStack.tsx    The editable band stack
    PrimitivePalette.tsx  Add-a-band
  store/
    useEditorStore.ts     Zustand, snapshot undo over the document AND the palette
```

---

## The project file

Plain GeoJSON. Four kinds of feature share one collection, and which of them is read back is
the design:

| `streetcity` | | Read back? |
| --- | --- | --- |
| `node` | A Point. The places roads meet. | Yes |
| `segment` | A LineString of **control** points. | Yes |
| `area` | A Polygon of control points. | Yes |
| `band` | The derived polygons. | **No** |

The bands are generated once, at save, by the only polygon generator left in the program.
They are written so the file is useful to something that is not this editor, and discarded
on load, which is what keeps a reopened project parametric rather than frozen.

The palette rides in a `streetcity` foreign member on the collection. GeoJSON permits
members it does not define and readers ignore them, so the file stays valid GeoJSON while
carrying the asset definitions its segments refer to.

### Opening a project from the old street model

Files written by the previous editor are converted on load. That editor had no nodes at
all — a street was a long polyline and whether two of them met was decided afresh by a
detector every time — so the conversion has to invent what was never recorded, and it is
deliberately strict about it:

- Where two streets genuinely **cross**, they are split and share a node. The crossing point
  is computed and lies exactly on both lines, so this is not a guess.
- Two **ends** within 1.5 m of each other are welded. That is a tracing slip.
- Everything else comes in unjoined, and joining it is one click.

The old detector scaled its tolerance to the widest street involved and would call ends
seventeen metres apart joined. Roads that were only ever connected by that guess arrive
disconnected, which is the truth about what was drawn.

Each distinct cross-section becomes one asset, shared by every street that carried it —
which is the thing the old model had no way to say.

The two projects the editor ships with, in `src/demo/`, have been converted on disk and are
stored in the native format, so opening one costs a parse rather than a conversion.

The I-75 example is the one worth opening first, because it exercises everything at once.
Twenty-six drawn streets convert into **119 roads across 96 nodes**, and the eight distinct
cross-sections in the file become eight assets — a 39 m freeway, a 13 m ramp, and six
surface street types — each shared by every road that carried it. Forty-nine of those nodes
are junctions.

Two things about it are worth knowing, and both are properties of the data rather than of
the renderer:

- Every street in it is at grade with no grade profile, so ramps that cross the mainline
  convert into genuine at-grade crossings and are drawn as such. Setting one to **Bridge**
  is what turns it back into the flyover it is, and is the clearest demonstration that
  levels do real work: the junction disappears the moment the two roads stop sharing a deck.
- Forty-seven ends are unjoined, because the weld is strict. Those are the places the old
  detector was guessing about, and there is currently no gesture for joining two nodes by
  hand — see the gaps below.

---

## Testing

613 tests. The ones worth knowing about:

- **`map/paint.test.ts`** — that a 3.6 m lane measures 3.6 m at every zoom, at 39°N and
  69°N. Widths are no longer computed into polygons; they are an expression MapLibre
  evaluates, so the correctness question moved into the expression and a test had to follow
  it there.
- **`map/style.guard.test.ts`** — the layers, checked against MapLibre's own style
  validator. A malformed expression is not an exception: MapLibre logs and drops the layer,
  and the map renders as bare imagery with the design silently missing.
- **`map/worker.guard.test.ts`** — a source-level guard on the worker URL, for a failure
  that has happened twice and is silent in the same way.
- **`model/io.test.ts`** — the round trip, and the conversion, run against the real
  Cincinnati project.
- **`library/dimensions.test.ts`** — every primitive and preset rendered and measured back
  with an independent haversine.

---

## What is deliberately absent

Recorded because these are the calls that would otherwise be quietly re-litigated.

- **No junction detection.** A junction is a node you placed or a split you made. The
  previous model derived them from where centerlines happened to cross, which meant two
  roads could be joined without anyone joining them, and could fail to be joined after being
  drawn to meet.
- **No polygon booleans.** Junctions are drawn over road ends rather than subtracted from
  them. `polyclip` is no longer a dependency.
- **No per-road cross-section override.** A road is an instance of its asset. If one block
  differs it is a different asset, and assets are cheap to duplicate.
- **No cross-section varying along a road.** Split it instead.
- **No fit check.** The measure tool and the right-of-way comparison went with the old
  model. Fading the imagery back still answers the same question by eye.
- **Convex hulls are not used for junctions.** The convex hull of a cross is a square, so
  the plate would bulge into the four quadrants where there is no pavement. The outline is
  built from where each pair of neighbouring kerbs actually meets.
- **No junction where the roads are not really crossing.** Two cases, and a freeway
  interchange hits both. If every road at a node lies within 40° of one line, nothing is
  crossing anything — a ramp joining a mainline is a merge, and a plate there is a lozenge
  painted across the carriageway. And roads at different levels do not meet at all, whatever
  the plan view says, which is what makes a flyover read as a flyover instead of carving a
  paved slab through the road beneath it.
- **A kerb return may eat a third of its edge, not half.** At a half, two returns sharing a
  short edge consume all of it and the junction becomes one continuous curve — a ramp
  crossing a freeway came out as a grey capsule laid across the carriageway.
- **Three decks, not arbitrary levels.** Drawing order has to interleave roads, markings and
  junction plates per level, and MapLibre layers are created once. Levels are authored
  freely and clamped to under / at grade / over for drawing, so two stacked flyovers share a
  deck.
- **Latitude is baked into the metre scale** from the project's centre, because a MapLibre
  expression cannot know `cos(latitude)`. Correct over a project, wrong over a continent —
  and a design spanning enough latitude for that to matter is not a design of a street.

---

## Known gaps

Recorded so they are not rediscovered as bugs.

- **No way to join two nodes by hand.** The importer welds ends within 1.5 m and leaves the
  rest apart, which is honest, but there is no gesture for saying "these two are the same
  place" afterwards. The model has `mergeNodes` and undo covers it; only the UI is missing.
  Forty-seven ends in the I-75 example are waiting on it.
- **Two stacked flyovers share a draw deck.** Levels are authored freely and clamped to
  under / at grade / over for drawing order, because MapLibre layers are created once.
- **A lane-spanning pavement symbol is rasterised at a 3.3 m reference width** and scaled,
  rather than rebuilt per lane.
- **No taper where two different assets meet end to end.** The joint is a step, which is
  honest about a lane drop but is not what a real transition looks like.
- **The Map Editor chunk is ~1 MB** in one piece, uncompressed.

---

## Licence

MIT — see [`LICENSE`](LICENSE).

Satellite imagery is supplied by third-party tile services under their own terms and is
not covered by this licence. Lane width defaults are derived from published NACTO and
AASHTO guidance; they ship as editable starting values, never as constraints, and are no
substitute for professional engineering judgement.
