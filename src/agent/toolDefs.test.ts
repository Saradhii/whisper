import { describe, expect, it } from 'vitest';

import { isoDay, mediaMatches, TOOL_DEFS } from './toolDefs';
import { paramsToJsonSchema } from './types';

const entries = Object.entries(TOOL_DEFS);

describe('TOOL_DEFS registry', () => {
  // Regression: schemas containing .transform() made z.toJSONSchema throw at
  // module load — i.e. the app crashed on OPEN, before any UI. This walks the
  // real registry through the same conversion defineTool uses, so adding a
  // schema zod can't convert turns the build red instead of bricking the APK.
  it.each(entries)('%s converts to a model-facing JSON Schema', (_name, def) => {
    const schema = paramsToJsonSchema(def.params) as { type?: string };
    expect(schema.type).toBe('object');
    expect(() => JSON.stringify(schema)).not.toThrow();
  });

  it('declares transformed params by their INPUT type (what the model sends)', () => {
    const schema = paramsToJsonSchema(TOOL_DEFS.create_calendar_event.params) as {
      properties: Record<string, { type?: string }>;
      required: string[];
    };
    expect(schema.properties.date!.type).toBe('string'); // YYYY-MM-DD, not Date
    expect(schema.properties.hour!.type).toBe('integer');
    expect(schema.required).toContain('title');
    expect(schema.required).not.toContain('duration_minutes'); // has a default
  });

  it('parses and labels valid model arguments (transforms applied)', () => {
    const parsed = TOOL_DEFS.create_calendar_event.params.parse({
      title: 'Dentist',
      date: '2026-07-10',
      hour: 15,
    });
    expect(parsed.date).toBeInstanceOf(Date);
    expect(parsed.minute).toBe(0);
    expect(TOOL_DEFS.create_calendar_event.label(parsed)).toContain('Dentist');
  });

  it('rejects invalid datetimes and out-of-range numbers', () => {
    expect(isoDay('x').safeParse('not-a-date').success).toBe(false);
    expect(isoDay('x').safeParse('2026-07-10').success).toBe(true);
    // 1pm as "1" instead of 13 is the mistake to catch at the boundary.
    expect(TOOL_DEFS.schedule_reminder.params.safeParse({ message: 'x', date: '2026-07-10', hour: 24 }).success).toBe(false);
    expect(TOOL_DEFS.set_alarm.params.safeParse({ hour: 25, minute: 0 }).success).toBe(false);
    expect(TOOL_DEFS.set_brightness.params.safeParse({ level: 2 }).success).toBe(false);
  });

  it('matches media by words, not by the whole phrase', () => {
    // "beach photos" used to miss beach_sunset.png, because the entire query
    // was tested as one substring of the filename.
    expect(mediaMatches('beach_sunset.png', 'beach photos')).toBe(true);
    expect(mediaMatches('beach_sunset.png', 'my beach pictures')).toBe(true);
    expect(mediaMatches('IMG_20260801_lunch.png', 'lunch')).toBe(true);
    expect(mediaMatches('beach_sunset.png', 'mountain')).toBe(false);
    // A query with nothing specific in it means "whatever is most recent".
    expect(mediaMatches('anything.png', 'recent photos')).toBe(true);
    expect(mediaMatches('anything.png', '')).toBe(true);
  });

  it('applies defaults for search_phone_media', () => {
    expect(TOOL_DEFS.search_phone_media.params.parse({})).toEqual({
      query: '',
      media_type: 'photo',
    });
  });
});
