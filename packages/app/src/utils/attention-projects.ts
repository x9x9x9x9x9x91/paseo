import { z } from "zod";
import type { WorkspaceDescriptor } from "@/stores/session-store";
import type { ProjectSummary } from "@/utils/projects";
import { resolveWorkspaceMapKeyByIdentity } from "@/utils/workspace-identity";

const AttentionProjectsShape = z.object({
  scope: z.enum(["all", "chosen"]).catch("all"),
  projectIds: z.array(z.string()).catch([]),
});

/**
 * Which projects count toward the dock badge and raise OS notifications. Device-local.
 * `projectIds` survives a switch back to "all", so the list is still there when the user
 * returns to "chosen". A project id is random per project on its host, so an id alone
 * names one project across every host, survives a rename, and never matches a project
 * that was removed and added again.
 */
export type AttentionProjects = z.output<typeof AttentionProjectsShape>;

export const DEFAULT_ATTENTION_PROJECTS: AttentionProjects = { scope: "all", projectIds: [] };

export const AttentionProjectsSchema = AttentionProjectsShape.catch(DEFAULT_ATTENTION_PROJECTS);

/** A project left off the list, including one added after the list was made, does not count. */
export function isProjectCountedForAttention(
  preference: AttentionProjects,
  projectId: string | null | undefined,
): boolean {
  if (preference.scope === "all") return true;
  return projectId ? preference.projectIds.includes(projectId) : false;
}

/** A workspace the app cannot find belongs to no chosen project. */
export function isWorkspaceCountedForAttention(input: {
  preference: AttentionProjects;
  workspaces: Map<string, WorkspaceDescriptor> | null | undefined;
  workspaceId: string | null | undefined;
}): boolean {
  if (input.preference.scope === "all") return true;
  const key = resolveWorkspaceMapKeyByIdentity({
    workspaces: input.workspaces,
    workspaceId: input.workspaceId,
  });
  const projectId = key ? input.workspaces?.get(key)?.projectId : null;
  return isProjectCountedForAttention(input.preference, projectId);
}

export function setProjectCountedForAttention(
  preference: AttentionProjects,
  projectId: string,
  counted: boolean,
): AttentionProjects {
  const others = preference.projectIds.filter((id) => id !== projectId);
  return { ...preference, projectIds: counted ? [...others, projectId] : others };
}

export interface AttentionProjectRow {
  projectId: string;
  /** The project's name on this host, as the projects list shows it. */
  name: string;
  /** Set only when the projects span more than one host, so same-named rows can be told apart. */
  hostName: string | null;
  counted: boolean;
}

/**
 * One row per project on each host. Ids on the list that match no known project (a removed
 * project, or one on a host that is gone) get no row; they stay stored, so a host that is only
 * offline keeps its choice.
 */
export function buildAttentionProjectRows(
  projects: readonly ProjectSummary[],
  preference: AttentionProjects,
): AttentionProjectRow[] {
  const hosts = projects.flatMap((project) => project.hosts);
  const multipleHosts = new Set(hosts.map((host) => host.serverId)).size > 1;
  return hosts.map((host) => ({
    projectId: host.projectId,
    name: host.projectName,
    hostName: multipleHosts ? host.serverName : null,
    counted: preference.projectIds.includes(host.projectId),
  }));
}
