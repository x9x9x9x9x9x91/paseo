import { z } from "zod";
import type { PersistStorage, StateStorage, StorageValue } from "zustand/middleware";

/**
 * A persisted store's storage that reads a stored value it cannot parse as none and leaves it
 * stored: it may be a later build's, and removing it would wipe the store for that build too
 * (ALM-5138). Give it a `z.object` state schema, never `z.strictObject`, so a key a later build
 * adds reads back without it instead of failing the read (ALM-5127); the envelope reads loosely
 * for the same reason. A list or record whose entries a later build may add kinds to reads them
 * with `readableEntries` / `readableRecordEntries`. A store with no migrations of its own passes
 * `migrate: keepStoredState`. A write stores the parsed value, so that build's next write leaves
 * the unknown keys out.
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
      return null;
    }

    const result = envelopeSchema.safeParse(decoded);
    return result.success ? result.data : null;
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

/**
 * The `migrate` of a persisted store with no migrations of its own. Without one, zustand drops a
 * stored state whose version is not the store's, so a later build that raises the version would
 * leave an older build with the defaults, written over the store at its next change (ALM-5138).
 * The storage has parsed the state against the store's schema already. Zustand writes a migrated
 * state back as it loads, so an older build stores it at once, in its own shape and version.
 */
export function keepStoredState<State>(persistedState: unknown): State {
  return persistedState as State;
}

/**
 * A stored list that drops each entry its schema cannot read and keeps the rest: an entry a later
 * build wrote, such as one of a new kind, would otherwise fail the whole stored value (ALM-5138).
 */
export function readableEntries<Entry extends z.ZodType>(entry: Entry) {
  return z.array(z.unknown()).transform((items) =>
    items.flatMap((item) => {
      const result = entry.safeParse(item);
      return result.success ? [result.data] : [];
    }),
  );
}

/** `readableEntries` for a stored record: drops each value its schema cannot read (ALM-5138). */
export function readableRecordEntries<Entry extends z.ZodType>(entry: Entry) {
  return z.record(z.string(), z.unknown()).transform((items) => {
    const readable: Record<string, z.output<Entry>> = {};
    for (const [key, item] of Object.entries(items)) {
      const result = entry.safeParse(item);
      if (result.success) readable[key] = result.data;
    }
    return readable;
  });
}
