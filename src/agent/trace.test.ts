import { beforeEach, describe, expect, it, vi } from 'vitest';

import * as Trace from './trace';

beforeEach(() => {
  Trace.setEnabled(false);
  Trace.clear();
});

describe('agent trace', () => {
  it('records nothing while disabled', () => {
    Trace.add('plan', 'call set_alarm');
    expect(Trace.list()).toHaveLength(0);
  });

  it('records once enabled', () => {
    Trace.setEnabled(true);
    Trace.add('plan', 'call set_alarm', { detail: '{"tool":"set_alarm"}', ms: 42 });
    const [entry] = Trace.list();
    expect(entry).toMatchObject({
      kind: 'plan',
      label: 'call set_alarm',
      detail: '{"tool":"set_alarm"}',
      ms: 42,
    });
  });

  it('returns newest first', () => {
    Trace.setEnabled(true);
    Trace.add('plan', 'first');
    Trace.add('tool', 'second');
    expect(Trace.list().map((e) => e.label)).toEqual(['second', 'first']);
  });

  it('tags entries with the turn they belong to', () => {
    Trace.setEnabled(true);
    const a = Trace.startTurn();
    Trace.add('plan', 'in turn a');
    const b = Trace.startTurn();
    Trace.add('plan', 'in turn b');
    expect(b).toBe(a + 1);
    const byLabel = new Map(Trace.list().map((e) => [e.label, e.turn]));
    expect(byLabel.get('in turn a')).toBe(a);
    expect(byLabel.get('in turn b')).toBe(b);
  });

  it('bounds the buffer so a long session cannot grow without limit', () => {
    Trace.setEnabled(true);
    for (let i = 0; i < 400; i++) Trace.add('plan', `step ${i}`);
    const entries = Trace.list();
    expect(entries.length).toBeLessThanOrEqual(300);
    // Oldest fall off the front; the newest is always retained.
    expect(entries[0]!.label).toBe('step 399');
  });

  it('notifies subscribers so the viewer re-renders live', () => {
    const listener = vi.fn();
    const unsubscribe = Trace.subscribe(listener);
    Trace.setEnabled(true);
    const before = Trace.getVersion();
    Trace.add('tool', 'set_alarm ok');
    expect(Trace.getVersion()).toBeGreaterThan(before);
    expect(listener).toHaveBeenCalled();
    unsubscribe();
  });

  it('flattens to shareable text with relative timestamps', () => {
    Trace.setEnabled(true);
    Trace.add('warn', 'planner skipped an action request', { detail: 'yes' });
    const text = Trace.toText();
    expect(text).toMatch(/\[\+0\.00s\] turn \d+ warn\s+planner skipped an action request/);
    expect(text).toContain('    yes');
  });

  it('says so when there is nothing to share', () => {
    expect(Trace.toText()).toMatch(/No agent activity/);
  });
});
