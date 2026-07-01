// Thin wrapper around llama.rn. The model + vision projector are fetched once on
// first launch, cached in the app's document directory, then used fully offline.
import * as FileSystem from 'expo-file-system/legacy';
import { Platform } from 'react-native';
import { initLlama, releaseAllLlama, type LlamaContext } from 'llama.rn';

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type LoadProgress =
  | { phase: 'downloading'; file: 'model' | 'vision'; progress: number } // 0..1
  | { phase: 'loading' };

// Gemma 4 E4B Instruct (Q4_K_M) — the edge/on-device variant, multimodal
// (text + vision). The mmproj file is the vision tower that lets the model
// actually see images. Swap both URLs to use a different GGUF.
const MODEL_URL =
  'https://huggingface.co/unsloth/gemma-4-E4B-it-GGUF/resolve/main/gemma-4-E4B-it-Q4_K_M.gguf';
const MMPROJ_URL =
  'https://huggingface.co/unsloth/gemma-4-E4B-it-GGUF/resolve/main/mmproj-F16.gguf';

const MODEL_PATH = FileSystem.documentDirectory + 'gemma-4-e4b.gguf';
const MMPROJ_PATH = FileSystem.documentDirectory + 'gemma-4-e4b-mmproj.gguf';

let context: LlamaContext | null = null;
let loading: Promise<LlamaContext> | null = null;

/** Download `url` to `path` (once), reporting progress. Cleans up partial files. */
async function ensureFile(
  url: string,
  path: string,
  file: 'model' | 'vision',
  onProgress?: (p: LoadProgress) => void,
): Promise<void> {
  const info = await FileSystem.getInfoAsync(path);
  if (info.exists) return;

  const download = FileSystem.createDownloadResumable(
    url,
    path,
    {},
    ({ totalBytesWritten, totalBytesExpectedToWrite }) => {
      const progress =
        totalBytesExpectedToWrite > 0 ? totalBytesWritten / totalBytesExpectedToWrite : 0;
      onProgress?.({ phase: 'downloading', file, progress });
    },
  );
  const result = await download.downloadAsync();
  if (!result || result.status !== 200) {
    await FileSystem.deleteAsync(path, { idempotent: true }); // drop partial file
    throw new Error(`Download failed for ${file} (status ${result?.status ?? 'unknown'}).`);
  }
}

/**
 * Ensure the model + vision projector are downloaded (once) and loaded. Cached
 * after first run, so subsequent launches are offline. Returns the live context.
 */
export function loadModel(onProgress?: (p: LoadProgress) => void): Promise<LlamaContext> {
  if (context) return Promise.resolve(context);
  if (loading) return loading;

  loading = (async () => {
    await ensureFile(MODEL_URL, MODEL_PATH, 'model', onProgress);
    await ensureFile(MMPROJ_URL, MMPROJ_PATH, 'vision', onProgress);

    onProgress?.({ phase: 'loading' });
    const ctx = await initLlama({
      model: MODEL_PATH.replace('file://', ''),
      n_ctx: 4096, // room for image tokens + prompt + reply
      n_gpu_layers: Platform.OS === 'ios' ? 99 : 0, // Metal on iOS; CPU on Android
    });

    // Enable vision. Without this, image parts in messages are ignored.
    await ctx.initMultimodal({
      path: MMPROJ_PATH.replace('file://', ''),
      use_gpu: Platform.OS === 'ios',
    });

    context = ctx;
    return context;
  })();

  return loading;
}

/**
 * Stream a completion for the given chat history. Optionally attaches a single
 * image (local file URI) to the latest user turn for vision.
 * llama.rn applies the GGUF's built-in chat template automatically and extracts
 * `image_url` parts into the native multimodal path.
 */
export async function generate(
  messages: ChatMessage[],
  onToken: (token: string) => void,
  imageUri?: string,
): Promise<string> {
  const ctx = await loadModel();

  // Build the OpenAI-compatible message list. If there's an image, replace the
  // last user turn's plain content with a [text, image] parts array.
  let payload: unknown[] = messages;
  if (imageUri) {
    const path = imageUri.replace('file://', '');
    payload = messages.map((m, i) =>
      i === messages.length - 1 && m.role === 'user'
        ? {
            role: 'user',
            content: [
              { type: 'text', text: m.content },
              { type: 'image_url', image_url: { url: path } },
            ],
          }
        : m,
    );
  }

  const result = await ctx.completion(
    {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      messages: payload as any,
      n_predict: 512,
      temperature: 0.7,
      stop: ['<end_of_turn>', '<eos>'],
    },
    (data) => {
      if (data.token) onToken(data.token);
    },
  );
  return result.text.trim();
}

/** Interrupt the in-flight generation. */
export async function stop(): Promise<void> {
  if (context) await context.stopCompletion();
}

/** Free native memory (e.g. on unmount). */
export async function unload(): Promise<void> {
  await releaseAllLlama();
  context = null;
  loading = null;
}
