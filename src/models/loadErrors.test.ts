import { describe, expect, it } from 'vitest';

import { humanizeLoadError } from './loadErrors';

const spec = { name: 'Gemma 4 E2B', minRamBytes: 8 * 1024 * 1024 * 1024 };

describe('humanizeLoadError', () => {
  it('maps allocation failures to a memory explanation with sizes', () => {
    const msg = humanizeLoadError(
      'failed to allocate backend buffer of size 4294967296',
      spec,
      8 * 1024 * 1024 * 1024,
    );
    expect(msg).toContain('ran out of memory');
    expect(msg).toContain('Gemma 4 E2B');
    expect(msg).toContain('8.0 GB');
  });

  it('omits device RAM when unknown', () => {
    const msg = humanizeLoadError('out of memory', spec, null);
    expect(msg).toContain('ran out of memory');
    expect(msg).not.toContain('this phone has');
  });

  it('maps corrupt-file errors to a re-download hint', () => {
    expect(humanizeLoadError('gguf_init_from_file: invalid magic', spec, null)).toContain(
      'download it again',
    );
  });

  it('passes through unrecognized errors unchanged', () => {
    expect(humanizeLoadError('something else broke', spec, null)).toBe('something else broke');
  });
});
