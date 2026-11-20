import { z } from "zod";

export interface ValidatedStorage {
  getItem(key: string): Promise<string | null>;
}

/**
 * Reads of a stored value that return `null` for one that fails its schema and leave it stored:
 * it may be a later build's value, and removing it would wipe it for that build too (ALM-5138).
 * Give each a `z.object` schema, never `z.strictObject`, so a key a later build adds reads back
 * without it instead of failing the read.
 */
export async function readValidatedString<Value>(
  storage: ValidatedStorage,
  key: string,
  schema: z.ZodType<Value>,
): Promise<Value | null> {
  const raw = await storage.getItem(key);
  if (raw === null) return null;
  const result = schema.safeParse(raw);
  return result.success ? result.data : null;
}

export async function readValidatedJson<Value>(
  storage: ValidatedStorage,
  key: string,
  schema: z.ZodType<Value>,
): Promise<Value | null> {
  const raw = await storage.getItem(key);
  if (raw === null) return null;
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    return null;
  }
  const result = schema.safeParse(decoded);
  return result.success ? result.data : null;
}
