import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { useSessionStore } from "@/stores/session-store";
import { selectHostFeature } from "@/runtime/host-features";
import { getHostRuntimeStore, isHostRuntimeConnected } from "@/runtime/host-runtime";

interface ProjectRemoveHost {
  serverId: string;
  projectId: string;
}

export interface ProjectRemoveProject {
  hosts: readonly ProjectRemoveHost[];
}

export interface ProjectRemoveTarget {
  serverId: string;
  projectId: string;
}

export type ProjectRemoveReadiness =
  | { kind: "ready"; targets: ProjectRemoveTarget[] }
  | { kind: "host_disconnected"; serverIds: string[] }
  | { kind: "needs_host_update"; serverIds: string[] };

export type ProjectRemoveOutcome =
  | { kind: "removed"; serverIds: string[] }
  | { kind: "host_disconnected"; serverIds: string[] }
  | { kind: "failed"; serverIds: string[] };

type ProjectRemoveClient = Pick<DaemonClient, "removeProject">;

/**
 * Whether every host of the project can remove it. A host that is not connected is reported as
 * such before any feature check, since an offline host sends no server info and would otherwise
 * read as one too old to remove projects (ALM-5042). With hosts of both kinds, the disconnected
 * ones are reported first.
 */
export function getProjectRemoveReadiness(input: {
  project: ProjectRemoveProject;
  isHostConnected: (serverId: string) => boolean;
  supportsProjectRemove: (serverId: string) => boolean;
}): ProjectRemoveReadiness {
  const disconnectedServerIds: string[] = [];
  const unsupportedServerIds: string[] = [];
  const targets: ProjectRemoveTarget[] = [];

  for (const host of input.project.hosts) {
    if (!input.isHostConnected(host.serverId)) {
      disconnectedServerIds.push(host.serverId);
      continue;
    }
    if (!input.supportsProjectRemove(host.serverId)) {
      unsupportedServerIds.push(host.serverId);
      continue;
    }
    targets.push({
      serverId: host.serverId,
      projectId: host.projectId,
    });
  }

  if (disconnectedServerIds.length > 0) {
    return { kind: "host_disconnected", serverIds: disconnectedServerIds };
  }

  if (unsupportedServerIds.length > 0) {
    return { kind: "needs_host_update", serverIds: unsupportedServerIds };
  }

  return { kind: "ready", targets };
}

/** A host counts as connected when it is online and has sent its server info. */
export function getCurrentProjectRemoveReadiness(
  project: ProjectRemoveProject,
): ProjectRemoveReadiness {
  const sessionState = useSessionStore.getState();
  const hostRuntime = getHostRuntimeStore();
  return getProjectRemoveReadiness({
    project,
    isHostConnected: (serverId) =>
      isHostRuntimeConnected(hostRuntime.getSnapshot(serverId)) &&
      sessionState.sessions[serverId]?.serverInfo != null,
    supportsProjectRemove: (serverId) => selectHostFeature(sessionState, serverId, "projectRemove"),
  });
}

export async function removeProjectFromHosts(input: {
  targets: readonly ProjectRemoveTarget[];
  getClient: (serverId: string) => ProjectRemoveClient | null;
}): Promise<ProjectRemoveOutcome> {
  const clients: Array<{ serverId: string; projectId: string; client: ProjectRemoveClient }> = [];
  const disconnectedServerIds: string[] = [];

  for (const target of input.targets) {
    const client = input.getClient(target.serverId);
    if (!client) {
      disconnectedServerIds.push(target.serverId);
      continue;
    }
    clients.push({ serverId: target.serverId, projectId: target.projectId, client });
  }

  if (disconnectedServerIds.length > 0) {
    return { kind: "host_disconnected", serverIds: disconnectedServerIds };
  }

  const results = await Promise.allSettled(
    clients.map(async ({ client, projectId }) => {
      await client.removeProject(projectId);
    }),
  );
  const failedServerIds: string[] = [];
  for (const [index, result] of results.entries()) {
    if (result.status === "rejected") {
      const failed = clients[index];
      if (failed) {
        failedServerIds.push(failed.serverId);
      }
    }
  }

  if (failedServerIds.length > 0) {
    return { kind: "failed", serverIds: failedServerIds };
  }

  return { kind: "removed", serverIds: clients.map((entry) => entry.serverId) };
}
