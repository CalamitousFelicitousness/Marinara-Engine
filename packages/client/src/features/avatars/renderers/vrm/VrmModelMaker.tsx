// "Make 3D model" on the 3D Avatars page (lane: 3D generation): a VRM body made from one full-body sprite by
// Tripo, with the user's own Tripo connection. Shows the balance and the cost before starting, each step with
// the credits used while it runs, and the result before it is kept. Keeping imports the file like a picked
// .vrm, so the importer checks it and everything after works as for any VRM. The model has no face: it is
// labelled "Body only".
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { AlertTriangle, Check, Circle, ExternalLink, Loader2, Sparkles, X } from "lucide-react";
import {
  AVATAR_VRM_MODEL_STEPS,
  TRIPO_API_KEYS_URL,
  TRIPO_VRM_MODEL_CREDITS,
  type AvatarOwnerRef,
} from "@marinara-engine/shared";
import { useAvatarModelActions } from "../../../../hooks/use-avatar-models";
import { useCharacterSprites, type SpriteInfo } from "../../../../hooks/use-characters";
import { useConnections } from "../../../../hooks/use-connections";
import { useUIStore } from "../../../../stores/ui.store";
import { preferredMeshSource } from "../../generation/MeshAvatarSection";
import { SpritePicker, avatarSourceSprites } from "../../generation/SpritePicker";
import { useTripoBalance, useVrmModelJob, vrmDraftFile } from "../../generation/use-avatar-generation";
import { isFullBodySprite } from "../pngtuber/pngtuber-layers";

const PRIMARY_BUTTON =
  "inline-flex min-h-11 items-center gap-1.5 rounded-xl bg-[var(--primary)] px-3 py-2 text-xs font-medium text-[var(--primary-foreground)] transition-colors hover:bg-[var(--primary)]/85 active:scale-95 disabled:cursor-not-allowed disabled:opacity-50";
const SECONDARY_BUTTON =
  "inline-flex min-h-11 items-center gap-1 rounded-xl px-3 py-2 text-xs ring-1 ring-[var(--border)] transition-colors hover:bg-[var(--accent)] active:scale-95 disabled:opacity-50";
const SELECT_CLASS =
  "w-full rounded-xl bg-[var(--secondary)] px-3 py-2.5 text-sm text-[var(--foreground)] ring-1 ring-[var(--border)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)] disabled:opacity-50 pointer-coarse:text-base";

/** The sprite picked until the user chooses: the full-body neutral one, else any full-body sprite. A portrait
 *  is never picked for them: Tripo needs the whole body, and a model costs credits. */
function preferredVrmSource(sprites: readonly SpriteInfo[]): string | null {
  const neutral = preferredMeshSource(sprites);
  if (neutral && isFullBodySprite(neutral)) return neutral;
  return sprites.find((sprite) => isFullBodySprite(sprite.expression))?.expression ?? null;
}

function errorText(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

export function VrmModelMaker({
  owner,
  hasModel,
  onChanged,
}: {
  owner: AvatarOwnerRef;
  /** Whether the owner already has a VRM model, which keeping this one replaces. */
  hasModel: boolean;
  onChanged?: () => void;
}) {
  const { t } = useTranslation();
  const { data: spriteList, isLoading } = useCharacterSprites(owner.ownerId);
  const sprites = useMemo(() => avatarSourceSprites(spriteList), [spriteList]);
  const { data: connectionList } = useConnections();
  const tripoConnections = useMemo(
    () =>
      ((connectionList ?? []) as Array<{ id: string; name: string; provider: string }>).filter(
        (row) => row.provider === "tripo",
      ),
    [connectionList],
  );
  // Undefined until the user picks or clears a sprite; until then the preferred one follows the sprite list.
  const [picked, setPicked] = useState<string | null>();
  const label =
    picked === null || (picked !== undefined && sprites.some((sprite) => sprite.expression === picked))
      ? picked
      : preferredVrmSource(sprites);
  const [chosenConnectionId, setChosenConnectionId] = useState<string | null>(null);
  const connectionId =
    (tripoConnections.some((row) => row.id === chosenConnectionId) ? chosenConnectionId : null) ??
    tripoConnections[0]?.id ??
    null;
  const balance = useTripoBalance(connectionId);
  const job = useVrmModelJob(owner);
  const { importFile } = useAvatarModelActions(owner, onChanged, {
    importFile: {
      onSuccess: () => {
        toast.success(t("avatars.vrm.make.saved"));
        job.discard();
      },
      onError: (error) => toast.error(t("avatars.generation.saveFailed", { error: errorText(error) })),
    },
  });
  const cost = balance.data?.cost ?? TRIPO_VRM_MODEL_CREDITS;
  const tooFewCredits = balance.data !== undefined && balance.data.balance < cost;
  const busy = job.running || importFile.isPending;

  const start = () => {
    if (busy || !label || !connectionId) return;
    void job.start({ sourceLabel: label, connectionId }).then(() => balance.refetch());
  };
  const showSteps = job.running || Object.keys(job.steps).length > 0;

  if (tripoConnections.length === 0) {
    return (
      <div className="space-y-2" data-vrm-model-maker>
        <MakerHeading />
        <p className="text-[0.6875rem] text-[var(--muted-foreground)]">{t("avatars.vrm.make.noConnection")}</p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <button
            type="button"
            className={SECONDARY_BUTTON}
            onClick={() => useUIStore.getState().openRightPanel("connections")}
          >
            {t("avatars.generation.openConnections")}
          </button>
          <a
            href={TRIPO_API_KEYS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-11 items-center gap-1 text-[0.6875rem] font-medium text-[var(--primary)] underline-offset-2 hover:underline"
          >
            {t("avatars.vrm.make.getKey")}
            <ExternalLink size="0.6875rem" aria-hidden="true" />
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3" data-vrm-model-maker>
      <MakerHeading />
      {isLoading ? null : sprites.length === 0 ? (
        <p className="text-[0.6875rem] text-[var(--muted-foreground)]">{t("avatars.generation.noSprites")}</p>
      ) : (
        <>
          <SpritePicker
            sprites={sprites}
            selected={label ? [label] : []}
            disabled={busy}
            label={t("avatars.generation.sourceSprite")}
            onToggle={(expression) => setPicked(label === expression ? null : expression)}
          />
          <p
            className={
              label && !isFullBodySprite(label)
                ? "flex items-start gap-1.5 text-[0.6875rem] text-[var(--foreground)]"
                : "text-[0.625rem] text-[var(--muted-foreground)]"
            }
          >
            {label && !isFullBodySprite(label) ? (
              <AlertTriangle
                size="0.75rem"
                className="mt-px shrink-0 text-[var(--marinara-app-accent-static)]"
                aria-hidden
              />
            ) : null}
            {t("avatars.vrm.make.fullBodyHint")}
          </p>
          {tripoConnections.length > 1 ? (
            <label className="flex flex-col gap-1 text-[0.6875rem] font-medium text-[var(--muted-foreground)] md:max-w-sm">
              {t("avatars.vrm.make.connection")}
              <select
                value={connectionId ?? ""}
                disabled={busy}
                onChange={(event) => setChosenConnectionId(event.target.value)}
                className={SELECT_CLASS}
              >
                {tripoConnections.map((connection) => (
                  <option key={connection.id} value={connection.id}>
                    {connection.name}
                  </option>
                ))}
              </select>
            </label>
          ) : null}
          <p className="text-[0.6875rem] text-[var(--foreground)]" data-tripo-balance>
            {balance.isLoading
              ? t("avatars.vrm.make.balanceLoading")
              : balance.error
                ? t("avatars.vrm.make.balanceFailed", { error: errorText(balance.error) })
                : balance.data
                  ? t("avatars.vrm.make.balance", { balance: balance.data.balance, cost })
                  : null}
            {tooFewCredits ? <> {t("avatars.vrm.make.notEnough")}</> : null}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={start}
              // A made model is kept or discarded first: it cost credits, and a new run would drop it.
              disabled={busy || !!job.draft || !label || !connectionId || tooFewCredits}
              className={PRIMARY_BUTTON}
            >
              {job.running ? (
                <Loader2 size="0.875rem" className="animate-spin" aria-hidden />
              ) : (
                <Sparkles size="0.875rem" aria-hidden />
              )}
              {t("avatars.vrm.make.start")}
            </button>
            {job.running ? (
              <>
                <button type="button" onClick={job.cancel} className={SECONDARY_BUTTON}>
                  <X size="0.875rem" aria-hidden />
                  {t("avatars.generation.cancel")}
                </button>
                <span className="text-[0.625rem] text-[var(--muted-foreground)]">{t("avatars.vrm.make.stay")}</span>
              </>
            ) : null}
          </div>
        </>
      )}

      {showSteps ? (
        <div className="space-y-1.5" role="status" aria-live="polite">
          <ol className="space-y-1">
            {AVATAR_VRM_MODEL_STEPS.map((step) => {
              const state = job.steps[step];
              const status = state?.status ?? "waiting";
              return (
                <li
                  key={step}
                  data-vrm-step={step}
                  data-status={status}
                  className="flex items-center gap-1.5 text-[0.6875rem] text-[var(--foreground)]"
                >
                  {status === "done" ? (
                    <Check size="0.75rem" className="shrink-0 text-[var(--primary)]" aria-hidden />
                  ) : status === "running" && job.running ? (
                    <Loader2 size="0.75rem" className="shrink-0 animate-spin" aria-hidden />
                  ) : (
                    <Circle size="0.75rem" className="shrink-0 text-[var(--muted-foreground)]" aria-hidden />
                  )}
                  <span className={status === "waiting" ? "text-[var(--muted-foreground)]" : undefined}>
                    {t(`avatars.vrm.make.step.${step}`)}
                  </span>
                  {status === "running" && job.running && state?.progress != null ? (
                    <span className="text-[var(--muted-foreground)]">{state.progress}%</span>
                  ) : null}
                </li>
              );
            })}
          </ol>
          <p className="text-[0.6875rem] text-[var(--muted-foreground)]" data-tripo-credits-used>
            {t("avatars.vrm.make.creditsUsed", { count: job.creditsUsed })}
          </p>
        </div>
      ) : null}
      {job.cancelled && !job.running ? (
        <p role="status" className="text-[0.6875rem] text-[var(--muted-foreground)]">
          {t("avatars.vrm.make.cancelled")}
        </p>
      ) : null}
      {job.interrupted && !job.running ? (
        <p role="alert" className="flex items-start gap-1.5 text-[0.6875rem] text-[var(--foreground)]">
          <AlertTriangle
            size="0.75rem"
            className="mt-px shrink-0 text-[var(--marinara-app-accent-static)]"
            aria-hidden
          />
          {t("avatars.vrm.make.interrupted")}
        </p>
      ) : null}
      {job.error !== null ? (
        <p role="alert" className="flex items-start gap-1.5 text-[0.6875rem] text-[var(--foreground)]">
          <AlertTriangle
            size="0.75rem"
            className="mt-px shrink-0 text-[var(--marinara-app-accent-static)]"
            aria-hidden
          />
          {job.error || t("avatars.vrm.make.failed")}
        </p>
      ) : null}

      {job.draft ? (
        <div className="space-y-2 rounded-xl bg-[var(--secondary)] p-2 ring-1 ring-[var(--border)]" data-vrm-draft>
          <div className="grid grid-cols-2 gap-2">
            {job.draft.tpose ? (
              <img
                src={job.draft.tpose}
                alt={t("avatars.vrm.make.tposeAlt", { name: job.draft.label.replace(/_/gu, " ") })}
                className="mx-auto max-h-64 w-full rounded-lg bg-[var(--background)] object-contain"
              />
            ) : null}
            {job.draft.preview ? (
              <img
                src={job.draft.preview}
                alt={t("avatars.vrm.make.previewAlt")}
                className="mx-auto max-h-64 w-full rounded-lg bg-[var(--background)] object-contain"
              />
            ) : null}
          </div>
          <p className="text-xs font-medium text-[var(--foreground)]">{t("avatars.vrm.bodyOnly")}</p>
          {hasModel ? (
            <p className="text-[0.6875rem] text-[var(--muted-foreground)]">{t("avatars.vrm.make.replaces")}</p>
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => job.draft && importFile.mutate({ kind: "vrm", file: vrmDraftFile(job.draft) })}
              disabled={importFile.isPending}
              className={PRIMARY_BUTTON}
            >
              {importFile.isPending ? <Loader2 size="0.875rem" className="animate-spin" aria-hidden /> : null}
              {t("avatars.vrm.make.save")}
            </button>
            <button type="button" onClick={job.discard} disabled={importFile.isPending} className={SECONDARY_BUTTON}>
              {t("avatars.generation.discard")}
            </button>
            <span className="text-[0.625rem] text-[var(--muted-foreground)]">
              {t("avatars.generation.unsavedHint")}
            </span>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function MakerHeading() {
  const { t } = useTranslation();
  return (
    <div>
      <h5 className="text-[0.6875rem] font-semibold text-[var(--foreground)]">{t("avatars.vrm.make.title")}</h5>
      <p className="mt-0.5 text-[0.625rem] leading-relaxed text-[var(--muted-foreground)]">
        {t("avatars.vrm.make.description", { cost: TRIPO_VRM_MODEL_CREDITS })}
      </p>
    </div>
  );
}
