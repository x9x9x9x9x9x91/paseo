import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { StateStorage } from "zustand/middleware";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import {
  createValidatedPersistStorage,
  keepStoredState,
  readableEntries,
  readableRecordEntries,
} from "./validated-persist-storage";

class MemoryStorage implements StateStorage {
  readonly values = new Map<string, string>();

  getItem(name: string): string | null {
    return this.values.get(name) ?? null;
  }

  setItem(name: string, value: string): void {
    this.values.set(name, value);
  }

  removeItem(name: string): void {
    this.values.delete(name);
  }
}

const StateSchema = z.object({ enabled: z.boolean() });

describe("createValidatedPersistStorage", () => {
  // A value this build cannot read may be a later build's: removing it would wipe it (ALM-5138).
  it.each([
    ["malformed JSON", "{"],
    ["invalid state", JSON.stringify({ state: { enabled: "yes" }, version: 1 })],
  ])("reads %s as none and keeps it", async (_label, stored) => {
    const backing = new MemoryStorage();
    backing.values.set("settings", stored);
    const storage = createValidatedPersistStorage(backing, StateSchema);

    await expect(storage.getItem("settings")).resolves.toBeNull();
    expect(backing.values.get("settings")).toBe(stored);
  });

  // An older build reading what a later one stored: removing it would wipe the store (ALM-5127).
  it.each([
    ["state", { state: { enabled: true, landing: "workers" }, version: 1 }],
    ["envelope", { state: { enabled: true }, version: 1, written: "later" }],
  ])("reads back a value with %s keys it does not know, and keeps it", async (_label, value) => {
    const backing = new MemoryStorage();
    const stored = JSON.stringify(value);
    backing.values.set("settings", stored);
    const storage = createValidatedPersistStorage(backing, StateSchema);

    await expect(storage.getItem("settings")).resolves.toEqual({
      state: { enabled: true },
      version: 1,
    });
    expect(backing.values.get("settings")).toBe(stored);
  });

  it("returns schema-validated state", async () => {
    const backing = new MemoryStorage();
    backing.values.set("settings", JSON.stringify({ state: { enabled: true }, version: 1 }));
    const storage = createValidatedPersistStorage(backing, StateSchema);

    await expect(storage.getItem("settings")).resolves.toEqual({
      state: { enabled: true },
      version: 1,
    });
  });

  it("clears a value rejected by the schema before writing", async () => {
    const backing = new MemoryStorage();
    backing.values.set("settings", JSON.stringify({ state: { count: 1 } }));
    const storage = createValidatedPersistStorage(
      backing,
      z.strictObject({ count: z.number().finite() }),
    );

    await storage.setItem("settings", { state: { count: Number.NaN } });

    expect(backing.values.has("settings")).toBe(false);
  });
});

it("skips repeated immutable states only when requested", async () => {
  let writes = 0;
  const backing: StateStorage = {
    getItem: () => null,
    setItem: () => {
      writes += 1;
    },
    removeItem: () => {},
  };
  const value = { state: { enabled: true }, version: 1 };
  const regular = createValidatedPersistStorage(backing, StateSchema);
  await regular.setItem("regular", value);
  await regular.setItem("regular", value);
  expect(writes).toBe(2);

  const deduplicated = createValidatedPersistStorage(backing, StateSchema, { skipUnchanged: true });
  await deduplicated.setItem("first", value);
  await deduplicated.setItem("first", { ...value });
  expect(writes).toBe(3);
  await deduplicated.setItem("second", value);
  expect(writes).toBe(4);
  await deduplicated.setItem("first", { ...value, version: 2 });
  expect(writes).toBe(5);
});

it("retries an unchanged state after a failed save", async () => {
  let attempts = 0;
  const backing = new MemoryStorage();
  const storage = createValidatedPersistStorage(
    {
      getItem: (name) => backing.getItem(name),
      setItem: (name, value) => {
        attempts += 1;
        if (attempts === 1) return Promise.reject(new Error("storage unavailable"));
        backing.setItem(name, value);
      },
      removeItem: (name) => backing.removeItem(name),
    },
    StateSchema,
    { skipUnchanged: true },
  );
  const value = { state: { enabled: true }, version: 1 };
  await expect(storage.setItem("layout", value)).rejects.toThrow("storage unavailable");
  await storage.setItem("layout", value);
  expect(attempts).toBe(2);
  expect(backing.getItem("layout")).toBe(JSON.stringify(value));
});

it("saves the same state again after removal or a read of an unreadable value", async () => {
  const backing = new MemoryStorage();
  const storage = createValidatedPersistStorage(backing, StateSchema, { skipUnchanged: true });
  const value = { state: { enabled: true }, version: 1 };
  await storage.setItem("layout", value);
  await storage.removeItem("layout");
  await storage.setItem("layout", value);
  expect(backing.getItem("layout")).toBe(JSON.stringify(value));

  backing.values.set("layout", "{");
  await expect(storage.getItem("layout")).resolves.toBeNull();
  await storage.setItem("layout", value);
  expect(backing.getItem("layout")).toBe(JSON.stringify(value));
});

describe("a store with no migrations of its own", () => {
  function createStore(backing: MemoryStorage) {
    return create<{ enabled: boolean }>()(
      persist((): { enabled: boolean } => ({ enabled: false }), {
        name: "settings",
        version: 1,
        storage: createValidatedPersistStorage(backing, StateSchema),
        migrate: keepStoredState<{ enabled: boolean }>,
      }),
    );
  }

  // A later build that raises the version: without a migrate, zustand drops the state (ALM-5138).
  it.each([
    ["a later build", 2],
    ["an earlier build", 0],
  ])("keeps the state %s stored under another version", async (_label, version) => {
    const backing = new MemoryStorage();
    backing.values.set("settings", JSON.stringify({ state: { enabled: true }, version }));
    const store = createStore(backing);

    await store.persist.rehydrate();

    expect(store.getState().enabled).toBe(true);
  });
});

describe("readable entries", () => {
  const Entry = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("file"), path: z.string() }),
    z.object({ kind: z.literal("image"), id: z.string() }),
  ]);

  it("drops the entries of a kind it does not know and keeps the rest", () => {
    expect(
      readableEntries(Entry).parse([
        { kind: "file", path: "a.ts" },
        { kind: "plugin", id: "later" },
        { kind: "image", id: "1", later: true },
      ]),
    ).toEqual([
      { kind: "file", path: "a.ts" },
      { kind: "image", id: "1" },
    ]);
  });

  it("drops the record values of a kind it does not know and keeps the rest", () => {
    expect(
      readableRecordEntries(Entry).parse({
        a: { kind: "file", path: "a.ts" },
        b: { kind: "plugin", id: "later" },
      }),
    ).toEqual({ a: { kind: "file", path: "a.ts" } });
  });
});
