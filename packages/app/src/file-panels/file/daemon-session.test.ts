import { afterEach, describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import { __resetRecentlyPersistedForTests, garbageCollectAttachments } from "@/attachments/service";
import { __setAttachmentStoreForTests } from "@/attachments/store";
import type { AttachmentMetadata, AttachmentStore } from "@/attachments/types";
import { createDaemonFileSession } from "./daemon-session";

/** An attachment store that keeps what is saved until it is deleted or swept. */
function createKeepingStore(): AttachmentStore & { stored: Set<string>; releasedUrls: string[] } {
  const stored = new Set<string>();
  const releasedUrls: string[] = [];
  return {
    storageType: "native-file",
    stored,
    releasedUrls,
    async save(input): Promise<AttachmentMetadata> {
      stored.add(input.id);
      return {
        id: input.id,
        mimeType: input.mimeType,
        storageType: "native-file",
        storageKey: input.id,
        fileName: input.fileName,
        byteSize: 4,
        createdAt: 1700000000000,
      };
    },
    async encodeBase64({ attachment }) {
      return attachment.id;
    },
    async resolvePreviewUrl({ attachment }) {
      return `file:///attachments/${attachment.id}`;
    },
    async releasePreviewUrl({ url }) {
      releasedUrls.push(url);
    },
    async delete({ attachment }) {
      stored.delete(attachment.id);
    },
    async garbageCollect({ referencedIds }) {
      for (const id of stored) if (!referencedIds.has(id)) stored.delete(id);
    },
  };
}

const session = createDaemonFileSession({} as DaemonClient, {
  workspaceFileEditing: true,
  fileByteWrites: true,
});
const target = { cwd: "/repo", path: "art/cover.png" };

describe("daemon file session previews", () => {
  afterEach(() => {
    __setAttachmentStoreForTests(null);
    __resetRecentlyPersistedForTests();
  });

  it("keeps an open preview's image through a sweep, and deletes it once released", async () => {
    const store = createKeepingStore();
    __setAttachmentStoreForTests(store);

    const preview = await session.createUrl({
      target,
      bytes: new Uint8Array([1, 2, 3, 4]),
      mimeType: "image/png",
    });
    const [id] = store.stored;
    expect(preview.url).toBe(`file:///attachments/${id}`);

    // Past the recent-save window, as a preview open for more than 30 s is.
    __resetRecentlyPersistedForTests();
    await garbageCollectAttachments({ referencedIds: new Set() });
    expect(store.stored.has(id)).toBe(true);

    preview.release();
    await vi.waitFor(() => expect(store.stored.has(id)).toBe(false));
    expect(store.releasedUrls).toEqual([preview.url]);
  });
});
