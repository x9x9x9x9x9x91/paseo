import { describe, expect, it } from "vitest";
import type { StateStorage } from "zustand/middleware";
import type { UserComposerAttachment } from "@/attachments/types";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";
import { PersistedDraftStoreSchema } from "./migration";
import type { DraftRecord, DraftStoreState } from "./state";
import { keepUnreadDraftEntries } from "./unread";

const KEY = "paseo-drafts";

function createMemoryStorage(): StateStorage & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => {
      values.set(key, value);
    },
    removeItem: async (key) => {
      values.delete(key);
    },
  };
}

function image(id: string): UserComposerAttachment {
  return {
    kind: "image",
    metadata: {
      id,
      mimeType: "image/png",
      storageType: "web-indexeddb",
      storageKey: id,
      createdAt: 1,
    },
  };
}

function draft(
  text: string,
  attachments: UserComposerAttachment[] = [],
  lifecycle: DraftRecord["lifecycle"] = "active",
): DraftRecord {
  return { input: { text, attachments }, lifecycle, updatedAt: 5, version: 1 };
}

/** A later build's attachment, of a kind this build does not know, holding a stored file. */
const voiceNote = { kind: "voice_note", metadata: { id: "voice-1", storageKey: "voice-1" } };
/** A later build's draft, of a lifecycle this build does not know. */
const scheduled = {
  ...draft("send at nine", [image("image-9")]),
  lifecycle: "scheduled",
};

function laterBuildState() {
  return {
    drafts: {
      "draft:voice": {
        ...draft("with a voice note"),
        input: { text: "with a voice note", attachments: [image("image-1"), voiceNote] },
      },
      "draft:scheduled": scheduled,
    },
    createModalDraft: { ...draft("modal"), lifecycle: "scheduled" },
  };
}

async function openOlderBuild(state: unknown = laterBuildState()) {
  const backing = createMemoryStorage();
  backing.values.set(KEY, JSON.stringify({ state, version: 5 }));
  const unread = keepUnreadDraftEntries(backing);
  const storage = createValidatedPersistStorage(unread.storage, PersistedDraftStoreSchema);
  const read = await storage.getItem(KEY);
  const write = (next: DraftStoreState) => storage.setItem(KEY, { state: next, version: 5 });
  const stored = () => JSON.parse(backing.values.get(KEY) ?? "null")?.state;
  return { backing, unread, read, write, stored };
}

describe("draft entries an older build cannot read (ALM-5148)", () => {
  it("writes back an attachment of an unknown kind in its draft, at its place, and a draft it cannot read", async () => {
    const { read, write, stored, unread } = await openOlderBuild();
    expect(read?.state.drafts?.["draft:voice"]).toEqual(
      draft("with a voice note", [image("image-1")]),
    );
    expect(Object.keys(read?.state.drafts ?? {})).toEqual(["draft:voice"]);

    const edited = draft("with a voice note, edited", [image("image-1"), image("image-2")]);
    const state = { drafts: { "draft:voice": edited }, createModalDraft: null };
    unread.forgetReplaced(state);
    await write(state);

    expect(stored()).toEqual({
      drafts: {
        "draft:voice": {
          ...edited,
          input: { ...edited.input, attachments: [image("image-1"), voiceNote, image("image-2")] },
        },
        "draft:scheduled": scheduled,
      },
      createModalDraft: laterBuildState().createModalDraft,
    });
  });

  it("keeps the files the unread entries name from the sweep", async () => {
    const { unread } = await openOlderBuild();
    const held = unread.heldStrings();
    expect(held.has("voice-1")).toBe(true);
    expect(held.has("image-9")).toBe(true);
    expect(held.has("image-1")).toBe(false);
  });

  it("drops an unread attachment with its draft once this build sends or clears it", async () => {
    const { write, stored, unread } = await openOlderBuild();
    const sent = { drafts: { "draft:voice": draft("", [], "sent") }, createModalDraft: null };
    unread.forgetReplaced(sent);
    // A new draft in the same place before the sent one was written holds nothing of the old.
    const next = { drafts: { "draft:voice": draft("next message") }, createModalDraft: null };
    unread.forgetReplaced(next);
    await write(next);

    expect(stored().drafts["draft:voice"]).toEqual(draft("next message"));
    expect(unread.heldStrings().has("voice-1")).toBe(false);
  });

  it("lets a draft of this build's own replace one it could not read", async () => {
    const { write, stored, unread } = await openOlderBuild();
    const own = draft("typed here");
    const state = {
      drafts: {
        "draft:voice": draft("with a voice note", [image("image-1")]),
        "draft:scheduled": own,
      },
      createModalDraft: draft("own modal"),
    };
    unread.forgetReplaced(state);
    await write(state);

    expect(stored().drafts["draft:scheduled"]).toEqual(own);
    expect(stored().createModalDraft).toEqual(draft("own modal"));
    expect(unread.heldStrings().has("image-9")).toBe(false);
    await write({ ...state, createModalDraft: null });
    expect(stored().createModalDraft).toBeNull();
  });

  it("writes a draft it reads whole as it is", async () => {
    const own = {
      drafts: { "draft:a": draft("hello", [image("image-1")]) },
      createModalDraft: null,
    };
    const { write, backing } = await openOlderBuild(own);
    await write(own);

    expect(JSON.parse(backing.values.get(KEY) ?? "null")).toEqual({ state: own, version: 5 });
  });
});
