// ──────────────────────────────────────────────
// One-click generation on the 2D Avatars agent page (lane: generation)
// ──────────────────────────────────────────────
// PNGTuber blink/talk pictures and a mesh avatar from the owner's sprites, through /api/avatar-generation.
// The base lane's setup mounts this through AVATAR_GENERATION_PANEL for the chosen character or persona.
// Results stay in the browser until the user keeps them, so the owner's avatar does not change before that.
import { useCallback, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useConnections } from "../../../hooks/use-connections";
import { useCharacterSprites, useSpriteCapabilities } from "../../../hooks/use-characters";
import { useUIStore } from "../../../stores/ui.store";
import {
  ImagePromptReviewModal,
  type ImagePromptOverride,
  type ImagePromptReviewItem,
} from "../../../components/ui/ImagePromptReviewModal";
import type { AvatarKindSetupPanelProps } from "../contract";
import { MeshAvatarSection, type ConnectionOption } from "./MeshAvatarSection";
import { PngtuberVariantsSection } from "./PngtuberVariantsSection";

/** Sprites an image model can read (the server refuses SVG sprites the same way). */
const RASTER_SPRITE = /\.(?:png|jpe?g|webp|avif|gif)$/iu;
const NON_LANGUAGE_PROVIDERS = new Set(["image_generation", "video_generation", "audio", "decision"]);

type ConnectionRow = ConnectionOption & { defaultForAgents?: boolean | string };

export function AvatarGenerationPanel({ owner, onChanged }: AvatarKindSetupPanelProps) {
  const { t } = useTranslation();
  const { data: spriteList, isLoading } = useCharacterSprites(owner.ownerId);
  const { data: capabilities } = useSpriteCapabilities();
  const { data: connectionList } = useConnections();
  const [chosenImageConnectionId, setChosenImageConnectionId] = useState<string | null>(null);
  const [reviewItems, setReviewItems] = useState<ImagePromptReviewItem[]>([]);
  const reviewResolveRef = useRef<((overrides: ImagePromptOverride[] | null) => void) | null>(null);

  const sprites = useMemo(
    () => (spriteList ?? []).filter((sprite) => RASTER_SPRITE.test(sprite.filename)),
    [spriteList],
  );
  const { imageConnections, languageConnections } = useMemo(() => {
    const rows = (connectionList ?? []) as ConnectionRow[];
    return {
      imageConnections: rows.filter((row) => row.provider === "image_generation"),
      languageConnections: rows.filter((row) => !NON_LANGUAGE_PROVIDERS.has(row.provider)),
    };
  }, [connectionList]);
  const defaultImageConnection = imageConnections.find(
    (row) => row.defaultForAgents === true || row.defaultForAgents === "true",
  );
  const imageConnectionId =
    (imageConnections.some((row) => row.id === chosenImageConnectionId) ? chosenImageConnectionId : null) ??
    defaultImageConnection?.id ??
    imageConnections[0]?.id ??
    null;

  const reviewPrompts = useCallback(
    (items: ImagePromptReviewItem[]) =>
      new Promise<ImagePromptOverride[] | null>((resolve) => {
        if (!items.length) return resolve([]);
        reviewResolveRef.current = resolve;
        setReviewItems(items);
      }),
    [],
  );
  const closeReview = useCallback((overrides: ImagePromptOverride[] | null) => {
    reviewResolveRef.current?.(overrides);
    reviewResolveRef.current = null;
    setReviewItems([]);
  }, []);

  const unavailable = capabilities?.imageProcessingAvailable === false;

  return (
    <section
      aria-labelledby="avatar-generation-title"
      className="space-y-4 rounded-2xl bg-[var(--card)] p-3 ring-1 ring-[var(--border)] md:p-4"
    >
      <div>
        <h3 id="avatar-generation-title" className="text-sm font-semibold text-[var(--foreground)]">
          {t("avatars.generation.title")}
        </h3>
        <p className="text-[0.6875rem] text-[var(--muted-foreground)]">{t("avatars.generation.description")}</p>
      </div>

      {unavailable ? (
        <p className="text-xs text-[var(--muted-foreground)]">{t("avatars.generation.unavailable")}</p>
      ) : isLoading ? null : sprites.length === 0 ? (
        <p className="text-xs text-[var(--muted-foreground)]">{t("avatars.generation.noSprites")}</p>
      ) : (
        <>
          {imageConnections.length > 0 ? (
            <label className="flex flex-col gap-1 text-[0.6875rem] font-medium text-[var(--muted-foreground)] md:max-w-sm">
              {t("avatars.generation.imageConnection")}
              <select
                value={imageConnectionId ?? ""}
                onChange={(event) => setChosenImageConnectionId(event.target.value)}
                className="w-full rounded-xl bg-[var(--secondary)] px-3 py-2.5 text-sm text-[var(--foreground)] ring-1 ring-[var(--border)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
              >
                {imageConnections.map((connection) => (
                  <option key={connection.id} value={connection.id}>
                    {connection.id === defaultImageConnection?.id
                      ? t("avatars.generation.imageConnectionDefault", { name: connection.name })
                      : connection.name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <p className="text-xs text-[var(--muted-foreground)]">
              {t("avatars.generation.noImageConnection")}{" "}
              <button
                type="button"
                className="text-[var(--primary)] underline"
                onClick={() => useUIStore.getState().openRightPanel("connections")}
              >
                {t("avatars.generation.openConnections")}
              </button>
            </p>
          )}
          <PngtuberVariantsSection
            owner={owner}
            sprites={sprites}
            imageConnectionId={imageConnectionId}
            reviewPrompts={reviewPrompts}
            onChanged={onChanged}
          />
          <div className="border-t border-[var(--border)]" />
          <MeshAvatarSection
            owner={owner}
            sprites={sprites}
            languageConnections={languageConnections}
            imageConnectionId={imageConnectionId}
            reviewPrompts={reviewPrompts}
            onChanged={onChanged}
          />
        </>
      )}

      <ImagePromptReviewModal
        open={reviewItems.length > 0}
        items={reviewItems}
        onCancel={() => closeReview(null)}
        onConfirm={(overrides) => closeReview(overrides)}
      />
    </section>
  );
}
