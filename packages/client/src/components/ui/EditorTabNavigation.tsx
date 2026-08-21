import { ChevronDown, type LucideIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/utils";
import { useLocalizedUiText } from "../../localization/use-localized-ui-text";

export type EditorTabItem<T extends string> = {
  id: T;
  label: string;
  icon: LucideIcon;
};

export function EditorTabNavigation<T extends string>({
  tabs,
  activeId,
  onChange,
  getBadge,
  className,
}: {
  tabs: readonly EditorTabItem<T>[];
  activeId: T;
  onChange: (id: T) => void;
  getBadge?: (id: T) => string | number | null;
  className?: string;
}) {
  const { t } = useTranslation();
  const localize = useLocalizedUiText();
  const navigationLabel = t("editor.navigation.sections");

  return (
    <div className={cn("mari-editor-navigation min-w-0 flex-[3_1_36rem]", className)}>
      <nav aria-label={navigationLabel} className="flex min-w-0 items-center gap-1 @max-7xl:gap-0.5 @max-5xl:hidden">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const active = activeId === tab.id;
          const badge = getBadge?.(tab.id);
          return (
            <button
              type="button"
              aria-label={localize(tab.label)}
              aria-current={active ? "page" : undefined}
              data-active={active ? "true" : undefined}
              key={tab.id}
              onClick={() => onChange(tab.id)}
              className="mari-editor-tab flex min-w-0 flex-1 items-center justify-center gap-1.5 whitespace-nowrap rounded-xl px-2 py-2 text-center text-[0.6875rem] font-medium transition-all @max-7xl:gap-1 @max-7xl:px-1 @max-7xl:text-[0.625rem]"
            >
              <Icon size="0.8125rem" className="shrink-0 @max-7xl:hidden" />
              <span>{localize(tab.label)}</span>
              {badge != null && <span className="mari-editor-tab-badge ml-0.5">{badge}</span>}
            </button>
          );
        })}
      </nav>

      <div className="relative hidden @max-5xl:block">
        <select
          aria-label={navigationLabel}
          value={activeId}
          onChange={(event) => onChange(event.target.value as T)}
          className="mari-editor-navigation-select min-h-10 w-full appearance-none rounded-xl border px-3 py-2 pr-9 text-xs font-medium outline-none transition-colors focus-visible:ring-2"
        >
          {tabs.map((tab) => (
            <option key={tab.id} value={tab.id}>
              {localize(tab.label)}
            </option>
          ))}
        </select>
        <ChevronDown
          aria-hidden="true"
          size="0.875rem"
          className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-[var(--marinara-editor-muted)]"
        />
      </div>
    </div>
  );
}
