// Agent trace: an in-memory ring buffer of what the agent actually decided.
//
// The failure this exists for is specific and was invisible: the planner is
// grammar-constrained, and parseDecision() falls back to 'respond' on ANY
// unparseable output. So a mis-converted grammar, a truncated decision, or a
// model that simply chose not to act all look identical from the outside — the
// assistant just narrates and nothing happens. Every one of those paths now
// leaves a record here.
//
// Same shape as the other stores (module singleton + version counter for
// useSyncExternalStore), but deliberately NOT persisted: it is a developer
// surface, it holds raw model output, and it must never survive as a file of
// the user's requests. Disabled by default — recording is a no-op until the
// Developer setting turns it on.
import type { AgentTraceKind } from './types';

export type TraceEntry = {
  id: number;
  /** ms epoch, for a relative timestamp in the viewer. */
  at: number;
  /** Which conversation turn this belongs to (see startTurn). */
  turn: number;
  kind: AgentTraceKind;
  /** One-line summary — the row title. */
  label: string;
  /** Optional payload: raw decision JSON, tool args, error text. */
  detail?: string;
  /** Wall-clock duration of the step, where one applies. */
  ms?: number;
};

// Bounded so a long session can't grow without limit. Old entries fall off the
// front; the viewer shows newest first anyway.
const MAX_ENTRIES = 300;

let entries: TraceEntry[] = [];
let enabled = false;
let seq = 0;
let turn = 0;

// --- change notification (useSyncExternalStore contract) ---
let version = 0;
const listeners = new Set<() => void>();

function emit(): void {
  version++;
  listeners.forEach((l) => l());
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getVersion(): number {
  return version;
}

/** Recording is off by default; the Developer setting drives this. */
export function setEnabled(value: boolean): void {
  if (enabled === value) return;
  enabled = value;
  emit();
}

export function isEnabled(): boolean {
  return enabled;
}

/** Newest first — the order the viewer renders. */
export function list(): TraceEntry[] {
  return [...entries].reverse();
}

export function clear(): void {
  entries = [];
  emit();
}

/** Begin a new conversation turn; subsequent entries are tagged with it. */
export function startTurn(): number {
  turn++;
  return turn;
}

export function currentTurn(): number {
  return turn;
}

/** Record one step. No-op (and allocation-free) while recording is off. */
export function add(kind: AgentTraceKind, label: string, extra?: { detail?: string; ms?: number }): void {
  if (!enabled) return;
  entries.push({
    id: ++seq,
    at: Date.now(),
    turn,
    kind,
    label,
    ...(extra?.detail !== undefined ? { detail: extra.detail } : {}),
    ...(extra?.ms !== undefined ? { ms: extra.ms } : {}),
  });
  if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);
  emit();
}

/** Flatten the buffer to text for the viewer's Share/Copy action. */
export function toText(): string {
  if (!entries.length) return 'No agent activity recorded yet.';
  const t0 = entries[0]!.at;
  return entries
    .map((e) => {
      const head = `[+${((e.at - t0) / 1000).toFixed(2)}s] turn ${e.turn} ${e.kind.padEnd(6)} ${e.label}`;
      const ms = e.ms !== undefined ? ` (${e.ms}ms)` : '';
      return e.detail ? `${head}${ms}\n    ${e.detail.replace(/\n/g, '\n    ')}` : `${head}${ms}`;
    })
    .join('\n');
}
