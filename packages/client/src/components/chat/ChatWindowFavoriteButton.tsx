import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Layers, Star } from "lucide-react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  getChatWindowDefaultSettingsKey,
  parseChatWindowDefault,
  type ChatMode,
  type ChatWindowDefault,
} from "@marinara-engine/shared";
import { api } from "../../lib/api-client";
import { showConfirmDialog } from "../../lib/app-dialogs";
import { chatKeys } from "../../hooks/use-chats";
import { readCurrentWindowLayout } from "../../hooks/use-chat-window-layout";
import {
  isEmptyWindowLayoutSnapshot,
  parseWindowLayoutSnapshot,
  serializeWindowLayoutSnapshot,
} from "../../lib/floating-window-layout";
import { selectWindowLayoutSnapshot, useFloatingWindowStore } from "../../stores/floating-window.store";

/** Save an arrangement for future chats without changing any existing chat or profile. */
export function ChatWindowFavoriteButton({ mode, hintsDismissed }: { mode: ChatMode; hintsDismissed: boolean }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const settingsKey = getChatWindowDefaultSettingsKey(mode);
  const queryKey = ["chat-window-default", mode];
  const path = `/app-settings/${settingsKey}`;
  const favorite = useQuery({
    queryKey,
    queryFn: async () => parseChatWindowDefault((await api.get<{ value: string | null }>(path)).value),
  });
  // This small button alone subscribes to moves, pinning and docking to show whether the saved setup matches.
  const windows = useFloatingWindowStore();
  const layout = selectWindowLayoutSnapshot(windows);
  const savedLayout = parseWindowLayoutSnapshot(favorite.data?.windowLayout);
  // Upgraded defaults choose button slots on each device. Those automatic slots still represent
  // the favorite until the user moves a button; explicit favorites keep their exact saved points.
  const comparableLayout = { ...layout };
  for (const key of ["bubbles", "phoneBubbles"] as const) {
    comparableLayout[key] = Object.fromEntries(
      Object.entries(layout[key] ?? {}).filter(([id, point]) => !point.automatic || savedLayout[key]?.[id]),
    );
  }
  const matches =
    !!favorite.data &&
    favorite.data.chatSettingsHintDismissed === hintsDismissed &&
    serializeWindowLayoutSnapshot(savedLayout) === serializeWindowLayoutSnapshot(comparableLayout);
  const modeName = t(`settings.modes.${mode}`);
  const save = useMutation({
    mutationFn: async ({ value, mode: targetMode }: { value: ChatWindowDefault | null; mode: ChatMode }) => {
      await api.put(`/app-settings/${getChatWindowDefaultSettingsKey(targetMode)}`, { value: JSON.stringify(value) });
      return value;
    },
    onSuccess: (value, variables) => {
      queryClient.setQueryData(["chat-window-default", variables.mode], value);
      toast.success(
        t(value ? "chat.settings.favoriteLayout.saved" : "chat.settings.favoriteLayout.cleared", {
          mode: t(`settings.modes.${variables.mode}`),
        }),
      );
    },
    onError: () => toast.error(t("chat.settings.favoriteLayout.failed")),
  });
  const label = t(matches ? "chat.settings.favoriteLayout.remove" : "chat.settings.favoriteLayout.save", {
    mode: modeName,
  });
  return (
    <button
      type="button"
      data-chat-settings-control="favorite-layout"
      className="mari-window__control"
      aria-label={label}
      title={label}
      aria-pressed={matches}
      disabled={favorite.isPending || favorite.isError || save.isPending}
      onClick={() =>
        save.mutate({
          mode,
          value: matches
            ? null
            : {
                windowLayout: isEmptyWindowLayoutSnapshot(layout) ? null : layout,
                chatSettingsHintDismissed: hintsDismissed,
              },
        })
      }
    >
      <Star size="0.8125rem" fill={matches ? "currentColor" : "none"} />
    </button>
  );
}

/** Copy this chat's arrangement into every existing chat of the same type, after a confirmation. */
export function ChatWindowApplyAllButton({ mode }: { mode: ChatMode }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const modeName = t(`settings.modes.${mode}`);
  const apply = useMutation({
    mutationFn: () =>
      api.post<{ updated: number }>("/chats/window-layout/apply", {
        mode,
        windowLayout: readCurrentWindowLayout(),
      }),
    onSuccess: ({ updated }) => {
      void queryClient.invalidateQueries({ queryKey: chatKeys.all });
      toast.success(t("chat.settings.applyLayoutToAll.done", { count: updated, mode: modeName }));
    },
    onError: () => toast.error(t("chat.settings.applyLayoutToAll.failed")),
  });
  const label = t("chat.settings.applyLayoutToAll.label", { mode: modeName });
  return (
    <button
      type="button"
      data-chat-settings-control="apply-layout-to-all"
      className="mari-window__control"
      aria-label={label}
      title={label}
      disabled={apply.isPending}
      onClick={async () => {
        const confirmed = await showConfirmDialog({
          title: t("chat.settings.applyLayoutToAll.confirmTitle", { mode: modeName }),
          message: t("chat.settings.applyLayoutToAll.confirmMessage", { mode: modeName }),
          confirmLabel: t("chat.settings.applyLayoutToAll.confirm"),
        });
        if (confirmed) apply.mutate();
      }}
    >
      <Layers size="0.8125rem" />
    </button>
  );
}
