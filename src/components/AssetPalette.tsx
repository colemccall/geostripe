import { useMemo, useState } from 'react';
import { ASSET_FAMILY_LABELS, ASSET_FAMILIES } from '../model/asset';
import type { Asset, AssetFamily } from '../model/asset';
import { useEditorStore } from '../store/useEditorStore';
import { totalWidth } from '../model/section';
import { formatWidth } from '../lib/units';
import type { DisplayUnits } from '../lib/units';
import { LANDCOVERS } from '../library/landcover';
import { PRIMITIVES } from '../library/primitives';

/**
 * The palette: what you pick up before you build anything.
 *
 * Modelled on a road-building game's build menu rather than on the preset list it replaces,
 * and the difference is not presentation. A preset was a stamp — you chose one, it was
 * copied into the street, and the two had nothing to do with each other afterwards. An
 * asset stays the road's type, so this list is not a set of starting points, it is the set
 * of things that exist in this project. Picking one arms the build tool; that is the whole
 * interaction.
 *
 * Families across the top, because a list holding six-lane freeways and gravel footpaths in
 * one column is unusable at any length. Recently used above the list, because building one
 * neighbourhood uses the same three assets over and over.
 */

interface Props {
  units: DisplayUnits;
}

/** A small plan-view swatch of the asset, so the list is scannable without reading it. */
function Swatch({ asset }: { asset: Asset }) {
  if (asset.kind === 'area') {
    const material = LANDCOVERS[asset.material];
    return (
      <span
        className="asset-swatch asset-swatch-area"
        style={{ background: material.color, opacity: Math.max(0.5, material.opacity) }}
      />
    );
  }

  const width = totalWidth(asset.components) || 1;
  return (
    <span className="asset-swatch">
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

export default function AssetPalette({ units }: Props) {
  const assets = useEditorStore((s) => s.assets);
  const activeLineAssetId = useEditorStore((s) => s.activeLineAssetId);
  const activeAreaAssetId = useEditorStore((s) => s.activeAreaAssetId);
  const recentAssetIds = useEditorStore((s) => s.recentAssetIds);
  const tool = useEditorStore((s) => s.tool);
  const setActiveAsset = useEditorStore((s) => s.setActiveAsset);
  const editAsset = useEditorStore((s) => s.editAsset);
  const createAsset = useEditorStore((s) => s.createAsset);

  const [family, setFamily] = useState<AssetFamily>('street');
  const [query, setQuery] = useState('');

  const active = tool === 'area' ? activeAreaAssetId : activeLineAssetId;

  const shown = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (needle) {
      // Search flattens the families. Somebody typing "bus" wants every bus asset, not the
      // bus assets that happen to be filed where they are standing.
      return assets.filter((asset) => asset.name.toLowerCase().includes(needle));
    }
    return assets.filter((asset) => asset.family === family);
  }, [assets, family, query]);

  const recent = useMemo(
    () =>
      recentAssetIds
        .map((id) => assets.find((a) => a.id === id))
        .filter((a): a is Asset => Boolean(a)),
    [recentAssetIds, assets],
  );

  const row = (asset: Asset) => (
    <li key={asset.id}>
      <button
        type="button"
        className={`asset-row${asset.id === active ? ' is-active' : ''}`}
        onClick={() => setActiveAsset(asset.id)}
        onDoubleClick={() => editAsset(asset.id)}
        title={
          asset.kind === 'line'
            ? `${formatWidth(totalWidth(asset.components), units, { withUnit: true })} overall`
            : LANDCOVERS[asset.material].note
        }
      >
        <Swatch asset={asset} />
        <span className="asset-name">{asset.name}</span>
        {asset.kind === 'line' && (
          <span className="asset-width">
            {formatWidth(totalWidth(asset.components), units, { withUnit: true })}
          </span>
        )}
      </button>
      <button
        type="button"
        className="asset-edit"
        onClick={() => editAsset(asset.id)}
        aria-label={`Edit ${asset.name}`}
        title="Edit this asset — every road built with it changes"
      >
        ✎
      </button>
    </li>
  );

  return (
    <section className="palette">
      <header className="palette-head">
        <input
          type="search"
          value={query}
          placeholder="Search assets"
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Search assets"
        />
        <button
          type="button"
          onClick={() => createAsset(family)}
          title="Create a new asset in this family"
        >
          New
        </button>
      </header>

      {!query && (
        <nav className="palette-families" aria-label="Asset families">
          {ASSET_FAMILIES.map((id) => (
            <button
              key={id}
              type="button"
              className={id === family ? 'is-active' : ''}
              onClick={() => setFamily(id)}
            >
              {ASSET_FAMILY_LABELS[id]}
            </button>
          ))}
        </nav>
      )}

      {!query && recent.length > 0 && (
        <>
          <h3 className="palette-heading">Recent</h3>
          <ul className="asset-list">{recent.map(row)}</ul>
        </>
      )}

      <h3 className="palette-heading">
        {query ? `${shown.length} match${shown.length === 1 ? '' : 'es'}` : ASSET_FAMILY_LABELS[family]}
      </h3>
      <ul className="asset-list">{shown.map(row)}</ul>
      {shown.length === 0 && <p className="palette-empty">Nothing here yet.</p>}
    </section>
  );
}
