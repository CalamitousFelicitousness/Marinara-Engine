// Guards the Home Professor Mari prompt split introduced for #4768.
//
// The name lists and fetched data used to live inside the system message, so any
// library change or [fetch:] rewrote the static system prefix — token noise on
// large libraries and a prompt-cache-busting churn every turn. resolveProfessorMari-
// PromptContext now returns { stablePrompt, volatileContext }: the instruction half
// stays a static system prefix, and the volatile half is injected as a tail message.
// These pins lock in that separation, the per-category cap, and byte-determinism.
import assert from "node:assert/strict";
import { PROFESSOR_MARI_ID } from "../../packages/shared/src/constants/defaults.js";
import { MARI_ASSISTANT_PROMPT } from "../../packages/server/src/db/seed-mari.js";
import { resolveProfessorMariPromptContext } from "../../packages/server/src/routes/generate/professor-mari-prompt-context.js";

const MAX_PER_TYPE = 100; // must track MAX_MARI_AVAILABLE_NAMES_PER_TYPE in the source.

type CharRow = { id?: string | null; data?: unknown };
type NamedRow = { name?: unknown };

function charRow(name: string, id = name): CharRow {
  return { id, data: JSON.stringify({ name }) };
}

function makeStores(opts: {
  chars?: CharRow[];
  personas?: NamedRow[];
  lorebooks?: NamedRow[];
  chats?: NamedRow[];
  presets?: NamedRow[];
  throwOnCharsList?: boolean;
}) {
  return {
    chars: {
      list: async (): Promise<CharRow[]> => {
        if (opts.throwOnCharsList) throw new Error("boom");
        return opts.chars ?? [];
      },
      listPersonas: async (): Promise<NamedRow[]> => opts.personas ?? [],
    },
    lorebooksStore: { list: async (): Promise<unknown[]> => opts.lorebooks ?? [] },
    chats: { list: async (): Promise<unknown[]> => opts.chats ?? [] },
    presets: { list: async (): Promise<unknown[]> => opts.presets ?? [] },
  };
}

// ── 1. The split pin: the stable half is exactly the instruction block, and the
//       volatile blocks never leak back into it. This is the guard against a
//       future refactor quietly folding the lists back into the system prefix.
{
  // A name and body distinctive enough that they cannot appear in the static
  // instruction prompt (whose <data_access> block ships example names like "Luna").
  const RUNTIME_NAME = "Zephyrine-Testcard-9271";
  const RUNTIME_BODY = "FETCHED-BODY-SENTINEL-9271";
  const { stablePrompt, volatileContext } = await resolveProfessorMariPromptContext({
    chatMeta: { mariContext: { [`character:${RUNTIME_NAME}`]: RUNTIME_BODY } },
    ...makeStores({ chars: [charRow(RUNTIME_NAME)], presets: [{ name: "Creative Writing" }] }),
  });

  // The instruction prompt legitimately *names* the <available_names> tag to
  // teach Mari the idiom, so we pin on the runtime DATA (a character name, a
  // fetched body) never leaking into the stable half — that is the separation
  // that actually matters for cache stability.
  assert.equal(stablePrompt, MARI_ASSISTANT_PROMPT, "stablePrompt must be exactly MARI_ASSISTANT_PROMPT");
  assert.ok(!stablePrompt.includes(RUNTIME_NAME), "a runtime character name must not appear in the stable half");
  assert.ok(!stablePrompt.includes(RUNTIME_BODY), "fetched data must not appear in the stable half");
  assert.match(volatileContext, /<available_names type="character">/);
  assert.ok(volatileContext.includes(RUNTIME_NAME), "the character name must appear in the volatile half");
  assert.match(volatileContext, /<loaded_context>/);
  assert.ok(volatileContext.includes(RUNTIME_BODY), "fetched data must appear in the volatile half");
}

// ── 2. A [fetch:] (populated mariContext) must not disturb the stable half.
{
  const base = makeStores({ chars: [charRow("Luna")] });
  const empty = await resolveProfessorMariPromptContext({ chatMeta: {}, ...base });
  const fetched = await resolveProfessorMariPromptContext({
    chatMeta: { mariContext: { "character:Luna": "fetched body" } },
    ...makeStores({ chars: [charRow("Luna")] }),
  });

  assert.equal(empty.stablePrompt, fetched.stablePrompt, "fetching must leave stablePrompt byte-identical");
  assert.notEqual(empty.volatileContext, fetched.volatileContext, "only the volatile half changes on fetch");
  assert.ok(!empty.volatileContext.includes("<loaded_context>"), "no fetched data yet → no loaded_context block");
}

// ── 3. Order-independence: the same entities in a different store order must
//       produce a byte-identical volatile block. This is the direct pin on the
//       FR's cache-invalidation mechanism (desc(updatedAt) reorders on any bump).
{
  const ascending = ["Aardvark", "Bob", "Cleo", "Dana", "Echo"];
  const shuffled = ["Echo", "Aardvark", "Dana", "Cleo", "Bob"];
  const a = await resolveProfessorMariPromptContext({
    chatMeta: {},
    ...makeStores({ chars: ascending.map((n) => charRow(n)) }),
  });
  const b = await resolveProfessorMariPromptContext({
    chatMeta: {},
    ...makeStores({ chars: shuffled.map((n) => charRow(n)) }),
  });
  assert.equal(a.volatileContext, b.volatileContext, "store order must not change the emitted block");
  assert.match(a.volatileContext, /Aardvark, Bob, Cleo, Dana, Echo/, "names must be sorted by codepoint");
}

// ── 4. Cap + overflow hint. 250 characters in → exactly MAX_PER_TYPE names and a
//       correct overflow count; a small library → all names, no hint.
{
  const many = Array.from({ length: 250 }, (_, i) => charRow(`char-${String(i).padStart(3, "0")}`));
  const { volatileContext } = await resolveProfessorMariPromptContext({
    chatMeta: {},
    ...makeStores({ chars: many }),
  });
  const block = volatileContext.match(/<available_names type="character">\n([\s\S]*?)\n<\/available_names>/);
  assert.ok(block, "character block must be present");
  const [namesLine, hintLine] = block![1]!.split("\n");
  const shown = namesLine!.split(", ");
  assert.equal(shown.length, MAX_PER_TYPE, `expected exactly ${MAX_PER_TYPE} names, got ${shown.length}`);
  assert.match(hintLine ?? "", /…and 150 more not listed/, "overflow hint must report the correct remainder");
  assert.match(hintLine ?? "", /fetch any of them by exact name/, "overflow hint must teach the fetch escape hatch");

  const few = await resolveProfessorMariPromptContext({
    chatMeta: {},
    ...makeStores({ chars: Array.from({ length: 10 }, (_, i) => charRow(`only-${i}`)) }),
  });
  assert.ok(!few.volatileContext.includes("more not listed"), "under the cap → no overflow hint");
}

// ── 5. Determinism across runs: identical inputs → byte-identical output (catches
//       accidental Set-iteration order leakage, Date, or randomness).
{
  const build = () =>
    resolveProfessorMariPromptContext({
      chatMeta: { mariContext: { "preset:X": "body" } },
      ...makeStores({
        chars: [charRow("Zed"), charRow("Amy")],
        personas: [{ name: "Alex" }],
        lorebooks: [{ name: "Arcadia" }],
        chats: [{ name: "Chat 1" }],
        presets: [{ name: "P1" }],
      }),
    });
  const first = await build();
  const second = await build();
  assert.deepEqual(first, second, "identical inputs must yield identical output");
}

// ── 6. Preserved behavior: Mari filters herself out; a throwing store degrades to
//       a usable stablePrompt with no lists; an empty library yields no volatile block.
{
  const withMari = await resolveProfessorMariPromptContext({
    chatMeta: {},
    ...makeStores({ chars: [charRow("Professor Mari", PROFESSOR_MARI_ID), charRow("Luna")] }),
  });
  assert.ok(!withMari.volatileContext.includes("Professor Mari"), "Mari must be filtered from her own name list");
  assert.match(withMari.volatileContext, /Luna/);

  const thrown = await resolveProfessorMariPromptContext({
    chatMeta: {},
    ...makeStores({ throwOnCharsList: true }),
  });
  assert.equal(thrown.stablePrompt, MARI_ASSISTANT_PROMPT, "a store failure must still yield the instruction block");
  assert.equal(thrown.volatileContext, "", "a store failure yields no partial name lists");

  const emptyLib = await resolveProfessorMariPromptContext({ chatMeta: {}, ...makeStores({}) });
  assert.equal(emptyLib.volatileContext, "", "an empty library yields an empty volatile block");
}

process.stdout.write("Professor Mari prompt-context regression passed.\n");
