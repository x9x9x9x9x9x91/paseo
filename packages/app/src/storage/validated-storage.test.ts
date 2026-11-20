import { describe, expect, it } from "vitest";
import { z } from "zod";
import { readValidatedJson, readValidatedString } from "./validated-storage";

class MemoryStorage {
  readonly values = new Map<string, string>();

  async getItem(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }
}

describe("validated storage reads", () => {
  // A value that fails its schema may be a later build's: removing it would wipe it (ALM-5138).
  it.each([
    ["malformed JSON", "{"],
    ["wrong field type", JSON.stringify({ enabled: "yes" })],
  ])("returns null for an unreadable JSON payload and keeps it: %s", async (_label, raw) => {
    const storage = new MemoryStorage();
    storage.values.set("settings", raw);

    await expect(
      readValidatedJson(storage, "settings", z.object({ enabled: z.boolean() })),
    ).resolves.toBeNull();
    expect(storage.values.get("settings")).toBe(raw);
  });

  it("returns null for an unreadable scalar value and keeps it", async () => {
    const storage = new MemoryStorage();
    storage.values.set("channel", "nightly");

    await expect(
      readValidatedString(storage, "channel", z.enum(["stable", "beta"])),
    ).resolves.toBeNull();
    expect(storage.values.get("channel")).toBe("nightly");
  });

  it("reads a value with a key it does not know without that key", async () => {
    const storage = new MemoryStorage();
    storage.values.set("settings", JSON.stringify({ enabled: true, surprise: true }));

    await expect(
      readValidatedJson(storage, "settings", z.object({ enabled: z.boolean() })),
    ).resolves.toEqual({ enabled: true });
    expect(storage.values.has("settings")).toBe(true);
  });
});
