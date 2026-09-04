// Guards the ablation landmarks against `planNote()` being reworded.
//
// This runs in `npm run check` — it needs no model and no runner, because
// `ablate()` is a pure string function and `real/engine.ts` has no runtime
// imports at all. That matters: the ablation is the proof that the real-model
// gate can detect the failure class it was built for, and an ablation that
// quietly stopped cutting anything would report "removing the date table
// changed nothing", i.e. it would disprove the harness by breaking silently.
// So the landmarks are pinned here, against the real rendered note.
import { describe, expect, it } from 'vitest';

import { planNote } from '@/src/agent/prompt';

import { ablate } from './engine';

const NOW = new Date('2026-08-12T09:15');
const note = () => planNote(NOW, [], 'What is on my calendar this week?').content;

describe('ablate', () => {
  it('leaves anything that is not a plan note alone', () => {
    expect(ablate('You are Whisper, a helpful assistant.', 'dates')).toBeNull();
    expect(ablate('Result of list_calendar_events: No events in that range.', 'anchors')).toBeNull();
  });

  it('is a no-op in "none" mode', () => {
    expect(ablate(note(), 'none')).toBeNull();
  });

  it('finds the date table in the real rendered note', () => {
    // If this fails, `anchors()` has been reworded and every ablation below is
    // silently cutting nothing.
    expect(note()).toContain('Dates: today 2026-08-12');
    expect(note()).toContain('This week means 2026-08-12 to 2026-08-18');
  });

  it('"dates" removes the seven-day table but keeps the clock and relative times', () => {
    const cut = ablate(note(), 'dates');
    expect(cut).not.toBeNull();
    // Gone: the six future dates the model would otherwise copy, and the span
    // it reads "this week" off.
    expect(cut).not.toContain('tomorrow 2026-08-13');
    expect(cut).not.toContain('2026-08-18');
    expect(cut).not.toContain('This week means');
    // TODAY's date survives, because it is in the clock sentence that precedes
    // the table (and in the system prompt besides). That is the intended
    // condition: the ablation removes the LOOKUP TABLE, not the model's sense
    // of what day it is — otherwise a drop could be explained away as "it no
    // longer knew the date" rather than "it had to do calendar arithmetic".
    expect(cut).toContain('2026-08-12');
    // Kept: the wall clock and the relative-time anchors, so a drop in the
    // score is attributable to the DATE table specifically.
    expect(cut).toContain('09:15');
    expect(cut).toContain('Wednesday');
    expect(cut).toContain('in an hour');
    // Kept: the user's actual request, which planNote repeats last.
    expect(cut).toContain('What is on my calendar this week?');
  });

  it('"anchors" removes the whole reference block after the clock', () => {
    const cut = ablate(note(), 'anchors');
    expect(cut).not.toContain('Dates:');
    expect(cut).not.toContain('in an hour');
    expect(cut).not.toContain('This week means');
    expect(cut).toContain('09:15');
    expect(cut).toContain('What is on my calendar this week?');
    // The reference block must still be a closed bracket — a cut that ate the
    // `]` would leave the model reading the protocol reminder as reference
    // material, which is a different (and much larger) change than the one
    // being tested.
    expect(cut).toContain('2026-08-12. ]');
  });

  it('shrinks the note, which is the whole point', () => {
    const full = note();
    expect(ablate(full, 'dates')!.length).toBeLessThan(full.length);
    expect(ablate(full, 'anchors')!.length).toBeLessThan(ablate(full, 'dates')!.length);
  });

  it('throws rather than cutting nothing when an end landmark moves', () => {
    // A note that starts the table but never closes it: the failure mode this
    // guard exists for is a SILENT no-op, so it must be loud.
    expect(() => ablate('[Reference — Dates: today 2026-08-12, tomorrow', 'anchors')).toThrow(
      /planNote\(\) has been reworded/,
    );
  });
});
