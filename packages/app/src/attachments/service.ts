import { collectRetainedAttachmentIds } from "@/attachments/gc-retention";
import {
  createOtherWindowHolds,
  defaultHoldChannel,
  defaultWindowCloseSource,
  type HoldChannel,
  type OtherWindowHolds,
} from "@/attachments/other-window-holds";
import { getAttachmentStore } from "@/attachments/store";
import type { AttachmentMetadata, SaveAttachmentInput } from "@/attachments/types";

// A save's id reaches its holder (a draft, a screenshot) only after the save returns; a sweep in
// that gap, this window's or another's, still keeps it (ALM-5125).
const RECENT_PERSISTENCE_MS = 30_000;

const activePersistence = new Set<Promise<AttachmentMetadata>>();
const persistedDuringGarbageCollection = new Set<string>();
const recentlyPersisted = new Map<string, number>();
let pendingGarbageCollections = 0;
let garbageCollectionTail: Promise<void> = Promise.resolve();
let persistenceBarrier: Promise<void> | null = null;
let releasePersistenceBarrier: (() => void) | null = null;
let collectWindowAttachmentIds: () => Iterable<string> = () => [];
let otherWindowHolds: OtherWindowHolds | null = null;

/**
 * Names every attachment this window holds in memory (drafts, queued messages, screenshots), so
 * another window's sweep keeps them. The draft store registers it, as it already gathers them for
 * its own sweep.
 */
export function setWindowAttachmentIdsCollector(collect: () => Iterable<string>): void {
  collectWindowAttachmentIds = collect;
}

function getOtherWindowHolds(): OtherWindowHolds {
  otherWindowHolds ??= createOtherWindowHolds({
    channel: defaultHoldChannel(),
    closeSource: defaultWindowCloseSource(),
    holdForPeerSweep,
  });
  return otherWindowHolds;
}

/** Starts answering other windows' sweeps; the app calls it once at start. */
export function startAnsweringOtherWindowSweeps(): void {
  getOtherWindowHolds();
}

/** Test-only hook: this module instance speaks on the given channel, as one app window. */
export function __useOtherWindowChannelForTests(
  channel: HoldChannel | null,
  options: { windowId?: string; replyTimeoutMs?: number; discoveryMs?: number } = {},
): void {
  otherWindowHolds = channel
    ? createOtherWindowHolds({ channel, holdForPeerSweep, ...options })
    : null;
}

function beginPersistenceHold(): () => void {
  pendingGarbageCollections += 1;
  if (!persistenceBarrier) {
    persistenceBarrier = new Promise<void>((resolve) => {
      releasePersistenceBarrier = resolve;
    });
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    pendingGarbageCollections -= 1;
    if (pendingGarbageCollections === 0) {
      persistedDuringGarbageCollection.clear();
      const release = releasePersistenceBarrier;
      releasePersistenceBarrier = null;
      persistenceBarrier = null;
      release?.();
    }
  };
}

async function waitForActivePersistence(): Promise<void> {
  while (activePersistence.size > 0) {
    await Promise.allSettled(activePersistence);
  }
}

function collectRecentlyPersistedIds(nowMs: number): string[] {
  for (const [id, persistedAt] of recentlyPersisted) {
    if (nowMs - persistedAt > RECENT_PERSISTENCE_MS) recentlyPersisted.delete(id);
  }
  return Array.from(recentlyPersisted.keys());
}

async function holdForPeerSweep(): Promise<{
  heldIds: ReadonlySet<string>;
  release: () => void;
}> {
  const release = beginPersistenceHold();
  try {
    await waitForActivePersistence();
    const heldIds = new Set<string>(collectWindowAttachmentIds());
    for (const id of collectRetainedAttachmentIds()) heldIds.add(id);
    for (const id of persistedDuringGarbageCollection) heldIds.add(id);
    for (const id of collectRecentlyPersistedIds(Date.now())) heldIds.add(id);
    return { heldIds, release };
  } catch (error) {
    release();
    throw error;
  }
}

async function waitForPersistenceBarrier(): Promise<void> {
  const barrier = persistenceBarrier;
  if (!barrier) {
    return;
  }
  await barrier;
  await waitForPersistenceBarrier();
}

async function persistAttachment(input: SaveAttachmentInput): Promise<AttachmentMetadata> {
  await waitForPersistenceBarrier();
  const pending = (async () => {
    const store = await getAttachmentStore();
    const attachment = await store.save(input);
    const persistedAt = Date.now();
    collectRecentlyPersistedIds(persistedAt);
    recentlyPersisted.set(attachment.id, persistedAt);
    if (pendingGarbageCollections > 0) {
      persistedDuringGarbageCollection.add(attachment.id);
    }
    return attachment;
  })();
  activePersistence.add(pending);
  try {
    return await pending;
  } finally {
    activePersistence.delete(pending);
  }
}

export async function persistAttachmentFromBlob(input: {
  blob: Blob;
  mimeType?: string;
  fileName?: string | null;
  id?: string;
}): Promise<AttachmentMetadata> {
  return await persistAttachment({
    id: input.id,
    mimeType: input.mimeType,
    fileName: input.fileName,
    source: { kind: "blob", blob: input.blob },
  });
}

export async function persistAttachmentFromDataUrl(input: {
  dataUrl: string;
  mimeType?: string;
  fileName?: string | null;
  id?: string;
}): Promise<AttachmentMetadata> {
  return await persistAttachment({
    id: input.id,
    mimeType: input.mimeType,
    fileName: input.fileName,
    source: { kind: "data_url", dataUrl: input.dataUrl },
  });
}

export async function persistAttachmentFromBytes(input: {
  bytes: Uint8Array;
  mimeType?: string;
  fileName?: string | null;
  id?: string;
}): Promise<AttachmentMetadata> {
  return await persistAttachment({
    id: input.id,
    mimeType: input.mimeType,
    fileName: input.fileName,
    source: { kind: "bytes", bytes: input.bytes },
  });
}

export async function persistAttachmentFromFileUri(input: {
  uri: string;
  mimeType?: string;
  fileName?: string | null;
  id?: string;
}): Promise<AttachmentMetadata> {
  return await persistAttachment({
    id: input.id,
    mimeType: input.mimeType,
    fileName: input.fileName,
    source: { kind: "file_uri", uri: input.uri },
  });
}

export async function encodeAttachmentsForSend(
  attachments: readonly AttachmentMetadata[] | undefined,
): Promise<Array<{ data: string; mimeType: string }> | undefined> {
  if (!attachments || attachments.length === 0) {
    return undefined;
  }

  const store = await getAttachmentStore();
  const encoded = await Promise.all(
    attachments.map(async (attachment) => {
      try {
        const data = await store.encodeBase64({ attachment });
        return {
          data,
          mimeType: attachment.mimeType,
        };
      } catch (error) {
        console.error("[attachments] Failed to encode attachment for send", {
          id: attachment.id,
          error,
        });
        return null;
      }
    }),
  );

  const valid = encoded.filter(
    (entry): entry is { data: string; mimeType: string } => entry !== null,
  );
  return valid.length > 0 ? valid : undefined;
}

export async function resolveAttachmentPreviewUrl(attachment: AttachmentMetadata): Promise<string> {
  const store = await getAttachmentStore();
  return await store.resolvePreviewUrl({ attachment });
}

export async function releaseAttachmentPreviewUrl(input: {
  attachment: AttachmentMetadata;
  url: string;
}): Promise<void> {
  const store = await getAttachmentStore();
  if (!store.releasePreviewUrl) {
    return;
  }
  await store.releasePreviewUrl({ attachment: input.attachment, url: input.url });
}

export async function deleteAttachments(
  attachments: readonly AttachmentMetadata[] | undefined,
): Promise<void> {
  if (!attachments || attachments.length === 0) {
    return;
  }
  const store = await getAttachmentStore();
  await Promise.all(
    attachments.map(async (attachment) => {
      try {
        await store.delete({ attachment });
      } catch (error) {
        console.warn("[attachments] Failed to delete attachment", {
          id: attachment.id,
          error,
        });
      }
    }),
  );
}

export async function garbageCollectAttachments(input: {
  referencedIds: ReadonlySet<string>;
}): Promise<void> {
  const holds = getOtherWindowHolds();
  // Before this window holds its own saves: a start-up sweep first learns the open windows.
  await holds.whenDiscovered();
  const releaseHold = beginPersistenceHold();

  const previousGarbageCollection = garbageCollectionTail;
  const currentGarbageCollection = (async () => {
    await previousGarbageCollection;
    await waitForActivePersistence();
    const otherWindows = await holds.beginSweep();
    if (!otherWindows) {
      console.warn("[attachments] Skipped a sweep: another app window did not say what it holds");
      return;
    }
    try {
      // Read again now, as the caller's ids may predate the waits above.
      const referencedIds = new Set(input.referencedIds);
      for (const id of collectWindowAttachmentIds()) {
        referencedIds.add(id);
      }
      for (const id of collectRetainedAttachmentIds()) {
        referencedIds.add(id);
      }
      for (const id of persistedDuringGarbageCollection) {
        referencedIds.add(id);
      }
      for (const id of collectRecentlyPersistedIds(Date.now())) {
        referencedIds.add(id);
      }
      for (const id of otherWindows.heldIds) {
        referencedIds.add(id);
      }
      const store = await getAttachmentStore();
      if (!otherWindows.isHeld()) {
        console.warn("[attachments] Skipped a sweep: the other app windows' hold ran out");
        return;
      }
      await store.garbageCollect({ referencedIds });
    } finally {
      otherWindows.finish();
    }
  })();
  garbageCollectionTail = currentGarbageCollection.catch(() => undefined);

  try {
    await currentGarbageCollection;
  } finally {
    releaseHold();
  }
}
