/**
 * Land use: what the ground is for.
 *
 * Shaped like `landcover.ts` on purpose (an id, a label, a category, a colour, an opacity, a
 * note) so it reads the same and is drawn the same way. The difference is meaning: landcover
 * says what a surface IS (grass, asphalt); land use says what it is FOR (low-density
 * residential, light industrial). A zone carries one of these and nothing else; there are no
 * attributes to fill in.
 *
 * Colours are muted and drawn semi-transparent over imagery, in the family planners already
 * read: yellows for residential, reds and pinks for commercial, purples for industrial,
 * blues for civic, greens for open land.
 *
 * The list is data. Adding a class is adding an entry here; nothing else in the editor names
 * a land use.
 */

export const LAND_USE_IDS = [
  'residentialLow',
  'residentialMedium',
  'residentialHigh',
  'commercial',
  'office',
  'mixedUse',
  'industrialLight',
  'industrialHeavy',
  'institutional',
  'utilities',
  'parks',
  'natural',
  'agriculture',
  'vacant',
] as const;

export type LandUseId = (typeof LAND_USE_IDS)[number];

export type LandUseCategory = 'residential' | 'commercial' | 'industrial' | 'civic' | 'open';

export interface LandUse {
  readonly label: string;
  readonly category: LandUseCategory;
  readonly color: string;
  readonly opacity: number;
  readonly note: string;
}

export const LAND_USE_CATEGORIES: { id: LandUseCategory; label: string }[] = [
  { id: 'residential', label: 'Residential' },
  { id: 'commercial', label: 'Commercial' },
  { id: 'industrial', label: 'Industrial' },
  { id: 'civic', label: 'Civic' },
  { id: 'open', label: 'Open land' },
];

export const LAND_USES: Readonly<Record<LandUseId, LandUse>> = {
  residentialLow: {
    label: 'Low-density residential',
    category: 'residential',
    color: '#E8D26A',
    opacity: 0.55,
    note: 'Detached homes on their own lots.',
  },
  residentialMedium: {
    label: 'Medium-density residential',
    category: 'residential',
    color: '#E0A93B',
    opacity: 0.58,
    note: 'Townhouses, duplexes and small apartment buildings.',
  },
  residentialHigh: {
    label: 'High-density residential',
    category: 'residential',
    color: '#C9782B',
    opacity: 0.6,
    note: 'Apartment blocks and towers.',
  },
  commercial: {
    label: 'Retail and commercial',
    category: 'commercial',
    color: '#D9534F',
    opacity: 0.58,
    note: 'Shops, restaurants and services.',
  },
  office: {
    label: 'Office',
    category: 'commercial',
    color: '#B8456B',
    opacity: 0.58,
    note: 'Workplaces that are not shops.',
  },
  mixedUse: {
    label: 'Mixed use',
    category: 'commercial',
    color: '#D98A73',
    opacity: 0.58,
    note: 'Homes above or beside shops and offices.',
  },
  industrialLight: {
    label: 'Light industrial',
    category: 'industrial',
    color: '#9A7FC4',
    opacity: 0.58,
    note: 'Workshops, warehousing and clean manufacturing.',
  },
  industrialHeavy: {
    label: 'Heavy industrial',
    category: 'industrial',
    color: '#6F4FA3',
    opacity: 0.62,
    note: 'Manufacturing and processing with real impacts on neighbours.',
  },
  institutional: {
    label: 'Institutional',
    category: 'civic',
    color: '#4F83C9',
    opacity: 0.58,
    note: 'Schools, hospitals, government and places of worship.',
  },
  utilities: {
    label: 'Utilities and infrastructure',
    category: 'civic',
    color: '#7A8794',
    opacity: 0.6,
    note: 'Substations, treatment plants, rail yards.',
  },
  parks: {
    label: 'Parks and recreation',
    category: 'open',
    color: '#5FA55A',
    opacity: 0.6,
    note: 'Public green space, playgrounds and sports fields.',
  },
  natural: {
    label: 'Natural and conservation',
    category: 'open',
    color: '#2E7D5B',
    opacity: 0.6,
    note: 'Woodland, wetland and land kept as it is.',
  },
  agriculture: {
    label: 'Agriculture',
    category: 'open',
    color: '#B5B36A',
    opacity: 0.55,
    note: 'Farmland and orchards.',
  },
  vacant: {
    label: 'Vacant',
    category: 'open',
    color: '#B9B2A5',
    opacity: 0.5,
    note: 'Unused land with no assigned purpose.',
  },
};

export function isLandUseId(value: unknown): value is LandUseId {
  return typeof value === 'string' && (LAND_USE_IDS as readonly string[]).includes(value);
}
