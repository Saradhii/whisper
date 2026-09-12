// Tool EXECUTORS: bind the pure declarations in toolDefs.ts to real device
// APIs. Permissions are requested lazily on first use; a denial becomes a
// normal tool result so the model can tell the user instead of crashing the
// loop. Side-effecting tools are flagged requiresConfirmation in their def
// and gated by an Allow/Deny prompt in the UI. Tools that merely open a
// system screen (dialer, SMS composer) don't need it — the user confirms
// inside that screen.
import * as Battery from 'expo-battery';
import * as Brightness from 'expo-brightness';
import * as Calendar from 'expo-calendar';
import * as Clipboard from 'expo-clipboard';
import * as Contacts from 'expo-contacts';
import * as IntentLauncher from 'expo-intent-launcher';
import * as Location from 'expo-location';
import * as MediaLibrary from 'expo-media-library';
import * as Notifications from 'expo-notifications';
import { Linking, Platform } from 'react-native';

import {
  cap,
  formatOtherResults,
  htmlToText,
  parseSearchResults,
  renderSearchTurn,
} from './parse';
import { atTime, mediaMatches, TOOL_DEFS } from './toolDefs';
import { defineTool, type AnyTool } from './types';
import { setTorch } from '@/src/torch/Torch';

async function ensure(granted: boolean, what: string): Promise<void> {
  if (!granted) throw new Error(`Permission for ${what} was denied by the user.`);
}

// Network tools run inside the agent loop — an unbounded fetch means the whole
// chat sits on a spinning tool chip with no way out. Hard timeout everything.
const FETCH_TIMEOUT_MS = 12_000;
const BROWSER_UA = 'Mozilla/5.0 (Android 15; Mobile)';

/** Hard ceiling on a response body we are willing to pull into JS memory.
 *  Requested via Range so a compliant server never sends more than this. */
const MAX_BODY_BYTES = 512 * 1024;

/** Fetch a URL and return its readable text, with every guard the web_fetch
 *  tool enforces (content-type, declared size, body cap). Shared by web_fetch
 *  and by web_search's auto-fetch of the top result. */
async function readPage(url: string): Promise<string> {
  const res = await fetchWithTimeout(url, MAX_BODY_BYTES);
  // 206 is the success case when the Range header was honoured.
  if (!res.ok && res.status !== 206) {
    throw new Error(`The page returned HTTP ${res.status}.`);
  }
  // Guard before materializing the body: a binary or huge response would
  // otherwise be fully buffered in JS memory just to be thrown away.
  const type = res.headers.get('content-type') ?? '';
  if (type && !/text|html|json|xml/i.test(type)) {
    throw new Error(`Not a readable page (content-type: ${type.split(';')[0]}).`);
  }
  // A chunked or gzip-streamed response carries NO Content-Length, and the
  // old `Number(null ?? 0) > 5MB` check passed every one of them — so the
  // guard was absent on exactly the responses most likely to be huge. The
  // Range request above is the real bound; this only catches a declared
  // oversize body early, and a missing length is no longer treated as 0.
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > 5 * 1024 * 1024) {
    throw new Error('Page is too large to read (over 5 MB).');
  }
  // Slice the RAW body before htmlToText: those are seven regex passes, and
  // running them over a multi-megabyte string is both the allocation and the
  // CPU spike we are trying to avoid.
  const body = (await res.text()).slice(0, MAX_BODY_BYTES);
  return htmlToText(body).slice(0, 4000);
}

async function fetchWithTimeout(url: string, maxBytes?: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: {
        'User-Agent': BROWSER_UA,
        // Ask for only the first slice. Servers that honour it stop there;
        // those that ignore it fall back to the size checks at the call site.
        ...(maxBytes ? { Range: `bytes=0-${maxBytes - 1}` } : {}),
      },
      signal: controller.signal,
    });
  } catch (e) {
    if (controller.signal.aborted) {
      throw new Error(`The request timed out after ${FETCH_TIMEOUT_MS / 1000}s. The network may be slow or offline.`);
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

async function defaultCalendar(): Promise<{ id: string; title: string }> {
  const cals = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
  // Prefer a calendar backed by a real account (shows up in Google Calendar),
  // then the primary, then any writable one — so events don't vanish into a
  // local-only calendar the user's calendar app doesn't display.
  const writable = cals.filter((c) => c.allowsModifications);
  const cal =
    writable.find((c) => c.source?.type === 'com.google' && c.isPrimary) ??
    writable.find((c) => c.source?.type === 'com.google') ??
    writable.find((c) => c.isPrimary) ??
    writable[0];
  if (!cal) throw new Error('No writable calendar found on this device.');
  return { id: cal.id, title: cal.title };
}

// Note the trailing platform filter: advertising a tool the platform can't
// execute (set_alarm on iOS) makes the model call it, fail, and apologize.
export const TOOLS: AnyTool[] = [
  defineTool({
    name: 'create_calendar_event',
    ...TOOL_DEFS.create_calendar_event,
    execute: async (a) => {
      const { granted } = await Calendar.requestCalendarPermissionsAsync();
      await ensure(granted, 'calendar');
      const cal = await defaultCalendar();
      const start = atTime(a.date, a.hour, a.minute);
      await Calendar.createEventAsync(cal.id, {
        title: a.title,
        startDate: start,
        endDate: new Date(+start + a.duration_minutes * 60_000),
        location: a.location,
      });
      return `Event "${a.title}" created for ${start.toLocaleString()} in the "${cal.title}" calendar.`;
    },
  }),
  defineTool({
    name: 'list_calendar_events',
    ...TOOL_DEFS.list_calendar_events,
    execute: async (a) => {
      const { granted } = await Calendar.requestCalendarPermissionsAsync();
      await ensure(granted, 'calendar');
      const cals = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
      // The range is given in whole days, so widen it to cover them fully —
      // otherwise "today to today" is a zero-length window at midnight.
      const from = atTime(a.start, 0, 0);
      const to = atTime(a.end, 23, 59);
      const events = await Calendar.getEventsAsync(cals.map((c) => c.id), from, to);
      if (!events.length) return 'No events in that range.';
      return events
        .slice(0, 20)
        .map((e) => `- ${cap(String(e.title ?? ''), 80)} — ${new Date(e.startDate as string | Date).toLocaleString()}`)
        .join('\n');
    },
  }),
  defineTool({
    name: 'schedule_reminder',
    ...TOOL_DEFS.schedule_reminder,
    execute: async (a) => {
      const { granted } = await Notifications.requestPermissionsAsync();
      await ensure(granted, 'notifications');
      const when = atTime(a.date, a.hour, a.minute);
      // The message is the model's only feedback channel, so it carries the
      // fix, not just the complaint: on device the planner set a reminder for
      // the current minute, was told "must be in the future", and moved it a
      // whole day rather than an hour.
      if (+when <= Date.now()) {
        throw new Error(
          `That time (${when.toLocaleString()}) has already passed — it is now ` +
            `${new Date().toLocaleTimeString()}. Call again with a later time.`,
        );
      }
      if (Platform.OS === 'android') {
        await Notifications.setNotificationChannelAsync('reminders', {
          name: 'Reminders',
          importance: Notifications.AndroidImportance.MAX,
        });
      }
      await Notifications.scheduleNotificationAsync({
        content: { title: 'Reminder', body: a.message },
        trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: when },
      });
      return `Reminder set for ${when.toLocaleString()}.`;
    },
  }),
  defineTool({
    name: 'set_alarm',
    ...TOOL_DEFS.set_alarm,
    execute: async (a) => {
      if (Platform.OS !== 'android') throw new Error('Alarms are only supported on Android.');
      await IntentLauncher.startActivityAsync('android.intent.action.SET_ALARM', {
        extra: {
          'android.intent.extra.alarm.HOUR': a.hour,
          'android.intent.extra.alarm.MINUTES': a.minute,
          'android.intent.extra.alarm.MESSAGE': a.label ?? 'Alarm',
          'android.intent.extra.alarm.SKIP_UI': true,
        },
      });
      return `Alarm set for ${a.hour}:${String(a.minute).padStart(2, '0')}.`;
    },
  }),
  defineTool({
    name: 'search_contacts',
    ...TOOL_DEFS.search_contacts,
    execute: async (a) => {
      const { granted } = await Contacts.requestPermissionsAsync();
      await ensure(granted, 'contacts');
      const { data } = await Contacts.getContactsAsync({
        name: a.query,
        fields: [Contacts.Fields.PhoneNumbers, Contacts.Fields.Emails],
      });
      if (!data.length) return 'No matching contacts.';
      return data
        .slice(0, 5)
        .map((c) => {
          const phones = (c.phoneNumbers ?? []).map((p) => p.number).join(', ');
          const emails = (c.emails ?? []).map((e) => e.email).join(', ');
          return `- ${cap(c.name ?? '', 60)}${phones ? ` · ${cap(phones, 80)}` : ''}${emails ? ` · ${cap(emails, 80)}` : ''}`;
        })
        .join('\n');
    },
  }),
  defineTool({
    name: 'dial_number',
    ...TOOL_DEFS.dial_number,
    execute: async (a) => {
      await Linking.openURL(`tel:${encodeURIComponent(a.phone)}`);
      return 'Dialer opened with the number.';
    },
  }),
  defineTool({
    name: 'compose_sms',
    ...TOOL_DEFS.compose_sms,
    execute: async (a) => {
      await Linking.openURL(
        `sms:${encodeURIComponent(a.phone)}?body=${encodeURIComponent(a.message)}`,
      );
      return 'SMS composer opened; the user must press send.';
    },
  }),
  defineTool({
    name: 'compose_email',
    ...TOOL_DEFS.compose_email,
    execute: async (a) => {
      const q = `subject=${encodeURIComponent(a.subject ?? '')}&body=${encodeURIComponent(a.body ?? '')}`;
      await Linking.openURL(`mailto:${encodeURIComponent(a.to)}?${q}`);
      return 'Email composer opened; the user must press send.';
    },
  }),
  defineTool({
    name: 'open_maps',
    ...TOOL_DEFS.open_maps,
    execute: async (a) => {
      await Linking.openURL(`geo:0,0?q=${encodeURIComponent(a.query)}`);
      return 'Maps opened with the search.';
    },
  }),
  defineTool({
    name: 'open_url',
    ...TOOL_DEFS.open_url,
    execute: async (a) => {
      await Linking.openURL(a.url);
      return 'Opened in the browser.';
    },
  }),
  defineTool({
    name: 'web_search',
    ...TOOL_DEFS.web_search,
    execute: async (a) => {
      const res = await fetchWithTimeout(
        `https://html.duckduckgo.com/html/?q=${encodeURIComponent(a.query)}`,
      );
      if (!res.ok) {
        throw new Error(`Search failed (HTTP ${res.status}). Try again in a moment.`);
      }
      // Parsing lives in ./parse.ts so it can be tested against a saved page;
      // this executor is the fetch, the auto-read of the top result, and the
      // error message.
      const results = parseSearchResults(await res.text());
      if (!results.length) return 'No results found.';
      // Read the top result FOR the model. Observed on a real phone and on the
      // live-model harness within the same hour: given links, a 1.7B planner
      // answers with "the search results show <the links>" and never fetches —
      // the hint, the description, nothing moved it. The harness does the
      // reading; the model answers from what it read (see parse.ts
      // renderSearchTurn for the contract and the fixture for the mirror).
      const top = results[0]!;
      let fetched: { url: string; text: string } | null = null;
      try {
        const text = await readPage(top.url);
        if (text) fetched = { url: top.url, text };
      } catch {
        // The links carry the turn, with a line telling the model it must
        // fetch one itself (renderSearchTurn's no-top branch).
      }
      return renderSearchTurn(a.query, fetched, formatOtherResults(results, top.url));
    },
  }),
  defineTool({
    name: 'web_fetch',
    ...TOOL_DEFS.web_fetch,
    execute: async (a) => {
      const text = await readPage(a.url);
      return text || 'Page had no readable text.';
    },
  }),
  defineTool({
    name: 'get_battery',
    ...TOOL_DEFS.get_battery,
    execute: async () => {
      const level = await Battery.getBatteryLevelAsync();
      const state = await Battery.getBatteryStateAsync();
      const charging = state === Battery.BatteryState.CHARGING ? 'charging' : 'not charging';
      return `Battery at ${Math.round(level * 100)}%, ${charging}.`;
    },
  }),
  defineTool({
    name: 'read_clipboard',
    ...TOOL_DEFS.read_clipboard,
    execute: async () => {
      const text = await Clipboard.getStringAsync();
      return text ? `Clipboard: ${text.slice(0, 1000)}` : 'Clipboard is empty.';
    },
  }),
  defineTool({
    name: 'write_clipboard',
    ...TOOL_DEFS.write_clipboard,
    execute: async (a) => {
      await Clipboard.setStringAsync(a.text);
      return 'Copied to clipboard.';
    },
  }),
  defineTool({
    name: 'set_brightness',
    ...TOOL_DEFS.set_brightness,
    execute: async (a) => {
      await Brightness.setBrightnessAsync(a.level);
      return `Brightness set to ${Math.round(a.level * 100)}%.`;
    },
  }),
  defineTool({
    name: 'toggle_torch',
    ...TOOL_DEFS.toggle_torch,
    execute: async (a) => {
      await setTorch(a.on);
      return a.on ? 'Torch on.' : 'Torch off.';
    },
  }),
  defineTool({
    name: 'get_location',
    ...TOOL_DEFS.get_location,
    execute: async () => {
      const { granted } = await Location.requestForegroundPermissionsAsync();
      await ensure(granted, 'location');
      const pos = await Location.getCurrentPositionAsync({});
      const places = await Location.reverseGeocodeAsync(pos.coords).catch(() => []);
      const p = places[0];
      const addr = p
        ? [p.name, p.street, p.city, p.region, p.country].filter(Boolean).join(', ')
        : 'address unknown';
      return `Lat ${pos.coords.latitude.toFixed(5)}, Lon ${pos.coords.longitude.toFixed(5)} — ${addr}`;
    },
  }),
  defineTool({
    name: 'search_phone_media',
    ...TOOL_DEFS.search_phone_media,
    execute: async (a) => {
      const { granted } = await MediaLibrary.requestPermissionsAsync();
      await ensure(granted, 'media library');
      const type =
        a.media_type === 'video'
          ? MediaLibrary.MediaType.video
          : a.media_type === 'audio'
            ? MediaLibrary.MediaType.audio
            : MediaLibrary.MediaType.photo;
      const page = await MediaLibrary.getAssetsAsync({
        first: 500,
        mediaType: type,
        sortBy: [[MediaLibrary.SortBy.creationTime, false]],
      });
      const hits = page.assets.filter((x) => mediaMatches(x.filename, a.query));
      if (!hits.length) return 'No matching files found.';
      return hits
        .slice(0, 15)
        .map((x) => `- ${cap(x.filename, 80)} (${new Date(x.creationTime).toLocaleDateString()})`)
        .join('\n');
    },
  }),
].filter(
  // A tool the platform can't execute makes the model call it, fail, and
  // apologize (see the comment above the registry).
  (t) =>
    Platform.OS === 'android' ||
    (t.name !== 'set_alarm' && t.name !== 'toggle_torch'),
);
