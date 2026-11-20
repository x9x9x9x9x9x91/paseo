import { describe, expect, it } from "vitest";
import {
  createSidebarFolder,
  EMPTY_SIDEBAR_FOLDERS,
  landNewSidebarProjects,
  mergePersistedSidebarFolders,
  moveLooseSidebarProjectsToFolder,
  moveSidebarProjectToFolder,
  removeSidebarFolder,
  renameSidebarFolder,
  NO_FOLDS_UNDER_FILTER,
  persistedSidebarFolders,
  setSidebarLandingFolder,
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
      landingFolderId: null,
      knownProjectKeys: [],
      knownServerIds: [],
    });
    expect(mergePersistedSidebarFolders({ folders: "nope" }, current)).toBe(current);
  });
});

const repo = (viewKey: string, serverIds = ["mac"]) => ({
  viewKey,
  projectKind: "git",
  hosts: serverIds.map((serverId) => ({ serverId })),
});
const plain = (viewKey: string) => ({
  viewKey,
  projectKind: "non_git",
  hosts: [{ serverId: "mac" }],
});

describe("filling a folder and landing new projects (ALM-5108)", () => {
  it("moves every loose repo into the folder and leaves plain folders and other folders' alone", () => {
    let state = createSidebarFolder(withWorkers(), {
      id: "music",
      name: "Music",
      projectKey: "night",
    });
    state = moveLooseSidebarProjectsToFolder(state, "workers", [
      plain("0sin-chats"),
      repo("alma"),
      repo("substrate"),
      repo("night"),
      { viewKey: "notes", projectKind: "directory" },
      repo("crisis"),
    ]);
    expect(state.folderIdByProjectKey).toEqual({
      alma: "workers",
      night: "music",
      substrate: "workers",
      crisis: "workers",
    });
    expect(moveLooseSidebarProjectsToFolder(state, "workers", [repo("alma")])).toBe(state);
    expect(moveLooseSidebarProjectsToFolder(state, "gone", [repo("cleanlane")])).toBe(state);
  });

  it("lands only a project that appears after the tick, a repo in the folder, a plain one loose", () => {
    let state = setSidebarLandingFolder(
      withWorkers(),
      "workers",
      ["0sin-chats", "substrate"],
      ["mac"],
    );
    expect(state.landingFolderId).toBe("workers");
    expect(state.knownProjectKeys).toEqual(["0sin-chats", "substrate", "alma"]);
    state = landNewSidebarProjects(
      state,
      [plain("0sin-chats"), repo("substrate"), repo("alma"), repo("crisis"), plain("new-chats")],
      ["mac"],
    );
    expect(state.folderIdByProjectKey).toEqual({ alma: "workers", crisis: "workers" });
    expect(state.knownProjectKeys).toEqual([
      "0sin-chats",
      "substrate",
      "alma",
      "crisis",
      "new-chats",
    ]);
    const again = landNewSidebarProjects(state, [repo("crisis"), plain("new-chats")], ["mac"]);
    expect(again).toBe(state);
  });

  it("takes the first listing of a host not listed at the tick as known, and lands what comes later (ALM-5148)", () => {
    // The tick: "mac" listed, "studio" filtered out or offline.
    let state = setSidebarLandingFolder(withWorkers(), "workers", ["substrate"], ["mac"]);
    state = landNewSidebarProjects(
      state,
      [repo("substrate"), repo("old-loose", ["studio"]), repo("crisis", ["studio", "mac"])],
      ["mac", "studio"],
    );
    // A repo on "studio" alone was there before; one that is new on "mac" too lands.
    expect(state.folderIdByProjectKey).toEqual({ alma: "workers", crisis: "workers" });
    expect(state.knownProjectKeys).toEqual(["substrate", "alma", "old-loose", "crisis"]);
    expect(state.knownServerIds).toEqual(["mac", "studio"]);
    state = landNewSidebarProjects(
      state,
      [repo("substrate"), repo("old-loose", ["studio"]), repo("fresh", ["studio"])],
      ["mac", "studio"],
    );
    expect(state.folderIdByProjectKey).toEqual({
      alma: "workers",
      crisis: "workers",
      fresh: "workers",
    });
  });

  it("lands nothing of a host's cached listing before the host lists its projects itself (ALM-5148)", () => {
    let state = setSidebarLandingFolder(withWorkers(), "workers", [], ["mac"]);
    // "studio" shows its cached projects; it has not listed them itself yet.
    state = landNewSidebarProjects(state, [repo("cached", ["studio"])], ["mac"]);
    expect(state.folderIdByProjectKey).toEqual({ alma: "workers" });
    expect(state.knownServerIds).toEqual(["mac"]);
    state = landNewSidebarProjects(
      state,
      [repo("cached", ["studio"]), repo("made-offline", ["studio"])],
      ["mac", "studio"],
    );
    expect(state.folderIdByProjectKey).toEqual({ alma: "workers" });
    const unchanged = landNewSidebarProjects(
      state,
      [repo("cached", ["studio"])],
      ["mac", "studio"],
    );
    expect(unchanged).toBe(state);
  });

  it("takes no host as listed at a tick stored without hosts (ALM-5148)", () => {
    const folders = [{ id: "workers", name: "Workers", collapsed: true }];
    let state = mergePersistedSidebarFolders(
      {
        folders,
        folderIdByProjectKey: { alma: "workers" },
        landingFolderId: "workers",
        knownProjectKeys: ["alma"],
      },
      EMPTY_SIDEBAR_FOLDERS,
    );
    // The first pass may come once a host offline at the tick has its listing in.
    state = landNewSidebarProjects(
      state,
      [repo("alma"), repo("old-loose", ["studio"])],
      ["studio"],
    );
    expect(state.folderIdByProjectKey).toEqual({ alma: "workers" });
    expect(state.knownServerIds).toEqual(["studio"]);
    state = landNewSidebarProjects(
      state,
      [repo("alma"), repo("old-loose", ["studio"]), repo("crisis", ["studio"])],
      ["mac", "studio"],
    );
    expect(state.folderIdByProjectKey).toEqual({ alma: "workers", crisis: "workers" });
  });

  it("keeps a landed project out once it was taken out", () => {
    let state = setSidebarLandingFolder(withWorkers(), "workers", [], ["mac"]);
    state = landNewSidebarProjects(state, [repo("crisis")], ["mac"]);
    state = moveSidebarProjectToFolder(state, "crisis", null);
    expect(landNewSidebarProjects(state, [repo("crisis")], ["mac"])).toBe(state);
    expect(state.folderIdByProjectKey).toEqual({ alma: "workers" });
  });

  it("lands nothing with no tick, and moves the tick to one folder at a time", () => {
    const loose = withWorkers();
    expect(landNewSidebarProjects(loose, [repo("crisis")], ["mac"])).toBe(loose);
    let state = createSidebarFolder(loose, { id: "music", name: "Music", projectKey: "night" });
    state = setSidebarLandingFolder(state, "workers", [], ["mac"]);
    state = setSidebarLandingFolder(state, "music", ["crisis"], ["mac"]);
    expect(state.landingFolderId).toBe("music");
    expect(state.knownProjectKeys).toEqual(["crisis", "alma", "night"]);
    state = setSidebarLandingFolder(state, null, [], []);
    expect(state.landingFolderId).toBeNull();
    expect(state.knownProjectKeys).toEqual([]);
    expect(setSidebarLandingFolder(state, "gone", [], ["mac"])).toBe(state);
  });

  it("drops the tick with its folder, removed or emptied", () => {
    const ticked = setSidebarLandingFolder(withWorkers(), "workers", ["crisis"], ["mac"]);
    expect(removeSidebarFolder(ticked, "workers")).toEqual(EMPTY_SIDEBAR_FOLDERS);
    expect(moveSidebarProjectToFolder(ticked, "alma", null)).toEqual(EMPTY_SIDEBAR_FOLDERS);
  });

  it("stores the folders and the tick, unticked as none", () => {
    const loose = withWorkers();
    expect(persistedSidebarFolders(loose)).toEqual({
      folders: loose.folders,
      folderIdByProjectKey: loose.folderIdByProjectKey,
      landingFolderId: null,
      knownProjectKeys: [],
      knownServerIds: [],
    });
    const ticked = setSidebarLandingFolder(loose, "workers", ["chats"], ["mac"]);
    expect(persistedSidebarFolders(ticked)).toEqual({
      folders: loose.folders,
      folderIdByProjectKey: loose.folderIdByProjectKey,
      landingFolderId: "workers",
      knownProjectKeys: ["chats", "alma"],
      knownServerIds: ["mac"],
    });
  });

  it("reads back a stored tick, and none for a folder that is gone or an older build's state", () => {
    const folders = [{ id: "workers", name: "Workers", collapsed: true }];
    const stored = mergePersistedSidebarFolders(
      {
        folders,
        folderIdByProjectKey: { alma: "workers" },
        landingFolderId: "workers",
        knownProjectKeys: ["alma", "chats"],
        knownServerIds: ["mac"],
      },
      EMPTY_SIDEBAR_FOLDERS,
    );
    expect(stored.landingFolderId).toBe("workers");
    expect(stored.knownProjectKeys).toEqual(["alma", "chats"]);
    expect(stored.knownServerIds).toEqual(["mac"]);
    const withoutHosts = mergePersistedSidebarFolders(
      { folders, folderIdByProjectKey: {}, landingFolderId: "workers", knownProjectKeys: [] },
      EMPTY_SIDEBAR_FOLDERS,
    );
    expect(withoutHosts.knownServerIds).toEqual([]);
    const gone = mergePersistedSidebarFolders(
      { folders, folderIdByProjectKey: {}, landingFolderId: "music", knownProjectKeys: ["x"] },
      EMPTY_SIDEBAR_FOLDERS,
    );
    expect(gone.landingFolderId).toBeNull();
    expect(gone.knownProjectKeys).toEqual([]);
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
