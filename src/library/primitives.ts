/**
 * The lane primitive library.
 *
 * Every default width here is a *starting value*, editable per instance, never a
 * constraint. Figures are drawn from NACTO's Urban Street Design Guide and the 2025
 * third edition of the Urban Bikeway Design Guide; `note` records the provenance so a
 * number is never anonymous. None of this is a substitute for engineering judgement,
 * and local standards override all of it.
 *
 * Two flags carry real meaning and are easy to conflate:
 *
 *   isRoadway  the component sits inside the curb-to-curb travelway. Drives the anchor
 *              calculation — the drawn centerline defaults to the middle of the
 *              travelway, which is the line you can actually see on satellite imagery.
 *              A raised median IS inside the curbs; a sidewalk is not.
 *   isRaised   the component is drawn above grade in the cross-section elevation.
 *              Purely visual. Sidewalks and medians are both raised.
 */

export const COMPONENT_TYPES = [
  'travelLane',
  'turnLane',
  'busLane',
  'bikeLaneConventional',
  'bikeLaneBuffered',
  'bikeLaneProtected',
  'parkingLaneParallel',
  'parkingLaneAngled',
  'median',
  'shoulder',
  'sidewalk',
] as const;

export type ComponentType = (typeof COMPONENT_TYPES)[number];

/**
 * Travel direction relative to the order the centerline was drawn — never a compass
 * bearing. "Northbound" is meaningless on a street that curves, and inverts if the user
 * happens to draw the centerline the other way. A display bearing is derived from the
 * geometry when one is needed.
 */
export const DIRECTIONS = ['forward', 'backward', 'both', 'none'] as const;
export type Direction = (typeof DIRECTIONS)[number];

/** Glyph drawn on the band in the cross-section elevation. */
export type Marking = 'none' | 'lane' | 'turn' | 'bus' | 'bike' | 'parking' | 'walk' | 'planting';

export interface Primitive {
  readonly label: string;
  readonly defaultWidthMeters: number;
  readonly minWidthMeters: number;
  readonly color: string;
  readonly isRoadway: boolean;
  readonly isRaised: boolean;
  readonly marking: Marking;
  readonly defaultDirection: Direction;
  readonly note: string;
}

export const PRIMITIVES: Readonly<Record<ComponentType, Primitive>> = {
  travelLane: {
    label: 'Travel lane',
    defaultWidthMeters: 3.0,
    minWidthMeters: 2.7,
    color: '#4A5157',
    isRoadway: true,
    isRaised: false,
    marking: 'lane',
    defaultDirection: 'forward',
    note: 'NACTO recommends 10 ft (3.0 m) in most urban contexts; up to 11 ft on transit or freight routes.',
  },
  turnLane: {
    label: 'Center turn lane',
    defaultWidthMeters: 3.0,
    minWidthMeters: 2.7,
    color: '#525A61',
    isRoadway: true,
    isRaised: false,
    marking: 'turn',
    defaultDirection: 'both',
    note: 'Two-way left-turn lane or dedicated turn pocket, typically 10–11 ft (3.0–3.35 m).',
  },
  busLane: {
    label: 'Bus lane',
    defaultWidthMeters: 3.35,
    minWidthMeters: 3.0,
    color: '#7A4636',
    isRoadway: true,
    isRaised: false,
    marking: 'bus',
    defaultDirection: 'forward',
    note: 'Wider than a general travel lane to accommodate bus width and mirrors — 11 ft (3.35 m).',
  },
  bikeLaneConventional: {
    label: 'Bike lane',
    defaultWidthMeters: 1.8,
    minWidthMeters: 1.2,
    color: '#2C6B4E',
    isRoadway: true,
    isRaised: false,
    marking: 'bike',
    defaultDirection: 'forward',
    note: 'NACTO preferred minimum bikeway width 6 ft (1.8 m); absolute minimum 4 ft (1.2 m).',
  },
  bikeLaneBuffered: {
    label: 'Buffered bike lane',
    defaultWidthMeters: 2.4,
    minWidthMeters: 1.8,
    color: '#2F7050',
    isRoadway: true,
    isRaised: false,
    marking: 'bike',
    defaultDirection: 'forward',
    note: 'Rideable width plus a painted buffer. Model the buffer as its own component when it matters.',
  },
  bikeLaneProtected: {
    label: 'Protected bike lane',
    defaultWidthMeters: 2.7,
    minWidthMeters: 2.0,
    color: '#2A7A57',
    isRoadway: true,
    isRaised: false,
    marking: 'bike',
    defaultDirection: 'forward',
    note: 'NACTO 3rd ed. gives 6.5–7 ft (2.0–2.1 m) minimum *rideable* width, 8–12.5 ft preferred — separation and buffer are additional.',
  },
  parkingLaneParallel: {
    label: 'Parallel parking',
    defaultWidthMeters: 2.4,
    minWidthMeters: 2.1,
    color: '#585F65',
    isRoadway: true,
    isRaised: false,
    marking: 'parking',
    defaultDirection: 'none',
    note: 'NACTO prefers a minimised 7 ft (2.1 m) width; up to 9 ft (2.7 m).',
  },
  parkingLaneAngled: {
    label: 'Angled parking',
    defaultWidthMeters: 5.2,
    minWidthMeters: 4.3,
    color: '#5C636A',
    isRoadway: true,
    isRaised: false,
    marking: 'parking',
    defaultDirection: 'none',
    note: 'Depth varies sharply by angle (45°/60°/90°) — verify against the local standard before relying on it.',
  },
  median: {
    label: 'Planted median',
    defaultWidthMeters: 1.8,
    minWidthMeters: 0.6,
    color: '#4B6B42',
    isRoadway: true,
    isRaised: true,
    marking: 'planting',
    defaultDirection: 'none',
    note: 'No standard default — highly context-dependent. Sits inside the curb-to-curb width.',
  },
  shoulder: {
    label: 'Shoulder',
    defaultWidthMeters: 1.2,
    minWidthMeters: 0.6,
    color: '#646B70',
    isRoadway: true,
    isRaised: false,
    marking: 'none',
    defaultDirection: 'none',
    note: 'Minimal urban shoulder, 4 ft (1.2 m).',
  },
  sidewalk: {
    label: 'Sidewalk',
    defaultWidthMeters: 1.8,
    minWidthMeters: 1.5,
    color: '#A6ADA6',
    isRoadway: false,
    isRaised: true,
    marking: 'walk',
    defaultDirection: 'none',
    note: 'ADA minimum clear width 5 ft (1.5 m); NACTO through-zone 8–12 ft in commercial areas.',
  },
};

/** Display order in the primitive palette — grouped by role, not alphabetical. */
export const PRIMITIVE_ORDER: readonly ComponentType[] = COMPONENT_TYPES;

export function isComponentType(value: unknown): value is ComponentType {
  return typeof value === 'string' && (COMPONENT_TYPES as readonly string[]).includes(value);
}

export function primitive(type: ComponentType): Primitive {
  return PRIMITIVES[type];
}
