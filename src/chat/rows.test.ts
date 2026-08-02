import { describe, expect, it } from 'vitest';

import {
  appendText,
  applyToolEvent,
  cancelConfirms,
  isMachinery,
  resolveConfirm,
  toStored,
  type UiMessage,
} from './rows';

const user = (content: string): UiMessage => ({ id: 'u1', role: 'user', content });
const bubble = (id: string, content: string): UiMessage => ({ id, role: 'assistant', content });
const planRow = (id: string, step: number): UiMessage => ({
  id,
  role: 'assistant',
  content: '',
  plan: { step, text: '{"respond": true}' },
});
const confirmRow = (id: string): UiMessage => ({
  id,
  role: 'assistant',
  content: '',
  confirm: { name: 'set_alarm', label: 'Set alarm 7:00' },
});

describe('appendText', () => {
  it('grows the trailing assistant bubble', () => {
    const next = appendText([user('hi'), bubble('a', 'Hel')], 'lo', 'new');
    expect(next).toHaveLength(2);
    expect(next[1]!.content).toBe('Hello');
  });

  it('starts a new bubble after a user turn', () => {
    const next = appendText([user('hi')], 'Hello', 'new');
    expect(next).toHaveLength(2);
    expect(next[1]).toMatchObject({ id: 'new', role: 'assistant', content: 'Hello' });
  });

  it('does NOT append into a planning row', () => {
    // The shipped bug: a plan row is role:'assistant' with no tool/error, so a
    // `!tool && !error` test appended the whole final answer into a field
    // PlanRow never renders. On device this looked like the agent setting an
    // alarm and then replying with nothing at all.
    const next = appendText([user('set an alarm'), planRow('p1', 1)], 'Alarm set for 7:00.', 'new');
    expect(next).toHaveLength(3);
    expect(next[1]!.plan).toBeDefined();
    expect(next[1]!.content).toBe(''); // plan row untouched
    expect(next[2]).toMatchObject({ id: 'new', content: 'Alarm set for 7:00.' });
  });

  it('does NOT append into a pending confirmation card', () => {
    const next = appendText([confirmRow('c1')], 'text', 'new');
    expect(next).toHaveLength(2);
    expect(next[0]!.content).toBe('');
  });

  it('does NOT append into a tool chip or an error bubble', () => {
    const withChip = applyToolEvent([], { name: 'echo', label: 'Echo', status: 'done' }, 't1');
    expect(appendText(withChip, 'hi', 'n1')).toHaveLength(2);
    const err: UiMessage = { id: 'e1', role: 'assistant', content: 'boom', error: true };
    expect(appendText([err], 'hi', 'n2')).toHaveLength(2);
  });
});

describe('applyToolEvent', () => {
  it('appends a chip when nothing matches', () => {
    const next = applyToolEvent([user('x')], { name: 'echo', label: 'Echo', status: 'running' }, 't1');
    expect(next[1]!.tool).toEqual({ name: 'echo', label: 'Echo', status: 'running' });
  });

  it('settles the running chip rather than appending a second one', () => {
    let rows = applyToolEvent([], { name: 'echo', label: 'Echo', status: 'running' }, 't1');
    rows = applyToolEvent(rows, { name: 'echo', label: 'Echo', status: 'done' }, 't2');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tool!.status).toBe('done');
  });

  it('settles a chip a confirmation card already turned to denied', () => {
    // Deny converts the card to a denied chip immediately; the loop then emits
    // its own denied event. Without matching 'denied' too, that appends a
    // duplicate chip right under the first.
    const denied = resolveConfirm([confirmRow('c1')], 'c1', false);
    const next = applyToolEvent(denied, { name: 'set_alarm', label: 'Set alarm 7:00', status: 'denied' }, 't1');
    expect(next).toHaveLength(1);
    expect(next[0]!.tool!.status).toBe('denied');
  });

  it('keeps distinct labels as separate chips', () => {
    let rows = applyToolEvent([], { name: 'a', label: 'A', status: 'running' }, 't1');
    rows = applyToolEvent(rows, { name: 'b', label: 'B', status: 'running' }, 't2');
    expect(rows).toHaveLength(2);
  });
});

describe('resolveConfirm / cancelConfirms', () => {
  it('allow converts the card into a running chip in place', () => {
    const next = resolveConfirm([user('x'), confirmRow('c1')], 'c1', true);
    expect(next).toHaveLength(2);
    expect(next[1]!.confirm).toBeUndefined();
    expect(next[1]!.tool).toEqual({ name: 'set_alarm', label: 'Set alarm 7:00', status: 'running' });
  });

  it('deny converts it to a denied chip', () => {
    const next = resolveConfirm([confirmRow('c1')], 'c1', false);
    expect(next[0]!.tool!.status).toBe('denied');
  });

  it('leaves other rows alone', () => {
    const next = resolveConfirm([bubble('a', 'hi'), confirmRow('c1')], 'c1', true);
    expect(next[0]).toEqual(bubble('a', 'hi'));
  });

  it('stopping declines every card still waiting', () => {
    const next = cancelConfirms([confirmRow('c1'), confirmRow('c2')]);
    expect(next.every((m) => !m.confirm && m.tool?.status === 'denied')).toBe(true);
  });
});

describe('isMachinery', () => {
  it('classifies every non-prose row', () => {
    expect(isMachinery(bubble('a', 'hi'))).toBe(false);
    expect(isMachinery(user('hi'))).toBe(false);
    expect(isMachinery(planRow('p', 0))).toBe(true);
    expect(isMachinery(confirmRow('c'))).toBe(true);
    expect(isMachinery({ ...bubble('t', ''), tool: { name: 'e', label: 'E', status: 'done' } })).toBe(true);
    expect(isMachinery({ ...bubble('e', 'x'), error: true })).toBe(true);
  });
});

describe('toStored', () => {
  it('drops system turns and unanswered confirmation cards', () => {
    expect(toStored({ id: 's', role: 'system', content: 'x' } as UiMessage)).toEqual([]);
    expect(toStored(confirmRow('c1'))).toEqual([]);
  });

  it('stores an interrupted running chip as failed, not eternally spinning', () => {
    const [stored] = toStored({
      ...bubble('t', ''),
      tool: { name: 'echo', label: 'Echo', status: 'running' },
    });
    expect(stored!.tool!.status).toBe('error');
  });

  it('round-trips a plan row', () => {
    const [stored] = toStored(planRow('p1', 2));
    expect(stored!.plan).toEqual({ step: 2, text: '{"respond": true}' });
  });

  it('keeps a plain bubble intact', () => {
    expect(toStored(bubble('a', 'hello'))).toEqual([
      { id: 'a', role: 'assistant', content: 'hello' },
    ]);
  });
});
