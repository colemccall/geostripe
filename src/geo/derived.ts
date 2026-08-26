import * as polyclip from 'polyclip-ts';
import type { Feature, MultiPolygon, Polygon } from 'geojson';
import { bandsForStreet } from './banding';
import {
  approachStamps,
  arrowForMovements,
  laneStampsForStreet,
  stampGlyph,
  stripesForStreet,
} from './markings';
import type { Movement } from './markings';
import { GLYPHS } from './glyphs';
import type { GlyphId } from './glyphs';
import type { BandFeature } from './banding';
import { detectJunctions } from './junctions';
import { pruneResolvedCache, resolveCenterline } from './curve';
import type { CurveSettings } from './curve';
import type { Junction } from './junctions';
import { DEFAULT_CORNER_RADIUS_METRES, junctionGeometry } from './intersection';
import { classifyJunction, mergeGeometry } from './merge';
import type { JunctionForm } from './merge';
import type {
  CornerTreatment,
  CrosswalkSpec,
  JunctionGeometry,
  LegInput,
  CornerInput,
} from './intersection';
import type { CurvatureWarning } from './curvature';
import type { LngLat, LocalPlane, PlanePoint } from './projection';
import { PRIMITIVES } from '../library/primitives';
import type { ComponentType } from '../library/primitives';
import type { CrossSection, JunctionNode, Street } from '../model/types';

/**
 * The derivation pipeline, memoised.
 *
 * Everything drawn on the map is computed from the centerlines and cross-sections on every
 * change, which is what keeps a design parametric. That was affordable when a street was
 * an offset and a fill. It stops being affordable the moment intersections arrive: each
 * band now also needs a boolean subtraction per junction, and a vertex drag fires sixty
 * times a second.
 *
 * So each stage caches on the identity of its inputs. The store updates immutably, so a
 * drag of one street leaves every other street's arrays reference-identical and their
 * geometry is reused untouched — the only work per frame is the street actually moving.
 *
 * Caches are keyed by street id and pruned to the live set on every pass, so deleting a
 * street cannot leak its geometry.
 */

export interface StreetGeometry {
  bands: Feature[];
  /** Longitudinal stripes: lane lines, centre lines, edge lines. */
  markings: Feature[];
  /** Repeating pavement symbols along the street — bicycles, diamonds, sharrows. */
  stamps: Feature[];
  warnings: CurvatureWarning[];
}

/** Paint. Crossings and stop bars are marked, not paved, so they read as one material. */
const PAINT_COLOR = '#F0EDE3';
/** A raised table is a change in surface, not in paint. */
const TABLE_COLOR = '#6E6355';

export interface DerivedProject {
  byStreet: Map<string, StreetGeometry>;
  junctions: Junction[];
  junctionGeometry: JunctionGeometry[];
  /** Crosswalk stripes, edge lines, raised tables and stop bars, ready to draw. */
  crossings: Feature[];
  /** How each junction was read, aligned with `junctions`. */
  junctionForms: JunctionForm[];
  /** Lane-use arrows on junction approaches, and the turn pockets they belong to. */
  approachStamps: Feature[];
  /** Extra approach lanes added at a junction, drawn as bands. */
  flares: Feature[];
  /**
   * Junctions close enough that their geometry interacts — a staggered pair of T's, or a
   * crossing right beside a slip road. Reported rather than silently merged.
   */
  offsetPairs: OffsetPair[];
  plane: LocalPlane;
  warnings: { streetId: string; streetName: string; warnings: CurvatureWarning[] }[];
  junctionWarnings: string[];
}

/** Persisted per-corner customisation. A null entry means "leave this one alone". */
export interface CornerOverride {
  radiusMeters?: number | null;
  treatment?: CornerTreatment;
  bulbOutMeters?: number;
  daylightMeters?: number;
}

/**
 * An extra lane added at one approach only — a turn pocket, in the general case.
 *
 * `side` is the *approaching driver's*, not the leg's. A leg points away from the
 * junction, so its outward left is the approaching driver's right; stating the side in
 * driver terms is the only way a "right-turn pocket" means what it says. The conversion
 * happens in exactly one place, where the geometry is built.
 */
export interface ApproachFlare {
  side: 'left' | 'right';
  componentType: ComponentType;
  widthMeters: number;
  /** Full-width storage, measured back from the stop line. */
  storageMeters: number;
  taperMeters: number;
  /** Movements the added lane serves. Drives its arrow. */
  movements?: Movement[];
}

/** Persisted per-leg customisation. */
export interface LegOverride {
  crosswalk?: CrosswalkSpec | null;
  stopBar?: boolean;
  stopOffsetMeters?: number | null;
  /**
   * Movements permitted from each lane of the approach, indexed by component index.
   *
   * Sparse and explicit: an unassigned lane gets no arrow, because guessing what a lane is
   * for and then painting the guess on the road is exactly the kind of confident fiction
   * this tool exists to avoid. `conventionalAssignment` fills it in on request.
   */
  lanes?: (Movement[] | null)[];
  flare?: ApproachFlare | null;
}

/** Two junctions whose footprints reach each other. */
export interface OffsetPair {
  keys: [string, string];
  /** Centre to centre. For a staggered T-junction this is the stagger. */
  separationMeters: number;
  /** How much they overlap: positive means the two boxes genuinely intersect. */
  overlapMeters: number;
  sharedStreetIds: string[];
}

/**
 * Persisted per-junction customisation, keyed by the junction's stable key.
 *
 * Sparse by design: junctions themselves are derived, so the only thing worth storing is
 * what somebody deliberately changed. Both arrays are indexed to match the junction's
 * legs, and corner `i` is the corner counter-clockwise from leg `i`.
 */
export interface JunctionOverride {
  corners?: (CornerOverride | null)[];
  legs?: (LegOverride | null)[];
  /**
   * Force how this junction is read.
   *
   * Absent means "decide from the geometry", which is right nearly always: a road joining
   * another at twenty degrees is a merge and nobody drew a twenty-degree crossroads. The
   * override is for the ambiguous band around thirty degrees, where whether traffic yields
   * or merges is a fact about the place that the shape cannot show.
   */
  form?: JunctionForm;
  /** A yield line across the joining road. Only meaningful on a merge. */
  yieldLine?: boolean;
}

export interface DeriveOptions {
  overrides?: Readonly<Record<string, JunctionOverride>>;
  defaultCornerRadiusMeters?: number;
  /** Off by default so the feature can be turned off wholesale if it misbehaves. */
  trimAtJunctions?: boolean;
  /**
   * Below this angle a road joining another is drawn as a merge rather than a junction.
   *
   * Exposed because the honest threshold depends on what is being drawn: a motorway
   * interchange merges at five degrees, a suburban slip road at thirty, and a service road
   * that meets its arterial at forty is arguable either way.
   */
  mergeBelowDegrees?: number;
  /**
   * Slack on the radius at which nearby crossings are treated as one junction.
   *
   * The automatic radius comes from the streets themselves, which is right almost always.
   * This is the knob for the two cases it cannot know about: a plaza where three streets
   * meet across twenty metres and is one junction, and a pair of T's ten metres apart that
   * are two. Negative pushes them apart, positive pulls them together.
   */
  junctionMergeSlackMeters?: number;
  /** Intersections somebody placed. Authoritative wherever they sit. */
  nodes?: readonly JunctionNode[];
  /**
   * 'nodes' means an intersection exists only where one was placed. The default 'auto'
   * still finds crossings, so a design works before anyone has thought about junctions.
   */
  junctionMode?: 'auto' | 'nodes';
}

// ------------------------------------------------------------------------ raw bands

interface RawEntry {
  centerline: Street['centerline'];
  curve: CurveSettings | undefined;
  section: CrossSection;
  bands: BandFeature[];
  markings: Feature[];
  stamps: Feature[];
  warnings: CurvatureWarning[];
}

const rawCache = new Map<string, RawEntry>();

function rawFor(street: Street): RawEntry {
  const hit = rawCache.get(street.id);
  // Reference equality, not deep comparison: the store never mutates in place, so a
  // matching reference is a guarantee of matching content and costs nothing to check.
  if (
    hit &&
    hit.centerline === street.centerline &&
    hit.curve === street.curve &&
    hit.section === street.section
  ) {
    return hit;
  }

  const line = resolveCenterline(street);
  const result = bandsForStreet(street.id, line, street.section);
  const entry: RawEntry = {
    centerline: street.centerline,
    curve: street.curve,
    section: street.section,
    bands: result.bands,
    markings: stripesForStreet(street.id, line, street.section),
    stamps: laneStampsForStreet(street.id, line, street.section),
    warnings: result.warnings,
  };
  rawCache.set(street.id, entry);
  return entry;
}

// ------------------------------------------------------------------ junction geometry

interface GeometryEntry {
  signature: string;
  geometry: JunctionGeometry;
}

const geometryCache = new Map<string, GeometryEntry>();

/** Everything the geometry depends on, rounded to a tenth of a millimetre. */
function signatureOf(
  junction: Junction,
  override: JunctionOverride | undefined,
  radius: number,
  form: JunctionForm,
): string {
  const legs = junction.legs
    .map((l) =>
      [
        l.streetId,
        l.bearing.toFixed(6),
        l.lengthMeters.toFixed(4),
        l.halfLeft.toFixed(4),
        l.halfRight.toFixed(4),
        l.travelwayHalfLeft.toFixed(4),
        l.travelwayHalfRight.toFixed(4),
      ].join(','),
    )
    .join('|');
  return [
    junction.position[0].toFixed(9),
    junction.position[1].toFixed(9),
    legs,
    radius,
    form,
    JSON.stringify(override ?? null),
  ].join('#');
}

function geometryFor(
  junction: Junction,
  plane: LocalPlane,
  override: JunctionOverride | undefined,
  defaultRadius: number,
  form: JunctionForm,
): GeometryEntry {
  const signature = signatureOf(junction, override, defaultRadius, form);
  const hit = geometryCache.get(junction.key);
  if (hit && hit.signature === signature) return hit;

  if (form === 'merge') {
    const merged = mergeGeometry(junction, plane, { yieldLine: override?.yieldLine });
    // Null means the parts do not make a merge after all — a junction is the safe answer,
    // and a silently empty one would just make the streets overlap.
    if (merged) {
      const entry: GeometryEntry = { signature, geometry: merged };
      geometryCache.set(junction.key, entry);
      return entry;
    }
  }

  const geometry = junctionGeometry(junction, plane, {
    defaultRadiusMeters: defaultRadius,
    corners: override?.corners?.map<CornerInput>((corner) => ({
      ...(corner?.radiusMeters !== null && corner?.radiusMeters !== undefined
        ? { radiusMeters: corner.radiusMeters }
        : {}),
      ...(corner?.treatment ? { treatment: corner.treatment } : {}),
      ...(corner?.bulbOutMeters !== undefined ? { bulbOutMeters: corner.bulbOutMeters } : {}),
      ...(corner?.daylightMeters !== undefined ? { daylightMeters: corner.daylightMeters } : {}),
    })),
    legs: override?.legs?.map<LegInput>((leg) => ({
      crosswalk: leg?.crosswalk ?? null,
      ...(leg?.stopBar !== undefined ? { stopBar: leg.stopBar } : {}),
      ...(leg?.stopOffsetMeters !== undefined
        ? { stopOffsetMeters: leg.stopOffsetMeters }
        : {}),
    })),
  });
  const entry: GeometryEntry = { signature, geometry };
  geometryCache.set(junction.key, entry);
  return entry;
}

// ---------------------------------------------------------------------- subtraction

type Ring = [number, number][];

/**
 * Cut the junction footprints out of a band.
 *
 * Returns null when the band is entirely inside a junction, which is what happens to a
 * very short street between two close crossings — it is genuinely all intersection, and
 * emitting a zero-area polygon would only produce a rendering artefact.
 */
function subtractRings(feature: Feature, holes: readonly Ring[]): Feature | null {
  const geometry = feature.geometry;
  if (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon') return feature;
  if (holes.length === 0) return feature;

  try {
    const subject =
      geometry.type === 'Polygon'
        ? (geometry.coordinates as Ring[])
        : (geometry.coordinates as Ring[][]);

    const result = polyclip.difference(
      subject as never,
      ...(holes.map((ring) => [ring]) as never[]),
    );
    if (result.length === 0) return null;

    return {
      ...feature,
      geometry:
        result.length === 1
          ? ({ type: 'Polygon', coordinates: result[0]! } as Polygon)
          : ({ type: 'MultiPolygon', coordinates: result } as MultiPolygon),
    };
  } catch {
    // A degenerate ring should cost one band's trim, not the whole design.
    return feature;
  }
}

/** Keep only the part of a band that falls inside the given ring. */
function intersectRings(feature: Feature, ring: Ring): Feature | null {
  const geometry = feature.geometry;
  if (geometry.type !== 'Polygon' && geometry.type !== 'MultiPolygon') return null;

  try {
    const subject =
      geometry.type === 'Polygon'
        ? (geometry.coordinates as Ring[])
        : (geometry.coordinates as Ring[][]);

    const result = polyclip.intersection(subject as never, [ring] as never);
    if (result.length === 0) return null;

    return {
      ...feature,
      geometry:
        result.length === 1
          ? ({ type: 'Polygon', coordinates: result[0]! } as Polygon)
          : ({ type: 'MultiPolygon', coordinates: result } as MultiPolygon),
    };
  } catch {
    return null;
  }
}

/** Parking is the one component daylighting removes; everything else stays put. */
function isParking(type: string): boolean {
  return type === 'parkingLaneParallel' || type === 'parkingLaneAngled';
}

/**
 * Trim a line to the parts outside every junction.
 *
 * Split at the crossings, not at the vertices. A lane marking on a straight street is two
 * points a hundred metres apart, both well outside the intersection — testing only the
 * vertices keeps the whole line and paints the centre stripe straight through the junction
 * box, which is the one place it must not appear.
 */
function clipLineOutside(feature: Feature, holes: readonly Ring[]): Feature[] {
  if (feature.geometry.type !== 'LineString' || holes.length === 0) return [feature];
  const coords = feature.geometry.coordinates as [number, number][];

  const runs: [number, number][][] = [];
  let current: [number, number][] = [];

  const flush = () => {
    if (current.length >= 2) runs.push(current);
    current = [];
  };

  for (let i = 0; i < coords.length - 1; i++) {
    const a = coords[i]!;
    const b = coords[i + 1]!;

    // Every parameter at which this segment enters or leaves a hole, plus the endpoints.
    const cuts = new Set<number>([0, 1]);
    for (const ring of holes) {
      for (let j = 0; j < ring.length - 1; j++) {
        const t = segmentParameter(a, b, ring[j]!, ring[j + 1]!);
        if (t !== null) cuts.add(t);
      }
    }

    const sorted = [...cuts].sort((p, q) => p - q);
    for (let k = 0; k < sorted.length - 1; k++) {
      const t0 = sorted[k]!;
      const t1 = sorted[k + 1]!;
      if (t1 - t0 < 1e-12) continue;

      const mid = lerp(a, b, (t0 + t1) / 2);
      if (holes.some((ring) => pointInRing(mid, ring))) {
        flush();
        continue;
      }

      const start = lerp(a, b, t0);
      const end = lerp(a, b, t1);
      if (current.length === 0) current.push(start);
      current.push(end);
    }
  }

  flush();

  return runs.map((run) => ({
    ...feature,
    geometry: { type: 'LineString' as const, coordinates: run },
  }));
}

function lerp(a: [number, number], b: [number, number], t: number): [number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/** Parameter along a-b at which it crosses c-d, or null if they do not properly cross. */
function segmentParameter(
  a: [number, number],
  b: [number, number],
  c: [number, number],
  d: [number, number],
): number | null {
  const rx = b[0] - a[0];
  const ry = b[1] - a[1];
  const sx = d[0] - c[0];
  const sy = d[1] - c[1];

  const denom = rx * sy - ry * sx;
  if (Math.abs(denom) < 1e-15) return null;

  const t = ((c[0] - a[0]) * sy - (c[1] - a[1]) * sx) / denom;
  const u = ((c[0] - a[0]) * ry - (c[1] - a[1]) * rx) / denom;
  if (t <= 0 || t >= 1 || u < 0 || u > 1) return null;
  return t;
}

/** Even-odd ray cast. Rings here are small and convex-ish, so this is plenty. */
function pointInRing(point: [number, number], ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i]!;
    const [xj, yj] = ring[j]!;
    if (yi > point[1] !== yj > point[1]) {
      const x = ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi;
      if (point[0] < x) inside = !inside;
    }
  }
  return inside;
}


// ----------------------------------------------------------------------- approach flares

/**
 * Widen a leg by its approach flare, before any junction geometry is built.
 *
 * A turn pocket is not decoration bolted onto the side of a finished junction: it makes
 * the approach wider, which moves the kerb, which moves the corner return, which lengthens
 * the crossing. Applying it here means every one of those follows for free — including the
 * crossing distance the inspector reports, so adding a right-turn pocket visibly costs the
 * pedestrian the metres it really costs them.
 *
 * A leg points AWAY from the junction, so the approaching driver's right is the leg's
 * outward left. That inversion happens here and nowhere else.
 */
function withFlares(junction: Junction, override: JunctionOverride | undefined): Junction {
  const legs = override?.legs;
  if (!legs || !legs.some((leg) => leg?.flare && leg.flare.widthMeters > 0)) return junction;

  return {
    ...junction,
    legs: junction.legs.map((leg, i) => {
      const flare = legs[i]?.flare;
      if (!flare || flare.widthMeters <= 0) return leg;
      const onLeft = flare.side === 'right';
      const width = flare.widthMeters;
      return {
        ...leg,
        halfLeft: leg.halfLeft + (onLeft ? width : 0),
        halfRight: leg.halfRight + (onLeft ? 0 : width),
        travelwayHalfLeft: leg.travelwayHalfLeft + (onLeft ? width : 0),
        travelwayHalfRight: leg.travelwayHalfRight + (onLeft ? 0 : width),
      };
    }),
  };
}

/** Gap between the stop line and the back of an approach arrow. */
const FLARE_ARROW_GAP_METRES = 2.0;

/**
 * The pocket itself: full width from the stop line back through the storage length, then
 * a taper closing onto the running edge of the street.
 *
 * `baseHalf` is the leg's half-width BEFORE the flare, which is where the street's own
 * bands stop. The pocket fills exactly the gap between that and the widened junction box,
 * so the two meet with no sliver and no overlap.
 */
function flareGeometry(
  plane: LocalPlane,
  origin: PlanePoint,
  bearing: number,
  baseHalf: number,
  onLeft: boolean,
  stopOffsetMeters: number,
  flare: ApproachFlare,
): { ring: LngLat[]; arrow: LngLat[][][] | null; glyph: GlyphId | null } {
  const d: PlanePoint = { x: Math.cos(bearing), y: Math.sin(bearing) };
  const n: PlanePoint = onLeft ? { x: -d.y, y: d.x } : { x: d.y, y: -d.x };
  const at = (along: number, across: number): PlanePoint => ({
    x: origin.x + d.x * along + n.x * across,
    y: origin.y + d.y * along + n.y * across,
  });

  const width = flare.widthMeters;
  const storage = Math.max(0, flare.storageMeters);
  const taper = Math.max(0.5, flare.taperMeters);
  const stop = stopOffsetMeters;

  const ring = [
    at(stop, baseHalf),
    at(stop, baseHalf + width),
    at(stop + storage, baseHalf + width),
    at(stop + storage + taper, baseHalf),
    at(stop, baseHalf),
  ].map((p) => plane.toLngLat(p));

  const glyph = flare.movements?.length ? arrowForMovements(flare.movements) : null;
  if (!glyph) return { ring, arrow: null, glyph: null };

  const spec = GLYPHS[glyph];
  if (spec.widthMeters > width - 0.15 || spec.lengthMeters + FLARE_ARROW_GAP_METRES > storage) {
    return { ring, arrow: null, glyph: null };
  }

  const centre = at(stop + FLARE_ARROW_GAP_METRES + spec.lengthMeters / 2, baseHalf + width / 2);
  return {
    ring,
    arrow: stampGlyph(spec.build(width), centre, { x: -d.x, y: -d.y }, plane),
    glyph,
  };
}

// ------------------------------------------------------------------- offset junctions

/** How far a junction reaches from its own centre. */
function junctionReach(entry: JunctionGeometry, plane: LocalPlane): number {
  const centre = plane.toPlane(entry.centre);
  let reach = 0;
  for (const point of entry.footprint) {
    const p = plane.toPlane(point);
    reach = Math.max(reach, Math.hypot(p.x - centre.x, p.y - centre.y));
  }
  return reach;
}

/**
 * Junctions whose geometry reaches into each other.
 *
 * The case this exists for is the staggered intersection — two T-junctions ten or twenty
 * metres apart on the same through street, which is a single place to a driver and two
 * junctions to the detector. Merging them would be wrong: their side streets meet the
 * through street at genuinely different points, and one shared centre would draw both legs
 * from somewhere neither of them is. So they stay separate, and this reports the fact,
 * suppresses the markings that would land inside the neighbour, and leaves the call to the
 * person looking at it.
 *
 * A shared street is required. Two unrelated junctions that happen to be close are just
 * close, and there is nothing to say about them.
 */
function findOffsetPairs(
  geometry: readonly JunctionGeometry[],
  junctions: readonly Junction[],
  plane: LocalPlane,
): OffsetPair[] {
  const reaches = geometry.map((entry) => junctionReach(entry, plane));
  const centres = geometry.map((entry) => plane.toPlane(entry.centre));
  const pairs: OffsetPair[] = [];

  for (let i = 0; i < geometry.length; i++) {
    for (let j = i + 1; j < geometry.length; j++) {
      const shared = junctions[i]!.streetIds.filter((id) => junctions[j]!.streetIds.includes(id));
      if (shared.length === 0) continue;

      const separation = Math.hypot(centres[i]!.x - centres[j]!.x, centres[i]!.y - centres[j]!.y);
      const overlap = reaches[i]! + reaches[j]! - separation;
      if (overlap <= 0) continue;

      pairs.push({
        keys: [geometry[i]!.key, geometry[j]!.key],
        separationMeters: separation,
        overlapMeters: overlap,
        sharedStreetIds: shared,
      });
    }
  }

  return pairs;
}

/** Centroid of a ring, for the "is this marking inside the neighbouring junction" test. */
function ringCentroid(ring: readonly (readonly number[])[]): [number, number] {
  let x = 0;
  let y = 0;
  for (const point of ring) {
    x += point[0]!;
    y += point[1]!;
  }
  return [x / ring.length, y / ring.length];
}

interface TrimEntry {
  bands: BandFeature[];
  trimKey: string;
  result: StreetGeometry;
}

const trimCache = new Map<string, TrimEntry>();

// --------------------------------------------------------------------------- public

export function deriveProject(
  streets: readonly Street[],
  options: DeriveOptions = {},
): DerivedProject {
  const {
    overrides,
    defaultCornerRadiusMeters = DEFAULT_CORNER_RADIUS_METRES,
    trimAtJunctions = true,
    junctionMergeSlackMeters = 0,
    mergeBelowDegrees = 40,
    nodes,
    junctionMode = 'auto',
  } = options;

  const visible = streets.filter((s) => s.visible);
  const byId = new Map(streets.map((street) => [street.id, street]));
  const { junctions, plane } = detectJunctions(streets, {
    mergeSlackMeters: junctionMergeSlackMeters,
    nodes,
    mode: junctionMode,
  });

  // Flares widen the legs, so they have to be applied before the geometry is built rather
  // than drawn over it afterwards. The cache signature already covers leg half-widths, so
  // a pocket appearing or changing width invalidates exactly the junction it belongs to.
  const flared = trimAtJunctions
    ? junctions.map((junction) => withFlares(junction, overrides?.[junction.key]))
    : junctions;

  // Form is decided on the FLARED legs, not the raw ones: adding a turn pocket changes
  // the widths a merge is measured against, and reading the form from geometry the user
  // can no longer see would be its own kind of lie.
  const forms = flared.map<JunctionForm>(
    (junction) =>
      overrides?.[junction.key]?.form ?? classifyJunction(junction, mergeBelowDegrees),
  );

  const entries = trimAtJunctions
    ? flared.map((junction, index) =>
        geometryFor(
          junction,
          plane,
          overrides?.[junction.key],
          defaultCornerRadiusMeters,
          forms[index]!,
        ),
      )
    : [];
  const geometry = entries.map((entry) => entry.geometry);

  // Two hole sets, and the split is the point: asphalt runs through the junction and is
  // cut only at the kerb-to-kerb box, while footway and verge stop at the wider footprint
  // so the corner sidewalk drawn underneath shows through and turns the corner.
  const pavedHoles: Ring[] = [];
  const roadwayHoles: Ring[] = [];
  const footprintHoles: Ring[] = [];
  const daylightHoles: Ring[] = [];
  for (const entry of geometry) {
    if (entry.paved.length > 3) pavedHoles.push(entry.paved as Ring);
    if (entry.roadwayCut.length > 3) roadwayHoles.push(entry.roadwayCut as Ring);
    if (entry.footprint.length > 3) footprintHoles.push(entry.footprint as Ring);
    for (const zone of entry.daylightZones) {
      if (zone.ring.length > 3) daylightHoles.push(zone.ring as Ring);
    }
  }

  // The signature already encodes leg geometry, corner overrides and the default radius,
  // so reusing it here is exact. Deriving the key from ring lengths instead would miss a
  // radius change that happened to leave the vertex count the same.
  const trimKey = entries.map((entry) => entry.signature).join('||');

  const byStreet = new Map<string, StreetGeometry>();
  const warnings: DerivedProject['warnings'] = [];

  for (const street of visible) {
    const raw = rawFor(street);
    if (raw.warnings.length > 0) {
      warnings.push({ streetId: street.id, streetName: street.name, warnings: raw.warnings });
    }

    const cached = trimCache.get(street.id);
    if (cached && cached.bands === raw.bands && cached.trimKey === trimKey) {
      byStreet.set(street.id, cached.result);
      continue;
    }

    const bands: Feature[] = [];
    for (const band of raw.bands) {
      const type = band.properties.componentType;
      const roadway = PRIMITIVES[type].isRoadway;

      // Roadway is cut against the UN-bulbed box, not the paved fill. The difference
      // between those two rings is exactly the ground a curb extension reclaims: no lane
      // band is drawn there, and the footway ring underneath shows through instead.
      const trimmed = subtractRings(band, roadway ? roadwayHoles : footprintHoles);
      if (!trimmed) continue;
      // Carried onto the feature so the map can draw a tunnel translucent and an overpass
      // with a deck edge, without needing to know which street a band came from.
      trimmed.properties = { ...trimmed.properties, level: street.level ?? 0 };

      if (!roadway || !isParking(type) || daylightHoles.length === 0) {
        bands.push(trimmed);
        continue;
      }

      // Daylighting removes the parking, not the pavement. The cleared stretch is still
      // roadway, so it is recoloured rather than cut out — a hole here would show footway
      // through the middle of the carriageway.
      for (const zone of daylightHoles) {
        const cleared = intersectRings(trimmed, zone);
        if (!cleared) continue;
        bands.push({
          ...cleared,
          properties: {
            ...cleared.properties,
            color: PRIMITIVES.travelLane.color,
            daylighted: true,
          },
        });
      }

      const kept = subtractRings(trimmed, daylightHoles);
      if (kept) bands.push(kept);
    }

    // Lane markings belong to the street, not the intersection; inside the box the
    // junction draws its own.
    const markings: Feature[] = [];
    for (const marking of raw.markings) markings.push(...clipLineOutside(marking, pavedHoles));

    // A symbol is either on the road or it is not — clipping one in half would read as a
    // rendering fault rather than as a junction. Drop any whose centre lands in the box.
    const stamps = raw.stamps.filter((stamp) => {
      if (stamp.geometry.type !== 'MultiPolygon') return true;
      const first = stamp.geometry.coordinates[0]?.[0];
      if (!first) return false;
      const centre = ringCentroid(first);
      return !pavedHoles.some((hole) => pointInRing(centre, hole));
    });

    const result: StreetGeometry = { bands, markings, stamps, warnings: raw.warnings };
    trimCache.set(street.id, { bands: raw.bands, trimKey, result });
    byStreet.set(street.id, result);
  }

  // Prune, so a deleted street cannot hold its geometry alive.
  const live = new Set(streets.map((s) => s.id));
  pruneResolvedCache(live);
  for (const id of [...rawCache.keys()]) if (!live.has(id)) rawCache.delete(id);
  for (const id of [...trimCache.keys()]) if (!live.has(id)) trimCache.delete(id);
  const liveJunctions = new Set(junctions.map((j) => j.key));
  for (const key of [...geometryCache.keys()]) {
    if (!liveJunctions.has(key)) geometryCache.delete(key);
  }

  const offsetPairs = trimAtJunctions ? findOffsetPairs(geometry, flared, plane) : [];

  // Which other junctions each one has to keep out of. Only offset neighbours, because
  // that is the only case where one junction's paint can land inside another's box.
  const neighbours = new Map<string, Ring[]>();
  for (const pair of offsetPairs) {
    for (const [self, other] of [
      [pair.keys[0], pair.keys[1]],
      [pair.keys[1], pair.keys[0]],
    ]) {
      const ring = geometry.find((entry) => entry.key === other)?.paved;
      if (!ring || ring.length <= 3) continue;
      const list = neighbours.get(self!);
      if (list) list.push(ring as Ring);
      else neighbours.set(self!, [ring as Ring]);
    }
  }

  const crossings: Feature[] = [];
  for (const entry of geometry) {
    const forbidden = neighbours.get(entry.key) ?? [];
    entry.crossings.forEach((part, index) => {
      // A crosswalk or stop bar that falls inside the junction next door is not a crossing,
      // it is paint in the middle of an intersection. Suppressed rather than drawn.
      if (forbidden.length > 0) {
        const centre = ringCentroid(part.ring);
        if (forbidden.some((ring) => pointInRing(centre, ring))) return;
      }
      crossings.push({
        type: 'Feature',
        id: `${entry.key}:x${index}`,
        properties: {
          junctionKey: entry.key,
          legIndex: part.legIndex,
          kind: part.kind,
          color: part.kind === 'table' ? TABLE_COLOR : PAINT_COLOR,
        },
        geometry: { type: 'Polygon', coordinates: [part.ring] },
      });
    });
  }

  // ---- approach lanes: the arrows on each lane, and the pockets some of them sit in.
  const approach: Feature[] = [];
  const flares: Feature[] = [];

  geometry.forEach((entry, index) => {
    const junction = junctions[index]!;
    const override = overrides?.[entry.key];
    const origin = plane.toPlane(entry.centre);

    entry.legs.forEach((legGeometry, legIndex) => {
      const leg = junction.legs[legIndex];
      const street = byId.get(legGeometry.streetId);
      if (!leg || !street) return;
      const legOverride = override?.legs?.[legIndex];

      const lanes = legOverride?.lanes;
      if (lanes && lanes.length > 0) {
        for (const stamp of approachStamps({
          plane,
          origin,
          bearing: leg.bearing,
          sense: leg.sense,
          stopOffsetMeters: legGeometry.stopOffsetMeters,
          legLengthMeters: leg.lengthMeters,
          section: street.section,
          lanes,
        })) {
          approach.push({
            type: 'Feature',
            id: `${entry.key}:arrow${legIndex}:${stamp.componentIndex}`,
            properties: {
              junctionKey: entry.key,
              legIndex,
              glyph: stamp.glyph,
              color: PAINT_COLOR,
            },
            geometry: { type: 'MultiPolygon', coordinates: stamp.polygons },
          });
        }
      }

      const flare = legOverride?.flare;
      if (!flare || flare.widthMeters <= 0) return;

      const onLeft = flare.side === 'right';
      const built = flareGeometry(
        plane,
        origin,
        leg.bearing,
        onLeft ? leg.travelwayHalfLeft : leg.travelwayHalfRight,
        onLeft,
        legGeometry.stopOffsetMeters,
        flare,
      );

      flares.push({
        type: 'Feature',
        id: `${entry.key}:flare${legIndex}`,
        properties: {
          featureClass: 'band',
          junctionKey: entry.key,
          legIndex,
          streetId: legGeometry.streetId,
          componentType: flare.componentType,
          color: PRIMITIVES[flare.componentType].color,
          level: street.level ?? 0,
        },
        geometry: { type: 'Polygon', coordinates: [built.ring] },
      });

      if (built.arrow && built.glyph) {
        approach.push({
          type: 'Feature',
          id: `${entry.key}:flarearrow${legIndex}`,
          properties: {
            junctionKey: entry.key,
            legIndex,
            glyph: built.glyph,
            color: PAINT_COLOR,
          },
          geometry: { type: 'MultiPolygon', coordinates: built.arrow },
        });
      }
    });
  });

  const offsetWarnings = offsetPairs.map(
    (pair) =>
      `Two junctions sit ${pair.separationMeters.toFixed(0)} m apart on ${
        pair.sharedStreetIds.length === 1 ? 'a shared street' : 'shared streets'
      } and their footprints overlap by ${pair.overlapMeters.toFixed(
        0,
      )} m. That is a staggered intersection: it is drawn as two, and the crossings that would land inside the other one are suppressed.`,
  );

  return {
    byStreet,
    junctions: flared,
    junctionGeometry: geometry,
    junctionForms: trimAtJunctions ? forms : flared.map(() => 'intersection' as JunctionForm),
    crossings,
    approachStamps: approach,
    flares,
    offsetPairs,
    plane,
    warnings,
    junctionWarnings: [...new Set([...geometry.flatMap((g) => g.warnings), ...offsetWarnings])],
  };
}

/** Drop every cache. Exists for tests; the pruning above handles normal operation. */
export function resetDerivedCaches(): void {
  pruneResolvedCache(new Set());
  rawCache.clear();
  trimCache.clear();
  geometryCache.clear();
}
