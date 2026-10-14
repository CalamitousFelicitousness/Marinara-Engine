// Blink and talk pictures for a PNGTuber avatar, made from the owner's sprites (lane: generation).
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Check, Loader2, RotateCcw, Sparkles, X } from "lucide-react";
import { AVATAR_PNGTUBER_VARIANTS, type AvatarOwnerRef, type AvatarPngtuberVariant } from "@marinara-engine/shared";
import type { SpriteInfo } from "../../../hooks/use-characters";
import { cn } from "../../../lib/utils";
import { useUIStore } from "../../../stores/ui.store";
import type { ImagePromptOverride, ImagePromptReviewItem } from "../../../components/ui/ImagePromptReviewModal";
import { pngtuberSpriteFamily } from "../renderers/pngtuber/pngtuber-layers";
import { SpritePicker } from "./SpritePicker";
import {
  previewVariantPrompts,
  useOneAtATime,
  usePngtuberVariantJob,
  useSavePngtuberVariants,
  variantJobId,
} from "./use-avatar-generation";

const VARIANT_KEYS: Record<AvatarPngtuberVariant, string> = {
  "eyes-closed": "avatars.generation.eyesClosed",
  "mouth-open": "avatars.generation.mouthOpen",
};

export function PngtuberVariantsSection({
  owner,
  sprites,
  imageConnectionId,
  reviewPrompts,
  onChanged,
}: {
  owner: AvatarOwnerRef;
  sprites: SpriteInfo[];
  /** Null when there is no image connection to use. */
  imageConnectionId: string | null;
  reviewPrompts: (items: ImagePromptReviewItem[]) => Promise<ImagePromptOverride[] | null>;
  onChanged: () => void;
}) {
  const { t } = useTranslation();
  const [labels, setLabels] = useState<string[]>([]);
  const [variants, setVariants] = useState<AvatarPngtuberVariant[]>([...AVATAR_PNGTUBER_VARIANTS]);
  const preparing = useOneAtATime();
  const saving = useOneAtATime();
  const job = usePngtuberVariantJob(owner);
  const save = useSavePngtuberVariants(owner);
  // Portrait sprites when there are any, like the PNGTuber avatar itself: full_happy would fill happy's slot.
  const family = useMemo(() => pngtuberSpriteFamily(sprites), [sprites]);
  // Pictures already made stay; a run makes the missing ones (Try again redoes one).
  const made = new Set(job.items.filter((item) => item.draft).map((item) => item.id));
  const missing = labels
    .filter((label) => family.some((sprite) => sprite.expression === label))
    .flatMap((label) => variants.filter((variant) => !made.has(variantJobId(label, variant))).map(() => label));
  const count = missing.length;
  const missingLabels = [...new Set(missing)];
  const busy = job.running || preparing.pending;
  const kept = useMemo(() => job.items.filter((item) => item.kept && item.draft), [job.items]);
  const current = job.items.findIndex((item) => item.status === "running") + 1;

  /** The run's connection and, with the image prompt review on, the prompts the user confirmed. Null
   *  when the review was cancelled. */
  const runOptions = async (queueLabels: string[], queueVariants: AvatarPngtuberVariant[]) => {
    if (!useUIStore.getState().reviewImagePromptsBeforeSend) return { connectionId: imageConnectionId };
    const preview = await previewVariantPrompts(owner, queueLabels, queueVariants, imageConnectionId);
    const overrides = await reviewPrompts(preview.items);
    return overrides ? { connectionId: imageConnectionId, promptOverrides: overrides } : null;
  };

  const start = () =>
    preparing.run(async () => {
      if (job.running || !count || !imageConnectionId) return;
      const options = await runOptions(missingLabels, variants);
      if (options) job.start(missingLabels, variants, options);
    });

  const retry = (id: string, label: string, variant: AvatarPngtuberVariant) =>
    preparing.run(async () => {
      if (job.running || !imageConnectionId) return;
      const options = await runOptions([label], [variant]);
      if (options) job.retry(id, options);
    });

  const saveKept = () =>
    saving.run(async () => {
      if (!kept.length) return;
      try {
        await save.mutateAsync(
          kept.map((item) => ({
            label: item.label,
            variant: item.variant,
            image: item.draft!.image,
            sourceHash: item.draft!.sourceHash,
          })),
        );
        toast.success(t("avatars.generation.pngtuberSaved", { count: kept.length }));
        job.removeSaved(kept.map((item) => item.id));
        onChanged();
      } catch (error) {
        toast.error(
          t("avatars.generation.saveFailed", { error: error instanceof Error ? error.message : String(error) }),
        );
      }
    });

  return (
    <section className="space-y-3" aria-labelledby="avatar-generation-pngtuber">
      <div>
        <h4 id="avatar-generation-pngtuber" className="text-[0.8125rem] font-semibold text-[var(--foreground)]">
          {t("avatars.generation.pngtuberTitle")}
        </h4>
        <p className="text-[0.6875rem] text-[var(--muted-foreground)]">{t("avatars.generation.pngtuberDescription")}</p>
      </div>
      <SpritePicker
        sprites={family}
        selected={labels}
        disabled={busy}
        label={t("avatars.generation.sprites")}
        onToggle={(label) =>
          setLabels((current) =>
            current.includes(label) ? current.filter((entry) => entry !== label) : [...current, label],
          )
        }
      />
      <fieldset className="flex flex-wrap gap-x-4 gap-y-2" disabled={busy}>
        <legend className="sr-only">{t("avatars.generation.variants")}</legend>
        {AVATAR_PNGTUBER_VARIANTS.map((variant) => (
          <label key={variant} className="flex min-h-9 items-center gap-2 text-xs text-[var(--foreground)]">
            <input
              type="checkbox"
              className="h-4 w-4 accent-[var(--primary)]"
              checked={variants.includes(variant)}
              onChange={(event) =>
                setVariants((current) =>
                  event.target.checked
                    ? AVATAR_PNGTUBER_VARIANTS.filter((entry) => entry === variant || current.includes(entry))
                    : current.filter((entry) => entry !== variant),
                )
              }
            />
            {t(VARIANT_KEYS[variant])}
          </label>
        ))}
      </fieldset>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => void start()}
          disabled={busy || !count || !imageConnectionId}
          className="inline-flex min-h-9 items-center gap-1.5 rounded-xl bg-[var(--primary)] px-3 py-2 text-xs font-medium text-[var(--primary-foreground)] transition-colors hover:bg-[var(--primary)]/85 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? (
            <Loader2 size="0.875rem" className="animate-spin" aria-hidden />
          ) : (
            <Sparkles size="0.875rem" aria-hidden />
          )}
          {t("avatars.generation.makePictures", { count })}
        </button>
        {job.running && (
          <>
            <span role="status" className="text-[0.6875rem] text-[var(--muted-foreground)]">
              {t("avatars.generation.progress", { current: Math.max(1, current), total: job.items.length })}
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

      {job.items.length > 0 && (
        <div className="space-y-3">
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
            {job.items.map((item) => {
              const name = `${item.label.replace(/_/gu, " ")}: ${t(VARIANT_KEYS[item.variant])}`;
              return (
                <li
                  key={item.id}
                  className={cn(
                    "flex flex-col gap-1.5 rounded-xl bg-[var(--secondary)] p-2 ring-1",
                    item.kept ? "ring-2 ring-[var(--primary)]" : "ring-[var(--border)]",
                  )}
                >
                  <span className="truncate text-[0.625rem] font-medium text-[var(--foreground)]">{name}</span>
                  <div className="flex aspect-square items-center justify-center overflow-hidden rounded-lg bg-[var(--background)]">
                    {item.draft ? (
                      <img
                        src={item.draft.image}
                        alt={t("avatars.generation.pictureAlt", { name })}
                        className="h-full w-full object-contain"
                      />
                    ) : item.status === "running" ? (
                      <Loader2 size="1.25rem" className="animate-spin text-[var(--muted-foreground)]" aria-hidden />
                    ) : item.status === "failed" ? (
                      <p className="p-2 text-center text-[0.625rem] text-[var(--muted-foreground)]">
                        {item.error || t("avatars.generation.failed")}
                      </p>
                    ) : (
                      <span className="text-[0.625rem] text-[var(--muted-foreground)]">
                        {t("avatars.generation.waiting")}
                      </span>
                    )}
                  </div>
                  {item.draft && item.status === "failed" && (
                    <p className="text-[0.625rem] text-[var(--muted-foreground)]">
                      {item.error || t("avatars.generation.failed")}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-1">
                    {item.draft && (
                      <button
                        type="button"
                        aria-pressed={item.kept}
                        onClick={() => job.setKept(item.id, !item.kept)}
                        className={cn(
                          "inline-flex min-h-8 flex-1 items-center justify-center gap-1 rounded-lg px-2 text-[0.625rem] font-medium transition-colors active:scale-95",
                          item.kept
                            ? "bg-[var(--primary)] text-[var(--primary-foreground)]"
                            : "ring-1 ring-[var(--border)] hover:bg-[var(--accent)]",
                        )}
                      >
                        <Check size="0.75rem" aria-hidden />
                        {item.kept ? t("avatars.generation.kept") : t("avatars.generation.keep")}
                      </button>
                    )}
                    {/* A kept picture is replaced only after the user lets it go. */}
                    {(item.status === "done" || item.status === "failed") && !item.kept && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void retry(item.id, item.label, item.variant)}
                        aria-label={t("avatars.generation.retryName", { name })}
                        title={t("avatars.generation.retry")}
                        className="inline-flex min-h-8 items-center justify-center rounded-lg px-2 ring-1 ring-[var(--border)] transition-colors hover:bg-[var(--accent)] active:scale-95 disabled:opacity-50"
                      >
                        <RotateCcw size="0.75rem" aria-hidden />
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={job.keepAll}
              disabled={!job.items.some((item) => item.draft && !item.kept)}
              className="inline-flex min-h-9 items-center rounded-xl px-3 py-2 text-xs ring-1 ring-[var(--border)] transition-colors hover:bg-[var(--accent)] active:scale-95 disabled:opacity-50"
            >
              {t("avatars.generation.keepAll")}
            </button>
            <button
              type="button"
              onClick={() => void saveKept()}
              disabled={!kept.length || save.isPending || job.running}
              className="inline-flex min-h-9 items-center gap-1.5 rounded-xl bg-[var(--primary)] px-3 py-2 text-xs font-medium text-[var(--primary-foreground)] transition-colors hover:bg-[var(--primary)]/85 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {save.isPending && <Loader2 size="0.875rem" className="animate-spin" aria-hidden />}
              {t("avatars.generation.saveKept", { count: kept.length })}
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
