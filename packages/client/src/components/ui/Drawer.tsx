// ──────────────────────────────────────────────
// Shared collapsible drawer (the Chat Settings section look)
//
// Custom themes style the stable `mari-drawer…` classes, `data-drawer` /
// `data-detached` and the `--mari-drawer-*` variables documented in globals.css.
// ──────────────────────────────────────────────
import { useId, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "../../lib/utils";
import { HelpTooltip } from "./HelpTooltip";

export interface DrawerProps {
  /** Stable id, exposed as `data-drawer` for themes and tests. */
  id?: string;
  title: ReactNode;
  icon?: ReactNode;
  count?: number;
  help?: string;
  /** Shown beside the title while the drawer is closed (a tracker's miniature display). */
  summary?: ReactNode;
  /** Reserved slot between the help tip and the arrow (the pop-out button, later). */
  actions?: ReactNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** True while the drawer is popped out into its own window. */
  detached?: boolean;
  className?: string;
  style?: CSSProperties;
  /** Top spacing of the body; defaults to "pt-3". */
  bodyClassName?: string;
  rootAttributes?: Record<`data-${string}`, string | undefined>;
  children: ReactNode;
}

export function Drawer({
  id,
  title,
  icon,
  count,
  help,
  summary,
  actions,
  open,
  onOpenChange,
  detached = false,
  className,
  style,
  bodyClassName,
  rootAttributes,
  children,
}: DrawerProps) {
  const bodyId = `mari-drawer-body-${useId().replace(/:/gu, "")}`;
  const handleHeaderKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return;
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onOpenChange(!open);
  };

  return (
    <div
      data-drawer={id}
      data-detached={detached ? "true" : "false"}
      {...rootAttributes}
      className={cn("mari-drawer", className)}
      style={style}
    >
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        aria-controls={open ? bodyId : undefined}
        onClick={() => onOpenChange(!open)}
        onKeyDown={handleHeaderKeyDown}
        className="mari-drawer__header flex w-full items-center gap-2 text-left transition-colors"
      >
        {icon && <span className="mari-drawer__icon">{icon}</span>}
        <span className="mari-drawer__title flex-1 text-xs font-semibold">{title}</span>
        {summary && !open && <span className="mari-drawer__summary flex shrink-0 items-center">{summary}</span>}
        {count != null && count > 0 && (
          <span className="mari-drawer__count rounded-full px-1.5 py-0.5 text-[0.625rem] font-medium">{count}</span>
        )}
        {help && (
          <span className="mari-drawer__help" onClick={(event) => event.stopPropagation()}>
            <HelpTooltip text={help} side="left" />
          </span>
        )}
        {actions && (
          <span className="mari-drawer__actions flex items-center" onClick={(event) => event.stopPropagation()}>
            {actions}
          </span>
        )}
        <ChevronDown size="0.75rem" className={cn("mari-drawer__arrow transition-transform", open && "rotate-180")} />
      </div>
      {open && (
        <div id={bodyId} className={cn("mari-drawer__body", bodyClassName ?? "pt-3")}>
          {children}
        </div>
      )}
    </div>
  );
}
