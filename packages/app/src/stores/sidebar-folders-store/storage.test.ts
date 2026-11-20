import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { StateStorage } from "zustand/middleware";
import {
  createSidebarFoldersStorage,
  SIDEBAR_FOLDER_LANDING_STORAGE_KEY,
  SIDEBAR_FOLDERS_STORAGE_KEY,
} from "@/stores/sidebar-folders-store/storage";

class MemoryStorage implements StateStorage {
  readonly values = new Map<string, string>();

  getItem(name: string): string | null {
    return this.values.get(name) ?? null;
  }

  setItem(name: string, value: string): void {
    this.values.set(name, value);
  }

  removeItem(name: string): void {
    this.values.delete(name);
  }
}

/** What every build from before ALM-5127 reads the folders' key with: strict, envelope too. */
const OlderBuildEnvelopeSchema = z.strictObject({
  state: z.strictObject({
    folders: z.array(z.strictObject({ id: z.string(), name: z.string(), collapsed: z.boolean() })),
    folderIdByProjectKey: z.record(z.string(), z.string()),
  }),
  version: z.number().int().nonnegative().optional(),
});

const folders = [{ id: "workers", name: "Workers", collapsed: true }];
const ticked = {
  folders,
  folderIdByProjectKey: { alma: "workers" },
  landingFolderId: "workers",
  knownProjectKeys: ["alma", "chats"],
};

function stored(backing: MemoryStorage, key: string): unknown {
  const raw = backing.getItem(key);
  return raw === null ? null : JSON.parse(raw);
}

describe("sidebar folders storage", () => {
  it("keeps the tick out of the folders' key, so an older build still reads the folders", async () => {
    const backing = new MemoryStorage();
    const storage = createSidebarFoldersStorage(backing);
    await storage.setItem(SIDEBAR_FOLDERS_STORAGE_KEY, { state: ticked, version: 0 });

    const foldersValue = stored(backing, SIDEBAR_FOLDERS_STORAGE_KEY);
    expect(OlderBuildEnvelopeSchema.safeParse(foldersValue).success).toBe(true);
    expect(foldersValue).toEqual({
      state: { folders, folderIdByProjectKey: { alma: "workers" } },
      version: 0,
    });
    expect(stored(backing, SIDEBAR_FOLDER_LANDING_STORAGE_KEY)).toEqual({
      state: { landingFolderId: "workers", knownProjectKeys: ["alma", "chats"] },
      version: 0,
    });
    await expect(storage.getItem(SIDEBAR_FOLDERS_STORAGE_KEY)).resolves.toEqual({
      state: ticked,
      version: 0,
    });
  });

  it("stores an untick as no landing folder, so another window follows it", async () => {
    const backing = new MemoryStorage();
    const storage = createSidebarFoldersStorage(backing);
    await storage.setItem(SIDEBAR_FOLDERS_STORAGE_KEY, { state: ticked, version: 0 });
    await storage.setItem(SIDEBAR_FOLDERS_STORAGE_KEY, {
      state: { ...ticked, landingFolderId: null, knownProjectKeys: [] },
      version: 0,
    });

    expect(stored(backing, SIDEBAR_FOLDER_LANDING_STORAGE_KEY)).toEqual({
      state: { landingFolderId: null, knownProjectKeys: [] },
      version: 0,
    });
  });

  it("moves a tick stored in the folders' key to its own key on read, so an older build keeps the folders", async () => {
    const backing = new MemoryStorage();
    backing.setItem(SIDEBAR_FOLDERS_STORAGE_KEY, JSON.stringify({ state: ticked, version: 0 }));
    const storage = createSidebarFoldersStorage(backing);
    await expect(storage.getItem(SIDEBAR_FOLDERS_STORAGE_KEY)).resolves.toEqual({
      state: ticked,
      version: 0,
    });

    const foldersValue = stored(backing, SIDEBAR_FOLDERS_STORAGE_KEY);
    expect(OlderBuildEnvelopeSchema.safeParse(foldersValue).success).toBe(true);
    expect(stored(backing, SIDEBAR_FOLDER_LANDING_STORAGE_KEY)).toEqual({
      state: { landingFolderId: "workers", knownProjectKeys: ["alma", "chats"] },
      version: 0,
    });
  });

  it("reads the tick's own key over one in the folders' key, and clears the folders' key", async () => {
    const backing = new MemoryStorage();
    backing.setItem(SIDEBAR_FOLDERS_STORAGE_KEY, JSON.stringify({ state: ticked, version: 0 }));
    const unticked = { state: { landingFolderId: null, knownProjectKeys: [] }, version: 0 };
    backing.setItem(SIDEBAR_FOLDER_LANDING_STORAGE_KEY, JSON.stringify(unticked));
    const storage = createSidebarFoldersStorage(backing);

    await expect(storage.getItem(SIDEBAR_FOLDERS_STORAGE_KEY)).resolves.toEqual({
      state: { ...ticked, landingFolderId: null, knownProjectKeys: [] },
      version: 0,
    });
    expect(
      OlderBuildEnvelopeSchema.safeParse(stored(backing, SIDEBAR_FOLDERS_STORAGE_KEY)).success,
    ).toBe(true);
    expect(stored(backing, SIDEBAR_FOLDER_LANDING_STORAGE_KEY)).toEqual(unticked);
  });

  it("reads folders a later build stored with keys this one does not know, and keeps them", async () => {
    const backing = new MemoryStorage();
    const later = JSON.stringify({
      state: {
        folders: [{ ...folders[0], color: "teal" }],
        folderIdByProjectKey: { alma: "workers" },
        sortedBy: "name",
      },
      version: 0,
    });
    backing.setItem(SIDEBAR_FOLDERS_STORAGE_KEY, later);
    const storage = createSidebarFoldersStorage(backing);

    await expect(storage.getItem(SIDEBAR_FOLDERS_STORAGE_KEY)).resolves.toEqual({
      state: { folders, folderIdByProjectKey: { alma: "workers" } },
      version: 0,
    });
    expect(backing.getItem(SIDEBAR_FOLDERS_STORAGE_KEY)).toBe(later);
  });

  it("writes nothing while it reads, so a change before hydration keeps the stored tick", async () => {
    const backing = new MemoryStorage();
    const storage = createSidebarFoldersStorage(backing);
    await storage.setItem(SIDEBAR_FOLDERS_STORAGE_KEY, { state: ticked, version: 0 });

    const reading = storage.getItem(SIDEBAR_FOLDERS_STORAGE_KEY);
    await storage.setItem(SIDEBAR_FOLDERS_STORAGE_KEY, {
      state: { folders: [], folderIdByProjectKey: {}, landingFolderId: null, knownProjectKeys: [] },
      version: 0,
    });
    await expect(reading).resolves.toEqual({ state: ticked, version: 0 });
    await expect(storage.getItem(SIDEBAR_FOLDERS_STORAGE_KEY)).resolves.toEqual({
      state: ticked,
      version: 0,
    });
  });

  it("writes the tick when another window's read starts while the folders are written", async () => {
    const backing = new MemoryStorage();
    let finishFoldersWrite = () => {};
    let finishTickRead = () => {};
    let tickReadStarted = false;
    const slow: StateStorage = {
      getItem: (name) => {
        if (name !== SIDEBAR_FOLDER_LANDING_STORAGE_KEY) return backing.getItem(name);
        tickReadStarted = true;
        return new Promise<string | null>((resolve) => {
          finishTickRead = () => resolve(backing.getItem(name));
        });
      },
      setItem: (name, value) => {
        if (name !== SIDEBAR_FOLDERS_STORAGE_KEY) return backing.setItem(name, value);
        return new Promise<void>((resolve) => {
          finishFoldersWrite = () => {
            backing.setItem(name, value);
            resolve();
          };
        });
      },
      removeItem: (name) => backing.removeItem(name),
    };
    backing.setItem(SIDEBAR_FOLDERS_STORAGE_KEY, JSON.stringify({ state: ticked, version: 0 }));
    const storage = createSidebarFoldersStorage(slow);

    const writing = storage.setItem(SIDEBAR_FOLDERS_STORAGE_KEY, { state: ticked, version: 0 });
    // What another window's write does here: this window reads both keys again.
    const reading = storage.getItem(SIDEBAR_FOLDERS_STORAGE_KEY);
    await vi.waitFor(() => expect(tickReadStarted).toBe(true));
    finishFoldersWrite();
    await writing;
    finishTickRead();
    await reading;

    expect(stored(backing, SIDEBAR_FOLDER_LANDING_STORAGE_KEY)).toEqual({
      state: { landingFolderId: "workers", knownProjectKeys: ["alma", "chats"] },
      version: 0,
    });
  });
});
