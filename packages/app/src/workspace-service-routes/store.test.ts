import { describe, expect, it } from "vitest";
import type { StateStorage } from "zustand/middleware";
import { createWorkspaceServiceRoutePreferencesStore } from "./store";

function createMemoryStorage(initial?: Record<string, string>): StateStorage & {
  values: Map<string, string>;
} {
  const values = new Map(Object.entries(initial ?? {}));
  return {
    values,
    getItem: async (name) => values.get(name) ?? null,
    setItem: async (name, value) => {
      values.set(name, value);
    },
    removeItem: async (name) => {
      values.delete(name);
    },
  };
}

describe("workspace service route preferences", () => {
  it("persists each host's preferred route", async () => {
    const storage = createMemoryStorage();
    const first = createWorkspaceServiceRoutePreferencesStore(storage);
    await first.persist.rehydrate();

    first.getState().setPreferredRoute("desktop", "direct");
    first.getState().setPreferredRoute("devbox", "public");

    const restored = createWorkspaceServiceRoutePreferencesStore(storage);
    await restored.persist.rehydrate();
    expect(restored.getState().byServerId).toEqual({ desktop: "direct", devbox: "public" });
  });

  // A route kind a later build adds would wipe every host's route on an older one (ALM-5138).
  it("leaves out only a route of a kind it does not know and keeps the stored value", async () => {
    const stored = JSON.stringify({
      state: { byServerId: { desktop: "direct", later: "unknown" } },
      version: 1,
    });
    const storage = createMemoryStorage({ "workspace-service-route-preferences": stored });
    const store = createWorkspaceServiceRoutePreferencesStore(storage);
    await store.persist.rehydrate();

    expect(store.getState().byServerId).toEqual({ desktop: "direct" });
    expect(storage.values.get("workspace-service-route-preferences")).toBe(stored);
  });
});
