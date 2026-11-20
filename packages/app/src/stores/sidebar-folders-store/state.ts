import { z } from "zod";

/**
 * A folder one level above projects in the sidebar: a name, a fold, and the projects put in it.
 *
 * Membership is kept by project view key, the same key the project order and the project folds
 * use, so a project that is only offline keeps its folder. A folder holds no position of its
 * own: it sits where its first project sits in the project order (see `sidebar-folders.ts`).
 */
export interface SidebarFolder {
  id: string;
  name: string;
  collapsed: boolean;
}

export interface SidebarFoldersState {
  folders: SidebarFolder[];
  folderIdByProjectKey: Record<string, string>;
}

export const PersistedSidebarFoldersSchema: z.ZodType<SidebarFoldersState> = z.strictObject({
  folders: z.array(
    z.strictObject({
      id: z.string(),
      name: z.string(),
      collapsed: z.boolean(),
    }),
  ),
  folderIdByProjectKey: z.record(z.string(), z.string()),
});

export const EMPTY_SIDEBAR_FOLDERS: SidebarFoldersState = {
  folders: [],
  folderIdByProjectKey: {},
};

export function normalizeSidebarFolderName(name: string): string {
  return name.trim().replace(/\s+/g, " ");
}

/**
 * A new folder holding one project, folded shut: the folder exists to keep projects out of
 * sight, so the project leaves the list the moment it goes in and the folder's row takes its
 * place. A blank name makes nothing.
 */
export function createSidebarFolder(
  state: SidebarFoldersState,
  input: { id: string; name: string; projectKey: string },
): SidebarFoldersState {
  const name = normalizeSidebarFolderName(input.name);
  if (!name || state.folders.some((folder) => folder.id === input.id)) return state;
  const created = {
    ...state,
    folders: [...state.folders, { id: input.id, name, collapsed: true }],
  };
  return moveSidebarProjectToFolder(created, input.projectKey, input.id);
}

/**
 * Puts a project in a folder, or takes it out with `null`. A folder left with no project goes,
 * since it has no row of its own to remove it from.
 */
export function moveSidebarProjectToFolder(
  state: SidebarFoldersState,
  projectKey: string,
  folderId: string | null,
): SidebarFoldersState {
  if (folderId !== null && !state.folders.some((folder) => folder.id === folderId)) return state;
  const previousFolderId = state.folderIdByProjectKey[projectKey] ?? null;
  if (previousFolderId === folderId) return state;
  const folderIdByProjectKey = { ...state.folderIdByProjectKey };
  if (folderId === null) {
    delete folderIdByProjectKey[projectKey];
  } else {
    folderIdByProjectKey[projectKey] = folderId;
  }
  return dropEmptyFolders({ folders: state.folders, folderIdByProjectKey });
}

export function renameSidebarFolder(
  state: SidebarFoldersState,
  folderId: string,
  name: string,
): SidebarFoldersState {
  const normalized = normalizeSidebarFolderName(name);
  if (!normalized) return state;
  return {
    ...state,
    folders: state.folders.map((folder) =>
      folder.id === folderId ? { ...folder, name: normalized } : folder,
    ),
  };
}

/** Removes a folder; its projects stay in the list, loose, where the folder stood. */
export function removeSidebarFolder(
  state: SidebarFoldersState,
  folderId: string,
): SidebarFoldersState {
  if (!state.folders.some((folder) => folder.id === folderId)) return state;
  const folderIdByProjectKey = Object.fromEntries(
    Object.entries(state.folderIdByProjectKey).filter(([, id]) => id !== folderId),
  );
  return {
    folders: state.folders.filter((folder) => folder.id !== folderId),
    folderIdByProjectKey,
  };
}

export function toggleSidebarFolderCollapsed(
  state: SidebarFoldersState,
  folderId: string,
): SidebarFoldersState {
  return {
    ...state,
    folders: state.folders.map((folder) =>
      folder.id === folderId ? { ...folder, collapsed: !folder.collapsed } : folder,
    ),
  };
}

/** A stored state read back: a project naming a folder that is gone is loose again. */
export function mergePersistedSidebarFolders<S extends SidebarFoldersState>(
  persistedValue: unknown,
  current: S,
): S {
  const result = PersistedSidebarFoldersSchema.safeParse(persistedValue);
  if (!result.success) return current;
  const folderIds = new Set(result.data.folders.map((folder) => folder.id));
  const folderIdByProjectKey = Object.fromEntries(
    Object.entries(result.data.folderIdByProjectKey).filter(([, id]) => folderIds.has(id)),
  );
  return { ...current, folders: result.data.folders, folderIdByProjectKey };
}

function dropEmptyFolders(state: SidebarFoldersState): SidebarFoldersState {
  const used = new Set(Object.values(state.folderIdByProjectKey));
  const folders = state.folders.filter((folder) => used.has(folder.id));
  return folders.length === state.folders.length ? state : { ...state, folders };
}
