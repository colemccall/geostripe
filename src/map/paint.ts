import type { ExpressionSpecification, LayerSpecification } from 'maplibre-gl';
import type { Feature, FeatureCollection, LineString, Point, Polygon } from 'geojson';
import { closeRing, resolveCenterline, resolveRing } from '../geo/curve';
import { junctionPlates } from '../geo/junction';
import type { Arrival } from '../geo/junction';
import { dedupe, localPlane, originFor } from '../geo/projection';
import type { LngLat, LocalPlane } from '../geo/projection';
import { defaultGlyphFor, stripeBetween } from '../geo/markings';
import type { StripeStyle } from '../geo/markings';
import { PAINT_WHITE, PAINT_YELLOW } from '../geo/markings';
import { GLYPHS } from '../geo/glyphs';
import { IMAGE_PX_PER_METRE } from './glyphImages';
import { metresPerDegreeLat, metresPerDegreeLng } from '../geo/projection';
import { LANDCOVERS } from '../library/landcover';
import { PRIMITIVES } from '../library/primitives';
import { boundaryOffsets, componentStarts, resolveAnchorOffset, sectionExtent } from '../model/section';
import { endsAt, nodeMap, segmentControlPoints, segmentElevation } from '../model/doc';
import type { Doc, Node, Segment } from '../model/doc';
import { isLineAsset } from '../model/asset';
import type { Asset, LineAsset } from '../model/asset';

/**
 * Turning the document into what the map draws.
 *
 * The one decision this file exists to make, and the reason the geometry engine is gone:
 *
 *   A ROAD IS ITS CENTERLINE, DRAWN MANY TIMES.
 *
 * A four-lane street with footways is one LineString emitted eight times over — once per
 * band — each copy carrying the width and the sideways offset of the band it stands for.
 * MapLibre does the offsetting, the mitring and the joins on the GPU, at whatever zoom the
 * user is at, every frame, for free.
 *
 * What that replaces is the whole of the old pipeline: tessellate the curve, offset the
 * polyline once per boundary, mitre the joins with a bevel fallback, close each band into a
 * polygon, then subtract every junction it passes through with a polygon boolean. That was
 * roughly three hundred and forty milliseconds of work on a ten-street project, repeated
 * whenever anything moved, and it was the reason the editor slowed down as a drawing grew.
 * Here the cost of a band is one property bag. Dragging a node rebuilds a few dozen of
 * them.
 *
 * The width is exact rather than approximate, which is the part worth being careful about.
 * Web Mercator scales by a factor of two per zoom level, so a metre is
 *
 *     pixels = metres × 512 × 2^zoom / (40075016.686 × cos(latitude))
 *
 * and an `['exponential', 2]` interpolation between two zoom stops reproduces exactly that
 * curve, not an approximation of it. So a 3.6 m lane measures 3.6 m at zoom 14 and at zoom
 * 22 alike, and the fit of a design against the imagery under it — which is the claim this
 * whole tool makes — is as honest as it was when polygons were being computed.
 *
 * The one thing the expression cannot know is latitude, because cos(latitude) is not
 * available to it. It is baked in from the project's own centre, which is correct over a
 * project and wrong over a continent; a design spanning enough latitude for that to matter
 * is not a design of a street.
 */

/** Circumference of the Earth at the equator, in metres — Web Mercator's world width. */
const EQUATOR_METRES = 40075016.686;

/** MapLibre's world is this many CSS pixels across at zoom zero. */
const WORLD_PIXELS_AT_Z0 = 512;

/**
 * The two stops the metre-to-pixel expression is pinned at.
 *
 * Any two would do — the interpolation between them is exact — but spanning the full zoom
 * range means the expression is never extrapolated, which MapLibre would clamp.
 */
const MIN_ZOOM = 0;
const MAX_ZOOM = 24;

export function pixelsPerMetre(latDeg: number, zoom: number): number {
  const ground = EQUATOR_METRES * Math.cos((latDeg * Math.PI) / 180);
  return (WORLD_PIXELS_AT_Z0 * Math.pow(2, zoom)) / ground;
}

/**
 * An expression turning a value in metres into screen pixels, exactly, at every zoom.
 *
 * `zoom` has to be the input of the OUTERMOST interpolate — MapLibre rejects it anywhere
 * else — so the feature property is multiplied inside each stop rather than outside the
 * whole thing. That constraint is the only reason this looks the way it does.
 */
export function metresToPixels(latDeg: number, metres: ExpressionSpecification | number) {
  return [
    'interpolate',
    ['exponential', 2],
    ['zoom'],
    MIN_ZOOM,
    ['*', metres, pixelsPerMetre(latDeg, MIN_ZOOM)],
    MAX_ZOOM,
    ['*', metres, pixelsPerMetre(latDeg, MAX_ZOOM)],
  ] as ExpressionSpecification;
}

// ------------------------------------------------------------------------- levels

/**
 * Which of three decks a segment is drawn on.
 *
 * Drawing order has to run bands, then stripes, then junction plates for each deck in turn,
 * or an at-grade road's lane markings paint themselves across the bridge above it. Since a
 * MapLibre layer draws entirely before the next one starts, the only way to interleave is
 * to have a set of layers per deck.
 *
 * Three of them, not one per distinct level, because layers are created once when the style
 * is built and levels are authored freely. Clamping means two stacked flyovers share a deck
 * and their order between themselves falls back to draw order — a real limit, and a cheap
 * one next to rebuilding the style whenever somebody presses Page Up.
 */
export const DECKS = [-1, 0, 1] as const;
export type Deck = (typeof DECKS)[number];

export const deckOf = (level: number | undefined): Deck =>
  !level ? 0 : level < 0 ? -1 : 1;

// -------------------------------------------------------------------------- output

export interface PaintSources {
  /** One feature per band per segment: the same line, offset and widened per band. */
  bands: FeatureCollection<LineString>;
  /** Lane lines and edge lines, likewise offset copies of the same centerline. */
  stripes: FeatureCollection<LineString>;
  /** Pavement symbols: one point per placement, rotated to the road. */
  stamps: FeatureCollection<Point>;
  /** Junction plates, drawn over the road ends they cover. */
  plates: FeatureCollection<Polygon>;
  /** Parks, plazas, water — the ground under everything. */
  areas: FeatureCollection<Polygon>;
  /** Nodes and shape points: the handles, which are not on the ground. */
  handles: FeatureCollection<Point>;
  /** Centerlines for selection and for dragging. */
  guides: FeatureCollection<LineString>;
}

export interface PaintOptions {
  selectedSegmentId?: string | null;
  selectedNodeId?: string | null;
  selectedAreaId?: string | null;
  /** Kerb radius for a node that does not state one and whose roads do not either. */
  defaultRadiusMeters: number;
  /** Draw every centerline, not just the selected one. */
  showAllCenterlines?: boolean;
}

const empty = <T extends Feature['geometry']>(): FeatureCollection<T> => ({
  type: 'FeatureCollection',
  features: [],
});

// --------------------------------------------------------------------------- build

/**
 * The centre of the project, which fixes the latitude the metre scale is built from.
 *
 * Recomputed on every build rather than cached: it is a bounding-box midpoint over a few
 * hundred points, and a stale one would silently mis-scale every width in the project after
 * the user pans to a new city.
 */
export function projectCentre(doc: Doc): LngLat {
  const points: LngLat[] = doc.nodes.map((n) => n.position);
  for (const area of doc.areas) points.push(...area.ring);
  return points.length ? originFor(points) : [0, 0];
}

interface Resolved {
  segment: Segment;
  asset: LineAsset;
  line: LngLat[];
  /** Taken from the segment's nodes, because height is a property of the place. */
  elevation: number;
}

/** The line a segment is drawn along: its start node, its shape, its end node. */
function resolveSegments(doc: Doc, assets: ReadonlyMap<string, Asset>): Resolved[] {
  const nodes = nodeMap(doc);
  const out: Resolved[] = [];

  for (const segment of doc.segments) {
    if (segment.visible === false) continue;
    const asset = assets.get(segment.assetId);
    if (!asset || !isLineAsset(asset)) continue;

    const controls = segmentControlPoints(segment, nodes);
    if (!controls) continue;

    const line = dedupe(
      resolveCenterline({ id: segment.id, centerline: controls, curve: segment.curve }),
    );
    if (line.length < 2) continue;

    out.push({ segment, asset, line, elevation: segmentElevation(segment, nodes) });
  }

  return out;
}

/**
 * Signed offset of each band's centre from the drawn line, and its width.
 *
 * Positive is to the RIGHT of the direction of travel, which is MapLibre's own convention
 * for `line-offset` — so the section's left-to-right order needs no flipping anywhere. A
 * segment drawn against the grain negates the offset instead of reversing the stack, which
 * is the same picture and one operation.
 */
function bandOffsets(asset: LineAsset, reversed: boolean): { offset: number; width: number }[] {
  const anchor = resolveAnchorOffset(asset);
  const starts = componentStarts(asset.components);
  const sign = reversed ? -1 : 1;

  return asset.components.map((component, i) => ({
    offset: sign * (starts[i]! + component.widthMeters / 2 - anchor),
    width: component.widthMeters,
  }));
}

function bandFeatures(resolved: readonly Resolved[]): Feature<LineString>[] {
  const out: Feature<LineString>[] = [];

  for (const { segment, asset, line, elevation } of resolved) {
    const geometry: LineString = { type: 'LineString', coordinates: line };
    const bands = bandOffsets(asset, segment.reversed === true);

    asset.components.forEach((component, i) => {
      const band = bands[i]!;
      if (band.width <= 0) return;
      const primitive = PRIMITIVES[component.componentType];
      out.push({
        type: 'Feature',
        geometry,
        properties: {
          segmentId: segment.id,
          assetId: asset.id,
          componentType: component.componentType,
          widthM: band.width,
          offsetM: band.offset,
          color: component.colorOverride ?? primitive.color,
          deck: deckOf(elevation),
          // Raised bands last within a segment, so a kerb reads above the asphalt beside it.
          raised: primitive.isRaised ? 1 : 0,
        },
      });
    });
  }

  // Within one layer MapLibre draws in feature order, so deck order is imposed here rather
  // than by a filter — a tunnel has to be under the ground its neighbour sits on.
  return out.sort(
    (a, b) =>
      (a.properties!.deck as number) - (b.properties!.deck as number) ||
      (a.properties!.raised as number) - (b.properties!.raised as number),
  );
}

/** Painted white, or painted yellow. Nothing else is painted on a road. */
const stripeColor = (style: StripeStyle): string =>
  style === 'centreDouble' || style === 'centreDashed' ? PAINT_YELLOW : PAINT_WHITE;

/** Stripe widths, in metres. A double centre line is two of these plus the gap between. */
const STRIPE_WIDTH_METRES = 0.12;
const DOUBLE_GAP_METRES = 0.12;

const DASHED: ReadonlySet<StripeStyle> = new Set<StripeStyle>([
  'laneDashed',
  'bikeDashed',
  'centreDashed',
]);

/**
 * The lane lines, as more offset copies of the same centerline.
 *
 * Derived from what sits either side of each boundary rather than authored: double yellow
 * between opposing directions, dashed white between lanes going the same way, solid against
 * a bike lane or parking, nothing at all at a kerb. A component can override the stripe on
 * its own left edge, which is named for the edge so two overrides can never disagree about
 * one boundary.
 *
 * These stop at nothing. They run the full length of the segment and straight through the
 * junction at the end of it — and are then covered by the junction plate, which is drawn
 * after them. No trimming, and no stripe left painted across an intersection.
 */
function stripeFeatures(resolved: readonly Resolved[]): Feature<LineString>[] {
  const out: Feature<LineString>[] = [];

  for (const { segment, asset, line, elevation } of resolved) {
    if (asset.components.length < 2) continue;
    const geometry: LineString = { type: 'LineString', coordinates: line };
    const offsets = boundaryOffsets(asset);
    const sign = segment.reversed === true ? -1 : 1;
    const deck = deckOf(elevation);

    for (let i = 1; i < asset.components.length; i++) {
      const before = asset.components[i - 1]!;
      const after = asset.components[i]!;
      const style = after.stripeLeft ?? stripeBetween(before, after).style;
      if (style === 'none') continue;

      const boundary = offsets[i];
      if (boundary === undefined) continue;

      const color = stripeColor(style);
      const dashed = DASHED.has(style);
      // A double line is two stripes either side of the boundary, which is what it is.
      const lanes =
        style === 'centreDouble'
          ? [-(DOUBLE_GAP_METRES + STRIPE_WIDTH_METRES) / 2, (DOUBLE_GAP_METRES + STRIPE_WIDTH_METRES) / 2]
          : [0];

      for (const shift of lanes) {
        out.push({
          type: 'Feature',
          geometry,
          properties: {
            segmentId: segment.id,
            style,
            widthM: STRIPE_WIDTH_METRES,
            offsetM: sign * (boundary + shift),
            color,
            dashed: dashed ? 1 : 0,
            deck,
          },
        });
      }
    }
  }

  return out.sort((a, b) => (a.properties!.deck as number) - (b.properties!.deck as number));
}


/**
 * Pavement symbols along a band.
 *
 * One point per placement, carrying which symbol and which way it faces. The points are the
 * only thing computed — walking a polyline and stepping along it — and the symbol layer does
 * the rest, so a bike lane with a marking every twenty metres costs a few dozen points
 * rather than a few hundred polygons.
 *
 * A symbol wider than the lane it sits in is dropped rather than drawn spilling over the
 * stripe, which is the same rule the old renderer had and is the reason a sharrow does not
 * appear in a metre-wide gutter.
 */
function stampFeatures(resolved: readonly Resolved[]): Feature<Point>[] {
  const out: Feature<Point>[] = [];

  for (const { segment, asset, line, elevation } of resolved) {
    const bands = bandOffsets(asset, segment.reversed === true);
    const deck = deckOf(elevation);

    asset.components.forEach((component, i) => {
      if (component.glyph === 'none') return;
      const chosen = component.glyph
        ? { glyph: component.glyph, spacingMeters: component.glyphSpacingMeters ?? 25 }
        : defaultGlyphFor(component);
      if (!chosen) return;

      const spec = GLYPHS[chosen.glyph];
      if (!spec || spec.widthMeters > component.widthMeters) return;

      const spacing = component.glyphSpacingMeters ?? chosen.spacingMeters;
      if (spacing <= 0) return;

      const band = bands[i]!;
      for (const placement of walk(line, spacing, band.offset)) {
        out.push({
          type: 'Feature',
          geometry: { type: 'Point', coordinates: placement.position },
          properties: {
            segmentId: segment.id,
            glyph: chosen.glyph,
            // Compass bearing of travel, which is what icon-rotate wants once the image is
            // drawn with travel pointing up.
            bearing: segment.reversed === true ? placement.bearing + 180 : placement.bearing,
            deck,
          },
        });
      }
    });
  }

  return out.sort((a, b) => (a.properties!.deck as number) - (b.properties!.deck as number));
}

/**
 * Step along a line at a fixed spacing, offset sideways.
 *
 * Starts half a spacing in so a symbol never lands exactly on a junction, and reports the
 * heading at each point so the symbol can be turned to match the road.
 */
function walk(
  line: readonly LngLat[],
  spacingMeters: number,
  offsetMeters: number,
): { position: LngLat; bearing: number }[] {
  const out: { position: LngLat; bearing: number }[] = [];
  let next = spacingMeters / 2;
  let travelled = 0;

  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i]!;
    const b = line[i + 1]!;
    const mPerLat = metresPerDegreeLat(a[1]);
    const mPerLng = metresPerDegreeLng(a[1]);

    const dx = (b[0] - a[0]) * mPerLng;
    const dy = (b[1] - a[1]) * mPerLat;
    const length = Math.hypot(dx, dy);
    if (length < 1e-9) continue;

    const ux = dx / length;
    const uy = dy / length;
    // Compass bearing: clockwise from north, which is what a symbol's rotation wants.
    const bearing = (Math.atan2(ux, uy) * 180) / Math.PI;

    while (next <= travelled + length) {
      const along = next - travelled;
      // Left of travel, matching the sign convention offsets use everywhere else.
      const nx = -uy * offsetMeters;
      const ny = ux * offsetMeters;
      out.push({
        position: [
          a[0] + (ux * along + nx) / mPerLng,
          a[1] + (uy * along + ny) / mPerLat,
        ],
        bearing,
      });
      next += spacingMeters;
    }

    travelled += length;
  }

  return out;
}

/**
 * Which way a segment leaves a node, and how wide it is when it gets there.
 *
 * The direction is taken a little way along the line rather than from its first vertex.
 * A tessellated curve's first edge can be under a metre long, and a node shared by several
 * roads sits where they MEET rather than exactly on any one of them, so the first edge
 * points off at an angle that has nothing to do with where the road is going. Sampling
 * further out costs nothing and is stable.
 */
const DIRECTION_SAMPLE_METRES = 8;

function arrivalFor(
  resolved: Resolved,
  end: 'from' | 'to',
  plane: LocalPlane,
  elevation: number,
): Arrival | null {
  const { segment, asset, line } = resolved;
  const outward = end === 'from' ? line : [...line].reverse();
  const start = plane.toPlane(outward[0]!);

  let dx = 0;
  let dy = 0;
  for (let i = 1; i < outward.length; i++) {
    const p = plane.toPlane(outward[i]!);
    dx = p.x - start.x;
    dy = p.y - start.y;
    if (Math.hypot(dx, dy) >= DIRECTION_SAMPLE_METRES) break;
  }

  const length = Math.hypot(dx, dy);
  if (length < 1e-9) return null;

  const extent = sectionExtent(asset);
  const paved = pavedExtent(asset);
  // Looking outward from the `to` node reverses the road, so its left kerb is on the right.
  const flip = (end === 'to') !== (segment.reversed === true);

  return {
    segmentId: segment.id,
    direction: [dx / length, dy / length],
    halfLeft: flip ? extent.right : extent.left,
    halfRight: flip ? extent.left : extent.right,
    pavedLeft: flip ? paved.right : paved.left,
    pavedRight: flip ? paved.left : paved.right,
    // The height AT THIS NODE, not the road's own. A ramp climbing to a bridge still meets
    // the street at its low end, and taking the road's higher end here would say it does not.
    level: elevation,
  };
}

/** How far the carriageway reaches either side of the drawn line. Zero for a path. */
function pavedExtent(asset: LineAsset): { left: number; right: number } {
  const anchor = resolveAnchorOffset(asset);
  const starts = componentStarts(asset.components);
  let first = -1;
  let last = -1;

  asset.components.forEach((component, i) => {
    if (PRIMITIVES[component.componentType].isRoadway) {
      if (first < 0) first = i;
      last = i;
    }
  });

  if (first < 0) return { left: 0, right: 0 };
  return {
    left: Math.abs(Math.min(0, starts[first]! - anchor)),
    right: Math.max(0, starts[last]! + asset.components[last]!.widthMeters - anchor),
  };
}

/** The kerb radius a node uses: its own, else the largest any road arriving asks for. */
function radiusFor(
  node: Node,
  arriving: readonly Resolved[],
  fallback: number,
): number {
  if (node.radiusMeters !== undefined) return node.radiusMeters;
  let radius = 0;
  for (const { asset } of arriving) radius = Math.max(radius, asset.cornerRadiusMeters ?? 0);
  return radius > 0 ? radius : fallback;
}

function plateFeatures(
  doc: Doc,
  resolved: readonly Resolved[],
  plane: LocalPlane,
  defaultRadius: number,
): Feature<Polygon>[] {
  const byId = new Map(resolved.map((r) => [r.segment.id, r]));
  const out: Feature<Polygon>[] = [];

  for (const node of doc.nodes) {
    const ends = endsAt(node.id, doc.segments);
    const arrivals: Arrival[] = [];
    const involved: Resolved[] = [];

    for (const { segment, end } of ends) {
      const item = byId.get(segment.id);
      if (!item) continue;
      const arrival = arrivalFor(item, end, plane, node.elevation ?? 0);
      if (arrival) {
        arrivals.push(arrival);
        involved.push(item);
      }
    }

    const plates = junctionPlates(
      node.id,
      node.position,
      arrivals,
      radiusFor(node, involved, defaultRadius),
      plane,
    );
    if (!plates) continue;

    const deck = deckOf(node.elevation ?? 0);
    out.push({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [closeRing(plates.footprint)] },
      properties: { nodeId: node.id, kind: 'footprint', deck, color: PRIMITIVES.sidewalk.color },
    });
    if (plates.paved) {
      out.push({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [closeRing(plates.paved)] },
        properties: { nodeId: node.id, kind: 'paved', deck, color: PRIMITIVES.travelLane.color },
      });
    }
  }

  // Footprints of a whole deck before any of its paved plates, so a corner footway is never
  // painted over by the asphalt of the junction next door.
  return out.sort(
    (a, b) =>
      (a.properties!.deck as number) - (b.properties!.deck as number) ||
      (a.properties!.kind === 'footprint' ? 0 : 1) - (b.properties!.kind === 'footprint' ? 0 : 1),
  );
}

function areaFeatures(doc: Doc, assets: ReadonlyMap<string, Asset>): Feature<Polygon>[] {
  const out: Feature<Polygon>[] = [];

  for (const area of doc.areas) {
    if (area.visible === false) continue;
    const asset = assets.get(area.assetId);
    if (!asset || asset.kind !== 'area') continue;
    const ring = resolveRing({ id: area.id, ring: area.ring, curve: area.curve });
    if (ring.length < 3) continue;
    const material = LANDCOVERS[asset.material];
    out.push({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [closeRing(ring)] },
      properties: {
        areaId: area.id,
        assetId: asset.id,
        color: material.color,
        opacity: material.opacity,
      },
    });
  }

  return out;
}

function handleFeatures(doc: Doc, options: PaintOptions): Feature<Point>[] {
  const degree = new Map<string, number>(doc.nodes.map((n) => [n.id, 0]));
  for (const segment of doc.segments) {
    if (segment.visible === false) continue;
    degree.set(segment.fromNodeId, (degree.get(segment.fromNodeId) ?? 0) + 1);
    degree.set(segment.toNodeId, (degree.get(segment.toNodeId) ?? 0) + 1);
  }

  const out: Feature<Point>[] = doc.nodes.map((node) => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: node.position },
    properties: {
      nodeId: node.id,
      kind: 'node',
      degree: degree.get(node.id) ?? 0,
      selected: node.id === options.selectedNodeId ? 1 : 0,
    },
  }));

  // Shape points belong to the selected road only. Every bend in the project drawn at once
  // is a field of dots you cannot click through to the design underneath.
  const selected = doc.segments.find((s) => s.id === options.selectedSegmentId);
  if (selected) {
    selected.shape.forEach((point, i) => {
      out.push({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: point },
        properties: { segmentId: selected.id, kind: 'shape', shapeIndex: i, selected: 1 },
      });
    });
  }

  return out;
}

function guideFeatures(resolved: readonly Resolved[], options: PaintOptions): Feature<LineString>[] {
  return resolved
    .filter((r) => options.showAllCenterlines || r.segment.id === options.selectedSegmentId)
    .map((r) => ({
      type: 'Feature',
      geometry: { type: 'LineString', coordinates: r.line } as LineString,
      properties: {
        segmentId: r.segment.id,
        selected: r.segment.id === options.selectedSegmentId ? 1 : 0,
      },
    }));
}

/**
 * Build every source the map draws from.
 *
 * One pass over the document, no caching, no memoisation. That is affordable now in a way
 * it was not before: the expensive thing used to be turning a line into polygons, and
 * nothing here turns anything into a polygon except the junction plates, which are a convex
 * hull of at most a few dozen points each.
 */
export function paintDoc(
  doc: Doc,
  assets: ReadonlyMap<string, Asset>,
  options: PaintOptions,
): PaintSources {
  const resolved = resolveSegments(doc, assets);
  const plane = localPlane(projectCentre(doc));

  return {
    bands: { type: 'FeatureCollection', features: bandFeatures(resolved) },
    stripes: { type: 'FeatureCollection', features: stripeFeatures(resolved) },
    stamps: { type: 'FeatureCollection', features: stampFeatures(resolved) },
    plates: {
      type: 'FeatureCollection',
      features: plateFeatures(doc, resolved, plane, options.defaultRadiusMeters),
    },
    areas: { type: 'FeatureCollection', features: areaFeatures(doc, assets) },
    handles: { type: 'FeatureCollection', features: handleFeatures(doc, options) },
    guides: { type: 'FeatureCollection', features: guideFeatures(resolved, options) },
  };
}

/**
 * The road under construction, painted with the real renderer.
 *
 * Not a dashed line standing in for a road. It is the same band stack the finished road
 * gets, built from a throwaway document holding one segment, so the preview is the thing
 * itself at the width it will really be. A tool that previews a hairline and then lays a
 * forty-metre freeway is a tool you have to learn to compensate for.
 *
 * Cheap enough to run on every pointer move because it paints one segment, not the project.
 */
export function paintPreview(
  assets: ReadonlyMap<string, Asset>,
  assetId: string,
  controls: readonly LngLat[],
  curved: boolean,
  elevation: number,
): FeatureCollection<LineString> {
  if (controls.length < 2) return empty<LineString>();

  const doc: Doc = {
    nodes: [
      { id: 'preview-a', position: controls[0]!, elevation },
      { id: 'preview-b', position: controls[controls.length - 1]!, elevation },
    ],
    segments: [
      {
        id: 'preview-s',
        assetId,
        fromNodeId: 'preview-a',
        toNodeId: 'preview-b',
        shape: controls.slice(1, -1) as LngLat[],
        curve: curved ? { mode: 'bezier', radiusMeters: 12 } : undefined,
        visible: true,
      },
    ],
    areas: [],
  };

  return { type: 'FeatureCollection', features: bandFeatures(resolveSegments(doc, assets)) };
}

export const emptySources = (): PaintSources => ({
  bands: empty<LineString>(),
  stripes: empty<LineString>(),
  stamps: empty<Point>(),
  plates: empty<Polygon>(),
  areas: empty<Polygon>(),
  handles: empty<Point>(),
  guides: empty<LineString>(),
});

// --------------------------------------------------------------------------- layers

/**
 * The layers, in draw order.
 *
 * Read top to bottom this is the design's cross-section in z: the ground, then each deck's
 * road surface, its paint, and the junction plates that cover both. The plates coming AFTER
 * the stripes is not an implementation detail — it is what removes junction trimming from
 * the project entirely.
 */
export function designLayers(latDeg: number): LayerSpecification[] {
  const width = metresToPixels(latDeg, ['get', 'widthM'] as ExpressionSpecification);
  const offset = metresToPixels(latDeg, ['get', 'offsetM'] as ExpressionSpecification);
  const layers: LayerSpecification[] = [];

  layers.push({
    id: 'area-fill',
    type: 'fill',
    source: 'areas',
    paint: {
      'fill-color': ['get', 'color'],
      'fill-opacity': ['get', 'opacity'],
    },
  });

  for (const deck of DECKS) {
    layers.push({
      id: `band-${deck}`,
      type: 'line',
      source: 'bands',
      filter: ['==', ['get', 'deck'], deck],
      layout: { 'line-cap': 'butt', 'line-join': 'round' },
      paint: { 'line-color': ['get', 'color'], 'line-width': width, 'line-offset': offset },
    });

    layers.push({
      id: `stripe-solid-${deck}`,
      type: 'line',
      source: 'stripes',
      filter: ['all', ['==', ['get', 'deck'], deck], ['==', ['get', 'dashed'], 0]],
      layout: { 'line-cap': 'butt' },
      paint: { 'line-color': ['get', 'color'], 'line-width': width, 'line-offset': offset },
    });

    layers.push({
      id: `stripe-dashed-${deck}`,
      type: 'line',
      source: 'stripes',
      filter: ['all', ['==', ['get', 'deck'], deck], ['==', ['get', 'dashed'], 1]],
      layout: { 'line-cap': 'butt' },
      paint: {
        'line-color': ['get', 'color'],
        'line-width': width,
        'line-offset': offset,
        // In stripe-widths, so the dash keeps its proportions as the line scales with zoom.
        'line-dasharray': [24, 24],
      },
    });

    layers.push({
      id: `stamp-${deck}`,
      type: 'symbol',
      source: 'stamps',
      filter: ['==', ['get', 'deck'], deck],
      layout: {
        'icon-image': ['get', 'glyph'],
        'icon-rotate': ['get', 'bearing'],
        // Turn with the map, not with the screen: a lane arrow points down its lane.
        'icon-rotation-alignment': 'map',
        // Symbols are placed where the design puts them, not where there is room. A bike
        // symbol suppressed for collision is a bike symbol missing from the drawing.
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
        // The image is drawn at a known pixels-per-metre, so scaling it back to ground
        // metres is the same arithmetic the line widths use.
        'icon-size': metresToPixels(latDeg, 1 / IMAGE_PX_PER_METRE),
      },
    });

    layers.push({
      id: `plate-${deck}`,
      type: 'fill',
      source: 'plates',
      filter: ['==', ['get', 'deck'], deck],
      paint: { 'fill-color': ['get', 'color'] },
    });
  }

  // The road under construction, over everything built but under the handles. Translucent,
  // because it is a proposal rather than a thing that exists.
  layers.push({
    id: 'preview-band',
    type: 'line',
    source: 'preview',
    layout: { 'line-cap': 'butt', 'line-join': 'round' },
    paint: {
      'line-color': ['get', 'color'],
      'line-width': width,
      'line-offset': offset,
      'line-opacity': 0.65,
    },
  });

  layers.push({
    id: 'guide-line',
    type: 'line',
    source: 'guides',
    layout: { 'line-cap': 'round' },
    paint: {
      'line-color': ['case', ['==', ['get', 'selected'], 1], '#4DA3FF', '#8892A6'],
      'line-width': ['case', ['==', ['get', 'selected'], 1], 2, 1],
      'line-dasharray': [3, 2],
    },
  });

  layers.push({
    id: 'handle-point',
    type: 'circle',
    source: 'handles',
    paint: {
      'circle-radius': [
        'case',
        ['==', ['get', 'kind'], 'shape'],
        4,
        // A node with one road is a dead end, which you want to see and to grab.
        ['<=', ['get', 'degree'], 1],
        5,
        6,
      ],
      'circle-color': [
        'case',
        ['==', ['get', 'selected'], 1],
        '#4DA3FF',
        ['==', ['get', 'kind'], 'shape'],
        '#FFFFFF',
        '#1B1F27',
      ],
      'circle-stroke-width': 1.5,
      'circle-stroke-color': '#FFFFFF',
    },
  });

  // What the next click will attach to. Drawn last so it is never hidden by the design.
  layers.push({
    id: 'snap-ring',
    type: 'circle',
    source: 'snap',
    paint: {
      'circle-radius': 9,
      'circle-color': 'rgba(0,0,0,0)',
      'circle-stroke-width': 2.5,
      'circle-stroke-color': [
        'case',
        ['==', ['get', 'kind'], 'node'],
        '#F2C14E',
        '#3FB5AA',
      ],
    },
  });

  return layers;
}

export const SOURCE_IDS = ['areas', 'bands', 'stripes', 'stamps', 'plates', 'preview', 'guides', 'handles', 'snap'] as const;
export type SourceId = (typeof SOURCE_IDS)[number];
