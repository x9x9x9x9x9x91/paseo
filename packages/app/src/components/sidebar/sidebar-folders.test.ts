import { describe, expect, it } from "vitest";
import {
  buildSidebarProjectListItems,
  foldersOfListItems,
  projectKeysInCollapsedFolders,
  projectKeysOfListItems,
  projectKeysWithFolderReordered,
  projectKeysWithProjectInFolder,
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

  it("offers only the folders that have a row in the list", () => {
    const items = buildSidebarProjectListItems({
      projects,
      folders: [workers, { id: "stale", name: "Stale", collapsed: true }],
      folderIdByProjectKey: { alma: "workers", removedProject: "stale" },
    });
    expect(foldersOfListItems(items).map((folder) => folder.id)).toEqual(["workers"]);
  });
});
