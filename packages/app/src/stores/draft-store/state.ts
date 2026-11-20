import {
  NEW_WORKSPACE_PICKER_ATTACHMENT_OWNER,
  type AttachmentMetadata,
  type UserComposerAttachment,
} from "@/attachments/types";
import { PluginResourceComposerAttachmentSchema } from "@/plugins/attachments";
import { mergeFollowedEntries } from "@/storage/follow-other-windows";
import { z } from "zod";

export const DRAFT_STORE_VERSION = 5;
export const FINALIZED_DRAFT_TTL_MS = 5 * 60 * 1000;

export interface LegacyDraftImage {
  uri: string;
  mimeType?: string;
}

export type PersistedDraftImage = AttachmentMetadata | LegacyDraftImage;

export interface DraftInput {
  text: string;
  attachments: UserComposerAttachment[];
}

export type DraftLifecycleState = "active" | "abandoned" | "sent";

export type CanonicalDraftInput = DraftInput;

export interface DraftRecord {
  input: CanonicalDraftInput;
  lifecycle: DraftLifecycleState;
  updatedAt: number;
  version: number;
}

export function editDraftRecordText(
  record: DraftRecord | undefined,
  text: string,
  now: number,
): DraftRecord {
  if (record?.lifecycle === "active" && record.input.text === text) return record;
  const attachments = record?.lifecycle === "active" ? record.input.attachments : [];
  return {
    input: { text, attachments },
    lifecycle: text.length > 0 || attachments.length > 0 ? "active" : "abandoned",
    updatedAt: now,
    version: (record?.version ?? 0) + 1,
  };
}

export interface DraftStoreState {
  drafts: Record<string, DraftRecord>;
  createModalDraft: DraftRecord | null;
}

// The attachment shapes read a key a later build adds without it, so a stored draft keeps its
// attachments on an older build; the draft input itself stays strict below (ALM-5138).
export const AttachmentMetadataSchema = z.object({
  id: z.string(),
  mimeType: z.string(),
  storageType: z.enum(["web-indexeddb", "desktop-file", "native-file"]),
  storageKey: z.string(),
  fileName: z.string().nullable().optional(),
  byteSize: z.number().nullable().optional(),
  createdAt: z.number(),
}) satisfies z.ZodType<AttachmentMetadata>;
export const LegacyDraftImageSchema: z.ZodType<LegacyDraftImage> = z.object({
  uri: z.string(),
  mimeType: z.string().optional(),
});
const UploadedFileSchema = z.object({
  type: z.literal("uploaded_file"),
  id: z.string(),
  fileName: z.string(),
  mimeType: z.string(),
  size: z.number().int().nonnegative(),
  path: z.string(),
});
const ForgeItemFields = {
  forge: z.string().optional(),
  number: z.number(),
  title: z.string(),
  url: z.string(),
  state: z.string(),
  body: z.string().nullable(),
  labels: z.array(z.string()),
  projectPath: z.string().optional(),
  baseRefName: z.string().nullable().optional(),
  headRefName: z.string().nullable().optional(),
  updatedAt: z.string().optional(),
};
const IssueItemSchema = z.object({ kind: z.literal("issue"), ...ForgeItemFields });
const ChangeRequestItemSchema = z.object({
  kind: z.literal("change_request"),
  ...ForgeItemFields,
});
export const UserComposerAttachmentSchema: z.ZodType<UserComposerAttachment> = z.discriminatedUnion(
  "kind",
  [
    z.object({ kind: z.literal("image"), metadata: AttachmentMetadataSchema }),
    z.object({ kind: z.literal("file"), attachment: UploadedFileSchema }),
    z.object({
      kind: z.literal("workspace_file"),
      path: z.string(),
      selection: z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("whole_file") }),
        z.object({
          kind: z.literal("line_range"),
          startLine: z.number().int().positive(),
          endLine: z.number().int().positive(),
        }),
      ]),
    }),
    z.object({ kind: z.literal("forge_issue"), item: IssueItemSchema }),
    z.object({ kind: z.literal("forge_change_request"), item: ChangeRequestItemSchema }),
    z.object({ kind: z.literal("github_issue"), item: IssueItemSchema }),
    PluginResourceComposerAttachmentSchema,
    z.object({
      kind: z.literal("github_pr"),
      item: ChangeRequestItemSchema,
      owner: z.literal(NEW_WORKSPACE_PICKER_ATTACHMENT_OWNER).optional(),
    }),
  ],
);
// Strict: a legacy input's `images` key marks it for migration (`migrateAllLegacyDrafts`).
export const CanonicalDraftInputSchema = z.strictObject({
  text: z.string(),
  attachments: z.array(UserComposerAttachmentSchema),
  // COMPAT(draft-cwd): accept legacy persisted drafts that include cwd. Stop accepting after 2026-11-09.
  cwd: z.string().optional(),
});
const DraftRecordSchema: z.ZodType<DraftRecord> = z.strictObject({
  input: CanonicalDraftInputSchema,
  lifecycle: z.enum(["active", "abandoned", "sent"]),
  updatedAt: z.number(),
  version: z.number().int().positive(),
});
export const DraftStoreStateSchema: z.ZodType<DraftStoreState> = z.strictObject({
  drafts: z.record(z.string(), DraftRecordSchema),
  createModalDraft: DraftRecordSchema.nullable(),
});

export function isAttachmentMetadata(value: unknown): value is AttachmentMetadata {
  return AttachmentMetadataSchema.safeParse(value).success;
}

export function isLegacyDraftImage(value: unknown): value is LegacyDraftImage {
  return LegacyDraftImageSchema.safeParse(value).success;
}

export function normalizeAttachmentMetadata(image: AttachmentMetadata): AttachmentMetadata {
  return {
    id: image.id,
    mimeType: image.mimeType,
    storageType: image.storageType,
    storageKey: image.storageKey,
    createdAt: image.createdAt,
    ...(typeof image.fileName === "string" || image.fileName === null
      ? { fileName: image.fileName }
      : {}),
    ...(typeof image.byteSize === "number" || image.byteSize === null
      ? { byteSize: image.byteSize }
      : {}),
  };
}

export function isUserComposerAttachment(value: unknown): value is UserComposerAttachment {
  return UserComposerAttachmentSchema.safeParse(value).success;
}

export function normalizeComposerAttachment(
  attachment: UserComposerAttachment,
): UserComposerAttachment {
  if (attachment.kind === "image") {
    return {
      kind: "image",
      metadata: normalizeAttachmentMetadata(attachment.metadata),
    };
  }
  if (attachment.kind === "workspace_file") {
    return {
      kind: "workspace_file",
      path: attachment.path.trim().replace(/^\.\//, ""),
      selection: attachment.selection,
    };
  }
  return attachment;
}

export function isCanonicalDraftInput(value: unknown): value is CanonicalDraftInput {
  return CanonicalDraftInputSchema.safeParse(value).success;
}

export function toDraftInputIfReady(
  record: DraftRecord | null | undefined,
): DraftInput | undefined {
  if (!record) {
    return undefined;
  }
  if (record.lifecycle !== "active") {
    return undefined;
  }
  if (!isCanonicalDraftInput(record.input)) {
    return undefined;
  }
  return {
    text: record.input.text,
    attachments: record.input.attachments.map(normalizeComposerAttachment),
  };
}

export function collectReferencedAttachmentIdsFromState(state: DraftStoreState): Set<string> {
  const referencedIds = new Set<string>();

  for (const draftRecord of Object.values(state.drafts)) {
    if (draftRecord.lifecycle !== "active") {
      continue;
    }
    if (!isCanonicalDraftInput(draftRecord.input)) {
      continue;
    }
    for (const attachment of draftRecord.input.attachments) {
      if (attachment.kind === "image") {
        referencedIds.add(attachment.metadata.id);
      }
    }
  }

  const modalRecord = state.createModalDraft;
  if (modalRecord?.lifecycle === "active" && isCanonicalDraftInput(modalRecord.input)) {
    for (const attachment of modalRecord.input.attachments) {
      if (attachment.kind === "image") {
        referencedIds.add(attachment.metadata.id);
      }
    }
  }

  return referencedIds;
}

export function pruneFinalizedDraftRecords(input: {
  drafts: Record<string, DraftRecord>;
  nowMs: number;
}): Record<string, DraftRecord> {
  let changed = false;
  const next: Record<string, DraftRecord> = {};
  for (const [draftKey, record] of Object.entries(input.drafts)) {
    if (record.lifecycle !== "active" && input.nowMs - record.updatedAt >= FINALIZED_DRAFT_TTL_MS) {
      changed = true;
      continue;
    }
    next[draftKey] = record;
  }
  return changed ? next : input.drafts;
}

function storedUpdatedAt(value: unknown): number {
  if (value && typeof value === "object" && "updatedAt" in value) {
    const { updatedAt } = value as { updatedAt: unknown };
    if (typeof updatedAt === "number") return updatedAt;
  }
  return -Infinity;
}

/** This window's draft wins when it changed after the other window's copy, or its removal. */
function isLaterLocalDraft(entry: {
  local: DraftRecord;
  stored: DraftRecord | undefined;
  before: unknown;
}): boolean {
  return entry.local.updatedAt > (entry.stored?.updatedAt ?? storedUpdatedAt(entry.before));
}

function asEntry(record: DraftRecord | null | undefined): Record<string, DraftRecord> {
  return record ? { draft: record } : {};
}

/**
 * Takes in the drafts other app windows wrote since `before`, and keeps every other draft of this
 * window as it is, so two windows do not drop each other's drafts (ALM-5115). Where both changed
 * one draft, the later edit wins: a window writes its drafts at most every 200 ms, so its last
 * keystrokes may not be stored yet.
 */
export function mergeFollowedDraftState(input: {
  before: Record<string, unknown>;
  stored: Partial<DraftStoreState>;
  local: DraftStoreState;
}): DraftStoreState {
  const drafts = mergeFollowedEntries({
    before: input.before.drafts,
    storedRaw: input.stored.drafts,
    stored: input.stored.drafts ?? {},
    local: input.local.drafts,
    keepLocal: isLaterLocalDraft,
  });
  const createModalDraft = mergeFollowedEntries({
    before: asEntry(input.before.createModalDraft as DraftRecord | null | undefined),
    storedRaw: asEntry(input.stored.createModalDraft),
    stored: asEntry(input.stored.createModalDraft),
    local: asEntry(input.local.createModalDraft),
    keepLocal: isLaterLocalDraft,
  }).draft;
  return { drafts, createModalDraft: createModalDraft ?? null };
}

export function applyClearDraftRecord(input: {
  record: DraftRecord;
  lifecycle?: Exclude<DraftLifecycleState, "active">;
  nowMs: number;
}): DraftRecord | null {
  if (!input.lifecycle) {
    return null;
  }

  return {
    ...input.record,
    input: { text: "", attachments: [] },
    lifecycle: input.lifecycle,
    updatedAt: input.nowMs,
    version: input.record.version + 1,
  };
}
