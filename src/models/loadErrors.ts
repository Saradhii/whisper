// Translate raw llama.cpp / native load failures into language a phone user
// can act on. The engine knows exactly why big models fail on small phones —
// the user should never have to read "failed to allocate backend buffer".
// Pure module so it is unit-tested in Node.
import { formatBytes } from './catalog';

const MEMORY_RE = /alloc|memory|oom|buffer|mmap failed/i;
const CORRUPT_RE = /gguf|magic|corrupt|invalid|unexpected end|parse|bad file/i;

export function humanizeLoadError(
  raw: string,
  spec: { name: string; minRamBytes: number },
  deviceRamBytes: number | null,
): string {
  if (MEMORY_RE.test(raw)) {
    const needs =
      spec.minRamBytes > 0
        ? ` ${spec.name} needs about ${formatBytes(spec.minRamBytes)} of RAM${
            deviceRamBytes ? `; this phone has ${formatBytes(deviceRamBytes)}` : ''
          }.`
        : '';
    return `Your phone ran out of memory loading this model.${needs} Try a smaller model, or close other apps and try again.`;
  }
  if (CORRUPT_RE.test(raw)) {
    return 'The model file appears damaged. Delete it on the Models screen and download it again.';
  }
  return raw;
}
