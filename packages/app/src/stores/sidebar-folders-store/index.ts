import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
import {
  createSidebarFolder,
  EMPTY_SIDEBAR_FOLDERS,
  mergePersistedSidebarFolders,
  moveSidebarProjectToFolder,
  PersistedSidebarFoldersSchema,
  removeSidebarFolder,
  renameSidebarFolder,
  toggleSidebarFolderCollapsed,
  type SidebarFoldersState,
} from "./state";

export type { SidebarFolder, SidebarFoldersState } from "./state";
export { normalizeSidebarFolderName } from "./state";

interface SidebarFoldersStore extends SidebarFoldersState {
  /** Makes a folded folder holding `projectKey` and returns its id, or null for a blank name. */
  createFolder: (name: string, projectKey: string) => string | null;
  moveProjectToFolder: (projectKey: string, folderId: string | null) => void;
  renameFolder: (folderId: string, name: string) => void;
  removeFolder: (folderId: string) => void;
  toggleFolderCollapsed: (folderId: string) => void;
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
  persist<SidebarFoldersStore, [], [], SidebarFoldersState>(
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
    }),
    {
      name: "sidebar-project-folders",
      storage: createValidatedPersistStorage(AsyncStorage, PersistedSidebarFoldersSchema),
      partialize: (state) => ({
        folders: state.folders,
        folderIdByProjectKey: state.folderIdByProjectKey,
      }),
      merge: (persistedState, currentState) =>
        mergePersistedSidebarFolders(persistedState, currentState),
    },
  ),
);
