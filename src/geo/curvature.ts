import type { PlanePoint } from './projection';

/**
 * Curvature checks.
 *
 * Parallel offset curves converge on the inside of a bend. Past a certain point the offset
 * line overruns the segment it belongs to and the band folds back through itself. The
 * cleanup pass in banding.ts dissolves the resulting bowtie into the swept area, which
 * looks plausible — and that is exactly the danger, because a quietly wrong shape is worse
 * than a visibly broken one. So we detect the condition and surface it instead.
 *
 * The test at each interior vertex is the classic one: an offset of d through a turn of
 * exterior angle φ needs d·tan(φ/2) of run-out along the adjacent segments. If either
 * neighbouring segment is shorter than that, the offset self-intersects.
 */

const EPS = 1e-9;

export interface CurvatureWarning {
  /** Index of the offending vertex in the centerline. */
  vertexIndex: number;
  /** Turn angle at that vertex, in degrees (0 = straight). */
  turnDegrees: number;
  /** Run-out the offset needs, in metres. */
  requiredMeters: number;
  /** Shortest adjacent segment, in metres. */
  availableMeters: number;
}

/**
 * Find vertices where offsetting by `maxOffset` would fold back on itself.
 * `maxOffset` should be the largest absolute boundary offset in the cross-section.
 */
export function findOverruns(
  pts: readonly PlanePoint[],
  maxOffset: number,
): CurvatureWarning[] {
  const warnings: CurvatureWarning[] = [];
  const d = Math.abs(maxOffset);
  if (pts.length < 3 || d < EPS) return warnings;

  for (let i = 1; i < pts.length - 1; i++) {
    const prev = pts[i - 1]!;
    const cur = pts[i]!;
    const next = pts[i + 1]!;

    const v1x = cur.x - prev.x;
    const v1y = cur.y - prev.y;
    const v2x = next.x - cur.x;
    const v2y = next.y - cur.y;

    const len1 = Math.hypot(v1x, v1y);
    const len2 = Math.hypot(v2x, v2y);
    if (len1 < EPS || len2 < EPS) continue;

    // Exterior turn angle between the two segment directions.
    const cross = v1x * v2y - v1y * v2x;
    const dot = v1x * v2x + v1y * v2y;
    const turn = Math.abs(Math.atan2(cross, dot));
    if (turn < 1e-6) continue; // straight

    // A half-turn would need infinite run-out; clamp so the number stays reportable.
    const halfTurn = Math.min(turn / 2, Math.PI / 2 - 1e-6);
    const required = d * Math.tan(halfTurn);
    const available = Math.min(len1, len2);

    if (required > available) {
      warnings.push({
        vertexIndex: i,
        turnDegrees: (turn * 180) / Math.PI,
        requiredMeters: required,
        availableMeters: available,
      });
    }
  }

  return warnings;
}

/** One-line summary for the UI. Empty string when there is nothing to report. */
export function describeWarnings(warnings: readonly CurvatureWarning[]): string {
  if (warnings.length === 0) return '';
  const worst = warnings.reduce((a, b) => (a.turnDegrees > b.turnDegrees ? a : b));
  const where = warnings.length === 1 ? `vertex ${worst.vertexIndex}` : `${warnings.length} vertices`;
  return (
    `Bend too tight at ${where}: a ${worst.turnDegrees.toFixed(0)}° turn needs ` +
    `${worst.requiredMeters.toFixed(1)} m of run-out but only ${worst.availableMeters.toFixed(1)} m ` +
    `is available. Outer bands were cleaned up — check the geometry before exporting.`
  );
}
