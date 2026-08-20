// Battery, clipboard, brightness, location — the tools that take no arguments
// or one obvious one. They are the easy half of the registry, and they are here
// for two reasons beyond coverage.
//
// The first is tense. `answerNote()` splits on `mutates` because a read that
// came back as "The battery WAS at 100%" reads like a fact about the past, and
// the whole point of asking was the present (F6).
//
// The second is that these are the tools a planner reaches for when it is not
// sure — cheap, safe, and always available — so several of them assert that
// nothing ELSE was called.
import { oneCall, scenarios } from './define';

export const DEVICE_SCENARIOS = scenarios([
  // Test sheet row 1. One call, and the number in the reply.
  {
    id: 'dev-battery',
    title: 'Battery is answered with the level, in the present tense',
    tags: ['device'],
    now: '2026-08-12T09:15',
    world: { battery: { level: 0.41, charging: false } },
    turns: [
      {
        user: 'How much battery do I have left?',
        expect: {
          calls: [{ name: 'get_battery', args: {} }],
          answer: {
            mustContain: ['41'],
            // OBSERVED (F6): "The battery was at 100%" — past tense on a read.
            mustNotContain: ['was at', 'I checked'],
          },
        },
      },
    ],
    script: oneCall('get_battery', {}, "You're at 41% and not charging."),
  },

  // The charging state is half the answer and the half most often dropped.
  {
    id: 'dev-battery-charging',
    title: 'Charging state is reported alongside the level',
    tags: ['device'],
    now: '2026-08-12T09:15',
    world: { battery: { level: 0.88, charging: true } },
    turns: [
      {
        user: 'Is my phone charging?',
        expect: {
          calls: [{ name: 'get_battery', args: {} }],
          answer: { mustContain: ['charging'] },
        },
      },
    ],
    script: oneCall('get_battery', {}, "Yes — it's charging, and up to 88%."),
  },

  // Test sheet row 3, the read half of the round trip.
  {
    id: 'dev-clipboard-read',
    title: 'The clipboard is read back verbatim',
    tags: ['device'],
    now: '2026-08-12T09:15',
    world: { clipboard: 'BLR-DEL 6E-2384 on the 19th' },
    turns: [
      {
        user: "What's on my clipboard?",
        expect: {
          calls: [{ name: 'read_clipboard', args: {} }],
          answer: { mustContain: ['6E-2384'] },
        },
      },
    ],
    script: oneCall('read_clipboard', {}, 'Your clipboard has "BLR-DEL 6E-2384 on the 19th".'),
  },

  // An empty clipboard is an answer. Looking again cannot change it, and the
  // prompt says as much for exactly this shape of result.
  {
    id: 'dev-clipboard-empty',
    title: 'An empty clipboard is reported, not re-read',
    tags: ['device', 'empty'],
    now: '2026-08-12T09:15',
    world: { clipboard: '' },
    turns: [
      {
        user: 'Read me whatever I copied last',
        expect: {
          calls: [{ name: 'read_clipboard', args: {} }],
          answer: {
            mustContain: ['empty'],
            mustNotContain: ['could not', 'failed'],
          },
        },
      },
    ],
    script: oneCall('read_clipboard', {}, 'Your clipboard is empty at the moment.'),
  },

  // Test sheet row 2. The text is what the user asked to copy, without the
  // words they used to ask for it — the same rule the calendar title has.
  {
    id: 'dev-clipboard-write',
    title: 'Copying puts the quoted text on the clipboard and nothing more',
    tags: ['device', 'mutating'],
    now: '2026-08-12T09:15',
    world: { clipboard: 'something older' },
    turns: [
      {
        user: 'Copy hello world to my clipboard',
        expect: {
          calls: [{ name: 'write_clipboard', args: { text: 'hello world' } }],
          answer: { mustContain: ['hello world'] },
        },
      },
    ],
    expectWorld: { clipboard: 'hello world' },
    script: oneCall('write_clipboard', { text: 'hello world' }, 'Copied "hello world" to your clipboard.'),
  },

  // Test sheet row 4. "30 percent" is 0.3 on a 0-1 scale, and 30 is out of
  // range — the schema would reject it, which surfaces as a tool error rather
  // than a wrong brightness, but it still costs the user a turn.
  {
    id: 'dev-brightness-percent',
    title: '30 percent is level 0.3, not 30',
    tags: ['device', 'mutating'],
    now: '2026-08-12T21:40',
    world: { brightness: 0.9 },
    turns: [
      {
        user: 'Dim the screen to 30 percent',
        expect: {
          calls: [{ name: 'set_brightness', args: { level: 0.3 } }],
          answer: { mustContain: ['30'] },
        },
      },
    ],
    expectWorld: { brightness: 0.3 },
    script: oneCall('set_brightness', { level: 0.3 }, 'Brightness is down to 30%.'),
  },

  // "All the way up" has no number in it at all; the mapping to 1.0 is the
  // thing under test.
  {
    id: 'dev-brightness-max',
    title: 'All the way up is level 1',
    tags: ['device', 'mutating'],
    now: '2026-08-12T13:00',
    world: { brightness: 0.4 },
    turns: [
      {
        user: "I can't see the screen in this sun, turn it all the way up",
        expect: {
          calls: [{ name: 'set_brightness', args: { level: 1 } }],
          answer: { mustContain: ['brightness'] },
        },
      },
    ],
    expectWorld: { brightness: 1 },
    script: oneCall('set_brightness', { level: 1 }, 'Brightness is all the way up.'),
  },

  // Test sheet row 15, which the emulator could never verify — no GPS fix on
  // the AVD, so the success path of this tool has literally never been scored.
  // Here it has a world and an answer.
  {
    id: 'dev-location',
    title: 'Location is answered with the place, not with the coordinates alone',
    tags: ['device'],
    now: '2026-08-12T09:15',
    world: {
      location: { latitude: 12.9784, longitude: 77.5946, address: 'Cubbon Park, Bengaluru' },
    },
    turns: [
      {
        user: 'Where am I right now?',
        expect: {
          calls: [{ name: 'get_location', args: {} }],
          answer: { mustContain: ['Cubbon Park'] },
        },
      },
    ],
    script: oneCall('get_location', {}, "You're at Cubbon Park in Bengaluru."),
  },
]);
