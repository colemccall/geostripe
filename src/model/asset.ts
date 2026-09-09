import type { LandcoverType } from '../library/landcover';
import type { SectionComponent } from './types';
import { newId } from './types';

/**
 * An asset: the thing you pick up in the palette and lay down on the map.
 *
 * This is the unit the whole editor now turns on, and it is a deliberate borrowing from
 * road-building games. There, you do not draw a road and then describe it — you choose
 * "six-lane highway", and every six-lane highway in the city is that same asset. Change the
 * asset and they all change together.
 *
 * The editor used to work the other way round: every street carried its own deep copy of a
 * cross-section, so two roads that were meant to be the same road were only the same by
 * coincidence, and making them agree meant editing both. Widening a corridor by one lane
 * meant editing it once per block. That is backwards for a design tool, where the whole
 * argument is usually about a *type* of street rather than one instance of it.
 *
 * So a segment stores an asset id and nothing about its own width. The consequence worth
 * stating plainly: there is no per-road override, on purpose. If one block differs, it is a
 * different asset — and because assets are cheap to make and duplicate, that is a smaller
 * act than it sounds. It is also how a turn lane is expressed now: the last fifty metres
 * before an intersection is a different asset, laid on a short segment, exactly the way it
 * is a different piece of road in the real world.
 */

/**
 * What an asset is for.
 *
 * Drives the palette's top level and nothing else — no geometry reads this. It exists
 * because a palette holding highways, streets, trails and parks in one flat list is
 * unusable, and because "which of these are roads" is a question the UI asks constantly.
 */
export const ASSET_FAMILIES = [
  'highway',
  'arterial',
  'street',
  'path',
  'transit',
  'area',
] as const;

export type AssetFamily = (typeof ASSET_FAMILIES)[number];

export const ASSET_FAMILY_LABELS: Record<AssetFamily, string> = {
  highway: 'Highways',
  arterial: 'Arterials',
  street: 'Streets',
  path: 'Paths & trails',
  transit: 'Transit',
  area: 'Parks & ground',
};

/**
 * An asset laid along a line: everything from a freeway to a footpath.
 *
 * One type covers all of them because the difference between a freeway and a footpath is
 * the contents of `components`, not the kind of thing it is. A path is a line asset whose
 * stack happens to contain no carriageway, which is why paths need no special case anywhere
 * downstream — they are drawn, snapped, split and joined by the same code.
 */
export interface LineAsset {
  id: string;
  name: string;
  kind: 'line';
  family: Exclude<AssetFamily, 'area'>;
  /** The cross-section, left to right, looking along the direction it was drawn. */
  components: SectionComponent[];
  /**
   * Distance from the stack's LEFT EDGE to the line you actually draw.
   *
   * `null` derives it — the middle of the travelway, which is the line visible on imagery.
   * A number pins it, which is what re-anchoring writes. One number expresses
   * travelway-centre, geometric-centre and left-edge anchoring alike.
   */
  anchorOffsetMeters: number | null;
  /**
   * Kerb radius this asset wants where it meets others, in metres.
   *
   * On the asset rather than on each corner because it is a property of the road — a
   * freeway ramp turns at a bigger radius than a lane in a neighbourhood, wherever either
   * of them happens to be. A node takes the largest radius any road arriving at it asks
   * for, which is the same rule a real corner obeys.
   */
  cornerRadiusMeters?: number;
  /** Shipped with the app. User assets are editable and deletable; these are duplicated. */
  builtIn?: boolean;
}

/**
 * An asset laid as a shape: parks, plazas, water, the ground under everything.
 *
 * Kept as its own type rather than folded into LineAsset because it genuinely has no
 * cross-section. Forcing a pond through a band stack would mean inventing a centerline for
 * it, and there is no honest one to invent.
 */
export interface AreaAsset {
  id: string;
  name: string;
  kind: 'area';
  family: 'area';
  material: LandcoverType;
  builtIn?: boolean;
}

export type Asset = LineAsset | AreaAsset;

export const isLineAsset = (asset: Asset): asset is LineAsset => asset.kind === 'line';
export const isAreaAsset = (asset: Asset): asset is AreaAsset => asset.kind === 'area';

export const newAssetId = (): string => newId('a');

/** A copy under a new id and name, which is how you make a variant of a built-in. */
export function duplicateAsset(asset: Asset, name?: string): Asset {
  const base = { ...asset, id: newAssetId(), name: name ?? `${asset.name} copy`, builtIn: false };
  return asset.kind === 'line'
    ? { ...(base as LineAsset), components: asset.components.map((c) => ({ ...c, id: newId('c') })) }
    : (base as AreaAsset);
}
