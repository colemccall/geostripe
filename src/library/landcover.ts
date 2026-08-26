/**
 * The land cover palette.
 *
 * Streets are bands along a line; this is everything that is not. An area exists to put a
 * designed surface over the imagery — the park that replaces a parking lot, the plaza that
 * replaces a slip lane — so the colours are chosen to read as *materials* at map scale over
 * a satellite photo, not as a chart legend.
 *
 * Categorised from the start. This list is small enough to scroll today and will not be
 * once the full asset library lands, and retrofitting categories onto a flat list means
 * touching every entry twice.
 */

export const LANDCOVER_TYPES = [
  'grass',
  'meadow',
  'park',
  'treeCanopy',
  'planting',
  'hedge',
  'farmland',
  'water',
  'wetland',
  'sand',
  'gravel',
  'dirt',
  'concrete',
  'asphalt',
  'pavers',
  'plaza',
  'playground',
  'sportsField',
  'parkingLot',
  'building',
  'roof',
  'railway',
] as const;

export type LandcoverType = (typeof LANDCOVER_TYPES)[number];

export type LandcoverCategory = 'green' | 'water' | 'hard' | 'built';

export interface Landcover {
  readonly label: string;
  readonly category: LandcoverCategory;
  readonly color: string;
  /** Drawn over imagery, so nothing is fully opaque unless it genuinely occludes. */
  readonly opacity: number;
  readonly note: string;
}

export const LANDCOVER_CATEGORIES: { id: LandcoverCategory; label: string }[] = [
  { id: 'green', label: 'Green' },
  { id: 'water', label: 'Water' },
  { id: 'hard', label: 'Hard surface' },
  { id: 'built', label: 'Built' },
];

export const LANDCOVERS: Readonly<Record<LandcoverType, Landcover>> = {
  grass: {
    label: 'Grass',
    category: 'green',
    color: '#6E8F4E',
    opacity: 0.82,
    note: 'Mown lawn. The default answer to "what replaces this asphalt".',
  },
  meadow: {
    label: 'Meadow',
    category: 'green',
    color: '#8AA05A',
    opacity: 0.8,
    note: 'Unmown grass and wildflower. Cheaper to maintain than lawn and better for drainage.',
  },
  park: {
    label: 'Park',
    category: 'green',
    color: '#5C8248',
    opacity: 0.85,
    note: 'Managed open space — lawn, paths and planting read together at this scale.',
  },
  treeCanopy: {
    label: 'Tree canopy',
    category: 'green',
    color: '#3F6B3A',
    opacity: 0.72,
    note: 'Drawn semi-transparent because canopy sits above whatever it shades.',
  },
  planting: {
    label: 'Planting bed',
    category: 'green',
    color: '#7A8C4E',
    opacity: 0.85,
    note: 'Shrubs and perennials. Often what a bulb-out is actually filled with.',
  },
  hedge: {
    label: 'Hedge',
    category: 'green',
    color: '#4E6B3F',
    opacity: 0.88,
    note: 'A dense edge — useful as a buffer between a footway and a carriageway.',
  },
  farmland: {
    label: 'Farmland',
    category: 'green',
    color: '#9C8A52',
    opacity: 0.8,
    note: 'Cultivated ground, for edge-of-town and rural sections.',
  },
  water: {
    label: 'Water',
    category: 'water',
    color: '#3E6E8E',
    opacity: 0.85,
    note: 'River, lake or basin.',
  },
  wetland: {
    label: 'Wetland',
    category: 'water',
    color: '#5B7A6B',
    opacity: 0.8,
    note: 'Marsh, rain garden or retention basin — drainage that is also landscape.',
  },
  sand: {
    label: 'Sand',
    category: 'hard',
    color: '#C9B98A',
    opacity: 0.85,
    note: 'Beach, or the surface under play equipment.',
  },
  gravel: {
    label: 'Gravel',
    category: 'hard',
    color: '#9A948A',
    opacity: 0.85,
    note: 'Loose surface. Permeable, cheap, and not accessible on its own.',
  },
  dirt: {
    label: 'Bare ground',
    category: 'hard',
    color: '#8B7355',
    opacity: 0.85,
    note: 'Unmade ground or a desire path worn through grass.',
  },
  concrete: {
    label: 'Concrete',
    category: 'hard',
    color: '#9A9A94',
    opacity: 0.85,
    note: 'Standard footway paving.',
  },
  asphalt: {
    label: 'Asphalt',
    category: 'hard',
    color: '#55595C',
    opacity: 0.85,
    note: 'Blacktop. Matches the carriageway colour, for areas that are genuinely roadway.',
  },
  pavers: {
    label: 'Pavers',
    category: 'hard',
    color: '#A08878',
    opacity: 0.85,
    note: 'Unit paving or setts. Slows traffic where it is used on the carriageway.',
  },
  plaza: {
    label: 'Plaza',
    category: 'hard',
    color: '#ADA79C',
    opacity: 0.85,
    note: 'Pedestrian space with no through route — a reclaimed slip lane, usually.',
  },
  playground: {
    label: 'Playground',
    category: 'hard',
    color: '#B5744F',
    opacity: 0.85,
    note: 'Poured safety surfacing.',
  },
  sportsField: {
    label: 'Sports field',
    category: 'hard',
    color: '#4E8C56',
    opacity: 0.85,
    note: 'Pitch or court, natural or synthetic.',
  },
  parkingLot: {
    label: 'Parking lot',
    category: 'built',
    color: '#63676A',
    opacity: 0.85,
    note: 'Off-street parking. Usually the "before" in a redesign rather than the after.',
  },
  building: {
    label: 'Building',
    category: 'built',
    color: '#7A6E68',
    opacity: 0.9,
    note: 'Footprint. Nearly opaque because a building genuinely occludes the ground.',
  },
  roof: {
    label: 'Canopy or roof',
    category: 'built',
    color: '#6B5F59',
    opacity: 0.75,
    note: 'A shelter, awning or station canopy — cover without a full building beneath it.',
  },
  railway: {
    label: 'Railway',
    category: 'built',
    color: '#6B6560',
    opacity: 0.85,
    note: 'Track bed and ballast, for rail alignments and tram reservations.',
  },
};

export const LANDCOVER_ORDER: readonly LandcoverType[] = LANDCOVER_TYPES;

export function isLandcoverType(value: unknown): value is LandcoverType {
  return typeof value === 'string' && (LANDCOVER_TYPES as readonly string[]).includes(value);
}

export function landcover(type: LandcoverType): Landcover {
  return LANDCOVERS[type];
}

/**
 * The materials as a tree, so the land-cover browser matches the lane one.
 *
 * Twenty-two entries in four categories does not need a third level, so each category is
 * one group. The shape still matches the other libraries, which is what lets all three
 * share one navigation component instead of three that drift apart.
 */
export function landcoverTree(
  types: readonly LandcoverType[] = LANDCOVER_ORDER,
): { category: LandcoverCategory; label: string; groups: { label: string; items: LandcoverType[] }[] }[] {
  return LANDCOVER_CATEGORIES.map((category) => ({
    category: category.id,
    label: category.label,
    groups: [
      { label: category.label, items: types.filter((type) => LANDCOVERS[type].category === category.id) },
    ],
  })).filter((entry) => entry.groups[0]!.items.length > 0);
}

/** Case-insensitive match on label, category or note. */
export function searchLandcover(query: string): LandcoverType[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...LANDCOVER_ORDER];
  return LANDCOVER_ORDER.filter((type) => {
    const entry = LANDCOVERS[type];
    return (
      entry.label.toLowerCase().includes(q) ||
      entry.category.toLowerCase().includes(q) ||
      entry.note.toLowerCase().includes(q)
    );
  });
}
