/**
 * Local metric tangent plane.
 *
 * Every piece of geometry in GeoStripe happens here, in metres, and never in degrees.
 * That is not a stylistic preference — it is the difference between a lane that measures
 * 3.0 m and one that measures 2.33 m.
 *
 * `@turf/lineOffset`, the obvious library choice, converts a metric distance to degrees
 * once and then does planar arithmetic directly on longitude/latitude with no correction:
 *
 *     const offsetDegrees = lengthToDegrees(distance, units);
 *     out1x = point1[0] + (offset * (point2[1] - point1[1])) / L;
 *
 * A degree of longitude is only cos(latitude) as long as a degree of latitude, so a
 * north-south street comes out narrow by that factor — 0.777x at Cincinnati. East-west
 * streets are correct, which is worse than being uniformly wrong: nothing looks broken
 * until you compare two streets. Segment length `L` also mixes degrees of latitude and
 * longitude as if they were the same unit, so on a diagonal the offset is not even
 * perpendicular to its own centerline.
 *
 * Projecting to a local plane first makes all of that go away, and turns the rest of the
 * problem into ordinary 2D geometry that can be unit-tested with known answers.
 *
 * Accuracy: the series below are the standard WGS84 expansions for the length of a degree
 * as a function of latitude. Over the few hundred metres of a street they are good to well
 * under a centimetre — far tighter than the imagery we trace against.
 */

export type LngLat = [number, number];

export interface PlanePoint {
  x: number;
  y: number;
}

const D2R = Math.PI / 180;

/** Metres per degree of latitude at a given latitude. */
export function metresPerDegreeLat(latDeg: number): number {
  const f = latDeg * D2R;
  return 111132.92 - 559.82 * Math.cos(2 * f) + 1.175 * Math.cos(4 * f) - 0.0023 * Math.cos(6 * f);
}

/** Metres per degree of longitude at a given latitude. */
export function metresPerDegreeLng(latDeg: number): number {
  const f = latDeg * D2R;
  return 111412.84 * Math.cos(f) - 93.5 * Math.cos(3 * f) + 0.118 * Math.cos(5 * f);
}

export interface LocalPlane {
  readonly origin: LngLat;
  toPlane(p: LngLat): PlanePoint;
  toLngLat(p: PlanePoint): LngLat;
}

/**
 * Build a tangent plane centred on `origin`. Scale factors are evaluated once, at the
 * origin's latitude, which is what makes the mapping affine and therefore exactly
 * reversible. Re-evaluating per point would make round-tripping lossy.
 */
export function localPlane(origin: LngLat): LocalPlane {
  const [lng0, lat0] = origin;
  const mPerLat = metresPerDegreeLat(lat0);
  const mPerLng = metresPerDegreeLng(lat0);

  return {
    origin,
    toPlane([lng, lat]: LngLat): PlanePoint {
      return { x: (lng - lng0) * mPerLng, y: (lat - lat0) * mPerLat };
    },
    toLngLat({ x, y }: PlanePoint): LngLat {
      return [lng0 + x / mPerLng, lat0 + y / mPerLat];
    },
  };
}

/**
 * Origin for a line's plane: the midpoint of its bounding box.
 *
 * Centring the plane on the geometry keeps every point close to the origin, where the
 * tangent-plane approximation is tightest, and keeps the error symmetric rather than
 * accumulating toward one end.
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
