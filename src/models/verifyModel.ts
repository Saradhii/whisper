// Glue: run the uncensored canary against a loaded model and store the result.
// Kept out of canary.ts (pure/testable) because this touches the engine and
// ModelManager. Called once from the chat screen after an uncensored model
// finishes loading.
import { engineFor, type AgentMessage } from '@/src/engines';
import type { ModelSpec } from './catalog';
import { runCanary } from './canary';
import * as ModelManager from './ModelManager';

/**
 * If `spec` is an uncensored model that hasn't been verified yet, run the
 * canary prompts through its loaded engine and persist pass/fail. No-op for
 * non-uncensored or already-verified models. Safe to call repeatedly.
 */
export async function ensureVerified(spec: ModelSpec): Promise<void> {
  if (!spec.uncensored) return;
  if (ModelManager.getVerifyState(spec.id) !== 'unverified') return;

  ModelManager.markVerifying(spec.id);
  const engine = engineFor(spec);
  const generate = async (prompt: string): Promise<string> => {
    const messages: AgentMessage[] = [{ role: 'user', content: prompt }];
    // Engine calls are queued, so a user message sent mid-canary waits behind
    // these generations — keep them short. Refusal boilerplate shows up in the
    // first sentences, so a low cap loses nothing.
    const res = await engine.generate(messages, () => {}, {
      maxTokens: 160,
      disableThinking: true,
    });
    return res.text;
  };

  try {
    const result = await runCanary(generate);
    ModelManager.setVerifyResult(spec.id, result.passed);
  } catch {
    ModelManager.setVerifyResult(spec.id, false);
  }
}
