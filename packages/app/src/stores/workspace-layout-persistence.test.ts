import { indexedDB, IDBKeyRange } from "fake-indexeddb";
import { expect, it } from "vitest";
import type { StateStorage } from "zustand/middleware";
import type { StorageEventSource } from "@/storage/follow-other-windows";
import {
  createWorkspaceLayoutStore,
  collectAllTabs,
  selectExplorerSidebarPaneId,
} from "./workspace-layout-store";
import { deriveWorkspacePaneState } from "../screens/workspace/workspace-pane-state";
import { selectVisibleAgentIds } from "../screens/workspace/visible-agent-ids";

Object.assign(globalThis, { indexedDB, IDBKeyRange });

it("skips unchanged reconciliations and immediately saves real layout changes", async () => {
  const values = new Map<string, string>();
  let writes = 0;
  const storage: StateStorage = {
    getItem: (name) => values.get(name) ?? null,
    setItem: (name, value) => {
      writes += 1;
      values.set(name, value);
    },
    removeItem: (name) => {
      values.delete(name);
    },
  };
  const store = createWorkspaceLayoutStore(undefined, storage);
  await store.persist.rehydrate();
  const workspaceKey = "server:workspace";
  const openAgent = (agentId: string) =>
    store.getState().openTab({
      workspaceKey,
      target: { kind: "agent", agentId },
      intent: "reveal",
    });
  openAgent("agent-1");
  const layout = store.getState().layoutByWorkspace[workspaceKey];
  const writesBefore = writes;
  expect(writesBefore).toBe(1);
  for (let index = 0; index < 50; index += 1) {
    store.getState().reconcileTabs(workspaceKey, {
      agentsHydrated: true,
      terminalsHydrated: true,
      activeAgentIds: ["agent-1"],
      autoOpenAgentIds: ["agent-1"],
      knownTerminalIds: [],
      standaloneTerminalIds: [],
    });
  }
  expect(store.getState().layoutByWorkspace[workspaceKey]).toBe(layout);
  expect(writes).toBe(writesBefore);

  openAgent("agent-2");
  expect(writes).toBe(writesBefore + 1);
  const restored = createWorkspaceLayoutStore(undefined, storage);
  await restored.persist.rehydrate();
  expect(restored.getState().layoutByWorkspace[workspaceKey]).toEqual(
    store.getState().layoutByWorkspace[workspaceKey],
  );
});

it("keeps the saved layout when the shell publishes its layout mode before hydration", async () => {
  const values = new Map<string, string>();
  const storage: StateStorage = {
    getItem: (name) => values.get(name) ?? null,
    setItem: (name, value) => {
      values.set(name, value);
    },
    removeItem: (name) => {
      values.delete(name);
    },
  };
  const workspaceKey = "server:workspace";
  const saved = createWorkspaceLayoutStore(undefined, storage);
  await saved.persist.rehydrate();
  saved.getState().openTab({
    workspaceKey,
    target: { kind: "file", path: "notes.md" },
    intent: "reveal",
  });

  // A page load: the shell publishes its mode from the first commit, before the read settles.
  const loaded = createWorkspaceLayoutStore(undefined, storage);
  loaded.getState().setLayoutMode("single-pane");
  await new Promise<void>((resolve) => loaded.persist.onFinishHydration(() => resolve()));
  expect(loaded.getState().layoutByWorkspace[workspaceKey]).toEqual(
    saved.getState().layoutByWorkspace[workspaceKey],
  );

  // Leaving the page before any other layout change must not lose the tabs.
  const reloaded = createWorkspaceLayoutStore(undefined, storage);
  await reloaded.persist.rehydrate();
  expect(reloaded.getState().layoutByWorkspace[workspaceKey]).toEqual(
    saved.getState().layoutByWorkspace[workspaceKey],
  );
});

it("keeps every saved layout when a draft tab's setup carries a nested provider option", async () => {
  const values = new Map<string, string>();
  const storage: StateStorage = {
    getItem: (name) => values.get(name) ?? null,
    setItem: (name, value) => {
      values.set(name, value);
    },
    removeItem: (name) => {
      values.delete(name);
    },
  };
  const store = createWorkspaceLayoutStore(undefined, storage);
  await store.persist.rehydrate();
  store.getState().openTab({
    workspaceKey: "server:kept",
    target: { kind: "agent", agentId: "agent-1" },
    intent: "reveal",
  });
  store.getState().openTab({
    workspaceKey: "server:forked",
    target: {
      kind: "draft",
      draftId: "draft-1",
      setup: {
        provider: "codex",
        cwd: "/repo",
        modeId: null,
        model: null,
        thinkingOptionId: null,
        providerOptions: { sandbox_workspace_write: { network_access: true }, max_turns: 3 },
      },
    },
    intent: "reveal",
  });

  const restored = createWorkspaceLayoutStore(undefined, storage);
  await restored.persist.rehydrate();

  expect(Object.keys(restored.getState().layoutByWorkspace).sort()).toEqual([
    "server:forked",
    "server:kept",
  ]);
  expect(JSON.stringify(restored.getState().layoutByWorkspace["server:forked"])).toContain(
    "network_access",
  );
});

it.each([1, 2])(
  "restores the agent pane after parked focus in storage version %i",
  async (version) => {
    const values = new Map<string, string>();
    const storage: StateStorage = {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value);
      },
      removeItem: (key) => {
        values.delete(key);
      },
    };
    const key = "host:workspace";
    const source = createWorkspaceLayoutStore(undefined, storage);
    await source.persist.rehydrate();
    source.getState().setLayoutMode("compact");
    source.getState().openTab({
      workspaceKey: key,
      target: { kind: "agent", agentId: "agent-a" },
      intent: "reveal",
    });
    source.getState().unfocusPane(key);
    expect(source.getState().layoutByWorkspace[key].focusedPaneId).toBeNull();
    const persisted = JSON.parse(values.get("workspace-layout-state")!);
    persisted.version = version;
    values.set("workspace-layout-state", JSON.stringify(persisted));
    const restored = createWorkspaceLayoutStore(undefined, storage);
    restored.getState().setLayoutMode("compact");
    await restored.persist.rehydrate();
    restored.getState().reconcileTabs(key, {
      agentsHydrated: true,
      terminalsHydrated: true,
      activeAgentIds: ["agent-a"],
      autoOpenAgentIds: ["agent-a"],
      knownTerminalIds: [],
      standaloneTerminalIds: [],
    });
    const layout = restored.getState().layoutByWorkspace[key];
    const tabs = collectAllTabs(layout.root);
    const restoredExplorerId = selectExplorerSidebarPaneId(restored.getState(), key);
    const main = deriveWorkspacePaneState({ layout, tabs });
    const visible = selectVisibleAgentIds({
      layout,
      tabs,
      routeFocused: true,
      focusedPaneOnly: true,
      explorerPaneId: restoredExplorerId,
      explorerVisible: false,
    });
    expect(layout.focusedPaneId).toBe("main");
    expect(main.activeTab?.descriptor.target).toEqual({ kind: "agent", agentId: "agent-a" });
    expect(main.tabs.map((t) => t.descriptor.kind)).toEqual(["agent"]);
    expect(visible).toEqual(["agent-a"]);
  },
);

it("takes in only the workspace another app window changed and keeps that change through its own next write", async () => {
  const values = new Map<string, string>();
  const storage: StateStorage = {
    getItem: (name) => values.get(name) ?? null,
    setItem: (name, value) => {
      values.set(name, value);
    },
    removeItem: (name) => {
      values.delete(name);
    },
  };
  type StorageListener = Parameters<StorageEventSource["addEventListener"]>[1];
  const listeners = new Set<StorageListener>();
  const eventsOfB: StorageEventSource = {
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
  };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  const shown = "server:shown-in-b";
  const other = "server:shown-in-a";
  const openAgent = (
    store: ReturnType<typeof createWorkspaceLayoutStore>,
    workspaceKey: string,
    agentId: string,
  ) =>
    store
      .getState()
      .openTab({ workspaceKey, target: { kind: "agent", agentId }, intent: "reveal" });

  const windowA = createWorkspaceLayoutStore(undefined, storage);
  await windowA.persist.rehydrate();
  openAgent(windowA, other, "agent-a1");
  await settle();
  const windowB = createWorkspaceLayoutStore(undefined, storage, eventsOfB);
  await windowB.persist.rehydrate();
  openAgent(windowB, shown, "agent-b1");
  await settle();
  await windowA.persist.rehydrate();
  const openInAFollowedByB = async (agentId: string, workspaceKey = other) => {
    const beforeA = values.get("workspace-layout-state") ?? null;
    openAgent(windowA, workspaceKey, agentId);
    await settle();
    for (const listener of listeners) {
      listener({
        key: "workspace-layout-state",
        oldValue: beforeA,
        newValue: values.get("workspace-layout-state") ?? null,
      });
    }
    await settle();
  };
  // A read B's workspace in, which fills in the explorer pane id B never stored, so A's next
  // write changes B's entry without changing B's layout: B keeps its own.
  const layoutShownInB = windowB.getState().layoutByWorkspace[shown];
  await openInAFollowedByB("agent-a2");
  expect(windowB.getState().layoutByWorkspace[shown]).toBe(layoutShownInB);

  await openInAFollowedByB("agent-a3");

  expect(windowB.getState().layoutByWorkspace[shown]).toBe(layoutShownInB);
  const agentIdsOf = (store: typeof windowB, workspaceKey: string) =>
    collectAllTabs(store.getState().layoutByWorkspace[workspaceKey].root).flatMap((tab) =>
      tab.target.kind === "agent" ? [tab.target.agentId] : [],
    );
  expect(agentIdsOf(windowB, other)).toEqual(["agent-a1", "agent-a2", "agent-a3"]);

  openAgent(windowB, shown, "agent-b2");
  await settle();
  const reopened = createWorkspaceLayoutStore(undefined, storage);
  await reopened.persist.rehydrate();
  expect(agentIdsOf(reopened, other)).toEqual(["agent-a1", "agent-a2", "agent-a3"]);
  expect(agentIdsOf(reopened, shown)).toEqual(["agent-b1", "agent-b2"]);

  // A real change to B's workspace from A is still taken in.
  await windowA.persist.rehydrate();
  await openInAFollowedByB("agent-a4", shown);
  expect(agentIdsOf(windowB, shown)).toEqual(["agent-b1", "agent-b2", "agent-a4"]);
});

// A later build's tab kind would fail the whole layout and leave this build with none (ALM-5138).
it("drops a tab of a kind it does not know and keeps the rest of the layout", async () => {
  const values = new Map<string, string>();
  const storage: StateStorage = {
    getItem: (name) => values.get(name) ?? null,
    setItem: (name, value) => {
      values.set(name, value);
    },
    removeItem: (name) => {
      values.delete(name);
    },
  };
  const workspaceKey = "server:workspace";
  const source = createWorkspaceLayoutStore(undefined, storage);
  await source.persist.rehydrate();
  source.getState().openTab({
    workspaceKey,
    target: { kind: "agent", agentId: "agent-1" },
    intent: "reveal",
  });
  const persisted = JSON.parse(values.get("workspace-layout-state")!);
  interface StoredPane {
    tabs: unknown[];
    tabIds: string[];
    focusedTabId: string | null;
  }
  interface StoredNode {
    pane?: StoredPane;
    group?: { children: StoredNode[] };
  }
  const panes = (node: StoredNode): StoredPane[] =>
    node.pane ? [node.pane] : (node.group?.children ?? []).flatMap(panes);
  const pane = panes(persisted.state.layoutByWorkspace[workspaceKey].root).find(
    (candidate) => candidate.tabs.length > 0,
  )!;
  pane.tabs.push({ tabId: "later-tab", target: { kind: "later_kind" }, createdAt: 1 });
  pane.tabIds.push("later-tab");
  pane.focusedTabId = "later-tab";
  values.set("workspace-layout-state", JSON.stringify(persisted));

  const restored = createWorkspaceLayoutStore(undefined, storage);
  await restored.persist.rehydrate();

  const tabs = collectAllTabs(restored.getState().layoutByWorkspace[workspaceKey].root);
  expect(tabs.map((tab) => tab.target)).toContainEqual({ kind: "agent", agentId: "agent-1" });
  expect(tabs.map((tab) => tab.tabId)).not.toContain("later-tab");
});

// One workspace's layout a later build changed would empty every workspace's (ALM-5138).
it("starts only the workspace whose layout it cannot read empty", async () => {
  const values = new Map<string, string>();
  const storage: StateStorage = {
    getItem: (name) => values.get(name) ?? null,
    setItem: (name, value) => {
      values.set(name, value);
    },
    removeItem: (name) => {
      values.delete(name);
    },
  };
  const workspaceKey = "server:workspace";
  const source = createWorkspaceLayoutStore(undefined, storage);
  await source.persist.rehydrate();
  source.getState().openTab({
    workspaceKey,
    target: { kind: "agent", agentId: "agent-1" },
    intent: "reveal",
  });
  const persisted = JSON.parse(values.get("workspace-layout-state")!);
  persisted.state.layoutByWorkspace["server:later"] = {
    root: { kind: "stack", stack: { id: "s" } },
    focusedPaneId: null,
  };
  values.set("workspace-layout-state", JSON.stringify(persisted));

  const restored = createWorkspaceLayoutStore(undefined, storage);
  await restored.persist.rehydrate();

  const tabs = collectAllTabs(restored.getState().layoutByWorkspace[workspaceKey].root);
  expect(tabs.map((tab) => tab.target)).toContainEqual({ kind: "agent", agentId: "agent-1" });
  expect(restored.getState().layoutByWorkspace["server:later"]).toBeUndefined();
});
