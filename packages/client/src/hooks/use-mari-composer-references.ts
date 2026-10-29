import type { MariComposerReference, ProfessorMariContextResource } from "@marinara-engine/shared";
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import { referenceOptionId, type MariReferencePickerProps } from "../components/chat/mari/MariReferencePicker";
import type { ActiveComposerToken, ComposerMark, ComposerPickerAction } from "../lib/composer-triggers";
import { rankCommands, removeCommandToken, type MariCommandId } from "../lib/mari-commands";
import {
  addReference,
  buildEntryItems,
  buildReferenceItems,
  completedNameAt,
  defaultActiveIndex,
  isCommandRow,
  isSlashLinkable,
  linkCompletedReference,
  locateReferenceTokens,
  MAX_COMPOSER_REFERENCES,
  applyReferencePick,
  pruneReferences,
  rankReferenceItems,
  referenceFromResource,
  withoutFuzzyNoise,
  type PickerRow,
} from "../lib/mari-composer-references";
import { useLorebookEntries } from "./use-lorebooks";

type Sources = {
  characters?: readonly unknown[];
  personas?: readonly unknown[];
  lorebooks?: readonly unknown[];
  presets?: readonly unknown[];
  skills?: readonly unknown[];
  memories?: readonly unknown[];
  chats?: readonly unknown[];
  agents?: readonly unknown[];
  docs?: readonly unknown[];
};

const SOURCE_BY_KIND = {
  character: "characters",
  persona: "personas",
  lorebook: "lorebooks",
  preset: "presets",
  skill: "skills",
  memory: "memories",
  chat: "chats",
  agent: "agents",
  doc: "docs",
} as const;

// Picks only: the ghost completes plain names, and `/` lists skills and memories.
const PICK_ONLY_GROUPS: ReadonlySet<string> = new Set(["skill", "memory", "chat", "agent", "doc"]);

/**
 * What the user linked with `@` in Professor Mari's composer: the picker's rows and highlight, the picks
 * (dropped when their token text is edited away), the marks drawn over the draft, and the references to send.
 * A `/` token lists her commands (run through `onCommand`) beside the skills and memories to link.
 */
export function useMariComposerReferences({
  draft,
  setDraft,
  sources,
  editorResource,
  companionDocked,
  onCommand,
  availableCommands,
}: {
  draft: string;
  setDraft: (next: string) => void;
  sources: Sources;
  editorResource?: ProfessorMariContextResource | null;
  companionDocked: boolean;
  /** Runs the command a `/` row picked; its `/query` text is already gone from the draft. */
  onCommand: (id: MariCommandId) => void;
  availableCommands: readonly MariCommandId[];
}) {
  const listboxId = useId();
  const [token, setToken] = useState<ActiveComposerToken | null>(null);
  const [picked, setPicked] = useState<readonly MariComposerReference[]>([]);
  const [dismissedKey, setDismissedKey] = useState<string | null>(null);
  const [drill, setDrill] = useState<{ id: string; tokenKey: string } | null>(null);
  const [moved, setMoved] = useState<{ key: string; index: number } | null>(null);
  const [caretRequest, setCaretRequest] = useState<{ pos: number; n: number } | null>(null);

  const spots = useMemo(() => locateReferenceTokens(draft, picked), [draft, picked]);
  const references = useMemo(() => picked.filter((_, index) => spots[index]), [picked, spots]);
  // A pick lives only as long as its token text: edit or delete it and the link is gone for good.
  useEffect(() => {
    setPicked((current) => pruneReferences(draft, current));
  }, [draft]);

  const { characters, personas, lorebooks, presets, skills, memories, chats, agents, docs } = sources;
  const items = useMemo(() => {
    // The open editor's row leads; its record is not listed again under its group.
    const open = companionDocked ? referenceFromResource(editorResource) : null;
    const listed = buildReferenceItems({
      characters,
      personas,
      lorebooks,
      presets,
      skills,
      memories,
      chats,
      agents,
      docs,
    });
    const same = (item: (typeof listed)[number]) =>
      open !== null && item.ref.kind === open.ref.kind && item.ref.id === open.ref.id;
    // It keeps the listed row's face.
    const openMedia = listed.find(same)?.media;
    return [
      ...(open ? [openMedia ? { ...open, media: openMedia } : open] : []),
      ...listed.filter((item) => !same(item)),
    ];
  }, [
    agents,
    characters,
    chats,
    companionDocked,
    docs,
    editorResource,
    lorebooks,
    memories,
    personas,
    presets,
    skills,
  ]);
  const knownKeys = useMemo(() => new Set(items.map((item) => `${item.ref.kind}:${item.ref.id}`)), [items]);
  const isUnresolved = (ref: MariComposerReference) =>
    ref.kind in SOURCE_BY_KIND &&
    sources[SOURCE_BY_KIND[ref.kind as keyof typeof SOURCE_BY_KIND]] !== undefined &&
    !knownKeys.has(`${ref.kind}:${ref.id}`);
  const referenceMarks: ComposerMark[] = picked.flatMap((ref, index) => {
    const spot = spots[index];
    return spot ? [{ ...spot, tone: isUnresolved(ref) ? ("unresolved" as const) : ("reference" as const) }] : [];
  });

  const tokenKey = token ? `${token.start}:${token.end}:${token.query}` : "";
  const activeDrill = drill && drill.tokenKey === tokenKey ? drill : null;
  const entries = useLorebookEntries(activeDrill?.id ?? null);
  const atCap = references.length >= MAX_COMPOSER_REFERENCES;
  const rows = useMemo<PickerRow[]>(() => {
    if (token?.trigger === "/") {
      const commands = rankCommands(token.query, availableCommands).map((command) => ({
        key: `command:${command.id}`,
        group: "command" as const,
        command: command.id,
        score: command.score,
      }));
      // Commands still run at the cap; only the links stop.
      const linkable = atCap ? [] : items.filter(isSlashLinkable);
      return withoutFuzzyNoise([...commands, ...rankReferenceItems(linkable, token.query)]);
    }
    if (token?.trigger !== "@") return [];
    if (activeDrill) {
      const book = items.find((item) => item.ref.kind === "lorebook" && item.ref.id === activeDrill.id);
      if (!book) return [];
      return [{ ...book, score: 0 }, ...rankReferenceItems(buildEntryItems(book.ref, entries.data), "")];
    }
    return rankReferenceItems(items, token.query);
  }, [activeDrill, atCap, availableCommands, entries.data, items, token]);

  const pickerOpen = rows.length > 0 && (token?.trigger === "/" || !atCap) && dismissedKey !== tokenKey;
  // Prose: the first Tab completed a name and it still ends the draft, so a second Tab links it. A name
  // already written as `@Name` is not at a boundary, so it does not count twice.
  // The ghost never suggests a pick-only kind, so a name that ends the draft is not one of theirs.
  const nameItems = useMemo(() => items.filter((item) => !PICK_ONLY_GROUPS.has(item.group)), [items]);
  const labels = useMemo(() => nameItems.map((item) => item.ref.label), [nameItems]);
  const canLinkCompletion = !pickerOpen && !token && !atCap && completedNameAt(draft, labels) !== null;
  const moveKey = `${tokenKey}|${activeDrill?.id ?? ""}`;
  const activeIndex = Math.min(moved?.key === moveKey ? moved.index : defaultActiveIndex(rows), rows.length - 1);
  const canDrillIn = pickerOpen && !activeDrill && rows[activeIndex]?.group === "lorebook";

  const pick = (row: PickerRow | undefined) => {
    if (!row || !token) return;
    if (isCommandRow(row)) {
      const removed = removeCommandToken(draft, token);
      setDraft(removed.value);
      setCaretRequest((current) => ({ pos: removed.caret, n: (current?.n ?? 0) + 1 }));
      onCommand(row.command);
      return;
    }
    if (atCap) return;
    const next = applyReferencePick(draft, token, row.ref);
    setDraft(next.value);
    setPicked((current) => addReference(current, row.ref));
    setCaretRequest((current) => ({ pos: next.caret, n: (current?.n ?? 0) + 1 }));
  };
  const drillInto = (row: PickerRow | undefined) => {
    if (row?.group === "lorebook") setDrill({ id: row.ref.id, tokenKey });
  };

  const onPickerAction = (action: ComposerPickerAction) => {
    if (action === "picker-next" || action === "picker-prev") {
      const step = action === "picker-next" ? 1 : -1;
      setMoved({ key: moveKey, index: (activeIndex + step + rows.length) % rows.length });
    } else if (action === "picker-accept") pick(rows[activeIndex]);
    else if (action === "ghost-link") {
      // Inside the `@` token the picker's best row is the link; in prose it is the name just completed.
      if (rows.length > 0) pick(rows[defaultActiveIndex(rows)]);
      else {
        const linked = linkCompletedReference(
          draft,
          labels,
          nameItems.map((item) => item.ref),
        );
        if (!linked) return;
        setDraft(linked.value);
        setPicked((current) => addReference(current, linked.ref));
        setCaretRequest((current) => ({ pos: linked.caret, n: (current?.n ?? 0) + 1 }));
      }
    } else if (action === "picker-close") setDismissedKey(tokenKey);
    else if (action === "picker-drill") drillInto(rows[activeIndex]);
    else setDrill(null);
  };

  const picker: MariReferencePickerProps | null = pickerOpen
    ? {
        id: listboxId,
        rows,
        activeIndex,
        drilled: Boolean(activeDrill),
        onPick: (index) => pick(rows[index]),
        onDrill: (index) => drillInto(rows[index]),
      }
    : null;

  const removeReference = useCallback(
    (ref: MariComposerReference) =>
      setPicked((current) => current.filter((item) => item.kind !== ref.kind || item.id !== ref.id)),
    [],
  );

  return {
    /** The picks whose token is still in the draft: what a send carries. */
    references,
    referenceMarks,
    pickerOpen,
    /** A just-completed name at the caret: Tab again links it instead of moving focus. */
    canLinkCompletion,
    onActiveTokenChange: setToken,
    onPickerAction,
    /** Everything `MariComposer` needs besides the four props above. */
    referenceUi: {
      picker,
      activeOptionId: pickerOpen ? referenceOptionId(listboxId, activeIndex) : undefined,
      canDrillIn,
      canDrillOut: pickerOpen && Boolean(activeDrill),
      caretRequest,
      references,
      onRemove: removeReference,
    },
    /** Give references back after a send that never reached the server and returned its text to the composer. */
    restoreReferences: useCallback(
      (refs: readonly MariComposerReference[]) => setPicked((current) => refs.reduce(addReference, current)),
      [],
    ),
  };
}
