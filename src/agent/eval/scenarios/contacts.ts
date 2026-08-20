// Contacts and the four handoff tools — dialer, SMS, email, and the ones that
// merely open something. None of them require confirmation, because the user
// confirms inside the app that opens; the assertion that matters is therefore
// the ARGUMENTS, since a wrong number reaches a stranger's phone and no
// confirmation card was ever going to catch it.
//
// The chains (look a contact up, then act on the result) live in multistep.ts.
// These are the single-call cases, where the user supplied the address already
// and a contact lookup would be a wasted generation.
import { oneCall, scenarios } from './define';

const ARUN = { name: 'Arun Menon', phone: '+91 98450 12345', email: 'arun@example.com' };
const PRIYA = { name: 'Priya Raghavan', phone: '+91 98860 55512', email: 'priya@example.com' };

export const CONTACT_SCENARIOS = scenarios([
  // Test sheet row 10 — the plain lookup. The answer has to carry the number,
  // because a read that reports "I found Arun in your contacts" and stops is
  // the F6 failure: the result sat in context, unused.
  {
    id: 'con-lookup-number',
    title: "A contact lookup answers with the number, not with 'I found them'",
    tags: ['contacts'],
    now: '2026-08-12T09:15',
    world: { contacts: [ARUN, PRIYA] },
    turns: [
      {
        user: "What's Arun's phone number?",
        expect: {
          calls: [{ name: 'search_contacts', args: { query: 'Arun' } }],
          answer: {
            mustContain: ['98450'],
            mustNotContain: ['I searched', 'I looked'],
          },
        },
      },
    ],
    script: oneCall(
      'search_contacts',
      { query: 'Arun' },
      "Arun Menon's number is +91 98450 12345, and his email is arun@example.com.",
    ),
  },

  // An empty contact search is an answer. The failure mode to guard is a
  // fabricated number — the model has two real ones in context from the world
  // and nothing stops it offering one of those instead.
  {
    id: 'con-lookup-missing',
    title: 'No matching contact is reported, never substituted',
    tags: ['contacts', 'empty'],
    now: '2026-08-12T09:15',
    world: { contacts: [ARUN, PRIYA] },
    turns: [
      {
        user: "What's Deepa's number?",
        expect: {
          calls: [{ name: 'search_contacts', args: { query: 'Deepa' } }],
          answer: {
            mustContain: ['Deepa'],
            // No invented digits, and no quietly answering with Arun's.
            mustNotContain: ['98450', '98860', '+91'],
          },
        },
      },
    ],
    script: oneCall(
      'search_contacts',
      { query: 'Deepa' },
      "There's no Deepa in your contacts.",
    ),
  },

  // A number the user said out loud needs no lookup. An extra search_contacts
  // here is the F5 class — harmless but it burns a generation, and with
  // MAX_STEPS at 4 the budget is not large.
  {
    id: 'con-dial-spoken-number',
    title: 'A number given in the request is dialled without a lookup first',
    tags: ['contacts', 'mutating'],
    now: '2026-08-12T09:15',
    world: { contacts: [ARUN] },
    turns: [
      {
        user: 'Call 1800 425 3800 for me',
        expect: {
          calls: [{ name: 'dial_number', args: { phone: '1800 425 3800' } }],
          answer: { mustContain: ['1800'] },
        },
      },
    ],
    script: oneCall(
      'dial_number',
      { phone: '1800 425 3800' },
      "I've opened the dialer with 1800 425 3800 — press call when you're ready.",
    ),
  },

  // Test sheet row 12. The address is in the request, so it is copied, not
  // looked up; the subject is copied verbatim rather than paraphrased.
  {
    id: 'con-email-explicit',
    title: 'An email to a spelled-out address is composed directly',
    tags: ['contacts', 'mutating'],
    now: '2026-08-12T09:15',
    world: { contacts: [ARUN] },
    turns: [
      {
        user: 'Email arun@example.com with the subject Project update',
        expect: {
          calls: [
            { name: 'compose_email', args: { to: 'arun@example.com', subject: 'Project update' } },
          ],
          answer: { mustContain: ['arun@example.com'] },
        },
      },
    ],
    script: oneCall(
      'compose_email',
      { to: 'arun@example.com', subject: 'Project update' },
      "I've opened a draft to arun@example.com with the subject Project update — send it when you're happy.",
    ),
  },

  // The body is the user's message, not a summary of it, and not addressed to
  // the third person. The composer opens; the user sends.
  {
    id: 'con-email-with-body',
    title: 'An email body carries the message the user dictated',
    tags: ['contacts', 'mutating'],
    now: '2026-08-12T09:15',
    world: { contacts: [PRIYA] },
    turns: [
      {
        user: 'Email priya@example.com and say the deck is ready for review',
        expect: {
          calls: [
            {
              name: 'compose_email',
              args: { to: 'priya@example.com', body: 'The deck is ready for review.' },
            },
          ],
          answer: { mustNotContain: ['the user', 'I sent'] },
        },
      },
    ],
    script: oneCall(
      'compose_email',
      {
        to: 'priya@example.com',
        subject: 'Deck ready for review',
        body: 'The deck is ready for review.',
      },
      "Draft ready for priya@example.com saying the deck is ready for review — press send when you like.",
    ),
  },

  // The composer opens prefilled and the user presses send, so the reply must
  // not claim the message went anywhere. Same class as the denial branch: an
  // action reported as more complete than it was.
  {
    id: 'con-sms-explicit-number',
    title: 'An SMS to a spelled-out number opens the composer, and says so',
    tags: ['contacts', 'mutating'],
    now: '2026-08-12T09:15',
    world: { contacts: [ARUN] },
    turns: [
      {
        user: "Text +91 98450 12345 that I'm running ten minutes late",
        expect: {
          calls: [{ name: 'compose_sms', args: { phone: '+91 98450 12345' } }],
          answer: { mustNotContain: ['I sent', 'message sent', 'has been sent'] },
        },
      },
    ],
    script: oneCall(
      'compose_sms',
      { phone: '+91 98450 12345', message: 'Running ten minutes late.' },
      "I've opened a message to +91 98450 12345 saying you're running ten minutes late — hit send when you're ready.",
    ),
  },
]);
