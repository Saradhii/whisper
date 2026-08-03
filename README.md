# Whisper

A bare-bones React Native (Expo) chat app that runs LLMs fully **on-device,
offline** via [`llama.rn`](https://github.com/mybigday/llama.rn) (llama.cpp).
No servers. Models are downloaded, deleted, and switched **inside the app** —
including any custom GGUF from Hugging Face. Multimodal models (with a mmproj
file) can look at images.

## How it works

- `src/engines/` — engine abstraction. One interface (`load / generate / stop /
  unload`), one implementation per runtime. Today that's `LlamaEngine`
  (llama.cpp via llama.rn); a LiteRT-LM engine for `.litertlm` Gemma builds can
  slot in without touching the UI.
- `src/models/catalog.ts` — built-in model catalog (Gemma 4 E2B recommended;
  E4B gated behind a 12 GB RAM warning) with per-model engine, URLs, size, and
  minimum-RAM metadata.
- `src/models/ModelManager.ts` — download with progress (crash-safe `.part`
  staging), cancel, delete, active-model selection, and user-added custom GGUF
  URLs. State persists to a JSON file in the app's documents directory.
- `app/index.tsx` — chat screen (streams tokens, image attach when the active
  model supports vision).
- `app/models.tsx` — model manager screen (download / cancel / delete / switch,
  device RAM + free-storage readout, add custom GGUF URLs).

### Memory guardrails

An 8 GB Android phone can't hold Gemma 4 **E4B** as a GGUF: llama.cpp
materializes all ~8B raw params (~5 GB) plus a ~1 GB F16 mmproj in RAM — unlike
Google's LiteRT-LM, which memory-maps the per-layer embeddings. The catalog
records each model's minimum RAM and the models screen warns (using the actual
device RAM via `expo-device`) before you download something that will crash
the device. **E2B** (~3.4 GB download) is the recommended default and runs
comfortably in 8 GB.

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
   This runs `expo prebuild` + a native build automatically. On first launch,
   pick a model on the **Models** screen and download it (E2B ≈ 3.4 GB).

### Build a standalone Android APK (no EAS account)

```bash
npx expo prebuild --platform android --clean --no-install
cd android && ./gradlew assembleRelease
# → android/app/build/outputs/apk/release/app-release.apk
```

The release build is signed with the debug keystore, so the APK installs on any
device directly (enable "install unknown apps"). Models are **not** bundled in
the APK — download them from the in-app Models screen.

## Notes

- iOS gets Metal GPU offload; Android runs models on CPU (a 2–4B model on CPU
  is usable but not fast — expect a wait per reply).
- GGUFs carry their own chat template, so prompts are formatted correctly per
  model.
