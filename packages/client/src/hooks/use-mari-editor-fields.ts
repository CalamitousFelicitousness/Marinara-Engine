import { useCallback, useEffect, useState, type RefObject } from "react";
import { useUIStore } from "../stores/ui.store";
import { fieldLabel } from "../lib/mari-edit-diff";
import { findMariField } from "../lib/mari-editor-fields";
import { hasEditorLeaveHandler } from "../lib/editor-leave";

/**
 * Prof. Mari and the `[data-mari-field]` fields of one editor scroll root: reports the focused field,
 * shows a field she asks for (scroll + one pulse), glows the field her running step writes and tells
 * whether that field is above or below the visible area.
 */
export function useMariEditorFields(
  contentRef: RefObject<HTMLDivElement | null>,
  entityId: string | null,
  ready: boolean,
  scrollToElement: (target: HTMLElement) => void,
) {
  const setActiveEditorField = useUIStore((s) => s.setActiveEditorField);
  const reveal = useUIStore((s) => s.mariRevealField);
  const working = useUIStore((s) => s.mariWorkingField);
  const [offscreen, setOffscreen] = useState<"above" | "below" | null>(null);

  useEffect(() => () => setActiveEditorField(null), [entityId, setActiveEditorField]);

  useEffect(() => {
    const root = contentRef.current;
    if (!root || !ready) return;
    const onFocusIn = (event: FocusEvent) => {
      const id = (event.target as Element).closest<HTMLElement>("[data-mari-field]")?.dataset.mariField;
      if (id) setActiveEditorField({ id, label: fieldLabel(id) });
    };
    root.addEventListener("focusin", onFocusIn);
    return () => root.removeEventListener("focusin", onFocusIn);
  }, [contentRef, ready, setActiveEditorField]);

  useEffect(() => {
    const root = contentRef.current;
    if (!root || !ready || !reveal || reveal.characterId !== entityId) return;
    useUIStore.getState().clearMariRevealField();
    const field = findMariField(root, reveal.path);
    if (!field) return;
    scrollToElement(field);
    // Restart the pulse when it is still running from an earlier reveal.
    delete field.dataset.mariPulse;
    void field.offsetWidth;
    field.dataset.mariPulse = "";
    // No cleanup: clearing the request above re-runs this effect, and the pulse must still end.
    window.setTimeout(() => delete field.dataset.mariPulse, 1200);
  }, [contentRef, ready, reveal, entityId, scrollToElement]);

  useEffect(() => {
    const root = contentRef.current;
    const field = root && ready && working?.characterId === entityId ? findMariField(root, working.path) : null;
    if (!root || !field) return;
    field.dataset.mariGlow = "";
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return;
        const rootTop = entry.rootBounds?.top ?? 0;
        setOffscreen(entry.isIntersecting ? null : entry.boundingClientRect.top < rootTop ? "above" : "below");
      },
      { root },
    );
    observer.observe(field);
    return () => {
      observer.disconnect();
      delete field.dataset.mariGlow;
      setOffscreen(null);
    };
  }, [contentRef, ready, working, entityId]);

  const revealWorkingField = useCallback(() => {
    if (working && entityId) useUIStore.getState().revealMariField(entityId, working.path);
  }, [working, entityId]);

  return { workingOffscreen: offscreen, revealWorkingField };
}

/** Opens a character at one field (`data.first_mes` or `first_mes`). False when the user stays in a dirty editor. */
export function openCharacterAtField(characterId: string, path: string, leavePrompt: string): boolean {
  const ui = useUIStore.getState();
  // Already open: nothing is left, so no leave prompt.
  if (ui.characterDetailId !== characterId) {
    if (ui.editorDirty && !hasEditorLeaveHandler(ui) && !window.confirm(leavePrompt)) return false;
    ui.openCharacterDetail(characterId);
  }
  ui.revealMariField(characterId, path);
  return true;
}
