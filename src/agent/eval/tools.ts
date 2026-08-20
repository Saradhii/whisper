// The fake phone: one executor per entry in TOOL_DEFS, reading and writing a
// plain `World` object instead of expo-calendar, expo-contacts, and friends.
//
// Two rules make this worth having rather than a pile of stubs.
//
// First, the tools are built with the REAL `defineTool` and the REAL params
// schema, so `{"hour": "seven"}` and a missing `date` are rejected by the same
// zod parse and raise the same `InvalidArguments` as on a device. The argument
// class of bug — "6pm today" arriving as 16:00, "Friday at 1pm" landing on
// Monday noon — is the one this project keeps shipping, and a fake that accepted
// anything would score every one of them as a pass.
//
// Second, the result STRINGS are copied from src/agent/tools.ts, near enough
// word for word. They are not cosmetic: "No events in that range." is the exact
// text the worked example in examples.ts teaches the model to stop on, and the
// answer note is written around results reading like these. A fake that replied
// "ok" would be evaluating a prompt nobody ships.
//
// Pure module — no Expo, no react-native — so the whole registry runs in Node.
import { atTime, mediaMatches, TOOL_DEFS } from '@/src/agent/toolDefs';
import { defineTool, type AnyTool } from '@/src/agent/types';

import type { World } from './types';

/** Calendar title reported by the fake calendar, standing in for whatever
 *  account `defaultCalendar()` picks on a real device. */
const FAKE_CALENDAR = 'Personal';

/** Local ISO with no zone suffix — the form `World.calendarEvents[].start`
 *  uses, and the form the planning note hands the model. `toISOString()` is UTC
 *  and would shift every IST evening event onto the wrong day. */
function localIso(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/**
 * Build the 18 fake tools over `world`.
 *
 * `now` is the scenario's frozen clock, and it is a parameter rather than
 * `Date.now()` because `schedule_reminder` refuses times in the past. With the
 * real clock a corpus dated 2026-08-12 would pass this month and start throwing
 * "that time has already passed" the moment the machine's date rolled past it —
 * the exact class of test that rots silently.
 */
export function buildFakeTools(world: World, now: Date = new Date()): AnyTool[] {
  /**
   * The failure injection point. A scenario names a tool in `world.failing` and
   * this throws its message instead of running — which is how the branches with
   * the most rules attached to them (a denied permission, a calendar read that
   * threw) get exercised at all. On a device they need a permission dialog and a
   * dead system provider to reproduce.
   */
  const check = (name: string): void => {
    const why = world.failing[name];
    if (why) throw new Error(why);
  };

  return [
    // --- calendar & reminders ---
    defineTool({
      name: 'create_calendar_event',
      ...TOOL_DEFS.create_calendar_event,
      execute: async (a) => {
        check('create_calendar_event');
        const start = atTime(a.date, a.hour, a.minute);
        world.calendarEvents.push({
          title: a.title,
          start: localIso(start),
          durationMinutes: a.duration_minutes,
          ...(a.location !== undefined ? { location: a.location } : {}),
        });
        return `Event "${a.title}" created for ${start.toLocaleString()} in the "${FAKE_CALENDAR}" calendar.`;
      },
    }),
    defineTool({
      name: 'list_calendar_events',
      ...TOOL_DEFS.list_calendar_events,
      execute: async (a) => {
        check('list_calendar_events');
        // Whole days, inclusive, widened the way the real executor widens them:
        // "today to today" is otherwise a zero-length window at midnight.
        const from = +atTime(a.start, 0, 0);
        const to = +atTime(a.end, 23, 59);
        const hits = world.calendarEvents
          .map((e) => ({ ...e, at: new Date(e.start) }))
          .filter((e) => +e.at >= from && +e.at <= to)
          .sort((x, y) => +x.at - +y.at);
        if (!hits.length) return 'No events in that range.';
        return hits
          .slice(0, 20)
          .map((e) => `- ${e.title} — ${e.at.toLocaleString()}`)
          .join('\n');
      },
    }),
    defineTool({
      name: 'schedule_reminder',
      ...TOOL_DEFS.schedule_reminder,
      execute: async (a) => {
        check('schedule_reminder');
        const when = atTime(a.date, a.hour, a.minute);
        // Carries the fix, not just the complaint, because the real one does:
        // told only "must be in the future", the planner moved a reminder a
        // whole day instead of an hour.
        if (+when <= +now) {
          throw new Error(
            `That time (${when.toLocaleString()}) has already passed — it is now ` +
              `${now.toLocaleTimeString()}. Call again with a later time.`,
          );
        }
        world.reminders.push({ message: a.message, at: localIso(when) });
        return `Reminder set for ${when.toLocaleString()}.`;
      },
    }),
    defineTool({
      name: 'set_alarm',
      ...TOOL_DEFS.set_alarm,
      execute: async (a) => {
        check('set_alarm');
        world.alarms.push({
          hour: a.hour,
          minute: a.minute,
          ...(a.label !== undefined ? { label: a.label } : {}),
        });
        return `Alarm set for ${a.hour}:${String(a.minute).padStart(2, '0')}.`;
      },
    }),

    // --- contacts & communication ---
    defineTool({
      name: 'search_contacts',
      ...TOOL_DEFS.search_contacts,
      execute: async (a) => {
        check('search_contacts');
        const q = a.query.trim().toLowerCase();
        const hits = world.contacts.filter((c) => c.name.toLowerCase().includes(q));
        if (!hits.length) return 'No matching contacts.';
        return hits
          .slice(0, 5)
          .map((c) => `- ${c.name}${c.phone ? ` · ${c.phone}` : ''}${c.email ? ` · ${c.email}` : ''}`)
          .join('\n');
      },
    }),
    defineTool({
      name: 'dial_number',
      ...TOOL_DEFS.dial_number,
      execute: async (a) => {
        check('dial_number');
        world.opened.push({ kind: 'dialer', detail: a.phone });
        return 'Dialer opened with the number.';
      },
    }),
    defineTool({
      name: 'compose_sms',
      ...TOOL_DEFS.compose_sms,
      execute: async (a) => {
        check('compose_sms');
        // Recipient AND body, because "text Arun I'll be late" has failed in
        // both halves: the right message to a number lifted out of the example
        // block, and the right number carrying the model's paraphrase.
        world.opened.push({ kind: 'sms', detail: `${a.phone}: ${a.message}` });
        return 'SMS composer opened; the user must press send.';
      },
    }),
    defineTool({
      name: 'compose_email',
      ...TOOL_DEFS.compose_email,
      execute: async (a) => {
        check('compose_email');
        world.opened.push({
          kind: 'email',
          detail: `${a.to}: ${a.subject ?? ''}${a.body ? ` — ${a.body}` : ''}`,
        });
        return 'Email composer opened; the user must press send.';
      },
    }),
    defineTool({
      name: 'open_maps',
      ...TOOL_DEFS.open_maps,
      execute: async (a) => {
        check('open_maps');
        world.opened.push({ kind: 'maps', detail: a.query });
        return 'Maps opened with the search.';
      },
    }),
    defineTool({
      name: 'open_url',
      ...TOOL_DEFS.open_url,
      execute: async (a) => {
        check('open_url');
        world.opened.push({ kind: 'url', detail: a.url });
        return 'Opened in the browser.';
      },
    }),

    // --- web ---
    defineTool({
      name: 'web_search',
      ...TOOL_DEFS.web_search,
      execute: async (a) => {
        check('web_search');
        const q = a.query.toLowerCase();
        const hit = Object.entries(world.webResults).find(([key]) => q.includes(key.toLowerCase()));
        // A miss is a RESULT, not an error. "No results found." is a legitimate
        // answer the model is taught to report and stop on, and turning it into
        // a throw would score the wrong branch of answerNote().
        return hit?.[1] ?? 'No results found.';
      },
    }),
    defineTool({
      name: 'web_fetch',
      ...TOOL_DEFS.web_fetch,
      execute: async (a) => {
        check('web_fetch');
        const page = world.webPages[a.url];
        // An unlisted URL is a 404, and it throws — same as the real executor.
        // "could not look" and "nothing there" are different things, and the
        // answer note has a whole branch riding on the difference.
        if (page === undefined) throw new Error('The page returned HTTP 404.');
        return page.slice(0, 4000) || 'Page had no readable text.';
      },
    }),

    // --- device ---
    defineTool({
      name: 'get_battery',
      ...TOOL_DEFS.get_battery,
      execute: async () => {
        check('get_battery');
        const { level, charging } = world.battery;
        return `Battery at ${Math.round(level * 100)}%, ${charging ? 'charging' : 'not charging'}.`;
      },
    }),
    defineTool({
      name: 'read_clipboard',
      ...TOOL_DEFS.read_clipboard,
      execute: async () => {
        check('read_clipboard');
        return world.clipboard ? `Clipboard: ${world.clipboard.slice(0, 1000)}` : 'Clipboard is empty.';
      },
    }),
    defineTool({
      name: 'write_clipboard',
      ...TOOL_DEFS.write_clipboard,
      execute: async (a) => {
        check('write_clipboard');
        world.clipboard = a.text;
        return 'Copied to clipboard.';
      },
    }),
    defineTool({
      name: 'set_brightness',
      ...TOOL_DEFS.set_brightness,
      execute: async (a) => {
        check('set_brightness');
        world.brightness = a.level;
        return `Brightness set to ${Math.round(a.level * 100)}%.`;
      },
    }),
    defineTool({
      name: 'get_location',
      ...TOOL_DEFS.get_location,
      execute: async () => {
        check('get_location');
        const pos = world.location;
        // No fix is a throw, not a made-up coordinate: a location the model
        // believes is real is worse than one it knows it does not have.
        if (!pos) throw new Error('Could not get a location fix.');
        return `Lat ${pos.latitude.toFixed(5)}, Lon ${pos.longitude.toFixed(5)} — ${pos.address ?? 'address unknown'}`;
      },
    }),

    // --- local files (media library) ---
    defineTool({
      name: 'search_phone_media',
      ...TOOL_DEFS.search_phone_media,
      execute: async (a) => {
        check('search_phone_media');
        // mediaMatches() is imported, not reimplemented — it is the thing under
        // test ("beach photos" must find beach_sunset.png), so a second copy
        // here would let the fake pass while the shipped matcher regressed.
        const hits = world.media
          .filter((m) => m.type === a.media_type && mediaMatches(m.filename, a.query))
          .sort((x, y) => +new Date(y.at) - +new Date(x.at));
        if (!hits.length) return 'No matching files found.';
        return hits
          .slice(0, 15)
          .map((m) => `- ${m.filename} (${new Date(m.at).toLocaleDateString()})`)
          .join('\n');
      },
    }),
  ];
}
