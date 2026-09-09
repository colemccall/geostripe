import i75 from './i75.geojson?raw';
import cincinnati from './cincinnati.geojson?raw';
import { parseProject } from '../model/io';
import { builtInAssets } from '../library/assets';
import type { Asset } from '../model/asset';
import type { Doc } from '../model/doc';

/**
 * The projects the editor ships with.
 *
 * Both are stored in the native format, so opening one costs a parse rather than a
 * conversion — they were written by the old street-based editor and were converted once,
 * on disk, rather than on every startup. Anything still in the old format is converted on
 * load like any other file; see `convertLegacy` in model/io.ts.
 */

export type DemoId = 'i75' | 'cincinnati';

const SOURCES: Record<DemoId, { text: string; name: string }> = {
  i75: { text: i75, name: 'I-75 alternative' },
  cincinnati: { text: cincinnati, name: 'Cincinnati downtown' },
};

export const DEMOS: { id: DemoId; label: string }[] = [
  { id: 'i75', label: 'I-75 interchange' },
  { id: 'cincinnati', label: 'Cincinnati downtown' },
];

export interface DemoProject {
  doc: Doc;
  assets: Asset[];
  name: string;
}

export function loadDemo(id: DemoId): DemoProject {
  const source = SOURCES[id];
  const parsed = parseProject(source.text, builtInAssets());
  return { doc: parsed.doc, assets: parsed.assets, name: source.name };
}
