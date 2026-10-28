import assert from "node:assert/strict";
import {
  activeToken,
  composerKeyAction,
  formatReferenceToken,
  type ComposerKeyInput,
} from "../../packages/client/src/lib/composer-triggers.js";

const atEnd = (text: string) => activeToken(text, text.length);

// @ triggers
assert.deepEqual(atEnd("@Ali"), { trigger: "@", query: "Ali", start: 0, end: 4, quoted: false });
assert.deepEqual(atEnd("ask @Al"), { trigger: "@", query: "Al", start: 4, end: 7, quoted: false });
assert.equal(atEnd("ask (@Al")?.start, 5);
assert.equal(atEnd("@")?.query, "");
assert.equal(atEnd("me@mail.com"), null);
assert.equal(atEnd("a@"), null);
// caret mid-token: the query stops at the caret, the token end does not
const mid = activeToken("hi @Alice there", 6);
assert.equal(mid?.query, "Al");
assert.equal(mid?.start, 3);
assert.equal(mid?.end, 9);
// a space ends it
assert.equal(atEnd("@Alice "), null);
assert.equal(activeToken("@Alice bob", 7), null);
// quoted
assert.deepEqual(atEnd('@"Alice in'), { trigger: "@", query: "Alice in", start: 0, end: 10, quoted: true });
assert.equal(atEnd('see @"Alice in Wonderland"'), null);
assert.equal(activeToken('@"Alice in Wonderland" x', 21)?.query, "Alice in Wonderland");
assert.equal(activeToken('@"Alice in Wonderland" x', 22), null);
assert.equal(atEnd('@"Alice" and @Bo')?.query, "Bo");

// / triggers
assert.deepEqual(atEnd("/he"), { trigger: "/", query: "he", start: 0, end: 3, quoted: false });
assert.equal(atEnd("/")?.query, "");
assert.equal(atEnd("hello\n/he")?.start, 6);
assert.equal(atEnd("  /he")?.start, 2);
assert.equal(atEnd("hello /he"), null);
assert.equal(atEnd("/usr/bin"), null);
assert.equal(atEnd("and/or"), null);
assert.equal(atEnd("/help me"), null);

// formatReferenceToken
assert.equal(formatReferenceToken("Alice"), "@Alice");
assert.equal(formatReferenceToken("Alice in Wonderland"), '@"Alice in Wonderland"');
assert.equal(formatReferenceToken('The "Best" One'), '@"The Best One"');

// composerKeyAction
const base: ComposerKeyInput = {
  key: "",
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  isComposing: false,
  pickerOpen: false,
  hasGhost: false,
  enterToSend: true,
};
const act = (over: Partial<ComposerKeyInput>) => composerKeyAction({ ...base, ...over });
assert.equal(act({ key: "Enter", isComposing: true, pickerOpen: true }), "none");
assert.equal(act({ key: "Tab", isComposing: true, hasGhost: true }), "none");
assert.equal(act({ key: "ArrowDown", pickerOpen: true }), "picker-next");
assert.equal(act({ key: "ArrowUp", pickerOpen: true }), "picker-prev");
assert.equal(act({ key: "Enter", pickerOpen: true }), "picker-accept");
assert.equal(act({ key: "Tab", pickerOpen: true, hasGhost: true }), "picker-accept");
assert.equal(act({ key: "Escape", pickerOpen: true }), "picker-close");
assert.equal(act({ key: "Escape" }), "none");
assert.equal(act({ key: "ArrowDown" }), "none");
assert.equal(act({ key: "Tab", hasGhost: true }), "ghost-accept");
assert.equal(act({ key: "Tab", hasGhost: true, shiftKey: true }), "none");
assert.equal(act({ key: "Tab" }), "none");
assert.equal(act({ key: "Enter", hasGhost: true }), "send");
assert.equal(act({ key: "Enter", shiftKey: true }), "none");
assert.equal(act({ key: "Enter", enterToSend: false }), "none");
assert.equal(act({ key: "Enter", enterToSend: false, metaKey: true }), "send");
assert.equal(act({ key: "Enter", enterToSend: false, ctrlKey: true }), "send");
assert.equal(act({ key: "a" }), "none");

console.log("Composer triggers regression passed");
