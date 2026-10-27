import { describe, expect, it, vi } from 'vitest';
import { AutosaveController, KEEP_VERSIONS, ago, memoryStore } from './autosave';

/** A controller on a fake clock, so debouncing is tested by advancing time, not waiting. */
function harness(opts: { text?: () => string } = {}) {
  const store = memoryStore();
  let t = 1_000;
  const timers: { at: number; fn: () => void; id: number }[] = [];
  let nextId = 1;
  let text = 'v1';
  const controller = new AutosaveController({
    store,
    read: () => ({ name: 'Test', text: opts.text ? opts.text() : text }),
    debounceMs: 1000,
    now: () => t,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.push({ at: t + ms, fn, id });
      return id;
    },
    clearTimer: (h) => {
      const i = timers.findIndex((x) => x.id === h);
      if (i >= 0) timers.splice(i, 1);
    },
  });
  const advance = async (ms: number) => {
    t += ms;
    for (const due of timers.filter((x) => x.at <= t)) {
      timers.splice(timers.indexOf(due), 1);
      due.fn();
    }
    await Promise.resolve();
    await Promise.resolve();
  };
  return {
    controller,
    store,
    advance,
    setText: (v: string) => (text = v),
    pendingTimers: () => timers.length,
  };
}

describe('autosave', () => {
  it('waits for the changes to stop, then writes once', async () => {
    const h = harness();
    h.controller.markDirty();
    h.controller.markDirty();
    h.controller.markDirty();
    expect(h.controller.getState().status).toBe('dirty');
    expect(await h.store.list()).toHaveLength(0);

    await h.advance(1000);
    await new Promise((r) => setTimeout(r, 0));
    expect(await h.store.list()).toHaveLength(1);
    expect(h.controller.getState().status).toBe('saved');
    expect(h.controller.getState().savedAt).not.toBeNull();
  });

  it('keeps pushing the write back while edits keep arriving', async () => {
    const h = harness();
    h.controller.markDirty();
    await h.advance(600);
    h.controller.markDirty();
    await h.advance(600);
    expect(await h.store.list()).toHaveLength(0);
    expect(h.pendingTimers()).toBe(1);
  });

  it('writes what is current at write time, not at change time', async () => {
    const h = harness();
    h.controller.markDirty();
    h.setText('v2');
    await h.controller.flush();
    expect((await h.store.latest())!.text).toBe('v2');
  });

  it('keeps only the most recent versions, newest first', async () => {
    const h = harness();
    for (let i = 0; i < KEEP_VERSIONS + 4; i++) {
      h.setText(`v${i}`);
      await h.controller.flush();
    }
    const rows = await h.store.list();
    expect(rows).toHaveLength(KEEP_VERSIONS);
    expect(rows[0]!.text).toBe(`v${KEEP_VERSIONS + 3}`);
  });

  it('reports unsaved work until it is stored', async () => {
    const h = harness();
    expect(h.controller.hasUnsaved).toBe(false);
    h.controller.markDirty();
    expect(h.controller.hasUnsaved).toBe(true);
    await h.controller.flush();
    expect(h.controller.hasUnsaved).toBe(false);
  });

  it('does not write while paused, so a restore offer is not overwritten', async () => {
    const h = harness();
    h.controller.pause();
    h.controller.markDirty();
    await h.controller.flush();
    expect(await h.store.list()).toHaveLength(0);
    h.controller.resume();
    h.controller.markDirty();
    await h.controller.flush();
    expect(await h.store.list()).toHaveLength(1);
  });

  it('says why it is off, and stays off', async () => {
    const h = harness();
    h.controller.disable('Another tab has this editor open.');
    h.controller.markDirty();
    await h.controller.flush();
    expect(h.controller.getState()).toMatchObject({
      status: 'disabled',
      message: 'Another tab has this editor open.',
    });
    expect(await h.store.list()).toHaveLength(0);
    expect(h.controller.hasUnsaved).toBe(false);
  });

  it('reports a failed write rather than pretending it was saved', async () => {
    const store = memoryStore();
    store.add = vi.fn().mockRejectedValue(new Error('QuotaExceededError'));
    const controller = new AutosaveController({ store, read: () => ({ name: 'x', text: 'y' }) });
    await controller.flush();
    expect(controller.getState()).toMatchObject({ status: 'error', message: 'QuotaExceededError' });
  });

  it('does not lose an edit that lands during a write', async () => {
    const h = harness();
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const original = h.store.add.bind(h.store);
    let first = true;
    h.store.add = async (entry, keep) => {
      if (first) {
        first = false;
        await gate;
      }
      return original(entry, keep);
    };

    h.setText('first');
    const writing = h.controller.flush();
    h.setText('second');
    void h.controller.flush(); // arrives mid-write
    release();
    await writing;
    expect((await h.store.latest())!.text).toBe('second');
  });
});

describe('ago', () => {
  it('reads naturally', () => {
    expect(ago(10_000, 9_000)).toBe('just now');
    expect(ago(40_000, 10_000)).toBe('30 s ago');
    expect(ago(200_000, 20_000)).toBe('3 min ago');
    expect(ago(3 * 3_600_000, 0)).toBe('3 h ago');
  });
});
