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

import { TOOL_DEFS } from './toolDefs';
import { defineTool, type AnyTool } from './types';

async function ensure(granted: boolean, what: string): Promise<void> {
  if (!granted) throw new Error(`Permission for ${what} was denied by the user.`);
}

// Network tools run inside the agent loop — an unbounded fetch means the whole
// chat sits on a spinning tool chip with no way out. Hard timeout everything.
const FETCH_TIMEOUT_MS = 12_000;
const BROWSER_UA = 'Mozilla/5.0 (Android 15; Mobile)';

async function fetchWithTimeout(url: string): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, {
      headers: { 'User-Agent': BROWSER_UA },
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

// Strip tags/scripts from HTML and collapse whitespace for model consumption.
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
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
      await Calendar.createEventAsync(cal.id, {
        title: a.title,
        startDate: a.start,
        endDate: a.end ?? new Date(+a.start + 3600_000),
        location: a.location,
        notes: a.notes,
      });
      return `Event "${a.title}" created for ${a.start.toLocaleString()} in the "${cal.title}" calendar.`;
    },
  }),
  defineTool({
    name: 'list_calendar_events',
    ...TOOL_DEFS.list_calendar_events,
    execute: async (a) => {
      const { granted } = await Calendar.requestCalendarPermissionsAsync();
      await ensure(granted, 'calendar');
      const cals = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
      const events = await Calendar.getEventsAsync(
        cals.map((c) => c.id),
        a.start,
        a.end,
      );
      if (!events.length) return 'No events in that range.';
      return events
        .slice(0, 20)
        .map((e) => `- ${e.title} — ${new Date(e.startDate as string | Date).toLocaleString()}`)
        .join('\n');
    },
  }),
  defineTool({
    name: 'schedule_reminder',
    ...TOOL_DEFS.schedule_reminder,
    execute: async (a) => {
      const { granted } = await Notifications.requestPermissionsAsync();
      await ensure(granted, 'notifications');
      if (+a.when <= Date.now()) throw new Error('Reminder time must be in the future.');
      if (Platform.OS === 'android') {
        await Notifications.setNotificationChannelAsync('reminders', {
          name: 'Reminders',
          importance: Notifications.AndroidImportance.MAX,
        });
      }
      await Notifications.scheduleNotificationAsync({
        content: { title: 'Reminder', body: a.message },
        trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: a.when },
      });
      return `Reminder set for ${a.when.toLocaleString()}.`;
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
          return `- ${c.name}${phones ? ` · ${phones}` : ''}${emails ? ` · ${emails}` : ''}`;
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
      const html = await res.text();
      const results: string[] = [];
      const re =
        /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(html)) && results.length < 5) {
        const href = m[1] ?? '';
        const title = htmlToText(m[2] ?? '');
        const snippet = m[3] ? htmlToText(m[3]) : '';
        // DDG wraps result URLs in a redirect; extract the real target.
        const uddg = /uddg=([^&]+)/.exec(href);
        const url = uddg?.[1] ? decodeURIComponent(uddg[1]) : href;
        if (title) results.push(`- ${title}\n  ${url}${snippet ? `\n  ${snippet}` : ''}`);
      }
      return results.length ? results.join('\n') : 'No results found.';
    },
  }),
  defineTool({
    name: 'web_fetch',
    ...TOOL_DEFS.web_fetch,
    execute: async (a) => {
      const res = await fetchWithTimeout(a.url);
      if (!res.ok) throw new Error(`The page returned HTTP ${res.status}.`);
      // Guard before materializing the body: a binary or huge response would
      // otherwise be fully buffered in JS memory just to be thrown away.
      const type = res.headers.get('content-type') ?? '';
      if (type && !/text|html|json|xml/i.test(type)) {
        throw new Error(`Not a readable page (content-type: ${type.split(';')[0]}).`);
      }
      const length = Number(res.headers.get('content-length') ?? 0);
      if (length > 5 * 1024 * 1024) {
        throw new Error('Page is too large to read (over 5 MB).');
      }
      const text = htmlToText(await res.text());
      return text.slice(0, 4000) || 'Page had no readable text.';
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
      const q = a.query.toLowerCase();
      const hits = page.assets.filter((x) => !q || x.filename.toLowerCase().includes(q));
      if (!hits.length) return 'No matching files found.';
      return hits
        .slice(0, 15)
        .map((x) => `- ${x.filename} (${new Date(x.creationTime).toLocaleDateString()})`)
        .join('\n');
    },
  }),
].filter((t) => Platform.OS === 'android' || t.name !== 'set_alarm');
