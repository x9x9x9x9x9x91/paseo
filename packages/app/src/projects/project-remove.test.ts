import { describe, expect, it } from "vitest";
import {
  getCurrentProjectRemoveReadiness,
  getProjectRemoveReadiness,
  removeProjectFromHosts,
  type ProjectRemoveProject,
} from "./project-remove";

const project: ProjectRemoveProject = {
  hosts: [
    { serverId: "host-a", projectId: "prj_host_a" },
    { serverId: "host-b", projectId: "prj_host_b" },
  ],
};

function createProjectRemoveClient() {
  const removedProjectKeys: string[] = [];
  return {
    removedProjectKeys,
    client: {
      async removeProject(projectKey: string): Promise<{ removedWorkspaceIds: string[] }> {
        removedProjectKeys.push(projectKey);
        return { removedWorkspaceIds: [] };
      },
    },
  };
}

describe("project remove policy", () => {
  it("requires every host to support project removal", () => {
    const readiness = getProjectRemoveReadiness({
      project,
      isHostConnected: () => true,
      supportsProjectRemove: (serverId) => serverId === "host-a",
    });

    expect(readiness).toEqual({
      kind: "needs_host_update",
      serverIds: ["host-b"],
    });
  });

  it("reports a host that is not connected as disconnected, not as needing an update", () => {
    const readiness = getProjectRemoveReadiness({
      project,
      isHostConnected: (serverId) => serverId === "host-a",
      supportsProjectRemove: (serverId) => serverId === "host-a",
    });

    expect(readiness).toEqual({
      kind: "host_disconnected",
      serverIds: ["host-b"],
    });
  });

  it("reports the disconnected host first when another host needs an update", () => {
    const readiness = getProjectRemoveReadiness({
      project,
      isHostConnected: (serverId) => serverId === "host-a",
      supportsProjectRemove: () => false,
    });

    expect(readiness).toEqual({
      kind: "host_disconnected",
      serverIds: ["host-b"],
    });
  });

  it("reads a host the app has no connection or server info for as disconnected", () => {
    const readiness = getCurrentProjectRemoveReadiness({
      hosts: [{ serverId: "host-never-connected", projectId: "prj_offline" }],
    });

    expect(readiness).toEqual({
      kind: "host_disconnected",
      serverIds: ["host-never-connected"],
    });
  });

  it("removes the project from every participating host", async () => {
    const hostA = createProjectRemoveClient();
    const hostB = createProjectRemoveClient();
    const readiness = getProjectRemoveReadiness({
      project,
      isHostConnected: () => true,
      supportsProjectRemove: () => true,
    });

    expect(readiness).toEqual({
      kind: "ready",
      targets: [
        { serverId: "host-a", projectId: "prj_host_a" },
        { serverId: "host-b", projectId: "prj_host_b" },
      ],
    });

    const outcome = await removeProjectFromHosts({
      targets: readiness.kind === "ready" ? readiness.targets : [],
      getClient: (serverId) => {
        if (serverId === "host-a") return hostA.client;
        if (serverId === "host-b") return hostB.client;
        return null;
      },
    });

    expect(outcome).toEqual({ kind: "removed", serverIds: ["host-a", "host-b"] });
    expect(hostA.removedProjectKeys).toEqual(["prj_host_a"]);
    expect(hostB.removedProjectKeys).toEqual(["prj_host_b"]);
  });

  it("reports disconnected hosts before sending any remove request", async () => {
    const hostA = createProjectRemoveClient();

    const outcome = await removeProjectFromHosts({
      targets: [
        { serverId: "host-a", projectId: "prj_host_a" },
        { serverId: "host-b", projectId: "prj_host_b" },
      ],
      getClient: (serverId) => (serverId === "host-a" ? hostA.client : null),
    });

    expect(outcome).toEqual({ kind: "host_disconnected", serverIds: ["host-b"] });
    expect(hostA.removedProjectKeys).toEqual([]);
  });
});
