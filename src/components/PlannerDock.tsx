import { useDeferredValue, useMemo, useState } from 'react';
import { assetMap } from '../library/assets';
import { LAND_USES, LAND_USE_IDS } from '../library/landuse';
import { ASSET_FAMILY_LABELS } from '../model/asset';
import type { AssetFamily } from '../model/asset';
import { computeStats } from '../model/stats';
import { useEditorStore } from '../store/useEditorStore';
import type { ViewMode } from '../store/useEditorStore';
import { formatArea, formatDistance } from '../lib/units';
import type { DisplayUnits } from '../lib/units';
import { legendFor } from '../map/views';

/**
 * The planner's dock: info views and the numbers behind the drawing.
 *
 * Collapsed to a tab by default, so it takes no map until it is wanted. The statistics are
 * measurements of what is drawn (lengths, ground taken, land given to each use) and are
 * computed from the document on demand, only while the tab is open.
 */

const VIEWS: { id: ViewMode; label: string; hint: string }[] = [
  { id: 'none', label: 'Normal', hint: 'The drawing over the imagery.' },
  { id: 'landUse', label: 'Land use', hint: 'Zones in bold, imagery dimmed.' },
  { id: 'roadType', label: 'Road type', hint: 'Roads coloured by highway, arterial, street.' },
  { id: 'height', label: 'Height', hint: 'Tunnels, ground level and raised roads.' },
  { id: 'district', label: 'Districts', hint: 'Planning districts emphasised.' },
];

function ViewsTab() {
  const view = useEditorStore((s) => s.view);
  const setView = useEditorStore((s) => s.setView);
  const legend = legendFor(view);
  return (
    <div className="dock-body">
      <div className="dock-list" role="radiogroup" aria-label="Info view">
        {VIEWS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="radio"
            aria-checked={view === entry.id}
            className={`dock-item${view === entry.id ? ' is-active' : ''}`}
            onClick={() => setView(entry.id)}
            title={entry.hint}
          >
            {entry.label}
          </button>
        ))}
      </div>
      {view === 'landUse' && (
        <ul className="dock-legend">
          {LAND_USE_IDS.map((id) => (
            <li key={id}>
              <i style={{ background: LAND_USES[id].color }} />
              {LAND_USES[id].label}
            </li>
          ))}
        </ul>
      )}
      {legend.length > 0 && (
        <ul className="dock-legend">
          {legend.map((entry) => (
            <li key={entry.label}>
              <i style={{ background: entry.color }} />
              {entry.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Row({ label, value, swatch }: { label: string; value: string; swatch?: string }) {
  return (
    <div className="stat-row">
      <span>
        {swatch && <i style={{ background: swatch }} />}
        {label}
      </span>
      <b>{value}</b>
    </div>
  );
}

function StatsTab({ units }: { units: DisplayUnits }) {
  const doc = useEditorStore((s) => s.doc);
  const assets = useEditorStore((s) => s.assets);
  // Measuring is not urgent; keep typing and dragging responsive and catch up after.
  const deferredDoc = useDeferredValue(doc);
  const stats = useMemo(() => computeStats(deferredDoc, assetMap(assets)), [deferredDoc, assets]);

  const uses = LAND_USE_IDS.filter((id) => (stats.landUseSquareMetres[id] ?? 0) > 0);
  const totalLand = uses.reduce((sum, id) => sum + (stats.landUseSquareMetres[id] ?? 0), 0);

  return (
    <div className="dock-body">
      <h3>Roads</h3>
      <Row label="Length" value={formatDistance(stats.roads.lengthMetres, units)} />
      <Row label="Lane length" value={formatDistance(stats.roads.laneMetres, units)} />
      <Row label="Right-of-way" value={formatArea(stats.roads.rightOfWayAreaSquareMetres, units)} />
      {Object.entries(stats.roads.byFamily).map(([family, f]) => (
        <Row
          key={family}
          label={ASSET_FAMILY_LABELS[family as AssetFamily] ?? family}
          value={formatDistance(f.lengthMetres, units)}
        />
      ))}

      <h3>Land use</h3>
      {uses.length === 0 && <p className="dock-empty">Nothing zoned yet.</p>}
      {uses.map((id) => (
        <Row
          key={id}
          label={LAND_USES[id].label}
          swatch={LAND_USES[id].color}
          value={formatArea(stats.landUseSquareMetres[id] ?? 0, units)}
        />
      ))}
      {uses.length > 0 && <Row label="Total" value={formatArea(totalLand, units)} />}

      <h3>Buildings</h3>
      <Row label="Footprints" value={String(stats.buildingCount)} />

      <h3>Districts</h3>
      {stats.districts.length === 0 && <p className="dock-empty">No districts yet.</p>}
      {stats.districts.map((district) => (
        <details key={district.id} className="stat-district">
          <summary>
            <i style={{ background: district.color }} />
            {district.name} <b>{formatArea(district.totalSquareMetres, units)}</b>
          </summary>
          {Object.entries(district.byLandUse).map(([id, m2]) => (
            <Row
              key={id}
              label={LAND_USES[id as keyof typeof LAND_USES]?.label ?? id}
              value={formatArea(m2, units)}
            />
          ))}
        </details>
      ))}
    </div>
  );
}

export default function PlannerDock({ units }: { units: DisplayUnits }) {
  const [tab, setTab] = useState<'views' | 'stats' | null>(null);

  return (
    <aside className={`planner-dock${tab ? ' is-open' : ''}`} aria-label="Planner">
      <div className="dock-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'views'}
          onClick={() => setTab(tab === 'views' ? null : 'views')}
        >
          Views
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'stats'}
          onClick={() => setTab(tab === 'stats' ? null : 'stats')}
        >
          Stats
        </button>
      </div>
      {tab === 'views' && <ViewsTab />}
      {tab === 'stats' && <StatsTab units={units} />}
    </aside>
  );
}
