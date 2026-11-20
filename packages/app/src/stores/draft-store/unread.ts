import type { StateStorage } from "zustand/middleware";
import { PersistedComposerAttachmentSchema, PersistedDraftRecordSchema } from "./migration";
import type { DraftRecord, DraftStoreState } from "./state";

/** An attachment this build cannot read, at its place in its draft's list. */
interface UnreadAttachment {
  index: number;
  raw: unknown;
}

/** What one stored draft holds that this build cannot read. */
interface UnreadSlot {
  /** The whole draft, when this build cannot read it, such as one of a later lifecycle. */
  whole?: unknown;
  /** The attachments of a draft this build reads, those of a kind it does not know. */
  attachments?: UnreadAttachment[];
}

interface UnreadDrafts {
  drafts: Map<string, UnreadSlot>;
  createModalDraft: UnreadSlot;
}

export interface UnreadDraftEntries {
  /** The drafts' storage, which reads what it cannot parse aside and writes it back. */
  storage: StateStorage;
  /** Drops what a draft this build cleared, sent or replaced held. */
  forgetReplaced: (state: DraftStoreState) => void;
  /** Every string the unread entries hold, their attachment ids among them, for the sweep. */
  heldStrings: () => Set<string>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emptyUnread(): UnreadDrafts {
  return { drafts: new Map(), createModalDraft: {} };
}

function storedAttachmentsOf(record: unknown): unknown[] | null {
  if (!isRecord(record) || !isRecord(record.input)) return null;
  return Array.isArray(record.input.attachments) ? record.input.attachments : null;
}

function readSlot(record: unknown): UnreadSlot {
  if (record === null || record === undefined) return {};
  if (!PersistedDraftRecordSchema.safeParse(record).success) return { whole: record };
  const attachments = (storedAttachmentsOf(record) ?? []).flatMap((raw, index) =>
    PersistedComposerAttachmentSchema.safeParse(raw).success ? [] : [{ index, raw }],
  );
  return attachments.length > 0 ? { attachments } : {};
}

function readUnread(text: string | null): UnreadDrafts {
  const unread = emptyUnread();
  if (text === null) return unread;
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    return unread;
  }
  if (!isRecord(decoded) || !isRecord(decoded.state)) return unread;
  const { drafts, createModalDraft } = decoded.state;
  if (isRecord(drafts)) {
    for (const [draftKey, record] of Object.entries(drafts)) {
      const slot = readSlot(record);
      if (slot.whole !== undefined || slot.attachments) unread.drafts.set(draftKey, slot);
    }
  }
  unread.createModalDraft = readSlot(createModalDraft);
  return unread;
}

function isActive(record: DraftRecord | null | undefined): boolean {
  return record?.lifecycle === "active";
}

/** The slot as it stands once `record` is what this build holds for that draft. */
function forgetSlot(slot: UnreadSlot, record: DraftRecord | null | undefined): UnreadSlot {
  const next: UnreadSlot = {};
  // A draft of this build's own in its place replaces the one it could not read.
  if (slot.whole !== undefined && !record) next.whole = slot.whole;
  // Cleared, sent or gone: the attachments went with it, as this build's own would.
  if (slot.attachments && isActive(record)) next.attachments = slot.attachments;
  return next;
}

function isEmptySlot(slot: UnreadSlot): boolean {
  return slot.whole === undefined && !slot.attachments;
}

function withUnreadAttachments(record: unknown, attachments: readonly UnreadAttachment[]): unknown {
  const stored = storedAttachmentsOf(record);
  if (!isRecord(record) || !isRecord(record.input) || !stored) return record;
  const merged = [...stored];
  for (const { index, raw } of attachments) merged.splice(Math.min(index, merged.length), 0, raw);
  return { ...record, input: { ...record.input, attachments: merged } };
}

function withSlot(record: unknown, slot: UnreadSlot): unknown {
  if (record === null || record === undefined) return slot.whole ?? record;
  if (!slot.attachments || !isRecord(record) || record.lifecycle !== "active") return record;
  return withUnreadAttachments(record, slot.attachments);
}

function writeUnread(text: string, unread: UnreadDrafts): string {
  let decoded: unknown;
  try {
    decoded = JSON.parse(text);
  } catch {
    return text;
  }
  if (!isRecord(decoded) || !isRecord(decoded.state)) return text;
  const state = decoded.state;
  const drafts: Record<string, unknown> = isRecord(state.drafts) ? { ...state.drafts } : {};
  for (const [draftKey, slot] of unread.drafts) {
    const merged = withSlot(drafts[draftKey], slot);
    if (merged !== undefined) drafts[draftKey] = merged;
  }
  const createModalDraft = withSlot(state.createModalDraft ?? null, unread.createModalDraft);
  return JSON.stringify({ ...decoded, state: { ...state, drafts, createModalDraft } });
}

function collectStrings(value: unknown, into: Set<string>): void {
  if (typeof value === "string") {
    into.add(value);
  } else if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, into);
  } else if (isRecord(value)) {
    for (const item of Object.values(value)) collectStrings(item, into);
  }
}

/**
 * Keeps the stored drafts this build cannot read, such as a draft of a lifecycle or an
 * attachment of a kind a later build added: the read drops them (`readableEntries`), and the
 * build's next write would store only what it read, so a downgrade would lose them (ALM-5148).
 *
 * Each read sets what the stored drafts hold that this build cannot read, and each write puts it
 * back: a whole draft where this build has none, an attachment in the draft it was in, at its
 * place, while that draft is active. A draft this build clears, sends or makes anew in that place
 * drops what it held, as its own attachments go; the store calls `forgetReplaced` on every change,
 * since a write may skip a state that one change leads past. The sweep keeps every file the kept
 * entries name (`heldStrings`).
 */
export function keepUnreadDraftEntries(backingStorage: StateStorage): UnreadDraftEntries {
  let unread = emptyUnread();

  const forgetReplaced = (state: DraftStoreState) => {
    for (const [draftKey, slot] of unread.drafts) {
      const next = forgetSlot(slot, state.drafts[draftKey]);
      if (isEmptySlot(next)) unread.drafts.delete(draftKey);
      else unread.drafts.set(draftKey, next);
    }
    unread.createModalDraft = forgetSlot(unread.createModalDraft, state.createModalDraft);
  };

  const storage: StateStorage = {
    getItem: async (name) => {
      const text = await backingStorage.getItem(name);
      unread = readUnread(text);
      return text;
    },
    setItem: (name, value) => {
      if (unread.drafts.size === 0 && isEmptySlot(unread.createModalDraft)) {
        return backingStorage.setItem(name, value);
      }
      return backingStorage.setItem(name, writeUnread(value, unread));
    },
    removeItem: (name) => backingStorage.removeItem(name),
  };

  return {
    storage,
    forgetReplaced,
    heldStrings: () => {
      const held = new Set<string>();
      for (const slot of [...unread.drafts.values(), unread.createModalDraft]) {
        collectStrings(slot.whole, held);
        for (const attachment of slot.attachments ?? []) collectStrings(attachment.raw, held);
      }
      return held;
    },
  };
}
