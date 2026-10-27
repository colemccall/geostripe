import { localPlane, originFor } from '../geo/crs';
import type { LngLat, LocalPlane } from '../geo/crs';
import { area, difference, intersection, toPolygons, union } from '../geo/region';
import type { Region } from '../geo/region';
import { newDistrictId } from './doc';
import type { District, Doc } from './doc';
import { strokeRegion, outlineRegion } from './zones';

/**
 * Planning districts: named, coloured areas, and nothing else.
 *
 * They are painted with the same brush and outline tools as land use and follow the same
 * rule: a district is one shape, painting into it grows it, and painting a different district
 * over it takes the ground (districts do not overlap). There are no policies; a district
 * exists to be looked at and to be added up.
 */

const DISTRICT_COLORS = ['#4DA3FF', '#F2994A', '#6FCF97', '#BB6BD9', '#EB5757', '#2D9CDB', '#F2C94C', '#56CCF2'];

export function nextDistrictColor(existing: readonly District[]): string {
  return DISTRICT_COLORS[existing.length % DISTRICT_COLORS.length]!;
}

export function addDistrict(doc: Doc, name?: string): { doc: Doc; districtId: string } {
  const id = newDistrictId();
  const district: District = {
    id,
    name: name?.trim() || `District ${doc.districts.length + 1}`,
    color: nextDistrictColor(doc.districts),
    rings: [],
    visible: true,
  };
  return { doc: { ...doc, districts: [...doc.districts, district] }, districtId: id };
}

const region = (d: District, plane: LocalPlane): Region => d.rings.map((r) => r.map((p) => plane.toPlane(p)));
const rings = (polygon: Region, plane: LocalPlane): LngLat[][] => polygon.map((r) => r.map((p) => plane.toLngLat(p)));

/** Paint a region into a district, taking it from the others. */
export function paintDistrictRegion(doc: Doc, districtId: string, shape: Region, plane: LocalPlane): Doc {
  const target = doc.districts.find((d) => d.id === districtId);
  if (!target || shape.length === 0) return doc;

  const districts = doc.districts.map((d) => {
    if (d.id === districtId) {
      const merged = union(region(d, plane), shape);
      // A district is one shape; if painting leaves several islands they are kept together
      // as one multi-polygon by storing every ring and relying on even-odd.
      return { ...d, rings: rings(merged, plane) };
    }
    if (d.rings.length === 0) return d;
    const remaining = difference(region(d, plane), shape);
    return { ...d, rings: rings(remaining, plane) };
  });
  return { ...doc, districts };
}

export function eraseDistrictRegion(doc: Doc, shape: Region, plane: LocalPlane, only?: string): Doc {
  if (shape.length === 0) return doc;
  return {
    ...doc,
    districts: doc.districts.map((d) =>
      d.rings.length === 0 || (only && d.id !== only)
        ? d
        : { ...d, rings: rings(difference(region(d, plane), shape), plane) },
    ),
  };
}

export function paintDistrictStroke(doc: Doc, districtId: string, points: readonly LngLat[], radius: number): Doc {
  if (points.length === 0) return doc;
  const plane = localPlane(originFor(points));
  return paintDistrictRegion(doc, districtId, strokeRegion(points, radius, plane), plane);
}

export function paintDistrictOutline(doc: Doc, districtId: string, ring: readonly LngLat[]): Doc {
  if (ring.length < 3) return doc;
  const plane = localPlane(originFor(ring));
  return paintDistrictRegion(doc, districtId, outlineRegion(ring, plane), plane);
}

export function eraseDistrictStroke(doc: Doc, points: readonly LngLat[], radius: number, only?: string): Doc {
  if (points.length === 0) return doc;
  const plane = localPlane(originFor(points));
  return eraseDistrictRegion(doc, strokeRegion(points, radius, plane), plane, only);
}

/** The polygons of a district, as separate outer-plus-holes shapes, for drawing. */
export function districtPolygons(district: District): LngLat[][][] {
  if (district.rings.length === 0) return [];
  const all = district.rings.flat();
  const plane = localPlane(originFor(all));
  return toPolygons(region(district, plane)).map((polygon) => rings(polygon, plane));
}

/** Square metres of a district, and how much of it each land use covers. */
export function districtBreakdown(
  doc: Doc,
  district: District,
): { total: number; byLandUse: Record<string, number> } {
  if (district.rings.length === 0) return { total: 0, byLandUse: {} };
  const plane = localPlane(originFor(district.rings.flat()));
  const shape = region(district, plane);
  const byLandUse: Record<string, number> = {};
  for (const zone of doc.zones) {
    if (!zone.visible) continue;
    const covered = area(intersection(zone.rings.map((r) => r.map((p) => plane.toPlane(p))), shape));
    if (covered > 0.01) byLandUse[zone.landUse] = (byLandUse[zone.landUse] ?? 0) + covered;
  }
  return { total: area(shape), byLandUse };
}
