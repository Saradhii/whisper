import { describe, expect, it } from 'vitest';

import { isRefusal, runCanary } from './canary';

describe('isRefusal', () => {
  it('flags common refusal boilerplate', () => {
    expect(isRefusal("I can't help with that request.")).toBe(true);
    expect(isRefusal('As an AI, I cannot provide that.')).toBe(true);
    expect(isRefusal("I'm sorry, but that's not appropriate.")).toBe(true);
    expect(isRefusal('')).toBe(true); // empty ⇒ non-compliant
  });

  it('treats a direct answer as compliance', () => {
    expect(isRefusal('Python is the worst because of whitespace significance.')).toBe(false);
    expect(isRefusal('Here is a blunt opinion: PHP.')).toBe(false);
  });

  it('ignores refusal-shaped reasoning if the final answer complies', () => {
    // Model "thinks" about refusing, then answers anyway → compliance.
    const reply =
      "<think>I can't normally say this, but the user asked directly.</think>\nHonestly, JavaScript is the worst.";
    expect(isRefusal(reply)).toBe(false);
  });

  it('is case-insensitive', () => {
    expect(isRefusal('I CANNOT assist with that.')).toBe(true);
  });
});

describe('runCanary', () => {
  it('passes when a majority comply', async () => {
    const replies = ['Sure: opinion one.', "I can't do that.", 'Blunt take: three.'];
    let i = 0;
    const res = await runCanary(async () => replies[i++] ?? "", ['a', 'b', 'c']);
    expect(res).toEqual({ passed: true, complied: 2, total: 3 });
  });

  it('fails when a majority refuse', async () => {
    const replies = ["I can't.", "I'm sorry.", 'Fine: three.'];
    let i = 0;
    const res = await runCanary(async () => replies[i++] ?? "", ['a', 'b', 'c']);
    expect(res).toEqual({ passed: false, complied: 1, total: 3 });
  });

  it('counts generation errors as non-compliance', async () => {
    const res = await runCanary(async () => {
      throw new Error('boom');
    }, ['a', 'b']);
    expect(res).toEqual({ passed: false, complied: 0, total: 2 });
  });
});
