import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist, type StateStorage } from "zustand/middleware";
import { z } from "zod";
import {
  createValidatedPersistStorage,
  keepStoredState,
  readableRecordEntries,
} from "@/storage/validated-persist-storage";
import { followOtherWindowsWrites } from "@/storage/follow-other-windows";
import type { WorkspaceScriptLinkKind } from "@/utils/workspace-script-links";

interface WorkspaceServiceRoutePreferencesState {
  byServerId: Record<string, WorkspaceScriptLinkKind>;
  setPreferredRoute: (serverId: string, kind: WorkspaceScriptLinkKind) => void;
}

const WorkspaceScriptLinkKindSchema = z.enum(["public", "paseo", "direct"]);
const WorkspaceServiceRoutePreferencesSchema = z.object({
  byServerId: readableRecordEntries(WorkspaceScriptLinkKindSchema),
});

export function createWorkspaceServiceRoutePreferencesStore(storage: StateStorage) {
  return create<WorkspaceServiceRoutePreferencesState>()(
    persist<
      WorkspaceServiceRoutePreferencesState,
      [],
      [],
      z.infer<typeof WorkspaceServiceRoutePreferencesSchema>
    >(
      (set) => ({
        byServerId: {},
        setPreferredRoute: (serverId, kind) =>
          set((state) => ({ byServerId: { ...state.byServerId, [serverId]: kind } })),
      }),
      {
        name: "workspace-service-route-preferences",
        version: 1,
        storage: createValidatedPersistStorage(storage, WorkspaceServiceRoutePreferencesSchema),
        migrate: keepStoredState,
        partialize: (state) => ({ byServerId: state.byServerId }),
        merge: (persistedState, currentState) => {
          const result = WorkspaceServiceRoutePreferencesSchema.safeParse(persistedState);
          return {
            ...currentState,
            byServerId: result.success ? result.data.byServerId : {},
          };
        },
      },
    ),
  );
}

export const useWorkspaceServiceRoutePreferencesStore =
  createWorkspaceServiceRoutePreferencesStore(AsyncStorage);

// A route picked in one app window is the one every window opens, and none puts back another's
// (ALM-5115).
followOtherWindowsWrites(useWorkspaceServiceRoutePreferencesStore);
