// The specification for the conversational fast path.
//
// The load-bearing test is `never skips a turn that needs a tool`: it runs the
// gate over every user message in the scenario corpus that expects a call, and
// fails if the gate would have routed even one of them past the planner. A
// false skip is the narrate-instead-of-act bug, which is silent and tells the
// user their alarm is set. Widen the vocabulary in fastPath.ts only with this
// green.
import { describe, expect, it } from 'vitest';

import { ALL_SCENARIOS } from './eval/scenarios';
import { skipsPlanning } from './fastPath';

/** Every (message, needs-a-tool) pair the corpus declares. */
const TURNS = ALL_SCENARIOS.flatMap((s) =>
  s.turns.map((t) => ({
    id: s.id,
    user: t.user,
    needsTool: (t.expect?.calls?.length ?? 0) > 0,
  })),
);

describe('skipsPlanning', () => {
  it('has a corpus to check against', () => {
    expect(TURNS.length).toBeGreaterThan(20);
    expect(TURNS.some((t) => t.needsTool)).toBe(true);
    expect(TURNS.some((t) => !t.needsTool)).toBe(true);
  });

  // THE safety property. Not a sample — every tool turn in the corpus.
  it('never skips a turn that needs a tool', () => {
    const falseSkips = TURNS.filter((t) => t.needsTool && skipsPlanning(t.user)).map(
      (t) => `${t.id}: ${t.user}`,
    );
    expect(falseSkips).toEqual([]);
  });

  it('skips the plain pleasantries it exists for', () => {
    for (const msg of [
      'hi',
      'Hello!',
      'hey there',
      'Morning!',
      'Thanks, that was perfect',
      'thank you so much',
      'Thanks, that is all for now',
      'ok cool',
      'Goodbye!',
    ]) {
      expect(skipsPlanning(msg), msg).toBe(true);
    }
  });

  it('plans anything that could want a tool', () => {
    for (const msg of [
      'wake me at 7',                      // no tool word, still an action
      'set an alarm',
      "what's on my calendar",
      'remind me to stretch',
      'search the web for the score',
      'good morning, any events today?',   // greeting PLUS a request
      "thanks — now what's the battery at", // gratitude PLUS a request
      'how do I get to the station',
      'text Arun',
      'what is the capital of France',     // a question, not a pleasantry
    ]) {
      expect(skipsPlanning(msg), msg).toBe(false);
    }
  });

  it('is not fooled by digits or length', () => {
    expect(skipsPlanning('hi 7')).toBe(false);
    expect(skipsPlanning('thanks '.repeat(20))).toBe(false);
  });

  it('needs an anchor, not just filler', () => {
    expect(skipsPlanning('is that all for now')).toBe(false);
    expect(skipsPlanning('how is it going today')).toBe(false);
  });

  it('ignores empty and whitespace input', () => {
    expect(skipsPlanning('')).toBe(false);
    expect(skipsPlanning('   ')).toBe(false);
  });
});
