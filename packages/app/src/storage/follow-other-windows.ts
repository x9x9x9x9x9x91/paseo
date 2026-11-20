import { isWeb } from "@/constants/platform";

interface StorageEventLike {
  key: string | null;
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

function defaultStorageEventSource(): StorageEventSource | null {
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
 * echo each other. A removed key is left alone: the window keeps what it shows and writes it on
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
