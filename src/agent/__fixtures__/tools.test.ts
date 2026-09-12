// The fixture has to be faithful or every test built on it is measuring a
// product that does not exist. These are the two ways it has actually gone
// wrong, both silent, both pinned here.
import { describe, expect, it } from 'vitest';

import { systemPrompt, toolCatalog } from '@/src/agent/prompt';
import { TOOL_DEFS } from '@/src/agent/toolDefs';

import { emptySchemaTools, realTools } from './tools';

describe('realTools is the registry, not a subset of it', () => {
  it('carries every declared tool', () => {
    expect(realTools.map((t) => t.name).sort()).toEqual(Object.keys(TOOL_DEFS).sort());
  });

  it('carries the fields loop.ts reads, which every hand-rolled copy dropped', () => {
    // The trap this replaces. Three test files built this list without
    // `mutates` or `requiresConfirmation`, which is invisible for prompt
    // rendering and decisive anywhere else: loop.ts gates the confirmation
    // card on one and sets `acted` from the other. A fixture missing them is a
    // world where no tool can require confirmation and nothing can ever have
    // acted — so the confirmation card never renders, every turn takes the
    // read framing, and answerNote's denial branch is unreachable. Nothing
    // errors; the tests pass.
    expect(realTools.filter((t) => t.mutates).length).toBeGreaterThan(0);
    expect(realTools.filter((t) => t.requiresConfirmation).length).toBeGreaterThan(0);
    for (const [name, def] of Object.entries(TOOL_DEFS)) {
      const tool = realTools.find((t) => t.name === name)!;
      expect(!!tool.mutates, `${name}.mutates`).toBe(!!def.mutates);
      expect(!!tool.requiresConfirmation, `${name}.requiresConfirmation`).toBe(
        !!def.requiresConfirmation,
      );
    }
  });

  it('renders the argument descriptions — the thing an empty schema loses', () => {
    // Every `.describe()` in toolDefs.ts is load-bearing; they were once
    // written and never shown to the model, and "8pm today" came back as
    // 8:53 PM with the minute copied off the wall clock.
    const catalog = toolCatalog(realTools);
    expect(catalog).toContain('1pm is 13 and 6pm is 18');
    expect(catalog).toContain('0 unless a specific minute was asked for');
    expect(catalog).toContain('YYYY-MM-DD');
  });
});

describe('emptySchemaTools', () => {
  it('is 1059 characters lighter, and that gap is the argument descriptions', () => {
    // The number quoted in tools.ts, pinned so the comment cannot go stale
    // silently. It is the DURABLE figure: it measures the catalog's argument
    // descriptions and nothing else, so it survives prompt edits that move the
    // absolute sizes — it was 954 both before and after the pass that took the
    // date table out of systemPrompt. (Raised from 954 in the same pass that
    // added the torch tool: its `on` argument description and the enum values
    // now disclosed for search_phone_media.media_type are exactly the
    // argument-level teaching this gap exists to count.)
    const gap = systemPrompt(realTools).length - systemPrompt(emptySchemaTools).length;
    expect(gap).toBe(1059);
    expect(gap).toBe(toolCatalog(realTools).length - toolCatalog(emptySchemaTools).length);
  });

  it('keeps names and descriptions, so only the arguments differ', () => {
    expect(emptySchemaTools.map((t) => t.name)).toEqual(realTools.map((t) => t.name));
    expect(emptySchemaTools.map((t) => t.description)).toEqual(
      realTools.map((t) => t.description),
    );
  });
});
