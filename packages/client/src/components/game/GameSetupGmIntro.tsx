// ──────────────────────────────────────────────
// Game: the Game Master's intro message (Capability API 1.338), part of the GM setup. Defined is the
// game's first message exactly as written; guided only shapes the one the Game Master writes. An
// Experience may set its own: locked, it is shown and cannot be changed; unlocked, it starts the field.
// ──────────────────────────────────────────────
import { Lock } from "lucide-react";
import { useTranslation as useUiTranslation } from "react-i18next";
import { GAME_INTRO_TEXT_MAX, type GameIntro, type GameIntroChoice } from "@marinara-engine/shared";
import { cn } from "../../lib/utils";
import { GAME_SETUP_FIELD_LABEL, GAME_SETUP_INPUT_CLASS } from "./game-setup-classes";

const MODES = ["none", "defined", "guided"] as const;

/** What the setup sends: the choice, or nothing when it is the Experience's own (or none, with none). */
export function gameIntroForSetup(choice: GameIntroChoice | null): GameIntroChoice | undefined {
  if (!choice) return undefined;
  if (choice.mode === "none") return choice;
  return choice.text.trim() ? { mode: choice.mode, text: choice.text.trim() } : { mode: "none" };
}

export function GameSetupGmIntro({
  value,
  onChange,
  experience,
}: {
  /** The setup's own choice; null follows the Experience's intro. */
  value: GameIntroChoice | null;
  onChange: (choice: GameIntroChoice | null) => void;
  /** The Experience's intro, when it sets one. */
  experience?: GameIntro;
}) {
  const { t } = useUiTranslation();
  const locked = experience?.locked === true;
  const shown: GameIntroChoice = locked ? experience! : (value ?? experience ?? { mode: "none" });
  const text = shown.mode === "none" ? "" : shown.text;
  const bracketed = shown.mode === "guided" && /[[\]]/.test(text);
  return (
    <div>
      <label className={GAME_SETUP_FIELD_LABEL}>{t("game.intro.title")}</label>
      {locked && (
        <p className="mb-1.5 flex items-center gap-1 text-[0.625rem] text-[var(--muted-foreground)]">
          <Lock size="0.625rem" />
          {t("game.intro.locked")}
        </p>
      )}
      <div className="mb-1.5 flex gap-2" role="radiogroup" aria-label={t("game.intro.title")}>
        {MODES.map((mode) => (
          <button
            key={mode}
            type="button"
            role="radio"
            aria-checked={shown.mode === mode}
            disabled={locked}
            onClick={() => onChange(mode === "none" ? { mode: "none" } : { mode, text })}
            className={cn(
              "flex-1 rounded-lg px-3 py-1.5 text-xs transition-colors ring-1 disabled:cursor-not-allowed disabled:opacity-60",
              shown.mode === mode
                ? "bg-[var(--primary)]/10 ring-[var(--primary)]/40 text-[var(--foreground)]"
                : "bg-[var(--secondary)] ring-[var(--border)] text-[var(--muted-foreground)] hover:ring-[var(--primary)]/20",
            )}
          >
            {t(`game.intro.mode.${mode}`)}
          </button>
        ))}
      </div>
      {shown.mode !== "none" && (
        <textarea
          value={text}
          readOnly={locked}
          maxLength={GAME_INTRO_TEXT_MAX}
          rows={shown.mode === "defined" ? 6 : 3}
          onChange={(event) => onChange({ mode: shown.mode, text: event.target.value })}
          placeholder={t(`game.intro.placeholder.${shown.mode}`)}
          aria-label={t("game.intro.title")}
          className={cn(GAME_SETUP_INPUT_CLASS, "resize-y", locked && "opacity-70")}
        />
      )}
      <p
        className={cn(
          "mt-1 text-[0.575rem]",
          bracketed ? "text-[var(--destructive)]" : "text-[var(--muted-foreground)]",
        )}
      >
        {bracketed ? t("game.intro.noBrackets") : t(`game.intro.help.${shown.mode}`)}
      </p>
    </div>
  );
}
