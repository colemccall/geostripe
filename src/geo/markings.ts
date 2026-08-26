import type { Feature } from 'geojson';
import { GLYPHS } from './glyphs';
import type { GlyphId, GlyphPolygon, Point } from './glyphs';
import { DEFAULT_LANE_GLYPHS, PRIMITIVES } from '../library/primitives';
import type { Direction } from '../library/primitives';
import type { CrossSection, SectionComponent } from '../model/types';
import { boundaryOffsets } from '../model/section';
import { dedupe, localPlane, originFor } from './projection';
import type { LngLat, LocalPlane, PlanePoint } from './projection';
import { offsetPolyline } from './offset';

/**
 * Road markings: the paint, as opposed to the pavement.
 *
 * Two independent things live here, and they are separate because they answer to
 * different geometry:
 *
 *   stripes   longitudinal lines ON the boundary between two components. They follow the
 *             same offset lines the bands were built from, so a stripe is never a hair
 *             away from the seam it is marking.
 *   stamps    symbols laid ALONG a component — arrows, bicycles, diamonds. Placed at a
 *             station, rotated into the direction that lane's traffic actually travels,
 *             and suppressed when the lane is too narrow to hold them.
 *
 * The direction bookkeeping is the part that is easy to get wrong. A component's
 * `direction` is relative to the order the centerline was drawn, so a 'backward' lane's
 * arrows point against the drawn line, and a junction leg running against the drawn line
 * inverts it again. Both inversions are done explicitly and named, rather than folded into
 * a sign somewhere.
 */

/** White thermoplastic. The same tone the crossings use, so paint reads as one material. */
export const PAINT_WHITE = '#F0EDE3';
/** Yellow, which in North America means "the other side of this line comes at you". */
export const PAINT_YELLOW = '#E8C45A';

/** Every stripe style, in the order a picker should offer them. */
export const STRIPE_STYLES = [
  'none',
  'laneDashed',
  'laneSolid',
  'edgeSolid',
  'bikeSolid',
  'bikeDashed',
  'centreDouble',
  'centreDashed',
] as const;

export type StripeStyle = (typeof STRIPE_STYLES)[number];

/** What each style means, for the picker. Conventions are North American. */
export const STRIPE_LABELS: Readonly<Record<StripeStyle, string>> = {
  none: 'No line',
  laneDashed: 'Dashed white — lane line',
  laneSolid: 'Solid white — do not cross',
  edgeSolid: 'Solid white — edge line',
  bikeSolid: 'Solid white — bike lane',
  bikeDashed: 'Dashed white — bike lane',
  centreDouble: 'Double yellow — opposing',
  centreDashed: 'Dashed yellow — passing allowed',
};

export interface StripeProperties {
  featureClass: 'marking';
  streetId: string;
  boundaryIndex: number;
  style: StripeStyle;
  /** Kept for the map's two-layer split, and because it is the fact the style encodes. */
  opposing: boolean;
  color: string;
  dashed: boolean;
  /** Screen width, carried on the feature so one layer can draw every style. */
  lineWidth: number;
}

/** Offset either side of the boundary for a double line, in metres. */
const DOUBLE_LINE_HALF_GAP = 0.12;

/**
 * What the line between two components should be.
 *
 * These are the North American conventions, and they are conventions rather than physics —
 * a user can override any boundary. Encoding them as defaults is still worth it: a design
 * whose striping has to be drawn by hand never gets striped, and unstriped asphalt reads
 * as a parking lot.
 */
export function stripeBetween(
  before: SectionComponent,
  after: SectionComponent,
): { style: StripeStyle; opposing: boolean } {
  const a = PRIMITIVES[before.componentType];
  const b = PRIMITIVES[after.componentType];

  // A kerb is not a stripe. Nothing is painted where the roadway ends.
  if (!a.isRoadway || !b.isRoadway) return { style: 'none', opposing: false };

  const opposing = directionsOppose(before.direction, after.direction);
  if (opposing) return { style: 'centreDouble', opposing: true };

  if (a.category === 'parking' || b.category === 'parking') {
    return { style: 'edgeSolid', opposing: false };
  }
  if (a.category === 'bike' || b.category === 'bike') {
    return { style: 'bikeSolid', opposing: false };
  }
  if (a.category === 'transit' || b.category === 'transit') {
    return { style: 'laneSolid', opposing: false };
  }
  return { style: 'laneDashed', opposing: false };
}

function directionsOppose(before: Direction, after: Direction): boolean {
  if (before === 'none' || after === 'none') return false;
  if (before === 'both' || after === 'both') return before !== after;
  return before !== after;
}

const DASHED: ReadonlySet<StripeStyle> = new Set<StripeStyle>([
  'laneDashed',
  'bikeDashed',
  'centreDashed',
]);

function stripeColor(style: StripeStyle): string {
  return style === 'centreDouble' || style === 'centreDashed' ? PAINT_YELLOW : PAINT_WHITE;
}

/**
 * Drawn width, in screen pixels.
 *
 * `line-dasharray` is not data-driven in MapLibre, so styles are split across exactly two
 * layers — solid and dashed — and everything else about a stripe travels on the feature.
 * A line that must not be crossed is drawn heavier than one that may be.
 */
function stripeWidth(style: StripeStyle): number {
  switch (style) {
    case 'centreDouble':
    case 'centreDashed':
      return 1.0;
    case 'laneSolid':
    case 'edgeSolid':
    case 'bikeSolid':
      return 1.3;
    default:
      return 1.1;
  }
}

/**
 * Longitudinal stripes for a street.
 *
 * A double line is two features, offset a hand's width either side of the boundary, rather
 * than one thick line — at the zoom this tool is used at that gap is visible, and it is the
 * difference between "double yellow" and "a wide yellow line", which mean different things.
 */
export function stripesForStreet(
  streetId: string,
  centerline: readonly LngLat[],
  section: CrossSection,
): Feature[] {
  const line = dedupe(centerline);
  if (line.length < 2 || section.components.length < 2) return [];

  const plane = localPlane(originFor(line));
  const planePts = line.map((p) => plane.toPlane(p));
  const offsets = boundaryOffsets(section);
  const out: Feature[] = [];

  for (let i = 1; i < section.components.length; i++) {
    const before = section.components[i - 1]!;
    const after = section.components[i]!;
    const boundary = offsets[i];
    if (boundary === undefined) continue;

    const resolved = stripeBetween(before, after);
    // The override lives on the component to the RIGHT of the boundary, named for the
    // edge it sits on, so one boundary can never carry two conflicting overrides.
    const style = after.stripeLeft ?? resolved.style;
    if (style === 'none') continue;

    const shifts = style === 'centreDouble' ? [-DOUBLE_LINE_HALF_GAP, DOUBLE_LINE_HALF_GAP] : [0];

    shifts.forEach((shift, which) => {
      const coords = offsetPolyline(planePts, -(boundary + shift)).map(
        (p) => plane.toLngLat(p) as [number, number],
      );
      const properties: StripeProperties = {
        featureClass: 'marking',
        streetId,
        boundaryIndex: i,
        style,
        opposing: resolved.opposing,
        color: stripeColor(style),
        dashed: DASHED.has(style),
        lineWidth: stripeWidth(style),
      };
      out.push({
        type: 'Feature',
        id: `${streetId}:mark:${i}:${which}`,
        properties,
        geometry: { type: 'LineString', coordinates: coords },
      });
    });
  }

  return out;
}

// ------------------------------------------------------------------------ stamp maths

/**
 * Place one glyph.
 *
 * `at` is where the glyph's centre lands; `travel` is the unit direction its +x axis
 * points, which is the direction the traffic using that lane moves — NOT the direction the
 * centerline was drawn in.
 */
export function stampGlyph(
  polygons: readonly GlyphPolygon[],
  at: PlanePoint,
  travel: PlanePoint,
  plane: LocalPlane,
): LngLat[][][] {
  const left: PlanePoint = { x: -travel.y, y: travel.x };
  const place = ([x, y]: Point): LngLat =>
    plane.toLngLat({
      x: at.x + travel.x * x + left.x * y,
      y: at.y + travel.y * x + left.y * y,
    });
  return polygons.map((polygon) => polygon.map((ring) => ring.map(place)));
}

/** Cumulative distance along a planar polyline. */
function stationsOf(pts: readonly PlanePoint[]): number[] {
  const stations = [0];
  for (let i = 1; i < pts.length; i++) {
    stations.push(stations[i - 1]! + Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y));
  }
  return stations;
}

/** Position and unit tangent at a station along a planar polyline. */
function sampleAt(
  pts: readonly PlanePoint[],
  stations: readonly number[],
  station: number,
): { point: PlanePoint; tangent: PlanePoint } {
  let i = 0;
  while (i < stations.length - 2 && stations[i + 1]! < station) i++;
  const a = pts[i]!;
  const b = pts[i + 1] ?? a;
  const span = (stations[i + 1] ?? stations[i]!) - stations[i]!;
  const t = span > 1e-9 ? (station - stations[i]!) / span : 0;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  return {
    point: { x: a.x + dx * t, y: a.y + dy * t },
    tangent: { x: dx / len, y: dy / len },
  };
}

// --------------------------------------------------------------------- lane stamps

export interface LaneStamp {
  componentIndex: number;
  glyph: GlyphId;
  /** Rings in WGS84, ready to become a MultiPolygon. */
  polygons: LngLat[][][];
  color: string;
}

/** What a component is stamped with when nobody has said otherwise. */
export function defaultGlyphFor(component: SectionComponent): { glyph: GlyphId; spacingMeters: number } | null {
  if (component.glyph === 'none') return null;
  const preset = DEFAULT_LANE_GLYPHS[component.componentType];
  const glyph = component.glyph ?? preset?.glyph;
  if (!glyph) return null;
  return {
    glyph,
    spacingMeters: component.glyphSpacingMeters ?? preset?.spacingMeters ?? 30,
  };
}

function glyphColorFor(glyph: GlyphId, componentType: SectionComponent['componentType']): string {
  // A two-way left-turn lane is marked in yellow, because both directions use it. Every
  // other lane-use arrow is white.
  return componentType === 'turnLane' ? PAINT_YELLOW : glyph === 'sharkTeeth' ? PAINT_WHITE : PAINT_WHITE;
}

/**
 * Repeating symbols along each component of a street.
 *
 * Spacing is even with equal margins rather than "one every 30 m from the start", so a
 * short block gets a centred symbol instead of one crammed against the junction. A lane
 * narrower than the symbol gets nothing — a bicycle spilling over the stripe would look
 * like a drawing error rather than the honest statement that the lane is too narrow, and
 * the fit check is where that belongs.
 */
export function laneStampsForStreet(
  streetId: string,
  centerline: readonly LngLat[],
  section: CrossSection,
): Feature[] {
  const line = dedupe(centerline);
  if (line.length < 2) return [];

  const plane = localPlane(originFor(line));
  const planePts = line.map((p) => plane.toPlane(p));
  const offsets = boundaryOffsets(section);
  const out: Feature[] = [];

  section.components.forEach((component, index) => {
    const chosen = defaultGlyphFor(component);
    if (!chosen) return;

    const spec = GLYPHS[chosen.glyph];
    if (spec.widthMeters > component.widthMeters - 0.15) return;

    const near = offsets[index];
    const far = offsets[index + 1];
    if (near === undefined || far === undefined) return;

    const lanePts = offsetPolyline(planePts, -(near + far) / 2);
    if (lanePts.length < 2) return;

    const stations = stationsOf(lanePts);
    const length = stations[stations.length - 1]!;
    if (length < spec.lengthMeters * 1.5) return;

    const count = Math.max(1, Math.floor(length / chosen.spacingMeters));
    const pitch = length / count;
    const polygons = spec.build(component.widthMeters);
    const color = glyphColorFor(chosen.glyph, component.componentType);

    for (let k = 0; k < count; k++) {
      const { point, tangent } = sampleAt(lanePts, stations, pitch * (k + 0.5));

      // 'backward' points against the drawn line. 'both' is a two-way left-turn lane:
      // alternate stamps so the arrows face each way, which is how one is really marked.
      const flip =
        component.direction === 'backward' || (component.direction === 'both' && k % 2 === 1);
      const travel = flip ? { x: -tangent.x, y: -tangent.y } : tangent;

      out.push({
        type: 'Feature',
        id: `${streetId}:stamp:${index}:${k}`,
        properties: {
          featureClass: 'stamp',
          streetId,
          componentIndex: index,
          glyph: chosen.glyph,
          color,
        },
        geometry: { type: 'MultiPolygon', coordinates: stampGlyph(polygons, point, travel, plane) },
      });
    }
  });

  return out;
}

// ------------------------------------------------------------------ approach stamps

/** The movements a lane is allowed to make through a junction. */
export const MOVEMENTS = ['left', 'through', 'right', 'uTurn'] as const;
export type Movement = (typeof MOVEMENTS)[number];

/**
 * The arrow that says exactly this set of movements.
 *
 * Returns null for the empty set — an unassigned lane is not the same as a lane assigned
 * nothing, and stamping a bare shaft would claim otherwise.
 */
export function arrowForMovements(movements: readonly Movement[]): GlyphId | null {
  const has = (m: Movement) => movements.includes(m);
  const left = has('left');
  const through = has('through');
  const right = has('right');
  const uTurn = has('uTurn');

  if (uTurn && left) return 'arrowUTurnLeft';
  if (uTurn) return 'arrowUTurn';
  if (left && through && right) return 'arrowAll';
  if (left && through) return 'arrowThroughLeft';
  if (right && through) return 'arrowThroughRight';
  if (left && right) return 'arrowLeftRight';
  if (left) return 'arrowLeft';
  if (right) return 'arrowRight';
  if (through) return 'arrowThrough';
  return null;
}

/**
 * Does traffic in this component travel TOWARD the junction along this leg?
 *
 * A leg's `sense` is +1 when it heads toward increasing station along the street. Traffic
 * approaching the junction along such a leg is therefore travelling toward *decreasing*
 * station — which is 'backward'. Getting this inverted puts every arrow on the departure
 * side, where it would be both wrong and hard to notice.
 */
export function approachesJunction(direction: Direction, sense: 1 | -1): boolean {
  if (direction === 'none') return false;
  if (direction === 'both') return true;
  return direction === (sense === 1 ? 'backward' : 'forward');
}

export interface ApproachStampInput {
  plane: LocalPlane;
  /** Junction centre, in the plane. */
  origin: PlanePoint;
  /** Outward bearing of the leg, radians. */
  bearing: number;
  sense: 1 | -1;
  /** Where the cross-section resumes; arrows sit behind it. */
  stopOffsetMeters: number;
  /** How much street is left along this leg. Arrows that do not fit are dropped. */
  legLengthMeters: number;
  section: CrossSection;
  /** Movements per component index. Missing or empty means no arrow. */
  lanes: readonly (readonly Movement[] | null | undefined)[];
}

export interface ApproachStamp {
  componentIndex: number;
  glyph: GlyphId;
  polygons: LngLat[][][];
}

/** Gap between the stop line and the back of the nearest arrow. */
const ARROW_GAP_METRES = 2.0;

/**
 * Lane-use arrows on the approach to a junction.
 *
 * Placed from the stop line backwards, which is where a driver reads them, and only on
 * lanes that actually approach. The section's own left/right is mirrored into the leg's
 * outward frame here — that single sign is the difference between arrows on the correct
 * lanes and arrows on the oncoming ones.
 */
export function approachStamps(input: ApproachStampInput): ApproachStamp[] {
  const { plane, origin, bearing, sense, stopOffsetMeters, legLengthMeters, section, lanes } = input;
  const d: PlanePoint = { x: Math.cos(bearing), y: Math.sin(bearing) };
  const n: PlanePoint = { x: -d.y, y: d.x };
  const travel: PlanePoint = { x: -d.x, y: -d.y };
  const offsets = boundaryOffsets(section);
  const out: ApproachStamp[] = [];

  section.components.forEach((component, index) => {
    const movements = lanes[index];
    if (!movements || movements.length === 0) return;
    if (!PRIMITIVES[component.componentType].isRoadway) return;
    if (!approachesJunction(component.direction, sense)) return;

    const glyph = arrowForMovements(movements);
    if (!glyph) return;

    const spec = GLYPHS[glyph];
    if (spec.widthMeters > component.widthMeters - 0.15) return;

    const along = stopOffsetMeters + ARROW_GAP_METRES + spec.lengthMeters / 2;
    if (along + spec.lengthMeters / 2 > legLengthMeters) return;

    const near = offsets[index];
    const far = offsets[index + 1];
    if (near === undefined || far === undefined) return;

    // Section offsets run left-negative to right-positive along the DRAWN line. A leg with
    // sense -1 faces the other way, so its outward frame sees them mirrored.
    const across = -sense * ((near + far) / 2);
    const at: PlanePoint = {
      x: origin.x + d.x * along + n.x * across,
      y: origin.y + d.y * along + n.y * across,
    };

    out.push({
      componentIndex: index,
      glyph,
      polygons: stampGlyph(spec.build(component.widthMeters), at, travel, plane),
    });
  });

  return out;
}

/**
 * The conventional lane assignment for an approach, offered as a starting point.
 *
 * Leftmost approach lane turns left, kerbside lane turns right and goes through, and
 * everything between goes through. It is a convention, not a derivation — which is why it
 * is a button the user presses rather than a default that appears unasked.
 */
export function conventionalAssignment(
  section: CrossSection,
  sense: 1 | -1,
  options: { hasThroughMovement?: boolean } = {},
): (Movement[] | null)[] {
  const through = options.hasThroughMovement ?? true;
  const lanes: (Movement[] | null)[] = section.components.map(() => null);

  const indices: number[] = [];
  section.components.forEach((component, index) => {
    if (!PRIMITIVES[component.componentType].isRoadway) return;
    if (PRIMITIVES[component.componentType].category === 'parking') return;
    if (!approachesJunction(component.direction, sense)) return;
    indices.push(index);
  });
  if (indices.length === 0) return lanes;

  // Ordered as the driver sees them: their left first. Section order is left-to-right
  // along the drawn line, so a leg running against it reads them in reverse.
  const driverOrder = sense === 1 ? [...indices].reverse() : indices;

  driverOrder.forEach((index, position) => {
    const component = section.components[index]!;
    const type = component.componentType;
    if (type === 'turnPocket' || type === 'turnLane') {
      lanes[index] = position === 0 ? ['left'] : ['right'];
      return;
    }
    if (driverOrder.length === 1) {
      lanes[index] = through ? ['left', 'through', 'right'] : ['left', 'right'];
      return;
    }
    if (position === 0) lanes[index] = through ? ['left', 'through'] : ['left'];
    else if (position === driverOrder.length - 1) {
      lanes[index] = through ? ['through', 'right'] : ['right'];
    } else lanes[index] = through ? ['through'] : ['left', 'right'];
  });

  return lanes;
}
