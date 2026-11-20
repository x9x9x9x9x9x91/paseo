import { describe, expect, it } from "vitest";
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import { followOtherWindowsWrites, type StorageEventSource } from "./follow-other-windows";

interface FoldersState {
  folderIdByProjectKey: Record<string, string>;
  label: string;
  moveProject: (projectKey: string, folderId: string | null) => void;
  setLabel: (label: string) => void;
}

const KEY = "sidebar-project-folders";

/** One shared storage, as the windows of one origin share `localStorage`. */
function createSharedStorage() {
  const values = new Map<string, string>();
  let writes = 0;
  const storage: StateStorage = {
    getItem: (name) => values.get(name) ?? null,
    setItem: (name, value) => {
      writes += 1;
      values.set(name, value);
    },
    removeItem: (name) => {
      values.delete(name);
    },
  };
  return { values, storage, writes: () => writes };
}

/** A window's `storage` events: the browser fires them only in the windows that did not write. */
function createEventSource() {
  const listeners = new Set<(event: { key: string | null; newValue: string | null }) => void>();
  const source: StorageEventSource = {
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
  };
  const fire = (key: string | null, newValue: string | null) => {
    for (const listener of listeners) listener({ key, newValue });
  };
  return { source, fire, listenerCount: () => listeners.size };
}

function createWindowStore(storage: StateStorage) {
  return create<FoldersState>()(
    persist(
      (set) => ({
        folderIdByProjectKey: {},
        label: "",
        moveProject: (projectKey, folderId) =>
          set((state) => {
            const next = { ...state.folderIdByProjectKey };
            if (folderId === null) delete next[projectKey];
            else next[projectKey] = folderId;
            return { folderIdByProjectKey: next };
          }),
        setLabel: (label) => set({ label }),
      }),
      {
        name: KEY,
        storage: createJSONStorage(() => storage),
        partialize: (state) => ({
          folderIdByProjectKey: state.folderIdByProjectKey,
          label: state.label,
        }),
      },
    ),
  );
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("followOtherWindowsWrites", () => {
  it("keeps a folder change made in another window through this window's next change", async () => {
    const shared = createSharedStorage();
    shared.values.set(
      KEY,
      JSON.stringify({ state: { folderIdByProjectKey: { alma: "workers" }, label: "" } }),
    );
    const windowA = createWindowStore(shared.storage);
    const windowB = createWindowStore(shared.storage);
    await windowA.persist.rehydrate();
    await windowB.persist.rehydrate();
    expect(windowB.getState().folderIdByProjectKey).toEqual({ alma: "workers" });
    const eventsOfB = createEventSource();
    followOtherWindowsWrites(windowB, eventsOfB.source);

    windowA.getState().moveProject("alma", null);
    await settle();
    eventsOfB.fire(KEY, shared.values.get(KEY) ?? null);
    await settle();
    expect(windowB.getState().folderIdByProjectKey).toEqual({});

    windowB.getState().setLabel("renamed");
    await settle();
    const stored = JSON.parse(shared.values.get(KEY) ?? "null");
    expect(stored.state).toEqual({ folderIdByProjectKey: {}, label: "renamed" });
  });

  it("shows another window's change and writes nothing back", async () => {
    const shared = createSharedStorage();
    const windowA = createWindowStore(shared.storage);
    const windowB = createWindowStore(shared.storage);
    await windowB.persist.rehydrate();
    const eventsOfB = createEventSource();
    followOtherWindowsWrites(windowB, eventsOfB.source);

    windowA.getState().moveProject("crisis", "workers");
    await settle();
    const writesBefore = shared.writes();
    eventsOfB.fire(KEY, shared.values.get(KEY) ?? null);
    await settle();

    expect(windowB.getState().folderIdByProjectKey).toEqual({ crisis: "workers" });
    expect(shared.writes()).toBe(writesBefore);
  });

  it("leaves the store alone for another key, a removed key, and once stopped", async () => {
    const shared = createSharedStorage();
    const windowA = createWindowStore(shared.storage);
    const windowB = createWindowStore(shared.storage);
    await windowB.persist.rehydrate();
    const eventsOfB = createEventSource();
    const stop = followOtherWindowsWrites(windowB, eventsOfB.source);

    windowA.getState().moveProject("crisis", "workers");
    await settle();
    eventsOfB.fire("sidebar-collapsed-sections", "{}");
    eventsOfB.fire(KEY, null);
    eventsOfB.fire(null, null);
    await settle();
    expect(windowB.getState().folderIdByProjectKey).toEqual({});

    stop();
    expect(eventsOfB.listenerCount()).toBe(0);
  });

  it("follows nothing without a window", () => {
    const shared = createSharedStorage();
    const store = createWindowStore(shared.storage);
    expect(() => followOtherWindowsWrites(store, null)()).not.toThrow();
  });
});
