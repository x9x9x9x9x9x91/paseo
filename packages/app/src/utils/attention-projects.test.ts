import { describe, expect, it } from "vitest";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import type { ProjectSummary } from "@/utils/projects";
import {
  AttentionProjectsSchema,
  DEFAULT_ATTENTION_PROJECTS,
  buildAttentionProjectRows,
  isProjectCountedForAttention,
  isWorkspaceCountedForAttention,
  setProjectCountedForAttention,
  type AttentionProjects,
} from "./attention-projects";

const CHATS = "prj_chats";
const BUILDS = "prj_builds";

const chosenChats: AttentionProjects = { scope: "chosen", projectIds: [CHATS] };

function workspace(id: string, projectId: string): WorkspaceDescriptor {
  return {
    id,
    projectId,
    projectDisplayName: projectId,
    projectRootPath: "/repo",
    workspaceDirectory: "/repo",
    projectKind: "git",
    workspaceKind: "local_checkout",
    name: "main",
    status: "attention",
    statusEnteredAt: null,
    archivingAt: null,
    diffStat: null,
    scripts: [],
  };
}

function workspaceMap(entries: [string, string][]): Map<string, WorkspaceDescriptor> {
  return new Map(entries.map(([id, projectId]) => [id, workspace(id, projectId)]));
}

function project(
  name: string,
  hosts: { serverId: string; serverName: string; projectId: string; projectName?: string }[],
): ProjectSummary {
  return {
    viewKey: name,
    projectName: name,
    hosts: hosts.map((host) => ({
      ...host,
      projectName: host.projectName ?? name,
      projectCustomName: null,
      isOnline: true,
      repoRoot: `/${name}`,
      workspaceCount: 0,
      workspaces: [],
    })),
    totalWorkspaceCount: 0,
    hostCount: hosts.length,
    onlineHostCount: hosts.length,
  };
}

describe("isProjectCountedForAttention", () => {
  it("counts every project by default", () => {
    expect(isProjectCountedForAttention(DEFAULT_ATTENTION_PROJECTS, CHATS)).toBe(true);
    expect(isProjectCountedForAttention(DEFAULT_ATTENTION_PROJECTS, BUILDS)).toBe(true);
  });

  it("counts only the chosen projects", () => {
    expect(isProjectCountedForAttention(chosenChats, CHATS)).toBe(true);
    expect(isProjectCountedForAttention(chosenChats, BUILDS)).toBe(false);
  });

  it("leaves a project added after the choice out", () => {
    expect(isProjectCountedForAttention(chosenChats, "prj_added_later")).toBe(false);
  });

  it("ignores a chosen project that no longer exists", () => {
    const withRemoved: AttentionProjects = { scope: "chosen", projectIds: ["prj_removed"] };
    expect(isProjectCountedForAttention(withRemoved, CHATS)).toBe(false);
    expect(isProjectCountedForAttention(withRemoved, null)).toBe(false);
  });

  it("keeps the list when the scope goes back to every project", () => {
    const backToAll: AttentionProjects = { scope: "all", projectIds: [CHATS] };
    expect(isProjectCountedForAttention(backToAll, BUILDS)).toBe(true);
  });
});

describe("isWorkspaceCountedForAttention (OS banners)", () => {
  const workspaces = workspaceMap([
    ["ws-chat", CHATS],
    ["ws-build", BUILDS],
  ]);

  it("raises a banner for every workspace by default, found or not", () => {
    for (const workspaceId of ["ws-chat", "ws-build", "ws-unknown", undefined]) {
      expect(
        isWorkspaceCountedForAttention({
          preference: DEFAULT_ATTENTION_PROJECTS,
          workspaces,
          workspaceId,
        }),
      ).toBe(true);
    }
  });

  it("raises a banner only for a workspace of a chosen project", () => {
    expect(
      isWorkspaceCountedForAttention({
        preference: chosenChats,
        workspaces,
        workspaceId: "ws-chat",
      }),
    ).toBe(true);
    expect(
      isWorkspaceCountedForAttention({
        preference: chosenChats,
        workspaces,
        workspaceId: "ws-build",
      }),
    ).toBe(false);
  });

  it("matches a workspace id the way the session store keys it", () => {
    expect(
      isWorkspaceCountedForAttention({
        preference: chosenChats,
        workspaces,
        workspaceId: " ws-chat ",
      }),
    ).toBe(true);
  });

  it("keeps quiet under chosen projects when the workspace is unknown", () => {
    for (const workspaceId of ["ws-unknown", null, undefined]) {
      expect(
        isWorkspaceCountedForAttention({ preference: chosenChats, workspaces, workspaceId }),
      ).toBe(false);
    }
    expect(
      isWorkspaceCountedForAttention({
        preference: chosenChats,
        workspaces: undefined,
        workspaceId: "ws-chat",
      }),
    ).toBe(false);
  });

  it("keeps quiet for a workspace of a project added after the choice", () => {
    const withNewProject = workspaceMap([["ws-new", "prj_added_later"]]);
    expect(
      isWorkspaceCountedForAttention({
        preference: chosenChats,
        workspaces: withNewProject,
        workspaceId: "ws-new",
      }),
    ).toBe(false);
  });
});

describe("setProjectCountedForAttention", () => {
  it("adds and removes a project without duplicating it", () => {
    const added = setProjectCountedForAttention(chosenChats, BUILDS, true);
    expect(added.projectIds).toEqual([CHATS, BUILDS]);
    expect(setProjectCountedForAttention(added, BUILDS, true).projectIds).toEqual([CHATS, BUILDS]);
    expect(setProjectCountedForAttention(added, CHATS, false)).toEqual({
      scope: "chosen",
      projectIds: [BUILDS],
    });
  });
});

describe("buildAttentionProjectRows", () => {
  const sin0 = { serverId: "srv-sin0", serverName: "sin0" };

  it("lists each known project by its sidebar name, a new one switched off", () => {
    const rows = buildAttentionProjectRows(
      [
        project("Chats", [{ ...sin0, projectId: CHATS }]),
        project("substrate", [{ ...sin0, projectId: "prj_added_later" }]),
      ],
      chosenChats,
    );
    expect(rows).toEqual([
      { projectId: CHATS, name: "Chats", hostName: null, counted: true },
      { projectId: "prj_added_later", name: "substrate", hostName: null, counted: false },
    ]);
  });

  it("gives a chosen project that no longer exists no row", () => {
    const rows = buildAttentionProjectRows([project("Chats", [{ ...sin0, projectId: CHATS }])], {
      scope: "chosen",
      projectIds: ["prj_removed", CHATS],
    });
    expect(rows.map((row) => row.projectId)).toEqual([CHATS]);
  });

  it("names each host's project its own way, and the host only across hosts", () => {
    const rows = buildAttentionProjectRows(
      [
        project("paseo", [
          { ...sin0, projectId: "prj_paseo_sin0" },
          {
            serverId: "srv-sincoder",
            serverName: "sincoder",
            projectId: "prj_paseo_sincoder",
            projectName: "paseo fork",
          },
        ]),
      ],
      { scope: "chosen", projectIds: ["prj_paseo_sin0"] },
    );
    expect(rows).toEqual([
      { projectId: "prj_paseo_sin0", name: "paseo", hostName: "sin0", counted: true },
      {
        projectId: "prj_paseo_sincoder",
        name: "paseo fork",
        hostName: "sincoder",
        counted: false,
      },
    ]);
  });
});

describe("AttentionProjectsSchema", () => {
  it("falls back to every project on a malformed value", () => {
    expect(AttentionProjectsSchema.parse(undefined)).toEqual(DEFAULT_ATTENTION_PROJECTS);
    expect(AttentionProjectsSchema.parse({ scope: "some", projectIds: [CHATS] })).toEqual({
      scope: "all",
      projectIds: [CHATS],
    });
    expect(AttentionProjectsSchema.parse({ scope: "chosen", projectIds: "Chats" })).toEqual({
      scope: "chosen",
      projectIds: [],
    });
  });
});
