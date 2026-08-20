import { describe, expect, it } from 'vitest';

import { TOOL_DEFS } from '@/src/agent/toolDefs';
import { InvalidArguments } from '@/src/agent/types';

import { buildFakeTools } from './tools';
import { emptyWorld, type World } from './types';

const NOW = new Date('2026-08-12T09:15');

function setup(patch: Partial<World> = {}) {
  const world = emptyWorld(patch);
  const tools = buildFakeTools(world, NOW);
  const call = (name: string, args: unknown) => {
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`no fake tool named ${name}`);
    return tool.run(args);
  };
  return { world, tools, call };
}

describe('buildFakeTools', () => {
  it('covers every declared tool, exactly once', () => {
    const { tools } = setup();
    expect(tools.map((t) => t.name).sort()).toEqual(Object.keys(TOOL_DEFS).sort());
  });

  it('carries the real confirmation and mutation flags', () => {
    // These drive the confirmation card and the branch answerNote() takes, so a
    // fake that dropped them would score a whole class of turn wrongly.
    const { tools } = setup();
    const alarm = tools.find((t) => t.name === 'set_alarm')!;
    expect(alarm.requiresConfirmation).toBe(true);
    expect(alarm.mutates).toBe(true);
    expect(tools.find((t) => t.name === 'get_battery')!.mutates).toBeUndefined();
  });

  it('rejects bad arguments through the real schema', async () => {
    // The point of building these with defineTool: "6pm" as an hour has to fail
    // here for the same reason and with the same error as it fails on a phone.
    const { call } = setup();
    await expect(call('set_alarm', { hour: 'seven' })).rejects.toBeInstanceOf(InvalidArguments);
    await expect(call('set_alarm', { hour: 25, minute: 0 })).rejects.toThrow(/Invalid arguments/);
    await expect(call('list_calendar_events', { start: 'Friday', end: 'Friday' })).rejects.toThrow(
      /not a date/,
    );
  });

  it('throws whatever world.failing names, so the failure branches are reachable', async () => {
    const { call } = setup({ failing: { list_calendar_events: 'Permission for calendar was denied by the user.' } });
    await expect(call('list_calendar_events', { start: '2026-08-12', end: '2026-08-12' })).rejects.toThrow(
      /Permission for calendar/,
    );
  });
});

describe('fake tools: world mutation', () => {
  it('set_alarm writes the alarm and reports it the way the real tool does', async () => {
    const { world, call } = setup();
    await expect(call('set_alarm', { hour: 7, minute: 0, label: 'Gym' })).resolves.toBe(
      'Alarm set for 7:00.',
    );
    expect(world.alarms).toEqual([{ hour: 7, minute: 0, label: 'Gym' }]);
  });

  it('create_calendar_event stores a local ISO start, never UTC', async () => {
    // toISOString() would shift an IST evening event onto the next day, and
    // every date assertion in the corpus is written in local time.
    const { world, call } = setup();
    await call('create_calendar_event', {
      title: 'Dentist',
      date: '2026-08-14',
      hour: 13,
      minute: 30,
    });
    expect(world.calendarEvents[0]).toMatchObject({
      title: 'Dentist',
      start: '2026-08-14T13:30',
      durationMinutes: 60,
    });
  });

  it('list_calendar_events covers whole days and reports an empty range as an answer', async () => {
    const { call } = setup({
      calendarEvents: [{ title: 'Standup', start: '2026-08-12T09:30', durationMinutes: 15 }],
    });
    await expect(call('list_calendar_events', { start: '2026-08-12', end: '2026-08-12' })).resolves.toMatch(
      /Standup/,
    );
    await expect(call('list_calendar_events', { start: '2026-08-13', end: '2026-08-13' })).resolves.toBe(
      'No events in that range.',
    );
  });

  it('schedule_reminder refuses a past time against the FROZEN clock', async () => {
    // Against Date.now() this assertion would flip from pass to fail purely
    // because the machine's calendar moved.
    const { call, world } = setup();
    await expect(
      call('schedule_reminder', { message: 'call plumber', date: '2026-08-12', hour: 8, minute: 0 }),
    ).rejects.toThrow(/already passed/);
    await call('schedule_reminder', { message: 'call plumber', date: '2026-08-12', hour: 21, minute: 0 });
    expect(world.reminders).toEqual([{ message: 'call plumber', at: '2026-08-12T21:00' }]);
  });

  it('records handoffs that change nothing on a real phone either', async () => {
    const { world, call } = setup();
    await expect(call('compose_sms', { phone: '+91 98450 12345', message: 'running late' })).resolves.toBe(
      'SMS composer opened; the user must press send.',
    );
    await call('open_maps', { query: 'Blossom Book House' });
    expect(world.opened).toEqual([
      { kind: 'sms', detail: '+91 98450 12345: running late' },
      { kind: 'maps', detail: 'Blossom Book House' },
    ]);
  });

  it('reads device state out of the world', async () => {
    const { world, call } = setup({
      battery: { level: 0.42, charging: true },
      clipboard: 'hello',
      location: { latitude: 12.9716, longitude: 77.5946, address: 'Bengaluru' },
    });
    await expect(call('get_battery', {})).resolves.toBe('Battery at 42%, charging.');
    await expect(call('read_clipboard', {})).resolves.toBe('Clipboard: hello');
    await expect(call('get_location', {})).resolves.toMatch(/12\.97160.*Bengaluru/);
    await call('write_clipboard', { text: 'copied' });
    await call('set_brightness', { level: 0.8 });
    expect(world.clipboard).toBe('copied');
    expect(world.brightness).toBe(0.8);
  });

  it('answers the web from canned results and 404s an unlisted page', async () => {
    const { call } = setup({
      webResults: { 'rain in bangalore': '- Yes, showers this evening.\n  https://example.com' },
      webPages: { 'https://example.com/a': 'the page text' },
    });
    await expect(call('web_search', { query: 'will there be rain in Bangalore today' })).resolves.toMatch(
      /showers/,
    );
    await expect(call('web_search', { query: 'something else' })).resolves.toBe('No results found.');
    await expect(call('web_fetch', { url: 'https://example.com/a' })).resolves.toBe('the page text');
    // A missing page THROWS. "could not look" and "nothing there" are different
    // things and answerNote() branches on the difference.
    await expect(call('web_fetch', { url: 'https://example.com/b' })).rejects.toThrow(/HTTP 404/);
  });

  it('searches media through the shipped matcher, not a second copy of it', async () => {
    const { call } = setup({
      media: [
        { filename: 'beach_sunset.png', type: 'photo', at: '2026-08-01T18:00' },
        { filename: 'invoice.pdf', type: 'photo', at: '2026-08-02T10:00' },
      ],
    });
    await expect(call('search_phone_media', { query: 'beach photos' })).resolves.toMatch(/beach_sunset/);
    await expect(call('search_phone_media', { query: 'holiday', media_type: 'video' })).resolves.toBe(
      'No matching files found.',
    );
  });
});
