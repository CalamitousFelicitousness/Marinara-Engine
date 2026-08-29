import { useEffect, useRef, useState } from "react";

interface DraftNumberInputProps {
  value: number;
  onCommit: (value: number) => void;
  className?: string;
  min?: number;
  max?: number;
  integer?: boolean;
  selectOnFocus?: boolean;
  commitOnValidChange?: boolean;
  disabled?: boolean;
  ariaLabel?: string;
  placeholder?: string;
  title?: string;
  id?: string;
}

export function DraftNumberInput({
  value,
  onCommit,
  className,
  min,
  max,
  integer = true,
  selectOnFocus = false,
  commitOnValidChange = false,
  disabled = false,
  ariaLabel,
  placeholder,
  title,
  id,
}: DraftNumberInputProps) {
  const [draft, setDraft] = useState(String(value));
  const focusedRef = useRef(false);

  useEffect(() => {
    // While the user is editing, the draft belongs to them: a value-prop
    // update arriving mid-edit is usually the ASYNC ECHO of the previous
    // commit (mutate → invalidate → refetch), and syncing it here wiped the
    // in-progress draft so blur re-committed the OLD value — a silently
    // dropped edit (#5636). External updates still sync any time the field
    // is not focused.
    if (focusedRef.current) return;
    setDraft(String(value));
  }, [value]);

  const parseDraft = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return null;

    const numericPattern = integer ? /^-?\d+$/ : /^-?(?:\d+\.?\d*|\.\d+)$/;
    if (!numericPattern.test(trimmed)) return null;

    const parsed = Number(trimmed);
    const validNumber = Number.isFinite(parsed) && (!integer || Number.isInteger(parsed));

    return validNumber ? parsed : null;
  };

  const clampValue = (raw: number) => {
    let next = raw;
    if (min !== undefined && next < min) next = min;
    if (max !== undefined && next > max) next = max;
    return next;
  };

  const commit = () => {
    const parsed = parseDraft(draft);

    if (parsed !== null) {
      const next = clampValue(parsed);
      onCommit(next);
      setDraft(String(next));
      return;
    }

    setDraft(String(value));
  };

  const commitRef = useRef(commit);
  commitRef.current = commit;

  useEffect(() => {
    return () => {
      // React fires no blur for a node that unmounts, so an edit in progress
      // when the surrounding tree is torn down (a parent re-keys or a
      // condition flips, the drawer closes) was silently dropped (#5636).
      // Flush it the same way blur would have.
      if (focusedRef.current) {
        focusedRef.current = false;
        commitRef.current();
      }
    };
  }, []);

  return (
    <input
      type="text"
      inputMode={integer && (min === undefined || min < 0) ? "text" : integer ? "numeric" : "decimal"}
      id={id}
      value={draft}
      aria-label={ariaLabel}
      placeholder={placeholder}
      title={title}
      disabled={disabled}
      onFocus={(e) => {
        focusedRef.current = true;
        if (selectOnFocus) e.target.select();
      }}
      onChange={(e) => {
        const nextDraft = e.target.value;
        setDraft(nextDraft);
        if (commitOnValidChange) {
          const parsed = parseDraft(nextDraft);
          if (parsed !== null) onCommit(clampValue(parsed));
        }
      }}
      onBlur={() => {
        focusedRef.current = false;
        commit();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.currentTarget.blur();
        }
      }}
      className={className}
    />
  );
}
