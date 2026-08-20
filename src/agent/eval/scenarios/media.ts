// The media library — one tool, but the one with the most interesting argument.
//
// `media_type` defaults to 'photo', so a video request that forgets it searches
// photos and reports nothing found: a wrong argument that looks exactly like an
// empty library. That is the whole reason `media_type` is asserted here and the
// query mostly is not — `mediaMatches()` already tokenises the query and drops
// generic words, so "beach", "beach photos" and "my beach pictures" are all the
// same search (F7, where the un-tokenised version missed beach_sunset.png).
import { oneCall, scenarios } from './define';

export const MEDIA_SCENARIOS = scenarios([
  // Test sheet row 16. The query wording is free; finding the file is not.
  {
    id: 'media-beach-photos',
    title: 'Beach photos finds beach_sunset.png',
    tags: ['media'],
    now: '2026-08-12T09:15',
    world: {
      media: [
        { filename: 'beach_sunset.png', type: 'photo', at: '2026-07-02T18:40' },
        { filename: 'IMG_2201.jpg', type: 'photo', at: '2026-08-01T10:00' },
      ],
    },
    turns: [
      {
        user: 'Find my beach photos',
        expect: {
          calls: [{ name: 'search_phone_media', args: { media_type: 'photo' } }],
          answer: { mustContain: ['beach_sunset'] },
        },
      },
    ],
    script: oneCall(
      'search_phone_media',
      { query: 'beach', media_type: 'photo' },
      'You have one: beach_sunset.png, from 2 July.',
    ),
  },

  // media_type must follow the noun the user used. Searching photos for a video
  // returns "No matching files found." — indistinguishable, from the outside,
  // from a phone with no videos on it.
  {
    id: 'media-videos',
    title: 'A video request searches videos, not the photo default',
    tags: ['media'],
    now: '2026-08-12T09:15',
    world: {
      media: [
        { filename: 'trek_skandagiri.mp4', type: 'video', at: '2026-05-18T06:10' },
        { filename: 'trek_group.jpg', type: 'photo', at: '2026-05-18T06:30' },
      ],
    },
    turns: [
      {
        user: 'Do I have any videos from the trek?',
        expect: {
          calls: [{ name: 'search_phone_media', args: { media_type: 'video' } }],
          answer: { mustContain: ['trek_skandagiri'] },
        },
      },
    ],
    script: oneCall(
      'search_phone_media',
      { query: 'trek', media_type: 'video' },
      'One video: trek_skandagiri.mp4, from 18 May.',
    ),
  },

  // The third enum value, which nothing else in the corpus reaches.
  {
    id: 'media-audio',
    title: 'A voice memo is an audio search',
    tags: ['media'],
    now: '2026-08-12T09:15',
    world: {
      media: [{ filename: 'voice_memo_standup.m4a', type: 'audio', at: '2026-08-11T09:05' }],
    },
    turns: [
      {
        user: 'Find the voice memo I recorded yesterday',
        expect: {
          calls: [{ name: 'search_phone_media', args: { media_type: 'audio' } }],
          answer: { mustContain: ['voice_memo_standup'] },
        },
      },
    ],
    script: oneCall(
      'search_phone_media',
      { query: 'voice memo', media_type: 'audio' },
      'There it is: voice_memo_standup.m4a, recorded yesterday morning.',
    ),
  },

  // "Most recent" describes nothing specific, and the tool has a documented
  // answer for that: an empty query means most recent wins. A model that
  // invents a query here ("recent") gets the same result only by accident —
  // "recent" is in the stop-word list.
  {
    id: 'media-most-recent',
    title: 'Most recent photos is an empty query, not an invented one',
    tags: ['media'],
    now: '2026-08-12T09:15',
    world: {
      media: [
        { filename: 'IMG_2301.jpg', type: 'photo', at: '2026-08-11T19:00' },
        { filename: 'IMG_2201.jpg', type: 'photo', at: '2026-08-01T10:00' },
      ],
    },
    turns: [
      {
        user: 'Show me my most recent photos',
        expect: {
          calls: [{ name: 'search_phone_media', args: { media_type: 'photo' } }],
          answer: { mustContain: ['IMG_2301'] },
        },
      },
    ],
    script: oneCall(
      'search_phone_media',
      { query: '', media_type: 'photo' },
      'Your latest is IMG_2301.jpg from yesterday evening, then IMG_2201.jpg from 1 August.',
    ),
  },

  // Nothing on the phone matches, and that is the answer. Looking again with a
  // different query is the retry the prompt forbids.
  {
    id: 'media-none-found',
    title: 'No matching files is reported once, not searched around',
    tags: ['media', 'empty'],
    now: '2026-08-12T09:15',
    world: {
      media: [{ filename: 'IMG_2201.jpg', type: 'photo', at: '2026-08-01T10:00' }],
    },
    turns: [
      {
        user: 'Find my wedding photos',
        expect: {
          calls: [{ name: 'search_phone_media', args: { media_type: 'photo' } }],
          answer: {
            mustContain: ['no'],
            mustNotContain: ['could not', 'permission', 'failed'],
          },
        },
      },
    ],
    script: oneCall(
      'search_phone_media',
      { query: 'wedding', media_type: 'photo' },
      'No wedding photos on this phone.',
    ),
  },
]);
