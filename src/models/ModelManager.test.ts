// The download state machine, against a fake file system and a fake native
// download whose promise the test settles by hand — including never.
//
// "Never" is the case that matters. Pause and Cancel used to rely on the
// native call settling before the row left "downloading"; when it did not, the
// row was stuck with two dead buttons until the app was force-closed.
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Result = { status: number } | undefined;

const fs = vi.hoisted(() => {
  const files = new Map<string, string | number>(); // path -> text, or a byte size
  const downloads: {
    url: string;
    path: string;
    resumeData?: string;
    progress: (written: number, total: number) => void;
    /** Settle the native promise. Writes `bytes` to the .part first. */
    finish: (result: { status: number } | undefined, bytes?: number) => void;
    fail: (message: string) => void;
    pauseAsync: ReturnType<typeof vi.fn>;
    cancelAsync: ReturnType<typeof vi.fn>;
  }[] = [];
  return { files, downloads, nativeStopHangs: false, platform: 'android' };
});

vi.mock('react-native', () => ({
  Platform: {
    get OS() {
      return fs.platform;
    },
  },
}));

vi.mock('expo-file-system/legacy', () => {
  const size = (v: string | number) => (typeof v === 'number' ? v : v.length);
  return {
    documentDirectory: 'file:///doc/',
    EncodingType: { Base64: 'base64' },
    makeDirectoryAsync: async () => {},
    readDirectoryAsync: async (dir: string) =>
      [...fs.files.keys()].filter((p) => p.startsWith(dir)).map((p) => p.slice(dir.length)),
    readAsStringAsync: async (path: string, opts?: { encoding?: string }) => {
      const v = fs.files.get(path);
      if (v === undefined) throw new Error('ENOENT');
      // Every byte-sized fake file "starts with GGUF".
      if (opts?.encoding === 'base64') return 'R0dVRg==';
      return String(v);
    },
    writeAsStringAsync: async (path: string, text: string) => {
      fs.files.set(path, text);
    },
    deleteAsync: async (path: string) => {
      fs.files.delete(path);
    },
    moveAsync: async ({ from, to }: { from: string; to: string }) => {
      const v = fs.files.get(from);
      if (v === undefined) throw new Error('ENOENT');
      fs.files.delete(from);
      fs.files.set(to, v);
    },
    getInfoAsync: async (path: string) => {
      const v = fs.files.get(path);
      return v === undefined ? { exists: false } : { exists: true, size: size(v) };
    },
    getFreeDiskStorageAsync: async () => 1e12,
    createDownloadResumable: (
      url: string,
      path: string,
      _opts: unknown,
      cb: (p: { totalBytesWritten: number; totalBytesExpectedToWrite: number }) => void,
      resumeData?: string,
    ) => {
      let settle!: (r: Result) => void;
      let reject!: (e: Error) => void;
      const promise = new Promise<Result>((res, rej) => {
        settle = res;
        reject = rej;
      });
      const stop = vi.fn(async () => {
        // Real behaviour: tearing the call down resolves the start promise
        // with nothing. `nativeStopHangs` models the failure this suite
        // exists for — the teardown that never reports back.
        if (fs.nativeStopHangs) return new Promise<never>(() => {});
        settle(undefined);
        return undefined;
      });
      const d = {
        url,
        path,
        resumeData,
        progress: (written: number, total: number) =>
          cb({ totalBytesWritten: written, totalBytesExpectedToWrite: total }),
        finish: (result: Result, bytes?: number) => {
          if (bytes !== undefined) fs.files.set(path, bytes);
          settle(result);
        },
        fail: (message: string) => reject(new Error(message)),
        pauseAsync: stop,
        cancelAsync: stop,
      };
      fs.downloads.push(d);
      return { downloadAsync: () => promise, resumeAsync: () => promise, ...d };
    },
  };
});

type Manager = typeof import('./ModelManager');
let M: Manager;
let spec: import('./catalog').ModelSpec;
const PART = () => `file:///doc/models/${spec.files[0]!.filename}.part`;
const FINAL = () => `file:///doc/models/${spec.files[0]!.filename}`;

/** Let queued promise continuations run. */
const tick = async (n = 20) => {
  for (let i = 0; i < n; i++) await Promise.resolve();
};

beforeEach(async () => {
  vi.resetModules();
  vi.useRealTimers();
  fs.files.clear();
  fs.downloads.length = 0;
  fs.nativeStopHangs = false;
  fs.platform = 'android';
  M = await import('./ModelManager');
  await M.init();
  // A single-file catalog model keeps the scenarios readable.
  spec = M.allModels().find((m) => m.files.length === 1)!;
});

describe('download', () => {
  it('installs the model and makes it active', async () => {
    const done = M.download(spec);
    await tick();
    expect(M.getStatus(spec.id).downloading).toBe(true);
    fs.downloads[0]!.progress(500, 1000);
    fs.downloads[0]!.finish({ status: 200 }, 1000);
    await done;
    expect(M.getStatus(spec.id)).toMatchObject({ installed: true, downloading: false });
    expect(fs.files.has(FINAL())).toBe(true);
    expect(fs.files.has(PART())).toBe(false);
    expect(M.getActive()?.id).toBe(spec.id);
  });

  it('shows "downloading" synchronously, before any file-system work', () => {
    void M.download(spec);
    expect(M.getStatus(spec.id).downloading).toBe(true);
  });

  it('keeps the partial bytes when the connection drops, and resumes from them', async () => {
    const first = M.download(spec);
    await tick();
    fs.files.set(PART(), 157_000_000);
    fs.downloads[0]!.fail('timeout');
    await expect(first).rejects.toThrow('timeout');
    // Not reset to zero, and not left "downloading": paused, with its bytes.
    expect(M.getStatus(spec.id)).toMatchObject({
      downloading: false,
      paused: true,
      bytesWritten: 157_000_000,
    });
    expect(fs.files.get(PART())).toBe(157_000_000);

    const second = M.download(spec);
    await tick();
    expect(fs.downloads[1]!.resumeData).toBe('157000000'); // HTTP Range offset
    fs.downloads[1]!.finish({ status: 206 }, spec.sizeBytes);
    await second;
    expect(M.getStatus(spec.id).installed).toBe(true);
  });

  it('a failure with nothing on disk drops back to a plain Download', async () => {
    const run = M.download(spec);
    await tick();
    fs.downloads[0]!.fail('no route to host');
    await expect(run).rejects.toThrow();
    expect(M.getStatus(spec.id)).toMatchObject({ downloading: false, paused: false });
  });

  it('never keeps an HTTP error page as a partial', async () => {
    const run = M.download(spec);
    await tick();
    fs.downloads[0]!.finish({ status: 503 }, 2048);
    await expect(run).rejects.toThrow('HTTP 503');
    expect(fs.files.has(PART())).toBe(false);
    expect(M.getStatus(spec.id).paused).toBe(false);
  });
});

describe('pause', () => {
  it('keeps the bytes and leaves the row resumable', async () => {
    const run = M.download(spec);
    await tick();
    fs.files.set(PART(), 4096);
    await M.pauseDownload(spec.id);
    await run; // resolves quietly — a pause is not a failure
    expect(M.getStatus(spec.id)).toMatchObject({
      downloading: false,
      paused: true,
      bytesWritten: 4096,
    });
    expect(fs.files.has(PART())).toBe(true);
  });

  it('leaves "downloading" immediately even if the native call never answers', async () => {
    vi.useFakeTimers();
    fs.nativeStopHangs = true;
    void M.download(spec);
    await tick();
    fs.files.set(PART(), 157_000_000);

    const paused = M.pauseDownload(spec.id);
    // Synchronously after the tap: no longer downloading.
    expect(M.getStatus(spec.id)).toMatchObject({ downloading: false, paused: true });
    await vi.advanceTimersByTimeAsync(5000);
    await paused;
    expect(M.getStatus(spec.id)).toMatchObject({
      downloading: false,
      paused: true,
      bytesWritten: 157_000_000,
    });
  });

  it('ignores progress events that arrive after the pause', async () => {
    const run = M.download(spec);
    await tick();
    const d = fs.downloads[0]!;
    await M.pauseDownload(spec.id);
    await run;
    d.progress(999, 1000);
    expect(M.getStatus(spec.id).downloading).toBe(false);
  });

  it('works in the window before the native download is registered', async () => {
    void M.download(spec); // not awaited: no native handle exists yet
    await M.pauseDownload(spec.id);
    await tick();
    expect(M.getStatus(spec.id).downloading).toBe(false);
    expect(fs.downloads.length).toBe(0); // and the detached run never started one
  });
});

describe('cancel', () => {
  it('deletes the partial and returns to a plain Download', async () => {
    const run = M.download(spec);
    await tick();
    fs.files.set(PART(), 4096);
    await M.cancelDownload(spec.id);
    await run;
    expect(M.getStatus(spec.id)).toMatchObject({
      downloading: false,
      paused: false,
      bytesWritten: 0,
    });
    expect(fs.files.has(PART())).toBe(false);
  });

  it('un-sticks the row even if the native call never answers', async () => {
    vi.useFakeTimers();
    fs.nativeStopHangs = true;
    void M.download(spec);
    await tick();
    fs.files.set(PART(), 157_000_000);

    const cancelled = M.cancelDownload(spec.id);
    expect(M.getStatus(spec.id).downloading).toBe(false); // immediately
    await vi.advanceTimersByTimeAsync(5000);
    await cancelled;
    expect(M.getStatus(spec.id)).toMatchObject({ downloading: false, paused: false });
    expect(fs.files.has(PART())).toBe(false);

    // And a fresh download can start afterwards.
    vi.useRealTimers();
    fs.nativeStopHangs = false;
    const again = M.download(spec);
    await tick();
    expect(M.getStatus(spec.id).downloading).toBe(true);
    fs.downloads[fs.downloads.length - 1]!.finish({ status: 200 }, 1000);
    await again;
    expect(M.getStatus(spec.id).installed).toBe(true);
  });

  it('a cancelled run that completes late does not install the model', async () => {
    fs.nativeStopHangs = true;
    vi.useFakeTimers();
    void M.download(spec);
    await tick();
    const stale = fs.downloads[0]!;
    const cancelled = M.cancelDownload(spec.id);
    await vi.advanceTimersByTimeAsync(5000);
    await cancelled;
    stale.finish({ status: 200 }, 1000); // the old transfer "finishes" anyway
    await tick();
    expect(M.getStatus(spec.id).installed).toBe(false);
    expect(fs.files.has(FINAL())).toBe(false);
  });

  it('clears a paused download left over from a previous session', async () => {
    const run = M.download(spec);
    await tick();
    fs.files.set(PART(), 4096);
    await M.pauseDownload(spec.id);
    await run;
    await M.cancelDownload(spec.id);
    expect(M.getStatus(spec.id)).toMatchObject({ paused: false, bytesWritten: 0 });
    expect(fs.files.has(PART())).toBe(false);
  });
});

describe('several models', () => {
  it('cancelling one download does not disturb another', async () => {
    const other = M.allModels().find((m) => m.files.length === 1 && m.id !== spec.id)!;
    void M.download(spec);
    void M.download(other);
    await tick();
    await M.cancelDownload(other.id);
    expect(M.getStatus(spec.id).downloading).toBe(true);
    expect(M.getStatus(other.id).downloading).toBe(false);
  });
});
