import { localPlane, originFor } from '../geo/crs';
import type { LngLat, LocalPlane } from '../geo/crs';
import { area, capsule, circle, difference, toPolygons, union } from '../geo/region';
import type { Region, Ring } from '../geo/region';
import type { LandUseId } from '../library/landuse';
import { newZoneId } from './doc';
import type { Doc, Zone } from './doc';

/**
 * Painting land use.
 *
 * Every operation here is the same move: take the region a stroke covers, merge it into the
 * zones of its own land use, and cut it out of the zones of every other. Zones therefore
 * never overlap, a use that is painted twice stays one shape, and painting over a different
 * use replaces it, which is how a brush in a game behaves.
 *
 * The geometry is done in a metre plane centred on the stroke (geo/crs.ts), and only zones
 * whose bounds meet the stroke are converted at all, so painting stays cheap however much
 * else is zoned and nothing far away is disturbed by the round trip through the plane.
 */

interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

const boundsOf = (region: Region): Bounds => {
  const b = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
  for (const ring of region) {
    for (const p of ring) {
      b.minX = Math.min(b.minX, p.x);
      b.minY = Math.min(b.minY, p.y);
      b.maxX = Math.max(b.maxX, p.x);
      b.maxY = Math.max(b.maxY, p.y);
    }
  }
  return b;
};

const overlaps = (a: Bounds, b: Bounds) =>
  a.minX <= b.maxX && a.maxX >= b.minX && a.minY <= b.maxY && a.maxY >= b.minY;

const zoneRegion = (zone: Zone, plane: LocalPlane): Region =>
  zone.rings.map((ring) => ring.map((p) => plane.toPlane(p)));

/** Rings of a polygon as a plane region back into zone rings, closed implicitly. */
const toRings = (polygon: Ring[], plane: LocalPlane): LngLat[][] =>
  polygon.map((ring) => ring.map((p) => plane.toLngLat(p)));

/** The region covered by a brush dragged through these points, `radius` metres either side. */
export function strokeRegion(points: readonly LngLat[], radiusMetres: number, plane: LocalPlane): Region {
  const planar = points.map((p) => plane.toPlane(p));
  if (planar.length === 0) return [];
  if (planar.length === 1) return [circle(planar[0]!, radiusMetres)];
  let region: Region = [];
  for (let i = 0; i < planar.length - 1; i++) {
    region = union(region, [capsule(planar[i]!, planar[i + 1]!, radiusMetres)]);
  }
  return region;
}

/** The region covered by a closed outline drawn point by point. */
export function outlineRegion(ring: readonly LngLat[], plane: LocalPlane): Region {
  return ring.length >= 3 ? [ring.map((p) => plane.toPlane(p))] : [];
}

/** A plane for working near these points. */
export function planeFor(points: readonly LngLat[]): LocalPlane {
  return localPlane(originFor(points));
}

/**
 * Paint a region with a land use.
 *
 * `shape` is the region in `plane`. Returns the document with every affected zone replaced;
 * zones the shape does not touch are the same objects as before.
 */
export function paintRegion(doc: Doc, landUse: LandUseId, shape: Region, plane: LocalPlane): Doc {
  if (shape.length === 0) return doc;
  const reach = boundsOf(shape);

  const touched: { zone: Zone; region: Region }[] = [];
  const untouched: Zone[] = [];
  for (const zone of doc.zones) {
    const region = zoneRegion(zone, plane);
    if (region.length > 0 && overlaps(boundsOf(region), reach)) touched.push({ zone, region });
    else untouched.push(zone);
  }

  const next: Zone[] = [...untouched];

  // Same use: merge the stroke into every zone it touches, producing one shape where they
  // join. The first zone's id is kept so a shape does not change identity every stroke.
  const same = touched.filter((t) => t.zone.landUse === landUse);
  let merged: Region = shape;
  for (const t of same) merged = union(merged, t.region);
  const keepId = same[0]?.zone.id;
  toPolygons(merged).forEach((polygon, i) => {
    next.push({
      id: i === 0 && keepId ? keepId : newZoneId(),
      landUse,
      rings: toRings(polygon, plane),
      visible: true,
    });
  });

  // Other uses: cut the stroke out of them. A zone split in two becomes two zones.
  for (const t of touched.filter((x) => x.zone.landUse !== landUse)) {
    const remaining = difference(t.region, shape);
    toPolygons(remaining).forEach((polygon, i) => {
      next.push({
        id: i === 0 ? t.zone.id : newZoneId(),
        landUse: t.zone.landUse,
        rings: toRings(polygon, plane),
        visible: t.zone.visible,
      });
    });
  }

  return { ...doc, zones: next };
}

/** Remove land use under a region, whatever it is, or only one use when given. */
export function eraseRegion(doc: Doc, shape: Region, plane: LocalPlane, only?: LandUseId): Doc {
  if (shape.length === 0) return doc;
  const reach = boundsOf(shape);
  const next: Zone[] = [];

  for (const zone of doc.zones) {
    const region = zoneRegion(zone, plane);
    if ((only && zone.landUse !== only) || region.length === 0 || !overlaps(boundsOf(region), reach)) {
      next.push(zone);
      continue;
    }
    toPolygons(difference(region, shape)).forEach((polygon, i) => {
      next.push({
        id: i === 0 ? zone.id : newZoneId(),
        landUse: zone.landUse,
        rings: toRings(polygon, plane),
        visible: zone.visible,
      });
    });
  }

  return { ...doc, zones: next };
}

/** Paint a brush stroke. */
export function paintStroke(
  doc: Doc,
  landUse: LandUseId,
  points: readonly LngLat[],
  radiusMetres: number,
): Doc {
  if (points.length === 0) return doc;
  const plane = planeFor(points);
  return paintRegion(doc, landUse, strokeRegion(points, radiusMetres, plane), plane);
}

/** Erase with a brush stroke. */
export function eraseStroke(
  doc: Doc,
  points: readonly LngLat[],
  radiusMetres: number,
  only?: LandUseId,
): Doc {
  if (points.length === 0) return doc;
  const plane = planeFor(points);
  return eraseRegion(doc, strokeRegion(points, radiusMetres, plane), plane, only);
}

/** Paint a closed outline. */
export function paintOutline(doc: Doc, landUse: LandUseId, ring: readonly LngLat[]): Doc {
  if (ring.length < 3) return doc;
  const plane = planeFor(ring);
  return paintRegion(doc, landUse, outlineRegion(ring, plane), plane);
}

/**
 * Area of a zone in square metres on the ground.
 *
 * Measured in a plane centred on the zone itself, so the Mercator stretch at its own
 * latitude is divided out; see geo/crs.ts.
 */
export function zoneAreaSquareMetres(zone: Zone): number {
  const all = zone.rings.flat();
  if (all.length === 0) return 0;
  const plane = localPlane(originFor(all));
  return area(zone.rings.map((ring) => ring.map((p) => plane.toPlane(p))));
}

/**
 * Fill the blocks between roads with a land use is a later step; what this offers now is the
 * smaller question it rests on: the ground a zone covers, as polygons, for the map.
 */
export function zonePolygons(zones: readonly Zone[]): { zone: Zone; rings: LngLat[][] }[] {
  return zones.filter((z) => z.visible).map((zone) => ({ zone, rings: zone.rings }));
}
