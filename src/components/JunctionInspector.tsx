import { useState } from 'react';
import type { JunctionSummary } from '../map/designLayers';
import type { CornerOverride, JunctionOverride, LegOverride } from '../geo/derived';
import type { CrosswalkStyle } from '../geo/intersection';
import {
  DEFAULT_BULB_OUT_METRES,
  DEFAULT_CROSSWALK_WIDTH_METRES,
  DEFAULT_DAYLIGHT_METRES,
} from '../geo/intersection';
import { displayToMetres, formatWidth, stepFor } from '../lib/units';
import type { DisplayUnits } from '../lib/units';
import ApproachEditor from './ApproachEditor';
import type { CrossSection } from '../model/types';

/**
 * The intersection inspector.
 *
 * Drawn as a wheel rather than listed as rows, because an intersection *is* radial: a
 * corner is only meaningful as the thing between two particular legs, and a list makes you
 * hold that mapping in your head. Clicking the corner you can see is the whole point.
 *
 * Crossing distance is given top billing throughout, and shown as a before/after wherever
 * a curb extension has moved it. That number — how far someone on foot is exposed — is the
 * pedestrian counterpart to a street's fit check, and it is what every control here is
 * ultimately in service of.
 */

interface Props {
  junction: JunctionSummary;
  units: DisplayUnits;
  streetNames: Readonly<Record<string, string>>;
  /** Each participating street's cross-section, so a leg can list its own lanes. */
  sections: Readonly<Record<string, CrossSection>>;
  /** Junctions this one overlaps — a staggered pair reads as one place to a driver. */
  offsetNeighbours?: readonly { key: string; separationMeters: number }[];
  override: JunctionOverride | undefined;
  onCorner: (cornerIndex: number, patch: Partial<CornerOverride>) => void;
  onLeg: (legIndex: number, patch: Partial<LegOverride>) => void;
  onReset: () => void;
}

const R_OUTER = 52;
const R_INNER = 20;
const SIZE = 132;

const CROSSWALK_STYLES: { id: CrosswalkStyle; label: string }[] = [
  { id: 'continental', label: 'Continental' },
  { id: 'ladder', label: 'Ladder' },
  { id: 'transverse', label: 'Transverse' },
  { id: 'raised', label: 'Raised table' },
];

/** Bearings are maths convention (0 = east, counter-clockwise); SVG y points down. */
function pointAt(bearing: number, radius: number): [number, number] {
  return [SIZE / 2 + radius * Math.cos(bearing), SIZE / 2 - radius * Math.sin(bearing)];
}

function arcPath(from: number, to: number, radius: number): string {
  let sweep = to - from;
  while (sweep <= 0) sweep += Math.PI * 2;
  const [x1, y1] = pointAt(from, radius);
  const [x2, y2] = pointAt(to, radius);
  // Counter-clockwise in bearing terms is clockwise on screen, hence sweep-flag 0.
  return `M ${x1} ${y1} A ${radius} ${radius} 0 ${sweep > Math.PI ? 1 : 0} 0 ${x2} ${y2}`;
}

/** Eight-point compass label from a maths-convention bearing. */
function compass(bearing: number): string {
  const points = ['E', 'NE', 'N', 'NW', 'W', 'SW', 'S', 'SE'];
  return points[Math.round((bearing / (Math.PI * 2)) * 8) % 8]!;
}

export default function JunctionInspector({
  junction,
  units,
  streetNames,
  sections,
  offsetNeighbours = [],
  override,
  onCorner,
  onLeg,
  onReset,
}: Props) {
  const [activeCorner, setActiveCorner] = useState(0);
  const [activeLeg, setActiveLeg] = useState(0);
  const corners = junction.corners;
  const legs = junction.legs;
  const corner = corners[activeCorner];
  const leg = legs[activeLeg];
  const legOverride = override?.legs?.[activeLeg] ?? null;

  // Bearings are not on the summary, so recover each leg's direction from its stop line:
  // the line runs right-to-left across the leg, so its clockwise normal points outward.
  const bearings = legs.map((entry) => {
    const [a, b] = entry.stopLine;
    const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
    return (angle - Math.PI / 2 + Math.PI * 2) % (Math.PI * 2);
  });

  /**
   * Is there another leg roughly opposite this one?
   *
   * The through movement is not a property of the approach, it is a property of the
   * junction: a leg can only go straight on if something continues on the far side. At a
   * T-junction stem there is nothing there, which is exactly the case a lane-assignment UI
   * has to know about. Thirty degrees of slack, because a junction is rarely square.
   */
  const hasOppositeLeg = (index: number): boolean => {
    const from = bearings[index];
    if (from === undefined) return true;
    return bearings.some((other, i) => {
      if (i === index || other === undefined) return false;
      const delta = Math.abs(((other - from + Math.PI * 3) % (Math.PI * 2)) - Math.PI);
      return delta < (30 * Math.PI) / 180;
    });
  };

  const widest = Math.max(...legs.map((l) => l.crossingDistanceWithoutBulbsMeters), 1);
  const totalSaved = legs.reduce(
    (sum, l) => sum + (l.crossingDistanceWithoutBulbsMeters - l.crossingDistanceMeters),
    0,
  );

  const everyLegMarked = legs.every((l) => l.hasCrosswalk);
  const everyCornerBulbed = corners.every(
    (c) => c.angleDegrees > 179 || c.treatment === 'bulbOut',
  );

  return (
    <>
      <section className="panel">
        <header className="panel-head">
          <span className="label">Intersection</span>
          <span className="label mono">
            {legs.length} legs · {junction.kind}
          </span>
        </header>

        <div className="junction-wheel">
          <svg viewBox={`0 0 ${SIZE} ${SIZE}`} role="img" aria-label="Intersection legs and corners">
            {legs.map((entry, i) => {
              const bearing = bearings[i]!;
              const [x1, y1] = pointAt(bearing, R_INNER);
              const [x2, y2] = pointAt(bearing, R_OUTER);
              return (
                <line
                  key={`leg-${i}`}
                  x1={x1}
                  y1={y1}
                  x2={x2}
                  y2={y2}
                  className={`wheel-leg${i === activeLeg ? ' is-active' : ''}`}
                  strokeWidth={4 + 10 * (entry.crossingDistanceMeters / widest)}
                  onClick={() => setActiveLeg(i)}
                  role="button"
                  tabIndex={0}
                  aria-label={`Leg ${compass(bearing)}`}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') setActiveLeg(i);
                  }}
                />
              );
            })}

            {corners.map((c, i) => {
              const straight = c.angleDegrees > 179;
              return (
                <path
                  key={`corner-${i}`}
                  d={arcPath(bearings[i]!, bearings[(i + 1) % legs.length]!, (R_INNER + R_OUTER) / 2)}
                  className={`wheel-corner${i === activeCorner ? ' is-active' : ''}${
                    straight ? ' is-straight' : ''
                  }${c.treatment === 'bulbOut' ? ' is-bulbed' : ''}`}
                  onClick={() => setActiveCorner(i)}
                  role="button"
                  tabIndex={0}
                  aria-label={`Corner ${i + 1}, ${c.appliedRadiusMeters.toFixed(1)} metres`}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') setActiveCorner(i);
                  }}
                />
              );
            })}

            <circle cx={SIZE / 2} cy={SIZE / 2} r={5} className="wheel-hub" />
          </svg>
        </div>

        {offsetNeighbours.length > 0 && (
          <p className="hint hint-warn">
            {offsetNeighbours.length === 1
              ? `Another junction sits ${offsetNeighbours[0]!.separationMeters.toFixed(0)} m away and the two overlap.`
              : `${offsetNeighbours.length} other junctions sit close enough to overlap this one.`}{' '}
            That is a staggered intersection. It is drawn as separate junctions on purpose —
            averaging them into one would put both side streets somewhere neither of them
            is — and any crossing that would land inside the neighbour is suppressed.
          </p>
        )}

        <ul className="leg-list">
          {legs.map((entry, i) => {
            const saved = entry.crossingDistanceWithoutBulbsMeters - entry.crossingDistanceMeters;
            return (
              <li key={`${entry.streetId}-${entry.sense}`}>
                <button
                  type="button"
                  className={`leg-row${i === activeLeg ? ' is-active' : ''}`}
                  onClick={() => setActiveLeg(i)}
                >
                  <span className="leg-name">{streetNames[entry.streetId] ?? 'Street'}</span>
                  <span className="leg-dir mono">{compass(bearings[i]!)}</span>
                  <span className="leg-cross mono" title="Kerb-to-kerb crossing distance">
                    {formatWidth(entry.crossingDistanceMeters, units, { withUnit: true })}
                    {saved > 0.01 && (
                      <em className="leg-was">
                        was {formatWidth(entry.crossingDistanceWithoutBulbsMeters, units)}
                      </em>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>

        {totalSaved > 0.01 ? (
          <p className="hint">
            Curb extensions have taken{' '}
            <b>{formatWidth(totalSaved, units, { withUnit: true })}</b> off the crossings here,
            summed across every leg.
          </p>
        ) : (
          <p className="hint">
            Crossing distance is how far a person on foot is exposed. Narrow the lanes to
            shorten it, or extend a curb at the corners.
          </p>
        )}

        <div className="btn-row">
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() =>
              legs.forEach((_, i) =>
                onLeg(i, {
                  crosswalk: everyLegMarked
                    ? null
                    : {
                        style: 'continental',
                        widthMeters: DEFAULT_CROSSWALK_WIDTH_METRES,
                        setbackMeters: 0,
                      },
                }),
              )
            }
          >
            {everyLegMarked ? 'Clear crossings' : 'Mark all crossings'}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() =>
              corners.forEach((c, i) => {
                if (c.angleDegrees > 179) return;
                onCorner(i, {
                  treatment: everyCornerBulbed ? 'plain' : 'bulbOut',
                  bulbOutMeters: DEFAULT_BULB_OUT_METRES,
                });
              })
            }
          >
            {everyCornerBulbed ? 'Remove curb extensions' : 'Extend every curb'}
          </button>
        </div>
      </section>

      {/* ------------------------------------------------------------------ crossings */}
      {leg && (
        <section className="panel">
          <header className="panel-head">
            <span className="label">Crossing · {compass(bearings[activeLeg]!)} leg</span>
            <span className="label mono">
              {formatWidth(leg.crossingDistanceMeters, units, { withUnit: true })}
            </span>
          </header>

          <label className="toggle-row">
            <input
              type="checkbox"
              checked={leg.hasCrosswalk}
              onChange={(e) =>
                onLeg(activeLeg, {
                  crosswalk: e.target.checked
                    ? {
                        style: 'continental',
                        widthMeters: DEFAULT_CROSSWALK_WIDTH_METRES,
                        setbackMeters: 0,
                      }
                    : null,
                })
              }
            />
            <span>Marked crosswalk</span>
          </label>

          {leg.hasCrosswalk && legOverride?.crosswalk && (
            <>
              <label className="field" style={{ marginTop: 9 }}>
                <span className="label">Marking</span>
                <select
                  className="text-input"
                  value={legOverride.crosswalk.style}
                  onChange={(e) =>
                    onLeg(activeLeg, {
                      crosswalk: {
                        ...legOverride.crosswalk!,
                        style: e.target.value as CrosswalkStyle,
                      },
                    })
                  }
                >
                  {CROSSWALK_STYLES.map((style) => (
                    <option key={style.id} value={style.id}>
                      {style.label}
                    </option>
                  ))}
                </select>
              </label>

              <label className="field" style={{ marginTop: 9 }}>
                <span className="label">Width ({units})</span>
                <input
                  className="text-input mono"
                  type="number"
                  min={0.5}
                  step={stepFor(units)}
                  value={formatWidth(legOverride.crosswalk.widthMeters, units)}
                  onChange={(e) => {
                    const value = Number(e.target.value);
                    if (!Number.isFinite(value) || value <= 0) return;
                    onLeg(activeLeg, {
                      crosswalk: {
                        ...legOverride.crosswalk!,
                        widthMeters: displayToMetres(value, units),
                      },
                    });
                  }}
                />
                <span className="hint">
                  Measured along the direction of traffic. 10 ft is the usual marked width.
                </span>
              </label>

              <label className="field" style={{ marginTop: 9 }}>
                <span className="label">Setback from the corner ({units})</span>
                <input
                  className="text-input mono"
                  type="number"
                  min={0}
                  step={stepFor(units)}
                  value={formatWidth(legOverride.crosswalk.setbackMeters, units)}
                  onChange={(e) => {
                    const value = Number(e.target.value);
                    if (!Number.isFinite(value) || value < 0) return;
                    onLeg(activeLeg, {
                      crosswalk: {
                        ...legOverride.crosswalk!,
                        setbackMeters: displayToMetres(value, units),
                      },
                    });
                  }}
                />
                <span className="hint">
                  Pulling the crossing back gives a turning driver room to stop after
                  leaving the junction rather than inside it.
                </span>
              </label>
            </>
          )}

          <label className="toggle-row">
            <input
              type="checkbox"
              checked={legOverride?.stopBar ?? false}
              onChange={(e) => onLeg(activeLeg, { stopBar: e.target.checked })}
            />
            <span>Stop bar</span>
          </label>

          {sections[leg.streetId] && (
            <ApproachEditor
              units={units}
              section={sections[leg.streetId]!}
              sense={leg.sense}
              // Straight on exists only if some other leg points roughly opposite this one.
              // At the stem of a T there is nowhere to go straight, and offering the
              // movement would let you paint an arrow into a building.
              hasThroughMovement={hasOppositeLeg(activeLeg)}
              override={legOverride}
              onChange={(patch) => onLeg(activeLeg, patch)}
            />
          )}
        </section>
      )}

      {/* -------------------------------------------------------------------- corner */}
      {corner && (
        <section className="panel">
          <header className="panel-head">
            <span className="label">Corner {activeCorner + 1}</span>
            <span className="label mono">{corner.angleDegrees.toFixed(0)}°</span>
          </header>

          {corner.angleDegrees > 179 ? (
            <p className="empty-note">
              This side runs straight through — there is no corner to round here.
            </p>
          ) : (
            <>
              <label className="field">
                <span className="label">Kerb return radius ({units})</span>
                <input
                  className="text-input mono"
                  type="number"
                  min={0}
                  max={30}
                  step={stepFor(units)}
                  value={formatWidth(corner.radiusMeters, units)}
                  onChange={(e) => {
                    const value = Number(e.target.value);
                    if (!Number.isFinite(value) || value < 0) return;
                    onCorner(activeCorner, { radiusMeters: displayToMetres(value, units) });
                  }}
                />
                <span className="hint">
                  The number most worth arguing down. A tighter corner forces a slower turn.
                </span>
              </label>

              <div className="btn-row">
                {[3, 4.5, 7.5].map((metres) => (
                  <button
                    key={metres}
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => onCorner(activeCorner, { radiusMeters: metres })}
                  >
                    {formatWidth(metres, units, { decimals: 0, withUnit: true })}
                  </button>
                ))}
              </div>

              {corner.clamped && (
                <div className="pill pill-warn" style={{ marginTop: 9 }}>
                  <strong>
                    Tightened to {formatWidth(corner.appliedRadiusMeters, units, { withUnit: true })}
                  </strong>
                  <span>The legs meeting here are too short or too sharp for the radius asked for.</span>
                </div>
              )}

              <label className="toggle-row">
                <input
                  type="checkbox"
                  checked={corner.treatment === 'bulbOut'}
                  onChange={(e) =>
                    onCorner(activeCorner, {
                      treatment: e.target.checked ? 'bulbOut' : 'plain',
                      bulbOutMeters: DEFAULT_BULB_OUT_METRES,
                    })
                  }
                />
                <span>Curb extension</span>
              </label>

              {corner.treatment === 'bulbOut' && (
                <label className="field" style={{ marginTop: 9 }}>
                  <span className="label">Extension ({units})</span>
                  <input
                    className="text-input mono"
                    type="number"
                    min={0}
                    step={stepFor(units)}
                    value={formatWidth(
                      override?.corners?.[activeCorner]?.bulbOutMeters ?? DEFAULT_BULB_OUT_METRES,
                      units,
                    )}
                    onChange={(e) => {
                      const value = Number(e.target.value);
                      if (!Number.isFinite(value) || value < 0) return;
                      onCorner(activeCorner, { bulbOutMeters: displayToMetres(value, units) });
                    }}
                  />
                  <span className="hint">
                    Usually the width of the parking lane it replaces — the roadway does not
                    need that space, so the crossing gets shorter for free.
                    {corner.appliedBulbOutMeters > 0 &&
                      ` Applied: ${formatWidth(corner.appliedBulbOutMeters, units, { withUnit: true })}.`}
                  </span>
                </label>
              )}

              <label className="field" style={{ marginTop: 9 }}>
                <span className="label">Daylighting ({units})</span>
                <input
                  className="text-input mono"
                  type="number"
                  min={0}
                  step={stepFor(units)}
                  value={formatWidth(corner.daylightMeters, units)}
                  onChange={(e) => {
                    const value = Number(e.target.value);
                    if (!Number.isFinite(value) || value < 0) return;
                    onCorner(activeCorner, { daylightMeters: displayToMetres(value, units) });
                  }}
                />
                <span className="hint">
                  Parking removed either side of the corner so drivers and people crossing
                  can see each other. 20 ft is a common minimum.
                </span>
              </label>

              {corner.daylightMeters === 0 && (
                <button
                  type="button"
                  className="btn btn-ghost btn-block"
                  style={{ marginTop: 8 }}
                  onClick={() => onCorner(activeCorner, { daylightMeters: DEFAULT_DAYLIGHT_METRES })}
                >
                  Daylight this corner
                </button>
              )}
            </>
          )}

          {override && (
            <button
              type="button"
              className="btn btn-ghost btn-block"
              style={{ marginTop: 8 }}
              onClick={onReset}
            >
              Reset this intersection
            </button>
          )}
        </section>
      )}

      {junction.warnings.length > 0 && (
        <section className="panel">
          <header className="panel-head">
            <span className="label">Warnings</span>
          </header>
          <ul className="warn-list">
            {junction.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
}
