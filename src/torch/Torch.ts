// JS face of the local torch module (modules/whisper-torch/). Kept separate
// from the tool executor so the import-time lookup happens once, and so the
// "missing native module" case degrades to a tool error the model can relay —
// e.g. in Expo Go or on iOS, where this module is not linked — instead of
// crashing the app at import.
import { requireOptionalNativeModule } from 'expo-modules-core';

type WhisperTorchModule = {
  setTorch(on: boolean): Promise<null>;
};

const torch = requireOptionalNativeModule<WhisperTorchModule>('WhisperTorch');

/**
 * Set the rear flash LED. Throws (rather than returning a "failed" marker)
 * because the tool result channel is the model's only feedback: a throw is
 * what makes the loop report failure instead of claiming success.
 */
export async function setTorch(on: boolean): Promise<void> {
  if (!torch) {
    throw new Error('The torch is not available in this build of the app.');
  }
  await torch.setTorch(on);
}
