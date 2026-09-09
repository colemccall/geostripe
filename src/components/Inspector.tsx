import { useEditorStore } from '../store/useEditorStore';
import { isLineAsset } from '../model/asset';
import type { LineAsset } from '../model/asset';
import { endsAt } from '../model/doc';
import { totalWidth } from '../model/section';
import { displayToMetres, formatWidth, metresToDisplay } from '../lib/units';
import type { DisplayUnits } from '../lib/units';
import { LANDCOVER_ORDER, LANDCOVERS } from '../library/landcover';
import CrossSectionSvg from './CrossSectionSvg';
import ComponentStack from './ComponentStack';
import PrimitivePalette from './PrimitivePalette';

/**
 * What is selected, and what can be done to it.
 *
 * Also where an asset is edited, which is deliberate rather than convenient. The asset
 * editor used to be its own page, reached by leaving the map — you assembled a
 * cross-section over there, came back, and stamped it onto a street. That made sense while
 * a section was a starting point. It does not once a road IS its asset: the question you
 * are actually asking is "this road is wrong, what is it made of", and the answer has to be
 * one click from the road rather than one page away.
 *
 * So selecting a road offers its asset, and editing that asset changes every road built
 * with it — which is stated in the panel, because it is the one consequence somebody could
 * be surprised by.
 */

interface Props {
  units: DisplayUnits;
}

/**
 * What a height means, in words.
 *
 * On the junction rather than on the road, because that is where height lives now. Raising
 * a junction lifts every road that meets it, and a road whose two ends differ is a ramp
 * between them — which is the same thing a game does when you drag a road up onto a bridge.
 */
const LEVEL_LABELS: Record<number, string> = {
  [-2]: 'Deep tunnel',
  [-1]: 'Tunnel',
  0: 'Ground',
  1: 'Bridge',
  2: 'High bridge',
};

export default function Inspector({ units }: Props) {
  const doc = useEditorStore((s) => s.doc);
  const assets = useEditorStore((s) => s.assets);
  const selectedSegmentId = useEditorStore((s) => s.selectedSegmentId);
  const selectedNodeId = useEditorStore((s) => s.selectedNodeId);
  const selectedAreaId = useEditorStore((s) => s.selectedAreaId);
  const editingAssetId = useEditorStore((s) => s.editingAssetId);
  const selectedComponentId = useEditorStore((s) => s.selectedComponentId);
  const defaultRadiusMeters = useEditorStore((s) => s.defaultRadiusMeters);
  const recentAssetIds = useEditorStore((s) => s.recentAssetIds);

  const store = useEditorStore.getState();

  const segment = doc.segments.find((s) => s.id === selectedSegmentId);
  const node = doc.nodes.find((n) => n.id === selectedNodeId);
  const area = doc.areas.find((a) => a.id === selectedAreaId);
  const editing = assets.find((a) => a.id === editingAssetId);

  return (
    <div className="inspector">
      {segment && (
        <section className="inspector-block">
          <h3>Road</h3>
          <label>
            Asset
            <select
              value={segment.assetId}
              onChange={(event) => store.setSegmentAsset(segment.id, event.target.value)}
            >
              {assets.filter(isLineAsset).map((asset) => (
                <option key={asset.id} value={asset.id}>
                  {asset.name}
                </option>
              ))}
            </select>
          </label>

          <RoadHeight segment={segment} />

          <div className="inspector-actions">
            <button type="button" onClick={() => store.reverseSegment(segment.id)}>
              Flip direction
            </button>
            <button
              type="button"
              onClick={() => store.editAsset(segment.assetId)}
              title="Edit the asset this road is built from"
            >
              Edit asset
            </button>
            <button type="button" onClick={() => store.bulldoze({ segmentId: segment.id })}>
              Delete
            </button>
          </div>

          <p className="inspector-note">
            To change one stretch of this road — a turn lane before a junction, say — split
            it and give the short piece a different asset.
          </p>
        </section>
      )}

      {node && (
        <section className="inspector-block">
          <h3>Junction</h3>
          <label>
            Name
            <input
              type="text"
              value={node.name ?? ''}
              placeholder="Unnamed"
              onChange={(event) => store.renameNode(node.id, event.target.value)}
            />
          </label>

          <label>
            Height
            <select
              value={node.elevation ?? 0}
              onChange={(event) => store.setNodeElevation(node.id, Number(event.target.value))}
            >
              {[-2, -1, 0, 1, 2].map((level) => (
                <option key={level} value={level}>
                  {LEVEL_LABELS[level]}
                </option>
              ))}
            </select>
          </label>

          <label>
            Kerb radius
            <input
              type="number"
              min={0}
              step={1}
              value={metresToDisplay(node.radiusMeters ?? defaultRadiusMeters, units).toFixed(1)}
              onChange={(event) =>
                store.setNodeRadius(node.id, displayToMetres(Number(event.target.value), units))
              }
            />
          </label>

          <p className="inspector-note">
            {endsAt(node.id, doc.segments).length} road(s) meet here.
            {node.radiusMeters === undefined && ' Radius comes from the roads that arrive.'}
          </p>

          <div className="inspector-actions">
            {node.radiusMeters !== undefined && (
              <button type="button" onClick={() => store.setNodeRadius(node.id, undefined)}>
                Use the roads&rsquo; radius
              </button>
            )}
            <button type="button" onClick={() => store.bulldoze({ nodeId: node.id })}>
              Delete junction and its roads
            </button>
          </div>
        </section>
      )}

      {area && (
        <section className="inspector-block">
          <h3>Ground</h3>
          <label>
            Material
            <select
              value={area.assetId}
              onChange={(event) => store.setAreaAsset(area.id, event.target.value)}
            >
              {assets
                .filter((a) => a.kind === 'area')
                .map((asset) => (
                  <option key={asset.id} value={asset.id}>
                    {asset.name}
                  </option>
                ))}
            </select>
          </label>
          <div className="inspector-actions">
            <button type="button" onClick={() => store.bulldoze({ areaId: area.id })}>
              Delete
            </button>
          </div>
        </section>
      )}

      {!segment && !node && !area && !editing && (
        <p className="inspector-empty">
          Pick an asset and click to build. Select something to change it.
        </p>
      )}

      {editing && (
        <section className="inspector-block inspector-asset">
          <header className="asset-editor-head">
            <h3>Asset</h3>
            <button type="button" onClick={() => store.editAsset(null)} aria-label="Close">
              ×
            </button>
          </header>

          <label>
            Name
            <input
              type="text"
              value={editing.name}
              onChange={(event) => store.renameAsset(editing.id, event.target.value)}
            />
          </label>

          <UsageNote assetId={editing.id} />

          {editing.kind === 'area' ? (
            <label>
              Material
              <select
                value={editing.material}
                onChange={(event) =>
                  useEditorStore.setState({
                    assets: assets.map((a) =>
                      a.id === editing.id && a.kind === 'area'
                        ? { ...a, material: event.target.value as typeof a.material }
                        : a,
                    ),
                  })
                }
              >
                {LANDCOVER_ORDER.map((material) => (
                  <option key={material} value={material}>
                    {LANDCOVERS[material].label}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <AssetSection asset={editing} units={units} selectedId={selectedComponentId} />
          )}

          <div className="inspector-actions">
            <button type="button" onClick={() => store.duplicateActiveAsset(editing.id)}>
              Duplicate
            </button>
            <button type="button" onClick={() => store.removeAsset(editing.id)}>
              Delete asset
            </button>
          </div>

          {editing.kind === 'line' && (
            <PrimitivePalette
              units={units}
              recent={recentAssetIds as never}
              onAdd={(type) => store.addComponent(editing.id, type)}
            />
          )}
        </section>
      )}
    </div>
  );
}

/**
 * What height a road runs at, which it no longer owns.
 *
 * Read-only on purpose: the answer comes from its two ends, and offering to set it here
 * would be offering to make the document contradict itself. A road that climbs is one whose
 * ends differ, and the way to make one is to raise the junction at one end.
 */
function RoadHeight({ segment }: { segment: { fromNodeId: string; toNodeId: string } }) {
  const doc = useEditorStore((s) => s.doc);
  const store = useEditorStore.getState();
  const from = doc.nodes.find((n) => n.id === segment.fromNodeId);
  const to = doc.nodes.find((n) => n.id === segment.toNodeId);
  const a = from?.elevation ?? 0;
  const b = to?.elevation ?? 0;

  if (a === b) {
    return (
      <p className="inspector-note">
        Runs at <b>{LEVEL_LABELS[a] ?? a}</b>. Height belongs to the junctions at either end —
        select one to change it.
      </p>
    );
  }

  return (
    <p className="inspector-note">
      A ramp, from <b>{LEVEL_LABELS[a] ?? a}</b> to <b>{LEVEL_LABELS[b] ?? b}</b>.{' '}
      <button
        type="button"
        className="link-btn"
        onClick={() => from && store.selectNode(from.id)}
      >
        Select the low end
      </button>
    </p>
  );
}

/** How many roads this asset is holding up, which is what makes an edit consequential. */
function UsageNote({ assetId }: { assetId: string }) {
  const doc = useEditorStore((s) => s.doc);
  const count =
    doc.segments.filter((s) => s.assetId === assetId).length +
    doc.areas.filter((a) => a.assetId === assetId).length;

  if (count === 0) return <p className="inspector-note">Not built anywhere yet.</p>;
  return (
    <p className="inspector-note">
      {count} in this project. Editing this changes all of them.
    </p>
  );
}

function AssetSection({
  asset,
  units,
  selectedId,
}: {
  asset: LineAsset;
  units: DisplayUnits;
  selectedId: string | null;
}) {
  const store = useEditorStore.getState();

  return (
    <>
      <CrossSectionSvg
        section={asset}
        units={units}
        variant="compact"
        selectedId={selectedId}
        onSelect={store.selectComponent}
      />
      <p className="inspector-note">
        {formatWidth(totalWidth(asset.components), units, { withUnit: true })} overall
      </p>

      <ComponentStack
        components={asset.components}
        units={units}
        selectedId={selectedId}
        onSelect={store.selectComponent}
        onWidth={(id, metres) => store.setComponentWidth(asset.id, id, metres)}
        onDirection={(id, direction) => store.setComponentDirection(asset.id, id, direction)}
        onMove={(id, delta) => store.moveComponent(asset.id, id, delta)}
        onRemove={(id) => store.removeComponent(asset.id, id)}
        onDuplicate={(id) => store.duplicateComponent(asset.id, id)}
        onMarkings={(id, patch) => store.patchComponent(asset.id, id, patch)}
      />

      <div className="inspector-actions">
        <button type="button" onClick={() => store.mirrorAsset(asset.id)}>
          Mirror
        </button>
        <button type="button" onClick={() => store.setAssetAnchor(asset.id, 'travelway')}>
          Centre on carriageway
        </button>
        <button type="button" onClick={() => store.setAssetAnchor(asset.id, 'geometric')}>
          Centre overall
        </button>
      </div>
    </>
  );
}
