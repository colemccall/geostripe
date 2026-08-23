import { describe, expect, it } from 'vitest';
import type { Polygon } from 'geojson';
import type { CrossSection, SectionComponent } from '../model/types';
import type { ComponentType } from '../library/primitives';
import { dedupe, localPlane, metresPerDegreeLat, metresPerDegreeLng, originFor } from './projection';
import type { LngLat } from './projection';
import { offsetPolyline, polylineLength } from './offset';
import { findOverruns } from './curvature';
import { bandsForStreet } from './banding';

/**
 * The gate for the geometry engine.
 *
 * The measurement helper below is a plain haversine written from scratch, deliberately
 * independent of projection.ts. If the tests measured with the same code they exercise,
 * a wrong scale factor would cancel out and every assertion would pass on broken geometry.
 */

const R = 6371008.8; // IUGG mean Earth radius, metres

function haversine([lng1, lat1]: LngLat, [lng2, lat2]: LngLat): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/**
 * A local metric frame whose scale comes only from haversine measurements, so nothing
 * here depends on projection.ts's ellipsoidal series. Heron's formula is deliberately
 * avoided: a band is a 3 m x 200 m sliver, and Heron loses most of its significant
 * digits on triangles that thin.
 */
function frameAt(origin: LngLat) {
  const d = 0.001;
  const mLat = haversine(origin, [origin[0], origin[1] + d]) / d;
  const mLng = haversine(origin, [origin[0] + d, origin[1]]) / d;
  return (p: LngLat) => ({ x: (p[0] - origin[0]) * mLng, y: (p[1] - origin[1]) * mLat });
}

/** Shoelace area in square metres, measured in a haversine-derived frame. */
function ringAreaM2(ring: readonly LngLat[], origin: LngLat): number {
  const f = frameAt(origin);
  const pts = ring.map(f);
  let sum = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    sum += pts[i]!.x * pts[i + 1]!.y - pts[i + 1]!.x * pts[i]!.y;
  }
  return Math.abs(sum / 2);
}

/**
 * Relative error, which is what these assertions actually care about. Spherical haversine
 * and the WGS84 ellipsoid disagree by roughly 0.2-0.3% at mid latitudes, so an absolute
 * millimetre tolerance would be measuring the difference between two Earth models rather
 * than testing our geometry. 0.5% still catches the @turf/lineOffset bug by a factor of 40.
 */
function relativeError(actual: number, expected: number): number {
  return Math.abs(actual - expected) / expected;
}

let n = 0;
const comp = (componentType: ComponentType, widthMeters: number): SectionComponent => ({
  id: `c${n++}`,
  componentType,
  widthMeters,
  direction: 'none',
});

function section(components: SectionComponent[]): CrossSection {
  return { id: 's', name: 't', components, anchorOffsetMeters: null };
}

/** A single 3.0 m lane, anchored so the band straddles the centerline. */
const oneLane = () => section([comp('travelLane', 3.0)]);

const CINCY: LngLat = [-84.5194, 39.1096];

/** Build a straight line of `lengthM` metres from `start` on the given compass bearing. */
function straightLine(start: LngLat, bearingDeg: number, lengthM: number): LngLat[] {
  const br = (bearingDeg * Math.PI) / 180;
  const mLat = metresPerDegreeLat(start[1]);
  const mLng = metresPerDegreeLng(start[1]);
  const dLat = (Math.cos(br) * lengthM) / mLat;
  const dLng = (Math.sin(br) * lengthM) / mLng;
  return [start, [start[0] + dLng, start[1] + dLat]];
}

/**
 * Width of a band drawn on a straight centerline: area divided by length.
 *
 * Robust to vertex order and winding, which matters because the boolean cleanup pass
 * normalises rings and may not preserve the order they were stitched in.
 */
function measureBandWidth(poly: Polygon, centerline: readonly LngLat[]): number {
  const ring = poly.coordinates[0]! as LngLat[];
  const origin = centerline[0]!;
  const length = haversine(centerline[0]!, centerline[centerline.length - 1]!);
  return ringAreaM2(ring, origin) / length;
}

describe('projection', () => {
  it('round-trips WGS84 -> plane -> WGS84', () => {
    const plane = localPlane(CINCY);
    for (const p of [CINCY, [-84.52, 39.11], [-84.5, 39.1]] as LngLat[]) {
      const back = plane.toLngLat(plane.toPlane(p));
      expect(back[0]).toBeCloseTo(p[0], 12);
      expect(back[1]).toBeCloseTo(p[1], 12);
    }
  });

  it('agrees with haversine on a known 100 m offset, both axes', () => {
    // Within 0.5%: the residual is the WGS84 ellipsoid vs the haversine sphere, not error.
    const plane = localPlane(CINCY);
    expect(relativeError(haversine(CINCY, plane.toLngLat({ x: 0, y: 100 })), 100)).toBeLessThan(0.005);
    expect(relativeError(haversine(CINCY, plane.toLngLat({ x: 100, y: 0 })), 100)).toBeLessThan(0.005);
  });

  it('knows a degree of longitude is shorter than a degree of latitude at 39N', () => {
    // The precise fact @turf/lineOffset ignores.
    expect(metresPerDegreeLng(39.1)).toBeLessThan(metresPerDegreeLat(39.1) * 0.79);
  });

  it('drops consecutive duplicate points', () => {
    expect(dedupe([[0, 0], [0, 0], [1, 1]])).toHaveLength(2);
  });

  it('centres the plane on the line', () => {
    expect(originFor([[-1, -1], [1, 1]])).toEqual([0, 0]);
  });
});

describe('band width is correct in every direction', () => {
  // The reason this module exists. @turf/lineOffset passes the east-west case and fails
  // north-south by cos(latitude) — 0.777x here, so a 3.0 m lane would measure 2.33 m.
  const cases: [string, number][] = [
    ['east-west', 90],
    ['north-south', 0],
    ['diagonal 45', 45],
    ['diagonal 135', 135],
    ['bearing 203', 203],
  ];

  for (const [name, bearing] of cases) {
    it(`${name}: a 3.0 m lane measures 3.0 m`, () => {
      const line = straightLine(CINCY, bearing, 200);
      const { bands } = bandsForStreet('s', line, oneLane());
      expect(bands).toHaveLength(1);
      const width = measureBandWidth(bands[0]!.geometry as Polygon, line);
      // @turf/lineOffset would give 2.33 m north-south here — 22% out, 44x this tolerance.
      expect(relativeError(width, 3.0)).toBeLessThan(0.005);
    });
  }

  it('gives the same width whichever way the street runs', () => {
    const widths = cases.map(([, bearing]) => {
      const line = straightLine(CINCY, bearing, 200);
      const { bands } = bandsForStreet('s', line, oneLane());
      return measureBandWidth(bands[0]!.geometry as Polygon, line);
    });
    const spread = Math.max(...widths) - Math.min(...widths);
    expect(spread / 3.0).toBeLessThan(0.005);
  });

  it('holds at high latitude, where the error would be largest', () => {
    // cos(69.6) ~ 0.35, so an uncorrected offset would be nearly a third of the width.
    const tromso: LngLat = [18.955, 69.649];
    const line = straightLine(tromso, 0, 200);
    const { bands } = bandsForStreet('s', line, oneLane());
    expect(relativeError(measureBandWidth(bands[0]!.geometry as Polygon, line), 3.0)).toBeLessThan(0.01);
  });
});

describe('multi-band sections', () => {
  const fourLane = () =>
    section([
      comp('sidewalk', 1.8),
      comp('travelLane', 3.0),
      comp('turnLane', 3.0),
      comp('travelLane', 3.0),
      comp('sidewalk', 1.8),
    ]);

  it('emits one band per component, in order', () => {
    const { bands } = bandsForStreet('s', straightLine(CINCY, 30, 300), fourLane());
    expect(bands).toHaveLength(5);
    bands.forEach((b, i) => expect(b.properties.componentIndex).toBe(i));
    expect(bands.map((b) => b.properties.componentType)).toEqual([
      'sidewalk',
      'travelLane',
      'turnLane',
      'travelLane',
      'sidewalk',
    ]);
  });

  it('each band measures its own width', () => {
    const line = straightLine(CINCY, 30, 300);
    const { bands } = bandsForStreet('s', line, fourLane());
    for (const band of bands) {
      const width = measureBandWidth(band.geometry as Polygon, line);
      expect(relativeError(width, band.properties.widthMeters)).toBeLessThan(0.005);
    }
  });

  it('neighbouring bands share their boundary exactly — no slivers, no overlap', () => {
    const { bands } = bandsForStreet('s', straightLine(CINCY, 30, 300), fourLane(), {
      skipCleanup: true,
    });
    for (let i = 0; i < bands.length - 1; i++) {
      const a = (bands[i]!.geometry as Polygon).coordinates[0]!;
      const b = (bands[i + 1]!.geometry as Polygon).coordinates[0]!;
      // Band i's outer edge is band i+1's inner edge, reversed.
      const aOuter = [a[2]!, a[3]!];
      const bInner = [b[0]!, b[1]!];
      expect(aOuter[0]![0]).toBeCloseTo(bInner[1]![0], 12);
      expect(aOuter[0]![1]).toBeCloseTo(bInner[1]![1], 12);
      expect(aOuter[1]![0]).toBeCloseTo(bInner[0]![0], 12);
      expect(aOuter[1]![1]).toBeCloseTo(bInner[0]![1], 12);
    }
  });

  it('total rendered width equals the sum of component widths', () => {
    const s = fourLane();
    const line = straightLine(CINCY, 77, 300);
    const { bands } = bandsForStreet('s', line, s);
    const total = bands.reduce(
      (sum, b) => sum + measureBandWidth(b.geometry as Polygon, line),
      0,
    );
    const expected = s.components.reduce((sum, c) => sum + c.widthMeters, 0);
    expect(relativeError(total, expected)).toBeLessThan(0.005);
  });

  it('moving the anchor translates the section without changing any width', () => {
    const line = straightLine(CINCY, 30, 300);
    const auto = bandsForStreet('s', line, fourLane());
    const pinned = bandsForStreet('s', line, { ...fourLane(), anchorOffsetMeters: 0 });
    auto.bands.forEach((b, i) => {
      const wa = measureBandWidth(b.geometry as Polygon, line);
      const wb = measureBandWidth(pinned.bands[i]!.geometry as Polygon, line);
      expect(relativeError(wa, wb)).toBeLessThan(0.001);
    });
  });
});

describe('offsetting', () => {
  it('offsets a straight line by exactly the requested distance', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ];
    const left = offsetPolyline(pts, 5);
    expect(left[0]!.y).toBeCloseTo(5, 9);
    expect(left[1]!.y).toBeCloseTo(5, 9);
    const right = offsetPolyline(pts, -5);
    expect(right[0]!.y).toBeCloseTo(-5, 9);
  });

  it('miters a corner so adjacent segments meet at one point', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
    ];
    const out = offsetPolyline(pts, 10);
    expect(out).toHaveLength(3); // mitered, not bevelled
    expect(out[1]!.x).toBeCloseTo(90, 6);
    expect(out[1]!.y).toBeCloseTo(10, 6);
  });

  it('bevels instead of letting a sharp corner spike to infinity', () => {
    // A near-reversal: an unlimited miter would shoot far away from the geometry.
    const pts = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 2, y: 1 },
    ];
    const out = offsetPolyline(pts, 10);
    expect(out.length).toBeGreaterThan(3); // bevel adds a point
    for (const p of out) expect(Math.hypot(p.x, p.y)).toBeLessThan(1000);
  });

  it('passes degenerate input through rather than throwing', () => {
    expect(offsetPolyline([], 5)).toEqual([]);
    expect(offsetPolyline([{ x: 1, y: 2 }], 5)).toEqual([{ x: 1, y: 2 }]);
  });

  it('measures polyline length', () => {
    expect(polylineLength([{ x: 0, y: 0 }, { x: 3, y: 4 }])).toBeCloseTo(5, 9);
  });
});

describe('curvature warnings', () => {
  it('stays quiet on a straight line', () => {
    expect(findOverruns([{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 200, y: 0 }], 10)).toEqual([]);
  });

  it('stays quiet on a gentle bend with room to run out', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 200, y: 0 },
      { x: 400, y: 20 },
    ];
    expect(findOverruns(pts, 5)).toEqual([]);
  });

  it('flags a hairpin that the offset cannot follow', () => {
    const pts = [
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 0, y: 4 },
    ];
    const warnings = findOverruns(pts, 12);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]!.vertexIndex).toBe(1);
    expect(warnings[0]!.requiredMeters).toBeGreaterThan(warnings[0]!.availableMeters);
  });

  it('still produces usable geometry through a hairpin, and warns', () => {
    // A 15 m switchback under a 12.6 m section: the outer boundary sits 6.3 m out and
    // needs ~27 m of run-out through a 153 degree turn, but only ~13 m is available.
    // The cleanup pass must still return a usable polygon — the warning is what tells
    // the user the shape is a repair rather than a faithful offset.
    const atMetres = (east: number, north: number): LngLat => [
      -84.5194 + east / 86492.6,
      39.1096 + north / 111017.5,
    ];
    const line: LngLat[] = [atMetres(0, 0), atMetres(15, 0), atMetres(3, 6)];
    const wide: CrossSection = section([
      comp('sidewalk', 1.8),
      comp('travelLane', 3.0),
      comp('turnLane', 3.0),
      comp('travelLane', 3.0),
      comp('sidewalk', 1.8),
    ]);

    const { bands, warnings } = bandsForStreet('s', line, wide);
    expect(bands).toHaveLength(5);
    for (const band of bands) {
      expect(band.geometry.coordinates.length).toBeGreaterThan(0);
    }
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]!.vertexIndex).toBe(1);
  });
});

describe('degenerate input', () => {
  it('returns nothing for a one-point centerline instead of throwing', () => {
    expect(bandsForStreet('s', [CINCY], oneLane()).bands).toEqual([]);
  });

  it('returns nothing for an empty section', () => {
    expect(bandsForStreet('s', straightLine(CINCY, 0, 100), section([])).bands).toEqual([]);
  });

  it('ignores repeated points in the centerline', () => {
    const line: LngLat[] = [CINCY, CINCY, [CINCY[0], CINCY[1] + 0.002]];
    expect(bandsForStreet('s', line, oneLane()).bands).toHaveLength(1);
  });
});
