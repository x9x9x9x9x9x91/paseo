import { describe, expect, it } from "vitest";
import { changesStateSchema, defaultChangesState } from "./state";

describe("Changes pane state", () => {
  it("drops preferences formerly persisted per pane without resetting local document state", () => {
    expect(
      changesStateSchema.parse({
        ...defaultChangesState,
        mode: "base",
        baseRef: "origin/main",
        layout: "split",
        wrapLines: true,
        hideWhitespace: true,
      }),
    ).toEqual(defaultChangesState);
  });

  // A key a later build adds would show the defaults, lost at the next change (ALM-5138).
  it("reads a key a later build added without it", () => {
    const state = { ...defaultChangesState, collapsedFilePaths: ["a.ts"], sortBy: "size" };
    expect(changesStateSchema.parse(state)).toEqual({
      ...defaultChangesState,
      collapsedFilePaths: ["a.ts"],
    });
  });
});
