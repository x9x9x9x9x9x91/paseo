import { describe, expect, it } from "vitest";
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import {
  followOtherWindowsWrites,
  followOtherWindowsWritesByKey,
  mergeFollowedEntries,
  type OtherWindowsWrites,
  type StorageEventSource,
} from "./follow-other-windows";

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
  type StorageListener = Parameters<StorageEventSource["addEventListener"]>[1];
  const listeners = new Set<StorageListener>();
  const source: StorageEventSource = {
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
  };
  const fire = (key: string | null, newValue: string | null, oldValue?: string | null) => {
    for (const listener of listeners) listener({ key, newValue, oldValue });
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

interface NotesState {
  notesById: Record<string, { text: string; at: number }>;
  /** Never stored: what this window shows. */
  selectedId: string | null;
  writeNote: (id: string, text: string, at: number) => void;
  removeNote: (id: string) => void;
}

const NOTES_KEY = "notes";

function createKeyedWindowStore(
  storage: StateStorage,
  source: StorageEventSource | null,
  isRestored?: () => boolean,
) {
  let writes: OtherWindowsWrites | null = null;
  const store = create<NotesState>()(
    persist(
      (set) => ({
        notesById: {},
        selectedId: null,
        writeNote: (id, text, at) =>
          set((state) => ({ notesById: { ...state.notesById, [id]: { text, at } } })),
        removeNote: (id) =>
          set((state) => {
            const { [id]: _removed, ...notesById } = state.notesById;
            return { notesById };
          }),
      }),
      {
        name: NOTES_KEY,
        storage: createJSONStorage(() => storage),
        partialize: (state) => ({ notesById: state.notesById }),
        merge: (persistedState, currentState) => {
          const stored = persistedState as Pick<NotesState, "notesById">;
          const before = writes?.takeStateBefore();
          if (!before) return { ...currentState, ...stored };
          return {
            ...currentState,
            notesById: mergeFollowedEntries({
              before: before.notesById,
              storedRaw: stored.notesById,
              stored: stored.notesById,
              local: currentState.notesById,
              keepLocal: ({ local, stored: storedNote, before: beforeNote }) =>
                local.at >
                (storedNote?.at ?? (beforeNote as { at: number } | undefined)?.at ?? -Infinity),
            }),
          };
        },
      },
    ),
  );
  writes = followOtherWindowsWritesByKey(store, source, isRestored);
  return { store, writes };
}

describe("followOtherWindowsWritesByKey", () => {
  it("takes in the entries another window wrote or removed and keeps every other entry as it is", async () => {
    const shared = createSharedStorage();
    const windowA = createKeyedWindowStore(shared.storage, null).store;
    const eventsOfB = createEventSource();
    const windowB = createKeyedWindowStore(shared.storage, eventsOfB.source).store;
    windowA.getState().writeNote("kept", "same in both", 1);
    windowA.getState().writeNote("gone", "removed by A", 1);
    await settle();
    await windowB.persist.rehydrate();
    windowB.setState({ selectedId: "kept" });
    const keptInB = windowB.getState().notesById.kept;

    const beforeA = shared.values.get(NOTES_KEY) ?? null;
    windowA.getState().writeNote("new", "written by A", 2);
    windowA.getState().removeNote("gone");
    await settle();
    eventsOfB.fire(NOTES_KEY, shared.values.get(NOTES_KEY) ?? null, beforeA);
    await settle();

    expect(windowB.getState().notesById).toEqual({
      kept: { text: "same in both", at: 1 },
      new: { text: "written by A", at: 2 },
    });
    expect(windowB.getState().notesById.kept).toBe(keptInB);
    expect(windowB.getState().selectedId).toBe("kept");
  });

  it("keeps this window's later change to an entry the other window wrote too", async () => {
    const shared = createSharedStorage();
    const windowA = createKeyedWindowStore(shared.storage, null).store;
    const eventsOfB = createEventSource();
    const windowB = createKeyedWindowStore(shared.storage, eventsOfB.source).store;
    await windowB.persist.rehydrate();

    const beforeA = shared.values.get(NOTES_KEY) ?? null;
    windowA.getState().writeNote("both", "older, from A", 1);
    await settle();
    const writtenByA = shared.values.get(NOTES_KEY) ?? null;
    // B's own change, made after A's but not read in by A yet.
    windowB.setState({ notesById: { both: { text: "later, from B", at: 2 } } });
    shared.values.set(NOTES_KEY, writtenByA ?? "");
    eventsOfB.fire(NOTES_KEY, writtenByA, beforeA);
    await settle();

    expect(windowB.getState().notesById.both).toEqual({ text: "later, from B", at: 2 });
  });

  it("takes in two writes that came before one merge, from the state before the first", async () => {
    const shared = createSharedStorage();
    const windowA = createKeyedWindowStore(shared.storage, null).store;
    const eventsOfB = createEventSource();
    const windowB = createKeyedWindowStore(shared.storage, eventsOfB.source).store;
    await windowB.persist.rehydrate();

    const first = shared.values.get(NOTES_KEY) ?? null;
    windowA.getState().writeNote("one", "first write", 1);
    await settle();
    const second = shared.values.get(NOTES_KEY) ?? null;
    windowA.getState().writeNote("two", "second write", 2);
    await settle();
    eventsOfB.fire(NOTES_KEY, second, first);
    eventsOfB.fire(NOTES_KEY, shared.values.get(NOTES_KEY) ?? null, second);
    await settle();

    expect(Object.keys(windowB.getState().notesById).sort()).toEqual(["one", "two"]);
  });

  it("leaves a write before the first hydration to that hydration", async () => {
    const shared = createSharedStorage();
    const slowStorage: StateStorage = {
      ...shared.storage,
      getItem: async (name) => shared.storage.getItem(name),
    };
    const eventsOfB = createEventSource();
    const { store: windowB, writes } = createKeyedWindowStore(slowStorage, eventsOfB.source);
    shared.values.set(
      NOTES_KEY,
      JSON.stringify({ state: { notesById: { early: { text: "before B read", at: 1 } } } }),
    );
    eventsOfB.fire(NOTES_KEY, shared.values.get(NOTES_KEY) ?? null, null);
    await settle();

    expect(writes.takeStateBefore()).toBeUndefined();
    expect(windowB.getState().notesById).toEqual({ early: { text: "before B read", at: 1 } });
  });

  it("follows key by key after a first read that failed, when the store says it is restored", async () => {
    const shared = createSharedStorage();
    let reads = 0;
    const failingFirstRead: StateStorage = {
      ...shared.storage,
      getItem: async (name) => {
        reads += 1;
        if (reads === 1) throw new Error("first read failed");
        return shared.storage.getItem(name);
      },
    };
    const eventsOfB = createEventSource();
    let restored = false;
    const { store: windowB } = createKeyedWindowStore(
      failingFirstRead,
      eventsOfB.source,
      () => restored,
    );
    await settle();
    restored = true;
    expect(windowB.persist.hasHydrated()).toBe(false);
    windowB.setState({ notesById: { unstored: { text: "only in B", at: 5 } } });
    shared.values.delete(NOTES_KEY);

    shared.values.set(
      NOTES_KEY,
      JSON.stringify({ state: { notesById: { fromA: { text: "written by A", at: 1 } } } }),
    );
    eventsOfB.fire(NOTES_KEY, shared.values.get(NOTES_KEY) ?? null, null);
    await settle();

    expect(windowB.getState().notesById).toEqual({
      unstored: { text: "only in B", at: 5 },
      fromA: { text: "written by A", at: 1 },
    });
  });
});
