/**
 * The one place coordinates are converted.
 *
 * Files store WGS84 longitude/latitude, because that is what GeoJSON is. The map draws Web
 * Mercator (EPSG:3857). Everything that measures, offsets, snaps or intersects happens in a
 * flat plane, and that plane is Web Mercator itself, so geometry and the renderer cannot
 * drift apart: they are the same plane.
 *
 * Web Mercator is conformal (angles are exact) but it is not metric. A "metre" in 3857 units
 * is stretched by k = 1 / cos(latitude), so a real distance of 3.6 m is 3.6 * k units. That
 * factor has to be applied everywhere a metre-valued quantity meets the plane, and it has to
 * be evaluated at the feature's own latitude, never baked once for a project. This module
 * does that in one way only:
 *
 *   `localPlane(origin)` is Web Mercator, translated to `origin` and divided by k at
 *   `origin`. Its units are real metres at the origin, its angles are exact, and it lies on
 *   top of the rendered map to within the variation of k across the feature (about 0.06%
 *   over 5 km north-south at 39N).
 *
 * Nothing else in the codebase may do latitude math or hold a degrees-to-metres constant.
 * `crs.guard.test.ts` fails the build if it does.
 */

export type LngLat = [number, number];

export interface PlanePoint {
  x: number;
  y: number;
}

const D2R = Math.PI / 180;

/** Web Mercator's sphere radius in metres (EPSG:3857). */
export const MERCATOR_RADIUS = 6378137;

/** Web Mercator's world width in metres. */
export const EQUATOR_METRES = 2 * Math.PI * MERCATOR_RADIUS;

/** Latitude past which Mercator is not defined; positions are clamped to it. */
const MAX_LAT = 85.05112878;

/** Longitude/latitude to Web Mercator metres. */
export function toMercator([lng, lat]: LngLat): PlanePoint {
  const phi = Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * D2R;
  return {
    x: MERCATOR_RADIUS * lng * D2R,
    y: MERCATOR_RADIUS * Math.log(Math.tan(Math.PI / 4 + phi / 2)),
  };
}

/** Web Mercator metres back to longitude/latitude. */
export function fromMercator({ x, y }: PlanePoint): LngLat {
  return [
    (x / MERCATOR_RADIUS) / D2R,
    (2 * Math.atan(Math.exp(y / MERCATOR_RADIUS)) - Math.PI / 2) / D2R,
  ];
}

/**
 * How much Web Mercator stretches a real distance at this latitude: k = 1 / cos(latitude).
 *
 * Multiply a real width by this to get the length it occupies on the rendered map.
 */
export function scaleAt(latDeg: number): number {
  const lat = Math.max(-MAX_LAT, Math.min(MAX_LAT, latDeg));
  return 1 / Math.cos(lat * D2R);
}

/**
 * The scale to draw a line at: k at its middle vertex.
 *
 * MapLibre takes one width per feature, so a feature gets one k. Over a street that is exact
 * to a small fraction of a percent; a road spanning degrees of latitude would need splitting.
 */
export function scaleForLine(line: readonly LngLat[]): number {
  if (line.length === 0) return 1;
  return scaleAt(line[Math.floor(line.length / 2)]![1]);
}

export interface LocalPlane {
  readonly origin: LngLat;
  /** Real metres at the origin; x east, y north. */
  toPlane(p: LngLat): PlanePoint;
  toLngLat(p: PlanePoint): LngLat;
}

/**
 * A plane in real metres, centred on `origin`, conformal and aligned with the rendered map.
 *
 * The scale is fixed at the origin's latitude so the mapping is affine and exactly
 * reversible; re-evaluating it per point would make a round trip lossy.
 */
export function localPlane(origin: LngLat): LocalPlane {
  const o = toMercator(origin);
  const k = scaleAt(origin[1]);

  return {
    origin,
    toPlane(p: LngLat): PlanePoint {
      const m = toMercator(p);
      return { x: (m.x - o.x) / k, y: (m.y - o.y) / k };
    },
    toLngLat({ x, y }: PlanePoint): LngLat {
      return fromMercator({ x: o.x + x * k, y: o.y + y * k });
    },
  };
}

/**
 * Origin for a line's plane: the midpoint of its bounding box.
 *
 * Centring the plane on the geometry keeps the variation of k across it symmetric and as
 * small as it can be.
 */
export function originFor(line: readonly LngLat[]): LngLat {
  if (line.length === 0) return [0, 0];
  let minLng = Infinity;
  let maxLng = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const [lng, lat] of line) {
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return [(minLng + maxLng) / 2, (minLat + maxLat) / 2];
}

/** Real ground distance between two positions, in metres. */
export function distanceMetres(a: LngLat, b: LngLat): number {
  const plane = localPlane(originFor([a, b]));
  const p = plane.toPlane(a);
  const q = plane.toPlane(b);
  return Math.hypot(q.x - p.x, q.y - p.y);
}

/** Drop consecutive duplicate points, which would otherwise give zero-length segments. */
export function dedupe(line: readonly LngLat[], epsilon = 1e-12): LngLat[] {
  const out: LngLat[] = [];
  for (const p of line) {
    const last = out[out.length - 1];
    if (!last || Math.abs(last[0] - p[0]) > epsilon || Math.abs(last[1] - p[1]) > epsilon) {
      out.push([p[0], p[1]]);
    }
  }
  return out;
}
