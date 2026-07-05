import type { ModelSpec } from '@/src/models/catalog';
import { LlamaEngine } from './LlamaEngine';
import type { Engine } from './types';

export type {
  AgentMessage,
  ChatMessage,
  Engine,
  GenerateOptions,
  GenerateResult,
  ModelFiles,
  ToolCall,
} from './types';

/** Resolve the engine responsible for a model. */
export function engineFor(spec: ModelSpec): Engine {
  switch (spec.engine) {
    case 'llama':
      return LlamaEngine;
  }
}

/** Free native memory across every engine (e.g. when the active model is deleted). */
export async function unloadAll(): Promise<void> {
  await LlamaEngine.unload();
}
