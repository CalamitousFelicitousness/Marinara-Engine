// ──────────────────────────────────────────────
// Avatar generation: server calls and job state (lane: generation)
// ──────────────────────────────────────────────
// Generating returns drafts the browser holds; nothing is stored until the user keeps a result, so the
// owner's avatar stays as it was. Draft shapes mirror packages/server/src/services/avatars/generation/.
import { useCallback, useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AVATAR_API_PREFIXES,
  type AvatarGenerationResponse,
  type AvatarOwnerRef,
  type AvatarPngtuberVariant,
} from "@marinara-engine/shared";
import { useAvatarModelChanged } from "../../../hooks/use-avatar-models";
import { api } from "../../../lib/api-client";
import { useUIStore } from "../../../stores/ui.store";
import type { ImagePromptOverride, ImagePromptReviewItem } from "../../../components/ui/ImagePromptReviewModal";

const PREFIX = AVATAR_API_PREFIXES.generation;

export interface PngtuberVariantDraft {
  label: string;
  variant: AvatarPngtuberVariant;
  /** PNG data URL at the sprite's size. */
  image: string;
  width: number;
  height: number;
  /** Which version of the sprite it was drawn from; saving refuses a sprite replaced since. */
  sourceHash: string;
}

interface PngtuberDraftsResponse {
  drafts: PngtuberVariantDraft[];
  failed: Array<{ label: string; variant: AvatarPngtuberVariant; error: string }>;
}

export interface MeshRigDraft {
  /** The `.mavatar`, base64. */
  archive: string;
  /** The sprite with the face parts the vision model found. */
  preview: string;
  warnings: string[];
}

export interface VariantJobItem {
  id: string;
  label: string;
  variant: AvatarPngtuberVariant;
  status: "waiting" | "running" | "done" | "failed";
  draft?: PngtuberVariantDraft;
  error?: string;
  kept: boolean;
}

export interface GenerationRunOptions {
  connectionId: string | null;
  promptOverrides?: ImagePromptOverride[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

function isAbort(error: unknown): boolean {
  return !!error && typeof error === "object" && "name" in error && error.name === "AbortError";
}

interface RunningJob {
  controller: AbortController;
  owner: AvatarOwnerRef;
}

/** Stops a running job: closes its request and asks the server to stop it too, since a proxy between the
 *  browser and the server can keep the server's side of a closed request going. */
function stopJob(job: RunningJob | null, kind: "pngtuber" | "mesh-avatar") {
  if (!job || job.controller.signal.aborted) return;
  job.controller.abort();
  api.post(`${PREFIX}/cancel`, { owner: job.owner, kind }).catch((error: unknown) => {
    console.warn("[avatars] Cancel request failed", error);
  });
}

/** Runs one async action at a time: a second call while one runs (a fast double click) does nothing.
 *  A failure is shown as a toast. */
export function useOneAtATime() {
  const runningRef = useRef(false);
  const [pending, setPending] = useState(false);
  const run = useCallback(async (action: () => Promise<void>) => {
    if (runningRef.current) return;
    runningRef.current = true;
    setPending(true);
    try {
      await action();
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      runningRef.current = false;
      setPending(false);
    }
  }, []);
  return { pending, run };
}

export function variantJobId(label: string, variant: AvatarPngtuberVariant): string {
  return `${label}\u0000${variant}`;
}

/** The exact prompts a run would send, for the image prompt review. */
export function previewVariantPrompts(
  owner: AvatarOwnerRef,
  labels: string[],
  variants: AvatarPngtuberVariant[],
  connectionId: string | null,
) {
  return api.post<{ items: ImagePromptReviewItem[] }>(`${PREFIX}/pngtuber-variants/preview`, {
    owner,
    labels,
    variants,
    connectionId,
  });
}

/** Makes blink and talk pictures one at a time, so each can be checked, kept or tried again, and Cancel
 *  stops the picture being made, on the server too, and drops the ones not started. A second start while one
 *  runs does nothing. Pictures already made stay: a new start makes only the missing ones, and a failed or
 *  cancelled try keeps the picture it was replacing. */
export function usePngtuberVariantJob(owner: AvatarOwnerRef) {
  const [items, setItems] = useState<VariantJobItem[]>([]);
  const [running, setRunning] = useState(false);
  const runningRef = useRef(false);
  const jobRef = useRef<RunningJob | null>(null);

  useEffect(() => () => stopJob(jobRef.current, "pngtuber"), []);
  // Another owner's pictures never belong to this one.
  useEffect(() => {
    stopJob(jobRef.current, "pngtuber");
    setItems([]);
  }, [owner.ownerType, owner.ownerId]);

  const update = useCallback((id: string, patch: Partial<VariantJobItem>) => {
    setItems((current) => current.map((item) => (item.id === id ? { ...item, ...patch } : item)));
  }, []);

  const run = useCallback(
    async (queue: VariantJobItem[], options: GenerationRunOptions) => {
      if (runningRef.current || !queue.length) return;
      runningRef.current = true;
      setRunning(true);
      const controller = new AbortController();
      jobRef.current = { controller, owner };
      try {
        for (const item of queue) {
          if (controller.signal.aborted) break;
          update(item.id, { status: "running", error: undefined });
          try {
            const response = await api.post<PngtuberDraftsResponse>(
              `${PREFIX}/pngtuber-variants`,
              {
                owner,
                labels: [item.label],
                variants: [item.variant],
                connectionId: options.connectionId,
                // The server picks each picture's reviewed prompt by its id.
                promptOverrides: options.promptOverrides,
                debugMode: useUIStore.getState().debugMode,
              },
              { signal: controller.signal },
            );
            const draft = response.drafts[0];
            update(
              item.id,
              draft
                ? { status: "done", draft, kept: false, error: undefined }
                : { status: "failed", error: response.failed[0]?.error ?? "" },
            );
          } catch (error) {
            if (controller.signal.aborted || isAbort(error)) {
              update(item.id, { status: item.draft ? "done" : "waiting" });
              break;
            }
            update(item.id, { status: "failed", error: errorMessage(error) });
          }
        }
      } finally {
        if (jobRef.current?.controller === controller) jobRef.current = null;
        runningRef.current = false;
        setRunning(false);
      }
    },
    [owner, update],
  );

  const start = useCallback(
    (labels: string[], variants: AvatarPngtuberVariant[], options: GenerationRunOptions) => {
      if (runningRef.current) return;
      const made = items.filter((item) => item.draft);
      const queue = labels.flatMap((label) =>
        variants.flatMap((variant): VariantJobItem[] => {
          const id = variantJobId(label, variant);
          return made.some((item) => item.id === id) ? [] : [{ id, label, variant, status: "waiting", kept: false }];
        }),
      );
      setItems([...made, ...queue]);
      void run(queue, options);
    },
    [items, run],
  );

  const retry = useCallback(
    (id: string, options: GenerationRunOptions) => {
      const item = items.find((entry) => entry.id === id);
      if (item) void run([item], options);
    },
    [items, run],
  );

  const cancel = useCallback(() => {
    if (!jobRef.current) return;
    stopJob(jobRef.current, "pngtuber");
    // Back to idle: only pictures already made stay (a picture being redone keeps its last version).
    setItems((current) =>
      current.flatMap((item) =>
        item.status === "waiting" || item.status === "running"
          ? item.draft
            ? [{ ...item, status: "done" as const }]
            : []
          : [item],
      ),
    );
  }, []);
  const setKept = useCallback((id: string, kept: boolean) => update(id, { kept }), [update]);
  const keepAll = useCallback(
    () => setItems((current) => current.map((item) => (item.draft ? { ...item, kept: true } : item))),
    [],
  );
  const removeSaved = useCallback(
    (ids: readonly string[]) => setItems((current) => current.filter((item) => !ids.includes(item.id))),
    [],
  );

  return { items, running, start, retry, cancel, setKept, keepAll, removeSaved };
}

/** Builds one mesh avatar draft. A second start while one runs does nothing. */
export function useMeshRigJob(owner: AvatarOwnerRef) {
  const [draft, setDraft] = useState<(MeshRigDraft & { label: string }) | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runningRef = useRef(false);
  const jobRef = useRef<RunningJob | null>(null);

  useEffect(() => () => stopJob(jobRef.current, "mesh-avatar"), []);
  useEffect(() => {
    stopJob(jobRef.current, "mesh-avatar");
    setDraft(null);
    setError(null);
  }, [owner.ownerType, owner.ownerId]);

  const start = useCallback(
    async (body: { sourceLabel: string; connectionId: string | null }) => {
      if (runningRef.current) return;
      runningRef.current = true;
      setRunning(true);
      setError(null);
      const controller = new AbortController();
      jobRef.current = { controller, owner };
      try {
        const result = await api.post<MeshRigDraft>(
          `${PREFIX}/mesh-rig`,
          { owner, ...body, debugMode: useUIStore.getState().debugMode },
          { signal: controller.signal },
        );
        if (!controller.signal.aborted) setDraft({ ...result, label: body.sourceLabel });
      } catch (caught) {
        if (!controller.signal.aborted && !isAbort(caught)) setError(errorMessage(caught));
      } finally {
        if (jobRef.current?.controller === controller) jobRef.current = null;
        runningRef.current = false;
        setRunning(false);
      }
    },
    [owner],
  );

  const cancel = useCallback(() => stopJob(jobRef.current, "mesh-avatar"), []);
  const discard = useCallback(() => setDraft(null), []);
  return { draft, running, error, start, cancel, discard };
}

export function useSavePngtuberVariants(owner: AvatarOwnerRef) {
  const changed = useAvatarModelChanged(owner);
  return useMutation({
    mutationFn: (images: Array<{ label: string; variant: AvatarPngtuberVariant; image: string; sourceHash: string }>) =>
      api.post<AvatarGenerationResponse>(`${PREFIX}/pngtuber-variants/save`, { owner, images }),
    onSuccess: (response) => changed(response.config),
  });
}

export function useSaveMeshRig(owner: AvatarOwnerRef) {
  const changed = useAvatarModelChanged(owner);
  return useMutation({
    mutationFn: (archive: string) => api.post<AvatarGenerationResponse>(`${PREFIX}/mesh-rig/save`, { owner, archive }),
    onSuccess: (response) => changed(response.config),
  });
}
