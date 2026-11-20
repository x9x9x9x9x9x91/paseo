import { afterEach, describe, expect, it, vi } from "vitest";
import type { HoldChannel } from "@/attachments/other-window-holds";
import type { AttachmentMetadata, AttachmentStore } from "@/attachments/types";

type ServiceModule = typeof import("./service");

/** One origin's BroadcastChannel: a message reaches every other channel on the bus, later. */
function createBus() {
  const channels = new Set<Set<(event: { data: unknown }) => void>>();
  return {
    channel(): HoldChannel {
      const listeners = new Set<(event: { data: unknown }) => void>();
      channels.add(listeners);
      return {
        send(message) {
          const data = structuredClone(message);
          for (const other of channels) {
            if (other === listeners) continue;
            setTimeout(() => {
              for (const listener of other) listener({ data });
            }, 0);
          }
        },
        addEventListener(_type, listener) {
          listeners.add(listener);
        },
      };
    },
  };
}

function createAttachment(id: string): AttachmentMetadata {
  return {
    id,
    mimeType: "image/png",
    storageType: "web-indexeddb",
    storageKey: id,
    fileName: null,
    byteSize: 3,
    createdAt: 1700000000000,
  };
}

/** The store every window shares; a sweep lists it only once `sweepGate` opens. */
function createSharedStore(initialIds: string[]) {
  const ids = new Set(initialIds);
  const saves: string[] = [];
  let sweepGate: Promise<void> = Promise.resolve();
  let saveGate: Promise<void> = Promise.resolve();
  const store: AttachmentStore = {
    storageType: "web-indexeddb",
    async save(input) {
      await saveGate;
      const id = input.id ?? `generated_${saves.length}`;
      saves.push(id);
      ids.add(id);
      return createAttachment(id);
    },
    async encodeBase64({ attachment }) {
      return attachment.id;
    },
    async resolvePreviewUrl({ attachment }) {
      return `blob:${attachment.id}`;
    },
    async delete({ attachment }) {
      ids.delete(attachment.id);
    },
    async garbageCollect({ referencedIds }) {
      await sweepGate;
      for (const id of Array.from(ids)) {
        if (!referencedIds.has(id)) ids.delete(id);
      }
    },
  };
  return {
    store,
    ids,
    saves,
    gateSaves(): () => void {
      let open: () => void = () => undefined;
      saveGate = new Promise<void>((resolve) => {
        open = resolve;
      });
      return open;
    },
    gateSweeps(): () => void {
      let open: () => void = () => undefined;
      sweepGate = new Promise<void>((resolve) => {
        open = resolve;
      });
      return open;
    },
  };
}

/** A fresh copy of the attachment service, as one app window loads it. */
async function openWindow(
  channel: HoldChannel,
  store: AttachmentStore,
  options: { replyTimeoutMs?: number; holdTimeoutMs?: number; discoveryMs?: number } = {},
): Promise<ServiceModule> {
  vi.resetModules();
  const service = await import("./service");
  const storeModule = await import("./store");
  storeModule.__setAttachmentStoreForTests(store);
  service.__useOtherWindowChannelForTests(channel, { discoveryMs: 20, ...options });
  return service;
}

function settle(ms = 5): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const bytes = { bytes: new Uint8Array([1, 2, 3]), mimeType: "image/png" };

describe("attachment sweeps across app windows", () => {
  afterEach(() => {
    vi.resetModules();
  });

  it("keeps an attachment another window holds only in its memory", async () => {
    const bus = createBus();
    const shared = createSharedStore(["screenshot", "orphan"]);
    const windowA = await openWindow(bus.channel(), shared.store);
    windowA.setWindowAttachmentIdsCollector(() => ["screenshot"]);
    const windowB = await openWindow(bus.channel(), shared.store);
    await settle();

    await windowB.garbageCollectAttachments({ referencedIds: new Set() });

    expect(Array.from(shared.ids)).toEqual(["screenshot"]);
  });

  it("keeps what an open window holds in a newly opened window's start-up sweep", async () => {
    const bus = createBus();
    const shared = createSharedStore(["screenshot", "orphan"]);
    const windowA = await openWindow(bus.channel(), shared.store);
    windowA.setWindowAttachmentIdsCollector(() => ["screenshot"]);
    const windowB = await openWindow(bus.channel(), shared.store);

    await windowB.garbageCollectAttachments({ referencedIds: new Set() });

    expect(Array.from(shared.ids)).toEqual(["screenshot"]);
  });

  it("keeps an attachment another window saved before it holds it anywhere", async () => {
    const bus = createBus();
    const shared = createSharedStore([]);
    const windowA = await openWindow(bus.channel(), shared.store);
    const windowB = await openWindow(bus.channel(), shared.store);
    await settle();

    await windowA.persistAttachmentFromBytes({ id: "picked", ...bytes });
    await windowB.garbageCollectAttachments({ referencedIds: new Set() });

    expect(Array.from(shared.ids)).toEqual(["picked"]);
  });

  it("holds another window's save until the sweep has ended", async () => {
    const bus = createBus();
    const shared = createSharedStore([]);
    const windowA = await openWindow(bus.channel(), shared.store);
    const windowB = await openWindow(bus.channel(), shared.store);
    // Past B's discovery wait, so B's request is out before A saves.
    await settle(30);
    const openSweep = shared.gateSweeps();

    const sweep = windowB.garbageCollectAttachments({ referencedIds: new Set() });
    await settle();
    const save = windowA.persistAttachmentFromBytes({ id: "late", ...bytes });
    await settle();
    expect(shared.saves).toEqual([]);

    openSweep();
    await Promise.all([sweep, save]);

    expect(shared.saves).toEqual(["late"]);
    expect(Array.from(shared.ids)).toEqual(["late"]);
  });

  it("skips sweeps while another window does not answer, then forgets that window", async () => {
    const bus = createBus();
    const shared = createSharedStore(["orphan"]);
    const silentWindow = bus.channel();
    const windowB = await openWindow(bus.channel(), shared.store, {
      replyTimeoutMs: 30,
      holdTimeoutMs: 50,
    });
    silentWindow.send({ type: "hello", from: "silent" });
    await settle();

    await windowB.garbageCollectAttachments({ referencedIds: new Set() });
    await windowB.garbageCollectAttachments({ referencedIds: new Set() });
    expect(Array.from(shared.ids)).toEqual(["orphan"]);

    // Two requests missed in a row and silent past the hold timeout: gone.
    await windowB.garbageCollectAttachments({ referencedIds: new Set() });
    expect(Array.from(shared.ids)).toEqual([]);
  });

  it("waits again for a window that answered late instead of forgetting it", async () => {
    const bus = createBus();
    const shared = createSharedStore(["screenshot", "orphan"]);
    const windowA = await openWindow(bus.channel(), shared.store);
    windowA.setWindowAttachmentIdsCollector(() => ["screenshot"]);
    const windowB = await openWindow(bus.channel(), shared.store, { replyTimeoutMs: 30 });
    await settle();
    // A answers only once its save under way ends, past B's wait.
    const openSave = shared.gateSaves();
    const save = windowA.persistAttachmentFromBytes({ id: "large", ...bytes });
    await settle();

    await windowB.garbageCollectAttachments({ referencedIds: new Set() });
    expect(Array.from(shared.ids)).toEqual(["screenshot", "orphan"]);
    // A sweep queued behind the first (a draft saved meanwhile) still waits for A.
    await windowB.garbageCollectAttachments({ referencedIds: new Set() });
    expect(Array.from(shared.ids)).toEqual(["screenshot", "orphan"]);
    openSave();
    await save;
    await settle();

    await windowB.garbageCollectAttachments({ referencedIds: new Set() });
    expect(Array.from(shared.ids).toSorted()).toEqual(["large", "screenshot"]);
  });

  it("does not wait on a window that has closed", async () => {
    const bus = createBus();
    const shared = createSharedStore(["orphan"]);
    const closedWindow = bus.channel();
    const windowB = await openWindow(bus.channel(), shared.store, { replyTimeoutMs: 60_000 });
    closedWindow.send({ type: "hello", from: "closed" });
    await settle();
    closedWindow.send({ type: "bye", from: "closed" });
    await settle();

    await windowB.garbageCollectAttachments({ referencedIds: new Set() });

    expect(Array.from(shared.ids)).toEqual([]);
  });
});
