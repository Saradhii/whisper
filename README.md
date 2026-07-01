# Whisper

A bare-bones React Native (Expo) chat app that runs **Gemma 4 E4B** (the
edge/on-device variant) fully **on-device, offline** via
[`llama.rn`](https://github.com/mybigday/llama.rn) (llama.cpp). No servers. The
model is a **multimodal** build, so it can look at images (vision) as well as
chat. The GGUF is downloaded once on first launch and then cached for fully
offline use.

## How it works

- `src/LlamaService.ts` — downloads the model + vision projector (mmproj) once,
  caches them in the app's document directory, enables multimodal, and streams
  completions.
- `app/index.tsx` — minimal chat screen (message list + input + image attach +
  send/stop). Attach a photo with **＋** and ask the model about it.
- Models are pulled from
  [`unsloth/gemma-4-E4B-it-GGUF`](https://huggingface.co/unsloth/gemma-4-E4B-it-GGUF):
  `gemma-4-E4B-it-Q4_K_M.gguf` (~5.0 GB) + `mmproj-F16.gguf` (~1.0 GB).

Because it uses a native module, this **cannot run in Expo Go** — it needs a
custom dev build.

## Setup

1. **Install deps**
   ```bash
   npm install
   ```

2. **Build & run** (real device or simulator; native build required)
   ```bash
   npm run ios       # or: npm run android
   ```
   This runs `expo prebuild` + a native build automatically. On first launch the
   app downloads ~6 GB of model files, so give it time and a good connection.

### Build a standalone Android APK (no EAS account)

```bash
npx expo prebuild --platform android --clean --no-install
cd android && ./gradlew assembleRelease
# → android/app/build/outputs/apk/release/app-release.apk
```

The release build is signed with the debug keystore, so the APK installs on any
device directly (enable "install unknown apps"). The model is **not** bundled in
the APK — it downloads on first run.

## Notes

- iOS gets Metal GPU offload; Android runs the model on CPU (4B on CPU is usable
  but not fast — expect a wait per reply).
- The GGUF carries its own chat template, so Gemma is formatted correctly.
- Swap models by changing `MODEL_URL` / `MMPROJ_URL` in `src/LlamaService.ts`.
