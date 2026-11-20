import { describe, expect, it } from "vitest";

import { hasVisibleOrderChanged, mergeByPosition, mergeWithRemainder } from "./sidebar-reorder";

describe("hasVisibleOrderChanged", () => {
  it("returns false when visible order is unchanged", () => {
    expect(
      hasVisibleOrderChanged({
        currentOrder: ["a", "b", "c", "d"],
        reorderedVisibleKeys: ["a", "b", "c"],
      }),
    ).toBe(false);
  });

  it("returns true when visible items are reordered", () => {
    expect(
      hasVisibleOrderChanged({
        currentOrder: ["a", "b", "c", "d"],
        reorderedVisibleKeys: ["b", "a", "c"],
      }),
    ).toBe(true);
  });

  it("returns true when a visible key is missing from current order", () => {
    expect(
      hasVisibleOrderChanged({
        currentOrder: ["a", "b"],
        reorderedVisibleKeys: ["a", "c"],
      }),
    ).toBe(true);
  });
});

describe("mergeWithRemainder", () => {
  it("appends non-visible stored keys after reordered visible keys", () => {
    expect(
      mergeWithRemainder({
        currentOrder: ["a", "x", "b", "y"],
        reorderedVisibleKeys: ["b", "a"],
      }),
    ).toEqual(["b", "a", "x", "y"]);
  });

  it("keeps unknown current keys when no visible keys are reordered", () => {
    expect(
      mergeWithRemainder({
        currentOrder: ["stale", "hidden"],
        reorderedVisibleKeys: [],
      }),
    ).toEqual(["stale", "hidden"]);
  });
});

describe("mergeByPosition", () => {
  it("puts the reordered keys in the places they had, the other keys staying where they are", () => {
    expect(
      mergeByPosition({
        currentOrder: ["a", "x", "b", "y", "c"],
        reorderedVisibleKeys: ["c", "a", "b"],
      }),
    ).toEqual(["c", "x", "a", "y", "b"]);
  });

  it("puts a reordered key the current order lacks before the reordered key after it", () => {
    expect(
      mergeByPosition({
        currentOrder: ["a", "x"],
        reorderedVisibleKeys: ["new", "a"],
      }),
    ).toEqual(["new", "a", "x"]);
    expect(
      mergeByPosition({
        currentOrder: ["a", "x"],
        reorderedVisibleKeys: ["a", "new"],
      }),
    ).toEqual(["a", "x", "new"]);
  });
});
