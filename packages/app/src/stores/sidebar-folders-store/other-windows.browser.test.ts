import AsyncStorage from "@react-native-async-storage/async-storage";
import { describe, expect, it, vi } from "vitest";
import { useSidebarFoldersStore } from "@/stores/sidebar-folders-store";

const KEY = "sidebar-project-folders";

async function stored(): Promise<unknown> {
  const raw = await AsyncStorage.getItem(KEY);
  return raw === null ? null : JSON.parse(raw).state;
}

/**
 * What another app window does: writes the storage every window shares (`localStorage` in the
 * app, the in-memory stub here), which fires `storage` in this window.
 */
async function writeFromOtherWindow(state: unknown) {
  const newValue = JSON.stringify({ state, version: 0 });
  await AsyncStorage.setItem(KEY, newValue);
  window.dispatchEvent(new StorageEvent("storage", { key: KEY, newValue }));
}

describe("sidebar folders across app windows", () => {
  it("keeps a project another window took out through this window's next folder change", async () => {
    await useSidebarFoldersStore.persist.rehydrate();
    const actions = useSidebarFoldersStore.getState();
    const workers = actions.createFolder("Workers", "alma");
    if (!workers) throw new Error("folder not made");
    actions.moveProjectToFolder("crisis", workers);
    await vi.waitFor(async () =>
      expect(await stored()).toMatchObject({
        folderIdByProjectKey: { alma: workers, crisis: workers },
      }),
    );
    const folders = useSidebarFoldersStore.getState().folders;

    await writeFromOtherWindow({ folders, folderIdByProjectKey: { crisis: workers } });
    await vi.waitFor(() =>
      expect(useSidebarFoldersStore.getState().folderIdByProjectKey).toEqual({ crisis: workers }),
    );

    useSidebarFoldersStore.getState().renameFolder(workers, "Helpers");
    await vi.waitFor(async () =>
      expect(await stored()).toEqual({
        folders: [{ id: workers, name: "Helpers", collapsed: true }],
        folderIdByProjectKey: { crisis: workers },
      }),
    );
  });
});
