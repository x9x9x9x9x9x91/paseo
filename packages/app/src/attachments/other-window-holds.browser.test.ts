import { afterEach, describe, expect, it } from "vitest";
import { persistAttachmentFromDataUrl } from "@/attachments/service";
import { getAttachmentStore } from "@/attachments/store";
import {
  resetWorkspaceAttachmentsStore,
  useWorkspaceAttachmentsStore,
} from "@/attachments/workspace-attachments-store";
import { useDraftStore } from "@/stores/draft-store";

const PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

interface Reply {
  type: "reply";
  to: string;
  sweepId: string;
  ids: string[];
}

function post(channel: BroadcastChannel, message: unknown): void {
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- a BroadcastChannel takes no origin: it reaches only its own.
  channel.postMessage(message);
}

/**
 * What another app window's sweep does: asks on the channel every window of the origin shares
 * and waits for this window's answer.
 */
function askAsOtherWindow(channel: BroadcastChannel, sweepId: string): Promise<Reply> {
  return new Promise((resolve) => {
    const listener = (event: MessageEvent) => {
      const message = event.data as Partial<Reply>;
      if (message.type === "reply" && message.to === "other" && message.sweepId === sweepId) {
        channel.removeEventListener("message", listener);
        resolve(message as Reply);
      }
    };
    channel.addEventListener("message", listener);
    post(channel, { type: "request", from: "other", sweepId });
  });
}

describe("attachment holds across app windows", () => {
  const channel = new BroadcastChannel("paseo-attachment-holds");

  afterEach(() => {
    resetWorkspaceAttachmentsStore();
  });

  it("names a browser element's screenshot held only in this window when another window sweeps", async () => {
    // Saved past the service, so only the workspace store names it, not the recent saves.
    const store = await getAttachmentStore();
    const screenshot = await store.save({
      source: { kind: "data_url", dataUrl: PNG },
      mimeType: "image/png",
    });
    useWorkspaceAttachmentsStore.getState().addWorkspaceAttachment({
      scopeKey: "workspace:test",
      attachment: {
        kind: "browser_element",
        attachment: {
          url: "http://localhost/",
          selector: "button",
          tag: "button",
          text: "Send",
          outerHTML: "<button>Send</button>",
          computedStyles: {},
          boundingRect: { x: 0, y: 0, width: 10, height: 10 },
          reactSource: null,
          parentChain: [],
          children: [],
          screenshot,
          formatted: "button",
        },
      },
    });

    expect(useDraftStore.getState().collectActiveAttachmentIds()).not.toContain(screenshot.id);
    const reply = await askAsOtherWindow(channel, "sweep-1");
    expect(reply.ids).toContain(screenshot.id);
    post(channel, { type: "done", from: "other", sweepId: "sweep-1" });
  });

  it("holds this window's saves until the other window's sweep is done", async () => {
    await askAsOtherWindow(channel, "sweep-2");
    let saved = false;
    const save = persistAttachmentFromDataUrl({ dataUrl: PNG, mimeType: "image/png" }).then(
      (attachment) => {
        saved = true;
        return attachment;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(saved).toBe(false);

    post(channel, { type: "done", from: "other", sweepId: "sweep-2" });
    await save;
    expect(saved).toBe(true);
  });
});
