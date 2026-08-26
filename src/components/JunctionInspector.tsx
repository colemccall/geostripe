import { useState } from 'react';
import type { JunctionSummary } from '../map/designLayers';
import { displayToMetres, formatWidth, stepFor } from '../lib/units';
import type { DisplayUnits } from '../lib/units';

/**
 * The intersection inspector.
 *
 * Drawn as a wheel rather than listed as rows, because an intersection *is* radial: a
 * corner is only meaningful as the thing between two particular legs, and a list makes you
 * hold that mapping in your head. Clicking the corner you can see is the whole point.
 *
 * Two numbers are given top billing, because they are the argument this tool exists to
 * make. Crossing distance is how far someone on foot is exposed. Corner radius is how fast
 * a driver can take the turn. Every other control here is in service of moving those two.
 */

interface Props {
  junction: JunctionSummary;
  units: DisplayUnits;
  streetNames: Readonly<Record<string, string>>;
  overriddenCorners: readonly (number | null)[] | undefined;
  onCornerRadius: (cornerIndex: number, metres: number | null) => void;
  onReset: () => void;
}

const R_OUTER = 52;
const R_INNER = 20;
const SIZE = 132;

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

export default function JunctionInspector({
  junction,
  units,
  streetNames,
  overriddenCorners,
  onCornerRadius,
  onReset,
}: Props) {
  const [activeCorner, setActiveCorner] = useState(0);
  const corners = junction.corners;
  const legs = junction.legs;
  const corner = corners[activeCorner];

  // Bearings are not on the summary, so recover each leg's direction from its stop line:
  // the line is perpendicular to the leg, so its normal is the leg's bearing.
  const bearings = legs.map((leg) => {
    const [a, b] = leg.stopLine;
    const angle = Math.atan2(b[1] - a[1], b[0] - a[0]);
    // The stop line runs right-to-left across the leg, so the outward direction is its
    // clockwise normal.
    return (angle - Math.PI / 2 + Math.PI * 2) % (Math.PI * 2);
  });

  const widest = Math.max(...legs.map((l) => l.crossingDistanceMeters), 1);

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
            {/* Legs, drawn at a thickness proportional to how far you have to walk. */}
            {legs.map((leg, i) => {
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
                  className="wheel-leg"
                  strokeWidth={4 + 10 * (leg.crossingDistanceMeters / widest)}
                />
              );
            })}

            {/* Corners, between consecutive legs. These are the click targets. */}
            {corners.map((c, i) => {
              const from = bearings[i]!;
              const to = bearings[(i + 1) % legs.length]!;
              const straight = c.angleDegrees > 179;
              return (
                <path
                  key={`corner-${i}`}
                  d={arcPath(from, to, (R_INNER + R_OUTER) / 2)}
                  className={`wheel-corner${i === activeCorner ? ' is-active' : ''}${
                    straight ? ' is-straight' : ''
                  }`}
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

        <ul className="leg-list">
          {legs.map((leg, i) => (
            <li key={`${leg.streetId}-${leg.sense}`}>
              <span className="leg-name">{streetNames[leg.streetId] ?? 'Street'}</span>
              <span className="leg-dir mono">{compass(bearings[i]!)}</span>
              <span
                className="leg-cross mono"
                title="Kerb-to-kerb crossing distance for this leg"
              >
                {formatWidth(leg.crossingDistanceMeters, units, { withUnit: true })}
              </span>
            </li>
          ))}
        </ul>
        <p className="hint">
          Crossing distance is how far a person on foot is exposed. It follows the
          cross-section, not the corner — narrow the lanes to shorten it.
        </p>
      </section>

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
                    onCornerRadius(activeCorner, displayToMetres(value, units));
                  }}
                />
                <span className="hint">
                  The number most worth arguing down. A tighter corner forces a slower turn
                  and shortens the crossing a person has to walk around.
                </span>
              </label>

              {corner.clamped && (
                <div className="pill pill-warn" style={{ marginTop: 9 }}>
                  <strong>Tightened to {formatWidth(corner.appliedRadiusMeters, units, { withUnit: true })}</strong>
                  <span>The legs meeting here are too short or too sharp for the radius asked for.</span>
                </div>
              )}
            </>
          )}

          <div className="btn-row">
            {[3, 4.5, 7.5].map((metres) => (
              <button
                key={metres}
                type="button"
                className="btn btn-ghost"
                onClick={() => onCornerRadius(activeCorner, metres)}
              >
                {formatWidth(metres, units, { decimals: 0, withUnit: true })}
              </button>
            ))}
          </div>

          {overriddenCorners && overriddenCorners.some((c) => c !== null && c !== undefined) && (
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

/** Eight-point compass label from a maths-convention bearing. */
function compass(bearing: number): string {
  const points = ['E', 'NE', 'N', 'NW', 'W', 'SW', 'S', 'SE'];
  const index = Math.round((bearing / (Math.PI * 2)) * 8) % 8;
  return points[index]!;
}
