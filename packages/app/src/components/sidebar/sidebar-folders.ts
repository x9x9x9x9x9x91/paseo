import type { SidebarFolder, SidebarFoldsUnderFilter } from "@/stores/sidebar-folders-store";
import { mergeByPosition } from "@/utils/sidebar-reorder";

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
 * The project order once `projectKey` goes into `folderId`: after the folder's last project, so
 * the folder keeps its place and the project joins it at the end. A folder with no project in the
 * order yet (a new one) takes the project's own place, and a project already in the folder stays
 * where it is: in both the order is unchanged. The sidebar gives it the whole order, not the
 * list a filter narrows, so a folder whose projects are hidden keeps its place too (ALM-5054).
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

/**
 * The project order once the projects `movingKeys` go into `folderId` together, as
 * `projectKeysWithProjectInFolder` does for one: after the folder's last project, in the order
 * they stand, so the folder keeps its place. A key the order lacks yet (a project that just
 * appeared) joins them at the end; a key already in the folder stays where it is (ALM-5108).
 * `folderIdByProjectKey` is the folders before the move.
 */
export function projectKeysWithProjectsInFolder(input: {
  projectKeys: readonly string[];
  folderIdByProjectKey: Readonly<Record<string, string>>;
  movingKeys: readonly string[];
  folderId: string;
}): string[] {
  const moving = new Set(
    input.movingKeys.filter((key) => input.folderIdByProjectKey[key] !== input.folderId),
  );
  if (moving.size === 0) return [...input.projectKeys];
  const inOrder = input.projectKeys.filter((key) => moving.has(key));
  const placed = new Set(inOrder);
  const arriving = [...inOrder, ...[...moving].filter((key) => !placed.has(key))];
  const rest = input.projectKeys.filter((key) => !moving.has(key));
  let lastMemberIndex = -1;
  rest.forEach((key, index) => {
    if (input.folderIdByProjectKey[key] === input.folderId) lastMemberIndex = index;
  });
  if (lastMemberIndex < 0) return [...rest, ...arriving];
  return [
    ...rest.slice(0, lastMemberIndex + 1),
    ...arriving,
    ...rest.slice(lastMemberIndex + 1),
  ];
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

/**
 * The whole project order once the list, which a filter may have narrowed, was put in a new order
 * (`listProjectKeys`). Each folder counts as one place, where its first project stands, holding
 * all of its projects as the list shows it. The places the list shows take its new order among
 * themselves, and every place it does not show keeps its place; inside a folder its listed
 * projects do the same around its hidden ones. So a filtered move leaves hidden projects where
 * they stand and a folder carries its hidden projects along (ALM-5054). A listed project the
 * order lacks goes just before the listed one after it (`mergeByPosition`).
 */
export function projectOrderWithListOrder(input: {
  currentOrder: readonly string[];
  listProjectKeys: readonly string[];
  folders: readonly SidebarFolder[];
  folderIdByProjectKey: Readonly<Record<string, string>>;
}): string[] {
  const placeOf = placeOfProject(input.folders, input.folderIdByProjectKey);
  const currentPlaces = groupKeysByPlace(input.currentOrder, placeOf);
  const listPlaces = groupKeysByPlace(input.listProjectKeys, placeOf);
  const placeOrder = mergeByPosition({
    currentOrder: [...currentPlaces.keys()],
    reorderedVisibleKeys: [...listPlaces.keys()],
  });
  return placeOrder.flatMap((place) => {
    const currentKeys = currentPlaces.get(place) ?? [];
    const listKeys = listPlaces.get(place);
    if (!listKeys) return currentKeys;
    return mergeByPosition({ currentOrder: currentKeys, reorderedVisibleKeys: listKeys });
  });
}

/**
 * The project order with each folder's projects side by side where its first one stands, as the
 * list shows them. A filtered list places a folder at its first listed project, so only an order
 * kept this way shows a folder in the same place with a filter on as without (ALM-5054).
 */
export function projectOrderGroupedByFolder(input: {
  order: readonly string[];
  folders: readonly SidebarFolder[];
  folderIdByProjectKey: Readonly<Record<string, string>>;
}): string[] {
  const places = groupKeysByPlace(
    input.order,
    placeOfProject(input.folders, input.folderIdByProjectKey),
  );
  return [...places.values()].flat();
}

function placeOfProject(
  folders: readonly SidebarFolder[],
  folderIdByProjectKey: Readonly<Record<string, string>>,
): (key: string) => string {
  const folderIds = new Set(folders.map((folder) => folder.id));
  return (key) => {
    const folderId = folderIdByProjectKey[key];
    return folderId && folderIds.has(folderId) ? `folder:${folderId}` : `project:${key}`;
  };
}

function groupKeysByPlace(
  keys: readonly string[],
  placeOf: (key: string) => string,
): Map<string, string[]> {
  const places = new Map<string, string[]>();
  for (const key of keys) {
    const place = placeOf(key);
    const members = places.get(place);
    if (members) members.push(key);
    else places.set(place, [key]);
  }
  return places;
}

/**
 * Which project filter is on, as one key: empty when none is. A fold made under a filter belongs
 * to that filter only.
 */
export function projectFilterKeyOf(projectFilters: readonly string[]): string {
  return [...projectFilters].sort().join("\n");
}

/**
 * The folders as the list shows them. While a project filter is on, every folder shows open, so a
 * project the filter matches inside a folded folder is in sight, unless it was folded under that
 * same filter; the saved fold is left as it is and comes back when the filter goes (ALM-5054).
 */
export function foldersAsShown(
  folders: readonly SidebarFolder[],
  projectFilterKey: string,
  foldsUnderFilter: SidebarFoldsUnderFilter,
): readonly SidebarFolder[] {
  if (!projectFilterKey) return folders;
  const folded = new Set(
    foldsUnderFilter.filterKey === projectFilterKey ? foldsUnderFilter.foldedFolderIds : [],
  );
  return folders.map((folder) =>
    folder.collapsed === folded.has(folder.id)
      ? folder
      : { ...folder, collapsed: folded.has(folder.id) },
  );
}
