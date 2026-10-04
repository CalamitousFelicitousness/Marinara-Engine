// ──────────────────────────────────────────────
// Chat Settings: Agent activity (Roleplay), inside the Agents drawer
//
// What the old Agents button in the tracker strip opened: agent output, Advanced
// Recall progress, stop/re-run/retry, and clearing trackers. It renders the same
// RoleplayHUDActionsMenu content inline.
// ──────────────────────────────────────────────
import { Suspense, lazy, useCallback } from "react";
import { useTranslation as useUiTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import type { GameState, Message } from "@marinara-engine/shared";
import { api } from "../../lib/api-client";
import { useAgentStore, EMPTY_AGENT_FAILURES, EMPTY_AGENT_TYPES } from "../../stores/agent.store";
import { useGameStateStore } from "../../stores/game-state.store";
import { useUIStore } from "../../stores/ui.store";
import { useAgentConfigs, useCustomAgentRuns } from "../../hooks/use-agents";
import { useAdvancedMemoryStatus } from "../../hooks/use-advanced-memory";
import { useUpdateMessageExtra } from "../../hooks/use-chats";
import { discardPendingGameStatePatch } from "../../hooks/use-game-state-patcher";

const RoleplayHUDActionsMenu = lazy(async () =>
  import("./RoleplayHUDActionsMenu").then((module) => ({ default: module.RoleplayHUDActionsMenu })),
);

interface ChatSettingsAgentActivityProps {
  chatId: string;
  advancedMemoryEnabled: boolean;
  isStreaming: boolean;
  /** Chat messages (chronological); the latest assistant reply resolves cached prompt injections. */
  messages?: Message[];
  enabledAgentTypes: Set<string>;
  onRetriggerTrackers?: () => void;
  onRetryFailedAgents?: () => void;
}

export function ChatSettingsAgentActivity({
  chatId,
  advancedMemoryEnabled,
  isStreaming,
  messages,
  enabledAgentTypes,
  onRetriggerTrackers,
  onRetryFailedAgents,
}: ChatSettingsAgentActivityProps) {
  const { t: localizeUi } = useUiTranslation();
  const { data: agentConfigs } = useAgentConfigs();
  const { data: advancedMemoryStatus } = useAdvancedMemoryStatus(chatId, advancedMemoryEnabled);
  const { data: customAgentRuns = [], isLoading: customAgentRunsLoading } = useCustomAgentRuns(chatId, true);
  const thoughtBubbles = useAgentStore((s) => s.thoughtBubbles);
  const isAgentProcessing = useAgentStore((s) => s.processingChatIds.includes(chatId));
  const failedAgentTypes = useAgentStore((s) =>
    s.failedAgentChatId && s.failedAgentChatId !== chatId ? EMPTY_AGENT_TYPES : s.failedAgentTypes,
  );
  const failedAgentFailures = useAgentStore((s) =>
    s.failedAgentChatId && s.failedAgentChatId !== chatId ? EMPTY_AGENT_FAILURES : s.failedAgentFailures,
  );
  const dismissThoughtBubble = useAgentStore((s) => s.dismissThoughtBubble);
  const clearThoughtBubbles = useAgentStore((s) => s.clearThoughtBubbles);
  const resetAgentStore = useAgentStore((s) => s.reset);
  const gameStateRefreshing = useGameStateStore((s) => s.isRefreshing);
  const showInjectionsTab = useUIStore((s) => s.debugMode);
  const updateMessageExtra = useUpdateMessageExtra(chatId);
  const memoryActive = advancedMemoryEnabled && advancedMemoryStatus?.settings.enabled && advancedMemoryStatus.job.id;

  const clearGameState = useCallback(() => {
    const cleared = {
      date: null,
      time: null,
      location: null,
      weather: null,
      temperature: null,
      worldCustomFields: [],
      presentCharacters: [],
      recentEvents: [],
      playerStats: {
        stats: [],
        attributes: null,
        skills: {},
        inventory: [],
        inventoryTrackerCurrencies: [],
        inventoryTrackerEquipped: [],
        inventoryTrackerInventory: [],
        activeQuests: [],
        status: "",
      },
      personaStats: [],
      fieldLocks: null,
      hiddenTrackerFields: null,
    };
    discardPendingGameStatePatch(chatId);
    const { current: prev, setGameState } = useGameStateStore.getState();
    if (prev?.chatId === chatId) {
      setGameState({ ...prev, ...cleared } as GameState);
    } else {
      setGameState({
        id: "",
        chatId,
        messageId: "",
        swipeIndex: 0,
        createdAt: "",
        ...cleared,
      } as GameState);
    }
    api.patch(`/chats/${chatId}/game-state`, { ...cleared, manual: true, clearOverrides: true }).catch(() => {});
    // Clear committed agent runs & memory from DB + reset client state
    api.delete(`/agents/runs/${chatId}`).catch(() => {});
    const latestAssistantMessage = [...(messages ?? [])].reverse().find((message) => message.role === "assistant");
    if (latestAssistantMessage) {
      updateMessageExtra.mutate({ messageId: latestAssistantMessage.id, extra: { cyoaChoices: [] } });
    }
    resetAgentStore();
  }, [chatId, messages, resetAgentStore, updateMessageExtra]);

  const stopAgents = useCallback(async () => {
    const result = await api.post<{ aborted: boolean }>("/generate/abort", { chatId, agentsOnly: true });
    if (!result.aborted) throw new Error("No active agent run was found");
  }, [chatId]);

  return (
    <div data-chat-agent-activity className="overflow-hidden rounded-lg border border-[var(--border)]">
      <Suspense
        fallback={
          <div className="flex items-center gap-2 px-3 py-3 text-xs text-[var(--muted-foreground)]">
            <Loader2 size="0.75rem" className="animate-spin" />
            {localizeUi("ui.chat.deferredactionsfallback.loadingAgentActivity")}
          </div>
        }
      >
        <RoleplayHUDActionsMenu
          chatId={chatId}
          advancedMemoryStatus={memoryActive ? advancedMemoryStatus : undefined}
          injectionSourceMessages={messages}
          isAgentProcessing={isAgentProcessing}
          isGenerationBusy={isAgentProcessing || isStreaming || gameStateRefreshing}
          thoughtBubbles={thoughtBubbles}
          clearThoughtBubbles={clearThoughtBubbles}
          dismissThoughtBubble={dismissThoughtBubble}
          customAgentRuns={customAgentRuns}
          customAgentRunsLoading={customAgentRunsLoading}
          agentConfigs={agentConfigs}
          enabledAgentTypes={enabledAgentTypes}
          clearGameState={clearGameState}
          onRetriggerTrackers={onRetriggerTrackers}
          onRetryFailedAgents={onRetryFailedAgents}
          onStopAgents={stopAgents}
          failedAgentTypes={failedAgentTypes}
          failedAgentFailures={failedAgentFailures}
          // The section stays open after an action; collapsing it is the user's call.
          onClose={() => {}}
          showInjectionsTab={showInjectionsTab}
        />
      </Suspense>
    </div>
  );
}
