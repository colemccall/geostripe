/**
 * Unit handling.
 *
 * Widths are stored in metres everywhere — in state, in asset JSON, and in exported
 * GeoJSON — with no exceptions. Feet exist only at the display boundary. US street
 * design is discussed in feet, so the UI defaults to feet, but a stored value is never
 * a converted one: converting on the way in and out of state accumulates rounding error
 * and makes "3.0 m" become 9.8 ft become 2.987 m.
 */

export type DisplayUnits = 'ft' | 'm';

/** Exact, by international definition. */
export const METRES_PER_FOOT = 0.3048;
export const FEET_PER_METRE = 1 / METRES_PER_FOOT;

export function metresToDisplay(metres: number, units: DisplayUnits): number {
  return units === 'ft' ? metres * FEET_PER_METRE : metres;
}

export function displayToMetres(value: number, units: DisplayUnits): number {
  return units === 'ft' ? value * METRES_PER_FOOT : value;
}

/** Sensible increment for a width stepper in the active unit. */
export function stepFor(units: DisplayUnits): number {
  return units === 'ft' ? 0.5 : 0.1;
}

export function unitLabel(units: DisplayUnits): string {
  return units;
}

interface FormatOptions {
  /** Append the unit symbol. Default false. */
  withUnit?: boolean;
  /** Override the decimal places. Defaults to 1 for feet, 2 for metres. */
  decimals?: number;
}

/**
 * Format a stored metre value for display. Defaults differ per unit because a tenth of
 * a foot (~3 cm) is a meaningful design increment, while a tenth of a metre is coarse.
 */
export function formatWidth(
  metres: number,
  units: DisplayUnits,
  { withUnit = false, decimals }: FormatOptions = {},
): string {
  const dp = decimals ?? (units === 'ft' ? 1 : 2);
  const text = metresToDisplay(metres, units).toFixed(dp);
  return withUnit ? `${text} ${units}` : text;
}

const METRES_PER_MILE = 1609.344;
const SQUARE_METRES_PER_ACRE = 4046.8564224;

/**
 * A distance that is long enough to be read in kilometres or miles, with its unit.
 *
 * `formatWidth` is for the small things in a cross-section; this is for totals over a plan.
 */
export function formatDistance(metres: number, units: DisplayUnits): string {
  if (units === 'ft') {
    return metres >= METRES_PER_MILE / 10
      ? `${(metres / METRES_PER_MILE).toFixed(2)} mi`
      : `${(metres * FEET_PER_METRE).toFixed(0)} ft`;
  }
  return metres >= 100 ? `${(metres / 1000).toFixed(2)} km` : `${metres.toFixed(0)} m`;
}

/** A length for a control, in the display unit, short. */
export function formatLength(metres: number, units: DisplayUnits): string {
  return units === 'ft' ? `${(metres * FEET_PER_METRE).toFixed(0)} ft` : `${metres.toFixed(0)} m`;
}

/** An area in acres (feet) or hectares (metres), or square units when small. */
export function formatArea(squareMetres: number, units: DisplayUnits): string {
  if (units === 'ft') {
    return squareMetres >= SQUARE_METRES_PER_ACRE / 10
      ? `${(squareMetres / SQUARE_METRES_PER_ACRE).toFixed(2)} ac`
      : `${(squareMetres * FEET_PER_METRE * FEET_PER_METRE).toFixed(0)} sq ft`;
  }
  return squareMetres >= 1000
    ? `${(squareMetres / 10000).toFixed(2)} ha`
    : `${squareMetres.toFixed(0)} m²`;
}
