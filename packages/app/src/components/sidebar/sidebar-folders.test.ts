import { describe, expect, it } from "vitest";
import {
  buildSidebarProjectListItems,
  foldersAsShown,
  projectFilterKeyOf,
  projectKeysInCollapsedFolders,
  projectKeysOfListItems,
  projectKeysWithFolderReordered,
  projectKeysWithProjectInFolder,
  projectKeysWithProjectsInFolder,
  projectOrderGroupedByFolder,
  projectOrderWithListOrder,
} from "./sidebar-folders";

const projects = ["chats", "alma", "substrate", "cleanlane", "crisis"].map((viewKey) => ({
  viewKey,
}));
const workers = { id: "workers", name: "Workers", collapsed: true };

function describeItems(
  items: ReturnType<typeof buildSidebarProjectListItems<{ viewKey: string }>>,
) {
  return items.map((item) =>
    item.kind === "project"
      ? item.project.viewKey
      : `${item.folder.name}[${item.projects.map((p) => p.viewKey).join(",")}]`,
  );
}

describe("sidebar folders in the project list", () => {
  it("puts a folder where its first project stands, holding all of its projects", () => {
    const items = buildSidebarProjectListItems({
      projects,
      folders: [workers],
      folderIdByProjectKey: { substrate: "workers", alma: "workers", crisis: "workers" },
    });
    expect(describeItems(items)).toEqual(["chats", "Workers[alma,substrate,crisis]", "cleanlane"]);
    expect(projectKeysOfListItems(items)).toEqual([
      "chats",
      "alma",
      "substrate",
      "crisis",
      "cleanlane",
    ]);
    expect([...projectKeysInCollapsedFolders(items)]).toEqual(["alma", "substrate", "crisis"]);
  });

  it("leaves the list as it is with no folders, or with a folder that is gone", () => {
    const items = buildSidebarProjectListItems({
      projects,
      folders: [],
      folderIdByProjectKey: { alma: "gone" },
    });
    expect(describeItems(items)).toEqual(["chats", "alma", "substrate", "cleanlane", "crisis"]);
  });

  it("shows no folder none of whose projects is in the list", () => {
    const items = buildSidebarProjectListItems({
      projects: projects.filter((project) => project.viewKey === "chats"),
      folders: [workers],
      folderIdByProjectKey: { alma: "workers" },
    });
    expect(describeItems(items)).toEqual(["chats"]);
  });

  it("counts an open folder's projects as shown", () => {
    const items = buildSidebarProjectListItems({
      projects,
      folders: [{ ...workers, collapsed: false }],
      folderIdByProjectKey: { alma: "workers" },
    });
    expect(projectKeysInCollapsedFolders(items).size).toBe(0);
  });

  it("orders the list after the projects inside a folder were dragged", () => {
    const items = buildSidebarProjectListItems({
      projects,
      folders: [workers],
      folderIdByProjectKey: { alma: "workers", substrate: "workers" },
    });
    expect(
      projectKeysWithFolderReordered(items, "workers", [
        { viewKey: "substrate" },
        { viewKey: "alma" },
      ]),
    ).toEqual(["chats", "substrate", "alma", "cleanlane", "crisis"]);
  });

  it("puts a project going into a folder after the folder's last project", () => {
    expect(
      projectKeysWithProjectInFolder({
        projectKeys: ["chats", "alma", "substrate", "cleanlane", "crisis"],
        folderIdByProjectKey: { alma: "workers", substrate: "workers" },
        projectKey: "crisis",
        folderId: "workers",
      }),
    ).toEqual(["chats", "alma", "substrate", "crisis", "cleanlane"]);
    expect(
      projectKeysWithProjectInFolder({
        projectKeys: ["crisis", "chats", "alma"],
        folderIdByProjectKey: { alma: "workers" },
        projectKey: "crisis",
        folderId: "workers",
      }),
    ).toEqual(["chats", "alma", "crisis"]);
  });

  it("keeps the order for a folder with no project in the list yet", () => {
    expect(
      projectKeysWithProjectInFolder({
        projectKeys: ["chats", "alma"],
        folderIdByProjectKey: { alma: "new" },
        projectKey: "alma",
        folderId: "new",
      }),
    ).toEqual(["chats", "alma"]);
  });

  it("keeps the order when a project is put in the folder it is already in", () => {
    expect(
      projectKeysWithProjectInFolder({
        projectKeys: ["chats", "alma", "substrate", "cleanlane"],
        folderIdByProjectKey: { alma: "workers", substrate: "workers", cleanlane: "workers" },
        projectKey: "alma",
        folderId: "workers",
      }),
    ).toEqual(["chats", "alma", "substrate", "cleanlane"]);
  });
});

describe("several projects going into a folder at once (ALM-5108)", () => {
  it("puts them after the folder's last project in the order they stood", () => {
    expect(
      projectKeysWithProjectsInFolder({
        projectKeys: ["crisis", "chats", "alma", "substrate", "notes", "cleanlane"],
        folderIdByProjectKey: { alma: "workers" },
        movingKeys: ["cleanlane", "crisis", "substrate"],
        folderId: "workers",
      }),
    ).toEqual(["chats", "alma", "crisis", "substrate", "cleanlane", "notes"]);
  });

  it("brings a project the order lacks yet to the folder, and leaves members where they are", () => {
    expect(
      projectKeysWithProjectsInFolder({
        projectKeys: ["chats", "alma", "substrate", "notes"],
        folderIdByProjectKey: { alma: "workers", substrate: "workers" },
        movingKeys: ["fresh", "alma"],
        folderId: "workers",
      }),
    ).toEqual(["chats", "alma", "substrate", "fresh", "notes"]);
    expect(
      projectKeysWithProjectsInFolder({
        projectKeys: ["chats", "alma"],
        folderIdByProjectKey: { alma: "workers" },
        movingKeys: ["alma"],
        folderId: "workers",
      }),
    ).toEqual(["chats", "alma"]);
  });
});

describe("a filtered move in the project order", () => {
  const folders = [workers];

  it("leaves the projects the filter hides where they stand", () => {
    expect(
      projectOrderWithListOrder({
        currentOrder: ["chats", "alma", "substrate", "cleanlane", "crisis"],
        listProjectKeys: ["cleanlane", "chats"],
        folders,
        folderIdByProjectKey: {},
      }),
    ).toEqual(["cleanlane", "alma", "substrate", "chats", "crisis"]);
  });

  it("moves a folder with its hidden projects", () => {
    // Workers holds alma (hidden) and substrate (listed); the filter shows substrate and crisis.
    expect(
      projectOrderWithListOrder({
        currentOrder: ["alma", "chats", "substrate", "crisis", "cleanlane"],
        listProjectKeys: ["crisis", "substrate"],
        folders,
        folderIdByProjectKey: { alma: "workers", substrate: "workers" },
      }),
    ).toEqual(["crisis", "chats", "alma", "substrate", "cleanlane"]);
  });

  it("keeps a folder's hidden projects at its place when nothing moved", () => {
    // What removing the folder writes first: its projects stay where it stood, not at the end.
    expect(
      projectOrderWithListOrder({
        currentOrder: ["chats", "alma", "substrate", "cleanlane", "crisis"],
        listProjectKeys: ["chats", "substrate", "cleanlane"],
        folders,
        folderIdByProjectKey: { alma: "workers", substrate: "workers" },
      }),
    ).toEqual(["chats", "alma", "substrate", "cleanlane", "crisis"]);
  });

  it("keeps a folder's hidden project in its place inside the folder", () => {
    expect(
      projectOrderWithListOrder({
        currentOrder: ["chats", "alma", "substrate", "crisis"],
        listProjectKeys: ["chats", "crisis", "alma"],
        folders,
        folderIdByProjectKey: { alma: "workers", substrate: "workers", crisis: "workers" },
      }),
    ).toEqual(["chats", "crisis", "substrate", "alma"]);
  });

  it("counts a project in a folder that is gone as loose", () => {
    expect(
      projectOrderWithListOrder({
        currentOrder: ["alma", "chats", "substrate"],
        listProjectKeys: ["substrate", "alma"],
        folders,
        folderIdByProjectKey: { alma: "gone", substrate: "gone" },
      }),
    ).toEqual(["substrate", "chats", "alma"]);
  });

  it("puts a listed project the order lacks at the end", () => {
    expect(
      projectOrderWithListOrder({
        currentOrder: ["chats", "alma"],
        listProjectKeys: ["alma", "fresh"],
        folders,
        folderIdByProjectKey: {},
      }),
    ).toEqual(["chats", "alma", "fresh"]);
  });
});

describe("an order grouped by folder", () => {
  it("puts a folder's projects side by side where its first one stands", () => {
    // Taking substrate out of the middle of Workers leaves alma, substrate, crisis in the order.
    expect(
      projectOrderGroupedByFolder({
        order: ["chats", "alma", "substrate", "crisis", "cleanlane"],
        folders: [workers],
        folderIdByProjectKey: { alma: "workers", crisis: "workers" },
      }),
    ).toEqual(["chats", "alma", "crisis", "substrate", "cleanlane"]);
  });
});

describe("folders under a project filter", () => {
  const open = { id: "open", name: "Open", collapsed: false };

  it("shows the saved folds when no filter is on", () => {
    const folders = [workers, open];
    expect(foldersAsShown(folders, "", { filterKey: "", foldedFolderIds: ["open"] })).toBe(folders);
  });

  it("shows every folder open under a filter, the saved fold untouched", () => {
    const shown = foldersAsShown([workers, open], projectFilterKeyOf(["alma"]), {
      filterKey: "",
      foldedFolderIds: [],
    });
    expect(shown.map((folder) => folder.collapsed)).toEqual([false, false]);
    expect(workers.collapsed).toBe(true);
  });

  it("shows a folder folded under the same filter folded, and only under it", () => {
    const folds = { filterKey: projectFilterKeyOf(["alma", "chats"]), foldedFolderIds: ["open"] };
    expect(
      foldersAsShown([workers, open], projectFilterKeyOf(["chats", "alma"]), folds).map(
        (folder) => folder.collapsed,
      ),
    ).toEqual([false, true]);
    expect(
      foldersAsShown([workers, open], projectFilterKeyOf(["alma"]), folds).map(
        (folder) => folder.collapsed,
      ),
    ).toEqual([false, false]);
  });

  it("lists a project the filter matches inside a folded folder", () => {
    const items = buildSidebarProjectListItems({
      projects: [{ viewKey: "alma" }],
      folders: foldersAsShown([workers], projectFilterKeyOf(["alma"]), {
        filterKey: "",
        foldedFolderIds: [],
      }),
      folderIdByProjectKey: { alma: "workers" },
    });
    expect(projectKeysInCollapsedFolders(items).size).toBe(0);
  });
});
