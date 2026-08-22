import { useCallback, useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import type { ChatMode } from "@marinara-engine/shared";
import { CircleHelp, EyeOff } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/utils";
import {
  CHAT_HELP_CLOSE_EVENT,
  CHAT_HELP_OPEN_REQUEST_EVENT,
  closeChatHelp,
  readChatHelpEventMode,
  requestChatHelp,
} from "../../lib/chat-help-events";
import { useUIStore } from "../../stores/ui.store";
import { NEUTRAL_PANEL_SHELL } from "../ui/neutral-surface-styles";

type HelpTargetId =
  | "identity"
  | "agents"
  | "branches"
  | "call"
  | "agent-controls"
  | "summary"
  | "context"
  | "author-notes"
  | "gallery"
  | "connected-chat"
  | "search"
  | "settings"
  | "help"
  | "messages"
  | "composer"
  | "map"
  | "party"
  | "scene-media"
  | "retry"
  | "session"
  | "volume"
  | "assets"
  | "widgets"
  | "dialogue";

interface HelpTargetDefinition {
  id: HelpTargetId;
  titleKey: string;
  bodyKey: string;
  selector?: string;
  mergeMatches?: boolean;
  virtual?: "messages" | "composer";
}

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

interface MeasuredTarget extends HelpTargetDefinition {
  rect: Rect;
}

const HELP_TARGET: HelpTargetDefinition = {
  id: "help",
  selector: '[data-chat-help="help"]',
  titleKey: "chat.help.targets.help.title",
  bodyKey: "chat.help.targets.help.body",
};

const COMMON_TOOLBAR_TARGETS: HelpTargetDefinition[] = [
  {
    id: "branches",
    selector: '[data-chat-help="branches"]',
    titleKey: "chat.help.targets.branches.title",
    bodyKey: "chat.help.targets.branches.body",
  },
  {
    id: "agent-controls",
    selector: '[data-chat-help="agent-controls"]',
    titleKey: "chat.help.targets.agentControls.title",
    bodyKey: "chat.help.targets.agentControls.body",
  },
  {
    id: "context",
    selector: '[data-chat-help="context"]',
    titleKey: "chat.help.targets.context.title",
    bodyKey: "chat.help.targets.context.body",
  },
  {
    id: "gallery",
    selector: '[data-chat-help="gallery"]',
    titleKey: "chat.help.targets.gallery.title",
    bodyKey: "chat.help.targets.gallery.body",
  },
  {
    id: "connected-chat",
    selector: '[data-chat-help="connected-chat"]',
    titleKey: "chat.help.targets.connectedChat.title",
    bodyKey: "chat.help.targets.connectedChat.body",
  },
  {
    id: "search",
    selector: '[data-chat-help="search"]',
    titleKey: "chat.help.targets.search.title",
    bodyKey: "chat.help.targets.search.body",
  },
  {
    id: "settings",
    selector: '[data-chat-help="settings"]',
    titleKey: "chat.help.targets.settings.title",
    bodyKey: "chat.help.targets.settings.body",
  },
];

function commonToolbarTargets(...ids: HelpTargetId[]): HelpTargetDefinition[] {
  return ids.map((id) => {
    const target = COMMON_TOOLBAR_TARGETS.find((candidate) => candidate.id === id);
    if (!target) throw new Error(`Unknown common toolbar help target: ${id}`);
    return target;
  });
}

const TARGETS_BY_MODE: Record<ChatMode, HelpTargetDefinition[]> = {
  conversation: [
    {
      id: "identity",
      selector: '[data-chat-help="identity"]',
      titleKey: "chat.help.targets.identity.title",
      bodyKey: "chat.help.targets.identity.body",
    },
    HELP_TARGET,
    ...COMMON_TOOLBAR_TARGETS,
    {
      id: "call",
      selector: '[data-chat-help="call"]',
      titleKey: "chat.help.targets.call.title",
      bodyKey: "chat.help.targets.call.body",
    },
    {
      id: "messages",
      virtual: "messages",
      titleKey: "chat.help.targets.conversationMessages.title",
      bodyKey: "chat.help.targets.conversationMessages.body",
    },
    {
      id: "composer",
      virtual: "composer",
      titleKey: "chat.help.targets.composer.title",
      bodyKey: "chat.help.targets.composer.body",
    },
  ],
  roleplay: [
    {
      id: "agents",
      selector: '[data-chat-help="agents"]',
      titleKey: "chat.help.targets.agents.title",
      bodyKey: "chat.help.targets.agents.body",
    },
    HELP_TARGET,
    ...commonToolbarTargets("branches", "agent-controls"),
    {
      id: "summary",
      selector: '[data-chat-help="summary"]',
      titleKey: "chat.help.targets.summary.title",
      bodyKey: "chat.help.targets.summary.body",
    },
    ...commonToolbarTargets("context"),
    {
      id: "author-notes",
      selector: '[data-chat-help="author-notes"]',
      titleKey: "chat.help.targets.authorNotes.title",
      bodyKey: "chat.help.targets.authorNotes.body",
    },
    ...commonToolbarTargets("gallery", "connected-chat", "search", "settings"),
    {
      id: "messages",
      virtual: "messages",
      titleKey: "chat.help.targets.roleplayMessages.title",
      bodyKey: "chat.help.targets.roleplayMessages.body",
    },
    {
      id: "composer",
      virtual: "composer",
      titleKey: "chat.help.targets.composer.title",
      bodyKey: "chat.help.targets.composer.body",
    },
  ],
  game: [
    {
      id: "map",
      selector: '[data-tour="game-map"]',
      titleKey: "chat.help.targets.map.title",
      bodyKey: "chat.help.targets.map.body",
    },
    {
      id: "party",
      selector: '[data-tour="game-party"]',
      titleKey: "chat.help.targets.party.title",
      bodyKey: "chat.help.targets.party.body",
    },
    {
      id: "scene-media",
      selector: '[data-chat-help="scene-media"]',
      titleKey: "chat.help.targets.sceneMedia.title",
      bodyKey: "chat.help.targets.sceneMedia.body",
    },
    HELP_TARGET,
    ...commonToolbarTargets("branches"),
    {
      id: "retry",
      selector: '[data-chat-help="retry"]',
      titleKey: "chat.help.targets.retry.title",
      bodyKey: "chat.help.targets.retry.body",
    },
    {
      id: "session",
      selector: '[data-chat-help="session"]',
      titleKey: "chat.help.targets.session.title",
      bodyKey: "chat.help.targets.session.body",
    },
    {
      id: "volume",
      selector: '[data-chat-help="volume"]',
      titleKey: "chat.help.targets.volume.title",
      bodyKey: "chat.help.targets.volume.body",
    },
    {
      id: "assets",
      selector: '[data-chat-help="assets"]',
      titleKey: "chat.help.targets.assets.title",
      bodyKey: "chat.help.targets.assets.body",
    },
    ...commonToolbarTargets("context", "gallery", "connected-chat", "settings"),
    {
      id: "widgets",
      selector: "[data-game-widget-rail]",
      mergeMatches: true,
      titleKey: "chat.help.targets.widgets.title",
      bodyKey: "chat.help.targets.widgets.body",
    },
    {
      id: "dialogue",
      selector: '[data-tour="game-dialogue"]',
      titleKey: "chat.help.targets.dialogue.title",
      bodyKey: "chat.help.targets.dialogue.body",
    },
  ],
};

const TARGET_PADDING = 5;

function rectFromDomRect(rect: DOMRect): Rect {
  return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
}

function unionRects(rects: Rect[]): Rect | null {
  if (rects.length === 0) return null;
  const left = Math.min(...rects.map((rect) => rect.left));
  const top = Math.min(...rects.map((rect) => rect.top));
  const right = Math.max(...rects.map((rect) => rect.left + rect.width));
  const bottom = Math.max(...rects.map((rect) => rect.top + rect.height));
  return { top, left, width: right - left, height: bottom - top };
}

function readVisibleRect(element: Element): Rect | null {
  const ownRect = rectFromDomRect((element as HTMLElement).getBoundingClientRect());
  if (ownRect.width > 1 && ownRect.height > 1) return ownRect;
  const childRects = Array.from(element.querySelectorAll<HTMLElement>("button, [role='button'], input, textarea"))
    .map((child) => rectFromDomRect(child.getBoundingClientRect()))
    .filter((rect) => rect.width > 1 && rect.height > 1);
  return unionRects(childRects);
}

function clipRect(rect: Rect, viewportWidth: number, viewportHeight: number): Rect | null {
  const left = Math.max(0, rect.left);
  const top = Math.max(0, rect.top);
  const right = Math.min(viewportWidth, rect.left + rect.width);
  const bottom = Math.min(viewportHeight, rect.top + rect.height);
  if (right - left <= 1 || bottom - top <= 1) return null;
  return { top, left, width: right - left, height: bottom - top };
}

function findTargetRect(definition: HelpTargetDefinition, root: HTMLElement): Rect | null {
  if (definition.virtual === "composer") {
    const composer = root.querySelector<HTMLElement>("[data-chat-composer]");
    const shell = composer?.closest<HTMLElement>("[data-chat-resource-drop-exclude]") ?? composer;
    return shell ? readVisibleRect(shell) : null;
  }

  if (definition.virtual === "messages") {
    const scrollArea = root.querySelector<HTMLElement>("[data-chat-scroll]");
    if (!scrollArea) return null;
    const scrollRect = rectFromDomRect(scrollArea.getBoundingClientRect());
    const composer = root.querySelector<HTMLElement>("[data-chat-composer]");
    const composerShell = composer?.closest<HTMLElement>("[data-chat-resource-drop-exclude]") ?? composer;
    const composerRect = composerShell ? readVisibleRect(composerShell) : null;
    const topControls = Array.from(
      root.querySelectorAll<HTMLElement>(
        '[data-chat-help="identity"], [data-roleplay-top-controls="right"], [data-chat-help="agents"]',
      ),
    )
      .map(readVisibleRect)
      .filter((rect): rect is Rect => rect !== null);
    const top = Math.max(scrollRect.top + 8, ...topControls.map((rect) => rect.top + rect.height + 8));
    const bottom = Math.min(scrollRect.top + scrollRect.height - 8, (composerRect?.top ?? Infinity) - 8);
    return bottom > top
      ? { top, left: scrollRect.left + 8, width: Math.max(1, scrollRect.width - 16), height: bottom - top }
      : null;
  }

  if (!definition.selector) return null;
  const rects = Array.from(document.querySelectorAll(definition.selector))
    .map(readVisibleRect)
    .filter((rect): rect is Rect => rect !== null);
  return definition.mergeMatches ? unionRects(rects) : (rects[0] ?? null);
}

function measureTargets(mode: ChatMode) {
  const root = Array.from(document.querySelectorAll<HTMLElement>(`[data-chat-mode="${mode}"]`)).find((element) => {
    const rect = element.getBoundingClientRect();
    return rect.width > 1 && rect.height > 1;
  });
  if (!root) return { rootRect: null, targets: [] as MeasuredTarget[] };

  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const rootRect = clipRect(rectFromDomRect(root.getBoundingClientRect()), viewportWidth, viewportHeight);
  const targets = TARGETS_BY_MODE[mode].flatMap((definition) => {
    const measured = findTargetRect(definition, root);
    const rect = measured ? clipRect(measured, viewportWidth, viewportHeight) : null;
    return rect ? [{ ...definition, rect }] : [];
  });
  return { rootRect, targets };
}

function getLegendStyle(rootRect: Rect): CSSProperties {
  const mobile = window.innerWidth < 768;
  if (mobile) {
    return {
      left: Math.max(12, rootRect.left + 12),
      right: Math.max(12, window.innerWidth - rootRect.left - rootRect.width + 12),
      bottom: Math.max(12, window.innerHeight - rootRect.top - rootRect.height + 12),
      maxHeight: "min(42dvh, 22rem)",
    };
  }
  return {
    left: rootRect.left + 16,
    bottom: Math.max(16, window.innerHeight - rootRect.top - rootRect.height + 16),
    width: Math.min(390, Math.max(280, rootRect.width * 0.38)),
    maxHeight: `min(58dvh, ${Math.max(240, rootRect.height - 96)}px)`,
  };
}

function measurementsSignature(rootRect: Rect | null, targets: MeasuredTarget[]) {
  return JSON.stringify([
    rootRect,
    targets.map(({ id, rect }) => [
      id,
      Math.round(rect.top),
      Math.round(rect.left),
      Math.round(rect.width),
      Math.round(rect.height),
    ]),
  ]);
}

export function ChatHelpOverlay({
  mode,
  activeChatId,
  isFirstChat,
  autoOpenBlocked,
}: {
  mode: ChatMode;
  activeChatId: string;
  isFirstChat: boolean;
  autoOpenBlocked: boolean;
}) {
  const { t } = useTranslation();
  const seenModes = useUIStore((state) => state.chatHelpSeenModes ?? []);
  const chatHelpButtonHidden = useUIStore((state) => state.chatHelpButtonHidden ?? false);
  const markChatHelpSeen = useUIStore((state) => state.markChatHelpSeen);
  const setChatHelpButtonHidden = useUIStore((state) => state.setChatHelpButtonHidden);
  const [open, setOpen] = useState(false);
  const [rootRect, setRootRect] = useState<Rect | null>(null);
  const [targets, setTargets] = useState<MeasuredTarget[]>([]);
  const overlayRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const measurementSignatureRef = useRef("");
  const autoOpenedChatRef = useRef<string | null>(null);
  const maskId = `chat-help-mask-${useId().replace(/:/gu, "")}`;

  useEffect(() => {
    const handleOpen = (event: Event) => {
      if (chatHelpButtonHidden || readChatHelpEventMode(event) !== mode) return;
      setOpen(true);
    };
    const handleClose = (event: Event) => {
      if (readChatHelpEventMode(event) === mode) setOpen(false);
    };
    window.addEventListener(CHAT_HELP_OPEN_REQUEST_EVENT, handleOpen);
    window.addEventListener(CHAT_HELP_CLOSE_EVENT, handleClose);
    return () => {
      window.removeEventListener(CHAT_HELP_OPEN_REQUEST_EVENT, handleOpen);
      window.removeEventListener(CHAT_HELP_CLOSE_EVENT, handleClose);
    };
  }, [chatHelpButtonHidden, mode]);

  useEffect(() => {
    if (
      chatHelpButtonHidden ||
      autoOpenBlocked ||
      !isFirstChat ||
      seenModes.includes(mode) ||
      autoOpenedChatRef.current === activeChatId
    ) {
      return;
    }
    const root = document.querySelector<HTMLElement>(`[data-chat-mode="${mode}"]`);
    if (!root || root.getBoundingClientRect().width <= 1) return;
    const timer = window.setTimeout(() => {
      autoOpenedChatRef.current = activeChatId;
      requestChatHelp(mode);
    }, 600);
    return () => window.clearTimeout(timer);
  }, [activeChatId, autoOpenBlocked, chatHelpButtonHidden, isFirstChat, mode, seenModes]);

  useEffect(() => {
    if (!open) return;
    let frame = 0;
    const measure = () => {
      const next = measureTargets(mode);
      const signature = measurementsSignature(next.rootRect, next.targets);
      if (signature !== measurementSignatureRef.current) {
        measurementSignatureRef.current = signature;
        setRootRect(next.rootRect);
        setTargets(next.targets);
      }
    };
    const scheduleMeasure = () => {
      if (frame) return;
      frame = window.requestAnimationFrame(() => {
        frame = 0;
        measure();
      });
    };
    measure();
    const observer = new ResizeObserver(scheduleMeasure);
    for (const element of document.querySelectorAll<HTMLElement>(`[data-chat-mode="${mode}"]`)) {
      observer.observe(element);
    }
    window.addEventListener("resize", scheduleMeasure);
    window.addEventListener("scroll", scheduleMeasure, true);
    return () => {
      if (frame) window.cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", scheduleMeasure);
      window.removeEventListener("scroll", scheduleMeasure, true);
    };
  }, [mode, open]);

  useEffect(() => {
    if (!open) return;
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    overlayRef.current?.focus({ preventScroll: true });
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      markChatHelpSeen(mode);
      closeChatHelp(mode);
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("keydown", handleKeyDown);
      previousFocusRef.current?.focus({ preventScroll: true });
    };
  }, [markChatHelpSeen, mode, open]);

  const dismiss = useCallback(() => {
    markChatHelpSeen(mode);
    closeChatHelp(mode);
  }, [markChatHelpSeen, mode]);
  const hideHelpButton = useCallback(() => {
    setChatHelpButtonHidden(true);
    closeChatHelp(mode);
  }, [mode, setChatHelpButtonHidden]);

  const legendStyle = useMemo(() => (rootRect ? getLegendStyle(rootRect) : undefined), [rootRect]);

  if (!open || !rootRect || typeof document === "undefined") return null;

  return createPortal(
    <div
      ref={overlayRef}
      data-chat-help-overlay={mode}
      role="dialog"
      aria-modal="true"
      aria-label={t("chat.help.overlayLabel")}
      tabIndex={-1}
      className="mari-chrome-token-scope fixed inset-0 z-[10050] cursor-pointer outline-none"
      onPointerDown={dismiss}
    >
      <svg className="pointer-events-none fixed inset-0 h-full w-full" aria-hidden="true">
        <defs>
          <mask id={maskId} maskUnits="userSpaceOnUse">
            <rect x={rootRect.left} y={rootRect.top} width={rootRect.width} height={rootRect.height} fill="white" />
            {targets.map(({ id, rect }) => (
              <rect
                key={id}
                x={rect.left - TARGET_PADDING}
                y={rect.top - TARGET_PADDING}
                width={rect.width + TARGET_PADDING * 2}
                height={rect.height + TARGET_PADDING * 2}
                rx="10"
                fill="black"
              />
            ))}
          </mask>
        </defs>
        <rect
          x={rootRect.left}
          y={rootRect.top}
          width={rootRect.width}
          height={rootRect.height}
          mask={`url(#${maskId})`}
          style={{ fill: "color-mix(in srgb, var(--background) 82%, transparent)" }}
        />
      </svg>

      {targets.map(({ id, rect }, index) => (
        <div
          key={id}
          data-chat-help-highlight={id}
          className="pointer-events-none fixed rounded-[0.625rem] ring-2 ring-[var(--marinara-chat-chrome-focus-ring)] shadow-[0_0_18px_color-mix(in_srgb,var(--marinara-chat-chrome-focus-ring)_45%,transparent)]"
          style={{
            top: rect.top - TARGET_PADDING,
            left: rect.left - TARGET_PADDING,
            width: rect.width + TARGET_PADDING * 2,
            height: rect.height + TARGET_PADDING * 2,
          }}
        >
          <span className="absolute -right-1.5 -top-1.5 flex h-4 min-w-4 items-center justify-center rounded-full bg-[var(--marinara-chat-chrome-button-bg-active)] px-1 text-[0.5625rem] font-bold leading-none text-[var(--marinara-chat-chrome-button-text-active)] ring-1 ring-[var(--marinara-chat-chrome-focus-ring)]">
            {index + 1}
          </span>
        </div>
      ))}

      <div
        className="pointer-events-none fixed flex max-w-[calc(100vw-1.5rem)] flex-col items-center gap-1.5"
        style={{
          top: rootRect.top + 10,
          left: Math.max(rootRect.left + 12, rootRect.left + rootRect.width / 2),
          transform: "translateX(-50%)",
        }}
      >
        <div className="flex items-center gap-2 rounded-lg border border-[var(--marinara-chat-chrome-button-border-active)] bg-[var(--card)] px-3 py-2 text-xs font-semibold text-[var(--foreground)] shadow-lg">
          <CircleHelp size="0.875rem" className="shrink-0 text-[var(--marinara-chat-chrome-button-text-active)]" />
          <span>{t("chat.help.exitInstruction")}</span>
        </div>
        <button
          type="button"
          className="mari-chrome-control pointer-events-auto min-h-7 px-2.5 text-[0.625rem] shadow-lg"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={hideHelpButton}
        >
          <EyeOff size="0.6875rem" />
          {t("chat.help.hidePermanently")}
        </button>
      </div>

      <div
        data-chat-help-legend
        className={cn(
          NEUTRAL_PANEL_SHELL,
          "pointer-events-none fixed min-h-0 overflow-hidden border-[var(--marinara-chat-chrome-button-border-active)] shadow-xl",
        )}
        style={legendStyle}
      >
        <div className="flex items-center gap-2 border-b border-[var(--marinara-chat-chrome-panel-divider)] px-3 py-2.5">
          <CircleHelp size="0.875rem" className="shrink-0 text-[var(--marinara-chat-chrome-button-text-active)]" />
          <h2 className="text-sm font-semibold text-[var(--marinara-chat-chrome-panel-title)]">
            {t(`chat.help.mode.${mode}`)}
          </h2>
        </div>
        <ol className="max-h-[inherit] space-y-2 overflow-y-auto overscroll-contain px-3 py-2.5">
          {targets.map((target, index) => (
            <li key={target.id} data-chat-help-entry={target.id} className="flex gap-2.5">
              <span className="mt-0.5 flex h-4 min-w-4 shrink-0 items-center justify-center rounded-full bg-[var(--marinara-chat-chrome-button-bg-active)] px-1 text-[0.5625rem] font-bold text-[var(--marinara-chat-chrome-button-text-active)]">
                {index + 1}
              </span>
              <span className="min-w-0 text-xs leading-4 text-[var(--marinara-chat-chrome-panel-muted)]">
                <strong className="font-semibold text-[var(--marinara-chat-chrome-panel-title)]">
                  {t(target.titleKey)}:
                </strong>{" "}
                {t(target.bodyKey)}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </div>,
    document.body,
  );
}
