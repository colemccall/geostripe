/**
 * Pavement marking glyphs.
 *
 * Every glyph is authored once, in metres, in a lane-local frame:
 *
 *   +x  the direction the traffic using this lane travels
 *   +y  that driver's left
 *   0,0 the centre of the glyph, so placement is "put this at station s"
 *
 * Authoring in real metres rather than a unit square is deliberate. A lane-use arrow is
 * about 3 m long on the ground, and a symbol that is not is a lie the same way a 2.33 m
 * lane is a lie — the whole tool rests on measuring what it draws. The figures follow the
 * MUTCD's Part 3B tables closely enough to be honest at map scale without pretending to
 * be a striping plan.
 *
 * A glyph is a list of *polygons*, each an outer ring plus optional holes. They are drawn
 * as one solid fill, so overlapping parts are free — a turn arrow is a thickened shaft and
 * a separate head triangle, and nobody has to union them.
 */

export type Point = [number, number];
/** Outer ring first, holes after. */
export type GlyphPolygon = Point[][];

export type GlyphId =
  // lane-use arrows
  | 'arrowThrough'
  | 'arrowLeft'
  | 'arrowRight'
  | 'arrowThroughLeft'
  | 'arrowThroughRight'
  | 'arrowLeftRight'
  | 'arrowAll'
  | 'arrowUTurn'
  | 'arrowUTurnLeft'
  | 'arrowMergeLeft'
  | 'arrowMergeRight'
  // mode symbols
  | 'bike'
  | 'sharrow'
  | 'bikeChevron'
  | 'diamond'
  | 'pedestrian'
  // surface markings
  | 'sharkTeeth'
  | 'railCrossing'
  | 'keepClear';

export interface GlyphSpec {
  readonly label: string;
  /** Extent along the direction of travel. Drives spacing and the fit-in-lane check. */
  readonly lengthMeters: number;
  /** Extent across the lane. A glyph wider than its lane is suppressed rather than clipped. */
  readonly widthMeters: number;
  readonly note: string;
  /** Lane width is passed in because a few glyphs (shark's teeth, keep-clear) span it. */
  readonly build: (laneWidthMeters: number) => GlyphPolygon[];
}

// ------------------------------------------------------------------------- primitives

const TAU = Math.PI * 2;

function arc(cx: number, cy: number, r: number, from: number, to: number, steps = 10): Point[] {
  const out: Point[] = [];
  for (let i = 0; i <= steps; i++) out.push([cx + r * Math.cos(from + ((to - from) * i) / steps), cy + r * Math.sin(from + ((to - from) * i) / steps)]);
  return out;
}

function circle(cx: number, cy: number, r: number, steps = 20): Point[] {
  const ring = arc(cx, cy, r, 0, TAU, steps);
  ring[ring.length - 1] = [ring[0]![0], ring[0]![1]];
  return ring;
}

/** A wheel: an outer circle with the hub punched out, so it reads as a rim not a disc. */
function annulus(cx: number, cy: number, outer: number, inner: number): GlyphPolygon {
  return [circle(cx, cy, outer), circle(cx, cy, inner).slice().reverse()];
}

/**
 * Give a path width.
 *
 * Vertex normals are averaged from the neighbouring segments, which is exact on a straight
 * run and slightly narrows the outside of a bend. Arcs here are stepped finely enough that
 * the error is well under a centimetre, and a mitre join would spike on the tight bends a
 * turn arrow is made of.
 */
function thicken(path: readonly Point[], half: number): Point[] {
  const n = path.length;
  if (n < 2) return [];

  const normals: Point[] = [];
  for (let i = 0; i < n; i++) {
    const a = path[Math.max(0, i - 1)]!;
    const b = path[Math.min(n - 1, i + 1)]!;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const len = Math.hypot(dx, dy) || 1;
    normals.push([-dy / len, dx / len]);
  }

  const left: Point[] = path.map((p, i) => [p[0] + normals[i]![0] * half, p[1] + normals[i]![1] * half]);
  const right: Point[] = path.map((p, i) => [p[0] - normals[i]![0] * half, p[1] - normals[i]![1] * half]);
  right.reverse();
  return [...left, ...right, [left[0]![0], left[0]![1]]];
}

/** Arrow head: an isosceles triangle with its tip at the end of a path. */
function head(tip: Point, direction: Point, length: number, halfWidth: number): Point[] {
  const len = Math.hypot(direction[0], direction[1]) || 1;
  const d: Point = [direction[0] / len, direction[1] / len];
  const n: Point = [-d[1], d[0]];
  const back: Point = [tip[0] - d[0] * length, tip[1] - d[1] * length];
  return [
    tip,
    [back[0] + n[0] * halfWidth, back[1] + n[1] * halfWidth],
    [back[0] - n[0] * halfWidth, back[1] - n[1] * halfWidth],
    tip,
  ];
}

// ------------------------------------------------------------------------ arrow parts

const STEM_HALF = 0.15;
const HEAD_LENGTH = 0.95;
const HEAD_HALF = 0.45;

/** A straight through arrow, tip forward. */
function throughArrow(from: number, to: number): GlyphPolygon[] {
  return [
    [thicken([[from, 0], [to - HEAD_LENGTH * 0.6, 0]], STEM_HALF)],
    [head([to, 0], [1, 0], HEAD_LENGTH, HEAD_HALF)],
  ];
}

/**
 * A turn arrow: a straight shaft, a quarter-turn, and a head pointing across the lane.
 *
 * `side` is +1 for a left turn and -1 for a right one, in the driver's frame — which is
 * the only frame a turn arrow can sensibly be authored in, and the reason the placement
 * code has to be careful about which way a leg points.
 */
function turnArrow(side: 1 | -1, tail: number, bendAt: number, radius: number): GlyphPolygon[] {
  const centre: Point = [bendAt, side * radius];
  const start = side > 0 ? -Math.PI / 2 : Math.PI / 2;
  const path: Point[] = [
    [tail, 0],
    ...arc(centre[0], centre[1], radius, start, 0, 6),
  ];
  const end = path[path.length - 1]!;
  const direction: Point = [0, side];
  const tip: Point = [end[0], end[1] + side * 0.55];
  return [[thicken(path, STEM_HALF)], [head(tip, direction, 0.6, HEAD_HALF * 0.85)]];
}

/** A lane-drop / merge arrow: a long shallow shift with no straight continuation. */
function mergeArrow(side: 1 | -1): GlyphPolygon[] {
  const path: Point[] = [
    [-1.5, 0],
    [-0.6, 0],
    ...arc(-0.6, side * 1.4, 1.4, side > 0 ? -Math.PI / 2 : Math.PI / 2, side > 0 ? -Math.PI / 4 : Math.PI / 4, 6),
  ];
  const end = path[path.length - 1]!;
  const direction: Point = [Math.SQRT1_2, side * Math.SQRT1_2];
  const tip: Point = [end[0] + direction[0] * 0.6, end[1] + direction[1] * 0.6];
  return [[thicken(path, STEM_HALF)], [head(tip, direction, 0.7, HEAD_HALF * 0.85)]];
}

/** A bicycle in side elevation, nose forward — the MUTCD symbol, simplified. */
function bicycle(): GlyphPolygon[] {
  const frame: Point[] = [
    [-0.55, 0],
    [-0.08, 0.42],
    [0.5, 0.04],
    [-0.05, 0.02],
    [-0.55, 0],
  ];
  return [
    annulus(-0.55, 0, 0.32, 0.19),
    annulus(0.55, 0, 0.32, 0.19),
    [thicken(frame, 0.055)],
    // Seat and handlebar: the two details that stop it reading as a pair of spectacles.
    [thicken([[-0.28, 0.46], [0.02, 0.44]], 0.05)],
    [thicken([[0.5, 0.04], [0.44, 0.5]], 0.05)],
    [thicken([[0.3, 0.5], [0.6, 0.48]], 0.05)],
  ];
}

function chevronAt(x: number): GlyphPolygon {
  return [thicken([[x - 0.3, -0.42], [x + 0.14, 0], [x - 0.3, 0.42]], 0.085)];
}

// ------------------------------------------------------------------------- the library

export const GLYPHS: Readonly<Record<GlyphId, GlyphSpec>> = {
  arrowThrough: {
    label: 'Through arrow',
    lengthMeters: 3.0,
    widthMeters: 0.95,
    note: 'MUTCD lane-use arrow for a lane that continues straight through the junction.',
    build: () => throughArrow(-1.5, 1.5),
  },
  arrowLeft: {
    label: 'Left-turn arrow',
    lengthMeters: 2.6,
    widthMeters: 1.3,
    note: 'A left-turn-only lane. Paired with a stop bar it is the clearest way to show a turn pocket.',
    build: () => turnArrow(1, -1.3, 0.35, 0.5),
  },
  arrowRight: {
    label: 'Right-turn arrow',
    lengthMeters: 2.6,
    widthMeters: 1.3,
    note: 'A right-turn-only lane, usually the kerbside one on the approach.',
    build: () => turnArrow(-1, -1.3, 0.35, 0.5),
  },
  arrowThroughLeft: {
    label: 'Through / left arrow',
    lengthMeters: 3.0,
    widthMeters: 1.6,
    note: 'A shared lane serving both movements — the commonest arrow on a two-lane approach.',
    build: () => [...throughArrow(-1.5, 1.5), ...turnArrow(1, -1.0, -0.15, 0.5)],
  },
  arrowThroughRight: {
    label: 'Through / right arrow',
    lengthMeters: 3.0,
    widthMeters: 1.6,
    note: 'A shared kerbside lane. Where it meets a crossing, the right hook is the conflict to design out.',
    build: () => [...throughArrow(-1.5, 1.5), ...turnArrow(-1, -1.0, -0.15, 0.5)],
  },
  arrowLeftRight: {
    label: 'Left / right arrow',
    lengthMeters: 2.6,
    widthMeters: 2.2,
    note: 'The single approach lane of a T-junction, where straight ahead is not an option.',
    build: () => [...turnArrow(1, -1.3, 0.35, 0.5), ...turnArrow(-1, -1.3, 0.35, 0.5)],
  },
  arrowAll: {
    label: 'All-movements arrow',
    lengthMeters: 3.0,
    widthMeters: 2.2,
    note: 'One lane serving every movement. On a wide approach it usually means the lane is doing too much.',
    build: () => [
      ...throughArrow(-1.5, 1.5),
      ...turnArrow(1, -1.0, -0.15, 0.5),
      ...turnArrow(-1, -1.0, -0.15, 0.5),
    ],
  },
  arrowUTurn: {
    label: 'U-turn arrow',
    lengthMeters: 2.3,
    widthMeters: 1.6,
    note: 'A U-turn bay, typically opposite a median opening on a divided road.',
    build: () => {
      const path: Point[] = [
        [-1.3, -0.35],
        [0.3, -0.35],
        ...arc(0.3, 0.15, 0.5, -Math.PI / 2, Math.PI / 2, 8),
      ];
      const end = path[path.length - 1]!;
      return [[thicken(path, STEM_HALF)], [head([end[0] - 0.75, end[1]], [-1, 0], 0.6, HEAD_HALF * 0.85)]];
    },
  },
  arrowUTurnLeft: {
    label: 'U-turn / left arrow',
    lengthMeters: 2.8,
    widthMeters: 1.6,
    note: 'A left-turn pocket that also permits the U-turn, which is how most median openings really work.',
    build: () => [...GLYPHS.arrowUTurn.build(0), ...turnArrow(1, -1.3, 0.6, 0.45)],
  },
  arrowMergeLeft: {
    label: 'Merge-left arrow',
    lengthMeters: 2.5,
    widthMeters: 1.1,
    note: 'A lane drop. The arrow shows where the lane ends, not where the taper starts.',
    build: () => mergeArrow(1),
  },
  arrowMergeRight: {
    label: 'Merge-right arrow',
    lengthMeters: 2.5,
    widthMeters: 1.1,
    note: 'A lane drop toward the kerb, the usual form on an approach that loses its outside lane.',
    build: () => mergeArrow(-1),
  },

  bike: {
    label: 'Bicycle symbol',
    lengthMeters: 1.8,
    widthMeters: 0.9,
    note: 'Marks a lane as a bike lane. Repeated after every junction so the lane is unambiguous where it matters.',
    build: () => bicycle(),
  },
  sharrow: {
    label: 'Shared-lane marking',
    lengthMeters: 2.6,
    widthMeters: 1.1,
    note: 'A sharrow — bicycle plus double chevron. NACTO treats it as the weakest treatment there is.',
    build: () => [...bicycle(), chevronAt(1.05), chevronAt(1.45)],
  },
  bikeChevron: {
    label: 'Bike chevron',
    lengthMeters: 1.0,
    widthMeters: 1.0,
    note: 'Direction chevrons alone, for a contraflow lane or a two-way track where the side matters.',
    build: () => [chevronAt(-0.2), chevronAt(0.2)],
  },
  diamond: {
    label: 'Preferential-lane diamond',
    lengthMeters: 2.4,
    widthMeters: 1.2,
    note: 'The MUTCD preferential-lane symbol: bus, HOV or any lane reserved for part of the traffic.',
    build: () => [[[[1.2, 0], [0, 0.6], [-1.2, 0], [0, -0.6], [1.2, 0]]]],
  },
  pedestrian: {
    label: 'Pedestrian symbol',
    lengthMeters: 1.4,
    widthMeters: 0.7,
    note: 'Marks a footway or the walking side of a shared-use path.',
    // Head toward +x: a pavement symbol is read by someone travelling along the lane, so
    // the figure walks the way they are going rather than lying across it.
    build: () => [
      [circle(0.5, 0, 0.17)],
      [thicken([[0.33, 0], [-0.05, -0.05]], 0.1)],
      [thicken([[-0.05, -0.05], [-0.48, 0.16]], 0.075)],
      [thicken([[-0.05, -0.05], [-0.52, -0.18]], 0.075)],
      [thicken([[0.26, 0.02], [-0.08, 0.26]], 0.06)],
    ],
  },

  sharkTeeth: {
    label: "Yield line (shark's teeth)",
    lengthMeters: 0.6,
    widthMeters: 0,
    note: 'A row of triangles pointing at approaching traffic. Yield here — the standard marking at a crossing or a roundabout entry.',
    build: (laneWidth) => {
      const pitch = 0.9;
      const usable = Math.max(pitch, laneWidth);
      const count = Math.max(1, Math.floor(usable / pitch));
      const span = count * pitch;
      const out: GlyphPolygon[] = [];
      for (let i = 0; i < count; i++) {
        const centre = -span / 2 + pitch * (i + 0.5);
        out.push([[[-0.3, centre - 0.3], [0.3, centre], [-0.3, centre + 0.3], [-0.3, centre - 0.3]]]);
      }
      return out;
    },
  },
  railCrossing: {
    label: 'Railway crossing',
    lengthMeters: 3.4,
    widthMeters: 2.3,
    note: 'The pavement X ahead of a level crossing.',
    build: () => [
      [thicken([[-1.6, -1.0], [1.6, 1.0]], 0.16)],
      [thicken([[-1.6, 1.0], [1.6, -1.0]], 0.16)],
    ],
  },
  keepClear: {
    label: 'Keep-clear hatching',
    lengthMeters: 6.3,
    widthMeters: 0,
    note: 'Cross-hatching over ground that must not be blocked — a junction box, a fire path, a driveway.',
    // Steep strokes rather than 45 degrees, so the hatch stays inside its own box however
    // wide the lane is. A 45-degree stroke grows with the lane and runs off both ends.
    build: (laneWidth) => {
      const half = Math.max(1, laneWidth / 2);
      const out: GlyphPolygon[] = [];
      for (let x = -2.6; x <= 2.6; x += 1.0) {
        out.push([thicken([[x, -half], [x + 0.8, half]], 0.09)]);
      }
      return out;
    },
  },
};

export const GLYPH_IDS = Object.keys(GLYPHS) as GlyphId[];

export function isGlyphId(value: unknown): value is GlyphId {
  return typeof value === 'string' && value in GLYPHS;
}

/** Bounding box of a built glyph, for tests and for the fits-in-the-lane check. */
export function glyphBounds(polygons: readonly GlyphPolygon[]): {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
} {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const polygon of polygons) {
    for (const ring of polygon) {
      for (const [x, y] of ring) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return { minX, maxX, minY, maxY };
}
