import { localPlane, originFor } from './projection';
import type { LngLat, LocalPlane, PlanePoint } from './projection';
import { resolveCenterline } from './curve';
import type { CurveSettings } from './curve';
import { lineLengthMeters } from './measure';
import { overpassProfile, stationAt } from './grade';
import type { GradePoint } from './grade';
import type { Junction } from './junctions';
import type { Street } from '../model/types';

/**
 * Interchanges, built out of the parts that already exist.
 *
 * Everything an interchange needs was already here — a grade profile to carry one road
 * over another, merges for where a ramp rejoins, junctions for where it lands — but putting
 * them together meant drawing four ramps by hand, guessing each one's curve, and setting
 * the grade separately. That is a lot of fiddly work to express one decision: *this
 * crossing is grade-separated, in this form*.
 *
 * So this plans the parts and hands them over as ordinary streets. Nothing here is a new
 * kind of object. A ramp is a street with a ramp cross-section; the structure is a grade
 * profile on the mainline; the place a ramp rejoins the mainline becomes a merge because
 * the merge detector reads it as one, at the angle it really comes in at. Delete a ramp and
 * it is gone; drag its vertices and it moves. That is the whole point of building it from
 * parts rather than adding an Interchange entity that would need its own editor.
 *
 * One crossing at a time, always. This is a decision about a specific place.
 */

export type InterchangeForm = 'diamond' | 'halfDiamond' | 'trumpet';

export const INTERCHANGE_FORMS: {
  id: InterchangeForm;
  label: string;
  detail: string;
  ramps: number;
}[] = [
  {
    id: 'diamond',
    label: 'Diamond',
    detail: 'Four ramps, one per quadrant. The ordinary grade-separated crossing.',
    ramps: 4,
  },
  {
    id: 'halfDiamond',
    label: 'Half diamond',
    detail: 'Two ramps on one side. Access in one direction only.',
    ramps: 2,
  },
  {
    id: 'trumpet',
    label: 'Trumpet',
    detail: 'For a road that ends at the one it meets: a loop and a direct ramp.',
    ramps: 2,
  },
];

export interface InterchangeOptions {
  /** The street that carries the structure. The other one passes at grade. */
  mainlineId: string;
  form: InterchangeForm;
  /** How far along the mainline the ramps diverge from it. */
  rampReachMeters?: number;
  /** How far along the cross road the ramp terminals sit. */
  terminalOffsetMeters?: number;
  /** +1 carries the mainline over, -1 takes it under. */
  direction?: 1 | -1;
}

export interface PlannedRamp {
  name: string;
  centerline: LngLat[];
  curve: CurveSettings;
  /** Which side of the mainline and cross road, for naming and for the half forms. */
  quadrant: 'NE' | 'NW' | 'SE' | 'SW';
}

export interface InterchangePlan {
  mainlineId: string;
  crossStreetId: string;
  /** The profile that carries the mainline over or under. */
  mainlineGrade: GradePoint[];
  ramps: PlannedRamp[];
  warnings: string[];
}

/**
 * Default reach, in metres.
 *
 * Long enough that the mainline is back on the ground where the ramps leave it — which is
 * what lets the ramps themselves stay at grade and keeps this an arrangement of ordinary
 * streets rather than a pile of special cases.
 */
const DEFAULT_RAMP_REACH = 210;

/** Default distance from the mainline to each ramp terminal, along the cross road. */
const DEFAULT_TERMINAL_OFFSET = 95;

/** Ramps shorter than this cannot hold a turn worth driving. */
const MIN_REACH = 60;

/**
 * How far apart the two ramps on the same side of the mainline attach to it.
 *
 * The single most important number here, and it was missing. Both ramps on one side used
 * to leave from the *same* point, which made that point a three-street junction — and a
 * merge is defined as one road ending on another that continues through, exactly two
 * streets. So no part of an interchange was ever read as a merge; every one came out as a
 * box intersection carved through the freeway, which is what "merge just lets both lines
 * exist" looks like from the map.
 *
 * Separating them is also what real diamonds do: the exit leaves before the structure and
 * the entrance rejoins after it. They are different places because they are different
 * manoeuvres.
 */
const RAMP_SPREAD_METRES = 80;

/**
 * How far off the mainline's centreline a ramp begins.
 *
 * Comfortably inside the detector's tolerance for an endpoint landing on a street, so the
 * junction still forms; comfortably clear of the centreline, so the ramp never crosses it.
 */
const DEPARTURE_OFFSET_METRES = 1.5;

const sub = (a: PlanePoint, b: PlanePoint): PlanePoint => ({ x: a.x - b.x, y: a.y - b.y });

function norm(p: PlanePoint): PlanePoint {
  const l = Math.hypot(p.x, p.y) || 1;
  return { x: p.x / l, y: p.y / l };
}

function add(a: PlanePoint, b: PlanePoint): PlanePoint {
  return { x: a.x + b.x, y: a.y + b.y };
}

function scale(p: PlanePoint, k: number): PlanePoint {
  return { x: p.x * k, y: p.y * k };
}

/**
 * Unit direction of a street at a station, pointing toward increasing station.
 *
 * Read off the resolved line rather than the control points: a ramp leaving a curved
 * mainline has to leave along where the pavement goes, not along the chord between the two
 * control points either side of it.
 */
function directionAt(line: readonly LngLat[], plane: LocalPlane, station: number): PlanePoint {
  const pts = line.map((p) => plane.toPlane(p));
  let travelled = 0;

  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (travelled + length >= station || i === pts.length - 2) return norm(sub(b, a));
    travelled += length;
  }

  return { x: 1, y: 0 };
}

/**
 * One ramp, as control points a smooth curve can run through.
 *
 * The two ends are deliberately different, because they are different things.
 *
 * At the mainline it leaves *tangentially* — the second point is still on the mainline —
 * so the merge detector reads a shallow angle and builds a taper and a gore. A ramp that
 * kinked away the moment it left would be classified as a junction and get a box.
 *
 * At the cross road it arrives at an *angle*. The point before the last used to sit on the
 * cross road's own centerline, which made the ramp run along it for its final stretch and
 * cross it more than once — that is where the six-legged junctions came from. Holding the
 * approach off to one side until the last point makes the terminal an ordinary T or
 * crossroads: something with corners, crossings and turn lanes you can design.
 */
function rampPoints(
  crossing: PlanePoint,
  mainDir: PlanePoint,
  crossDir: PlanePoint,
  reach: number,
  offset: number,
): PlanePoint[] {
  return [
    // Beside the mainline, not on it — the ramp starts a metre and a half off the
    // centreline, which is where a ramp actually diverges from anyway: the edge of the
    // carriageway, not the middle of it.
    //
    // The junction detector still finds this. Its tolerance for an endpoint landing on a
    // street is that street's own half-width, several metres, so a metre and a half inside
    // it reads as a T at the projection. What it does NOT do is touch the centreline, and
    // that is the point: a ramp that starts exactly on the line and curves away grazes it
    // again a few metres on, and the graze is a second crossing. That showed up as a
    // phantom four-legged intersection sitting beside every merge.
    //
    // Every offset below increases monotonically for the same reason — a spline through
    // points that hesitate will bow back across the line they came from.
    add(add(crossing, scale(mainDir, reach)), scale(crossDir, DEPARTURE_OFFSET_METRES)),
    add(
      add(crossing, scale(mainDir, reach * 0.85)),
      scale(crossDir, DEPARTURE_OFFSET_METRES + offset * 0.04),
    ),
    // The sweep, off both axes so the curve turns rather than corners.
    add(add(crossing, scale(mainDir, reach * 0.55)), scale(crossDir, offset * 0.26)),
    // Approaching the cross road but still clear of it, so the arrival has an angle.
    add(add(crossing, scale(mainDir, reach * 0.2)), scale(crossDir, offset * 0.7)),
    add(crossing, scale(crossDir, offset)),
  ];
}

/**
 * Work out the ramps and the structure for one crossing.
 *
 * Returns null when the junction cannot carry the form — two streets that do not both pass
 * through, or a street too short to hold its own ramps. Refusing is better than emitting
 * ramps that start off the end of the road they are supposed to leave.
 */
export function planInterchange(
  junction: Junction,
  streets: readonly Street[],
  options: InterchangeOptions,
): InterchangePlan | null {
  const {
    mainlineId,
    form,
    rampReachMeters = DEFAULT_RAMP_REACH,
    terminalOffsetMeters = DEFAULT_TERMINAL_OFFSET,
    direction = 1,
  } = options;

  const crossStreetId = junction.streetIds.find((id) => id !== mainlineId);
  if (!crossStreetId) return null;

  const mainline = streets.find((s) => s.id === mainlineId);
  const cross = streets.find((s) => s.id === crossStreetId);
  if (!mainline || !cross) return null;

  const mainLine = resolveCenterline(mainline);
  const crossLine = resolveCenterline(cross);
  const plane = localPlane(originFor([...mainLine, ...crossLine]));

  const crossing = plane.toPlane(junction.position);
  const mainStation = stationAt(mainLine, junction.position);
  const crossStation = stationAt(crossLine, junction.position);
  const mainLength = lineLengthMeters(mainLine);
  const crossLength = lineLengthMeters(crossLine);

  const warnings: string[] = [];

  // How much road there actually is, either side, on both streets. Ramps are clamped to
  // it rather than running off the end — a ramp that leaves from beyond the end of the
  // mainline is not a ramp, it is a floating line.
  const mainBack = Math.min(rampReachMeters, mainStation);
  const mainFwd = Math.min(rampReachMeters, mainLength - mainStation);
  const crossBack = Math.min(terminalOffsetMeters, crossStation);
  const crossFwd = Math.min(terminalOffsetMeters, crossLength - crossStation);

  if (Math.max(mainBack, mainFwd) < MIN_REACH || Math.max(crossBack, crossFwd) < MIN_REACH) {
    return null;
  }

  const mainDir = directionAt(mainLine, plane, mainStation);
  const crossDir = directionAt(crossLine, plane, crossStation);

  // `rank` staggers the two ramps on the same side of the mainline: the nearer one
  // attaches at `reach`, the further at `reach + spread`. They have to be separate points
  // or the mainline sees a three-street junction there and a merge is, by definition, two.
  const quadrants: {
    id: PlannedRamp['quadrant'];
    main: 1 | -1;
    cross: 1 | -1;
    rank: 0 | 1;
  }[] = [
    { id: 'NE', main: 1, cross: 1, rank: 0 },
    { id: 'SE', main: 1, cross: -1, rank: 1 },
    { id: 'NW', main: -1, cross: 1, rank: 0 },
    { id: 'SW', main: -1, cross: -1, rank: 1 },
  ];

  const wanted =
    form === 'diamond'
      ? quadrants
      : form === 'halfDiamond'
        ? quadrants.filter((q) => q.cross === 1)
        : // A trumpet serves a road that ends here: both ramps come off the same side of
          // the mainline, one looping back on itself.
          quadrants.filter((q) => q.main === 1);

  const ramps: PlannedRamp[] = [];

  for (const quadrant of wanted) {
    const available = quadrant.main === 1 ? mainFwd : mainBack;
    const offset = quadrant.cross === 1 ? crossFwd : crossBack;

    // The far ramp of a pair sits a spread further out — but never past the end of the
    // road. Where there is not room for the stagger, both land at the same place and the
    // pair reads as one junction rather than two merges, which is honest: the road is too
    // short for a diamond and saying so beats drawing one that overlaps itself.
    const spread = Math.min(RAMP_SPREAD_METRES, Math.max(0, available - MIN_REACH));
    const reach = quadrant.rank === 0 ? Math.max(MIN_REACH, available - spread) : available;

    if (available < MIN_REACH || offset < MIN_REACH * 0.5) {
      warnings.push(
        `No room for the ${quadrant.id} ramp — ${reach.toFixed(0)} m of mainline and ${offset.toFixed(
          0,
        )} m of cross road. Extend one of them, or use a form with fewer ramps.`,
      );
      continue;
    }

    const points = rampPoints(
      crossing,
      scale(mainDir, quadrant.main),
      scale(crossDir, quadrant.cross),
      reach,
      offset,
    );

    ramps.push({
      name: `${mainline.name} ${quadrant.id} ramp`,
      centerline: points.map((p) => plane.toLngLat(p)),
      // Smooth rather than a stated radius: a ramp is traced as a shape that has to land
      // tangentially at both ends, which is exactly what this mode is for.
      curve: { mode: 'smooth', radiusMeters: 30 },
      quadrant: quadrant.id,
    });
  }

  if (ramps.length === 0) return null;

  // The structure. Ramps are placed where the mainline is already back on the ground, so
  // the ramps themselves stay at grade and the whole thing is ordinary streets meeting
  // ordinary streets.
  const hold = Math.max(20, Math.min(40, crossLength * 0.08));
  const rampRun = Math.max(35, Math.min(70, Math.min(mainBack, mainFwd) * 0.45));
  const mainlineGrade = overpassProfile(mainLength, mainStation, {
    rampMeters: rampRun,
    holdMeters: hold,
    direction,
  });

  return { mainlineId, crossStreetId, mainlineGrade, ramps, warnings };
}
