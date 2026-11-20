import AsyncStorage from "@react-native-async-storage/async-storage";
import { BrowserAutomationBrowserIdSchema } from "@getpaseo/protocol/browser-automation/rpc-schemas";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
import {
  followOtherWindowsWritesByKey,
  mergeFollowedEntries,
  type OtherWindowsWrites,
} from "@/storage/follow-other-windows";
import {
  applyBrowserPatch,
  BrowserIndexStateSchema,
  type BrowserIndexState,
  type BrowserRecord,
  type BrowserRecordPatch,
  type BrowserViewport,
  createBrowserRecord,
  normalizeBrowserIndexState,
  normalizeBrowserUrl,
  removeBrowserFromIndex,
  sanitizeBrowsersForPersist,
  trimNonEmpty,
} from "./state";

export {
  createFixedBrowserViewport,
  RESPONSIVE_BROWSER_VIEWPORT,
  type BrowserRecord,
  type BrowserViewport,
} from "./state";

interface BrowserStoreState extends BrowserIndexState {
  createBrowser: (input?: { initialUrl?: string }) => string;
  updateBrowser: (browserId: string, patch: BrowserRecordPatch) => void;
  setBrowserViewport: (browserId: string, viewport: BrowserViewport) => void;
  removeBrowser: (browserId: string) => void;
}

function createBrowserId(): string {
  let browserId: string;
  if (typeof globalThis.crypto?.randomUUID === "function") {
    browserId = globalThis.crypto.randomUUID();
  } else {
    const randomSuffix = Math.random().toString(16).slice(2) || "0";
    browserId = `${Date.now()}-${randomSuffix}`;
  }
  return BrowserAutomationBrowserIdSchema.parse(browserId);
}

let otherWindowsBrowserWrites: OtherWindowsWrites | null = null;

export const useBrowserStore = create<BrowserStoreState>()(
  persist(
    (set) => ({
      browsersById: {},
      createBrowser: (input) => {
        const browserId = createBrowserId();
        const record = createBrowserRecord({
          browserId,
          initialUrl: input?.initialUrl,
          now: Date.now(),
        });

        set((state) => ({
          browsersById: {
            ...state.browsersById,
            [browserId]: record,
          },
        }));

        return browserId;
      },
      updateBrowser: (browserId, patch) => {
        set((state) => applyBrowserPatch(state, browserId, patch));
      },
      setBrowserViewport: (browserId, viewport) => {
        set((state) => applyBrowserPatch(state, browserId, { viewport }));
      },
      removeBrowser: (browserId) => {
        set((state) => removeBrowserFromIndex(state, browserId));
      },
    }),
    {
      name: "workspace-browser-store",
      storage: createValidatedPersistStorage(AsyncStorage, BrowserIndexStateSchema),
      partialize: (state) => sanitizeBrowsersForPersist(state),
      // Another window's write takes in only the browsers it changed, so this window keeps the
      // live state (loading, last error) of the ones it shows (ALM-5115).
      merge: (persistedState, currentState) => {
        const stored = normalizeBrowserIndexState(persistedState);
        const before = otherWindowsBrowserWrites?.takeStateBefore();
        if (!before) return { ...currentState, ...stored };
        return {
          ...currentState,
          browsersById: mergeFollowedEntries({
            before: before.browsersById,
            storedRaw: (persistedState as { browsersById?: unknown } | undefined)?.browsersById,
            stored: stored.browsersById,
            local: currentState.browsersById,
          }),
        };
      },
    },
  ),
);

// Each app window keeps its own browsers in memory and writes all of them; this takes in the ones
// another window opened, moved or closed (ALM-5115).
otherWindowsBrowserWrites = followOtherWindowsWritesByKey(useBrowserStore);

export function getBrowserRecord(browserId: string): BrowserRecord | null {
  const normalizedBrowserId = trimNonEmpty(browserId);
  if (!normalizedBrowserId) {
    return null;
  }
  return useBrowserStore.getState().browsersById[normalizedBrowserId] ?? null;
}

export function createWorkspaceBrowser(input?: { initialUrl?: string }): {
  browserId: string;
  url: string;
} {
  const browserId = useBrowserStore.getState().createBrowser(input);
  const record = getBrowserRecord(browserId);
  return {
    browserId,
    url: record?.url ?? normalizeBrowserUrl(input?.initialUrl),
  };
}

export function normalizeWorkspaceBrowserUrl(value: string | null | undefined): string {
  return normalizeBrowserUrl(value);
}
