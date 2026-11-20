import { isWeb } from "@/constants/platform";

interface StorageEventLike {
  key: string | null;
  oldValue?: string | null;
  newValue: string | null;
}

export interface StorageEventSource {
  addEventListener(type: "storage", listener: (event: StorageEventLike) => void): void;
  removeEventListener(type: "storage", listener: (event: StorageEventLike) => void): void;
}

interface PersistedStoreLike {
  persist: {
    getOptions: () => { name?: string };
    rehydrate: () => Promise<void> | void;
  };
}

interface HydratingStoreLike extends PersistedStoreLike {
  persist: PersistedStoreLike["persist"] & {
    hasHydrated: () => boolean;
    onFinishHydration: (listener: () => void) => () => void;
  };
}

export function defaultStorageEventSource(): StorageEventSource | null {
  if (!isWeb || typeof window === "undefined" || typeof window.addEventListener !== "function") {
    return null;
  }
  return window as unknown as StorageEventSource;
}

/**
 * Reads a persisted store again whenever another app window writes its key, so every window
 * holds the latest stored state. Without it each window keeps its own copy and writes the whole
 * of it on its next change, putting back what another window had just changed (ALM-5112).
 *
 * On web the windows share one `localStorage`, and the browser fires `storage` only in the
 * windows that did not write. Zustand's rehydrate writes nothing back, so two windows do not
 * echo each other, as long as nothing the store runs on a hydration (`onRehydrateStorage`,
 * `onFinishHydration`) writes either; a store's start-up work belongs to its first hydration. A removed key is left alone: the window keeps what it shows and writes it on
 * its next change. Native runs one window, so there is nothing to follow there.
 */
export function followOtherWindowsWrites(
  store: PersistedStoreLike,
  source: StorageEventSource | null = defaultStorageEventSource(),
): () => void {
  const name = store.persist.getOptions().name;
  if (!source || !name) return () => {};
  const listener = (event: StorageEventLike) => {
    if (event.key !== name || event.newValue === null) return;
    void store.persist.rehydrate();
  };
  source.addEventListener("storage", listener);
  return () => source.removeEventListener("storage", listener);
}

/** A persisted store's stored state as a JSON object, `{}` when there is none to read. */
type StoredState = Record<string, unknown>;

export interface OtherWindowsWrites {
  /**
   * The stored state from before the other windows' writes this window has not merged yet, and
   * forgets it; `undefined` when there are none, as at start-up.
   */
  takeStateBefore: () => StoredState | undefined;
  stop: () => void;
}

function storedStateOf(raw: string | null | undefined): StoredState {
  if (!raw) return {};
  try {
    const decoded: unknown = JSON.parse(raw);
    if (decoded && typeof decoded === "object" && "state" in decoded) {
      const state = (decoded as { state: unknown }).state;
      if (state && typeof state === "object") return state as StoredState;
    }
  } catch {
    // An unreadable earlier value counts as empty: every stored entry then reads as changed.
  }
  return {};
}

/**
 * Like `followOtherWindowsWrites`, for a store whose `merge` takes in only what the other windows
 * changed (`mergeFollowedEntries`), so this window keeps its own copy of everything else: an
 * entry it has not written yet, state that is never stored, and the identity of what it shows
 * (ALM-5115). The store reads `takeStateBefore()` in its `merge`; the earlier stored value comes
 * from the `storage` event. Writes before the store's first hydration are left to that hydration,
 * which reads the latest stored state whole. A follow writes only a change of this window's own
 * that was not stored yet (the drafts' interval).
 */
export function followOtherWindowsWritesByKey(
  store: HydratingStoreLike,
  source: StorageEventSource | null = defaultStorageEventSource(),
): OtherWindowsWrites {
  let stateBefore: StoredState | undefined;
  let hydratedOnce = store.persist.hasHydrated();
  const name = store.persist.getOptions().name;
  const takeStateBefore = () => {
    const taken = stateBefore;
    stateBefore = undefined;
    return taken;
  };
  if (!source || !name) return { takeStateBefore, stop: () => {} };
  const stopHydrationListener = store.persist.onFinishHydration(() => {
    hydratedOnce = true;
  });
  const listener = (event: StorageEventLike) => {
    if (event.key !== name || event.newValue === null) return;
    // Two writes before one merge: the state before the first is what both changed from.
    if (hydratedOnce && stateBefore === undefined) stateBefore = storedStateOf(event.oldValue);
    void store.persist.rehydrate();
  };
  source.addEventListener("storage", listener);
  return {
    takeStateBefore,
    stop: () => {
      stopHydrationListener();
      source.removeEventListener("storage", listener);
    },
  };
}

function sameStoredValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function entriesOf(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/** The keys of a stored map whose entry differs between two stored states. */
export function changedStoredKeys(before: unknown, stored: unknown): Set<string> {
  const beforeEntries = entriesOf(before);
  const storedEntries = entriesOf(stored);
  const changed = new Set<string>();
  for (const key of new Set([...Object.keys(beforeEntries), ...Object.keys(storedEntries)])) {
    if (!sameStoredValue(beforeEntries[key], storedEntries[key])) changed.add(key);
  }
  return changed;
}

/**
 * One map of a store that follows other windows key by key: an entry the other windows changed
 * (written, or removed) is taken from storage, and every other entry stays this window's own
 * object. `keepLocal` lets this window's own unwritten change to that same entry win.
 */
export function mergeFollowedEntries<T>(input: {
  /** The map in the stored state from before the other windows' writes. */
  before: unknown;
  /** The map as stored now, in raw stored form, to compare with `before`. */
  storedRaw: unknown;
  /** The map as stored now, as the store's own merge makes it. */
  stored: Record<string, T>;
  local: Record<string, T>;
  keepLocal?: (entry: { local: T; stored: T | undefined; before: unknown }) => boolean;
}): Record<string, T> {
  const changed = changedStoredKeys(input.before, input.storedRaw);
  if (changed.size === 0) return input.local;
  const beforeEntries = entriesOf(input.before);
  const next: Record<string, T> = { ...input.local };
  for (const key of changed) {
    const local = Object.hasOwn(input.local, key) ? input.local[key] : undefined;
    const stored = Object.hasOwn(input.stored, key) ? input.stored[key] : undefined;
    if (local !== undefined && input.keepLocal?.({ local, stored, before: beforeEntries[key] })) {
      continue;
    }
    if (stored === undefined) delete next[key];
    else next[key] = stored;
  }
  return next;
}
