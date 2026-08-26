/**
 * The lane primitive library.
 *
 * Every default width here is what you would most often *measure on the ground*, not what
 * a guide recommends. That distinction is the whole reason the fit check can be trusted:
 * the tool's argument is "here is what exists, here is what fits in the same width", so
 * the neutral starting value has to be the as-built one. Templates that are *about*
 * narrowing state their tighter numbers explicitly.
 *
 * Figures are drawn from NACTO's Urban Street Design Guide, the 2025 third edition of the
 * Urban Bikeway Design Guide, the Transit Street Design Guide, and AASHTO's Green Book for
 * the highway entries; `note` records the provenance so a number is never anonymous. None
 * of this is a substitute for engineering judgement, and local standards override all of it.
 *
 * Three flags carry real meaning and are easy to conflate:
 *
 *   isRoadway  the component sits inside the kerb-to-kerb travelway. Drives the anchor
 *              calculation and the intersection trimming — the drawn centerline defaults
 *              to the middle of the travelway, which is the line you can actually see on
 *              satellite imagery. A raised median IS inside the kerbs; a footway is not.
 *   isRaised   drawn above grade in the cross-section elevation. Purely visual. Footways
 *              and medians are both raised.
 *   category   what it is for, so a library this long stays navigable. Adding a primitive
 *              without one makes it unfindable.
 */

export const COMPONENT_TYPES = [
  // ---- travel
  'travelLane',
  'turnLane',
  'turnPocket',
  'sharedLane',
  'slipLane',
  'reversibleLane',
  'woonerf',
  // ---- transit
  'busLane',
  'busLaneOffset',
  'busway',
  'transitPlatform',
  'tramTrack',
  'tramReservation',
  // ---- bike
  'bikeLaneConventional',
  'bikeLaneBuffered',
  'bikeLaneProtected',
  'cycleTrackTwoWay',
  'bikeLaneContraflow',
  'sharedUsePath',
  'bikeParking',
  // ---- parking
  'parkingLaneParallel',
  'parkingLaneAngled',
  'parkingBackInAngled',
  'parkingPerpendicular',
  'loadingZone',
  'layby',
  // ---- pedestrian
  'sidewalk',
  'frontageZone',
  'furnitureZone',
  'pedestrianMall',
  'sharedSpace',
  // ---- median and buffer
  'median',
  'medianRefuge',
  'flushMedian',
  'paintedBuffer',
  'plantingStrip',
  'bioswale',
  'treePit',
  // ---- edge
  'shoulder',
  'gutter',
  'verge',
  'barrier',
  'guardrail',
  'soundWall',
  'ditch',
  // ---- highway
  'freewayLane',
  'auxiliaryLane',
  'rampLane',
  'accelerationLane',
  'shoulderInner',
  'gore',
  // ---- rail
  'railTrack',
  'railBallast',
] as const;

export type ComponentType = (typeof COMPONENT_TYPES)[number];

export type ComponentCategory =
  | 'travel'
  | 'transit'
  | 'bike'
  | 'parking'
  | 'pedestrian'
  | 'median'
  | 'edge'
  | 'highway'
  | 'rail';

export const COMPONENT_CATEGORIES: { id: ComponentCategory; label: string }[] = [
  { id: 'travel', label: 'Travel' },
  { id: 'transit', label: 'Transit' },
  { id: 'bike', label: 'Bike' },
  { id: 'parking', label: 'Parking' },
  { id: 'pedestrian', label: 'Pedestrian' },
  { id: 'median', label: 'Median' },
  { id: 'edge', label: 'Edge' },
  { id: 'highway', label: 'Highway' },
  { id: 'rail', label: 'Rail' },
];

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
  readonly category: ComponentCategory;
  /** As-built typical. See the note at the top of this file. */
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
  // ------------------------------------------------------------------------- travel
  travelLane: {
    label: 'Travel lane',
    category: 'travel',
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
    category: 'travel',
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
  turnPocket: {
    label: 'Turn pocket',
    category: 'travel',
    defaultWidthMeters: 3.05,
    minWidthMeters: 2.7,
    typicalRangeFeet: [10, 12],
    color: '#565E65',
    isRoadway: true,
    isRaised: false,
    marking: 'turn',
    defaultDirection: 'forward',
    note: 'A dedicated turn lane at an approach only. Shorter pockets keep the through street narrow between junctions.',
  },
  sharedLane: {
    label: 'Shared lane',
    category: 'travel',
    defaultWidthMeters: 4.0,
    minWidthMeters: 3.0,
    typicalRangeFeet: [12, 15],
    color: '#4F565C',
    isRoadway: true,
    isRaised: false,
    marking: 'bike',
    defaultDirection: 'forward',
    note: 'A sharrow lane. NACTO treats markings alone as the weakest treatment — useful only on genuinely low-volume, low-speed streets.',
  },
  slipLane: {
    label: 'Slip lane',
    category: 'travel',
    defaultWidthMeters: 4.0,
    minWidthMeters: 3.35,
    typicalRangeFeet: [12, 16],
    color: '#5C646B',
    isRoadway: true,
    isRaised: false,
    marking: 'turn',
    defaultDirection: 'forward',
    note: 'A channelised right turn. Usually a candidate for removal — it lets drivers turn at speed across a crossing.',
  },
  reversibleLane: {
    label: 'Reversible lane',
    category: 'travel',
    defaultWidthMeters: 3.35,
    minWidthMeters: 3.0,
    typicalRangeFeet: [10, 12],
    color: '#5A5F53',
    isRoadway: true,
    isRaised: false,
    marking: 'lane',
    defaultDirection: 'both',
    note: 'Direction changes by time of day under lane control signals.',
  },
  woonerf: {
    label: 'Shared street',
    category: 'travel',
    defaultWidthMeters: 5.5,
    minWidthMeters: 3.5,
    typicalRangeFeet: [14, 24],
    color: '#8A7F70',
    isRoadway: true,
    isRaised: false,
    marking: 'none',
    defaultDirection: 'both',
    note: 'No kerb line and no lane markings; vehicles are guests. Works only where volumes and speeds are genuinely low.',
  },

  // ------------------------------------------------------------------------ transit
  busLane: {
    label: 'Bus lane',
    category: 'transit',
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
  busLaneOffset: {
    label: 'Offset bus lane',
    category: 'transit',
    defaultWidthMeters: 3.65,
    minWidthMeters: 3.0,
    typicalRangeFeet: [11, 13],
    color: '#84503E',
    isRoadway: true,
    isRaised: false,
    marking: 'bus',
    defaultDirection: 'forward',
    note: 'Set one lane in from the kerb so parking and loading do not block it.',
  },
  busway: {
    label: 'Busway',
    category: 'transit',
    defaultWidthMeters: 7.0,
    minWidthMeters: 6.0,
    typicalRangeFeet: [20, 26],
    color: '#6E3F31',
    isRoadway: true,
    isRaised: false,
    marking: 'bus',
    defaultDirection: 'both',
    note: 'Two-way transit-only carriageway, usually in the centre of the street.',
  },
  transitPlatform: {
    label: 'Transit platform',
    category: 'transit',
    defaultWidthMeters: 2.4,
    minWidthMeters: 1.8,
    typicalRangeFeet: [6, 12],
    color: '#8E7B5E',
    isRoadway: false,
    isRaised: true,
    marking: 'walk',
    defaultDirection: 'none',
    note: 'Boarding island. 8 ft is comfortable; 6 ft is the accessible minimum with a shelter set back.',
  },
  tramTrack: {
    label: 'Tram track',
    category: 'transit',
    defaultWidthMeters: 3.0,
    minWidthMeters: 2.6,
    typicalRangeFeet: [9, 11],
    color: '#66584C',
    isRoadway: true,
    isRaised: false,
    marking: 'bus',
    defaultDirection: 'forward',
    note: 'One direction of embedded track in the carriageway.',
  },
  tramReservation: {
    label: 'Tram reservation',
    category: 'transit',
    defaultWidthMeters: 6.4,
    minWidthMeters: 5.5,
    typicalRangeFeet: [18, 24],
    color: '#5E6B52',
    isRoadway: true,
    isRaised: true,
    marking: 'planting',
    defaultDirection: 'both',
    note: 'Two tracks on their own reservation, often grassed. Separated from traffic entirely.',
  },

  // --------------------------------------------------------------------------- bike
  bikeLaneConventional: {
    label: 'Bike lane',
    category: 'bike',
    defaultWidthMeters: 1.8,
    minWidthMeters: 1.2,
    typicalRangeFeet: [5, 7],
    color: '#2E6F63',
    isRoadway: true,
    isRaised: false,
    marking: 'bike',
    defaultDirection: 'forward',
    note: 'Conventional painted lane. 5 ft minimum next to a kerb, 6 ft typical, 7 ft where volumes are high.',
  },
  bikeLaneBuffered: {
    label: 'Buffered bike lane',
    category: 'bike',
    defaultWidthMeters: 2.4,
    minWidthMeters: 1.8,
    typicalRangeFeet: [7, 10],
    color: '#2F7A6C',
    isRoadway: true,
    isRaised: false,
    marking: 'bike',
    defaultDirection: 'forward',
    note: 'A 5-6 ft lane plus a 2-3 ft painted buffer, which is what the total here represents.',
  },
  bikeLaneProtected: {
    label: 'Protected bike lane',
    category: 'bike',
    defaultWidthMeters: 3.0,
    minWidthMeters: 2.1,
    typicalRangeFeet: [8, 13],
    color: '#2F8A72',
    isRoadway: true,
    isRaised: false,
    marking: 'bike',
    defaultDirection: 'forward',
    note: 'The 2025 NACTO Bikeway Guide splits this into rideable width plus separation: 6.5-7 ft rideable minimum, 8-12.5 ft preferred, plus the separator. 10 ft total is a realistic one-way build.',
  },
  cycleTrackTwoWay: {
    label: 'Two-way cycle track',
    category: 'bike',
    defaultWidthMeters: 3.7,
    minWidthMeters: 2.4,
    typicalRangeFeet: [10, 16],
    color: '#27997A',
    isRoadway: true,
    isRaised: false,
    marking: 'bike',
    defaultDirection: 'both',
    note: 'Both directions on one side. 12 ft is comfortable; 8 ft is the constrained minimum and gets uncomfortable quickly.',
  },
  bikeLaneContraflow: {
    label: 'Contraflow bike lane',
    category: 'bike',
    defaultWidthMeters: 1.8,
    minWidthMeters: 1.5,
    typicalRangeFeet: [5, 7],
    color: '#35806F',
    isRoadway: true,
    isRaised: false,
    marking: 'bike',
    defaultDirection: 'backward',
    note: 'Against the flow on a one-way street — the cheapest way to undo a one-way network for bikes.',
  },
  sharedUsePath: {
    label: 'Shared use path',
    category: 'bike',
    defaultWidthMeters: 3.0,
    minWidthMeters: 2.4,
    typicalRangeFeet: [8, 14],
    color: '#4A8C6A',
    isRoadway: false,
    isRaised: true,
    marking: 'bike',
    defaultDirection: 'both',
    note: 'People walking and cycling together, off the carriageway. 10 ft standard, 12 ft where busy.',
  },
  bikeParking: {
    label: 'Bike parking',
    category: 'bike',
    defaultWidthMeters: 1.8,
    minWidthMeters: 0.9,
    typicalRangeFeet: [3, 8],
    color: '#3B6E62',
    isRoadway: false,
    isRaised: true,
    marking: 'bike',
    defaultDirection: 'none',
    note: 'Racks or a bike corral. One car space holds roughly ten bikes.',
  },

  // ------------------------------------------------------------------------ parking
  parkingLaneParallel: {
    label: 'Parallel parking',
    category: 'parking',
    defaultWidthMeters: 2.4,
    minWidthMeters: 2.1,
    typicalRangeFeet: [7, 9],
    color: '#5E5A50',
    isRoadway: true,
    isRaised: false,
    marking: 'parking',
    defaultDirection: 'none',
    note: 'Typically 8 ft. 7 ft is workable on a low-volume street and hands a foot back to the roadway.',
  },
  parkingLaneAngled: {
    label: 'Angled parking',
    category: 'parking',
    defaultWidthMeters: 5.5,
    minWidthMeters: 4.3,
    typicalRangeFeet: [16, 20],
    color: '#65604F',
    isRoadway: true,
    isRaised: false,
    marking: 'parking',
    defaultDirection: 'none',
    note: 'About 18 ft at 60 degrees.',
  },
  parkingBackInAngled: {
    label: 'Back-in angled parking',
    category: 'parking',
    defaultWidthMeters: 5.5,
    minWidthMeters: 4.3,
    typicalRangeFeet: [16, 20],
    color: '#6B6553',
    isRoadway: true,
    isRaised: false,
    marking: 'parking',
    defaultDirection: 'none',
    note: 'Same width as head-in, far better sight lines pulling out — and loading happens on the kerb side.',
  },
  parkingPerpendicular: {
    label: 'Perpendicular parking',
    category: 'parking',
    defaultWidthMeters: 5.5,
    minWidthMeters: 4.9,
    typicalRangeFeet: [16, 20],
    color: '#5F5A48',
    isRoadway: true,
    isRaised: false,
    marking: 'parking',
    defaultDirection: 'none',
    note: '90 degrees to the kerb. Needs a wide aisle to manoeuvre, so it suits lots more than streets.',
  },
  loadingZone: {
    label: 'Loading zone',
    category: 'parking',
    defaultWidthMeters: 3.0,
    minWidthMeters: 2.4,
    typicalRangeFeet: [8, 12],
    color: '#6E5B44',
    isRoadway: true,
    isRaised: false,
    marking: 'parking',
    defaultDirection: 'none',
    note: 'Kerbside freight or passenger loading. Time-limited kerb is usually worth more than all-day storage.',
  },
  layby: {
    label: 'Layby',
    category: 'parking',
    defaultWidthMeters: 3.0,
    minWidthMeters: 2.4,
    typicalRangeFeet: [8, 12],
    color: '#655843',
    isRoadway: true,
    isRaised: false,
    marking: 'parking',
    defaultDirection: 'none',
    note: 'A pull-in bay set into the kerb line, for stopping without blocking a lane.',
  },

  // --------------------------------------------------------------------- pedestrian
  sidewalk: {
    label: 'Sidewalk',
    category: 'pedestrian',
    defaultWidthMeters: 3.0,
    minWidthMeters: 1.5,
    typicalRangeFeet: [6, 15],
    color: '#8C8578',
    isRoadway: false,
    isRaised: true,
    marking: 'walk',
    defaultDirection: 'none',
    note: 'The whole footway zone, not just the walking lane: frontage plus clear width plus furniture. 5 ft is the clear-width minimum alone, so a 10 ft total is the realistic urban figure.',
  },
  frontageZone: {
    label: 'Frontage zone',
    category: 'pedestrian',
    defaultWidthMeters: 0.6,
    minWidthMeters: 0.3,
    typicalRangeFeet: [1.5, 6],
    color: '#948C7E',
    isRoadway: false,
    isRaised: true,
    marking: 'none',
    defaultDirection: 'none',
    note: 'The shy distance against a building line, or space for cafe tables and shop displays.',
  },
  furnitureZone: {
    label: 'Furniture zone',
    category: 'pedestrian',
    defaultWidthMeters: 1.2,
    minWidthMeters: 0.9,
    typicalRangeFeet: [3, 6],
    color: '#7E8A6A',
    isRoadway: false,
    isRaised: true,
    marking: 'planting',
    defaultDirection: 'none',
    note: 'Trees, poles, bins and signs, kept out of the clear walking width.',
  },
  pedestrianMall: {
    label: 'Pedestrian mall',
    category: 'pedestrian',
    defaultWidthMeters: 9.0,
    minWidthMeters: 4.0,
    typicalRangeFeet: [20, 60],
    color: '#9C9384',
    isRoadway: false,
    isRaised: true,
    marking: 'walk',
    defaultDirection: 'none',
    note: 'A street given over entirely to people on foot.',
  },
  sharedSpace: {
    label: 'Shared space',
    category: 'pedestrian',
    defaultWidthMeters: 6.0,
    minWidthMeters: 3.0,
    typicalRangeFeet: [12, 30],
    color: '#94897A',
    isRoadway: false,
    isRaised: true,
    marking: 'walk',
    defaultDirection: 'none',
    note: 'Level surface with no kerb. Contested: works where vehicle volumes are very low, poorly where they are not, and needs a defined edge for people who cannot see one.',
  },

  // -------------------------------------------------------------- median and buffer
  median: {
    label: 'Planted median',
    category: 'median',
    defaultWidthMeters: 2.4,
    minWidthMeters: 1.8,
    typicalRangeFeet: [6, 16],
    color: '#5E7A4A',
    isRoadway: true,
    isRaised: true,
    marking: 'planting',
    defaultDirection: 'none',
    note: 'A pedestrian refuge needs 6 ft to hold someone with a bike or a pushchair; landscaped medians run much wider.',
  },
  medianRefuge: {
    label: 'Refuge island',
    category: 'median',
    defaultWidthMeters: 1.83,
    minWidthMeters: 1.83,
    typicalRangeFeet: [6, 10],
    color: '#6B8455',
    isRoadway: true,
    isRaised: true,
    marking: 'walk',
    defaultDirection: 'none',
    note: 'Splits a crossing into two stages. 6 ft is the minimum that actually shelters a person; anything less is decorative.',
  },
  flushMedian: {
    label: 'Flush median',
    category: 'median',
    defaultWidthMeters: 1.2,
    minWidthMeters: 0.6,
    typicalRangeFeet: [2, 6],
    color: '#6E6A5C',
    isRoadway: true,
    isRaised: false,
    marking: 'none',
    defaultDirection: 'none',
    note: 'Painted separation at grade. Cheap, and does nothing to slow a driver who ignores it.',
  },
  paintedBuffer: {
    label: 'Painted buffer',
    category: 'median',
    defaultWidthMeters: 0.9,
    minWidthMeters: 0.45,
    typicalRangeFeet: [1.5, 5],
    color: '#7A776B',
    isRoadway: true,
    isRaised: false,
    marking: 'none',
    defaultDirection: 'none',
    note: 'Hatching between a bike lane and traffic. Becomes protection only when something vertical is added.',
  },
  plantingStrip: {
    label: 'Planting strip',
    category: 'median',
    defaultWidthMeters: 1.5,
    minWidthMeters: 0.9,
    typicalRangeFeet: [3, 8],
    color: '#6B8450',
    isRoadway: false,
    isRaised: true,
    marking: 'planting',
    defaultDirection: 'none',
    note: 'Verge between kerb and footway. Street trees need about 5 ft to survive long term.',
  },
  bioswale: {
    label: 'Bioswale',
    category: 'median',
    defaultWidthMeters: 1.8,
    minWidthMeters: 1.2,
    typicalRangeFeet: [4, 10],
    color: '#5B7A63',
    isRoadway: false,
    isRaised: false,
    marking: 'planting',
    defaultDirection: 'none',
    note: 'Planted drainage. Does the job of a pipe and a garden at once, and takes runoff off the carriageway.',
  },
  treePit: {
    label: 'Tree pit',
    category: 'median',
    defaultWidthMeters: 1.5,
    minWidthMeters: 1.2,
    typicalRangeFeet: [4, 8],
    color: '#4E7042',
    isRoadway: false,
    isRaised: false,
    marking: 'planting',
    defaultDirection: 'none',
    note: 'Individual pits rather than a continuous strip. Needs soil volume below to grow a canopy worth having.',
  },

  // --------------------------------------------------------------------------- edge
  shoulder: {
    label: 'Shoulder',
    category: 'edge',
    defaultWidthMeters: 2.4,
    minWidthMeters: 0.6,
    typicalRangeFeet: [4, 10],
    color: '#6E6B62',
    isRoadway: true,
    isRaised: false,
    marking: 'none',
    defaultDirection: 'none',
    note: 'Urban shoulders are 4-8 ft; a rural or highway shoulder is 8-10 ft and doubles as a breakdown lane.',
  },
  gutter: {
    label: 'Gutter',
    category: 'edge',
    defaultWidthMeters: 0.45,
    minWidthMeters: 0.3,
    typicalRangeFeet: [1, 2],
    color: '#7E7B72',
    isRoadway: true,
    isRaised: false,
    marking: 'none',
    defaultDirection: 'none',
    note: 'The drainage channel at the kerb. Counts against a bike lane width — it is not rideable.',
  },
  verge: {
    label: 'Verge',
    category: 'edge',
    defaultWidthMeters: 1.8,
    minWidthMeters: 0.6,
    typicalRangeFeet: [3, 12],
    color: '#6B7A52',
    isRoadway: false,
    isRaised: false,
    marking: 'planting',
    defaultDirection: 'none',
    note: 'Unpaved edge, usually grass. Common on rural and suburban sections with no footway.',
  },
  barrier: {
    label: 'Concrete barrier',
    category: 'edge',
    defaultWidthMeters: 0.6,
    minWidthMeters: 0.45,
    typicalRangeFeet: [1.5, 3],
    color: '#948F86',
    isRoadway: true,
    isRaised: true,
    marking: 'none',
    defaultDirection: 'none',
    note: 'Jersey barrier or similar. Genuine protection, and a genuine obstacle to crossing.',
  },
  guardrail: {
    label: 'Guardrail',
    category: 'edge',
    defaultWidthMeters: 0.45,
    minWidthMeters: 0.3,
    typicalRangeFeet: [1, 2],
    color: '#8A8B8C',
    isRoadway: false,
    isRaised: true,
    marking: 'none',
    defaultDirection: 'none',
    note: 'Steel beam barrier. Needs deflection space behind it to work.',
  },
  soundWall: {
    label: 'Sound wall',
    category: 'edge',
    defaultWidthMeters: 0.6,
    minWidthMeters: 0.3,
    typicalRangeFeet: [1, 3],
    color: '#7C766E',
    isRoadway: false,
    isRaised: true,
    marking: 'none',
    defaultDirection: 'none',
    note: 'Noise barrier along a highway edge.',
  },
  ditch: {
    label: 'Ditch',
    category: 'edge',
    defaultWidthMeters: 2.4,
    minWidthMeters: 1.2,
    typicalRangeFeet: [4, 12],
    color: '#5E6B58',
    isRoadway: false,
    isRaised: false,
    marking: 'planting',
    defaultDirection: 'none',
    note: 'Open drainage channel on a rural section.',
  },

  // ------------------------------------------------------------------------ highway
  freewayLane: {
    label: 'Freeway lane',
    category: 'highway',
    defaultWidthMeters: 3.65,
    minWidthMeters: 3.35,
    typicalRangeFeet: [11, 12],
    color: '#3E464C',
    isRoadway: true,
    isRaised: false,
    marking: 'lane',
    defaultDirection: 'forward',
    note: 'AASHTO standard is 12 ft on a mainline. The width is why speeds are what they are.',
  },
  auxiliaryLane: {
    label: 'Auxiliary lane',
    category: 'highway',
    defaultWidthMeters: 3.65,
    minWidthMeters: 3.35,
    typicalRangeFeet: [11, 12],
    color: '#454D53',
    isRoadway: true,
    isRaised: false,
    marking: 'lane',
    defaultDirection: 'forward',
    note: 'Runs between an on-ramp and the next off-ramp so merging traffic does not have to weave.',
  },
  rampLane: {
    label: 'Ramp lane',
    category: 'highway',
    defaultWidthMeters: 4.3,
    minWidthMeters: 3.65,
    typicalRangeFeet: [12, 16],
    color: '#4A5259',
    isRoadway: true,
    isRaised: false,
    marking: 'lane',
    defaultDirection: 'forward',
    note: 'A single-lane ramp is wider than a mainline lane to allow for a broken-down vehicle.',
  },
  accelerationLane: {
    label: 'Acceleration lane',
    category: 'highway',
    defaultWidthMeters: 3.65,
    minWidthMeters: 3.35,
    typicalRangeFeet: [11, 12],
    color: '#414951',
    isRoadway: true,
    isRaised: false,
    marking: 'lane',
    defaultDirection: 'forward',
    note: 'Merge or diverge taper alongside the mainline.',
  },
  shoulderInner: {
    label: 'Inner shoulder',
    category: 'highway',
    defaultWidthMeters: 1.22,
    minWidthMeters: 0.6,
    typicalRangeFeet: [4, 6],
    color: '#5E656B',
    isRoadway: true,
    isRaised: false,
    marking: 'none',
    defaultDirection: 'none',
    note: 'Median-side shoulder, narrower than the outer one.',
  },
  gore: {
    label: 'Gore area',
    category: 'highway',
    defaultWidthMeters: 3.0,
    minWidthMeters: 1.2,
    typicalRangeFeet: [4, 20],
    color: '#6B7176',
    isRoadway: true,
    isRaised: false,
    marking: 'none',
    defaultDirection: 'none',
    note: 'The painted wedge where a ramp splits from the mainline. Nominal width — it is a taper, not a constant.',
  },

  // --------------------------------------------------------------------------- rail
  railTrack: {
    label: 'Rail track',
    category: 'rail',
    defaultWidthMeters: 3.0,
    minWidthMeters: 2.6,
    typicalRangeFeet: [9, 12],
    color: '#5E5750',
    isRoadway: false,
    isRaised: false,
    marking: 'none',
    defaultDirection: 'forward',
    note: 'One track. Standard gauge is 4 ft 8.5 in; the width here is the structure gauge it occupies.',
  },
  railBallast: {
    label: 'Ballast',
    category: 'rail',
    defaultWidthMeters: 1.8,
    minWidthMeters: 0.9,
    typicalRangeFeet: [3, 8],
    color: '#6E675E',
    isRoadway: false,
    isRaised: false,
    marking: 'none',
    defaultDirection: 'none',
    note: 'Track bed either side of the rails.',
  },
};

export const PRIMITIVE_ORDER: readonly ComponentType[] = COMPONENT_TYPES;

export function isComponentType(value: unknown): value is ComponentType {
  return typeof value === 'string' && (COMPONENT_TYPES as readonly string[]).includes(value);
}

export function primitive(type: ComponentType): Primitive {
  return PRIMITIVES[type];
}

/**
 * Case-insensitive match on label, category or note.
 *
 * Notes are searchable on purpose: it means you can find a thing by what it is *for*
 * ("refuge", "freight", "drainage") rather than having to already know its name.
 */
export function searchPrimitives(query: string): ComponentType[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...PRIMITIVE_ORDER];
  return PRIMITIVE_ORDER.filter((type) => {
    const spec = PRIMITIVES[type];
    return (
      spec.label.toLowerCase().includes(q) ||
      spec.category.toLowerCase().includes(q) ||
      spec.note.toLowerCase().includes(q)
    );
  });
}
