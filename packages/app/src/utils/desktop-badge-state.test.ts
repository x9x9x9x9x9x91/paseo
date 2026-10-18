import { describe, expect, it } from "vitest";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import {
  createMacDockBadgeCountSelector,
  isWorkspaceActionableForDesktopBadge,
  selectMacDockBadgeCount,
} from "./desktop-badge-state";
import { DEFAULT_ATTENTION_PROJECTS } from "./attention-projects";

function workspace(
  id: string,
  status: WorkspaceDescriptor["status"],
  projectId = "project-1",
): WorkspaceDescriptor {
  return {
    createdAt: null,
    lastUserMessageAt: null,
    id,
    projectId,
    projectDisplayName: "Project 1",
    projectRootPath: "/repo",
    workspaceDirectory: "/repo",
    projectKind: "git",
    workspaceKind: "local_checkout",
    name: id,
    status,
    archivingAt: null,
    statusEnteredAt: null,
    diffStat: null,
    scripts: [],
  };
}

function stateWith(...workspaces: WorkspaceDescriptor[]) {
  return {
    sessions: {
      srv_a: { workspaces: new Map(workspaces.map((entry) => [entry.id, entry])) },
    },
  };
}

describe("desktop-badge-state", () => {
  it("treats attention-requiring workspace statuses as actionable", () => {
    expect(isWorkspaceActionableForDesktopBadge("attention")).toBe(true);
    expect(isWorkspaceActionableForDesktopBadge("needs_input")).toBe(true);
    expect(isWorkspaceActionableForDesktopBadge("failed")).toBe(true);
  });

  it("ignores running and done workspace statuses", () => {
    expect(isWorkspaceActionableForDesktopBadge("running")).toBe(false);
    expect(isWorkspaceActionableForDesktopBadge("done")).toBe(false);
  });

  it("returns undefined when no visible workspaces need attention", () => {
    expect(
      selectMacDockBadgeCount(stateWith(workspace("a", "done"), workspace("b", "running")), {
        attentionProjects: DEFAULT_ATTENTION_PROJECTS,
      }),
    ).toBeUndefined();
  });

  it("counts only actionable visible workspaces across every host", () => {
    const state = {
      sessions: {
        srv_a: {
          workspaces: new Map([
            ["a", workspace("a", "done")],
            ["b", workspace("b", "attention")],
          ]),
        },
        srv_b: {
          workspaces: new Map([
            ["c", workspace("c", "running")],
            ["d", workspace("d", "needs_input")],
            ["e", workspace("e", "failed")],
          ]),
        },
      },
    };
    expect(selectMacDockBadgeCount(state, { attentionProjects: DEFAULT_ATTENTION_PROJECTS })).toBe(
      3,
    );
  });

  it("counts only workspaces of the chosen projects", () => {
    const state = stateWith(
      workspace("chat-a", "attention", "prj_chats"),
      workspace("chat-b", "done", "prj_chats"),
      workspace("chat-c", "needs_input", "prj_chats"),
      workspace("build", "attention", "prj_builds"),
      workspace("added-later", "failed", "prj_added_later"),
    );

    expect(selectMacDockBadgeCount(state, { attentionProjects: DEFAULT_ATTENTION_PROJECTS })).toBe(
      4,
    );
    expect(
      selectMacDockBadgeCount(state, {
        attentionProjects: { scope: "chosen", projectIds: ["prj_chats", "prj_removed"] },
      }),
    ).toBe(2);
    expect(
      selectMacDockBadgeCount(state, { attentionProjects: { scope: "chosen", projectIds: [] } }),
    ).toBeUndefined();
  });

  it("leaves out background workspaces, which the sidebar hides", () => {
    const hidden = { ...workspace("a", "attention"), background: true };
    expect(selectMacDockBadgeCount(stateWith(hidden))).toBeUndefined();
    expect(selectMacDockBadgeCount(stateWith(hidden, workspace("b", "failed")))).toBe(1);
  });

  it("counts background workspaces while Show background puts them in the sidebar", () => {
    const hidden = { ...workspace("a", "attention"), background: true };
    expect(selectMacDockBadgeCount(stateWith(hidden), { showBackground: true })).toBe(1);
    expect(createMacDockBadgeCountSelector({ showBackground: true })(stateWith(hidden))).toBe(1);
  });

  it("recounts only when a workspace map is replaced", () => {
    const select = createMacDockBadgeCountSelector({
      attentionProjects: DEFAULT_ATTENTION_PROJECTS,
    });
    const state = stateWith(workspace("a", "attention"));
    expect(select(state)).toBe(1);

    state.sessions.srv_a.workspaces.set("b", workspace("b", "failed"));
    expect(select({ sessions: { ...state.sessions } })).toBe(1);

    expect(select(stateWith(workspace("a", "attention"), workspace("b", "failed")))).toBe(2);
  });
});
