// Tool DECLARATIONS: name → params schema, label, description, confirmation
// flag. Pure module (zod only, no Expo imports) so the test suite can prove
// every schema converts to JSON Schema and parses/labels correctly — the
// executors in tools.ts bind these to real device APIs.
import { z } from 'zod';

/**
 * A calendar day, as YYYY-MM-DD.
 *
 * These tools used to take a full ISO-8601 datetime, and the model could not
 * produce one: on device, "Friday at 1pm" became Monday 12:00 and "6pm today"
 * became 16:00. Meanwhile set_alarm — hour and minute as plain integers — was
 * right every single time. So the datetime is split: the DATE is copied from
 * the table in the planning note, and the TIME is two integers. Neither
 * requires the model to format anything or do arithmetic.
 */
export const isoDay = (field: string) =>
  z
    .string()
    // The prefix used to repeat what the argument's own key already says —
    // `date: (the day of the event as YYYY-MM-DD)`, `start: (first day as
    // YYYY-MM-DD)`. `YYYY-MM-DD` is the load-bearing half and is pinned by
    // prompt.test.ts; the label is kept for the zod error message, which the
    // model never sees but a developer does.
    .describe('YYYY-MM-DD')
    .transform((s, ctx) => {
      const m = /^\s*(\d{4})-(\d{2})-(\d{2})/.exec(s);
      const d = m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : new Date(NaN);
      if (isNaN(+d)) {
        ctx.addIssue({
          code: 'custom',
          message: `${field}: "${s}" is not a date in YYYY-MM-DD form`,
        });
        return z.NEVER;
      }
      return d;
    });

export const hourField = z
  .number()
  .int()
  .min(0)
  .max(23)
  .describe('hour on a 24-hour clock, so 1pm is 13 and 6pm is 18');

// "6pm today" came back as 6:28 PM — the hour right, the minute copied off the
// current clock. On the hour is what people mean unless they say otherwise.
export const minuteField = z
  .number()
  .int()
  .min(0)
  .max(59)
  .default(0)
  .describe('minutes past the hour; 0 unless a specific minute was asked for');

/** Combine a day with an hour and minute, in the phone's own timezone. */
export function atTime(day: Date, hour: number, minute: number): Date {
  const d = new Date(day);
  d.setHours(hour, minute, 0, 0);
  return d;
}

export const httpUrl = z
  .string()
  .describe('http(s) URL')
  .refine((u) => /^https?:\/\//.test(u), 'must be an http(s) URL');

// Labels are read at a glance on a chip mid-conversation, so they are written
// the way a person would say them. `toLocaleString()` ("8/3/2026, 1:00:00 PM")
// and bare ISO ("2026-08-03") both make the user decode a machine timestamp to
// check the agent understood "Friday at one".
const day = (d: Date) =>
  d.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
const at = (d: Date) =>
  `${day(d)}, ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;

/**
 * Does a filename satisfy a media search?
 *
 * The first version tested `filename.includes(query)`, so "beach photos" missed
 * `beach_sunset.png` — nobody types a filename, they describe the picture. The
 * query is split into words, the generic ones dropped, and every remaining word
 * has to appear somewhere in the name. Pure and exported so the behaviour is
 * pinned by tests rather than discovered on a phone.
 */
const MEDIA_STOP_WORDS = new Set([
  'a', 'all', 'any', 'file', 'files', 'find', 'from', 'image', 'images', 'me',
  'my', 'of', 'photo', 'photos', 'picture', 'pictures', 'recent', 'show',
  'the', 'video', 'videos',
]);

export function mediaMatches(filename: string, query: string): boolean {
  const words = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !MEDIA_STOP_WORDS.has(w));
  if (!words.length) return true; // nothing specific asked for — most recent wins
  const name = filename.toLowerCase();
  return words.every((w) => name.includes(w));
}

/** Identity helper that binds `label`'s argument type to the params schema. */
function def<S extends z.ZodRawShape>(d: {
  description: string;
  params: z.ZodObject<S>;
  label: (args: z.infer<z.ZodObject<S>>) => string;
  requiresConfirmation?: boolean;
  mutates?: boolean;
}) {
  return d;
}

export const TOOL_DEFS = {
  // --- calendar & reminders ---
  create_calendar_event: def({
    description:
      'Create an event in the user calendar. Give the title as the event name only, without the words the user used to ask for it.',
    params: z.object({
      title: z.string(),
      date: isoDay('the day of the event'),
      hour: hourField,
      minute: minuteField,
      duration_minutes: z.number().int().min(5).max(1440).default(60),
      location: z.string().optional(),
    }),
    label: (a) => `Create “${a.title}” · ${at(atTime(a.date, a.hour, a.minute))}`,
    requiresConfirmation: true,
    mutates: true,
  }),
  list_calendar_events: def({
    description:
      'List calendar events over a range of days, inclusive. Copy both dates from the date list in the note.',
    params: z.object({ start: isoDay('first day'), end: isoDay('last day') }),
    label: (a) =>
      day(a.start) === day(a.end)
        ? `Read calendar · ${day(a.start)}`
        : `Read calendar · ${day(a.start)} → ${day(a.end)}`,
  }),
  schedule_reminder: def({
    description: 'Schedule a reminder notification on a given day at a given time.',
    params: z.object({
      message: z.string(),
      date: isoDay('the day of the reminder'),
      hour: hourField,
      minute: minuteField,
    }),
    label: (a) => `Remind “${a.message}” · ${at(atTime(a.date, a.hour, a.minute))}`,
    requiresConfirmation: true,
    mutates: true,
  }),
  set_alarm: def({
    description: 'Set an alarm in the system clock app.',
    params: z.object({
      hour: z.number().int().min(0).max(23),
      minute: z.number().int().min(0).max(59),
      label: z.string().optional(),
    }),
    label: (a) => `Set alarm ${a.hour}:${String(a.minute).padStart(2, '0')}`,
    requiresConfirmation: true,
    mutates: true,
  }),
  // --- contacts & communication ---
  search_contacts: def({
    // "by name" was the whole discriminator, and "name" is ambiguous — the name
    // of a thing reads as well as the name of a person. On the emulator this
    // description won "what is the capital of France" over web_search: three
    // tools in the catalog open with the word "Search", and nothing here said
    // what this one is NOT for. Naming the argument type (a person) is the part
    // that separates it from the other two.
    description:
      'Search the user contacts for a PERSON by name — never for a topic, a place, or a fact. Returns names, phone numbers, emails.',
    params: z.object({ query: z.string() }),
    label: (a) => `Search contacts for “${a.query}”`,
  }),
  dial_number: def({
    description: 'Open the phone dialer with a number (the user places the call).',
    params: z.object({ phone: z.string() }),
    label: (a) => `Open dialer for ${a.phone}`,
    mutates: true,
  }),
  compose_sms: def({
    description: 'Open the SMS composer prefilled with recipient and message (the user sends it).',
    params: z.object({ phone: z.string(), message: z.string() }),
    label: (a) => `Compose SMS to ${a.phone}`,
    mutates: true,
  }),
  compose_email: def({
    description: 'Open the email composer prefilled (the user sends it).',
    params: z.object({
      to: z.string(),
      subject: z.string().optional(),
      body: z.string().optional(),
    }),
    label: (a) => `Compose email to ${a.to}`,
    mutates: true,
  }),
  open_maps: def({
    description: 'Open the maps app searching for a place or address.',
    params: z.object({ query: z.string() }),
    label: (a) => `Open maps: “${a.query}”`,
    mutates: true,
  }),
  open_url: def({
    description: 'Open a URL in the browser.',
    params: z.object({ url: httpUrl }),
    label: (a) => `Open ${a.url}`,
    mutates: true,
  }),
  // --- web ---
  web_search: def({
    // "Search the web" describes the mechanism and says nothing about when it
    // is the right call, so it was picked for questions the model could already
    // answer ("capital of France", "a good stretch for lower back pain") — each
    // one buying an extra plan/execute/prefill cycle for an answer it then gave
    // from its own knowledge anyway. The condition belongs in the description,
    // where it sits next to the name at the moment of choosing.
    //
    // The last sentence is the link-dumping fix, OBSERVED on a phone: asked for
    // tonight's match result, the planner answered with the result URLs dressed
    // up as answers — twice, even after the correction "I want to see the
    // results not links". A snippets page is not a result; the model needs to
    // be told, at the moment it holds the links, that fetching one is part of
    // the same turn's job. ("facts you do NOT already know" must stay verbatim:
    // a guarded eval scenario quotes it as its guard.)
    description:
      'Search the web for facts you do NOT already know, or that change (news, prices, opening hours, live scores). Returns top results with titles, URLs, and snippets. If the results are links rather than the answer itself, fetch the most promising one with web_fetch and read the answer out of the page.',
    params: z.object({ query: z.string() }),
    label: (a) => `Search web: “${a.query}”`,
  }),
  web_fetch: def({
    description:
      'Fetch a web page and return its readable text (truncated). Use it to read a page a search only gave you the link to.',
    params: z.object({ url: httpUrl }),
    label: (a) => `Read ${a.url}`,
  }),
  // --- device ---
  get_battery: def({
    description: 'Get the battery level and charging state.',
    params: z.object({}),
    label: () => 'Check battery',
  }),
  read_clipboard: def({
    description: 'Read the current clipboard text.',
    params: z.object({}),
    label: () => 'Read clipboard',
  }),
  write_clipboard: def({
    description: 'Copy text to the clipboard.',
    params: z.object({ text: z.string() }),
    label: (a) => `Copy to clipboard (${a.text.length} chars)`,
    mutates: true,
  }),
  set_brightness: def({
    // "100" arrived twice on a real phone before the percent mapping was
    // spelled out here: the schema rejected level 100, the model "fixed it to
    // 1", and the transcript showed a failed chip followed by "Set brightness
    // to 100%" — a recovery from its own error rendered as two actions. The
    // mapping belongs at the decision point, like the enum values in
    // search_phone_media.
    description:
      'Set the screen brightness for this app (0.0 dark to 1.0 max; percentages divide by 100, so "100%" is 1 and "30 percent" is 0.3).',
    params: z.object({ level: z.number().min(0).max(1) }),
    label: (a) => `Set brightness to ${Math.round(a.level * 100)}%`,
    mutates: true,
  }),
  toggle_torch: def({
    // OBSERVED: "turn on the torch light" had nothing to call — the closest
    // tool was set_brightness, which the model substituted twice while the
    // flashlight stayed off. The description also has to say what this is NOT:
    // "light" alone reads as brightness, which is how the substitution
    // happened in the first place.
    description:
      'Turn the camera flash LED (the torch / flashlight) on or off. This is the rear light, not the screen — brightness does not change.',
    params: z.object({
      on: z.boolean().describe('true to turn the torch on, false to turn it off'),
    }),
    label: (a) => (a.on ? 'Turn on the torch' : 'Turn off the torch'),
    mutates: true,
  }),
  get_location: def({
    description: 'Get the current location (coordinates and address).',
    params: z.object({}),
    label: () => 'Get current location',
  }),
  // --- local files (media library) ---
  search_phone_media: def({
    description:
      'Search photos, videos, and audio files on the phone by filename. Returns filenames and dates.',
    params: z.object({
      query: z.string().describe('text to match in filenames (empty = most recent)').default(''),
      media_type: z.enum(['photo', 'video', 'audio']).default('photo'),
    }),
    label: (a) => `Search phone media for “${a.query || 'recent files'}”`,
  }),
} as const;
