import { z } from "zod";
import type { PersistStorage, StateStorage, StorageValue } from "zustand/middleware";

/**
 * A persisted store's storage that drops a stored value it cannot parse. Give it a `z.object`
 * state schema, never `z.strictObject`: a key a later build adds then reads back without it,
 * where a strict schema fails the parse and this storage removes the whole value, so opening an
 * older build would wipe the store (ALM-5127). The envelope reads loosely for the same reason.
 * A write stores the parsed value, so that build's next write leaves the unknown keys out.
 */
export function createValidatedPersistStorage<State>(
  backingStorage: StateStorage,
  stateSchema: z.ZodType<State>,
  // Opt in only when callers preserve state references until values change.
  options: { skipUnchanged?: boolean } = {},
): PersistStorage<State> {
  const envelopeSchema = z.object({
    state: stateSchema,
    version: z.number().int().nonnegative().optional(),
  });

  const accepted = new Map<string, StorageValue<State>>();
  const reading = new Set<string>();

  async function read(name: string): Promise<StorageValue<State> | null> {
    const raw = await backingStorage.getItem(name);
    if (raw === null) return null;

    let decoded: unknown;
    try {
      decoded = JSON.parse(raw);
    } catch {
      await backingStorage.removeItem(name);
      return null;
    }

    const result = envelopeSchema.safeParse(decoded);
    if (!result.success) {
      await backingStorage.removeItem(name);
      return null;
    }
    return result.data;
  }

  return {
    getItem: async (name) => {
      accepted.delete(name);
      reading.add(name);
      try {
        return await read(name);
      } finally {
        reading.delete(name);
      }
    },
    setItem: async (name, value) => {
      // A store that changes before hydration settles writes the defaults it started with.
      // Hydration then merges the stored state in memory without writing it back, so that
      // write would replace the stored state until the next change.
      if (reading.has(name)) return;
      const previous = accepted.get(name);
      if (
        options.skipUnchanged &&
        previous &&
        previous.state === value.state &&
        previous.version === value.version
      )
        return;
      const result = envelopeSchema.safeParse(value);
      if (!result.success) {
        accepted.delete(name);
        await backingStorage.removeItem(name);
        return;
      }
      if (options.skipUnchanged) accepted.set(name, value);
      try {
        await backingStorage.setItem(name, JSON.stringify(result.data));
      } catch (error) {
        if (accepted.get(name) === value) accepted.delete(name);
        throw error;
      }
    },
    removeItem: (name) => {
      accepted.delete(name);
      return backingStorage.removeItem(name);
    },
  };
}
