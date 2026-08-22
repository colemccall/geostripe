import { Fragment } from 'react';
import { PRIMITIVES } from '../library/primitives';
import type { Marking } from '../library/primitives';
import type { CrossSection, SectionComponent } from '../model/types';
import { componentStarts, resolveAnchorOffset, totalWidth } from '../model/section';
import { formatWidth } from '../lib/units';
import type { DisplayUnits } from '../lib/units';

/**
 * Cross-section elevation with engineering dimension lines.
 *
 * Shared deliberately: the Asset Builder renders it large and interactive, the Map
 * Editor inspector renders it small and read-only. Keeping it a pure function of
 * (section, units, variant) is what makes that possible — it holds no state of its own.
 *
 * Drawn in a fixed virtual coordinate space and scaled by the SVG viewBox, so the
 * geometry maths stays in one unit system regardless of the rendered pixel size.
 */

const VIRTUAL_WIDTH = 1000;

interface Props {
  section: CrossSection;
  units: DisplayUnits;
  variant?: 'compact' | 'full';
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  className?: string;
}

interface Metrics {
  groundY: number;
  bandHeight: number;
  raisedLift: number;
  tickY: number;
  totalDimY: number;
  height: number;
  labelSize: number;
  minLabelWidth: number;
}

function metricsFor(variant: 'compact' | 'full'): Metrics {
  return variant === 'full'
    ? {
        groundY: 116,
        bandHeight: 40,
        raisedLift: 9,
        tickY: 182,
        totalDimY: 220,
        height: 240,
        labelSize: 13,
        minLabelWidth: 34,
      }
    : {
        groundY: 30,
        bandHeight: 24,
        raisedLift: 5,
        tickY: 68,
        totalDimY: 96,
        height: 108,
        labelSize: 11,
        minLabelWidth: 46,
      };
}

/** Glyphs that make a band readable at a glance without a legend. */
function MarkingGlyph({
  marking,
  x,
  width,
  top,
  height,
  full,
}: {
  marking: Marking;
  x: number;
  width: number;
  top: number;
  height: number;
  full: boolean;
}) {
  const cx = x + width / 2;
  const stroke = '#EDE9DC';

  switch (marking) {
    case 'bike':
      return width < 14 ? null : (
        <circle
          cx={cx}
          cy={top + height * 0.55}
          r={full ? 7 : 4}
          fill="none"
          stroke={stroke}
          strokeWidth={full ? 2.2 : 1.4}
          strokeOpacity={0.9}
        />
      );
    case 'bus':
      return width < 26 ? null : (
        <text
          x={cx}
          y={top + height * 0.66}
          fill={stroke}
          fontSize={full ? 14 : 9}
          fontWeight={700}
          textAnchor="middle"
          fillOpacity={0.92}
        >
          BUS
        </text>
      );
    case 'turn':
      return width < 20 ? null : (
        <path
          d={`M${cx} ${top + height - 7}v${-(height - 15)}m-5 6l5-6 5 6`}
          fill="none"
          stroke="#E8C45A"
          strokeWidth={full ? 2.2 : 1.4}
          strokeOpacity={0.9}
        />
      );
    case 'planting':
      return width < 10 ? null : (
        <circle cx={cx} cy={top - (full ? 6 : 3)} r={full ? 10 : 5} fill="#5C8A4E" />
      );
    case 'walk':
      return width < 12 ? null : (
        <>
          {[1, 2, 3].map((k) => (
            <line
              key={k}
              x1={x + (width * k) / 4}
              y1={top + 2}
              x2={x + (width * k) / 4}
              y2={top + height - 2}
              stroke="rgba(255,255,255,.24)"
              strokeWidth={1}
            />
          ))}
        </>
      );
    case 'parking':
      return width < 18 ? null : (
        <text
          x={cx}
          y={top + height * 0.68}
          fill={stroke}
          fontSize={full ? 15 : 10}
          fontWeight={700}
          textAnchor="middle"
          fillOpacity={0.5}
        >
          P
        </text>
      );
    default:
      return null;
  }
}

function DirectionArrow({
  direction,
  x,
  width,
  top,
  height,
}: {
  direction: SectionComponent['direction'];
  x: number;
  width: number;
  top: number;
  height: number;
}) {
  if (direction !== 'forward' && direction !== 'backward') return null;
  if (width < 34) return null;
  const sign = direction === 'forward' ? 1 : -1;
  const cx = x + width / 2;
  const cy = top + height * 0.26;
  return (
    <path
      d={`M${cx - 10 * sign} ${cy}h${20 * sign}m0 0l${-7 * sign} -5m${7 * sign} 5l${-7 * sign} 5`}
      fill="none"
      stroke="#EDE9DC"
      strokeWidth={1.7}
      strokeOpacity={0.75}
    />
  );
}

export default function CrossSectionSvg({
  section,
  units,
  variant = 'full',
  selectedId = null,
  onSelect,
  className,
}: Props) {
  const { components } = section;
  const total = totalWidth(components);
  const m = metricsFor(variant);
  const full = variant === 'full';

  if (components.length === 0 || total <= 0) {
    return (
      <svg
        className={className}
        viewBox={`0 0 ${VIRTUAL_WIDTH} ${m.height}`}
        role="img"
        aria-label="Empty cross-section"
      >
        <text
          x={VIRTUAL_WIDTH / 2}
          y={m.height / 2}
          textAnchor="middle"
          fill="var(--ink-dim)"
          fontSize={m.labelSize + 1}
          fontFamily="var(--font-ui)"
        >
          No components yet — add one from the library
        </text>
      </svg>
    );
  }

  const scale = VIRTUAL_WIDTH / total;
  const starts = componentStarts(components);
  const anchorX = resolveAnchorOffset(section) * scale;

  return (
    <svg
      className={className}
      viewBox={`0 0 ${VIRTUAL_WIDTH} ${m.height}`}
      role="img"
      aria-label={`Cross-section, ${components.length} components, total ${formatWidth(total, units, { withUnit: true })}`}
    >
      {components.map((c, i) => {
        const spec = PRIMITIVES[c.componentType];
        const width = c.widthMeters * scale;
        const x = starts[i]! * scale;
        const top = spec.isRaised ? m.groundY - m.raisedLift : m.groundY;
        const height = spec.isRaised ? m.bandHeight + m.raisedLift : m.bandHeight;
        const selected = selectedId === c.id;

        return (
          <Fragment key={c.id}>
            <g
              onClick={onSelect ? () => onSelect(c.id) : undefined}
              style={onSelect ? { cursor: 'pointer' } : undefined}
            >
              <rect
                x={x}
                y={top}
                width={Math.max(width, 0.8)}
                height={height}
                fill={c.colorOverride ?? spec.color}
                stroke={selected ? 'var(--accent-fill)' : 'rgba(0,0,0,.34)'}
                strokeWidth={selected ? 2.4 : 0.8}
              />
              <MarkingGlyph
                marking={spec.marking}
                x={x}
                width={width}
                top={top}
                height={height}
                full={full}
              />
              {full && (
                <DirectionArrow
                  direction={c.direction}
                  x={x}
                  width={width}
                  top={top}
                  height={height}
                />
              )}
            </g>

            {/* per-band dimension tick and width */}
            <line
              x1={x}
              y1={m.tickY - (full ? 8 : 5)}
              x2={x}
              y2={m.tickY}
              stroke="var(--line)"
              strokeWidth={1}
            />
            {width >= m.minLabelWidth && (
              <text
                x={x + width / 2}
                y={m.tickY + m.labelSize}
                fill="var(--ink-dim)"
                fontSize={m.labelSize}
                textAnchor="middle"
                fontFamily="var(--font-mono)"
              >
                {formatWidth(c.widthMeters, units)}
              </text>
            )}
          </Fragment>
        );
      })}

      {/* closing tick */}
      <line
        x1={VIRTUAL_WIDTH}
        y1={m.tickY - (full ? 8 : 5)}
        x2={VIRTUAL_WIDTH}
        y2={m.tickY}
        stroke="var(--line)"
        strokeWidth={1}
      />

      {/* overall dimension line, tick-terminated */}
      <line
        x1={0}
        y1={m.totalDimY}
        x2={VIRTUAL_WIDTH}
        y2={m.totalDimY}
        stroke="var(--accent)"
        strokeWidth={1.4}
      />
      {[0, VIRTUAL_WIDTH].map((px) => (
        <line
          key={px}
          x1={px}
          y1={m.totalDimY - 6}
          x2={px}
          y2={m.totalDimY + 6}
          stroke="var(--accent)"
          strokeWidth={2.4}
        />
      ))}
      <text
        x={VIRTUAL_WIDTH / 2}
        y={m.totalDimY - 8}
        fill="var(--accent)"
        fontSize={m.labelSize + 2}
        fontWeight={600}
        textAnchor="middle"
        fontFamily="var(--font-mono)"
      >
        total {formatWidth(total, units, { withUnit: true })}
      </text>

      {/* where the drawn centerline lands */}
      <line
        x1={anchorX}
        y1={full ? 20 : 8}
        x2={anchorX}
        y2={m.groundY + m.bandHeight + 5}
        stroke="var(--accent-fill)"
        strokeWidth={1.5}
        strokeDasharray="5 4"
      />
      <text
        x={anchorX}
        y={full ? 13 : 6}
        fill="var(--accent)"
        fontSize={full ? 11 : 9}
        textAnchor="middle"
        fontFamily="var(--font-mono)"
        letterSpacing=".08em"
      >
        ANCHOR
      </text>
    </svg>
  );
}
