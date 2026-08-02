// Conversation persistence: one JSON file per conversation plus a small index
// (titles, timestamps, which conversation is open). Without this, backgrounding
// the app — which the OS is free to turn into a kill at any time given the
// model's footprint — silently destroys the user's entire chat history.
//
// Same architecture as ModelManager: module singleton, version counter for
// useSyncExternalStore, zod-validated reads so a corrupt file degrades to an
// empty conversation instead of crashing startup. Writes are debounced and
// happen at turn boundaries (not per token), so the cost is negligible.
import * as FileSystem from 'expo-file-system/legacy';
import { AppState } from 'react-native';
import { z } from 'zod';

export type StoredTool = {
  name: string;
  label: string;
  status: 'done' | 'denied' | 'error';
};

/** A grammar-constrained planning decision, kept so reopening a conversation
 *  still shows how the agent decided (rendered only when the user has plan
 *  steps switched on). */
export type StoredPlan = {
  step: number;
  text: string;
  forced?: boolean;
};

export type StoredMessage = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  image?: string;
  tool?: StoredTool;
  plan?: StoredPlan;
  error?: boolean;
};

export type ConversationMeta = {
  id: string;
  title: string;
  updatedAt: number;
  messageCount: number;
};

const StoredMessageSchema: z.ZodType<StoredMessage> = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  image: z.string().optional(),
  tool: z
    .object({
      name: z.string(),
      label: z.string(),
      status: z.enum(['done', 'denied', 'error']),
    })
    .optional(),
  plan: z
    .object({
      step: z.number(),
      text: z.string(),
      forced: z.boolean().optional(),
    })
    .optional(),
  error: z.boolean().optional(),
});

const ConversationFileSchema = z.object({
  messages: z
    .array(z.unknown())
    .catch([])
    .transform((list) =>
      list.flatMap((m) => (StoredMessageSchema.safeParse(m).success ? [m as StoredMessage] : [])),
    ),
});

const MetaSchema: z.ZodType<ConversationMeta> = z.object({
  id: z.string(),
  title: z.string(),
  updatedAt: z.number(),
  messageCount: z.number(),
});

const IndexSchema = z.object({
  currentId: z.string().nullable().catch(null),
  metas: z
    .array(z.unknown())
    .catch([])
    .transform((list) =>
      list.flatMap((m) => (MetaSchema.safeParse(m).success ? [m as ConversationMeta] : [])),
    ),
});

const CHATS_DIR = FileSystem.documentDirectory + 'chats/';
const INDEX_PATH = CHATS_DIR + 'index.json';
const convPath = (id: string) => `${CHATS_DIR}${id}.json`;

const WRITE_DEBOUNCE_MS = 300;
const TITLE_MAX = 44;

let metas: ConversationMeta[] = [];
let currentId: string | null = null;
let currentMessages: StoredMessage[] = [];
// Serialized form of the last write for the open conversation, so re-saving
// unchanged messages (e.g. right after restore) is a no-op that doesn't bump
// updatedAt or reorder the list.
let lastSavedJson: string | null = null;

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

// --- init & persistence ---
let initPromise: Promise<void> | null = null;

/** Idempotent. Loads the index and the previously open conversation. */
export function init(): Promise<void> {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    // Land any debounced write before the OS can freeze or kill the process.
    AppState.addEventListener('change', (s) => {
      if (s !== 'active') void flushWrites();
    });
    await FileSystem.makeDirectoryAsync(CHATS_DIR, { intermediates: true }).catch(() => {});

    const rawIndex = await FileSystem.readAsStringAsync(INDEX_PATH).catch(() => null);
    if (rawIndex) {
      try {
        const parsed = IndexSchema.safeParse(JSON.parse(rawIndex));
        if (parsed.success) {
          metas = parsed.data.metas;
          currentId = parsed.data.currentId;
        }
      } catch {
        // corrupt index — start fresh (conversation files remain on disk)
      }
    }

    if (currentId) {
      currentMessages = await readConversation(currentId);
      lastSavedJson = JSON.stringify(currentMessages);
      // The index said a conversation is open but its file is gone/corrupt →
      // don't resurrect an empty shell.
      if (!currentMessages.length && !metas.some((m) => m.id === currentId)) currentId = null;
    }
    emit();
  })();
  return initPromise;
}

async function readConversation(id: string): Promise<StoredMessage[]> {
  const raw = await FileSystem.readAsStringAsync(convPath(id)).catch(() => null);
  if (!raw) return [];
  try {
    const parsed = ConversationFileSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data.messages : [];
  } catch {
    return [];
  }
}

let writeTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleWrite(): void {
  if (writeTimer) return;
  writeTimer = setTimeout(() => void flushWrites(), WRITE_DEBOUNCE_MS);
}

/** Write the open conversation + index to disk now. */
export async function flushWrites(): Promise<void> {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  const index = JSON.stringify({ currentId, metas });
  await FileSystem.writeAsStringAsync(INDEX_PATH, index).catch(() => {});
  if (currentId) {
    const body = JSON.stringify({ id: currentId, messages: currentMessages });
    await FileSystem.writeAsStringAsync(convPath(currentId), body).catch(() => {});
  }
}

// --- queries ---
export function list(): ConversationMeta[] {
  return [...metas].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getCurrentId(): string | null {
  return currentId;
}

export function getCurrentMessages(): StoredMessage[] {
  return currentMessages;
}

// --- actions ---
function titleFrom(messages: StoredMessage[]): string {
  const first = messages.find((m) => m.role === 'user' && m.content.trim());
  if (!first) return 'New chat';
  const text = first.content.trim().replace(/\s+/g, ' ');
  if (text.length <= TITLE_MAX) return text;
  const cut = text.slice(0, TITLE_MAX);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 24))}…`;
}

/**
 * Persist the open conversation's messages. Creates the conversation (id,
 * title, index entry) on the first non-empty save. No-op when unchanged.
 */
export function saveCurrent(messages: StoredMessage[]): void {
  if (!messages.length && !currentId) return;
  const json = JSON.stringify(messages);
  if (currentId && json === lastSavedJson) return;

  if (!currentId) {
    currentId = `c${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
    metas = [
      ...metas,
      { id: currentId, title: titleFrom(messages), updatedAt: Date.now(), messageCount: 0 },
    ];
  }
  currentMessages = messages;
  lastSavedJson = json;
  const id = currentId;
  metas = metas.map((m) =>
    m.id === id
      ? {
          ...m,
          title: m.title === 'New chat' ? titleFrom(messages) : m.title,
          updatedAt: Date.now(),
          messageCount: messages.length,
        }
      : m,
  );
  scheduleWrite();
  emit();
}

/** Open a conversation from the list. */
export async function open(id: string): Promise<void> {
  if (id === currentId) return;
  await flushWrites();
  currentMessages = await readConversation(id);
  lastSavedJson = JSON.stringify(currentMessages);
  currentId = id;
  scheduleWrite();
  emit();
}

/** Start a fresh conversation (created lazily on its first message). */
export async function startNew(): Promise<void> {
  if (!currentId && !currentMessages.length) return;
  await flushWrites();
  currentId = null;
  currentMessages = [];
  lastSavedJson = null;
  scheduleWrite();
  emit();
}

/** Delete a conversation and its file. */
export async function remove(id: string): Promise<void> {
  await flushWrites();
  metas = metas.filter((m) => m.id !== id);
  if (currentId === id) {
    currentId = null;
    currentMessages = [];
    lastSavedJson = null;
  }
  await FileSystem.deleteAsync(convPath(id), { idempotent: true });
  scheduleWrite();
  emit();
}
