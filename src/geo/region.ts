import type { PlanePoint } from './crs';

/**
 * Regions of the plane and the booleans between them.
 *
 * Zoning is painted with a brush, which means every stroke has to be merged into what is
 * already there (a union) and every erase has to be cut out of it (a difference). Roads
 * avoided polygon booleans by drawing one thing over another; land use cannot, because it is
 * data that gets measured, saved and exported, so the ground it covers has to be exact.
 *
 * A region here is a list of rings under the even-odd rule: a point is inside if it is inside
 * an odd number of rings. That one rule gives islands, holes and islands in holes without
 * any bookkeeping about which ring is which. Everything works in a flat metre plane
 * (geo/crs.ts), so a tolerance in this file is a tolerance in metres.
 *
 * The method is the simple, robust one:
 *
 *   1. cut every edge of each region wherever it meets an edge of the other;
 *   2. classify each resulting piece as inside or outside the other region, with coincident
 *      pieces (the shared wall of two adjoining shapes) decided by their direction;
 *   3. keep the pieces the operation wants and stitch them back into rings.
 *
 * Rings are first normalised so the inside is always on the left of every edge (outer rings
 * counter-clockwise, holes clockwise), which is what makes step 2's direction rule work.
 */

export type Ring = PlanePoint[];
export type Region = Ring[];

/** Points closer than this, in metres, are the same point. */
const SNAP = 1e-6;

/** Rings smaller than this, in square metres, are numerical dust. */
const MIN_AREA = 1e-5;

const key = (p: PlanePoint) => `${Math.round(p.x / SNAP)},${Math.round(p.y / SNAP)}`;

// ---------------------------------------------------------------------------- basics

export function ringArea(ring: Ring): number {
  let sum = 0;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    sum += a.x * b.y - b.x * a.y;
  }
  return sum / 2;
}

/** Area of a region under the even-odd rule: outer rings add, holes subtract. */
export function area(region: Region): number {
  return Math.abs(region.reduce((total, ring) => total + Math.abs(ringArea(ring)) * evenOddSign(region, ring), 0));
}

/** +1 for a ring at even depth (adds area), -1 at odd depth (removes it). */
function evenOddSign(region: Region, ring: Ring): number {
  return depthOf(region, ring) % 2 === 0 ? 1 : -1;
}

function depthOf(region: Region, ring: Ring): number {
  const probe = boundaryProbe(ring);
  let depth = 0;
  for (const other of region) {
    if (other === ring) continue;
    if (pointInRing(probe, other)) depth++;
  }
  return depth;
}

/**
 * A point on a ring's own boundary that is unlikely to touch any other ring: the middle of
 * its longest edge. Nesting is decided by asking which OTHER rings contain this point.
 *
 * It has to be on the boundary, not inside the ring: a point inside an outer ring can lie in
 * its own hole, which would make the outer ring look nested in the hole.
 */
function boundaryProbe(ring: Ring): PlanePoint {
  let best = ring[0]!;
  let next = ring[1 % ring.length]!;
  let longest = -1;
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]!;
    const b = ring[(i + 1) % ring.length]!;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (length > longest) {
      longest = length;
      best = a;
      next = b;
    }
  }
  return { x: (best.x + next.x) / 2, y: (best.y + next.y) / 2 };
}

/** Crossing-number test for one ring. Points exactly on the boundary are not guaranteed. */
export function pointInRing(p: PlanePoint, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]!;
    const b = ring[j]!;
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside;
    }
  }
  return inside;
}

/** Even-odd containment in a region. */
export function contains(region: Region, p: PlanePoint): boolean {
  let inside = false;
  for (const ring of region) if (pointInRing(p, ring)) inside = !inside;
  return inside;
}

// ---------------------------------------------------------------------------- shapes

/** A regular polygon approximating a circle, counter-clockwise. */
export function circle(centre: PlanePoint, radius: number, sides = 32): Ring {
  const out: Ring = [];
  for (let i = 0; i < sides; i++) {
    const a = (i / sides) * Math.PI * 2;
    out.push({ x: centre.x + radius * Math.cos(a), y: centre.y + radius * Math.sin(a) });
  }
  return out;
}

/** The ground swept by a circle of `radius` moving from `a` to `b`: a stadium shape. */
export function capsule(a: PlanePoint, b: PlanePoint, radius: number, sides = 32): Ring {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.hypot(dx, dy) < SNAP * 10) return circle(a, radius, sides);
  const heading = Math.atan2(dy, dx);
  const half = Math.max(2, Math.floor(sides / 2));
  const out: Ring = [];
  // A semicircle round b, from the right of travel to the left, then one round a.
  for (let i = 0; i <= half; i++) {
    const t = heading - Math.PI / 2 + (i / half) * Math.PI;
    out.push({ x: b.x + radius * Math.cos(t), y: b.y + radius * Math.sin(t) });
  }
  for (let i = 0; i <= half; i++) {
    const t = heading + Math.PI / 2 + (i / half) * Math.PI;
    out.push({ x: a.x + radius * Math.cos(t), y: a.y + radius * Math.sin(t) });
  }
  return out;
}

// ------------------------------------------------------------------------ normalising

/** Remove repeated points and points that sit on a straight run, snapping to the grid. */
function clean(ring: Ring): Ring {
  const snapped: Ring = [];
  for (const p of ring) {
    const q = { x: Math.round(p.x / SNAP) * SNAP, y: Math.round(p.y / SNAP) * SNAP };
    const last = snapped[snapped.length - 1];
    if (!last || last.x !== q.x || last.y !== q.y) snapped.push(q);
  }
  while (snapped.length > 1 && snapped[0]!.x === snapped[snapped.length - 1]!.x && snapped[0]!.y === snapped[snapped.length - 1]!.y) {
    snapped.pop();
  }
  // Drop points exactly on the line between their neighbours (spikes included).
  let changed = true;
  while (changed && snapped.length >= 3) {
    changed = false;
    for (let i = 0; i < snapped.length; i++) {
      const a = snapped[(i - 1 + snapped.length) % snapped.length]!;
      const b = snapped[i]!;
      const c = snapped[(i + 1) % snapped.length]!;
      const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      if (Math.abs(cross) < 1e-9) {
        snapped.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return snapped;
}

/**
 * Clean every ring and orient them so the inside is on the left: even-depth rings
 * counter-clockwise, odd-depth (holes) clockwise.
 */
export function normalize(region: Region): Region {
  const rings = region.map(clean).filter((r) => r.length >= 3 && Math.abs(ringArea(r)) >= MIN_AREA);
  return rings.map((ring) => {
    const wantCcw = depthOf(rings, ring) % 2 === 0;
    const isCcw = ringArea(ring) > 0;
    return wantCcw === isCcw ? ring : [...ring].reverse();
  });
}

// --------------------------------------------------------------------- the boolean

interface Edge {
  a: PlanePoint;
  b: PlanePoint;
}

/** Parameters along a->b at which another edge meets it, including overlaps. */
function meetings(e: Edge, f: Edge, out: number[]): void {
  const rx = e.b.x - e.a.x;
  const ry = e.b.y - e.a.y;
  const sx = f.b.x - f.a.x;
  const sy = f.b.y - f.a.y;
  const denom = rx * sy - ry * sx;
  const lenE = Math.hypot(rx, ry);
  const lenF = Math.hypot(sx, sy);
  if (lenE === 0 || lenF === 0) return;

  // Parallel (or nearly): only an overlap matters.
  if (Math.abs(denom) <= 1e-9 * lenE * lenF) {
    const offLine = Math.abs((f.a.x - e.a.x) * ry - (f.a.y - e.a.y) * rx) / lenE;
    if (offLine > SNAP * 4) return;
    for (const p of [f.a, f.b]) {
      const t = ((p.x - e.a.x) * rx + (p.y - e.a.y) * ry) / (lenE * lenE);
      if (t > 0 && t < 1) out.push(t);
    }
    return;
  }

  const qx = f.a.x - e.a.x;
  const qy = f.a.y - e.a.y;
  const t = (qx * sy - qy * sx) / denom;
  const u = (qx * ry - qy * rx) / denom;
  const tol = (SNAP * 4) / lenE;
  const tolU = (SNAP * 4) / lenF;
  if (u < -tolU || u > 1 + tolU || t < -tol || t > 1 + tol) return;
  if (t > tol && t < 1 - tol) out.push(t);
}

interface Piece {
  a: PlanePoint;
  b: PlanePoint;
}

function cut(region: Region, other: Region): Piece[] {
  const otherEdges: Edge[] = [];
  for (const ring of other) {
    for (let i = 0; i < ring.length; i++) otherEdges.push({ a: ring[i]!, b: ring[(i + 1) % ring.length]! });
  }

  // A coarse bounding box of the other region, to skip edges nowhere near it.
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const e of otherEdges) {
    minX = Math.min(minX, e.a.x, e.b.x);
    minY = Math.min(minY, e.a.y, e.b.y);
    maxX = Math.max(maxX, e.a.x, e.b.x);
    maxY = Math.max(maxY, e.a.y, e.b.y);
  }

  const pieces: Piece[] = [];
  for (const ring of region) {
    for (let i = 0; i < ring.length; i++) {
      const e: Edge = { a: ring[i]!, b: ring[(i + 1) % ring.length]! };
      const params: number[] = [];

      const near =
        Math.max(e.a.x, e.b.x) >= minX - 1e-4 &&
        Math.min(e.a.x, e.b.x) <= maxX + 1e-4 &&
        Math.max(e.a.y, e.b.y) >= minY - 1e-4 &&
        Math.min(e.a.y, e.b.y) <= maxY + 1e-4;
      if (near) {
        for (const f of otherEdges) {
          if (
            Math.max(f.a.x, f.b.x) < Math.min(e.a.x, e.b.x) - 1e-4 ||
            Math.min(f.a.x, f.b.x) > Math.max(e.a.x, e.b.x) + 1e-4 ||
            Math.max(f.a.y, f.b.y) < Math.min(e.a.y, e.b.y) - 1e-4 ||
            Math.min(f.a.y, f.b.y) > Math.max(e.a.y, e.b.y) + 1e-4
          ) {
            continue;
          }
          meetings(e, f, params);
        }
      }

      params.sort((p, q) => p - q);
      let from = e.a;
      let last = 0;
      for (const t of params) {
        if (t - last < 1e-12) continue;
        const to = { x: e.a.x + (e.b.x - e.a.x) * t, y: e.a.y + (e.b.y - e.a.y) * t };
        pieces.push({ a: from, b: to });
        from = to;
        last = t;
      }
      pieces.push({ a: from, b: e.b });
    }
  }

  // Snap every end to the grid so pieces from both regions that meet share exact points.
  return pieces
    .map((p) => ({
      a: { x: Math.round(p.a.x / SNAP) * SNAP, y: Math.round(p.a.y / SNAP) * SNAP },
      b: { x: Math.round(p.b.x / SNAP) * SNAP, y: Math.round(p.b.y / SNAP) * SNAP },
    }))
    .filter((p) => p.a.x !== p.b.x || p.a.y !== p.b.y);
}

type Op = 'union' | 'difference' | 'intersection';

const undirected = (p: Piece) => {
  const ka = key(p.a);
  const kb = key(p.b);
  return ka < kb ? `${ka}|${kb}` : `${kb}|${ka}`;
};

function combine(aIn: Region, bIn: Region, op: Op): Region {
  const a = normalize(aIn);
  const b = normalize(bIn);

  if (a.length === 0) {
    if (op === 'union') return b;
    return [];
  }
  if (b.length === 0) {
    if (op === 'intersection') return [];
    return a;
  }

  const aPieces = cut(a, b);
  const bPieces = cut(b, a);

  // Index the other region's pieces to recognise a shared wall, and remember its direction.
  const bByKey = new Map<string, Piece>();
  for (const p of bPieces) bByKey.set(undirected(p), p);
  const aByKey = new Map<string, Piece>();
  for (const p of aPieces) aByKey.set(undirected(p), p);

  const sameDirection = (p: Piece, q: Piece) => key(p.a) === key(q.a) && key(p.b) === key(q.b);
  const mid = (p: Piece): PlanePoint => ({ x: (p.a.x + p.b.x) / 2, y: (p.a.y + p.b.y) / 2 });
  const reverse = (p: Piece): Piece => ({ a: p.b, b: p.a });

  const kept: Piece[] = [];

  for (const p of aPieces) {
    const twin = bByKey.get(undirected(p));
    if (twin) {
      const same = sameDirection(p, twin);
      if (op === 'union' && same) kept.push(p);
      else if (op === 'difference' && !same) kept.push(p);
      else if (op === 'intersection' && same) kept.push(p);
      continue;
    }
    const inside = contains(b, mid(p));
    if (op === 'union' && !inside) kept.push(p);
    else if (op === 'difference' && !inside) kept.push(p);
    else if (op === 'intersection' && inside) kept.push(p);
  }

  for (const p of bPieces) {
    if (aByKey.has(undirected(p))) continue; // decided from a's side
    const inside = contains(a, mid(p));
    if (op === 'union' && !inside) kept.push(p);
    else if (op === 'difference' && inside) kept.push(reverse(p));
    else if (op === 'intersection' && inside) kept.push(p);
  }

  return normalize(stitch(kept));
}

/** Join directed pieces end to end into closed rings. */
function stitch(pieces: Piece[]): Region {
  const outgoing = new Map<string, Piece[]>();
  for (const p of pieces) {
    const list = outgoing.get(key(p.a));
    if (list) list.push(p);
    else outgoing.set(key(p.a), [p]);
  }

  const used = new Set<Piece>();
  const rings: Region = [];

  for (const start of pieces) {
    if (used.has(start)) continue;
    const ring: Ring = [];
    let current: Piece | undefined = start;
    let guard = pieces.length + 2;

    while (current && !used.has(current) && guard-- > 0) {
      used.add(current);
      ring.push(current.a);
      const options: Piece[] = (outgoing.get(key(current.b)) ?? []).filter((q) => !used.has(q));
      if (options.length === 0) {
        current = undefined;
      } else if (options.length === 1) {
        current = options[0];
      } else {
        // Several ways on at a touching point: take the sharpest left turn, which stays
        // with the shape being traced rather than hopping to a neighbour.
        const heading = Math.atan2(current.b.y - current.a.y, current.b.x - current.a.x);
        let best = options[0]!;
        let bestTurn = -Infinity;
        for (const q of options) {
          let turn = Math.atan2(q.b.y - q.a.y, q.b.x - q.a.x) - heading;
          while (turn > Math.PI) turn -= 2 * Math.PI;
          while (turn <= -Math.PI) turn += 2 * Math.PI;
          if (turn > bestTurn) {
            bestTurn = turn;
            best = q;
          }
        }
        current = best;
      }
    }
    if (ring.length >= 3) rings.push(ring);
  }
  return rings;
}

export const union = (a: Region, b: Region): Region => combine(a, b, 'union');
export const difference = (a: Region, b: Region): Region => combine(a, b, 'difference');
export const intersection = (a: Region, b: Region): Region => combine(a, b, 'intersection');

/**
 * Split a region into polygons: each outer ring with the holes inside it.
 *
 * What a document stores, since a zone is one polygon with holes. Rings at even depth are
 * outers; each odd-depth ring is a hole of the smallest outer that contains it.
 */
export function toPolygons(region: Region): Ring[][] {
  const rings = normalize(region);
  const outers = rings.filter((r) => depthOf(rings, r) % 2 === 0);
  const holes = rings.filter((r) => depthOf(rings, r) % 2 === 1);
  const polygons: Ring[][] = outers.map((outer) => [outer]);
  for (const hole of holes) {
    const probe = boundaryProbe(hole);
    let best = -1;
    let bestArea = Infinity;
    outers.forEach((outer, i) => {
      if (pointInRing(probe, outer) && Math.abs(ringArea(outer)) < bestArea) {
        best = i;
        bestArea = Math.abs(ringArea(outer));
      }
    });
    if (best >= 0) polygons[best]!.push(hole);
  }
  return polygons;
}
