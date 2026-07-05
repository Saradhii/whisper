// Tool DECLARATIONS: name → params schema, label, description, confirmation
// flag. Pure module (zod only, no Expo imports) so the test suite can prove
// every schema converts to JSON Schema and parses/labels correctly — the
// executors in tools.ts bind these to real device APIs.
import { z } from 'zod';

export const isoDate = (field: string) =>
  z
    .string()
    .describe(`${field} as ISO 8601 datetime`)
    .transform((s, ctx) => {
      const d = new Date(s);
      if (isNaN(+d)) {
        ctx.addIssue({ code: 'custom', message: `"${s}" is not a valid ISO 8601 datetime` });
        return z.NEVER;
      }
      return d;
    });

export const httpUrl = z
  .string()
  .describe('http(s) URL')
  .refine((u) => /^https?:\/\//.test(u), 'must be an http(s) URL');

/** Identity helper that binds `label`'s argument type to the params schema. */
function def<S extends z.ZodRawShape>(d: {
  description: string;
  params: z.ZodObject<S>;
  label: (args: z.infer<z.ZodObject<S>>) => string;
  requiresConfirmation?: boolean;
}) {
  return d;
}

export const TOOL_DEFS = {
  // --- calendar & reminders ---
  create_calendar_event: def({
    description: 'Create an event in the user calendar.',
    params: z.object({
      title: z.string(),
      start: isoDate('start'),
      end: isoDate('end (default: start + 1h)').optional(),
      location: z.string().optional(),
      notes: z.string().optional(),
    }),
    label: (a) => `Create event “${a.title}” at ${a.start.toLocaleString()}`,
    requiresConfirmation: true,
  }),
  list_calendar_events: def({
    description: 'List calendar events between two datetimes.',
    params: z.object({ start: isoDate('start of range'), end: isoDate('end of range') }),
    label: (a) =>
      `Read calendar ${a.start.toISOString().slice(0, 10)} → ${a.end.toISOString().slice(0, 10)}`,
  }),
  schedule_reminder: def({
    description: 'Schedule a reminder notification at a specific time.',
    params: z.object({ message: z.string(), when: isoDate('reminder time') }),
    label: (a) => `Remind “${a.message}” at ${a.when.toLocaleString()}`,
    requiresConfirmation: true,
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
  }),
  // --- contacts & communication ---
  search_contacts: def({
    description: 'Search the user contacts by name; returns names, phone numbers, emails.',
    params: z.object({ query: z.string() }),
    label: (a) => `Search contacts for “${a.query}”`,
  }),
  dial_number: def({
    description: 'Open the phone dialer with a number (the user places the call).',
    params: z.object({ phone: z.string() }),
    label: (a) => `Open dialer for ${a.phone}`,
  }),
  compose_sms: def({
    description: 'Open the SMS composer prefilled with recipient and message (the user sends it).',
    params: z.object({ phone: z.string(), message: z.string() }),
    label: (a) => `Compose SMS to ${a.phone}`,
  }),
  compose_email: def({
    description: 'Open the email composer prefilled (the user sends it).',
    params: z.object({
      to: z.string(),
      subject: z.string().optional(),
      body: z.string().optional(),
    }),
    label: (a) => `Compose email to ${a.to}`,
  }),
  open_maps: def({
    description: 'Open the maps app searching for a place or address.',
    params: z.object({ query: z.string() }),
    label: (a) => `Open maps: “${a.query}”`,
  }),
  open_url: def({
    description: 'Open a URL in the browser.',
    params: z.object({ url: httpUrl }),
    label: (a) => `Open ${a.url}`,
  }),
  // --- web ---
  web_search: def({
    description: 'Search the web; returns top results with titles, URLs, and snippets.',
    params: z.object({ query: z.string() }),
    label: (a) => `Search web: “${a.query}”`,
  }),
  web_fetch: def({
    description: 'Fetch a web page and return its readable text (truncated).',
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
  }),
  set_brightness: def({
    description: 'Set the screen brightness for this app (0.0 dark to 1.0 max).',
    params: z.object({ level: z.number().min(0).max(1) }),
    label: (a) => `Set brightness to ${Math.round(a.level * 100)}%`,
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
