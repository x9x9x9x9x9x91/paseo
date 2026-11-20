import { z } from "zod";

// Loose, as `changesStateSchema` (ALM-5138).
export const fileStateSchema = z.object({
  treeVisible: z.boolean(),
  treeWidth: z.number().optional(),
});

export type FileState = z.infer<typeof fileStateSchema>;

export const defaultFileState: FileState = { treeVisible: false };

export const fileStateForFilesView: FileState = { treeVisible: true };
