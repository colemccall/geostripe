import { describe, expect, it } from 'vitest';
import { area, capsule, circle, contains, difference, intersection, normalize, toPolygons, union } from './region';
import type { Region, Ring } from './region';

const square = (x: number, y: number, size: number): Ring => [
  { x, y },
  { x: x + size, y },
  { x: x + size, y: y + size },
  { x, y: y + size },
];

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

describe('area', () => {
  it('measures squares and holes', () => {
    expect(area([square(0, 0, 10)])).toBeCloseTo(100, 6);
    expect(area([square(0, 0, 10), square(2, 2, 4)])).toBeCloseTo(84, 6);
  });
});

describe('union', () => {
  it('merges overlapping squares', () => {
    const r = union([square(0, 0, 10)], [square(5, 5, 10)]);
    expect(area(r)).toBeCloseTo(175, 5);
    expect(r).toHaveLength(1);
  });

  it('merges squares that share only a wall into one rectangle', () => {
    const r = union([square(0, 0, 10)], [square(10, 0, 10)]);
    expect(area(r)).toBeCloseTo(200, 5);
    expect(r).toHaveLength(1);
    expect(r[0]!.length).toBe(4);
  });

  it('keeps two separate squares separate', () => {
    const r = union([square(0, 0, 10)], [square(50, 50, 10)]);
    expect(r).toHaveLength(2);
    expect(area(r)).toBeCloseTo(200, 5);
  });

  it('absorbs a square entirely inside another', () => {
    const r = union([square(0, 0, 10)], [square(2, 2, 3)]);
    expect(area(r)).toBeCloseTo(100, 5);
    expect(r).toHaveLength(1);
  });

  it('closes a ring around a hole when the mouth of a C is capped', () => {
    const c: Region = [
      [
        { x: 0, y: 0 },
        { x: 30, y: 0 },
        { x: 30, y: 10 },
        { x: 10, y: 10 },
        { x: 10, y: 20 },
        { x: 30, y: 20 },
        { x: 30, y: 30 },
        { x: 0, y: 30 },
      ],
    ];
    const r = union(c, [square(25, 8, 14)]);
    expect(toPolygons(r).some((poly) => poly.length === 2)).toBe(true);
  });

  it('is the identity with an empty region', () => {
    expect(area(union([], [square(0, 0, 4)]))).toBeCloseTo(16, 6);
    expect(area(union([square(0, 0, 4)], []))).toBeCloseTo(16, 6);
  });
});

describe('difference', () => {
  it('cuts a notch from a corner', () => {
    const r = difference([square(0, 0, 10)], [square(5, 5, 10)]);
    expect(area(r)).toBeCloseTo(75, 5);
    expect(r).toHaveLength(1);
  });

  it('cuts a hole from the middle', () => {
    const r = difference([square(0, 0, 10)], [square(3, 3, 4)]);
    expect(area(r)).toBeCloseTo(84, 5);
    expect(toPolygons(r)).toHaveLength(1);
    expect(toPolygons(r)[0]).toHaveLength(2);
  });

  it('splits a bar in two when the middle is removed', () => {
    const r = difference(
      [square(0, 0, 30)],
      [[{ x: 10, y: -5 }, { x: 20, y: -5 }, { x: 20, y: 35 }, { x: 10, y: 35 }]],
    );
    expect(toPolygons(r)).toHaveLength(2);
    expect(area(r)).toBeCloseTo(600, 4);
  });

  it('removes a shared wall without leaving a sliver', () => {
    const r = difference([square(0, 0, 10)], [square(5, 0, 5)]);
    expect(area(r)).toBeCloseTo(75, 5);
    expect(r).toHaveLength(1);
  });

  it('erases everything when the eraser covers it', () => {
    expect(difference([square(2, 2, 3)], [square(0, 0, 10)])).toEqual([]);
  });
});

describe('intersection', () => {
  it('is the overlap', () => {
    expect(area(intersection([square(0, 0, 10)], [square(5, 5, 10)]))).toBeCloseTo(25, 5);
  });
});

describe('painting', () => {
  it('a stroke drawn as overlapping capsules merges into one shape of the right area', () => {
    let region: Region = [];
    const radius = 3;
    for (let i = 0; i < 20; i++) {
      region = union(region, [capsule({ x: i * 4, y: 0 }, { x: (i + 1) * 4, y: 0 }, radius)]);
    }
    const expected = 80 * 6 + Math.PI * radius * radius;
    expect(region).toHaveLength(1);
    expect(Math.abs(area(region) - expected) / expected).toBeLessThan(0.01);
  });

  it('erasing the middle of a stroke leaves two pieces', () => {
    const stroke = union([], [capsule({ x: 0, y: 0 }, { x: 60, y: 0 }, 4)]);
    const left = difference(stroke, [circle({ x: 30, y: 0 }, 6)]);
    expect(toPolygons(left)).toHaveLength(2);
  });
});

describe('agreeing with point sampling', () => {
  // The strongest check: for random shapes, every operation must give the answer the
  // definition gives at points that are not on a boundary.
  function randomBlob(rand: () => number, cx: number, cy: number): Ring {
    const n = 5 + Math.floor(rand() * 8);
    const points: Ring = [];
    for (let i = 0; i < n; i++) {
      const angle = (i / n) * Math.PI * 2;
      const r = 6 + rand() * 12;
      points.push({ x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r });
    }
    return points;
  }

  for (const op of ['union', 'difference', 'intersection'] as const) {
    it(`${op} of 150 random pairs matches the definition at 300 points each`, () => {
      const rand = rng(op.length * 31);
      const fn = { union, difference, intersection }[op];
      let checked = 0;
      for (let trial = 0; trial < 150; trial++) {
        const A: Region = [randomBlob(rand, 0, 0)];
        const B: Region = [randomBlob(rand, (rand() - 0.5) * 24, (rand() - 0.5) * 24)];
        const R = fn(A, B);
        for (let i = 0; i < 300; i++) {
          const p = { x: (rand() - 0.5) * 60, y: (rand() - 0.5) * 60 };
          const a = contains(A, p);
          const b = contains(B, p);
          const expected = op === 'union' ? a || b : op === 'difference' ? a && !b : a && b;
          // Skip points within a hair of any boundary, where inside is a matter of rounding.
          const nearEdge = [...A, ...B, ...R].some((ring) =>
            ring.some((q, k) => {
              const n = ring[(k + 1) % ring.length]!;
              const dx = n.x - q.x;
              const dy = n.y - q.y;
              const t = Math.max(0, Math.min(1, ((p.x - q.x) * dx + (p.y - q.y) * dy) / (dx * dx + dy * dy || 1)));
              return Math.hypot(p.x - (q.x + t * dx), p.y - (q.y + t * dy)) < 1e-3;
            }),
          );
          if (nearEdge) continue;
          expect(contains(R, p), `${op} trial ${trial} at (${p.x.toFixed(3)}, ${p.y.toFixed(3)})`).toBe(expected);
          checked++;
        }
      }
      expect(checked).toBeGreaterThan(30000);
    });
  }

  it('area of a union equals area(A) + area(B) - area(A intersect B)', () => {
    const rand = rng(99);
    for (let i = 0; i < 100; i++) {
      const A: Region = [circle({ x: 0, y: 0 }, 5 + rand() * 8, 24)];
      const B: Region = [circle({ x: (rand() - 0.5) * 16, y: (rand() - 0.5) * 16 }, 5 + rand() * 8, 24)];
      const lhs = area(union(A, B));
      const rhs = area(A) + area(B) - area(intersection(A, B));
      expect(Math.abs(lhs - rhs)).toBeLessThan(1e-3);
    }
  });
});

describe('normalising', () => {
  it('orients outers counter-clockwise and holes clockwise', () => {
    const r = normalize([[...square(0, 0, 10)].reverse(), square(2, 2, 3)]);
    const signed = (ring: Ring) =>
      ring.reduce(
        (s, p, i) => s + (p.x * ring[(i + 1) % ring.length]!.y - ring[(i + 1) % ring.length]!.x * p.y),
        0,
      ) / 2;
    expect(signed(r[0]!)).toBeGreaterThan(0);
    expect(signed(r[1]!)).toBeLessThan(0);
  });

  it('drops rings that are not rings', () => {
    expect(
      normalize([
        [{ x: 0, y: 0 }, { x: 1, y: 1 }],
        [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }],
      ]),
    ).toEqual([]);
  });
});
