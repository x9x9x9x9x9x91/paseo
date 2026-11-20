import { isWeb } from "@/constants/platform";

/** A same-origin `BroadcastChannel`, as the exchange uses it, so a test can pass its own. */
export interface HoldChannel {
  send(message: unknown): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
}

/** The page's leave and return, so a test can pass its own. */
export interface WindowCloseSource {
  onPageHide(listener: () => void): void;
  /** `restored`: the browser kept the page and shows it again, as `pageshow`'s `persisted`. */
  onPageShow(listener: (restored: boolean) => void): void;
  /** The browser froze the page without a pagehide and now runs it again (`resume`). */
  onResume(listener: () => void): void;
}

type HoldMessage =
  | { type: "hello"; from: string }
  | { type: "here"; from: string }
  | { type: "bye"; from: string }
  | { type: "ping"; from: string; sweepId: string }
  | { type: "pong"; from: string; to: string; sweepId: string }
  | { type: "request"; from: string; sweepId: string }
  | { type: "reply"; from: string; to: string; sweepId: string; ids: string[] }
  | { type: "done"; from: string; sweepId: string };

const MESSAGE_TYPES = new Set(["hello", "here", "bye", "ping", "pong", "request", "reply", "done"]);

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
  /**
   * Whether the other windows still hold their saves, so a sweep that lists the store now sees
   * none of theirs it was not told of. False once half their hold has passed.
   */
  isHeld(): boolean;
  /** Lets the other windows save again. Call it once the store's sweep has ended. */
  finish(): void;
}

export interface OtherWindowHolds {
  /**
   * Resolves once the windows already open have had time to say so after this one's hello, so
   * a start-up sweep does not run before it knows them. Await it before holding any save.
   */
  whenDiscovered(): Promise<void>;
  /**
   * Asks every other open window for the attachments it holds and has them hold their saves
   * until `finish`. Resolves null when a window did not answer in time: the sweep is skipped.
   * A window is forgotten only once it has missed two requests in a row and said nothing for a
   * whole hold timeout, so a slow window is waited for again, a queued sweep too, and a gone one
   * costs a few skipped sweeps.
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
  discoveryMs?: number;
}): OtherWindowHolds {
  const { channel } = params;
  if (!channel) {
    return {
      async whenDiscovered() {},
      async beginSweep() {
        return { heldIds: new Set(), isHeld: () => true, finish: () => {} };
      },
    };
  }

  const windowId =
    params.windowId ?? `window_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  const replyTimeoutMs = params.replyTimeoutMs ?? 3000;
  const holdTimeoutMs = params.holdTimeoutMs ?? 10_000;
  const discoveryMs = params.discoveryMs ?? replyTimeoutMs;
  const peers = new Set<string>();
  // Requests each peer missed in a row, and when each last said anything.
  const missedRequests = new Map<string, number>();
  const lastHeardAt = new Map<string, number>();
  let closing = false;
  const pendingSweeps = new Map<string, PendingSweep>();
  const activeSweepIds = new Set<string>();
  // Sweeps past their request phase, about to list the store.
  const listingSweepIds = new Set<string>();
  const heldForPeers = new Map<string, () => void>();
  let sweepCounter = 0;

  const post = (message: HoldMessage) => channel.send(message);
  const pendingKey = (phase: "ping" | "request", sweepId: string) => `${phase}:${sweepId}`;

  /** Counts a peer's answer to this window's ping or request, and its named ids. */
  function takeAnswer(
    phase: "ping" | "request",
    message: { from: string; to: string; sweepId: string },
    ids: readonly unknown[] = [],
  ): void {
    if (message.to !== windowId) return;
    const pending = pendingSweeps.get(pendingKey(phase, message.sweepId));
    if (!pending?.waitingOn.has(message.from)) return;
    for (const id of ids) {
      if (typeof id === "string") pending.heldIds.add(id);
    }
    pending.waitingOn.delete(message.from);
    if (pending.waitingOn.size === 0) pending.settle();
  }

  /** Posts `ask` and waits until every peer in `waitingOn` has answered, or the reply timeout. */
  async function collectAnswers(
    phase: "ping" | "request",
    sweepId: string,
    waitingOn: Set<string>,
    heldIds: Set<string>,
    ask: () => void,
  ): Promise<void> {
    let settle: () => void = () => {};
    const answered = new Promise<void>((resolve) => {
      settle = resolve;
    });
    const timer = setTimeout(() => settle(), replyTimeoutMs);
    pendingSweeps.set(pendingKey(phase, sweepId), {
      waitingOn,
      heldIds,
      settle: () => settle(),
    });
    ask();
    await answered;
    clearTimeout(timer);
    pendingSweeps.delete(pendingKey(phase, sweepId));
  }

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
    let hold: Awaited<ReturnType<typeof params.holdForPeerSweep>>;
    try {
      hold = await params.holdForPeerSweep();
    } catch (error) {
      // No answer: the sweep skips, as for a window that does not answer.
      heldForPeers.delete(key);
      console.warn("[attachments] Could not say what this window holds", error);
      return;
    }
    if (!heldForPeers.has(key)) {
      // The sweep gave up on this window first; saying so keeps it known for the next one.
      hold.release();
      if (!closing) post({ type: "here", from: windowId });
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
    missedRequests.delete(peerId);
    lastHeardAt.delete(peerId);
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
    missedRequests.delete(message.from);
    lastHeardAt.set(message.from, Date.now());
    switch (message.type) {
      case "hello":
        peers.add(message.from);
        post({ type: "here", from: windowId });
        // A window opened while this one lists the store holds its saves until it is done.
        for (const sweepId of listingSweepIds) {
          post({ type: "request", from: windowId, sweepId });
        }
        return;
      case "here":
        peers.add(message.from);
        return;
      case "bye":
        forgetPeer(message.from);
        return;
      case "ping":
        peers.add(message.from);
        if (!closing) {
          post({ type: "pong", from: windowId, to: message.from, sweepId: message.sweepId });
        }
        return;
      case "pong":
        peers.add(message.from);
        takeAnswer("ping", message);
        return;
      case "request":
        peers.add(message.from);
        void answerRequest(message.from, message.sweepId);
        return;
      case "done":
        releasePeerHold(`${message.from}:${message.sweepId}`);
        return;
      case "reply":
        peers.add(message.from);
        takeAnswer("request", message, message.ids);
        return;
    }
  });

  /** Says hello, resolving once the open windows have had time to answer it. */
  function announce(): Promise<void> {
    post({ type: "hello", from: windowId });
    return new Promise<void>((resolve) => {
      setTimeout(resolve, discoveryMs);
    });
  }
  let discovered = announce();

  params.closeSource?.onPageHide(() => {
    closing = true;
    post({ type: "bye", from: windowId });
    for (const key of Array.from(heldForPeers.keys())) releasePeerHold(key);
  });
  // A page the browser kept and shows again said bye on leaving, so it says hello once more,
  // and learns anew the windows opened while it was away before it sweeps.
  params.closeSource?.onPageShow((restored) => {
    if (!restored) return;
    closing = false;
    discovered = announce();
  });
  // A frozen page sent no bye and may have been forgotten, so it says hello once more.
  params.closeSource?.onResume(() => {
    discovered = announce();
  });

  return {
    whenDiscovered: () => discovered,
    async beginSweep() {
      const nowMs = Date.now();
      for (const [peerId, missed] of missedRequests) {
        if (missed < 2 || nowMs - (lastHeardAt.get(peerId) ?? 0) < holdTimeoutMs) continue;
        peers.delete(peerId);
        missedRequests.delete(peerId);
        lastHeardAt.delete(peerId);
      }
      sweepCounter += 1;
      const sweepId = `${windowId}:${sweepCounter}`;
      activeSweepIds.add(sweepId);
      const finish = () => {
        listingSweepIds.delete(sweepId);
        if (!activeSweepIds.delete(sweepId)) return;
        post({ type: "done", from: windowId, sweepId });
      };
      if (peers.size === 0) {
        return { heldIds: new Set(), isHeld: () => true, finish };
      }

      const missAll = (missing: Set<string>) => {
        for (const peerId of missing) {
          missedRequests.set(peerId, (missedRequests.get(peerId) ?? 0) + 1);
        }
        finish();
        return null;
      };

      // First a ping no one holds anything for, so the windows that answer do not hold their
      // saves while this one waits out a window that is gone.
      const unanswered = new Set(peers);
      await collectAnswers("ping", sweepId, unanswered, new Set(), () =>
        post({ type: "ping", from: windowId, sweepId }),
      );
      if (unanswered.size > 0) return missAll(unanswered);

      const waitingOn = new Set(peers);
      const heldIds = new Set<string>();
      const requestedAt = Date.now();
      await collectAnswers("request", sweepId, waitingOn, heldIds, () =>
        post({ type: "request", from: windowId, sweepId }),
      );

      if (waitingOn.size > 0) return missAll(waitingOn);
      listingSweepIds.add(sweepId);
      const isHeld = () => Date.now() - requestedAt < holdTimeoutMs / 2;
      return { heldIds, isHeld, finish };
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
  return {
    onPageHide: (listener) => window.addEventListener("pagehide", () => listener()),
    onPageShow: (listener) =>
      window.addEventListener("pageshow", (event) => listener(event.persisted)),
    onResume: (listener) => document.addEventListener("resume", () => listener()),
  };
}
