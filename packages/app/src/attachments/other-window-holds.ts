import { isWeb } from "@/constants/platform";

/** A same-origin `BroadcastChannel`, as the exchange uses it, so a test can pass its own. */
export interface HoldChannel {
  send(message: unknown): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
}

export interface WindowCloseSource {
  addEventListener(type: "pagehide", listener: () => void): void;
}

type HoldMessage =
  | { type: "hello"; from: string }
  | { type: "here"; from: string }
  | { type: "bye"; from: string }
  | { type: "request"; from: string; sweepId: string }
  | { type: "reply"; from: string; to: string; sweepId: string; ids: string[] }
  | { type: "done"; from: string; sweepId: string };

const MESSAGE_TYPES = new Set(["hello", "here", "bye", "request", "reply", "done"]);

function readMessage(data: unknown): HoldMessage | null {
  if (!data || typeof data !== "object") return null;
  const message = data as { type?: unknown; from?: unknown };
  if (typeof message.type !== "string" || !MESSAGE_TYPES.has(message.type)) return null;
  if (typeof message.from !== "string") return null;
  return data as HoldMessage;
}

export interface OtherWindowSweep {
  /** Every attachment id another open window holds, read before this window deletes anything. */
  heldIds: ReadonlySet<string>;
  /** Lets the other windows save again. Call it once the store's sweep has ended. */
  finish(): void;
}

export interface OtherWindowHolds {
  /**
   * Asks every other open window for the attachments it holds and has them hold their saves
   * until `finish`. Resolves null when a window did not answer in time: the sweep is skipped,
   * and that window is forgotten until it speaks again.
   */
  beginSweep(): Promise<OtherWindowSweep | null>;
}

interface PendingSweep {
  waitingOn: Set<string>;
  heldIds: Set<string>;
  settle: () => void;
}

/**
 * The windows of one app share one attachment store, while some of what each holds lives in its
 * memory only (a browser element's screenshot, a queued message's images, a draft inside its
 * write interval). A sweep deletes what it does not know is held, so before it runs, the sweeping
 * window asks the others over a same-origin channel and keeps what they name (ALM-5125). A window
 * that answers holds its own saves until the sweep is done, so nothing it saves meanwhile is
 * swept. Native runs one window, so it has no channel and no one to ask.
 */
export function createOtherWindowHolds(params: {
  channel: HoldChannel | null;
  closeSource?: WindowCloseSource | null;
  /** Holds this window's saves, waits for the ones under way and returns what it holds. */
  holdForPeerSweep: () => Promise<{ heldIds: ReadonlySet<string>; release: () => void }>;
  windowId?: string;
  replyTimeoutMs?: number;
  holdTimeoutMs?: number;
}): OtherWindowHolds {
  const { channel } = params;
  if (!channel) {
    return {
      async beginSweep() {
        return { heldIds: new Set(), finish: () => {} };
      },
    };
  }

  const windowId =
    params.windowId ?? `window_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  const replyTimeoutMs = params.replyTimeoutMs ?? 3000;
  const holdTimeoutMs = params.holdTimeoutMs ?? 10_000;
  const peers = new Set<string>();
  const pendingSweeps = new Map<string, PendingSweep>();
  const activeSweepIds = new Set<string>();
  const heldForPeers = new Map<string, () => void>();
  let sweepCounter = 0;

  const post = (message: HoldMessage) => channel.send(message);

  function releasePeerHold(key: string): void {
    const release = heldForPeers.get(key);
    if (!release) return;
    heldForPeers.delete(key);
    release();
  }

  async function answerRequest(from: string, sweepId: string): Promise<void> {
    const key = `${from}:${sweepId}`;
    if (heldForPeers.has(key)) return;
    heldForPeers.set(key, () => {});
    const hold = await params.holdForPeerSweep();
    if (!heldForPeers.has(key)) {
      hold.release();
      return;
    }
    const timer = setTimeout(() => releasePeerHold(key), holdTimeoutMs);
    heldForPeers.set(key, () => {
      clearTimeout(timer);
      hold.release();
    });
    post({ type: "reply", from: windowId, to: from, sweepId, ids: Array.from(hold.heldIds) });
  }

  function forgetPeer(peerId: string): void {
    peers.delete(peerId);
    for (const key of Array.from(heldForPeers.keys())) {
      if (key.startsWith(`${peerId}:`)) releasePeerHold(key);
    }
    for (const pending of pendingSweeps.values()) {
      if (pending.waitingOn.delete(peerId) && pending.waitingOn.size === 0) pending.settle();
    }
  }

  channel.addEventListener("message", (event) => {
    const message = readMessage(event.data);
    if (!message || message.from === windowId) return;
    switch (message.type) {
      case "hello":
        peers.add(message.from);
        post({ type: "here", from: windowId });
        // A window opened while this one sweeps holds its saves until the sweep is done.
        for (const sweepId of activeSweepIds) {
          post({ type: "request", from: windowId, sweepId });
        }
        return;
      case "here":
        peers.add(message.from);
        return;
      case "bye":
        forgetPeer(message.from);
        return;
      case "request":
        peers.add(message.from);
        void answerRequest(message.from, message.sweepId);
        return;
      case "done":
        releasePeerHold(`${message.from}:${message.sweepId}`);
        return;
      case "reply": {
        peers.add(message.from);
        if (message.to !== windowId) return;
        const pending = pendingSweeps.get(message.sweepId);
        if (!pending) return;
        for (const id of message.ids) {
          if (typeof id === "string") pending.heldIds.add(id);
        }
        if (pending.waitingOn.delete(message.from) && pending.waitingOn.size === 0) {
          pending.settle();
        }
        return;
      }
    }
  });

  params.closeSource?.addEventListener("pagehide", () => {
    post({ type: "bye", from: windowId });
    for (const key of Array.from(heldForPeers.keys())) releasePeerHold(key);
  });

  post({ type: "hello", from: windowId });

  return {
    async beginSweep() {
      sweepCounter += 1;
      const sweepId = `${windowId}:${sweepCounter}`;
      activeSweepIds.add(sweepId);
      const finish = () => {
        if (!activeSweepIds.delete(sweepId)) return;
        post({ type: "done", from: windowId, sweepId });
      };
      if (peers.size === 0) {
        return { heldIds: new Set(), finish };
      }

      const waitingOn = new Set(peers);
      const heldIds = new Set<string>();
      let settle: () => void = () => {};
      const answered = new Promise<void>((resolve) => {
        settle = resolve;
      });
      const timer = setTimeout(() => settle(), replyTimeoutMs);
      pendingSweeps.set(sweepId, { waitingOn, heldIds, settle: () => settle() });
      post({ type: "request", from: windowId, sweepId });
      await answered;
      clearTimeout(timer);
      pendingSweeps.delete(sweepId);

      if (waitingOn.size > 0) {
        for (const peerId of waitingOn) peers.delete(peerId);
        finish();
        return null;
      }
      return { heldIds, finish };
    },
  };
}

export function defaultHoldChannel(): HoldChannel | null {
  if (!isWeb || typeof window === "undefined" || typeof BroadcastChannel !== "function") {
    return null;
  }
  const channel = new BroadcastChannel("paseo-attachment-holds");
  return {
    // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a BroadcastChannel takes no origin: it reaches only its own.
    send: (message) => channel.postMessage(message),
    addEventListener: (type, listener) => channel.addEventListener(type, listener),
  };
}

export function defaultWindowCloseSource(): WindowCloseSource | null {
  if (!isWeb || typeof window === "undefined" || typeof window.addEventListener !== "function") {
    return null;
  }
  return window;
}
