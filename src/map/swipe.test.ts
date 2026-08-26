import { describe, expect, it } from 'vitest';
import { clipEastOf, clipLinesEastOf } from './designLayers';
import type { FeatureCollection } from 'geojson';

/**
 * The before/after divider, which is a clip and not a boolean.
 *
 * This ran on every frame of every pan through a polygon-boolean library, at 1.1 seconds
 * a frame on a real project. The replacement is Sutherland-Hodgman against one edge; these
 * tests exist so the correctness that bought is not quietly given back.
 */

function poly(ring: [number, number][]): FeatureCollection {
  return {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [ring] } },
    ],
  };
}

/** A unit square from x=0 to x=1. */
const SQUARE: [number, number][] = [
  [0, 0],
  [1, 0],
  [1, 1],
  [0, 1],
  [0, 0],
];

const ringOf = (fc: FeatureCollection) =>
  (fc.features[0]!.geometry as unknown as { coordinates: [number, number][][] }).coordinates[0]!;

describe('clipping polygons to one side of a meridian', () => {
  it('keeps a shape entirely on the visible side whole', () => {
    const out = clipEastOf(poly(SQUARE), -1);
    expect(out.features).toHaveLength(1);
    expect(ringOf(out)).toHaveLength(SQUARE.length);
  });

  it('drops a shape entirely on the hidden side', () => {
    expect(clipEastOf(poly(SQUARE), 5).features).toHaveLength(0);
  });

  it('cuts a straddling shape exactly at the line', () => {
    const out = clipEastOf(poly(SQUARE), 0.25);
    const ring = ringOf(out);
    expect(out.features).toHaveLength(1);
    // Nothing survives west of the divider, and the cut edge sits exactly on it.
    expect(Math.min(...ring.map((p) => p[0]))).toBeCloseTo(0.25, 12);
    expect(ring.filter((p) => Math.abs(p[0] - 0.25) < 1e-12).length).toBeGreaterThanOrEqual(2);
  });

  it('keeps the area it should — three quarters of a unit square', () => {
    const ring = ringOf(clipEastOf(poly(SQUARE), 0.25));
    let area = 0;
    for (let i = 0; i < ring.length - 1; i++) {
      area += ring[i]![0] * ring[i + 1]![1] - ring[i + 1]![0] * ring[i]![1];
    }
    expect(Math.abs(area / 2)).toBeCloseTo(0.75, 10);
  });

  it('returns a closed ring', () => {
    const ring = ringOf(clipEastOf(poly(SQUARE), 0.5));
    expect(ring[0]).toEqual(ring[ring.length - 1]);
  });

  it('drops a sliver too thin to be an area', () => {
    // Clipping exactly at the eastern edge leaves a degenerate line, not a polygon.
    expect(clipEastOf(poly(SQUARE), 1).features).toHaveLength(0);
  });

  it('keeps a hole that survives the cut', () => {
    const withHole: FeatureCollection = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {},
          geometry: {
            type: 'Polygon',
            coordinates: [
              [
                [0, 0],
                [10, 0],
                [10, 10],
                [0, 10],
                [0, 0],
              ],
              [
                [6, 6],
                [8, 6],
                [8, 8],
                [6, 8],
                [6, 6],
              ],
            ],
          },
        },
      ],
    };
    const out = clipEastOf(withHole, 2);
    const coords = (out.features[0]!.geometry as { coordinates: unknown[] }).coordinates;
    expect(coords).toHaveLength(2);
  });
});

describe('clipping lines', () => {
  it('cuts a crossing line at the divider', () => {
    const line: FeatureCollection = {
      type: 'FeatureCollection',
      features: [
        {
          type: 'Feature',
          properties: {},
          geometry: {
            type: 'LineString',
            coordinates: [
              [0, 0],
              [10, 0],
            ],
          },
        },
      ],
    };
    const out = clipLinesEastOf(line, 4);
    const coords = (out.features[0]!.geometry as unknown as { coordinates: [number, number][] }).coordinates;
    expect(coords[0]![0]).toBeCloseTo(4, 12);
  });
});
