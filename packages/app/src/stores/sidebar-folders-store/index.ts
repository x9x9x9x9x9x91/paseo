import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { followOtherWindowsWrites } from "@/storage/follow-other-windows";
import { keepStoredState } from "@/storage/validated-persist-storage";
import {
  createSidebarFolder,
  EMPTY_SIDEBAR_FOLDERS,
  landNewSidebarProjects,
  mergePersistedSidebarFolders,
  moveLooseSidebarProjectsToFolder,
  moveSidebarProjectToFolder,
  NO_FOLDS_UNDER_FILTER,
  persistedSidebarFolders,
  removeSidebarFolder,
  renameSidebarFolder,
  setSidebarLandingFolder,
  toggleSidebarFolderCollapsed,
  toggleSidebarFolderFoldUnderFilter,
  type PersistedSidebarFolders,
  type SidebarFoldersState,
  type SidebarFoldsUnderFilter,
  type SidebarLandingProject,
  type SidebarListedProject,
} from "./state";
import {
  createSidebarFoldersStorage,
  SIDEBAR_FOLDER_LANDING_STORAGE_KEY,
  SIDEBAR_FOLDERS_STORAGE_KEY,
} from "./storage";

export type {
  SidebarFolder,
  SidebarFoldersState,
  SidebarFoldsUnderFilter,
  SidebarLandingProject,
} from "./state";
export { normalizeSidebarFolderName } from "./state";

interface SidebarFoldersStore extends SidebarFoldersState {
  /** Makes a folded folder holding `projectKey` and returns its id, or null for a blank name. */
  createFolder: (name: string, projectKey: string) => string | null;
  moveProjectToFolder: (projectKey: string, folderId: string | null) => void;
  renameFolder: (folderId: string, name: string) => void;
  removeFolder: (folderId: string) => void;
  toggleFolderCollapsed: (folderId: string) => void;
  moveLooseProjectsToFolder: (folderId: string, projects: readonly SidebarLandingProject[]) => void;
  setLandingFolder: (
    folderId: string | null,
    knownProjectKeys: readonly string[],
    listedServerIds: readonly string[],
  ) => void;
  landNewProjects: (
    projects: readonly SidebarListedProject[],
    listedServerIds: readonly string[],
  ) => void;
  /** Kept in memory only, never in `partialize`: see `SidebarFoldsUnderFilter`. */
  foldsUnderFilter: SidebarFoldsUnderFilter;
  toggleFolderFoldUnderFilter: (filterKey: string, folderId: string) => void;
}

function createFolderId(): string {
  const value =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return `folder_${value}`;
}

/**
 * The sidebar's folders, kept on this device like the project folds and the project order, so
 * they survive a restart and an app update. Nothing goes to the host: a phone or another Mac
 * shows every project as before.
 */
export const useSidebarFoldersStore = create<SidebarFoldersStore>()(
  persist<SidebarFoldersStore, [], [], PersistedSidebarFolders>(
    (set, get) => ({
      ...EMPTY_SIDEBAR_FOLDERS,
      createFolder: (name, projectKey) => {
        const id = createFolderId();
        const next = createSidebarFolder(get(), { id, name, projectKey });
        if (!next.folders.some((folder) => folder.id === id)) return null;
        set(next);
        return id;
      },
      moveProjectToFolder: (projectKey, folderId) =>
        set((state) => moveSidebarProjectToFolder(state, projectKey, folderId)),
      renameFolder: (folderId, name) => set((state) => renameSidebarFolder(state, folderId, name)),
      removeFolder: (folderId) => set((state) => removeSidebarFolder(state, folderId)),
      toggleFolderCollapsed: (folderId) =>
        set((state) => toggleSidebarFolderCollapsed(state, folderId)),
      moveLooseProjectsToFolder: (folderId, projects) =>
        set((state) => moveLooseSidebarProjectsToFolder(state, folderId, projects)),
      setLandingFolder: (folderId, knownProjectKeys, listedServerIds) =>
        set((state) => setSidebarLandingFolder(state, folderId, knownProjectKeys, listedServerIds)),
      landNewProjects: (projects, listedServerIds) =>
        set((state) => landNewSidebarProjects(state, projects, listedServerIds)),
      foldsUnderFilter: NO_FOLDS_UNDER_FILTER,
      toggleFolderFoldUnderFilter: (filterKey, folderId) =>
        set((state) => ({
          foldsUnderFilter: toggleSidebarFolderFoldUnderFilter(
            state.foldsUnderFilter,
            filterKey,
            folderId,
          ),
        })),
    }),
    {
      name: SIDEBAR_FOLDERS_STORAGE_KEY,
      storage: createSidebarFoldersStorage(AsyncStorage),
      migrate: keepStoredState,
      partialize: persistedSidebarFolders,
      merge: (persistedState, currentState) =>
        mergePersistedSidebarFolders(persistedState, currentState),
    },
  ),
);

followOtherWindowsWrites(useSidebarFoldersStore);
// The landing tick has a key of its own (see `createSidebarFoldersStorage`); a read takes both.
followOtherWindowsWrites({
  persist: {
    getOptions: () => ({ name: SIDEBAR_FOLDER_LANDING_STORAGE_KEY }),
    rehydrate: () => useSidebarFoldersStore.persist.rehydrate(),
  },
});
