import type { SidebarFolder } from "@/stores/sidebar-folders-store";

interface ProjectLike {
  viewKey: string;
}

export type SidebarProjectListItem<P extends ProjectLike> =
  | { kind: "project"; key: string; project: P }
  | { kind: "folder"; key: string; folder: SidebarFolder; projects: P[] };

const FOLDER_ITEM_KEY_PREFIX = "sidebar-folder:";

/**
 * The project list as the sidebar shows it: each folder stands where the first of its projects
 * stands in the project order and holds all of its projects in that order; every other project
 * stays where it is. A folder none of whose projects is in the list shows nothing, so a filter
 * that hides them hides the folder too.
 */
export function buildSidebarProjectListItems<P extends ProjectLike>(input: {
  projects: readonly P[];
  folders: readonly SidebarFolder[];
  folderIdByProjectKey: Readonly<Record<string, string>>;
}): SidebarProjectListItem<P>[] {
  const folderById = new Map(input.folders.map((folder) => [folder.id, folder]));
  const membersByFolderId = new Map<string, P[]>();
  for (const project of input.projects) {
    const folderId = input.folderIdByProjectKey[project.viewKey];
    if (!folderId || !folderById.has(folderId)) continue;
    const members = membersByFolderId.get(folderId);
    if (members) members.push(project);
    else membersByFolderId.set(folderId, [project]);
  }

  const items: SidebarProjectListItem<P>[] = [];
  const placedFolderIds = new Set<string>();
  for (const project of input.projects) {
    const folderId = input.folderIdByProjectKey[project.viewKey];
    const folder = folderId ? folderById.get(folderId) : undefined;
    if (!folder) {
      items.push({ kind: "project", key: project.viewKey, project });
      continue;
    }
    if (placedFolderIds.has(folder.id)) continue;
    placedFolderIds.add(folder.id);
    items.push({
      kind: "folder",
      key: `${FOLDER_ITEM_KEY_PREFIX}${folder.id}`,
      folder,
      projects: membersByFolderId.get(folder.id) ?? [],
    });
  }
  return items;
}

/** The project order the list shows, each folder's projects in its place. */
export function projectKeysOfListItems<P extends ProjectLike>(
  items: readonly SidebarProjectListItem<P>[],
): string[] {
  return items.flatMap((item) =>
    item.kind === "project" ? [item.project.viewKey] : item.projects.map((p) => p.viewKey),
  );
}

/** The list's project order after the projects inside one folder were dragged into a new order. */
export function projectKeysWithFolderReordered<P extends ProjectLike>(
  items: readonly SidebarProjectListItem<P>[],
  folderId: string,
  reorderedMembers: readonly P[],
): string[] {
  return items.flatMap((item) => {
    if (item.kind === "project") return [item.project.viewKey];
    const members = item.folder.id === folderId ? reorderedMembers : item.projects;
    return members.map((project) => project.viewKey);
  });
}

/**
 * The list's project order once `projectKey` goes into `folderId`: after the folder's last
 * project, so the folder keeps its place and the project joins it at the end. A folder with no
 * project in the list yet (a new one) takes the project's own place, and a project already in
 * the folder stays where it is: in both the order is unchanged.
 */
export function projectKeysWithProjectInFolder(input: {
  projectKeys: readonly string[];
  folderIdByProjectKey: Readonly<Record<string, string>>;
  projectKey: string;
  folderId: string;
}): string[] {
  if (input.folderIdByProjectKey[input.projectKey] === input.folderId) {
    return [...input.projectKeys];
  }
  const rest = input.projectKeys.filter((key) => key !== input.projectKey);
  let lastMemberIndex = -1;
  rest.forEach((key, index) => {
    if (input.folderIdByProjectKey[key] === input.folderId) lastMemberIndex = index;
  });
  if (lastMemberIndex < 0) return [...input.projectKeys];
  return [
    ...rest.slice(0, lastMemberIndex + 1),
    input.projectKey,
    ...rest.slice(lastMemberIndex + 1),
  ];
}

/** The folders that have a row in the list, the only ones a project can be moved into. */
export function foldersOfListItems<P extends ProjectLike>(
  items: readonly SidebarProjectListItem<P>[],
): SidebarFolder[] {
  return items.flatMap((item) => (item.kind === "folder" ? [item.folder] : []));
}

/** Projects inside a folded folder: their workspaces are out of sight, like a folded project's. */
export function projectKeysInCollapsedFolders<P extends ProjectLike>(
  items: readonly SidebarProjectListItem<P>[],
): Set<string> {
  const keys = new Set<string>();
  for (const item of items) {
    if (item.kind !== "folder" || !item.folder.collapsed) continue;
    for (const project of item.projects) keys.add(project.viewKey);
  }
  return keys;
}
