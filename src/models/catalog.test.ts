// Invariants the built-in catalog has to hold. Every entry here is hand-written
// data with no compiler telling it apart from the code that reads it, so the
// only failures it produces are silent ones: a model that never enters the
// agent loop, a window too small for the prompt that would be sent to it, a
// description promising something the flags do not enable. Each assertion below
// names the specific first-run failure it exists to prevent.
import { describe, expect, it } from 'vitest';

import { TOOL_PROMPT_RESERVE } from '@/src/agent/prompt';

import { CATALOG, GB } from './catalog';

const builtIn = CATALOG.filter((m) => !m.custom);
const suggested = builtIn.filter((m) => m.suggested);

describe('catalog context windows', () => {
  // The bug this file was written for. app/index.tsx budgets an agent turn as
  // `max(512, nCtx - TOOL_PROMPT_RESERVE)`, and that floor hides the failure:
  // at nCtx 2048 the subtraction is negative, the floor quietly hands back 512,
  // and the turn is then assembled from a ~2816-token reserve plus 512 tokens of
  // history against a 2048-token window. llama.cpp does not refuse it — the
  // engine sets ctx_shift with n_keep pinned at 0, so the overflow is discarded
  // from the FRONT and eats the system message: the tool catalog and the worked
  // examples, the only place the model is told the tools exist. Requiring real
  // headroom (not merely `>`) keeps that arithmetic out of the floor entirely.
  it('gives every tools model room for the agent prompt plus real history', () => {
    for (const m of builtIn.filter((s) => s.tools)) {
      expect(m.nCtx, `${m.id} cannot hold the agent prompt`).toBeGreaterThanOrEqual(
        TOOL_PROMPT_RESERVE + 1024,
      );
    }
  });

  // The inverse, stated so the trade is deliberate rather than an oversight: a
  // model too small for the reserve must not be flagged tools-capable, no
  // matter how good it is at chat.
  it('never flags a model whose window is under the reserve as tools-capable', () => {
    for (const m of builtIn.filter((s) => s.nCtx < TOOL_PROMPT_RESERVE)) {
      expect(m.tools ?? false, `${m.id} declares tools it has no room for`).toBe(false);
    }
  });
});

describe('catalog recommendations', () => {
  // The first card in the open-by-default Medium group is what a new user reads
  // first, and the onboarding screen has just promised alarms, reminders and
  // calendar. Gemma held that slot for months, so the likely first-run path was
  // an assistant that could not do any of it.
  it('leads with a model that can actually run the agent', () => {
    expect(builtIn[0]?.tools, `${builtIn[0]?.id} leads the catalog but has no tools`).toBe(true);
  });

  // "Recommended" is the strongest word in this UI. Reserve it for models that
  // can do what the product is sold on; a vision-only pick has to earn its
  // place with a description that names what it gives up.
  it('reserves the word "Recommended" for tools-capable models', () => {
    for (const m of builtIn.filter((s) => /recommended/i.test(s.description))) {
      expect(m.tools, `${m.id} says "Recommended" but cannot act on the phone`).toBe(true);
    }
  });

  // A suggested model without tools is allowed (Gemma is the only pick that can
  // see an image) but it must say so where the user chooses, not leave the
  // "Suggested" sparkle to imply parity with the models that can act.
  it('makes a suggested model without tools state the limit in its description', () => {
    for (const m of suggested.filter((s) => !s.tools)) {
      expect(m.description, `${m.id} is suggested, cannot act, and does not say so`).toMatch(
        /cannot|no phone actions|chat and vision|chat only/i,
      );
    }
  });

  it('suggests at least one tools-capable model', () => {
    expect(suggested.some((m) => m.tools)).toBe(true);
  });
});

describe('catalog sizing', () => {
  // minRamBytes gates the "this model will likely crash it" warning on the
  // models screen. A floor at or below the download size cannot be true: the
  // weights are resident while the model runs, and the KV cache, the runtime
  // and the rest of Android sit on top of them.
  it('keeps the RAM floor above the weights it has to hold', () => {
    for (const m of builtIn) {
      expect(m.minRamBytes, `${m.id} claims to fit in less RAM than its own weights`).toBeGreaterThan(
        m.sizeBytes,
      );
    }
  });

  it('describes every built-in model with a size and a RAM floor', () => {
    for (const m of builtIn) {
      expect(m.sizeBytes, `${m.id} has no download size`).toBeGreaterThan(0);
      expect(m.minRamBytes, `${m.id} has no RAM floor`).toBeGreaterThanOrEqual(2 * GB);
    }
  });

  it('has unique ids and unique on-disk filenames', () => {
    const ids = builtIn.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    const files = builtIn.flatMap((m) => m.files.map((f) => f.filename));
    expect(new Set(files).size).toBe(files.length);
  });
});
