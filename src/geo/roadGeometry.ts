import type { Feature, LineString, Point, Polygon } from 'geojson';
import { dedupe, localPlane, originFor } from './projection';
import type { LngLat, LocalPlane, PlanePoint } from './projection';
import { resolveCenterline } from './curve';
import { sliceLine, stationsAlong } from './grade';
import { bandsForStreet } from './banding';
import type { BandFeature } from './banding';
import { nodeEnvelope } from './network';
import type { NetworkNode, NodeEnvelope, NodeForm, SegmentEnd } from './network';
import { sectionExtent, travelwayWidth } from '../model/section';
import { endsAt, segmentControlPoints } from '../model/road';
import type { RoadNetworkDoc, RoadNode, RoadSegment } from '../model/road';
import type { CurvatureWarning } from './curvature';

/**
 * The whole design, built from nodes and segments.
 *
 * Nothing here cuts anything out of anything. That is the entire difference from what came
 * before, and it is not a performance note — it is why the geometry is right.
 *
 * The old pipeline drew each street as a long ribbon, worked out where the ribbons crossed,
 * built a junction shape, and subtracted it from every ribbon it touched. Every junction
 * was a polygon boolean against geometry hundreds of points long, which is slow; and the
 * shape being subtracted was a guess at what a junction looks like made from the outside,
 * which is why a fork came out as a hole.
 *
 * Here a road already knows where it stops. A segment runs between two nodes, each node
 * works out how far back the roads meeting it must stand to clear each other, and the
 * segment is drawn over what is left. The junction is the ground between the stopped ends.
 * Both come from the same numbers, so they meet exactly, and neither is subtracted from the
 * other.
 *
 * Planar metres in one shared plane throughout, as everywhere else.
 */

const EPS = 1e-9;

/** Leave at least this much road visible between two junctions that crowd each other. */
const MIN_VISIBLE_METRES = 2;

export interface SegmentLine {
  segmentId: string;
  /** The resolved centerline, node to node, before anything retreats. */
  line: LngLat[];
  planePts: PlanePoint[];
  stations: number[];
  lengthMeters: number;
  /** What is actually drawn, once both ends have stood back into their nodes. */
  fromStation: number;
  toStation: number;
}

export interface RoadGeometry {
  bands: BandFeature[];
  /** The paved ground each junction owns, built up from the ends that meet there. */
  nodeSurfaces: Feature<Polygon>[];
  /** One point per node, for selection and for showing what kind of place it is. */
  nodePoints: Feature<Point>[];
  /** The line you drag, for selected or all segments. */
  centerlines: Feature<LineString>[];
  segmentLines: Map<string, SegmentLine>;
  envelopes: Map<string, NodeEnvelope>;
  graphNodes: NetworkNode[];
  plane: LocalPlane;
  warnings: { segmentId: string; name: string; warnings: CurvatureWarning[] }[];
}

export interface RoadGeometryOptions {
  /** Draw every centerline, not only the selected one. */
  showAllCenterlines?: boolean;
  selectedSegmentId?: string | null;
  selectedNodeId?: string | null;
}

// ------------------------------------------------------------------------ resolving

/**
 * The line a segment is actually drawn along.
 *
 * Built from the two nodes plus the shape between them, so it is impossible for a segment
 * to disagree with a node about where it ends. Memoised by resolveCenterline on reference
 * identity — the control array is rebuilt whenever a node moves, which is exactly when the
 * line has to change.
 */
function resolveSegment(
  segment: RoadSegment,
  nodes: ReadonlyMap<string, RoadNode>,
  plane: LocalPlane,
): SegmentLine | null {
  const controls = segmentControlPoints(segment, nodes);
  if (!controls || controls.length < 2) return null;

  const line = dedupe(
    resolveCenterline({ id: segment.id, centerline: controls, curve: segment.curve }),
  );
  if (line.length < 2) return null;

  const planePts = line.map((p) => plane.toPlane(p));
  const stations = stationsAlong(line);
  const lengthMeters = stations[stations.length - 1]!;
  if (lengthMeters <= EPS) return null;

  return {
    segmentId: segment.id,
    line,
    planePts,
    stations,
    lengthMeters,
    fromStation: 0,
    toStation: lengthMeters,
  };
}

/**
 * How far along a road to look when asking which way it leaves a node.
 *
 * Not zero, which is the obvious answer and the wrong one. A tessellated line's first edge
 * is a metre or two long, so any discrepancy between where the node is and where the road's
 * own line starts — and there is always some, because a node shared by several roads sits
 * where they MEET rather than on any one of them — points that first edge sideways and the
 * bearing taken from it is meaningless.
 *
 * The I-75 fan showed exactly this: a braid of carriageways whose arms lie between 73 and
 * 91 degrees reported 37, 109, 215, 255 and 358, because each road's first step was a jog
 * from the shared node over to where that road really began. Read as a five-way crossing,
 * it got boxed — the failure the whole model exists to end.
 *
 * Looking a short way out makes the answer the road's actual direction. Short enough that a
 * road curving away from a junction still reports the direction it leaves in, which is what
 * the kerb corners are built from.
 */
const BEARING_PROBE_METRES = 15;

/** Unit tangent at a station, pointing toward increasing station. */
function tangentAt(resolved: SegmentLine, station: number): PlanePoint {
  const { planePts, stations } = resolved;
  let i = 0;
  for (; i < stations.length - 1; i++) if (station <= stations[i + 1]! + EPS) break;
  i = Math.min(i, planePts.length - 2);
  const a = planePts[i]!;
  const b = planePts[i + 1]!;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: dx / len, y: dy / len };
}

/** The point at a station, in the plane. */
function pointAtStation(resolved: SegmentLine, station: number): PlanePoint {
  const { planePts, stations } = resolved;
  let i = 0;
  for (; i < stations.length - 1; i++) if (station <= stations[i + 1]! + EPS) break;
  i = Math.min(i, planePts.length - 2);
  const a = planePts[i]!;
  const b = planePts[i + 1]!;
  const span = stations[i + 1]! - stations[i]!;
  const t = span <= EPS ? 0 : (station - stations[i]!) / span;
  return { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
}

/**
 * The end of a segment, as the node sees it.
 *
 * `sense` is +1 at the start of the road and -1 at its far end, because a node always looks
 * OUTWARD along whatever leaves it. The section's own left and right swap at the far end,
 * which is the bookkeeping that is easiest to get wrong and hardest to spot: every kerb
 * corner at half the junctions in a project would be built on the wrong side.
 */
function endFor(
  segment: RoadSegment,
  resolved: SegmentLine,
  which: 'from' | 'to',
  nodeId: string,
): SegmentEnd {
  const sense: 1 | -1 = which === 'from' ? 1 : -1;
  const station = which === 'from' ? 0 : resolved.lengthMeters;

  // The direction the road heads, measured a little way out rather than at the node itself.
  const probe = Math.min(BEARING_PROBE_METRES, resolved.lengthMeters / 3);
  const here = pointAtStation(resolved, station);
  const there = pointAtStation(resolved, which === 'from' ? probe : resolved.lengthMeters - probe);
  const away = { x: there.x - here.x, y: there.y - here.y };
  const span = Math.hypot(away.x, away.y);
  const tangent =
    span > 1e-6
      ? { x: away.x / span, y: away.y / span }
      : (() => {
          const t = tangentAt(resolved, station);
          return { x: t.x * sense, y: t.y * sense };
        })();

  const dx = tangent.x;
  const dy = tangent.y;
  const extent = sectionExtent(segment.section);

  return {
    segmentId: segment.id,
    nodeId,
    streetId: segment.id,
    stationMeters: station,
    sense,
    bearing: (Math.atan2(dy, dx) + Math.PI * 2) % (Math.PI * 2),
    halfLeft: sense === 1 ? extent.left : extent.right,
    halfRight: sense === 1 ? extent.right : extent.left,
    travelwayHalf: travelwayWidth(segment.section.components) / 2,
    lengthMeters: resolved.lengthMeters,
    level: segment.level ?? 0,
  };
}

// -------------------------------------------------------------------------- building

export function buildRoadGeometry(
  doc: RoadNetworkDoc,
  options: RoadGeometryOptions = {},
): RoadGeometry {
  const nodes = new Map(doc.nodes.map((node) => [node.id, node]));
  const visible = doc.segments.filter((segment) => segment.visible !== false);

  const points: LngLat[] = doc.nodes.map((node) => node.position);
  for (const segment of visible) points.push(...segment.shape);
  const plane = localPlane(originFor(points.length > 0 ? points : [[0, 0]]));

  const segmentLines = new Map<string, SegmentLine>();
  for (const segment of visible) {
    const resolved = resolveSegment(segment, nodes, plane);
    if (resolved) segmentLines.set(segment.id, resolved);
  }

  // Every node, with the ends that meet there sorted counter-clockwise from east — the
  // order the envelope walks, and the order corners sit between.
  const graphNodes: NetworkNode[] = [];
  for (const node of doc.nodes) {
    const ends: SegmentEnd[] = [];
    for (const { segment, end } of endsAt(node.id, visible)) {
      const resolved = segmentLines.get(segment.id);
      if (!resolved) continue;
      ends.push(endFor(segment, resolved, end, node.id));
    }
    ends.sort((a, b) => a.bearing - b.bearing);
    graphNodes.push({
      id: node.id,
      position: plane.toPlane(node.position),
      positionLngLat: node.position,
      ends,
    });
  }

  const envelopes = new Map<string, NodeEnvelope>();
  for (const graphNode of graphNodes) {
    const authored = nodes.get(graphNode.id);
    envelopes.set(graphNode.id, envelopeFor(graphNode, authored?.form));
  }

  relaxRetreats(doc, graphNodes, envelopes, segmentLines);

  // What is left of each road once both ends have stood back.
  for (const segment of visible) {
    const resolved = segmentLines.get(segment.id);
    if (!resolved) continue;
    resolved.fromStation = retreatAt(segment.fromNodeId, segment.id, graphNodes, envelopes);
    resolved.toStation =
      resolved.lengthMeters - retreatAt(segment.toNodeId, segment.id, graphNodes, envelopes);
  }

  const bands: BandFeature[] = [];
  const centerlines: Feature<LineString>[] = [];
  const warnings: RoadGeometry['warnings'] = [];

  for (const segment of visible) {
    const resolved = segmentLines.get(segment.id);
    if (!resolved) continue;

    const drawn =
      resolved.fromStation <= EPS && resolved.toStation >= resolved.lengthMeters - EPS
        ? resolved.line
        : sliceLine(resolved.line, resolved.fromStation, resolved.toStation);
    if (drawn.length >= 2) {
      const result = bandsForStreet(segment.id, drawn, segment.section);
      for (const band of result.bands) {
        bands.push({
          ...band,
          properties: { ...band.properties, level: segment.level ?? 0 },
        });
      }
      if (result.warnings.length > 0) {
        warnings.push({
          segmentId: segment.id,
          name: segment.name ?? 'Road',
          warnings: result.warnings,
        });
      }
    }

    if (options.showAllCenterlines || options.selectedSegmentId === segment.id) {
      centerlines.push({
        type: 'Feature',
        id: `${segment.id}:line`,
        properties: {
          segmentId: segment.id,
          selected: options.selectedSegmentId === segment.id,
        },
        geometry: { type: 'LineString', coordinates: resolved.line },
      });
    }
  }

  const nodeSurfaces: Feature<Polygon>[] = [];
  const nodePoints: Feature<Point>[] = [];

  for (const graphNode of graphNodes) {
    const envelope = envelopes.get(graphNode.id)!;
    if (envelope.form === 'junction' && envelope.surface.length >= 3) {
      const ring = envelope.surface.map((p) => plane.toLngLat(p) as [number, number]);
      ring.push(ring[0]!);
      nodeSurfaces.push({
        type: 'Feature',
        id: `${graphNode.id}:paved`,
        properties: { nodeId: graphNode.id, form: envelope.form },
        geometry: { type: 'Polygon', coordinates: [ring] },
      });
    }

    nodePoints.push({
      type: 'Feature',
      id: `${graphNode.id}:pt`,
      properties: {
        nodeId: graphNode.id,
        form: envelope.form,
        endCount: graphNode.ends.length,
        selected: options.selectedNodeId === graphNode.id,
      },
      geometry: { type: 'Point', coordinates: graphNode.positionLngLat },
    });
  }

  return {
    bands,
    nodeSurfaces,
    nodePoints,
    centerlines,
    segmentLines,
    envelopes,
    graphNodes,
    plane,
    warnings,
  };
}

/**
 * The envelope, honouring a form the user set by hand.
 *
 * Forcing `merge` is how you say "these roads run into each other, leave them alone" about
 * a junction the angles read as a crossing; forcing `junction` is how you say the opposite.
 * Both are things only a person can know — whether traffic yields or merges is not in the
 * geometry — so the override is applied by rebuilding the envelope under the forced form
 * rather than by patching the result, which would leave the retreats disagreeing with it.
 */
function envelopeFor(node: NetworkNode, form: RoadNode['form']): NodeEnvelope {
  const natural = nodeEnvelope(node);
  if (!form || form === natural.form) return natural;

  if (form === 'junction') {
    // Keep the corners and retreats the geometry worked out; just build the surface.
    return { ...natural, form: 'junction', surface: surfaceFrom(node, natural) };
  }
  // merge or continuation: the roads own the ground, so nothing retreats and nothing fills.
  return { ...natural, form: form as NodeForm, retreats: natural.retreats.map(() => 0), surface: [] };
}

function surfaceFrom(node: NetworkNode, envelope: NodeEnvelope): PlanePoint[] {
  const out: PlanePoint[] = [];
  for (let i = 0; i < node.ends.length; i++) {
    const end = node.ends[i]!;
    const ux = Math.cos(end.bearing);
    const uy = Math.sin(end.bearing);
    const nx = -uy;
    const ny = ux;
    const r = envelope.retreats[i] ?? 0;
    const bx = node.position.x + r * ux;
    const by = node.position.y + r * uy;
    out.push({ x: bx - end.halfRight * nx, y: by - end.halfRight * ny });
    out.push({ x: bx + end.halfLeft * nx, y: by + end.halfLeft * ny });
    const corner = envelope.corners.find((c) => c.fromEnd === i);
    if (corner?.point) out.push(corner.point);
  }
  return out;
}

function retreatAt(
  nodeId: string,
  segmentId: string,
  graphNodes: readonly NetworkNode[],
  envelopes: ReadonlyMap<string, NodeEnvelope>,
): number {
  const node = graphNodes.find((n) => n.id === nodeId);
  const envelope = envelopes.get(nodeId);
  if (!node || !envelope) return 0;
  const index = node.ends.findIndex((end) => end.segmentId === segmentId);
  return index < 0 ? 0 : (envelope.retreats[index] ?? 0);
}

/**
 * Stop two junctions eating the road between them.
 *
 * Each node works out its retreats from its own ends alone, which is right — it is the only
 * one that knows what meets there. But two nodes a short way apart can each demand more road
 * than lies between them. Neither is wrong, so neither wins: both give way in proportion and
 * a couple of metres of road stays visible. A cramped junction then looks cramped, which is
 * what it is, rather than leaving a hole where a road should be.
 *
 * One pass is exact rather than approximate: every retreat belongs to exactly one segment
 * end, so no clamp can disturb another.
 */
function relaxRetreats(
  doc: RoadNetworkDoc,
  graphNodes: readonly NetworkNode[],
  envelopes: Map<string, NodeEnvelope>,
  segmentLines: ReadonlyMap<string, SegmentLine>,
): void {
  const byId = new Map(graphNodes.map((node) => [node.id, node]));

  for (const segment of doc.segments) {
    const resolved = segmentLines.get(segment.id);
    if (!resolved) continue;

    const from = byId.get(segment.fromNodeId);
    const to = byId.get(segment.toNodeId);
    const fromEnvelope = envelopes.get(segment.fromNodeId);
    const toEnvelope = envelopes.get(segment.toNodeId);
    if (!from || !to || !fromEnvelope || !toEnvelope) continue;

    const fromIndex = from.ends.findIndex((end) => end.segmentId === segment.id);
    const toIndex = to.ends.findIndex((end) => end.segmentId === segment.id);
    if (fromIndex < 0 || toIndex < 0) continue;

    const wanted = (fromEnvelope.retreats[fromIndex] ?? 0) + (toEnvelope.retreats[toIndex] ?? 0);
    const room = resolved.lengthMeters - MIN_VISIBLE_METRES;
    if (wanted <= EPS || wanted <= room) continue;

    const scale = Math.max(0, room) / wanted;
    fromEnvelope.retreats[fromIndex] = (fromEnvelope.retreats[fromIndex] ?? 0) * scale;
    toEnvelope.retreats[toIndex] = (toEnvelope.retreats[toIndex] ?? 0) * scale;
  }

  // Surfaces are built from the retreats, so any that moved has to be rebuilt.
  for (const node of graphNodes) {
    const envelope = envelopes.get(node.id)!;
    if (envelope.form !== 'junction') continue;
    envelopes.set(node.id, { ...envelope, surface: surfaceFrom(node, envelope) });
  }
}
