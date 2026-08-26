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
  /**
   * What you would most often *measure on the ground*, not what a guide recommends.
   *
   * This distinction matters more than it looks. The tool's whole argument is "here is
   * what exists, and here is what fits in the same width", so the neutral starting value
   * has to be the as-built one — otherwise tracing a real street produces bands narrower
   * than the pavement underneath them, and the redesign looks like it fits when it does
   * not. Templates that are *about* narrowing state their tighter numbers explicitly.
   */
  readonly defaultWidthMeters: number;
  readonly minWidthMeters: number;
  /** Typical as-built range in feet, for guidance in the UI and as a test fixture. */
  readonly typicalRangeFeet: readonly [number, number];
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
    defaultWidthMeters: 3.35,
    minWidthMeters: 2.7,
    typicalRangeFeet: [10, 12],
    color: '#4A5157',
    isRoadway: true,
    isRaised: false,
    marking: 'lane',
    defaultDirection: 'forward',
    note: 'Typically 11 ft as built in US cities. NACTO recommends 10 ft, and narrowing to it is the most common single move in a road diet.',
  },
  turnLane: {
    label: 'Center turn lane',
    defaultWidthMeters: 3.35,
    minWidthMeters: 3.0,
    typicalRangeFeet: [10, 14],
    color: '#525A61',
    isRoadway: true,
    isRaised: false,
    marking: 'turn',
    defaultDirection: 'both',
    note: 'Two-way left-turn lane, usually 11 ft as built. Wide ones are often the easiest space to reclaim.',
  },
  busLane: {
    label: 'Bus lane',
    defaultWidthMeters: 3.35,
    minWidthMeters: 3.0,
    typicalRangeFeet: [10, 12],
    color: '#7A4636',
    isRoadway: true,
    isRaised: false,
    marking: 'bus',
    defaultDirection: 'forward',
    note: 'NACTO: 10-11 ft, 12 ft preferred where it is offset from the kerb.',
  },
  bikeLaneConventional: {
    label: 'Bike lane',
    defaultWidthMeters: 1.8,
    minWidthMeters: 1.2,
    typicalRangeFeet: [5, 7],
    color: '#2C6B4E',
    isRoadway: true,
    isRaised: false,
    marking: 'bike',
    defaultDirection: 'forward',
    note: 'Conventional painted lane. 5 ft minimum next to a kerb, 6 ft typical, 7 ft where volumes are high.',
  },
  bikeLaneBuffered: {
    label: 'Buffered bike lane',
    defaultWidthMeters: 2.4,
    minWidthMeters: 1.8,
    typicalRangeFeet: [7, 10],
    color: '#2F7050',
    isRoadway: true,
    isRaised: false,
    marking: 'bike',
    defaultDirection: 'forward',
    note: 'A 5-6 ft lane plus a 2-3 ft painted buffer, which is what the total here represents.',
  },
  bikeLaneProtected: {
    label: 'Protected bike lane',
    defaultWidthMeters: 3.0,
    minWidthMeters: 2.1,
    typicalRangeFeet: [8, 13],
    color: '#2A7A57',
    isRoadway: true,
    isRaised: false,
    marking: 'bike',
    defaultDirection: 'forward',
    note: 'The 2025 NACTO Bikeway Guide splits this into rideable width plus separation: 6.5-7 ft rideable minimum, 8-12.5 ft preferred, plus the separator. 10 ft total is a realistic one-way build.',
  },
  parkingLaneParallel: {
    label: 'Parallel parking',
    defaultWidthMeters: 2.4,
    minWidthMeters: 2.1,
    typicalRangeFeet: [7, 9],
    color: '#585F65',
    isRoadway: true,
    isRaised: false,
    marking: 'parking',
    defaultDirection: 'none',
    note: 'Typically 8 ft. 7 ft is workable on a low-volume street and hands a foot back to the roadway.',
  },
  parkingLaneAngled: {
    label: 'Angled parking',
    defaultWidthMeters: 5.5,
    minWidthMeters: 4.3,
    typicalRangeFeet: [16, 20],
    color: '#5C636A',
    isRoadway: true,
    isRaised: false,
    marking: 'parking',
    defaultDirection: 'none',
    note: 'About 18 ft at 60 degrees. Back-in angled parking occupies the same width and has far better sight lines.',
  },
  median: {
    label: 'Planted median',
    defaultWidthMeters: 2.4,
    minWidthMeters: 1.8,
    typicalRangeFeet: [6, 16],
    color: '#4B6B42',
    isRoadway: true,
    isRaised: true,
    marking: 'planting',
    defaultDirection: 'none',
    note: 'A pedestrian refuge needs 6 ft to hold someone with a bike or a pushchair; landscaped medians run much wider.',
  },
  shoulder: {
    label: 'Shoulder',
    defaultWidthMeters: 2.4,
    minWidthMeters: 0.6,
    typicalRangeFeet: [4, 10],
    color: '#646B70',
    isRoadway: true,
    isRaised: false,
    marking: 'none',
    defaultDirection: 'none',
    note: 'Urban shoulders are 4-8 ft; a rural or highway shoulder is 8-10 ft and doubles as a breakdown lane.',
  },
  sidewalk: {
    label: 'Sidewalk',
    defaultWidthMeters: 3.0,
    minWidthMeters: 1.5,
    typicalRangeFeet: [6, 15],
    color: '#A6ADA6',
    isRoadway: false,
    isRaised: true,
    marking: 'walk',
    defaultDirection: 'none',
    note: 'The whole footway zone, not just the walking lane: frontage plus clear width plus furniture. 5 ft is the clear-width minimum alone, so a 10 ft total is the realistic urban figure.',
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
