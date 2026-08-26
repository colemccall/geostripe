import * as polyclip from 'polyclip-ts';
import type { Feature, MultiPolygon, Polygon } from 'geojson';
import { bandsForStreet, markingsForStreet } from './banding';
import type { BandFeature } from './banding';
import { detectJunctions } from './junctions';
import { pruneResolvedCache, resolveCenterline } from './curve';
import type { CurveSettings } from './curve';
import type { Junction } from './junctions';
import { DEFAULT_CORNER_RADIUS_METRES, junctionGeometry } from './intersection';
import type {
  CornerTreatment,
  CrosswalkSpec,
  JunctionGeometry,
  LegInput,
  CornerInput,
} from './intersection';
import type { CurvatureWarning } from './curvature';
import type { LocalPlane } from './projection';
import { PRIMITIVES } from '../library/primitives';
import type { CrossSection, Street } from '../model/types';

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
  markings: Feature[];
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

/** Persisted per-leg customisation. */
export interface LegOverride {
  crosswalk?: CrosswalkSpec | null;
  stopBar?: boolean;
  stopOffsetMeters?: number | null;
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
}

export interface DeriveOptions {
  overrides?: Readonly<Record<string, JunctionOverride>>;
  defaultCornerRadiusMeters?: number;
  /** Off by default so the feature can be turned off wholesale if it misbehaves. */
  trimAtJunctions?: boolean;
}

// ------------------------------------------------------------------------ raw bands

interface RawEntry {
  centerline: Street['centerline'];
  curve: CurveSettings | undefined;
  section: CrossSection;
  bands: BandFeature[];
  markings: Feature[];
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
    markings: markingsForStreet(street.id, line, street.section),
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
function signatureOf(junction: Junction, override: JunctionOverride | undefined, radius: number): string {
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
    JSON.stringify(override ?? null),
  ].join('#');
}

function geometryFor(
  junction: Junction,
  plane: LocalPlane,
  override: JunctionOverride | undefined,
  defaultRadius: number,
): GeometryEntry {
  const signature = signatureOf(junction, override, defaultRadius);
  const hit = geometryCache.get(junction.key);
  if (hit && hit.signature === signature) return hit;

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
  } = options;

  const visible = streets.filter((s) => s.visible);
  const { junctions, plane } = detectJunctions(streets);

  const entries = trimAtJunctions
    ? junctions.map((junction) =>
        geometryFor(junction, plane, overrides?.[junction.key], defaultCornerRadiusMeters),
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

    const result: StreetGeometry = { bands, markings, warnings: raw.warnings };
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

  const crossings: Feature[] = [];
  for (const entry of geometry) {
    entry.crossings.forEach((part, index) => {
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

  return {
    byStreet,
    junctions,
    junctionGeometry: geometry,
    crossings,
    plane,
    warnings,
    junctionWarnings: [...new Set(geometry.flatMap((g) => g.warnings))],
  };
}

/** Drop every cache. Exists for tests; the pruning above handles normal operation. */
export function resetDerivedCaches(): void {
  pruneResolvedCache(new Set());
  rawCache.clear();
  trimCache.clear();
  geometryCache.clear();
}
