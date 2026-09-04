// The date table across a daylight-saving transition.
//
// Its own file because it has to run in a timezone that HAS daylight saving,
// and `process.env.TZ` must be set before anything touches a Date. The rest of
// the suite runs in the machine's zone; India, where this app is developed and
// tested, has no DST, which is exactly why the bug below survived.
import { describe, expect, it } from 'vitest';

import { realTools } from './__fixtures__/tools';
import { legacyPlanNote, systemPrompt, turnReference } from './prompt';

process.env.TZ = 'America/New_York';

/**
 * The rendered date table, from whichever message currently carries it.
 *
 * Deliberately not pinned to `systemPrompt`. The table has already lived in
 * two places — it moved from the per-turn note into the system prefix for
 * KV-cache reasons, `legacyPlanNote` still renders the old layout as an A/B
 * seam, and a real-model run suggests it may move back. The arithmetic is
 * wrong or right regardless of which message it is written into, so this
 * searches every message a turn can produce and asserts on whichever one has
 * it. If the table moves again, this test follows it instead of going red for
 * the wrong reason.
 */
function dateTableLine(now: Date): string {
  const request = 'what am I doing on Friday';
  const candidates = [
    systemPrompt(realTools),
    turnReference(now, request).content,
    legacyPlanNote(now, [], request).content,
  ];
  // Keyed on "This week means", which only the table renders. An earlier
  // version of this looked for a line containing "today " and a date, and that
  // matched a WORKED EXAMPLE — "User: What's on my calendar this week? (today
  // is Monday 2026-03-02)" — picking the real table only because it happens to
  // be rendered above the examples. It would have silently asserted against
  // the wrong line the moment the table moved, which is the failure this
  // whole file exists to catch a version of.
  const line = candidates
    .flatMap((text) => text.split('\n'))
    .find((l) => l.includes('This week means'));
  expect(line, 'no message rendered a date table — has it been renamed?').toBeDefined();
  return line!;
}

describe('the date table across a DST transition', () => {
  // 2026 US transitions: fall back Sunday 1 November, spring forward Sunday
  // 8 March. Rendered from 00:30 local — the only window where adding 24 hours
  // lands on the wrong side of a date boundary.
  it.each([
    ['fall back', new Date(2026, 10, 1, 0, 30)],
    ['spring forward', new Date(2026, 2, 8, 0, 30)],
    ['an ordinary day', new Date(2026, 7, 2, 0, 30)],
    ['an ordinary day, midday', new Date(2026, 7, 2, 12, 0)],
  ])('gives seven distinct consecutive days (%s)', (_label, now) => {
    // Anchored at "today ", not at the start of the line. `legacyPlanNote`
    // prefixes the table with a clock ("it is 12:30 am on Sunday, 2026-11-01.
    // Dates: today ..."), so taking the first seven dates on the line would
    // slide the window by one and report a duplicate that is not there.
    const line = dateTableLine(now);
    const table = line.slice(line.indexOf('today '));
    const dates = [...table.matchAll(/\d{4}-\d{2}-\d{2}/g)].map((m) => m[0]).slice(0, 7);
    expect(dates).toHaveLength(7);
    // The defect: `+now + i * 86_400_000` walked backwards over a fall-back, so
    // "tomorrow" rendered as today. A duplicate is the symptom that matters —
    // the model is told to COPY from this table, so a repeated date silently
    // schedules "tomorrow" for today.
    expect(new Set(dates).size, `duplicate dates: ${dates.join(', ')}`).toBe(7);
    for (let i = 1; i < dates.length; i++) {
      const step = (+new Date(`${dates[i]}T12:00:00Z`) - +new Date(`${dates[i - 1]}T12:00:00Z`))
        / 86_400_000;
      expect(step, `${dates[i - 1]} -> ${dates[i]} is not one calendar day`).toBe(1);
    }
  });

  it('still spans a full seven-day week across a fall-back', () => {
    // The same arithmetic shortened "this week" to six days, so a "what's on
    // this week" range would have silently dropped a day.
    expect(dateTableLine(new Date(2026, 10, 1, 0, 30))).toContain(
      'This week means 2026-11-01 to 2026-11-07',
    );
  });
});
