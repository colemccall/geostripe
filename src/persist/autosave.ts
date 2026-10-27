/**
 * Autosave.
 *
 * The editor had no persistence of any kind: closing the tab, a crash or a stray refresh lost
 * the project. This keeps the last few versions of the working project in the browser and
 * offers the newest back on the next visit.
 *
 * Split in two so the logic can be tested without a browser. `AutosaveController` decides
 * when to write and reports a status; a `SnapshotStore` is where the bytes go. The browser
 * store is IndexedDB; tests use the in-memory one.
 *
 * What is written is the same GeoJSON the Save button writes (minus the derived band
 * polygons, which are large and discarded on load anyway), so a recovered project and a
 * saved file are the same thing and migrate the same way.
 */

export interface Snapshot {
  id: number;
  savedAt: number;
  name: string;
  /** Project GeoJSON text. */
  text: string;
}

export interface SnapshotStore {
  add(entry: Omit<Snapshot, 'id'>, keep: number): Promise<void>;
  latest(): Promise<Snapshot | null>;
  list(): Promise<Snapshot[]>;
  clear(): Promise<void>;
}

/** How many versions are kept. Older ones are dropped as new ones arrive. */
export const KEEP_VERSIONS = 10;

// ------------------------------------------------------------------------ memory store

export function memoryStore(): SnapshotStore {
  const rows: Snapshot[] = [];
  let next = 1;
  return {
    async add(entry, keep) {
      rows.push({ ...entry, id: next++ });
      while (rows.length > keep) rows.shift();
    },
    async latest() {
      return rows[rows.length - 1] ?? null;
    },
    async list() {
      return [...rows].reverse();
    },
    async clear() {
      rows.length = 0;
    },
  };
}

// --------------------------------------------------------------------- IndexedDB store

const DB_NAME = 'streetcity-editor';
const STORE = 'snapshots';

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export function indexedDbStore(): SnapshotStore | null {
  if (typeof indexedDB === 'undefined') return null;

  let opened: Promise<IDBDatabase> | null = null;
  const open = (): Promise<IDBDatabase> => {
    opened ??= new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return opened;
  };

  return {
    async add(entry, keep) {
      const db = await open();
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      store.add(entry);
      // Trim in the same transaction so a crash cannot leave the ring over-full or empty.
      const keys = (await request(store.getAllKeys())) as number[];
      const excess = keys.length + 1 - keep;
      for (let i = 0; i < excess; i++) store.delete(keys[i]!);
      await done(tx);
    },
    async latest() {
      const rows = await this.list();
      return rows[0] ?? null;
    },
    async list() {
      const db = await open();
      const rows = (await request(db.transaction(STORE).objectStore(STORE).getAll())) as Snapshot[];
      return rows.sort((a, b) => b.id - a.id);
    },
    async clear() {
      const db = await open();
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      await done(tx);
    },
  };
}

// ---------------------------------------------------------------------- the controller

export type SaveStatus = 'idle' | 'dirty' | 'saving' | 'saved' | 'error' | 'disabled';

export interface AutosaveState {
  status: SaveStatus;
  /** When the last successful write finished, in epoch milliseconds. */
  savedAt: number | null;
  /** Why the status is `error` or `disabled`. */
  message?: string;
}

export interface AutosaveOptions {
  store: SnapshotStore;
  /** Produces what to write. Called when the write happens, not when the change does. */
  read: () => { name: string; text: string };
  /** Wait this long after the last change before writing. */
  debounceMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export class AutosaveController {
  private state: AutosaveState = { status: 'idle', savedAt: null };
  private listeners = new Set<() => void>();
  private timer: unknown = null;
  private paused = false;
  private disabled = false;
  private writing: Promise<void> | null = null;
  private again = false;

  private readonly debounceMs: number;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (handle: unknown) => void;

  constructor(private readonly options: AutosaveOptions) {
    this.debounceMs = options.debounceMs ?? 1000;
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>));
  }

  // useSyncExternalStore contract.
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  getState = (): AutosaveState => this.state;

  private set(next: Partial<AutosaveState>) {
    this.state = { ...this.state, ...next };
    for (const l of this.listeners) l();
  }

  /**
   * Hold writes. Used while the user is deciding whether to restore the last session, so a
   * freshly opened demo does not overwrite the very thing they are about to be offered.
   */
  pause(): void {
    this.paused = true;
    this.cancelTimer();
  }

  resume(): void {
    this.paused = false;
  }

  /** Turn autosave off for this session, with the reason the user will be shown. */
  disable(message: string): void {
    this.disabled = true;
    this.cancelTimer();
    this.set({ status: 'disabled', message });
  }

  /** Something changed. Writes after the debounce. */
  markDirty(): void {
    if (this.disabled || this.paused) return;
    this.set({ status: this.state.status === 'saving' ? 'saving' : 'dirty', message: undefined });
    this.cancelTimer();
    this.timer = this.setTimer(() => {
      this.timer = null;
      void this.flush();
    }, this.debounceMs);
  }

  /** True while there is work that is not safely stored. */
  get hasUnsaved(): boolean {
    return !this.disabled && (this.state.status === 'dirty' || this.state.status === 'saving');
  }

  /** Write now, e.g. when the tab is being hidden. */
  async flush(): Promise<void> {
    if (this.disabled || this.paused) return;
    this.cancelTimer();

    // One write at a time. A change that lands mid-write schedules another straight after.
    if (this.writing) {
      this.again = true;
      return this.writing;
    }

    this.writing = (async () => {
      do {
        this.again = false;
        this.set({ status: 'saving' });
        try {
          const { name, text } = this.options.read();
          await this.options.store.add({ savedAt: this.now(), name, text }, KEEP_VERSIONS);
          if (!this.again) this.set({ status: 'saved', savedAt: this.now(), message: undefined });
        } catch (error) {
          this.set({
            status: 'error',
            message: error instanceof Error ? error.message : 'Could not write to browser storage.',
          });
          return;
        }
      } while (this.again);
    })().finally(() => {
      this.writing = null;
    });

    return this.writing;
  }

  private cancelTimer() {
    if (this.timer !== null) {
      this.clearTimer(this.timer);
      this.timer = null;
    }
  }
}

/** "12 s ago", "3 min ago", for the status line. */
export function ago(now: number, then: number): string {
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds} s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h ago`;
  return `${Math.round(hours / 24)} days ago`;
}
