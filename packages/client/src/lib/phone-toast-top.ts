// ──────────────────────────────────────────────
// Phone toast placement: below the header rows at the top of the screen
// ──────────────────────────────────────────────
// A phone toast sits top-centre, where windows, editors, the right panel, the chat list and the chat
// put their header controls (the Chat Settings star, Save, Close). Sonner pauses a hovered or pressed
// toast, so one over those controls stays there. The toaster reads its phone top from
// PHONE_TOAST_TOP_VARIABLE, which these helpers keep below the header rows stacked under the top bar.

export const PHONE_TOAST_TOP_VARIABLE = "--mari-phone-toast-top";

// The top bar, the chat's buttons, a window or sheet, the right panel, the chat list and an editor.
const PHONE_HEADER_ROWS = [
  ".mari-window-bubble",
  ".mari-window__header",
  ".mari-right-panel-header",
  ".mari-sidebar-header",
  ".mari-editor-header",
].join(",");
// A row starting this close below the rows above it belongs to the same stack (the chat's buttons sit
// 8px under the top bar); anything further down, such as a chat button moved lower, does not.
const STACK_GAP_PX = 16;
const TOAST_GAP_PX = 8;
const REMEASURE_MS = 250;

/** The top for a phone toast in px: under the top bar and every header row stacked below it. */
export function phoneToastTop(): number {
  let bottom = document.querySelector('[data-component="TopBar"]')?.getBoundingClientRect().bottom ?? 0;
  const rows = Array.from(document.querySelectorAll(PHONE_HEADER_ROWS), (row) => row.getBoundingClientRect())
    .filter((rect) => rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.left < window.innerWidth)
    .sort((a, b) => a.top - b.top);
  for (const rect of rows) {
    if (rect.top <= bottom + STACK_GAP_PX) bottom = Math.max(bottom, rect.bottom);
  }
  return Math.round(bottom + TOAST_GAP_PX);
}

/**
 * Keeps PHONE_TOAST_TOP_VARIABLE on the toaster's host current while a toast shows: measured as a toast
 * mounts (before it paints) and again while it stays, so a window or editor opened under it moves it down.
 * Returns the cleanup.
 */
export function watchPhoneToastTop(host: HTMLElement): () => void {
  let timer: number | undefined;
  const place = () => {
    const showing = host.querySelector("[data-sonner-toast]") !== null;
    if (showing) {
      const top = `${phoneToastTop()}px`;
      if (host.style.getPropertyValue(PHONE_TOAST_TOP_VARIABLE) !== top) {
        host.style.setProperty(PHONE_TOAST_TOP_VARIABLE, top);
      }
    }
    // ponytail: a short poll while a toast shows instead of observing the whole app for headers that
    // open under it; a moved header can sit under the toast for up to REMEASURE_MS. Upgrade to a
    // ResizeObserver plus a scoped MutationObserver if that delay shows.
    if (showing && timer === undefined) timer = window.setInterval(place, REMEASURE_MS);
    if (!showing && timer !== undefined) {
      window.clearInterval(timer);
      timer = undefined;
    }
  };
  // Mutation callbacks run before the next paint, so a new toast never shows at the old place first.
  const observer = new MutationObserver(place);
  observer.observe(host, { childList: true, subtree: true });
  place();
  return () => {
    observer.disconnect();
    if (timer !== undefined) window.clearInterval(timer);
    host.style.removeProperty(PHONE_TOAST_TOP_VARIABLE);
  };
}
