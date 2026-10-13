// A mesh avatar built from one of the owner's sprites (lane: generation).
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { AlertTriangle, Loader2, Sparkles, X } from "lucide-react";
import { AVATAR_PNGTUBER_VARIANTS, type AvatarOwnerRef } from "@marinara-engine/shared";
import type { SpriteInfo } from "../../../hooks/use-characters";
import { useUIStore } from "../../../stores/ui.store";
import type { ImagePromptOverride, ImagePromptReviewItem } from "../../../components/ui/ImagePromptReviewModal";
import { SpritePicker } from "./SpritePicker";
import { previewVariantPrompts, useMeshRigJob, useSaveMeshRig } from "./use-avatar-generation";

export interface ConnectionOption {
  id: string;
  name: string;
  provider: string;
}

export function MeshAvatarSection({
  owner,
  sprites,
  languageConnections,
  imageConnectionId,
  reviewPrompts,
  onChanged,
}: {
  owner: AvatarOwnerRef;
  sprites: SpriteInfo[];
  languageConnections: ConnectionOption[];
  /** Null when there is no image connection to draw with. */
  imageConnectionId: string | null;
  reviewPrompts: (items: ImagePromptReviewItem[]) => Promise<ImagePromptOverride[] | null>;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [label, setLabel] = useState<string | null>(null);
  const [visionConnectionId, setVisionConnectionId] = useState("");
  const [drawVariants, setDrawVariants] = useState(true);
  const [preparing, setPreparing] = useState(false);
  const job = useMeshRigJob(owner);
  const save = useSaveMeshRig(owner);
  const busy = job.running || preparing;
  const draws = drawVariants && !!imageConnectionId;

  const start = async () => {
    if (busy || !label) return;
    setPreparing(true);
    let overrides: ImagePromptOverride[] | undefined;
    try {
      if (draws && useUIStore.getState().reviewImagePromptsBeforeSend) {
        const preview = await previewVariantPrompts(owner, [label], [...AVATAR_PNGTUBER_VARIANTS], imageConnectionId);
        const reviewed = await reviewPrompts(preview.items);
        if (!reviewed) return;
        overrides = reviewed;
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
      return;
    } finally {
      setPreparing(false);
    }
    void job.start(
      {
        sourceLabel: label,
        connectionId: visionConnectionId || null,
        imageConnectionId: draws ? imageConnectionId : null,
        drawVariants: draws,
      },
      overrides,
    );
  };

  const keep = async () => {
    if (!job.draft || save.isPending) return;
    try {
      await save.mutateAsync(job.draft.archive);
      toast.success(t("avatars.generation.meshSaved"));
      job.discard();
      onChanged();
    } catch (error) {
      toast.error(
        t("avatars.generation.saveFailed", { error: error instanceof Error ? error.message : String(error) }),
      );
    }
  };

  return (
    <section className="space-y-3" aria-labelledby="avatar-generation-mesh">
      <div>
        <h4 id="avatar-generation-mesh" className="text-[0.8125rem] font-semibold text-[var(--foreground)]">
          {t("avatars.generation.meshTitle")}
        </h4>
        <p className="text-[0.6875rem] text-[var(--muted-foreground)]">{t("avatars.generation.meshDescription")}</p>
      </div>
      <SpritePicker
        sprites={sprites}
        selected={label ? [label] : []}
        disabled={busy}
        label={t("avatars.generation.sourceSprite")}
        onToggle={(expression) => setLabel((current) => (current === expression ? null : expression))}
      />
      <div className="grid gap-3 md:grid-cols-2">
        <label className="flex flex-col gap-1 text-[0.6875rem] font-medium text-[var(--muted-foreground)]">
          {t("avatars.generation.visionConnection")}
          <select
            value={visionConnectionId}
            disabled={busy}
            onChange={(event) => setVisionConnectionId(event.target.value)}
            className="w-full rounded-xl bg-[var(--secondary)] px-3 py-2.5 text-sm text-[var(--foreground)] ring-1 ring-[var(--border)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)] disabled:opacity-50"
          >
            <option value="">{t("avatars.generation.visionConnectionAgent")}</option>
            {languageConnections.map((connection) => (
              <option key={connection.id} value={connection.id}>
                {connection.name} ({connection.provider})
              </option>
            ))}
          </select>
        </label>
        <label className="flex min-h-9 items-start gap-2 self-end text-xs text-[var(--foreground)]">
          <input
            type="checkbox"
            className="mt-0.5 h-4 w-4 accent-[var(--primary)]"
            checked={draws}
            disabled={busy || !imageConnectionId}
            onChange={(event) => setDrawVariants(event.target.checked)}
          />
          <span>
            {t("avatars.generation.drawVariants")}
            <span className="block text-[0.625rem] text-[var(--muted-foreground)]">
              {t("avatars.generation.drawVariantsHelp")}
            </span>
          </span>
        </label>
      </div>
      <p className="text-[0.625rem] text-[var(--muted-foreground)]">{t("avatars.generation.sourceSpriteHelp")}</p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void start()}
          disabled={busy || !label}
          className="inline-flex min-h-9 items-center gap-1.5 rounded-xl bg-[var(--primary)] px-3 py-2 text-xs font-medium text-[var(--primary-foreground)] transition-colors hover:bg-[var(--primary)]/85 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? (
            <Loader2 size="0.875rem" className="animate-spin" aria-hidden />
          ) : (
            <Sparkles size="0.875rem" aria-hidden />
          )}
          {t("avatars.generation.makeMesh")}
        </button>
        {job.running && (
          <>
            <span role="status" className="text-[0.6875rem] text-[var(--muted-foreground)]">
              {t("avatars.generation.makeMeshRunning")}
            </span>
            <button
              type="button"
              onClick={job.cancel}
              className="inline-flex min-h-9 items-center gap-1 rounded-xl px-3 py-2 text-xs ring-1 ring-[var(--border)] transition-colors hover:bg-[var(--accent)] active:scale-95"
            >
              <X size="0.875rem" aria-hidden />
              {t("avatars.generation.cancel")}
            </button>
          </>
        )}
      </div>
      {job.error && (
        <p role="alert" className="flex items-start gap-1.5 text-[0.6875rem] text-[var(--foreground)]">
          <AlertTriangle
            size="0.75rem"
            className="mt-px shrink-0 text-[var(--marinara-app-accent-static)]"
            aria-hidden
          />
          {job.error}
        </p>
      )}
      {job.draft && (
        <div className="space-y-2 rounded-xl bg-[var(--secondary)] p-2 ring-1 ring-[var(--border)]">
          <img
            src={job.draft.preview}
            alt={t("avatars.generation.meshPreviewAlt", { name: job.draft.label.replace(/_/gu, " ") })}
            className="mx-auto max-h-80 w-auto rounded-lg object-contain"
          />
          <p className="text-[0.6875rem] text-[var(--muted-foreground)]">{t("avatars.generation.meshCheck")}</p>
          {job.draft.warnings.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-4 text-[0.625rem] text-[var(--muted-foreground)]">
              {job.draft.warnings.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void keep()}
              disabled={save.isPending}
              className="inline-flex min-h-9 items-center gap-1.5 rounded-xl bg-[var(--primary)] px-3 py-2 text-xs font-medium text-[var(--primary-foreground)] transition-colors hover:bg-[var(--primary)]/85 active:scale-95 disabled:opacity-50"
            >
              {save.isPending && <Loader2 size="0.875rem" className="animate-spin" aria-hidden />}
              {t("avatars.generation.saveMesh")}
            </button>
            <button
              type="button"
              onClick={job.discard}
              disabled={save.isPending}
              className="inline-flex min-h-9 items-center rounded-xl px-3 py-2 text-xs ring-1 ring-[var(--border)] transition-colors hover:bg-[var(--accent)] active:scale-95 disabled:opacity-50"
            >
              {t("avatars.generation.discard")}
            </button>
            <span className="text-[0.625rem] text-[var(--muted-foreground)]">
              {t("avatars.generation.unsavedHint")}
            </span>
          </div>
        </div>
      )}
    </section>
  );
}
