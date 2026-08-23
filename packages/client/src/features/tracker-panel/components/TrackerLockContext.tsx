import { createContext, useCallback, useContext, useMemo, type ReactNode } from "react";
import { isTrackerFieldLocked, type TrackerFieldLocks, type TrackerHiddenFields } from "@marinara-engine/shared";
import type { TrackerFieldLocksUpdater } from "../hooks/use-tracker-field-lock-updater";

type TrackerHiddenFieldsUpdater = (hiddenFields: TrackerHiddenFields | null | undefined) => TrackerHiddenFields;

interface TrackerLockContextValue {
  /** Rows accept edits only while this is true. Undefined outside the provider,
   *  which is how InlineEdit stays editable on the Roleplay HUD. */
  editMode?: boolean;
  fieldLocks?: TrackerFieldLocks | null;
  hiddenTrackerFields?: TrackerHiddenFields | null;
  lockMode: boolean;
  hideMode?: boolean;
  onSetLockMode?: (enabled: boolean) => void;
  onToggleFieldLock?: (key: string) => void;
  onUpdateFieldLocks?: (updater: TrackerFieldLocksUpdater) => void;
  onUpdateHiddenFields?: (updater: TrackerHiddenFieldsUpdater) => void;
}

const TrackerLockContext = createContext<TrackerLockContextValue>({ lockMode: false });

export function TrackerLockProvider({
  children,
  editMode,
  fieldLocks,
  hiddenTrackerFields,
  lockMode,
  hideMode,
  onSetLockMode,
  onToggleFieldLock,
  onUpdateFieldLocks,
  onUpdateHiddenFields,
}: TrackerLockContextValue & { children: ReactNode }) {
  const value = useMemo(
    () => ({
      editMode,
      fieldLocks,
      hiddenTrackerFields,
      lockMode,
      hideMode: hideMode === true,
      onSetLockMode,
      onToggleFieldLock,
      onUpdateFieldLocks,
      onUpdateHiddenFields,
    }),
    [
      editMode,
      fieldLocks,
      hiddenTrackerFields,
      lockMode,
      hideMode,
      onSetLockMode,
      onToggleFieldLock,
      onUpdateFieldLocks,
      onUpdateHiddenFields,
    ],
  );
  return <TrackerLockContext.Provider value={value}>{children}</TrackerLockContext.Provider>;
}

export function useTrackerLockContext() {
  return useContext(TrackerLockContext);
}

export function useTrackerFieldLock(key: string | undefined) {
  const { fieldLocks, lockMode, onToggleFieldLock } = useTrackerLockContext();
  const onToggleLock = useCallback(() => {
    if (key) onToggleFieldLock?.(key);
  }, [key, onToggleFieldLock]);
  return {
    locked: key ? isTrackerFieldLocked(fieldLocks, key) : false,
    lockMode,
    onToggleLock: key && onToggleFieldLock ? onToggleLock : undefined,
  };
}
