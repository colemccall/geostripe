# StreetCityEditor Roadmap

Status: planning document. Evaluation was read-only: `tsc --noEmit` is clean and `vitest run` passes 640/640. The app was **not** run in a browser, so behaviour claims come from code reading and are marked "unverified" where that matters.

Decisions already made: US only, 2D footprints, custom land-use classification, autosave in, no sound, no simulation / policies / finances, imagery licensing deferred while the project is private, product renamed to StreetCityEditor, hybrid UI (bottom category toolbar + docked planner panel).

## 1. Executive summary

- Today's app (internally "GeoStripe") is a React 18 + MapLibre 6 + Zustand static SPA with a good node/segment/asset model and 640 passing tests, but it is a *road drawing* tool only. It has no zoning, buildings, districts, info views, persistence or planner stats.
- Foundations come first because coordinates and snapping are unacceptable today: **one coordinate system with no divergent scales**, a **rewritten snapping and node-collision engine** on a spatial index, and **autosave**. Nothing else ships until these pass numeric tests.
- The product becomes **StreetCityEditor**: renamed everywhere, with a new hybrid UI (bottom category toolbar for tools and brushes, docked planner panel for properties, layers and stats) and Cities: Skylines-style *interaction* (curve tools, ghost previews, brushes, info views) without its chrome or art.
- Scope is road editing and **free-paint land-use zoning for planners**. Out of scope: policies, finances, citizens, traffic, economy. Stats are measurements (lengths, right-of-way area, land-use area), not simulation.
- Phase 2 differentiators (real cross-sections, before/after slider, planner exports, Streetmix-style builder, OSM import) all work without a backend. Licensing is a pre-public-launch checklist item.

## 2. Phase 0 findings

### 2.1 Stack, build, deploy

- Vite 6, TypeScript ~5.6, React 18, react-router 7 (HashRouter), Zustand 5, Immer 11 (installed; the store uses plain immutable snapshots), Zod 4, maplibre-gl 6.5, Vitest 3 (node environment only; no component tests).
- Static hosting only. Three deploy targets via `.env*` `VITE_BASE`; GitHub Actions deploys on push to `main`. `scripts/sync-maplibre-worker.mjs` copies MapLibre 6's worker and `worker.guard.test.ts` guards a silent failure. No backend.
- Google Fonts are loaded at runtime (breaks offline). Naming is split across GeoStripe / StreetCityEditor / `streetcity` / `geostripe`. Root litter: tracked `cinci.geojson` (27k lines) and two `i75-alternative*.geojson`. Stale comments reference a removed `/builder` route and a nonexistent `convertLegacy`.

### 2.2 Map engine and imagery

- MapLibre GL, Web Mercator display. Basemaps: USGS NAIP (default; dynamic `exportImage` per tile, no cache, US only, z19), Esri World Imagery, Wayback (13 vintages), Clarity, Esri keyed, custom XYZ.
- NAIP tiles are rendered on demand (slower, uncached); there is no offline tile cache.
- Imagery licensing is out of scope while private (see section 5).

### 2.3 Coordinates

Geometry is stored as WGS84 lng/lat, but at least **four different metric scales** are in use:

1. `geo/projection.ts` `localPlane` (WGS84 series, origin = per-call `originFor(points)`).
2. `paint.ts` `pixelsPerMetre` (spherical `cos(lat)` with equatorial circumference, ~0.1-0.3% different from 1).
3. `paint.ts` stamp walking (metres-per-degree at each segment start).
4. `MapCanvas.snapAngle` (plain `cos(lat)` of the last point).

`curve.ts`, `build.ts` and `doc.ts` (`joinCandidate`, `splitPointFor`) each build their own scale as well.

**Concrete bug:** `designLayers(lat)` bakes `cos(centre latitude)` into the line-width expressions once and never rebuilds them, so loading or drawing far from the initial centre makes every width wrong by cos(lat1)/cos(lat2). Offsets and widths are rendered by MapLibre in Mercator while junction plates are built in a tangent plane, so the two drift apart away from the origin.

**Web Mercator (EPSG:3857) evaluation**

- Pros: it is exactly what MapLibre draws, so geometry and rendering share one plane and cannot drift; it is conformal, so angles (snapping directions, junction corner construction) are exact; no per-call origin; cheap forward/inverse math; planar libraries (polygon-clipping, Flatbush) work directly.
- Cons: lengths and areas are inflated by sec(lat) (about x1.29 length / x1.67 area at 39N, x1.9 / x3.6 at 58N), so **every metre-valued quantity must pass through the local scale factor k = 1/cos(lat)**. Naive 3857 "metres" are wrong for widths, radii, snap tolerances and stats. 3857 is not GeoJSON-legal as stored coordinates (RFC 7946 is WGS84), so exports must convert.
- **Recommendation (the first spike validates it):** store WGS84 in the file (GeoJSON-legal, no export surprises) and do all editing geometry in EPSG:3857 with an explicit per-feature scale factor k computed at the feature's own latitude, not a project-wide bake. Metric widths become `width_m * k` in 3857 units; in MapLibre a per-feature `k` property multiplies the zoom expression, which removes the latitude bake. Measurement (lengths, areas, stats) uses k-corrected values or a geodesic routine, verified against an independent reference. k varies by less than 0.05% over 5 km N-S, so per-feature k is safe; very long roads use per-vertex k.
- A project-local tangent plane (the current approach) was considered and **ruled out**: it keeps display and geometry in different planes. If the C0 spike finds a flaw in the 3857 approach, stop and re-decide with the owner rather than falling back.

**Acceptance for C0** (see Phase 1): a 3.6 m lane measures 3.6 m (+/-0.1%) against an independent geodesic at 20N, 39N and 60N, and across a project 5 km N-S; round trip lng/lat -> 3857 -> lng/lat is under 1 mm; a junction plate and its roads overlay within 1 cm at the project edge; loading Cincinnati then Anchorage needs no reload; `geo/crs.ts` is the only module allowed to convert, enforced by a guard test that fails on any other latitude `cos(` math or `111132` / `111320` literal.

### 2.4 Snapping and node collision

- Snap (`MapCanvas.snapAt`) is a rendered-feature query in a 14 px box. Node beats road; there is no true nearest-distance ranking, no priority table, no tolerance in metres. It depends on rendered layers (breaks on hidden decks) and re-runs `designLayers(0)` on every call.
- The area tool snaps to road centrelines with no opt-out. Bulldoze and upgrade have no hover target. There is no snapping to road edges, kerbs, parallel offsets, grid, perpendicular/tangent, or other area vertices.
- Collision: `layRoad` brute-force tests 96 samples against every segment (no index); crossings within 2 m of a road's own end are ignored; tangent/collinear overlaps are ignored; a failed split pushes an empty id and can desync pieces from the chain; roads at different elevations never interact; there is no minimum-length, minimum-angle or overlap validity; two nodes closer than a road width are allowed; `mergeNodes` is only user-initiated (12 m drop radius) and `joinCandidate` is a 30 m suggestion only.
- Interaction bugs: a mouse-up outside the canvas leaves drag state stuck; mouse-up reads a stale doc; dragging a node repaints the whole document on every mousemove.

### 2.5 Feature model and persistence

- `Doc = { nodes, segments, areas }`. Assets (cross-sections and 22 ground materials) share the undo snapshot. A road is an instance of its asset, with no per-road override, by design.
- **GeoJSON confirmed.** Features are tagged `streetcity: node | segment | area | band`; `band` polygons are export-only; the palette travels in a foreign member; `version: 2` is written but never read (no migrations). Save = download, Open = file picker. Validation is lenient Zod with gaps: assetId not checked, ranges and duplicate ids unchecked, silent palette failure, no try/catch around the file read, no size limit.
- **There is no persistence of any kind** (no localStorage, IndexedDB or unload guard). Imagery choice and units are not remembered either.

### 2.6 Feature status

| Feature | Status |
|---|---|
| Road build (straight / curved / freeform), split, crossing auto-split | Works; see snapping/collision defects |
| Junction plates (kerb-return construction) | Works for crossings and forks. No roundabouts, medians, crosswalks or stop bars; 2-leg bends under 40 deg get no plate; no guard for duplicate bearings or concave outlines |
| Upgrade / bulldoze / undo (100 snapshots) | Works; no hover preview |
| Elevation | Works as 3 decks; stacked flyovers share a deck |
| Ground areas | Partial: draw only; no vertex edit, no holes, no curve UI |
| Cross-section asset editor | Works (96 primitives; ~157 presets per code comments, unverified) |
| Asset file import/export | Dead code, no UI |
| Before/after swipe | Dead: store field and CSS only |
| Save / open GeoJSON | Works; no autosave |
| Buildings, zoning, districts, info views, planner stats | Absent |
| Tool hotkeys, multi-select, copy/paste, marquee | Absent |
| Animation | CSS hover transitions only |
| Accessibility | Partial: labels, focus rings, reduced-motion and dark scheme exist; drawer has no focus trap or Esc; nested interactive elements |
| Touch / mobile | Weak: only synthesized mouse events; responsive CSS targets dead classes |

### 2.7 Code quality, tests, performance

- Strengths: pure geo and model modules; guard tests for silent MapLibre failures; 640 tests (paint expressions, style validation, round trip, haversine dimension checks).
- Debt: `MapCanvas.tsx` 891 lines (styles, layers, every tool, keyboard), `paint.ts` 1085, store 925, `global.css` 3043 with large dead sections; Bezier code duplicated three times; duplicate constants (DECKS, source ids); `as never` casts hiding type errors; stale comments; undo bound twice (AppShell and MapCanvas); components read `getState()` during render; no component or MapCanvas tests.
- Performance (not measured): every doc or selection change repaints the whole document (`paintDoc` plus `setData` on 8 sources); feature count scales with roads x bands; `joinCandidate` is O(ends x nodes) and `endsAt` O(nodes x segments) per paint. Fine at demo scale; expect jank at thousands of segments.
- Probable crash (unverified): `Inspector.tsx:268` passes asset ids as component types to `PrimitivePalette` through `as never`.

### 2.8 Blockers before Phase 1 feature work

1. Coordinate unification (C0).
2. Snapping and collision rewrite on a spatial index (S0).
3. Autosave, crash recovery and unload guard (P0).
4. Render pipeline: split sources, selection/hover as feature-state, rAF coalescing, incremental updates (R0).
5. Document model generalised for new feature kinds, with schema versioning and migrations (D0).
6. Confirm and fix the Inspector crash; reapply layer visibility after `setStyle`; fix the basemap-switch `styledata` race; fix the stuck drag on mouse-up outside the canvas.
7. Rename and cleanup: dead code and CSS, root litter, stale comments, double undo binding (N0).

## 3. Phase 1: planner-grade editor with Cities: Skylines-style interaction

### Patterns being mimicked (please verify against your own play)

Described from general knowledge of Cities: Skylines I and II. Interaction and layout are mimicked; icons and art are original.

- Road tool with straight / curve / freeform modes and a live preview at real width.
- Green / red validity feedback on hover.
- Snapping to nodes, existing roads and angle guides.
- Automatic intersections where roads cross.
- Click a road with a type armed to upgrade or replace it.
- Bulldoze with hover highlight.
- Page Up / Page Down elevation.
- Zoning painted with a circular brush, per-type colours, and a dezone eraser.
- Placement ghost with rotation and valid/invalid colouring.
- Bottom toolbar of category icons that opens a panel.
- Info views that recolour the map by a property.

**Not mimicked:** policies, budget, demand, citizens, traffic, disasters, sound.

### UI/UX (hybrid)

- **Bottom toolbar:** categories Roads, Zoning, Buildings, Districts, Measure, each opening a drawer of types or brushes.
- **Docked right panel** (collapsible): tabs Properties, Layers & Views, Stats.
- **Top bar:** project name, autosave state, undo/redo, imagery and view controls.
- **Bottom status strip:** cursor lng/lat and project coordinates, scale bar, snap state, tool hints.
- Keyboard-first (tool hotkeys, brush size `[` `]`, rotate, Esc ladder), design tokens, dark and light themes, touch-sized hit areas.

### Milestones, in order

Order: C0 -> S0 -> P0 -> R0 -> D0 -> N0 -> M1 -> M2 -> M3 -> M6 -> M4 -> M5 -> M7. C0 and S0 come first; P0 can run in parallel.

#### M0 Foundations (the blockers) - Effort L

**C0 Coordinates** (spike first; S-M)
- Tasks: `geo/crs.ts` as the single conversion module; EPSG:3857 working plane with per-feature k; per-feature width in the render path; replace all four scales; guard test.
- Acceptance: as in 2.3.

**S0 Snapping + collision engine** (L)
- Tasks:
  - One spatial index (e.g. Flatbush / RBush) over nodes, segment edges and area vertices/edges.
  - Snap by true metric distance with a priority table: node > intersection > road centreline > road edge/kerb > area vertex/edge > angle/perpendicular guides > grid.
  - Tolerance in screen pixels converted to metres; visible snap glyph and label per type; Alt disables, Tab cycles candidates; hidden-deck features excluded explicitly.
  - Collision rules as data: minimum segment length, minimum angle at nodes, node-to-node minimum spacing (auto-merge inside a threshold with preview), end-on and T crossings, tangent/overlap handling (split and merge collinear), elevation separation, validity colouring.
  - Fix the empty-id desync in `layRoad`.
- Acceptance: property tests show random road networks never produce zero-length segments, nodes within the merge threshold, or desynced pieces; at 1000 random cursor positions the snap picks the geometrically nearest candidate; drag a node in a 5,000-segment project without frame drops below 30 fps (shared with R0).

**P0 Autosave** (S-M)
- Tasks: IndexedDB persistence, debounced 1 s and on `visibilitychange`; keyed per project; ring of the last N versions; restore prompt on load; "Saved 12 s ago" indicator; file export/import remains; `beforeunload` guard while dirty; multi-tab lock; quota errors handled.
- Acceptance: kill the tab mid-edit and recover everything up to 1 s before; behaviour is defined when storage is unavailable or full.

**R0 Render pipeline** (M-L)
- Tasks: per-kind sources; selection and hover as feature-state; incremental `updateData`; rAF coalescing; no repaint on selection change; re-apply layer visibility after `setStyle`; fix the basemap-switch race.
- Acceptance: 5,000 segments, node drag >= 30 fps (scripted measurement).

**D0 Document model** (M)
- Tasks: generalised feature registry (road, area, zone, building, district); `version` is read and migrations exist; validation of assetIds, ranges and duplicate ids; no silent failures; try/catch and size limit on import.
- Acceptance: files from the current version migrate with a round-trip test; invalid files produce a specific, user-visible message.

**N0 Rename + cleanup** (S)
- Tasks: StreetCityEditor in package name, UI, README, DEPLOYMENT and workflows; keep the `streetcity` file key; remove dead code and CSS (`assetFile.ts` is kept for Phase 2), root geojson moves to `examples/`; self-host fonts; fix stale comments; single undo binding; fix the Inspector crash.
- Acceptance: no occurrence of "GeoStripe" outside the changelog; build, typecheck and tests green.

#### M1 New shell and design system - Effort M

- Tasks: hybrid layout, tokens, original SVG icon set, status strip with coordinates and scale, panels, keyboard map, accessibility (focus trap, `aria-pressed`, valid roles), touch targets.
- Acceptance: every existing function is reachable in the new shell; axe checks pass; usable at 1280x720 and tablet width.
- Depends on N0.

#### M2 Complete the road tool - Effort L

- Tasks: validity preview and length tooltip; hover highlights for upgrade/bulldoze; tool hotkeys; one-way flag and direction arrows; roundabout generator (radius, N legs, island); plate for gentle 2-leg bends; crosswalk and stop-bar markings; insert a bend into a segment; multi-select and copy/paste; real touch input.
- Hard geometry: junction outlines for acute, near-parallel and concave arrangements; duplicate bearings; roundabout tangency and splitting inbound roads; tapers between differing assets.
- Acceptance: each behaviour is demonstrable in a scripted manual test; a fuzz test over random leg sets yields simple (non-self-intersecting) junction polygons.
- Depends on S0, R0.

#### M3 Zoning with free-paint polygons - Effort L

- Tasks: land-use catalogue, **no attributes**, modelled on the existing `landcover.ts` shape (`id -> { label, category, color, opacity, note }`) so zones are just another area material and reuse the area rendering, save and palette code. v1 classes, grouped by category:
  - Residential: Low-density residential, Medium-density residential, High-density residential.
  - Commercial: Retail / commercial, Office, Mixed use.
  - Industrial: Light industrial, Heavy industrial.
  - Civic: Institutional (schools, government, hospitals), Utilities / infrastructure.
  - Open: Parks & recreation, Natural / conservation, Agriculture, Vacant.
  Colours follow the muted, semi-transparent-over-imagery convention already used. The list lives in data, so classes can be added or renamed without code changes. Also: brush tool (circle / square, size via `[` `]`, snap-to-road-edge toggle); polygon tool; eraser; vertex editing; holes; merge same type; overlap rule (later paint wins); fill-enclosed-block command using road-graph faces; undo as one step.
- Hard geometry: polygon booleans (union / difference) in the 3857 plane via a vetted library, with winding, holes, slivers and tolerance cleanup. The "no polygon booleans" principle in the current README is dropped **for zones only**; roads keep the overlay model.
- Acceptance: 500 random strokes leave no self-intersections; total area equals the union area of a reference within 0.1%; round trip through save/load and autosave.
- Depends on C0, S0, D0, R0.

#### M6 Info views and planner stats - Effort M

- Tasks: view modes that recolour by property (land use, road type, right-of-way width, elevation, district), legend, imagery dimming; Stats tab with lane-km per road type, total right-of-way area, area per land use (and per district once M5 lands), units toggle. These are measurements, not simulation.
- Acceptance: numbers match independent geodesic calculations on test projects.
- Depends on M3 (land-use views); road-type and elevation views can ship earlier.

#### M4 Buildings and assets - Effort M

- Scope: **2D footprints only.** Footprint polygons and point assets with rotation (15 degree steps, free with Shift), ghost with valid/invalid reason, snap to frontage and zone edges. No attributes and no 3D view; a building is a footprint of a chosen building type.
- Acceptance: placement validity uses the spatial index; exported as GeoJSON polygons.
- Depends on S0, M3.

#### M5 Districts - Effort M

- Scope: named planning-district polygons with a colour (**no policies, no other attributes**). Reuse the M3 brush and polygon tools; labels and an outline view.
- Acceptance: district stats roll up zoned areas.
- Depends on M3, M6.

#### M7 Polish - Effort S

- Placement and bulldoze animations, drawer transitions, `prefers-reduced-motion` respected. No sound.

## 4. Phase 2: our own spin

Ranked by impact against effort.

| # | Idea | Impact | Effort | Backend? |
|---|---|---|---|---|
| 1 | Real-world cross-section library as editable multi-lane polygons (US packs: NACTO, AASHTO; sourced standards; validation) | High | S-M | No |
| 2 | Before/after slider against current imagery (wire up the dead swipe state and CSS; clip design layers against imagery) | High | S | No |
| 3 | Planner exports: **GeoJSON only** (exists; extend to zones, buildings, districts, and a per-feature-kind export). Other formats are not planned. | High | S | No |
| 4 | Streetmix-style cross-section builder with Streetmix JSON import and shareable asset files (revive `assetFile.ts`) | High | S-M | No |
| 5 | Project share by file and URL-encoded small projects | Med | S | No; cloud sharing would need a backend |
| 6 | OSM import to start from existing roads/zones (Overpass), attribution in exports | High | M | No (public API) |
| 7 | Scenario compare: named alternatives per project, side-by-side stats | Med-High | M | No |
| 8 | Review comments and pins | Med | M | Yes if shared |
| 9 | Desktop build (Tauri) with filesystem autosave | Low-Med | M | No |

Detail for the top items:

- **Real cross-sections:** the editor, 96 primitives and the preset library already exist. Work is region packs with cited sources, validation (lane width ranges, ADA clearances) and a visible "as-built vs standard" comparison. Acceptance: every US preset cites a source and renders at the stated dimensions (existing haversine tests extended).
- **Before/after slider:** use the existing store field; draw a movable divider that clips the design layers or imagery. Acceptance: smooth at 60 fps on a 1080p screen; works with every basemap.
- **Planner exports:** GeoJSON in WGS84 via the single `geo/crs.ts`, with zones, buildings and districts as their own tagged features. Acceptance: files open in QGIS with correct geometry and the measured lane widths match the design.
- **Streetmix-style builder:** the asset editor exists; add Streetmix JSON import and a shared asset library file. Acceptance: round trip of a Streetmix street with dimensions preserved.

### Considered and rejected

- Traffic, economy, policy, finance and citizen simulation: explicitly out of scope.
- Walkability / transit-catchment simulation layer: deferred; would reopen the scope boundary.
- Real-time multiplayer editing: backend and CRDT cost.
- AI-generated designs: accuracy and liability.
- 3D buildings from imagery and any 3D extrusion view: 2D footprints only.
- Electron: Tauri is smaller if a desktop build is ever wanted.
- Sound: removed from scope.

## 5. Risks and open questions

### Risks

- **Coordinates:** per-feature k still needs a clear rule for very long features, and mixing 3857 with geodesic measurement is an error source. A single `crs` module plus guard tests is mandatory.
- **Geometry complexity:** polygon booleans and junction outlines on awkward input; roundabouts; GPU line-offset and polygon plates diverging on sharp curves.
- **Performance:** whole-document repaint, O(n^2) helpers and per-band feature duplication until R0 lands.
- **Format churn:** adding feature kinds without migrations strands saved files (D0).
- **Scope creep** back toward simulation; keep Stats strictly measurement.
- **Deferred while private:** imagery licensing for the Esri endpoints (World Imagery, Wayback, Clarity), Google Fonts, and public hosting terms. Revisit before any public release; NAIP is public domain.

### Open questions

Resolved:

1. Coordinates: no project-local metric plane. The approach is WGS84 stored, EPSG:3857 edited with a per-feature scale factor; the C0 spike validates it numerically. (Dropped the tangent-plane alternative from 2.3 as an option.)
2. Land use: classes chosen by the team (list in M3), no attributes, same shape as `landcover.ts`.
3. Export: GeoJSON only.

Still open:

4. Polygon-boolean and spatial-index dependencies (polygon-clipping, Flatbush): needed for brush painting/erasing and for fast snapping. Awaiting a yes/no; assumed yes unless told otherwise.
5. The suspected Inspector crash: unconfirmed. First task in N0 is to reproduce it in a running build.
