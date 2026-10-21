import { useTranslation } from "react-i18next";

/** The same model guidance beside Mari's first connection choice and in her connection picker. */
export function MariConnectionGuidance({ showSelectionHint = false }: { showSelectionHint?: boolean }) {
  const { t } = useTranslation();
  return (
    <div
      data-component="ProfessorMari.ConnectionGuidance"
      className="space-y-2 text-xs leading-relaxed text-[var(--muted-foreground)]"
    >
      {showSelectionHint && <p>{t("professorMari.connectionGuidance.select")}</p>}
      <p>{t("professorMari.connectionGuidance.model")}</p>
      <p>{t("professorMari.connectionGuidance.context")}</p>
      <ul className="list-disc space-y-1 pl-4">
        {["tier16k", "tier32k", "tier64k", "tier128k"].map((tier) => (
          <li key={tier}>{t(`professorMari.connectionGuidance.${tier}`)}</li>
        ))}
      </ul>
    </div>
  );
}
