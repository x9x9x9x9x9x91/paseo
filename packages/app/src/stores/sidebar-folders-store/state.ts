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
  /** The folder new projects go into by themselves, or null (see `landNewSidebarProjects`). */
  landingFolderId: string | null;
  /** The projects known while a landing folder is set: a project not among them is new. */
  knownProjectKeys: string[];
  /**
   * The hosts whose projects were listed while a landing folder is set, so a project on none of
   * them is not new to it (see `landNewSidebarProjects`).
   */
  knownServerIds: string[];
}

/**
 * The stored state as the store reads it back. The landing fields are optional: a state from
 * before ALM-5108 has none, and `createSidebarFoldersStorage` keeps them under a key of their own.
 */
export const PersistedSidebarFoldersSchema = z.object({
  folders: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      collapsed: z.boolean(),
    }),
  ),
  folderIdByProjectKey: z.record(z.string(), z.string()),
  landingFolderId: z.string().nullable().optional(),
  knownProjectKeys: z.array(z.string()).optional(),
  knownServerIds: z.array(z.string()).optional(),
});

export type PersistedSidebarFolders = z.infer<typeof PersistedSidebarFoldersSchema>;

/** The landing tick, stored apart from the folders (see `createSidebarFoldersStorage`). */
export const StoredSidebarLandingSchema = z.object({
  landingFolderId: z.string().nullable(),
  knownProjectKeys: z.array(z.string()),
  knownServerIds: z.array(z.string()).optional(),
});

export const EMPTY_SIDEBAR_FOLDERS: SidebarFoldersState = {
  folders: [],
  folderIdByProjectKey: {},
  landingFolderId: null,
  knownProjectKeys: [],
  knownServerIds: [],
};

/** What the landing rules need of a project: a repo goes in, a plain folder stays out. */
export interface SidebarLandingProject {
  viewKey: string;
  projectKind: string;
}

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
  return dropEmptyFolders({ ...state, folderIdByProjectKey });
}

/**
 * Puts every project that is in no folder into `folderId`, the repos only: a plain folder (a
 * project of kind `non_git` or `directory`, such as a chats folder) stays where it is, since the
 * folder is for the worker repos and the plain ones are where the chats live (ALM-5108).
 */
export function moveLooseSidebarProjectsToFolder(
  state: SidebarFoldersState,
  folderId: string,
  projects: readonly SidebarLandingProject[],
): SidebarFoldersState {
  if (!state.folders.some((folder) => folder.id === folderId)) return state;
  const moving = looseRepoKeys(state, projects);
  if (moving.length === 0) return state;
  const folderIdByProjectKey = { ...state.folderIdByProjectKey };
  for (const key of moving) folderIdByProjectKey[key] = folderId;
  return { ...state, folderIdByProjectKey };
}

/** The keys of the repos in `projects` that are in no folder, in the order given. */
export function looseRepoKeys(
  state: SidebarFoldersState,
  projects: readonly SidebarLandingProject[],
): string[] {
  const folderIds = new Set(state.folders.map((folder) => folder.id));
  return projects
    .filter((project) => project.projectKind === "git")
    .filter((project) => !folderIds.has(state.folderIdByProjectKey[project.viewKey] ?? ""))
    .map((project) => project.viewKey);
}

/** A project as listed, with the hosts it is on, for `landNewSidebarProjects`. */
export interface SidebarListedProject extends SidebarLandingProject {
  hosts: readonly { serverId: string }[];
}

/**
 * Makes `folderId` the folder new projects land in, or none with `null`; one folder at a time.
 * The projects listed now (`knownProjectKeys`) and those in a folder count as old, so only a
 * project that appears later lands (ALM-5108). `listedServerIds` are the hosts whose projects
 * are listed now; a host not among them, filtered out or offline, has its first listing taken as
 * old (ALM-5148). The project order's history is left out: a repo removed before the tick lands
 * once it is listed.
 */
export function setSidebarLandingFolder(
  state: SidebarFoldersState,
  folderId: string | null,
  knownProjectKeys: readonly string[],
  listedServerIds: readonly string[],
): SidebarFoldersState {
  if (folderId === null) {
    return state.landingFolderId === null
      ? state
      : { ...state, landingFolderId: null, knownProjectKeys: [], knownServerIds: [] };
  }
  if (!state.folders.some((folder) => folder.id === folderId)) return state;
  const known = new Set([...knownProjectKeys, ...Object.keys(state.folderIdByProjectKey)]);
  return {
    ...state,
    landingFolderId: folderId,
    knownProjectKeys: [...known],
    knownServerIds: [...new Set(listedServerIds)],
  };
}

/**
 * Lands the projects that are new since the landing folder was set: a repo goes into that
 * folder, a plain folder stays loose (see `moveLooseSidebarProjectsToFolder`), and both are
 * known from then on, so a project taken out of the folder stays out. With no landing folder,
 * or nothing new, the state is returned as it was (ALM-5108).
 *
 * Only a project on a host whose projects were listed since the tick (`knownServerIds`) is new:
 * a host filtered out or offline then was never read, so its first listing is taken as known,
 * and every host in `listedServerIds` counts as read from now on (ALM-5148). A tick stored
 * without the hosts, by a build before ALM-5148, counts none as read: a host offline then may
 * have its listing in by the first pass, so a repo made before that pass stays loose.
 */
export function landNewSidebarProjects(
  state: SidebarFoldersState,
  projects: readonly SidebarListedProject[],
  listedServerIds: readonly string[],
): SidebarFoldersState {
  const folderId = state.landingFolderId;
  if (folderId === null || !state.folders.some((folder) => folder.id === folderId)) return state;
  const readHosts = new Set(state.knownServerIds);
  const newHost = listedServerIds.some((serverId) => !readHosts.has(serverId));
  const known = new Set(state.knownProjectKeys);
  const fresh = projects.filter((project) => !known.has(project.viewKey));
  if (fresh.length === 0 && !newHost) return state;
  const landing = fresh.filter((project) =>
    project.hosts.some((host) => readHosts.has(host.serverId)),
  );
  const folderIdByProjectKey = { ...state.folderIdByProjectKey };
  for (const key of looseRepoKeys(state, landing)) folderIdByProjectKey[key] = folderId;
  for (const project of fresh) known.add(project.viewKey);
  return {
    ...state,
    folderIdByProjectKey,
    knownProjectKeys: [...known],
    knownServerIds: [...new Set([...readHosts, ...listedServerIds])],
  };
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
  return withLandingFolderInFolders({
    ...state,
    folders: state.folders.filter((folder) => folder.id !== folderId),
    folderIdByProjectKey,
  });
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

/**
 * The folds made while a project filter is on, for that filter (`filterKey`) only. They are never
 * saved: a filter shows its folders open and leaves their saved folds alone (ALM-5054).
 */
export interface SidebarFoldsUnderFilter {
  filterKey: string;
  foldedFolderIds: string[];
}

export const NO_FOLDS_UNDER_FILTER: SidebarFoldsUnderFilter = {
  filterKey: "",
  foldedFolderIds: [],
};

/** Folds or opens a folder under the filter `filterKey`; a fold under another filter is dropped. */
export function toggleSidebarFolderFoldUnderFilter(
  folds: SidebarFoldsUnderFilter,
  filterKey: string,
  folderId: string,
): SidebarFoldsUnderFilter {
  const folded = folds.filterKey === filterKey ? folds.foldedFolderIds : [];
  return {
    filterKey,
    foldedFolderIds: folded.includes(folderId)
      ? folded.filter((id) => id !== folderId)
      : [...folded, folderId],
  };
}

/** What is stored; `createSidebarFoldersStorage` writes the landing keys apart (ALM-5127). */
export function persistedSidebarFolders(state: SidebarFoldersState): PersistedSidebarFolders {
  return {
    folders: state.folders,
    folderIdByProjectKey: state.folderIdByProjectKey,
    landingFolderId: state.landingFolderId,
    knownProjectKeys: state.knownProjectKeys,
    knownServerIds: state.knownServerIds,
  };
}

/**
 * A stored state read back: a project naming a folder that is gone is loose again, and a landing
 * folder that is gone lands nothing. A state an older build stored has no landing folder.
 */
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
  return withLandingFolderInFolders({
    ...current,
    folders: result.data.folders,
    folderIdByProjectKey,
    landingFolderId: result.data.landingFolderId ?? null,
    knownProjectKeys: result.data.knownProjectKeys ?? [],
    // A tick an older build stored has no hosts; see `landNewSidebarProjects`.
    knownServerIds: result.data.knownServerIds ?? [],
  });
}

function dropEmptyFolders<S extends SidebarFoldersState>(state: S): S {
  const used = new Set(Object.values(state.folderIdByProjectKey));
  const folders = state.folders.filter((folder) => used.has(folder.id));
  return folders.length === state.folders.length
    ? state
    : withLandingFolderInFolders({ ...state, folders });
}

/** A landing folder that went (removed, or emptied) takes its tick and its known projects along. */
function withLandingFolderInFolders<S extends SidebarFoldersState>(state: S): S {
  const id = state.landingFolderId;
  if (id === null || state.folders.some((folder) => folder.id === id)) return state;
  return { ...state, landingFolderId: null, knownProjectKeys: [], knownServerIds: [] };
}
