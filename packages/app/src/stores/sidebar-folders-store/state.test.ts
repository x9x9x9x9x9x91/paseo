import { describe, expect, it } from "vitest";
import {
  createSidebarFolder,
  EMPTY_SIDEBAR_FOLDERS,
  mergePersistedSidebarFolders,
  moveSidebarProjectToFolder,
  removeSidebarFolder,
  renameSidebarFolder,
  NO_FOLDS_UNDER_FILTER,
  toggleSidebarFolderCollapsed,
  toggleSidebarFolderFoldUnderFilter,
  type SidebarFoldersState,
} from "@/stores/sidebar-folders-store/state";

function withWorkers(): SidebarFoldersState {
  return createSidebarFolder(EMPTY_SIDEBAR_FOLDERS, {
    id: "workers",
    name: "  Workers  ",
    projectKey: "alma",
  });
}

describe("sidebar folders", () => {
  it("makes a folded folder holding the project it was made from", () => {
    const state = withWorkers();
    expect(state.folders).toEqual([{ id: "workers", name: "Workers", collapsed: true }]);
    expect(state.folderIdByProjectKey).toEqual({ alma: "workers" });
  });

  it("makes nothing from a blank name or a used id", () => {
    expect(
      createSidebarFolder(EMPTY_SIDEBAR_FOLDERS, { id: "x", name: "   ", projectKey: "alma" }),
    ).toBe(EMPTY_SIDEBAR_FOLDERS);
    const state = withWorkers();
    expect(createSidebarFolder(state, { id: "workers", name: "Again", projectKey: "crisis" })).toBe(
      state,
    );
  });

  it("moves a project between folders and drops a folder left empty", () => {
    let state = withWorkers();
    state = createSidebarFolder(state, { id: "music", name: "Music", projectKey: "night" });
    state = moveSidebarProjectToFolder(state, "substrate", "workers");
    state = moveSidebarProjectToFolder(state, "night", "workers");
    expect(state.folders.map((folder) => folder.id)).toEqual(["workers"]);
    expect(state.folderIdByProjectKey).toEqual({
      alma: "workers",
      substrate: "workers",
      night: "workers",
    });
  });

  it("takes a project out of its folder, and the last one out removes the folder", () => {
    let state = moveSidebarProjectToFolder(withWorkers(), "substrate", "workers");
    state = moveSidebarProjectToFolder(state, "alma", null);
    expect(state.folders).toHaveLength(1);
    expect(state.folderIdByProjectKey).toEqual({ substrate: "workers" });
    state = moveSidebarProjectToFolder(state, "substrate", null);
    expect(state).toEqual(EMPTY_SIDEBAR_FOLDERS);
  });

  it("ignores a move into a folder that does not exist", () => {
    const state = withWorkers();
    expect(moveSidebarProjectToFolder(state, "crisis", "gone")).toBe(state);
  });

  it("renames, folds and removes a folder, leaving its projects loose", () => {
    let state = moveSidebarProjectToFolder(withWorkers(), "substrate", "workers");
    state = renameSidebarFolder(state, "workers", " Lanes ");
    expect(renameSidebarFolder(state, "workers", "  ")).toBe(state);
    state = toggleSidebarFolderCollapsed(state, "workers");
    expect(state.folders).toEqual([{ id: "workers", name: "Lanes", collapsed: false }]);
    state = removeSidebarFolder(state, "workers");
    expect(state).toEqual(EMPTY_SIDEBAR_FOLDERS);
  });

  it("reads back what was stored, a project naming a folder that is gone loose again", () => {
    const current = { ...EMPTY_SIDEBAR_FOLDERS, extra: 1 };
    const merged = mergePersistedSidebarFolders(
      {
        folders: [{ id: "workers", name: "Workers", collapsed: true }],
        folderIdByProjectKey: { alma: "workers", crisis: "gone" },
      },
      current,
    );
    expect(merged).toEqual({
      extra: 1,
      folders: [{ id: "workers", name: "Workers", collapsed: true }],
      folderIdByProjectKey: { alma: "workers" },
    });
    expect(mergePersistedSidebarFolders({ folders: "nope" }, current)).toBe(current);
  });
});

describe("folds under a project filter", () => {
  it("folds and opens a folder under one filter", () => {
    const folded = toggleSidebarFolderFoldUnderFilter(NO_FOLDS_UNDER_FILTER, "alma", "workers");
    expect(folded).toEqual({ filterKey: "alma", foldedFolderIds: ["workers"] });
    expect(toggleSidebarFolderFoldUnderFilter(folded, "alma", "workers")).toEqual({
      filterKey: "alma",
      foldedFolderIds: [],
    });
  });

  it("drops the folds of another filter", () => {
    const folded = toggleSidebarFolderFoldUnderFilter(NO_FOLDS_UNDER_FILTER, "alma", "workers");
    expect(toggleSidebarFolderFoldUnderFilter(folded, "chats", "tools")).toEqual({
      filterKey: "chats",
      foldedFolderIds: ["tools"],
    });
  });
});
