import { describe, expect, it } from 'vitest';
import {
  EQUATOR_METRES,
  MERCATOR_RADIUS,
  distanceMetres,
  fromMercator,
  localPlane,
  scaleAt,
  toMercator,
} from './crs';
import type { LngLat } from './crs';

const toRad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance on the sphere Web Mercator itself assumes. Independent of crs.ts. */
function haversine(a: LngLat, b: LngLat, radius = MERCATOR_RADIUS): number {
  const dLat = toRad(b[1] - a[1]);
  const dLng = toRad(b[0] - a[0]);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[1])) * Math.cos(toRad(b[1])) * Math.sin(dLng / 2) ** 2;
  return 2 * radius * Math.asin(Math.sqrt(h));
}

/** Ground metres per degree on the WGS84 ellipsoid, from its own radii of curvature. */
function ellipsoidMetresPerDegree(latDeg: number): { lat: number; lng: number } {
  const a = 6378137;
  const e2 = 0.00669437999014;
  const phi = toRad(latDeg);
  const w = Math.sqrt(1 - e2 * Math.sin(phi) ** 2);
  const prime = a / w;
  const meridian = (a * (1 - e2)) / w ** 3;
  return { lat: (meridian * Math.PI) / 180, lng: (prime * Math.cos(phi) * Math.PI) / 180 };
}

const LATITUDES = [20, 39.1, 47.6, 60];

describe('web mercator conversions', () => {
  it('round-trips lng/lat -> mercator -> lng/lat to well under a millimetre', () => {
    for (const lat of [-60, 0, 20, 39.1096, 61.2181]) {
      for (const lng of [-150, -84.5194, 0, 12.3]) {
        const back = fromMercator(toMercator([lng, lat]));
        // 1 mm on the ground is about 9e-9 degrees.
        expect(Math.abs(back[0] - lng)).toBeLessThan(1e-9);
        expect(Math.abs(back[1] - lat)).toBeLessThan(1e-9);
      }
    }
  });

  it('matches the circumference MapLibre assumes', () => {
    expect(EQUATOR_METRES).toBeCloseTo(40075016.686, 2);
  });
});

describe('the local plane', () => {
  it('round-trips plane -> lng/lat -> plane to a millimetre', () => {
    for (const lat of LATITUDES) {
      const plane = localPlane([-100, lat]);
      for (const [x, y] of [[0, 0], [1234.5, -987.6], [-5000, 5000]] as [number, number][]) {
        const back = plane.toPlane(plane.toLngLat({ x, y }));
        expect(Math.abs(back.x - x)).toBeLessThan(1e-3);
        expect(Math.abs(back.y - y)).toBeLessThan(1e-3);
      }
    }
  });

  it('measures a 3.6 m lane as 3.6 m at 20N, 39N, 47N and 60N', () => {
    for (const lat of LATITUDES) {
      const plane = localPlane([-100, lat]);
      for (const bearing of [0, 45, 90, 137]) {
        const b = toRad(bearing);
        const end = plane.toLngLat({ x: Math.sin(b) * 3.6, y: Math.cos(b) * 3.6 });
        // Exact against the sphere that 3857 defines.
        expect(Math.abs(haversine([-100, lat], end) - 3.6)).toBeLessThan(3.6 * 1e-4);
      }
    }
  });

  it('stays within 0.7% of the WGS84 ellipsoid in both axes', () => {
    // 3857 is a sphere, the ground is an ellipsoid; the two differ by a small, bounded,
    // direction-dependent amount (about 0.3% north-south at 39N, 0.55% at 60N). This pins it.
    for (const lat of LATITUDES) {
      const plane = localPlane([-100, lat]);
      const north = plane.toLngLat({ x: 0, y: 100 });
      const east = plane.toLngLat({ x: 100, y: 0 });
      const e = ellipsoidMetresPerDegree(lat);
      const trueNorth = (north[1] - lat) * e.lat;
      const trueEast = (east[0] + 100) * e.lng;
      expect(Math.abs(trueNorth - 100) / 100).toBeLessThan(0.007);
      expect(Math.abs(trueEast - 100) / 100).toBeLessThan(0.007);
    }
  });

  it('stays accurate across a 5 km north-south project', () => {
    for (const lat of LATITUDES) {
      const a: LngLat = [-100, lat];
      const b: LngLat = [-100, lat + 5000 / 111000];
      // Planar distance through a plane centred at the midpoint vs the sphere itself.
      const reference = haversine(a, b);
      expect(Math.abs(distanceMetres(a, b) - reference) / reference).toBeLessThan(2e-3);
    }
  });

  it('is conformal: a right angle stays a right angle', () => {
    const plane = localPlane([-84.5, 39.1]);
    const o = plane.toLngLat({ x: 0, y: 0 });
    const e = plane.toLngLat({ x: 50, y: 0 });
    const n = plane.toLngLat({ x: 0, y: 50 });
    const p = (q: LngLat) => plane.toPlane(q);
    const ex = p(e).x - p(o).x;
    const ey = p(e).y - p(o).y;
    const nx = p(n).x - p(o).x;
    const ny = p(n).y - p(o).y;
    expect(Math.abs(ex * nx + ey * ny)).toBeLessThan(1e-6);
  });

  it('agrees with the renderer: ground metres times k is the length on the mercator map', () => {
    for (const lat of LATITUDES) {
      const plane = localPlane([-100, lat]);
      const p = toMercator(plane.toLngLat({ x: 0, y: 0 }));
      const q = toMercator(plane.toLngLat({ x: 100, y: 0 }));
      expect(Math.abs((q.x - p.x) / (100 * scaleAt(lat)) - 1)).toBeLessThan(1e-9);
    }
  });
});

describe('moving a project to a distant city', () => {
  it('needs no reload: each plane carries its own scale', () => {
    const cincinnati = localPlane([-84.52, 39.11]);
    const anchorage = localPlane([-149.9, 61.22]);
    const lane = (plane: ReturnType<typeof localPlane>, at: LngLat) =>
      haversine(at, plane.toLngLat({ x: 3.6, y: 0 }));
    expect(lane(cincinnati, [-84.52, 39.11])).toBeCloseTo(3.6, 3);
    expect(lane(anchorage, [-149.9, 61.22])).toBeCloseTo(3.6, 3);
  });
});
