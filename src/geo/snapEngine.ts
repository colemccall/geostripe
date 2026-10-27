import { resolveCenterline, resolveRing } from './curve';
import { dedupe, fromMercator, scaleAt, toMercator } from './crs';
import type { LngLat } from './crs';
import { GridIndex, pointToSegment } from './spatial';
import { isLineAsset } from '../model/asset';
import type { Asset } from '../model/asset';
import { nodeMap, segmentControlPoints, splitPointFor } from '../model/doc';
import type { Doc, Snap } from '../model/doc';
import { sectionExtent } from '../model/section';

/**
 * Snapping: what the cursor lands on.
 *
 * It used to ask the renderer - "which pixels are under the cursor" - which ties the answer
 * to what happens to be drawn (a hidden deck snaps to nothing), to a pixel box instead of a
 * distance, and to whichever layer MapLibre returned first. This asks the model. Every
 * candidate is measured in real metres from the cursor, ranked by an explicit priority table,
 * and returned as a list, so the interface can show the winner and cycle through the rest.
 *
 * Distances are measured in Web Mercator (the plane the map is drawn in) and divided by the
 * stretch at the cursor's latitude, so a tolerance of 1.5 m means 1.5 m on the ground.
 */

export type SnapKind = 'node' | 'centreline' | 'edge' | 'areaVertex' | 'areaEdge';

/**
 * Which kinds of thing each tool snaps to, strongest first.
 *
 * Data, not code, so the priority is something to read and argue about. A node beats the
 * centreline of the road it sits on because joining at a place that already exists is nearly
 * always the intent. Ground shapes snap to each other's corners before anything else and may
 * follow a kerb, but never a centreline: a park boundary is not drawn down the middle of a
 * street.
 */
export const SNAP_ORDER = {
  build: ['node', 'centreline'],
  select: ['node', 'centreline'],
  area: ['areaVertex', 'node', 'edge', 'areaEdge'],
} as const satisfies Record<string, readonly SnapKind[]>;

export type SnapContext = keyof typeof SNAP_ORDER;

export interface SnapCandidate {
  kind: SnapKind;
  position: LngLat;
  /** Real ground distance from the cursor, in metres. */
  distanceMetres: number;
  /** What the model operation wants, for kinds that name an existing thing. */
  snap?: Snap;
  /** Short label for the status strip. */
  label: string;
}

interface Point {
  x: number;
  y: number;
}

interface PointItem extends Point {
  kind: 'node' | 'areaVertex';
  id: string;
}

interface EdgeItem {
  kind: 'road' | 'area';
  id: string;
  a: Point;
  b: Point;
  /** Lateral offsets of the two kerbs from the line, in metres. Roads only. */
  kerbs?: [number, number];
}

export interface SnapIndex {
  readonly points: GridIndex<PointItem>;
  readonly edges: GridIndex<EdgeItem>;
  readonly doc: Doc;
}

/** Cell size in Mercator metres: a few streets wide, so a query touches a handful of cells. */
const CELL = 200;

const sub = (p: LngLat): Point => toMercator(p);

/**
 * Index the model once per document, then query it per pointer move.
 *
 * Building is linear in the size of the project; it is rebuilt when the document changes, not
 * when the pointer does.
 */
export function buildSnapIndex(doc: Doc, assets: ReadonlyMap<string, Asset>): SnapIndex {
  const points = new GridIndex<PointItem>(CELL);
  const edges = new GridIndex<EdgeItem>(CELL);
  const nodes = nodeMap(doc);

  for (const node of doc.nodes) {
    const m = sub(node.position);
    points.insert({ minX: m.x, minY: m.y, maxX: m.x, maxY: m.y }, { kind: 'node', id: node.id, ...m });
  }

  for (const segment of doc.segments) {
    if (segment.visible === false) continue;
    const controls = segmentControlPoints(segment, nodes);
    if (!controls) continue;
    const line = dedupe(
      resolveCenterline({ id: segment.id, centerline: controls, curve: segment.curve }),
    );
    if (line.length < 2) continue;

    const asset = assets.get(segment.assetId);
    let kerbs: [number, number] | undefined;
    if (asset && isLineAsset(asset)) {
      const extent = sectionExtent(asset);
      // Line-frame lateral offsets, positive to the right of travel; see paint.ts. A reversed
      // road mirrors its stack, so the kerbs swap sides.
      kerbs = segment.reversed ? [extent.left, -extent.right] : [extent.right, -extent.left];
    }

    const m = line.map(sub);
    for (let i = 0; i < m.length - 1; i++) {
      const a = m[i]!;
      const b = m[i + 1]!;
      // Pad the box by the kerb reach so a query near a kerb finds the edge it belongs to.
      const pad = (Math.max(Math.abs(kerbs?.[0] ?? 0), Math.abs(kerbs?.[1] ?? 0)) + 1) * scaleAt(line[i]![1]);
      edges.insert(
        {
          minX: Math.min(a.x, b.x) - pad,
          minY: Math.min(a.y, b.y) - pad,
          maxX: Math.max(a.x, b.x) + pad,
          maxY: Math.max(a.y, b.y) + pad,
        },
        { kind: 'road', id: segment.id, a, b, kerbs },
      );
    }
  }

  for (const area of doc.areas) {
    if (area.visible === false) continue;
    const ring = area.ring;
    for (const p of ring) {
      const m = sub(p);
      points.insert({ minX: m.x, minY: m.y, maxX: m.x, maxY: m.y }, { kind: 'areaVertex', id: area.id, ...m });
    }
    const resolved = resolveRing({ id: area.id, ring: area.ring, curve: area.curve });
    const m = resolved.map(sub);
    for (let i = 0; i < m.length; i++) {
      const a = m[i]!;
      const b = m[(i + 1) % m.length]!;
      edges.insert(
        { minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y), maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y) },
        { kind: 'area', id: area.id, a, b },
      );
    }
  }

  return { points, edges, doc };
}

export interface FindOptions {
  /** Ignore these node ids, e.g. the node currently being dragged. */
  excludeNodeIds?: ReadonlySet<string>;
  /** Ignore segments with these ids. */
  excludeSegmentIds?: ReadonlySet<string>;
  /** Ignore area shapes with these ids. */
  excludeAreaIds?: ReadonlySet<string>;
}

/**
 * Everything within `toleranceMetres` of the cursor that the context may snap to, strongest
 * first and nearest first within a kind. The first element is what a click lands on.
 */
export function findSnaps(
  index: SnapIndex,
  cursor: LngLat,
  toleranceMetres: number,
  context: SnapContext,
  options: FindOptions = {},
): SnapCandidate[] {
  const allowed: readonly SnapKind[] = SNAP_ORDER[context];
  const k = scaleAt(cursor[1]);
  const c = sub(cursor);
  const reach = toleranceMetres * k;
  const out: SnapCandidate[] = [];
  const nodes = nodeMap(index.doc);

  for (const item of index.points.near(c.x, c.y, reach)) {
    if (!allowed.includes(item.kind)) continue;
    if (item.kind === 'node' && options.excludeNodeIds?.has(item.id)) continue;
    if (item.kind === 'areaVertex' && options.excludeAreaIds?.has(item.id)) continue;
    const metres = Math.hypot(item.x - c.x, item.y - c.y) / k;
    if (metres > toleranceMetres) continue;
    const position = fromMercator(item);
    out.push({
      kind: item.kind,
      position,
      distanceMetres: metres,
      snap: item.kind === 'node' ? { kind: 'node', nodeId: item.id } : undefined,
      label: item.kind === 'node' ? 'Junction' : 'Shape corner',
    });
  }

  // One road is many short edges; keep its nearest hit only, so the list names roads rather
  // than slivers of them.
  const bestRoad = new Map<string, SnapCandidate>();
  const bestKerb = new Map<string, SnapCandidate>();
  const bestAreaEdge = new Map<string, SnapCandidate>();

  for (const edge of index.edges.near(c.x, c.y, reach + 1)) {
    if (edge.kind === 'road' && options.excludeSegmentIds?.has(edge.id)) continue;
    if (edge.kind === 'area' && options.excludeAreaIds?.has(edge.id)) continue;

    const hit = pointToSegment(c.x, c.y, edge.a.x, edge.a.y, edge.b.x, edge.b.y);
    const metres = hit.distance / k;

    if (edge.kind === 'road') {
      if (allowed.includes('centreline') && metres <= toleranceMetres) {
        const position = fromMercator({ x: hit.x, y: hit.y });
        const previous = bestRoad.get(edge.id);
        if (!previous || metres < previous.distanceMetres) {
          const segment = index.doc.segments.find((s) => s.id === edge.id);
          const at = segment ? splitPointFor(segment, nodes, position) : null;
          bestRoad.set(edge.id, {
            kind: 'centreline',
            position,
            distanceMetres: metres,
            snap: at
              ? { kind: 'segment', segmentId: edge.id, shapeIndex: at.shapeIndex, position }
              : undefined,
            label: 'Road',
          });
        }
      }

      if (allowed.includes('edge') && edge.kerbs) {
        const dx = edge.b.x - edge.a.x;
        const dy = edge.b.y - edge.a.y;
        const len = Math.hypot(dx, dy);
        if (len > 1e-9) {
          // Right of travel in a plane with y north.
          const nx = dy / len;
          const ny = -dx / len;
          for (const offset of edge.kerbs) {
            const shift = offset * k;
            const kerb = pointToSegment(
              c.x,
              c.y,
              edge.a.x + nx * shift,
              edge.a.y + ny * shift,
              edge.b.x + nx * shift,
              edge.b.y + ny * shift,
            );
            const kerbMetres = kerb.distance / k;
            if (kerbMetres > toleranceMetres) continue;
            const key = `${edge.id}:${offset > 0 ? 'r' : 'l'}`;
            const previous = bestKerb.get(key);
            if (!previous || kerbMetres < previous.distanceMetres) {
              bestKerb.set(key, {
                kind: 'edge',
                position: fromMercator({ x: kerb.x, y: kerb.y }),
                distanceMetres: kerbMetres,
                label: 'Kerb',
              });
            }
          }
        }
      }
    } else if (allowed.includes('areaEdge') && metres <= toleranceMetres) {
      const previous = bestAreaEdge.get(edge.id);
      if (!previous || metres < previous.distanceMetres) {
        bestAreaEdge.set(edge.id, {
          kind: 'areaEdge',
          position: fromMercator({ x: hit.x, y: hit.y }),
          distanceMetres: metres,
          label: 'Shape edge',
        });
      }
    }
  }

  out.push(...bestRoad.values(), ...bestKerb.values(), ...bestAreaEdge.values());

  // Strongest kind first, then nearest. Stable on ties so cycling is repeatable.
  return out.sort(
    (a, b) =>
      allowed.indexOf(a.kind) - allowed.indexOf(b.kind) || a.distanceMetres - b.distanceMetres,
  );
}
