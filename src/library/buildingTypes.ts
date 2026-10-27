/**
 * Building footprints you can place.
 *
 * A type is a name, a footprint size and a colour. There are no attributes (floors, use,
 * height) on purpose: a building here is a footprint on the ground, two-dimensional, and the
 * land use under it says what it is for. An instance in the document is a type, a position
 * and a rotation; the polygon is derived from those, so resizing a type resizes every
 * building of it, the same way widening an asset widens every road.
 */

export const BUILDING_TYPE_IDS = [
  'house',
  'rowhouse',
  'apartment',
  'shop',
  'office',
  'warehouse',
  'civic',
  'garage',
] as const;

export type BuildingTypeId = (typeof BUILDING_TYPE_IDS)[number];

export interface BuildingType {
  readonly label: string;
  /** Footprint across the front, in metres. */
  readonly widthMetres: number;
  /** Footprint front to back, in metres. */
  readonly depthMetres: number;
  readonly color: string;
}

export const BUILDING_TYPES: Readonly<Record<BuildingTypeId, BuildingType>> = {
  house: { label: 'House', widthMetres: 12, depthMetres: 10, color: '#C9A27E' },
  rowhouse: { label: 'Row house', widthMetres: 6, depthMetres: 14, color: '#B98B6A' },
  apartment: { label: 'Apartment block', widthMetres: 40, depthMetres: 22, color: '#A9776A' },
  shop: { label: 'Shop', widthMetres: 10, depthMetres: 20, color: '#CF7F7A' },
  office: { label: 'Office', widthMetres: 45, depthMetres: 30, color: '#9C6B8A' },
  warehouse: { label: 'Warehouse', widthMetres: 80, depthMetres: 50, color: '#8C7FB0' },
  civic: { label: 'Civic building', widthMetres: 35, depthMetres: 25, color: '#6F93C4' },
  garage: { label: 'Garage', widthMetres: 6, depthMetres: 6, color: '#A59F95' },
};

export function isBuildingTypeId(value: unknown): value is BuildingTypeId {
  return typeof value === 'string' && (BUILDING_TYPE_IDS as readonly string[]).includes(value);
}
