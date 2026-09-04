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

  // THE REGRESSION THAT KILLED THE FIRST DESIGN, pinned as a CLASS.
  //
  // The bag-of-words gate accepted any sentence built from safe words as long
  // as one was an anchor — so a greeting donated the anchor and an arbitrary
  // question rode along behind it. These are not just the two sentences that
  // were reported; the shape is "greeting + question made of innocent words",
  // and a future widening of PHRASES must not reopen it.
  it('never lets a greeting carry a question past the gate', () => {
    const greetings = ['hey', 'hi', 'hello', 'ok', 'morning', 'thanks', 'cool'];
    const questions = [
      'how much work is there today',
      'how is work going',
      'how much is there',
      'is there much on today',
      'what is on today',
      'how long is it',
      'are we done for the day',
      'how much time do i have',
    ];
    for (const g of greetings) {
      for (const q of questions) {
        // The question alone must plan...
        expect(skipsPlanning(q), q).toBe(false);
        // ...and prefixing it with a pleasantry must not change that.
        for (const joined of [`${g} ${q}`, `${g}, ${q}`, `${g}! ${q}?`]) {
          expect(skipsPlanning(joined), joined).toBe(false);
        }
      }
    }
  });

  // The specific sentences that were observed, kept alongside the class so a
  // failure names something concrete.
  it('plans the exact sentences that defeated the vocabulary gate', () => {
    expect(skipsPlanning('hey how much work is there today')).toBe(false);
    expect(skipsPlanning('ok so how is work going')).toBe(false);
  });

  // A pleasantry followed by another pleasantry is still a pleasantry — this is
  // what makes phrase composition safe where word composition was not.
  it('accepts sequences of whole pleasantries', () => {
    for (const msg of [
      'Morning! How are you doing today?',
      'Perfect, thanks — that is all for now',
      'ok cool thanks',
      'thanks, that was perfect',
      'Alright, goodnight',
    ]) {
      expect(skipsPlanning(msg), msg).toBe(true);
    }
  });

  it('is not fooled by digits or length', () => {
    expect(skipsPlanning('hi 7')).toBe(false);
    expect(skipsPlanning('thanks '.repeat(20))).toBe(false);
  });

  // Named for the old "anchor word" rule, which no longer exists — the property
  // survives it: a near-miss of a listed phrase is not a phrase, and the whole
  // message must match end to end. "that is all for now" is listed; the
  // interrogative "is that all for now" is not, and neither is "how is it
  // going" with a stray word hung off it.
  it('rejects near-misses of a listed phrase', () => {
    expect(skipsPlanning('is that all for now')).toBe(false);
    expect(skipsPlanning('how is it going today')).toBe(false);
    expect(skipsPlanning('thanks for the alarm')).toBe(false);
    expect(skipsPlanning('good morning what is on')).toBe(false);
  });

  it('ignores empty and whitespace input', () => {
    expect(skipsPlanning('')).toBe(false);
    expect(skipsPlanning('   ')).toBe(false);
  });
});
