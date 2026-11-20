import AsyncStorage from "@react-native-async-storage/async-storage";
import { describe, expect, it, vi } from "vitest";

const garbageCollections = vi.hoisted(() => ({ count: 0 }));

vi.mock("@/attachments/service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/attachments/service")>();
  return {
    ...actual,
    garbageCollectAttachments: async () => {
      garbageCollections.count += 1;
    },
  };
});

import { useDraftStore } from "./index";
import { DRAFT_STORE_VERSION } from "./state";

async function settle() {
  for (let index = 0; index < 5; index += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("draft store reading another window's write", () => {
  it("sweeps no attachments and writes nothing back", async () => {
    if (!useDraftStore.persist.hasHydrated()) {
      await new Promise<void>((resolve) =>
        useDraftStore.persist.onFinishHydration(() => resolve()),
      );
    }
    await settle();
    const sweepsAtStartUp = garbageCollections.count;
    const stored = JSON.stringify({
      state: {
        drafts: {
          "draft:other-window": {
            input: { text: "typed in the other window", attachments: [] },
            lifecycle: "active",
            updatedAt: 1,
            version: 1,
          },
        },
        createModalDraft: null,
      },
      version: DRAFT_STORE_VERSION,
    });
    await AsyncStorage.setItem("paseo-drafts", stored);
    const setItem = vi.spyOn(AsyncStorage, "setItem");

    await useDraftStore.persist.rehydrate();
    await settle();

    expect(useDraftStore.getState().getDraftInput("draft:other-window")?.text).toBe(
      "typed in the other window",
    );
    expect(garbageCollections.count).toBe(sweepsAtStartUp);
    expect(setItem).not.toHaveBeenCalled();
  });
});
