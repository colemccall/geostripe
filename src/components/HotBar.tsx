import { useMemo, useState } from 'react';
import { ASSET_FAMILIES, ASSET_FAMILY_LABELS } from '../model/asset';
import type { Asset, AssetFamily } from '../model/asset';
import { useEditorStore } from '../store/useEditorStore';
import type { BuildMode, Tool } from '../store/useEditorStore';
import { totalWidth } from '../model/section';
import { formatWidth } from '../lib/units';
import type { DisplayUnits } from '../lib/units';
import { LANDCOVERS } from '../library/landcover';
import { PRIMITIVES } from '../library/primitives';

/**
 * The build menu, along the bottom of the map.
 *
 * Modelled on a city-builder's hotbar rather than on a side panel, and the difference is
 * not decoration. A side rail takes a column of the window permanently and puts the thing
 * you are placing as far from the cursor as it can be. A hotbar sits under the map, opens
 * upward only while you are choosing, and closes again — so the map has the window for the
 * whole of the time you are actually building, which is most of it.
 *
 * Everything here is one row of icons and a drawer. The drawer is the only part that ever
 * covers the map, and it is dismissed by picking something, which is the same click you
 * were going to make anyway.
 */

interface Props {
  units: DisplayUnits;
}

const TOOL_ICONS: { id: Tool; icon: string; label: string; key: string }[] = [
  { id: 'select', icon: '➤', label: 'Select', key: 'V' },
  { id: 'build', icon: '━', label: 'Roads', key: 'B' },
  { id: 'area', icon: '▰', label: 'Ground', key: 'G' },
  { id: 'bulldoze', icon: '✖', label: 'Bulldoze', key: 'X' },
];

const MODE_ICONS: { id: BuildMode; icon: string; label: string; key: string }[] = [
  { id: 'straight', icon: '╱', label: 'Straight', key: '1' },
  { id: 'curved', icon: '⌒', label: 'Curved', key: '2' },
  { id: 'freeform', icon: '∿', label: 'Freeform', key: '3' },
];

/** The families that hold roads, in the order a builder reaches for them. */
const LINE_FAMILIES = ASSET_FAMILIES.filter((f) => f !== 'area');

const FAMILY_ICONS: Record<AssetFamily, string> = {
  highway: '⛟',
  arterial: '≡',
  street: '⋮',
  transit: '⊕',
  path: '⋯',
  area: '❑',
};

/** A plan-view slice of the asset, so the drawer is scannable without reading it. */
function Swatch({ asset }: { asset: Asset }) {
  if (asset.kind === 'area') {
    const material = LANDCOVERS[asset.material];
    return (
      <span
        className="hb-swatch hb-swatch-solid"
        style={{ background: material.color, opacity: Math.max(0.55, material.opacity) }}
      />
    );
  }
  const width = totalWidth(asset.components) || 1;
  return (
    <span className="hb-swatch">
      {asset.components.map((component) => (
        <span
          key={component.id}
          style={{
            flexGrow: component.widthMeters / width,
            background: component.colorOverride ?? PRIMITIVES[component.componentType].color,
          }}
        />
      ))}
    </span>
  );
}

export default function HotBar({ units }: Props) {
  const assets = useEditorStore((s) => s.assets);
  const tool = useEditorStore((s) => s.tool);
  const buildMode = useEditorStore((s) => s.buildMode);
  const buildLevel = useEditorStore((s) => s.buildLevel);
  const activeLineAssetId = useEditorStore((s) => s.activeLineAssetId);
  const activeAreaAssetId = useEditorStore((s) => s.activeAreaAssetId);
  const recentAssetIds = useEditorStore((s) => s.recentAssetIds);

  const setTool = useEditorStore((s) => s.setTool);
  const setBuildMode = useEditorStore((s) => s.setBuildMode);
  const setBuildLevel = useEditorStore((s) => s.setBuildLevel);
  const setActiveAsset = useEditorStore((s) => s.setActiveAsset);
  const editAsset = useEditorStore((s) => s.editAsset);
  const createAsset = useEditorStore((s) => s.createAsset);

  /** Which family's drawer is open, or null for closed. */
  const [open, setOpen] = useState<AssetFamily | null>(null);
  const [query, setQuery] = useState('');

  const active = assets.find(
    (a) => a.id === (tool === 'area' ? activeAreaAssetId : activeLineAssetId),
  );

  const drawer = useMemo(() => {
    if (!open) return [];
    const needle = query.trim().toLowerCase();
    if (needle) return assets.filter((a) => a.name.toLowerCase().includes(needle));
    return assets.filter((a) => a.family === open);
  }, [assets, open, query]);

  const recent = useMemo(
    () =>
      recentAssetIds
        .map((id) => assets.find((a) => a.id === id))
        .filter((a): a is Asset => Boolean(a))
        .slice(0, 6),
    [recentAssetIds, assets],
  );

  const pick = (asset: Asset) => {
    setActiveAsset(asset.id);
    setOpen(null);
    setQuery('');
  };

  return (
    <>
      {open && (
        <>
          {/* Clicking the map closes the drawer, the way clicking away from a game menu does. */}
          <div className="hb-scrim" onClick={() => setOpen(null)} />
          <div className="hb-drawer" role="dialog" aria-label={`${ASSET_FAMILY_LABELS[open]} assets`}>
            <header className="hb-drawer-head">
              <h2>{ASSET_FAMILY_LABELS[open]}</h2>
              <input
                type="search"
                autoFocus
                value={query}
                placeholder="Search all assets"
                onChange={(event) => setQuery(event.target.value)}
                aria-label="Search assets"
              />
              <button type="button" onClick={() => createAsset(open)}>
                + New
              </button>
              <button type="button" className="hb-close" onClick={() => setOpen(null)} aria-label="Close">
                ✕
              </button>
            </header>

            <div className="hb-grid">
              {drawer.map((asset) => (
                <button
                  key={asset.id}
                  type="button"
                  className={`hb-card${asset.id === active?.id ? ' is-active' : ''}`}
                  onClick={() => pick(asset)}
                  onDoubleClick={() => editAsset(asset.id)}
                >
                  <Swatch asset={asset} />
                  <span className="hb-card-name">{asset.name}</span>
                  <span className="hb-card-meta">
                    {asset.kind === 'line'
                      ? formatWidth(totalWidth(asset.components), units, { withUnit: true })
                      : LANDCOVERS[asset.material].label}
                  </span>
                  <span
                    className="hb-card-edit"
                    role="button"
                    tabIndex={-1}
                    title="Edit this asset — every road built with it changes"
                    onClick={(event) => {
                      event.stopPropagation();
                      editAsset(asset.id);
                    }}
                  >
                    ✎
                  </span>
                </button>
              ))}
              {drawer.length === 0 && <p className="hb-empty">Nothing here yet.</p>}
            </div>
          </div>
        </>
      )}

      <div className="hotbar" role="toolbar" aria-label="Build menu">
        <div className="hb-group">
          {TOOL_ICONS.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className={`hb-btn${tool === entry.id ? ' is-active' : ''}`}
              onClick={() => setTool(entry.id)}
              title={`${entry.label} (${entry.key})`}
            >
              <span className="hb-icon">{entry.icon}</span>
              <span className="hb-label">{entry.label}</span>
            </button>
          ))}
        </div>

        {tool === 'build' && (
          <>
            <span className="hb-sep" />
            <div className="hb-group">
              {MODE_ICONS.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className={`hb-btn${buildMode === entry.id ? ' is-active' : ''}`}
                  onClick={() => setBuildMode(entry.id)}
                  title={`${entry.label} (${entry.key})`}
                >
                  <span className="hb-icon">{entry.icon}</span>
                  <span className="hb-label">{entry.label}</span>
                </button>
              ))}
            </div>

            <span className="hb-sep" />
            <div className="hb-group hb-level" title="Page Up and Page Down">
              <button type="button" className="hb-step" onClick={() => setBuildLevel(Math.max(-2, buildLevel - 1))}>
                −
              </button>
              <span className="hb-level-read">
                {buildLevel === 0 ? 'Ground' : buildLevel > 0 ? `+${buildLevel}` : buildLevel}
              </span>
              <button type="button" className="hb-step" onClick={() => setBuildLevel(Math.min(2, buildLevel + 1))}>
                +
              </button>
            </div>
          </>
        )}

        <span className="hb-sep" />

        {/* The families, which are what a build menu is actually made of. */}
        <div className="hb-group">
          {(tool === 'area' ? (['area'] as AssetFamily[]) : LINE_FAMILIES).map((family) => (
            <button
              key={family}
              type="button"
              className={`hb-btn${open === family ? ' is-open' : ''}`}
              onClick={() => setOpen(open === family ? null : family)}
              title={ASSET_FAMILY_LABELS[family]}
            >
              <span className="hb-icon">{FAMILY_ICONS[family]}</span>
              <span className="hb-label">{ASSET_FAMILY_LABELS[family]}</span>
            </button>
          ))}
        </div>

        {recent.length > 0 && (
          <>
            <span className="hb-sep" />
            <div className="hb-group hb-recent">
              {recent.map((asset) => (
                <button
                  key={asset.id}
                  type="button"
                  className={`hb-slot${asset.id === active?.id ? ' is-active' : ''}`}
                  onClick={() => setActiveAsset(asset.id)}
                  title={asset.name}
                >
                  <Swatch asset={asset} />
                </button>
              ))}
            </div>
          </>
        )}

        {/* What is armed, at the end of the bar where the eye lands after choosing. */}
        {active && (
          <div className="hb-active" title={active.name}>
            <Swatch asset={active} />
            <span className="hb-active-name">{active.name}</span>
            <button type="button" onClick={() => editAsset(active.id)} title="Edit this asset">
              ✎
            </button>
          </div>
        )}
      </div>
    </>
  );
}
