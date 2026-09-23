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

---

## How it works

Three ideas carry the whole program. Everything else follows from them.

### 1 · A node is a place. A segment is a road between exactly two of them.

```
        n2
        ●                    nodes    n1 n2 n3 n4
        │                    segments s1 = n1→n2
     s2 │                             s2 = n2→n3
        │                             s3 = n2→n4
  n1 ●──●──● n3
     s1 │  s3
        ● n4
```

A **node** owns a position, a height, and optionally a kerb radius. A **segment** owns which
two nodes it runs between, the bends in the middle, and which asset it is made of — and
nothing else. Note what a segment does *not* have: any width, any material, and crucially
**no ends of its own**. Its ends *are* its nodes. That single invariant is why dragging a
node moves every road that touches it, and why a road can never be left behind.

Two roads are joined when they share a node, and not otherwise. There is no tolerance, no
proximity rule, and nothing to tune.

### 2 · Nodes are placed, never detected

Every node in the document got there because something explicit put it there. There are
exactly four ways:

| How | What happens |
| --- | --- |
| **You click open ground** | A node is created at the click, at the height you are building at |
| **You click on a road** | That road is **split** at the click, and the new node is shared by both halves |
| **Your road crosses another** | Both are split at the crossing, and share the node — no click needed |
| **You drop a node on another** | They merge, and everything that met at either now meets at one |

…and one way for a node to leave: **dissolve**, the inverse of a split. A node with exactly
two roads of the same asset is a seam rather than a place, and removing it joins the two
roads back into one, keeping its position as a bend so nothing springs straight.

Without dissolve the graph is a ratchet — every crossing, retype and stray click leaves a
node that could only be removed by deleting both roads and drawing them again.

The crossing case is the one worth being precise about, because an earlier version of this
program got it badly wrong. The crossing point is **computed** from the two lines and lies
exactly on both. That is a fact about two lines, not a guess about intent. The old model
instead asked "were these two roads *probably meant* to meet?" with a tolerance that scaled
to the widest street involved — and answered yes for ends seventeen metres apart, inventing
junctions at places no road actually reached.

So: crossings are inferred, because a crossing is a fact. **Nearness is never inferred.** A
road that stops 4 m from another is ringed in orange and left alone until you say so.

### 3 · A junction is not cut out of anything

This is where most road editors get slow and wrong, and it is worth showing the difference.

**The way it is usually done** — build each road as a ribbon, work out the junction's shape,
then subtract it from every road that touches it:

```
   ribbon  ────────────────      junction shape     result
           ────────────────   −      ▒▒▒▒       =   ────┐  ┌────
                                     ▒▒▒▒            ────┘  └────
```

Every junction is a polygon boolean against geometry hundreds of points long. It is slow, it
needs the junction classified first (crossroads? fork? merge?) because the shape to subtract
depends on the answer, and a fork subtracted as a crossroads comes out as a hole.

**The way it is done here** — the roads run all the way into the node and overlap, and the
junction's paved ground is drawn *on top of* them:

```
   roads run in, overlapping     plate drawn over      what you see
        ────────────                ┌────┐              ────┐  ┌────
        ─────┼┼─────                │▒▒▒▒│              ────┘  └────
             ││                     └────┘                  ││
```

The **stacking order is the boolean.** Nothing is subtracted, nothing is classified, and a
fork is drawn as a fork for the same reason a crossroads is drawn as a crossroads: nobody
asked which one it was.

#### The shape of the plate

Two plates, and their order does real work:

1. the **footprint**, as wide as the widest thing arriving, in footway colour;
2. the **paved area**, carriageways only, in asphalt, drawn over it.

What shows between them at the corners is the footway turning the corner — computed as a
per-corner polygon by the old model, and free here.

The outline itself is the **corner-return construction**: sort the arriving roads by
bearing, and for each neighbouring pair find where one road's left kerb crosses the next
road's right kerb. That point is the corner. Rounding those corners is the kerb return.

The obvious alternative — take the convex hull of the roads' rectangles — was tried and is
visibly wrong. The convex hull of a cross is a **square**, so the plate bulges into the four
quadrants where there is no pavement, and a wide road meeting a narrow one reads as a
roundabout.

#### When there is no junction

Two cases, and an interchange hits both:

- **Everything is heading the same way.** If every road at the node lies within 40° of one
  line, nothing is crossing anything — a ramp joining a mainline is a *merge*, and a plate
  there is a lozenge painted across the carriageway at every ramp.
- **The roads are at different heights.** They never share a node in the first place, so
  there is nothing to draw.

That second one used to need a rule. It does not any more, which is the next idea.

### Height belongs to the node

A place has one height. Everything meeting there is at that height *by construction*, and a
road whose two ends differ is a **ramp** between them.

Putting height on the road instead lets the document state a contradiction — one point at
two heights at once — and the only thing you can do with a contradiction is suppress
something. There used to be a rule doing exactly that. There is no longer anything for it to
suppress.

`Page Up` and `Page Down` set the height that **new** nodes get. Landing on a node that
already exists uses *its* height, because the place already has one and a road does not get
to disagree with it.

Since a plan view cannot show height, a raised road **casts a shadow** on the ground beneath
it — the one depth cue that works without perspective. A ramp's shadow fades in along its
length, from nothing where it leaves the ground to full where it meets the deck, which is
the only thing in the renderer that shows a road climbing.

---

## How the front end works

One source of truth, and everything on screen is a function of it:

```
                    ┌──────────────────────────────┐
                    │   store/useEditorStore.ts    │
                    │   doc · assets · tool · …    │
                    └───┬───────────────────┬──────┘
          subscribes    │                   │    actions
        ┌───────────────┼───────────────────┼───────────────┐
        ▼               ▼                   ▼               ▼
    HotBar          Inspector           MapEditor       MapCanvas
   build menu     what's selected     project + view    ──► paint.ts ──► MapLibre
```

No component talks to another. Each subscribes to the slices it needs and calls actions.
That is why arming an asset in the hotbar immediately changes what the map previews without
either one knowing the other exists.

### The chrome floats over the map

| Where | What | |
| --- | --- | --- |
| top-left | project name, save, open, examples | always |
| bottom | the **hotbar** — tools, road modes, height, asset families | always |
| top-right | the **inspector** | only while something is selected |
| bottom-right | layer switches, imagery fade | always |

A panel that is always there takes space from the map even when it has nothing to say, so
the inspector is mounted from `hasSelection` — no empty column, nothing to dismiss.

### The rendering path

`paint.ts` is the whole renderer, and it computes **no polygons for roads at all**:

```
doc + assets  ──►  paint.ts  ──►  one LineString per segment, emitted once per band,
                                  each copy carrying { widthM, offsetM, color, deck }
                                          │
                                          ▼
                              MapLibre line layers, width and
                              offset as zoom expressions in metres
```

A four-lane street with footways is one line drawn eight times over. MapLibre does the
offsetting and the joins on the GPU. The widths stay metre-exact because Web Mercator scales
by two per zoom level and an `['exponential', 2]` interpolation reproduces exactly that
curve — so a 3.6 m lane measures 3.6 m at every zoom, at 39°N and 69°N alike.

The only polygons anywhere are junction plates (a handful of points each) and the band
polygons written into an exported file, generated once at save.

### What the map shows before a click is spent

All three on pointer move, because a tool you have to trust is worse than one you can see:

| | |
| --- | --- |
| **the preview** | the road under construction at its **real width**, painted by the same renderer that draws finished roads |
| **the snap ring** | what the next click attaches to — amber for a node you would *join*, teal for a road you would *split* |
| **the guide** | the direction the road has been pulled onto when leaving a junction |

### Layer order is load-bearing

`designLayers()` emits, per deck, in this order:

```
ground  →  shadow  →  bands  →  stripes  →  symbols  →  junction plates
                                                        └─ covers the markings
                                                           that run through it
```

then, above every deck: the preview, the selected junction's outline, centerlines, handles,
and the snap ring last of all. A guard test checks this against MapLibre's own style
validator, because a malformed expression is not an exception — MapLibre logs it, drops the
layer, and the map renders as bare imagery with the design silently missing.

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

Everything lives in a hotbar along the bottom of the map, the way a city-builder's build
menu does. Picking a family opens a drawer of assets upward; picking one arms the tool and
closes the drawer again, so the map has the window for the whole of the time you are
actually building. Nothing takes a permanent column, and the inspector only exists while
something is selected.

| Tool | What it does |
| --- | --- |
| **Select** | Click a road, junction or ground shape. Drag a node to move it and everything attached follows; drag a handle to reshape one road. **Drop a node onto another and they merge**, which is how two roads drawn separately become connected. Selecting a junction outlines the ground it owns. |
| **Roads** | Click to lay the armed asset. Landing on a node joins there; landing on a road splits it; landing on open ground makes a new node — and running *across* a road splits both without any click at the crossing. The end of one road is the start of the next, so a run of blocks is one gesture. |
| **Upgrade** | Arm a road type and click an existing road to make it that type. One click, because a road is an instance of its asset rather than a copy of one. |
| **Ground** | Click a shape for a park, plaza or water. Double-click or Enter closes it. |
| **Bulldoze** | Click to remove. |

A junction with exactly two roads of the same type is a **seam**, not a place — the inspector
offers *Remove junction, keep the road*, which is the inverse of a split. It keeps the node's
position as a bend, so the road does not spring straight when the node goes. Without it the
graph only ever gains nodes.

The road tool has the three modes the games have, and the difference between them is what a
click in the MIDDLE of a road means:

| Mode | Clicks | |
| --- | --- | --- |
| **Straight** | start, end | No middle. |
| **Curved** | start, handle, end | The handle is a bezier control — the road bends *toward* it and leaves the start tangent to it, rather than passing through it. |
| **Freeform** | start, two handles, end | The same, with a cubic. |

A handle is not a node and never appears in the document. The road under construction is
previewed at its **real width**, with its bands, by the same renderer that draws the
finished thing — and whatever the next click will attach to is ringed as you pass it, in
amber for a node you would join and teal for a road you would split.

Leaving a junction, the road is pulled onto the directions that junction already implies —
**carry straight on through a road, or turn square off it** — with a dashed guide showing
which. The guides come from the roads actually there rather than from a global grid, because
a real downtown grid is rarely aligned to north and a fixed angular snap therefore helps
with nothing. Hold `Alt` to ignore them.

A road that stops within 30 m of another end is **ringed in orange**. Nothing is joined
until you say so: select it and the inspector states the distance and offers the join, or
just drag it onto its neighbour. The old model made that decision on its own, with a
tolerance that scaled to the widest street involved, and called ends seventeen metres apart
a junction — offering it instead is the whole difference.

| Key | |
| --- | --- |
| `1` `2` `3` | Straight / Curved / Freeform |
| `Page Up` / `Page Down` | Raise or lower what you are about to build. It sets the height NEW junctions get; landing on one that exists uses its height, because the place already has one |
| `Shift` while building | Snap to 15° instead of to the junction's own directions |
| `Alt` while building | Ignore snapping entirely |
| `Backspace` | Step back one click — drops the last handle, then lets go of the start |
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
    doc.ts                Nodes, segments, areas — and the edits: split, join, merge,
                          move, dissolve
    build.ts              Laying a road through whatever it crosses, splitting both
    asset.ts              What the palette holds: a line asset, or a ground material
    section.ts            Cross-section arithmetic — widths, anchor, boundary offsets
    io.ts                 GeoJSON in and out, plus conversion from the old street model
    schema.ts             Zod validation for the interchange format
    types.ts              SectionComponent and CrossSection
  geo/                    Pure. No React, no MapLibre.
    projection.ts         Local metric tangent plane — the cos(latitude) fix
    curve.ts              Control points -> the line everything is drawn along
    junction.ts           The ground a junction owns: where the kerbs meet, rounded
    snapping.ts           The directions a junction implies, and pulling the cursor onto them
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
    HotBar.tsx            The build menu: tools, road modes, families, the asset drawer
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

### A note on older files

Projects written by the street-based editor are **no longer read**. Those files contain no
nodes at all — a street was a long polyline and whether two of them met was decided afresh
on every load — so anything produced from one would be an invention rather than a
conversion, and the editor used to make exactly that mistake. Opening one now says so
plainly instead of half-reading it.

The two bundled examples were converted once, on disk, and are stored in the native format.

---

## Testing

640 tests. The ones worth knowing about:

- **`map/paint.test.ts`** — that a 3.6 m lane measures 3.6 m at every zoom, at 39°N and
  69°N. Widths are no longer computed into polygons; they are an expression MapLibre
  evaluates, so the correctness question moved into the expression and a test had to follow
  it there.
- **`map/style.guard.test.ts`** — the layers, checked against MapLibre's own style
  validator. A malformed expression is not an exception: MapLibre logs and drops the layer,
  and the map renders as bare imagery with the design silently missing.
- **`map/worker.guard.test.ts`** — a source-level guard on the worker URL, for a failure
  that has happened twice and is silent in the same way.
- **`geo/snapping.test.ts`** — that the guides are carry-on plus the two square turns; that
  snapping changes direction without changing how far out the cursor is; and that it lets go
  once the cursor is clearly off, because 45° is a direction somebody meant.
- **`model/dissolve.test.ts`** — that removing a seam joins the two roads and keeps the
  bend; and that it refuses at a junction, at a terminus, where the road changes type, and
  where it would close a ring with no ends.
- **`model/build.test.ts`** — that a road drawn across another splits both and shares one
  node; that three crossings in one stroke produce ten roads; that a curved road split at a
  crossing keeps its exact shape on both sides; and that a road at a different height passes
  over untouched.
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

## Which build am I looking at?

The header carries the version and a stamp, because "I cannot see my change" is
indistinguishable from a failed deploy, a stale `index.html` in the browser cache, and a
build that never ran — and GitHub Pages serves `index.html` with a ten-minute cache, so the
middle one is common.

In a production build the stamp is when the bundle was built. **In dev it is when the page
was loaded**, and says `dev`. That distinction had to be made explicit: the build time is
baked when Vite evaluates its config, which under `vite dev` is when the *server* started,
so it froze while the code under it kept hot-reloading and spent whole sessions asserting a
freshness it had no way to know.

The version comes from `package.json` and nowhere else, so `npm version` moves the header,
every exported project, and the reload notice together.

---

## Known gaps

Recorded so they are not rediscovered as bugs.

- **Two stacked flyovers share a draw deck.** Heights are authored freely and clamped to
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
