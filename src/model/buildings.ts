import { localPlane } from '../geo/crs';
import type { LngLat } from '../geo/crs';
import { BUILDING_TYPES } from '../library/buildingTypes';
import type { Building } from './doc';

/**
 * Building footprints.
 *
 * A building is a type, a place and a heading; its polygon is derived here, in a metre plane
 * centred on the building, so a 12 m house is 12 m wide at any latitude.
 */

/** The four corners of a footprint, in longitude/latitude, starting front-left. */
export function footprint(building: Pick<Building, 'typeId' | 'position' | 'rotation'>): LngLat[] {
  const type = BUILDING_TYPES[building.typeId];
  const plane = localPlane(building.position);
  const theta = (building.rotation * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const hw = type.widthMetres / 2;
  const hd = type.depthMetres / 2;

  // Local frame: x across the front, y toward the back; rotation is clockwise from north.
  const corners: [number, number][] = [
    [-hw, -hd],
    [hw, -hd],
    [hw, hd],
    [-hw, hd],
  ];
  return corners.map(([x, y]) => plane.toLngLat({ x: x * cos + y * sin, y: -x * sin + y * cos }));
}

/** The bearing, in degrees clockwise from north, that makes a building face a road. */
export function bearingToFace(from: LngLat, towards: LngLat): number {
  const plane = localPlane(from);
  const p = plane.toPlane(towards);
  const degrees = (Math.atan2(p.x, p.y) * 180) / Math.PI;
  return (degrees + 360) % 360;
}

/** Round a heading to the nearest step, e.g. 15 degrees. */
export function snapRotation(degrees: number, step = 15): number {
  return (((Math.round(degrees / step) * step) % 360) + 360) % 360;
}
