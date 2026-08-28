import { describe, expect, it } from 'vitest';

import { TOOL_DEFS } from '@/src/agent/toolDefs';

import { orbLook } from './orbPhase';

// The six states the library ships. Hard-coded rather than imported so that a
// state disappearing from the package is a test failure here, not a silently
// broken animation.
const STATES = ['working', 'searching', 'solving', 'listening', 'composing', 'shaping'];

describe('orbLook', () => {
  it('reads a bare prefill as solving', () => {
    expect(orbLook({ kind: 'thinking' })).toEqual({ state: 'solving', label: 'Thinking' });
  });

  it('reads a post-tool prefill as composing', () => {
    expect(orbLook({ kind: 'composing' })).toEqual({ state: 'composing', label: 'Writing' });
  });

  it('sweeps for a tool that only reads', () => {
    expect(orbLook({ kind: 'tool', name: 'web_search' }).state).toBe('searching');
    expect(orbLook({ kind: 'tool', name: 'list_calendar_events' }).state).toBe('searching');
  });

  it('drives for a tool that changes something', () => {
    expect(orbLook({ kind: 'tool', name: 'set_alarm' }).state).toBe('working');
    expect(orbLook({ kind: 'tool', name: 'create_calendar_event' }).state).toBe('working');
  });

  // The name arrives as a plain string on the agent event; a model can emit one
  // that no longer exists, and a lookup miss must not throw inside a render.
  it('falls back to searching for a name it does not know', () => {
    expect(orbLook({ kind: 'tool', name: 'no_such_tool' }).state).toBe('searching');
    expect(orbLook({ kind: 'tool', name: '__proto__' }).state).toBe('searching');
  });

  it('maps every registered tool to a state the library ships', () => {
    for (const name of Object.keys(TOOL_DEFS)) {
      const { state, label } = orbLook({ kind: 'tool', name });
      expect(STATES, `${name} -> ${state}`).toContain(state);
      expect(label.length).toBeGreaterThan(0);
    }
  });

  // Returned objects are used as props; a fresh literal per call would make
  // every consumer re-render on every frame the phase is merely re-read.
  it('returns a stable object for the same phase', () => {
    expect(orbLook({ kind: 'thinking' })).toBe(orbLook({ kind: 'thinking' }));
    expect(orbLook({ kind: 'tool', name: 'web_search' })).toBe(
      orbLook({ kind: 'tool', name: 'web_fetch' }),
    );
  });
});
