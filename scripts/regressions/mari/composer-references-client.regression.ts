import assert from "node:assert/strict";
import type { MariComposerReference } from "../../../packages/shared/src/types/chat.js";
import { activeToken } from "../../../packages/client/src/lib/composer-triggers.js";
import {
  addReference,
  applyReferencePick,
  buildEntryItems,
  buildReferenceItems,
  completedNameAt,
  linkCompletedReference,
  defaultActiveIndex,
  locateReferenceTokens,
  MAX_COMPOSER_REFERENCES,
  maskReferenceQuery,
  pruneReferences,
  rankReferenceItems,
  referenceFromResource,
  referenceMatchScore,
} from "../../../packages/client/src/lib/mari-composer-references.js";

const ref = (kind: MariComposerReference["kind"], id: string, label: string): MariComposerReference => ({
  kind,
  id,
  label,
});

// masking and ranking
assert.equal(maskReferenceQuery("@Jes"), "Jes");
assert.equal(maskReferenceQuery('@"Jes'), "Jes");
assert.equal(referenceMatchScore("Jessica", "jes"), 0);
assert.equal(referenceMatchScore("Jessica", "@Jes"), 0);
assert.equal(referenceMatchScore("Alice in Wonderland", "won"), 1);
assert.equal(referenceMatchScore("Alice in Wonderland", "land"), 2);
assert.equal(referenceMatchScore("Alice", "zzz"), null);
assert.equal(referenceMatchScore("Alice", ""), 3);

const items = buildReferenceItems({
  characters: [
    { id: "c1", data: JSON.stringify({ name: "Xjessica" }), comment: null },
    { id: "c2", data: JSON.stringify({ name: "Jessica Rabbit" }), comment: null },
    { id: "c3", data: JSON.stringify({ name: "Bob" }), comment: null },
  ],
  personas: [{ id: "p1", name: "Jess" }],
  lorebooks: [{ id: "l1", name: "Jessica's World" }, { id: "l2", name: "  " }, { name: "no id" }],
  presets: [{ id: "r1", name: "Default" }],
});
assert.deepEqual(
  items.map((item) => item.key),
  ["character:c1", "character:c2", "character:c3", "persona:p1", "lorebook:l1", "preset:r1"],
);
const ranked = rankReferenceItems(items, "@jess");
// grouped in order, best match first inside a group (prefix beats substring)
assert.deepEqual(
  ranked.map((row) => row.key),
  ["character:c2", "character:c1", "persona:p1", "lorebook:l1"],
);
assert.deepEqual(
  ranked.map((row) => row.score),
  [0, 2, 0, 0],
);
assert.equal(defaultActiveIndex(ranked), 0);
assert.equal(defaultActiveIndex(rankReferenceItems(items, "ice")), 0);
assert.equal(rankReferenceItems(items, "Default").length, 1);
assert.equal(rankReferenceItems(items, "").length, 6);
assert.equal(defaultActiveIndex([]), 0);

// the open editor's row leads, and only kinds the resolver reads
const open = referenceFromResource({ kind: "character", id: "c3", label: "Bob" });
assert.deepEqual(open?.ref, ref("character", "c3", "Bob"));
assert.equal(open?.group, "open");
assert.equal(referenceFromResource({ kind: "connection", id: "x", label: "Conn" }), null);
assert.equal(referenceFromResource({ kind: "chat", id: "x", label: "Chat" }), null);
assert.equal(referenceFromResource({ kind: "character", id: "x" }), null);
assert.equal(referenceFromResource(null), null);
const withOpen = rankReferenceItems([open!, ...items], "");
assert.equal(withOpen[0]!.key, "open:character:c3");
assert.equal(defaultActiveIndex(withOpen), 0);
// a better match elsewhere wins the highlight over a weaker open row
const withOpenQuery = rankReferenceItems([open!, ...items], "jess");
assert.equal(withOpenQuery[defaultActiveIndex(withOpenQuery)]!.key, "character:c2");

// a lorebook's entries carry its id as parentId
const entryItems = buildEntryItems({ id: "l1" }, [
  { id: "e1", name: "The Hat" },
  { id: "e2", name: "" },
]);
assert.deepEqual(
  entryItems.map((item) => item.ref),
  [{ kind: "lorebookEntry", id: "e1", label: "The Hat", parentId: "l1" }],
);

// picking writes the token over the live @ token
const draft = "tell me about @Jes now";
const token = activeToken(draft, 18)!;
assert.deepEqual(applyReferencePick(draft, token, ref("character", "c2", "Jessica Rabbit")), {
  value: "tell me about @Jessica Rabbit now",
  caret: 30,
});
const atEnd = activeToken("hi @Je", 6)!;
assert.deepEqual(applyReferencePick("hi @Je", atEnd, ref("persona", "p1", "Jess")), { value: "hi @Jess ", caret: 9 });
// the caret lands outside the token, so the picker does not reopen
assert.equal(activeToken("hi @Jess ", 9), null);
assert.equal(activeToken("tell me about @Jessica Rabbit now", 28), null);
// a bare name is linked as one token: no quotes in the draft
const bareDraft = "ask @Fel Lock";
assert.deepEqual(
  applyReferencePick(bareDraft, activeToken(bareDraft, bareDraft.length)!, ref("character", "c4", "Fel Lock")),
  {
    value: "ask @Fel Lock ",
    caret: 14,
  },
);

// drop-on-edit: a pick lives while its token text does
const jess = ref("persona", "p1", "Jess");
const jessica = ref("character", "c2", "Jessica Rabbit");
const full = "hi @Jess and @Jessica Rabbit.";
assert.deepEqual(locateReferenceTokens(full, [jess, jessica]), [
  { start: 3, end: 8 },
  { start: 13, end: 28 },
]);
const picks = [jess, jessica];
assert.equal(pruneReferences(full, picks), picks);
assert.deepEqual(pruneReferences("hi @Jessi", picks), []);
assert.deepEqual(pruneReferences("hi @Jess2 and Jessica Rabbit", picks), []);
assert.deepEqual(pruneReferences("hi @Jess2 and @Jessica Rabbit", picks), [jessica]);
assert.deepEqual(pruneReferences("hi Jess and @Jessica Rabbit", picks), [jessica]);
assert.deepEqual(pruneReferences("(@Jess)", picks), [jess]);
assert.deepEqual(pruneReferences("me@Jess", picks), []);
assert.deepEqual(pruneReferences("", picks), []);
// the same name picked twice takes the occurrences in turn
const twin = ref("character", "c9", "Jess");
assert.deepEqual(locateReferenceTokens("@Jess @Jess", [jess, twin]), [
  { start: 0, end: 5 },
  { start: 6, end: 11 },
]);
assert.deepEqual(locateReferenceTokens("@Jess", [jess, twin]), [{ start: 0, end: 5 }, null]);
// a hand-typed token that was never picked is not a reference
assert.deepEqual(pruneReferences("see @docs/FAQ.md", []), []);

// second Tab in prose: the completed name becomes the reference
assert.deepEqual(completedNameAt("tell me about Jessica", ["Jessica", "Jessica Rabbit"]), {
  start: 14,
  label: "Jessica",
});
assert.deepEqual(completedNameAt("about Alice in Wonderland", ["Alice in Wonderland", "Alice"]), {
  start: 6,
  label: "Alice in Wonderland",
});
assert.equal(completedNameAt("@Jess", ["Jess"]), null);
assert.equal(completedNameAt("Jessy", ["Jess"]), null);
assert.equal(completedNameAt("say hi", ["Jessica"]), null);
const plainJess = ref("character", "c6", "Jessica");
assert.deepEqual(linkCompletedReference("tell me about Jessica", ["Jessica"], [plainJess]), {
  value: "tell me about @Jessica",
  caret: 22,
  ref: plainJess,
});
assert.equal(linkCompletedReference("about Jessica", ["Jessica"], [jessica]), null);
// the ghost always completes the whole label, so a bare prefix is not a completion
assert.equal(linkCompletedReference("about Jess", ["Jessica"], [jessica]), null);
assert.equal(linkCompletedReference("nothing here", ["Jessica"], [jessica]), null);

// the cap and duplicates
assert.deepEqual(addReference([jess], jess), [jess]);
let many: readonly MariComposerReference[] = [];
for (let i = 0; i < MAX_COMPOSER_REFERENCES + 3; i++) many = addReference(many, ref("preset", `r${i}`, `P${i}`));
assert.equal(many.length, MAX_COMPOSER_REFERENCES);

console.log("Composer references client regression passed");
