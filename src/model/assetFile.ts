import type { CrossSection } from './types';
import { toAssetFile } from './schema';

/**
 * Download and upload for asset files.
 *
 * The file *is* the sharing mechanism — there is no backend, no account, and no server
 * round-trip. Someone builds a cross-section, downloads the JSON, sends it to whoever,
 * and they load it into their own palette.
 */

export function assetFilename(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${slug || 'cross-section'}.json`;
}

export function serializeAsset(section: CrossSection): string {
  return `${JSON.stringify(toAssetFile(section), null, 2)}\n`;
}

/** Trigger a browser download of the given text. */
export function downloadText(filename: string, text: string, mime = 'application/json'): void {
  const blob = new Blob([text], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Revoking immediately can cancel the download in some browsers; defer a tick.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadAsset(section: CrossSection): void {
  downloadText(assetFilename(section.name), serializeAsset(section));
}

/**
 * Open a file picker and resolve with the chosen file's text, or null if dismissed.
 *
 * Cancellation is genuinely awkward to detect: browsers fire no event for it. The
 * `cancel` event covers modern browsers, and the window-focus fallback catches the rest
 * so the promise never dangles forever.
 */
export function pickTextFile(accept = 'application/json,.json'): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    document.body.appendChild(input);

    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(value);
    };

    input.addEventListener('change', () => {
      const file = input.files?.[0];
      if (!file) return finish(null);
      file
        .text()
        .then(finish)
        .catch(() => finish(null));
    });

    input.addEventListener('cancel', () => finish(null));

    window.addEventListener(
      'focus',
      () => {
        // Runs before 'change' on some browsers, so give the picker a moment to report.
        setTimeout(() => {
          if (!input.files?.length) finish(null);
        }, 400);
      },
      { once: true },
    );

    input.click();
  });
}
