/**
 * A uniform-grid spatial index.
 *
 * Snapping, collision and join checks all ask the same question - "what is near here" - and
 * used to answer it by looking at everything, or by asking the renderer what pixels were
 * under the cursor. This answers it from the model, in constant time per query regardless of
 * how many roads the project has.
 *
 * A grid rather than an R-tree: street geometry is spread fairly evenly, edges are short
 * compared with the cell, and a grid is a few dozen lines that can be read in one sitting.
 * Items are stored in every cell their bounding box touches and de-duplicated on the way out.
 *
 * Coordinates are whatever plane the caller uses (the editor passes Web Mercator metres); the
 * cell size is in the same units.
 */

export interface Box {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export class GridIndex<T> {
  private readonly cells = new Map<string, T[]>();
  private count = 0;

  constructor(private readonly cell: number) {
    if (!(cell > 0)) throw new Error('GridIndex cell size must be positive');
  }

  get size(): number {
    return this.count;
  }

  insert(box: Box, item: T): void {
    const x0 = Math.floor(box.minX / this.cell);
    const x1 = Math.floor(box.maxX / this.cell);
    const y0 = Math.floor(box.minY / this.cell);
    const y1 = Math.floor(box.maxY / this.cell);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const key = `${x},${y}`;
        const bucket = this.cells.get(key);
        if (bucket) bucket.push(item);
        else this.cells.set(key, [item]);
      }
    }
    this.count++;
  }

  /** Every item whose bounding box shares a cell with `box`. A superset: callers measure. */
  query(box: Box): T[] {
    const x0 = Math.floor(box.minX / this.cell);
    const x1 = Math.floor(box.maxX / this.cell);
    const y0 = Math.floor(box.minY / this.cell);
    const y1 = Math.floor(box.maxY / this.cell);
    const seen = new Set<T>();
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const bucket = this.cells.get(`${x},${y}`);
        if (!bucket) continue;
        for (const item of bucket) seen.add(item);
      }
    }
    return [...seen];
  }

  /** Items near a point, within `radius` of it. */
  near(x: number, y: number, radius: number): T[] {
    return this.query({ minX: x - radius, minY: y - radius, maxX: x + radius, maxY: y + radius });
  }
}

/** Distance from a point to a line segment, and where on the segment is nearest. */
export function pointToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): { distance: number; t: number; x: number; y: number } {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  const t = lenSq <= 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  const x = ax + t * dx;
  const y = ay + t * dy;
  return { distance: Math.hypot(px - x, py - y), t, x, y };
}
