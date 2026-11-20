import { useTranslation } from "react-i18next";
import React, { createContext, useContext, useEffect, useMemo, type ReactNode } from "react";
import {
  useSidebarWorkspacesList,
  type SidebarProjectEntry,
  type SidebarWorkspaceEntry,
  type SidebarWorkspacesListResult,
} from "@/hooks/use-sidebar-workspaces-list";
import { useSidebarWorkspaceEntries } from "@/hooks/use-sidebar-workspace-entries";
import { usePinnedSidebarKeys, type PinnedSidebarGroups } from "@/hooks/use-sidebar-pins";
import { useSidebarCollapsedSectionsStore } from "@/stores/sidebar-collapsed-sections-store";
import { useSidebarFoldersStore } from "@/stores/sidebar-folders-store";
import {
  hasActiveSidebarLabelFilter,
  useSidebarViewStore,
  type SidebarGroupMode,
} from "@/stores/sidebar-view-store";
import { useSidebarOrderStore } from "@/stores/sidebar-order-store";
import type { SidebarShortcutModel } from "@/utils/sidebar-shortcuts";
import {
  foldersAsShown,
  projectFilterKeyOf,
  projectKeysWithProjectsInFolder,
} from "./sidebar-folders";
import { buildSidebarProjection } from "./sidebar-projection";
import type { SidebarProjectIconTarget } from "@/utils/sidebar-project-row-model";
import { filterWorkspacesByLabels, type SidebarWorkspaceGroup } from "./sidebar-labels";
import { filterWorkspacesByProjects, resolveActiveProjectFilters } from "./sidebar-project-filter";
import {
  hasAuthoritativeWorkspaceLabelCatalog,
  useWorkspaceLabelProjection,
} from "@/workspace-labels";

interface SidebarModel extends SidebarWorkspacesListResult {
  workspaceEntriesByKey: ReadonlyMap<string, SidebarWorkspaceEntry>;
  /**
   * Every project the sidebar could show, before any filter narrows it.
   *
   * `projects` is the FILTERED list. A surface that offers a filter picker must read this one, or
   * narrowing the filter deletes the rows that would undo it.
   */
  allProjects: SidebarProjectEntry[];
  /** The project filter as it is actually being applied — see `resolveActiveProjectFilters`. */
  resolvedProjectFilters: readonly string[];
  /** The project filter as one key, empty when none is applied (`projectFilterKeyOf`). */
  projectFilterKey: string;
  hasProjectsBeforeFilter: boolean;
  groupMode: SidebarGroupMode;
  workspaceGroups: SidebarWorkspaceGroup[];
  projectIconTargets: SidebarProjectIconTarget[];
  pinnedGroups: PinnedSidebarGroups;
  collapsedProjectKeys: ReadonlySet<string>;
  toggleProjectCollapsed: (projectViewKey: string) => void;
  shortcutModel: SidebarShortcutModel;
}

const SidebarModelContext = createContext<SidebarModel | null>(null);

/**
 * Runs `change`, a folder store change that puts projects into `folderId`, then takes the
 * projects it moved to the folder's end in the project order, as a move from a project's menu
 * does, so the folder keeps its place (ALM-5108).
 */
export function moveProjectsIntoFolderWithOrder(folderId: string, change: () => void): void {
  const before = useSidebarFoldersStore.getState();
  change();
  const after = useSidebarFoldersStore.getState();
  if (after === before) return;
  const movingKeys = Object.entries(after.folderIdByProjectKey)
    .filter(([key, id]) => id === folderId && before.folderIdByProjectKey[key] !== id)
    .map(([key]) => key);
  if (movingKeys.length === 0) return;
  const orderStore = useSidebarOrderStore.getState();
  const order = orderStore.getProjectOrder();
  const next = projectKeysWithProjectsInFolder({
    projectKeys: order,
    folderIdByProjectKey: before.folderIdByProjectKey,
    movingKeys,
    folderId,
  });
  if (next.length !== order.length || next.some((key, index) => key !== order[index])) {
    orderStore.setProjectOrder(next);
  }
}

export function SidebarModelProvider({
  active,
  keyboardNavigationActive = false,
  children,
}: {
  active?: boolean;
  keyboardNavigationActive?: boolean;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const modelActive = active !== false || keyboardNavigationActive;
  const list = useSidebarWorkspacesList({ enabled: modelActive });
  const showBackground = useSidebarViewStore((state) => state.showBackground);
  const groupMode = useSidebarViewStore((state) => state.groupMode);
  const labelFilter = useSidebarViewStore((state) => state.labelFilter);
  const projectFilters = useSidebarViewStore((state) => state.projectFilters);
  const reconcileLabelFilter = useSidebarViewStore((state) => state.reconcileLabelFilter);
  const { hosts: labelHosts } = useWorkspaceLabelProjection();
  const collapsedProjectKeys = useSidebarCollapsedSectionsStore(
    (state) => state.collapsedProjectKeys,
  );
  const collapsedWorkspaceGroupKeys = useSidebarCollapsedSectionsStore(
    (state) => state.collapsedWorkspaceGroupKeys,
  );
  const pinnedCollapsed = useSidebarCollapsedSectionsStore((state) => state.collapsedPinned);
  const savedFolders = useSidebarFoldersStore((state) => state.folders);
  const foldsUnderFilter = useSidebarFoldersStore((state) => state.foldsUnderFilter);
  const folderIdByProjectKey = useSidebarFoldersStore((state) => state.folderIdByProjectKey);
  const landingFolderId = useSidebarFoldersStore((state) => state.landingFolderId);
  // A project that appears while a folder is ticked "New projects land here" goes into it, one a
  // project filter hides too: the list read is every project on the hosts shown (ALM-5108).
  useEffect(() => {
    if (!modelActive || landingFolderId === null) return;
    const projects = list.projects;
    moveProjectsIntoFolderWithOrder(landingFolderId, () =>
      useSidebarFoldersStore.getState().landNewProjects(projects),
    );
  }, [landingFolderId, list.projects, modelActive]);
  const pinnedWorkspaceOrder = useSidebarOrderStore((state) => state.pinnedWorkspaceOrder);
  const toggleProjectCollapsed = useSidebarCollapsedSectionsStore(
    (state) => state.toggleProjectCollapsed,
  );
  const availableLabelNames = useMemo(
    () => labelHosts.flatMap((host) => host.labels.map((label) => label.name)),
    [labelHosts],
  );
  const hasAuthoritativeLabelCatalog = hasAuthoritativeWorkspaceLabelCatalog(labelHosts);
  useEffect(() => {
    if (!hasAuthoritativeLabelCatalog) return;
    reconcileLabelFilter(availableLabelNames);
  }, [availableLabelNames, hasAuthoritativeLabelCatalog, reconcileLabelFilter]);
  const hasActiveLabelFilter = hasActiveSidebarLabelFilter(labelFilter);
  const resolvedProjectFilters = useMemo(
    () =>
      resolveActiveProjectFilters(
        projectFilters,
        new Set(list.projects.map((project) => project.viewKey)),
      ),
    [projectFilters, list.projects],
  );
  const hasActiveProjectFilter = resolvedProjectFilters.length > 0;
  // Keyed by the stored filter: a filtered-to project going offline keeps the folds made under it.
  const projectFilterKey = useMemo(
    () => (hasActiveProjectFilter ? projectFilterKeyOf(projectFilters) : ""),
    [hasActiveProjectFilter, projectFilters],
  );
  // The shortcuts skip a folded folder's workspaces, so they read the folds the list shows.
  const folders = useMemo(
    () => foldersAsShown(savedFolders, projectFilterKey, foldsUnderFilter),
    [foldsUnderFilter, projectFilterKey, savedFolders],
  );
  // The project filter is deliberately absent from this gate. It reads `projectViewKey`, which
  // lives on the project and the placement, so it can narrow the project list without hydrating
  // anything; the label filter reads `labels`, which only exists on an entry. Hydration opens a
  // live session-store subscription over every workspace on every visible host, so widening this
  // for a filter that does not need it costs a retained-but-inactive sidebar real work.
  // Hardware keyboard navigation needs the same filtered targets while the sidebar is hidden.
  const needsWorkspaceEntries = groupMode !== "project" || hasActiveLabelFilter;
  const workspaceEntriesByKey = useSidebarWorkspaceEntries(
    list.workspacePlacements,
    modelActive || needsWorkspaceEntries,
  );
  const filteredWorkspaceEntriesByKey = useMemo(() => {
    const byProject = filterWorkspacesByProjects({
      workspaces: [...workspaceEntriesByKey.values()],
      projectFilters: resolvedProjectFilters,
    });
    const filtered = filterWorkspacesByLabels({
      workspaces: byProject.filter((workspace) => showBackground || !workspace.background),
      ...labelFilter,
    });
    return new Map(filtered.map((workspace) => [workspace.workspaceKey, workspace]));
  }, [showBackground, labelFilter, resolvedProjectFilters, workspaceEntriesByKey]);
  const visibleWorkspaceKeys = useMemo(
    () => new Set(filteredWorkspaceEntriesByKey.keys()),
    [filteredWorkspaceEntriesByKey],
  );
  // The two filters prune differently on purpose. The project filter is a membership test on the
  // project itself, so a project you filtered TO survives even with no workspaces — it still owns
  // a header row you can create your first workspace under. The label filter can only ask about
  // workspaces, so a project it empties has nothing left to show.
  const filteredProjects = useMemo(() => {
    let projects = list.projects;
    if (hasActiveProjectFilter) {
      const included = new Set(resolvedProjectFilters);
      projects = projects.filter((project) => included.has(project.viewKey));
    }
    if (hasActiveLabelFilter || !showBackground) {
      projects = projects.flatMap((project) => {
        const workspaces = project.workspaces.filter((workspace) =>
          visibleWorkspaceKeys.has(workspace.workspaceKey),
        );
        return workspaces.length > 0 || (!hasActiveLabelFilter && project.workspaces.length === 0)
          ? [workspaces.length === project.workspaces.length ? project : { ...project, workspaces }]
          : [];
      });
    }
    return projects;
  }, [
    showBackground,
    hasActiveLabelFilter,
    hasActiveProjectFilter,
    resolvedProjectFilters,
    list.projects,
    visibleWorkspaceKeys,
  ]);
  const pinnedKeys = usePinnedSidebarKeys(filteredProjects);
  const projectionInput = useMemo(
    () => ({
      projects: filteredProjects,
      pinnedKeys,
      pinnedWorkspaceOrder,
      workspaceEntriesByKey: filteredWorkspaceEntriesByKey,
      projectNamesByViewKey: list.projectNamesByViewKey,
      groupMode,
      pinnedCollapsed,
      collapsedProjectKeys,
      collapsedWorkspaceGroupKeys,
      folders,
      folderIdByProjectKey,
      t,
    }),
    [
      collapsedProjectKeys,
      collapsedWorkspaceGroupKeys,
      folders,
      folderIdByProjectKey,
      groupMode,
      list.projectNamesByViewKey,
      filteredProjects,
      pinnedCollapsed,
      pinnedKeys,
      pinnedWorkspaceOrder,
      filteredWorkspaceEntriesByKey,
      t,
    ],
  );
  const projection = useMemo(() => buildSidebarProjection(projectionInput), [projectionInput]);
  const value = useMemo(
    () => ({
      ...list,
      projects: filteredProjects,
      allProjects: list.projects,
      resolvedProjectFilters,
      projectFilterKey,
      hasProjectsBeforeFilter: list.projects.length > 0,
      workspaceEntriesByKey: filteredWorkspaceEntriesByKey,
      groupMode,
      workspaceGroups: projection.workspaceGroups,
      projectIconTargets: projection.projectIconTargets,
      pinnedGroups: projection.pinnedGroups,
      collapsedProjectKeys,
      toggleProjectCollapsed,
      shortcutModel: projection.shortcutModel,
    }),
    [
      resolvedProjectFilters,
      projectFilterKey,
      collapsedProjectKeys,
      groupMode,
      list,
      filteredProjects,
      projection,
      toggleProjectCollapsed,
      filteredWorkspaceEntriesByKey,
    ],
  );

  return <SidebarModelContext.Provider value={value}>{children}</SidebarModelContext.Provider>;
}

export function useSidebarModel(): SidebarModel {
  const model = useContext(SidebarModelContext);
  if (!model) throw new Error("SidebarModelProvider is required");
  return model;
}
