import type { PersistStorage, StateStorage } from "zustand/middleware";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
import {
  PersistedSidebarFoldersSchema,
  StoredSidebarLandingSchema,
  type PersistedSidebarFolders,
} from "./state";

export const SIDEBAR_FOLDERS_STORAGE_KEY = "sidebar-project-folders";
export const SIDEBAR_FOLDER_LANDING_STORAGE_KEY = "sidebar-folder-landing";

/**
 * The folders' storage: the folders under the store's own key, in the shape every build reads,
 * and the landing tick under `SIDEBAR_FOLDER_LANDING_STORAGE_KEY`. Builds from before ALM-5127
 * read the folders' key with a strict schema and remove it whole at a key they do not know, so
 * the landing keys stay out of it (ALM-5127).
 *
 * The tick is written on every write, `null` when unticked, never removed: another window
 * follows a write but leaves a removed key alone (`followOtherWindowsWrites`). A tick stored in
 * the folders' key, by a build with ALM-5108 and not this (0.16.2-fork.12), still reads, and the
 * read moves it to its own key at once, so an older build opened before the next write keeps the
 * folders; a tick already in its own key wins.
 */
export function createSidebarFoldersStorage(
  backingStorage: StateStorage,
): PersistStorage<PersistedSidebarFolders> {
  const folders = createValidatedPersistStorage(backingStorage, PersistedSidebarFoldersSchema);
  const landing = createValidatedPersistStorage(backingStorage, StoredSidebarLandingSchema);
  let reading = 0;

  return {
    getItem: async (name) => {
      // A write while the two keys are read would put the defaults back over the stored tick.
      reading += 1;
      try {
        const stored = await folders.getItem(name);
        if (!stored) return null;
        const tick = await landing.getItem(SIDEBAR_FOLDER_LANDING_STORAGE_KEY);
        const { landingFolderId, knownProjectKeys, knownServerIds, ...rest } = stored.state;
        if (landingFolderId !== undefined || knownProjectKeys !== undefined) {
          // The tick's own key first, so a failed write leaves the tick where it was. A failed
          // move never fails the read: the store would start empty and write that over the folders.
          try {
            if (!tick) {
              await landing.setItem(SIDEBAR_FOLDER_LANDING_STORAGE_KEY, {
                state: {
                  landingFolderId: landingFolderId ?? null,
                  knownProjectKeys: knownProjectKeys ?? [],
                  knownServerIds: knownServerIds ?? null,
                },
                version: stored.version,
              });
            }
            await folders.setItem(name, { ...stored, state: rest });
          } catch (error) {
            console.warn("[sidebar-folders] Could not move the folder tick to its own key", error);
          }
        }
        return tick ? { ...stored, state: { ...stored.state, ...tick.state } } : stored;
      } finally {
        reading -= 1;
      }
    },
    setItem: async (name, value) => {
      if (reading > 0) return;
      const { landingFolderId, knownProjectKeys, knownServerIds, ...rest } = value.state;
      // Both start now: each skips its write while its key is read, so a read another window's
      // write starts between them would drop the tick's write alone.
      await Promise.all([
        folders.setItem(name, { ...value, state: rest }),
        landing.setItem(SIDEBAR_FOLDER_LANDING_STORAGE_KEY, {
          state: {
            landingFolderId: landingFolderId ?? null,
            knownProjectKeys: knownProjectKeys ?? [],
            knownServerIds: knownServerIds ?? null,
          },
          version: value.version,
        }),
      ]);
    },
    removeItem: async (name) => {
      await folders.removeItem(name);
      await landing.removeItem(SIDEBAR_FOLDER_LANDING_STORAGE_KEY);
    },
  };
}
