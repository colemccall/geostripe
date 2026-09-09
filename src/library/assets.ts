import { TEMPLATES, instantiateTemplate } from './templates';
import type { TemplateCategory, TemplateDef } from './templates';
import { LANDCOVER_ORDER, LANDCOVERS } from './landcover';
import type { Asset, AssetFamily, AreaAsset, LineAsset } from '../model/asset';

/**
 * The starting palette.
 *
 * Everything here is derived from the libraries that already existed — 157 cross-section
 * presets and 22 ground materials — rather than authored again. That is deliberate: the
 * overhaul changed how a road is modelled and drawn, not what a bus lane is, and throwing
 * away a catalogue of as-built widths to prove a point about architecture would have been
 * the expensive kind of clean slate.
 *
 * What changes is their status. A preset used to be a stamp: you picked one, it was copied
 * into the street, and the two had nothing to do with each other afterwards. An asset is
 * the road's type for as long as the road exists, so editing "Residential, two-way" moves
 * every residential street in the project. That is the difference the whole editor now
 * turns on, and it is why these are built once into a table the document owns rather than
 * read from the library on demand.
 */

/**
 * Which shelf of the palette a preset lands on.
 *
 * The preset library divides by what a section is FOR — a road diet, a bike facility, an
 * as-built measurement. The palette divides by what you are about to build, which is a
 * different question with a different answer: "road diet" is not a kind of road, it is an
 * argument about one. So the mapping is explicit rather than derived from the category
 * name, and the cases where the two disagree are exactly the interesting ones.
 */
const FAMILY_BY_CATEGORY: Record<TemplateCategory, Exclude<AssetFamily, 'area'>> = {
  saved: 'street',
  existing: 'arterial',
  diet: 'arterial',
  bike: 'street',
  transit: 'transit',
  path: 'path',
  downtown: 'street',
  residential: 'street',
  highway: 'highway',
  rural: 'arterial',
  special: 'street',
};

/**
 * The kerb radius each family turns at, in metres.
 *
 * A property of the road rather than of the corner, which is the change that let per-corner
 * radius customisation go. A freeway ramp turns at thirty metres and a lane in a
 * neighbourhood at four, wherever either of them happens to be, and a junction simply takes
 * the largest radius any road arriving at it asks for — which is the rule a real corner
 * obeys, since the corner has to accommodate the largest vehicle that uses it.
 */
const RADIUS_BY_FAMILY: Record<Exclude<AssetFamily, 'area'>, number> = {
  highway: 30,
  arterial: 9,
  street: 6,
  transit: 9,
  path: 2,
};

function assetFromTemplate(template: TemplateDef): LineAsset {
  const section = instantiateTemplate(template);
  const family = FAMILY_BY_CATEGORY[template.category];
  return {
    id: `builtin-${template.id}`,
    name: template.label,
    kind: 'line',
    family,
    components: section.components,
    anchorOffsetMeters: section.anchorOffsetMeters,
    cornerRadiusMeters: RADIUS_BY_FAMILY[family],
    builtIn: true,
  };
}

function assetFromMaterial(material: (typeof LANDCOVER_ORDER)[number]): AreaAsset {
  return {
    id: `builtin-area-${material}`,
    name: LANDCOVERS[material].label,
    kind: 'area',
    family: 'area',
    material,
    builtIn: true,
  };
}

/**
 * Build the palette the editor starts with.
 *
 * A function rather than a constant because the section inside each asset carries fresh
 * component ids, and two projects open in two tabs must not share them — component identity
 * is what the inspector selects on, and aliased ids across documents is the kind of bug that
 * only shows up when somebody has both open.
 */
export function builtInAssets(): Asset[] {
  const lines = TEMPLATES.filter((t) => t.category !== 'saved').map(assetFromTemplate);
  const areas = LANDCOVER_ORDER.map(assetFromMaterial);
  return [...lines, ...areas];
}

/**
 * The asset a fresh project draws with before anybody has chosen one.
 *
 * A two-way residential street: the most ordinary thing there is, and narrow enough that
 * the first road somebody lays down does not cover the block they were aiming at.
 */
export const DEFAULT_LINE_ASSET_ID = 'builtin-neighborhood';

export function defaultLineAssetId(assets: readonly Asset[]): string {
  const preferred = assets.find((a) => a.id === DEFAULT_LINE_ASSET_ID);
  if (preferred) return preferred.id;
  const fallback = assets.find((a) => a.kind === 'line');
  return fallback?.id ?? '';
}

export function defaultAreaAssetId(assets: readonly Asset[]): string {
  return assets.find((a) => a.kind === 'area')?.id ?? '';
}

/** Index a palette for lookup, which is how every consumer actually wants it. */
export function assetMap(assets: readonly Asset[]): Map<string, Asset> {
  return new Map(assets.map((asset) => [asset.id, asset]));
}
