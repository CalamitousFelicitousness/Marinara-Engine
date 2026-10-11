// ──────────────────────────────────────────────
// Character Onboarding Modal
// Shown during chat setup when a chosen character's card ships interactive
// onboarding: the player answers the card's questions and the answers become
// a new persona. Questions appear and disappear as the answers change.
// ──────────────────────────────────────────────
import { useMemo, useRef, useState } from "react";
import { PencilLine, CheckCircle2, Circle } from "lucide-react";
import { toast } from "sonner";
import { useTranslation as useUiTranslation } from "react-i18next";
import {
  getNextOnboardingVariable,
  getOnboardingVariables,
  getRelevantCardVariables,
  getRelevantOnboardingVariables,
  ONBOARDING_PLAYER_VARIABLE,
  resolveCardVariables,
  resolveOnboardingPersona,
  resolveOnboardingQuestions,
  type CharacterOnboarding,
  type CharacterOnboardingVariable,
  type OnboardingAnswer,
  type OnboardingAnswers,
  type OnboardingCardFields,
} from "@marinara-engine/shared";
import { Modal } from "../ui/Modal";
import { ChoiceOptionsField } from "../presets/ChoiceOptionsField";
import { useCreatePersona } from "../../hooks/use-characters";
import { cn } from "../../lib/utils";

const FIELD_CLASS =
  "w-full rounded-lg bg-[var(--background)] px-3 py-2 text-xs text-[var(--foreground)] ring-1 ring-[var(--border)] placeholder:text-[var(--muted-foreground)]/60 focus:outline-none focus:ring-2 focus:ring-[var(--ring)]";
const ROW_CLASS = "flex w-full items-start gap-2.5 rounded-lg p-2.5 text-left transition-all";
const ROW_SELECTED_CLASS = "bg-[var(--primary)]/10 ring-1 ring-[var(--primary)]/30";

/** Choices start on their first option; free text starts empty. */
function defaultAnswer(variable: CharacterOnboardingVariable): OnboardingAnswer {
  const first = variable.options[0];
  return first ? { optionIds: [first.id] } : { text: "" };
}

/** Answers for one list of questions, defaults for whatever isn't overridden. */
function answersFor(variables: CharacterOnboardingVariable[], overrides: OnboardingAnswers): OnboardingAnswers {
  // Own properties only, on an object without a prototype: a question named
  // `toString` or `__proto__` must not read or replace Object.prototype.
  const merged: OnboardingAnswers = Object.create(null);
  for (const variable of variables) {
    const name = variable.variableName;
    merged[name] = Object.prototype.hasOwnProperty.call(overrides, name) ? overrides[name]! : defaultAnswer(variable);
  }
  return merged;
}

export function CharacterOnboardingModal({
  open,
  characterName,
  onboarding,
  cardFields,
  withPersona,
  onBack,
  onCreated,
}: {
  open: boolean;
  characterName: string;
  onboarding: CharacterOnboarding;
  /** The card's own text, so its questions are the ones the card actually reads. */
  cardFields: OnboardingCardFields;
  /** False when the player asked for no new persona: only the card needs answers. */
  withPersona: boolean;
  /** Return to the persona picker without creating anything. */
  onBack: () => void;
  /** The window stays open and locked until this settles. */
  onCreated: (personaId: string | null, cardVariables: Record<string, string>) => void | Promise<void>;
}) {
  const { t: localizeUi } = useUiTranslation();
  const createPersona = useCreatePersona();
  const [overrides, setOverrides] = useState<OnboardingAnswers>({});

  const personaVariables = useMemo(() => getOnboardingVariables(onboarding), [onboarding]);
  // The card's fields and the persona's fields are answered in one window, but
  // they resolve different things, so each list keeps its own answers.
  const cardAnswers = useMemo(() => answersFor(onboarding.cardVariables ?? [], overrides), [onboarding, overrides]);
  const personaAnswers = useMemo(() => answersFor(personaVariables, overrides), [personaVariables, overrides]);

  const cardQuestions = useMemo(
    () => getRelevantCardVariables(onboarding, cardFields, cardAnswers),
    [onboarding, cardFields, cardAnswers],
  );
  const personaQuestions = useMemo(
    () => (withPersona ? getRelevantOnboardingVariables(onboarding, personaAnswers) : []),
    [withPersona, onboarding, personaAnswers],
  );
  const questionTexts = useMemo(
    () => resolveOnboardingQuestions(onboarding, personaAnswers, characterName),
    [onboarding, personaAnswers, characterName],
  );
  const setAnswer = (name: string, answer: OnboardingAnswer) => setOverrides((prev) => ({ ...prev, [name]: answer }));

  // Card questions are OPTIONAL: a blank one simply writes no variable, and the
  // card keeps whatever it reads without it. The persona is not — it needs a
  // name and its fields are the persona's whole content.
  const personaComplete = useMemo(
    () => !withPersona || getNextOnboardingVariable(onboarding, personaAnswers) === null,
    [withPersona, onboarding, personaAnswers],
  );
  // Nothing to show at all: the wizard suppresses the modal for this case, so
  // this only guards a direct render.
  const hasAnything = cardQuestions.length > 0 || personaQuestions.length > 0;

  // Set synchronously, so a double click can't create the persona twice before
  // the button re-renders as disabled.
  const creatingRef = useRef(false);
  // Locked from Create until the wizard has switched the chat to the new
  // persona, so Back or a second Create can't interleave with that update.
  const [busy, setBusy] = useState(false);
  const handleCreate = async () => {
    if (creatingRef.current) return;
    creatingRef.current = true;
    setBusy(true);
    try {
      const cardVariables = resolveCardVariables(onboarding, cardAnswers);
      let personaId: string | null = null;
      if (withPersona) {
        try {
          personaId = (await createPersona.mutateAsync(resolveOnboardingPersona(onboarding, personaAnswers))).id;
        } catch {
          toast.error(localizeUi("ui.characters.onboarding.createFailed"));
          return;
        }
      }
      await onCreated(personaId, cardVariables);
    } finally {
      creatingRef.current = false;
      setBusy(false);
    }
  };

  const renderQuestion = (variable: CharacterOnboardingVariable, showName: boolean) => {
    const name = variable.variableName;
    const answer = (showName ? personaAnswers : cardAnswers)[name];
    const ownText = answer && "text" in answer ? answer.text : null;
    const isPlayer = showName && name === ONBOARDING_PLAYER_VARIABLE;
    const question = variable.question
      ? (questionTexts.get(variable.id) ?? "")
      : isPlayer
        ? localizeUi("ui.characters.onboarding.nameQuestion")
        : name;
    const textInput = (value: string) =>
      isPlayer ? (
        <input
          value={value}
          onChange={(event) => setAnswer(name, { text: event.target.value })}
          placeholder={localizeUi("ui.characters.onboarding.yourAnswer")}
          aria-label={question}
          className={FIELD_CLASS}
        />
      ) : (
        <textarea
          value={value}
          onChange={(event) => setAnswer(name, { text: event.target.value })}
          placeholder={localizeUi("ui.characters.onboarding.yourAnswer")}
          aria-label={question}
          rows={3}
          className={cn(FIELD_CLASS, "resize-y")}
        />
      );

    return (
      <div key={variable.id} className="rounded-xl border border-[var(--border)] bg-[var(--secondary)] p-3">
        <h4 className="mb-1 text-xs font-semibold text-[var(--foreground)]">{question}</h4>
        <p className="mb-2 text-[0.625rem] text-[var(--muted-foreground)]">
          {localizeUi("ui.presets.choiceselectionmodal.variable")}{" "}
          <code className="text-[var(--foreground)]">{`{{${name}}}`}</code>
        </p>
        {variable.options.length === 0 ? (
          textInput(ownText ?? "")
        ) : (
          <div className="space-y-1.5">
            <ChoiceOptionsField
              variable={variable}
              selection={
                answer && "optionIds" in answer
                  ? variable.multiSelect
                    ? answer.optionIds
                    : answer.optionIds[0]
                  : undefined
              }
              optionKey={(option) => option.id}
              onChange={(next) => setAnswer(name, { optionIds: Array.isArray(next) ? next : next ? [next] : [] })}
              allowBooleanToggle={false}
              ariaLabel={question}
            />
            {variable.allowCustom && (
              <>
                <button
                  type="button"
                  aria-pressed={ownText !== null}
                  onClick={() => setAnswer(name, { text: ownText ?? "" })}
                  className={cn(ROW_CLASS, ownText !== null ? ROW_SELECTED_CLASS : "hover:bg-[var(--accent)]")}
                >
                  {ownText !== null ? (
                    <CheckCircle2 size="0.875rem" className="mt-0.5 shrink-0 text-[var(--primary)]" />
                  ) : (
                    <Circle size="0.875rem" className="mt-0.5 shrink-0 text-[var(--muted-foreground)]" />
                  )}
                  <span
                    className={cn(
                      "flex items-center gap-1.5 text-xs font-medium",
                      ownText !== null && "text-[var(--primary)]",
                    )}
                  >
                    <PencilLine size="0.75rem" />
                    {localizeUi("ui.characters.onboarding.writeYourOwn")}
                  </span>
                </button>
                {ownText !== null && textInput(ownText)}
              </>
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <Modal
      open={open}
      onClose={onBack}
      title={localizeUi("ui.characters.onboarding.modalTitle")}
      width="max-w-lg"
      closeDisabled={busy}
    >
      <fieldset disabled={busy} className="min-w-0 space-y-4 p-4">
        <p className="text-xs text-[var(--muted-foreground)]">
          {localizeUi("ui.characters.onboarding.modalIntro", { value1: characterName })}
        </p>

        {cardQuestions.length > 0 && (
          <section className="space-y-3">
            {/* The card's own questions lead: they are the card's, not the
                persona's, and they are asked whether or not one is created. */}
            <div className="space-y-1">
              <h3 className="text-xs font-semibold text-[var(--foreground)]">
                {localizeUi("ui.characters.onboarding.modalCardSection")}
              </h3>
              <p className="text-[0.625rem] text-[var(--muted-foreground)]">
                {localizeUi("ui.characters.onboarding.modalCardHelp", { value1: characterName })}
              </p>
            </div>
            {cardQuestions.map((variable) => renderQuestion(variable, false))}
          </section>
        )}

        {personaQuestions.length > 0 && (
          <section className="space-y-3">
            <div className="space-y-1">
              <h3 className="text-xs font-semibold text-[var(--foreground)]">
                {localizeUi("ui.characters.onboarding.modalPersonaSection")}
              </h3>
              <p className="text-[0.625rem] text-[var(--muted-foreground)]">
                {localizeUi("ui.characters.onboarding.modalPersonaHelp")}
              </p>
            </div>
            {personaQuestions.map((variable) => renderQuestion(variable, true))}
          </section>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <button
            type="button"
            onClick={onBack}
            className="rounded-xl px-4 py-2 text-xs font-medium text-[var(--muted-foreground)] hover:bg-[var(--accent)]"
          >
            {localizeUi("navigation.common.back")}
          </button>
          <button
            type="button"
            onClick={() => void handleCreate()}
            disabled={!personaComplete || !hasAnything || busy}
            className="rounded-xl bg-[var(--primary)] px-4 py-2 text-xs font-medium text-[var(--primary-foreground)] shadow-md transition-all hover:opacity-90 active:scale-[0.98] disabled:opacity-50"
          >
            {busy
              ? localizeUi("chat.settings.inlineEditor.saving")
              : localizeUi("ui.characters.onboarding.createPersona")}
          </button>
        </div>
      </fieldset>
    </Modal>
  );
}
