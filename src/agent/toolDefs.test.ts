import { describe, expect, it } from 'vitest';

import { TOOL_DEFS, isoDate } from './toolDefs';
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
    expect(schema.properties.start!.type).toBe('string'); // ISO string, not Date
    expect(schema.required).toContain('title');
    expect(schema.required).not.toContain('end');
  });

  it('parses and labels valid model arguments (transforms applied)', () => {
    const parsed = TOOL_DEFS.create_calendar_event.params.parse({
      title: 'Dentist',
      start: '2026-07-10T15:00:00',
    });
    expect(parsed.start).toBeInstanceOf(Date);
    expect(TOOL_DEFS.create_calendar_event.label(parsed)).toContain('Dentist');
  });

  it('rejects invalid datetimes and out-of-range numbers', () => {
    expect(isoDate('x').safeParse('not-a-date').success).toBe(false);
    expect(TOOL_DEFS.set_alarm.params.safeParse({ hour: 25, minute: 0 }).success).toBe(false);
    expect(TOOL_DEFS.set_brightness.params.safeParse({ level: 2 }).success).toBe(false);
  });

  it('applies defaults for search_phone_media', () => {
    expect(TOOL_DEFS.search_phone_media.params.parse({})).toEqual({
      query: '',
      media_type: 'photo',
    });
  });
});
