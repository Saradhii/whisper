// The chat transcript's row model and the pure transitions over it.
//
// A conversation is not just bubbles: the agent also emits tool chips, planning
// steps, and confirmation cards, and those rows MUTATE — a confirmation card
// becomes a running chip, which becomes a settled one. That state machine used
// to live inside the chat component's setState updaters, where it could not be
// tested and where an off-by-one in the matcher shows up as a duplicated chip
// or an eternally spinning one. It lives here instead, as pure functions on an
// array, so the interesting cases are pinned by tests.
import type { ChatMessage } from '@/src/engines/types';
import type { StoredMessage } from './store';

export type ToolStatus = 'running' | 'done' | 'denied' | 'error';

export type UiMessage = ChatMessage & {
  id: string;
  image?: string;
  tool?: { name: string; label: string; status: ToolStatus };
  /** A grammar-constrained planning decision (shown when plan steps are on). */
  plan?: { step: number; text: string; forced?: boolean };
  /** An Allow/Deny card awaiting the user. */
  confirm?: { name: string; label: string };
  error?: boolean;
};

/** Rows that are agent machinery, not conversation: never sent back to the
 *  model as history, and never treated as a bubble to speak or regenerate. */
export const isMachinery = (m: UiMessage): boolean =>
  !!(m.tool || m.plan || m.confirm || m.error);

/**
 * Append streamed answer text to the trailing assistant bubble, starting a new
 * one when the last row can't hold prose.
 *
 * The "can this row hold text?" test must be the inverse of isMachinery, not a
 * hand-listed subset. Testing only `!tool && !error` let a plan row — which is
 * also role:'assistant' — absorb the entire final answer into a `content` field
 * that PlanRow never renders, so a turn could set an alarm and then show the
 * user nothing. Verified on device: the trace recorded "35 chars" answered
 * while the screen stayed empty.
 */
export function appendText(prev: UiMessage[], chunk: string, newId: string): UiMessage[] {
  const next = [...prev];
  const last = next[next.length - 1];
  if (last && last.role === 'assistant' && !isMachinery(last)) {
    next[next.length - 1] = { ...last, content: last.content + chunk };
  } else {
    next.push({ id: newId, role: 'assistant', content: chunk });
  }
  return next;
}

/**
 * Land a tool event on the transcript.
 *
 * The matcher scans backwards for a chip with the same label that is still
 * unsettled — `running` (the normal case) or `denied` (a row that a
 * confirmation card already converted). Without the `denied` case the loop's
 * own denial event would append a second, duplicate chip right under the one
 * the card just became.
 */
export function applyToolEvent(
  prev: UiMessage[],
  e: { name: string; label: string; status: ToolStatus },
  newId: string,
): UiMessage[] {
  const next = [...prev];
  for (let i = next.length - 1; i >= 0; i--) {
    const m = next[i];
    if (
      m?.tool &&
      m.tool.label === e.label &&
      (m.tool.status === 'running' || m.tool.status === 'denied')
    ) {
      next[i] = { ...m, tool: { name: e.name, label: e.label, status: e.status } };
      return next;
    }
  }
  next.push({
    id: newId,
    role: 'assistant',
    content: '',
    tool: { name: e.name, label: e.label, status: e.status },
  });
  return next;
}

/**
 * Answer a pending confirmation card: the row converts in place into the tool
 * chip it becomes, so the transcript reads as one continuous item rather than a
 * card followed by a separate chip repeating the same words.
 */
export function resolveConfirm(prev: UiMessage[], id: string, allow: boolean): UiMessage[] {
  return prev.map((m) =>
    m.id === id && m.confirm
      ? {
          ...m,
          confirm: undefined,
          tool: {
            name: m.confirm.name,
            label: m.confirm.label,
            status: allow ? ('running' as const) : ('denied' as const),
          },
        }
      : m,
  );
}

/** Stopping generation declines every card still waiting on the user — one left
 *  pending would hold the agent loop, and therefore the chat, busy forever. */
export function cancelConfirms(prev: UiMessage[]): UiMessage[] {
  return prev.map((m) =>
    m.confirm
      ? {
          ...m,
          confirm: undefined,
          tool: { name: m.confirm.name, label: m.confirm.label, status: 'denied' as const },
        }
      : m,
  );
}

/**
 * UiMessage → persisted message. System turns never persist; a tool chip still
 * marked "running" at save time means the turn was interrupted, so it is stored
 * as failed rather than restored eternally spinning. An unanswered confirmation
 * card is dropped entirely: its promise died with the turn, so restoring it
 * would show Allow/Deny buttons wired to nothing.
 */
export function toStored(m: UiMessage): StoredMessage[] {
  if (m.role === 'system' || m.confirm) return [];
  return [
    {
      id: m.id,
      role: m.role,
      content: m.content,
      ...(m.image ? { image: m.image } : {}),
      ...(m.tool
        ? {
            tool: {
              name: m.tool.name,
              label: m.tool.label,
              status: m.tool.status === 'running' ? ('error' as const) : m.tool.status,
            },
          }
        : {}),
      ...(m.plan ? { plan: m.plan } : {}),
      ...(m.error ? { error: true } : {}),
    },
  ];
}
