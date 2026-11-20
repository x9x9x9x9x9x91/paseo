import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { StateStorage } from "zustand/middleware";
import { createValidatedPersistStorage } from "./validated-persist-storage";

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
  it.each([
    ["malformed JSON", "{"],
    ["invalid state", JSON.stringify({ state: { enabled: "yes" }, version: 1 })],
  ])("clears %s", async (_label, stored) => {
    const backing = new MemoryStorage();
    backing.values.set("settings", stored);
    const storage = createValidatedPersistStorage(backing, StateSchema);

    await expect(storage.getItem("settings")).resolves.toBeNull();
    expect(backing.values.has("settings")).toBe(false);
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

  it("leaves a later build's unknown keys out of its next write", async () => {
    const backing = new MemoryStorage();
    backing.values.set(
      "settings",
      JSON.stringify({ state: { enabled: true, landing: "workers" }, version: 1, written: "later" }),
    );
    const storage = createValidatedPersistStorage(backing, StateSchema);
    const read = await storage.getItem("settings");
    if (!read) throw new Error("nothing read");

    await storage.setItem("settings", { ...read, state: { enabled: false } });
    expect(backing.values.get("settings")).toBe(
      JSON.stringify({ state: { enabled: false }, version: 1 }),
    );
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

it("saves the same state again after removal or rehydration clears invalid storage", async () => {
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
