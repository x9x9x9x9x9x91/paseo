import AsyncStorage from "@react-native-async-storage/async-storage";
import { describe, expect, it, vi } from "vitest";
import { useSidebarFoldersStore } from "@/stores/sidebar-folders-store";
import { SIDEBAR_FOLDER_LANDING_STORAGE_KEY } from "@/stores/sidebar-folders-store/storage";

const KEY = "sidebar-project-folders";

async function stored(): Promise<unknown> {
  const raw = await AsyncStorage.getItem(KEY);
  return raw === null ? null : JSON.parse(raw).state;
}

/**
 * What another app window does: writes the storage every window shares (`localStorage` in the
 * app, the in-memory stub here), which fires `storage` in this window.
 */
async function writeFromOtherWindow(state: unknown, key = KEY) {
  const newValue = JSON.stringify({ state, version: 0 });
  await AsyncStorage.setItem(key, newValue);
  window.dispatchEvent(new StorageEvent("storage", { key, newValue }));
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

  it("follows a tick another window makes, which writes only the tick's own key", async () => {
    await useSidebarFoldersStore.persist.rehydrate();
    const music = useSidebarFoldersStore.getState().createFolder("Music", "night");
    if (!music) throw new Error("folder not made");
    await vi.waitFor(async () =>
      expect(await stored()).toMatchObject({ folderIdByProjectKey: { night: music } }),
    );

    await writeFromOtherWindow(
      { landingFolderId: music, knownProjectKeys: ["night"] },
      SIDEBAR_FOLDER_LANDING_STORAGE_KEY,
    );
    await vi.waitFor(() =>
      expect(useSidebarFoldersStore.getState()).toMatchObject({
        landingFolderId: music,
        knownProjectKeys: ["night"],
      }),
    );
  });
});
