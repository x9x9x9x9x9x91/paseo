import { describe, expect, it } from "vitest";
import type { DaemonServerInfo } from "@/stores/session-store";
import {
  hostFeatureAvailability,
  noHostLacksFeature,
  selectHostFeature,
  selectHostFeatureAvailability,
} from "@/runtime/host-features";

function serverInfo(features: DaemonServerInfo["features"]): DaemonServerInfo {
  return { serverId: "server-1", hostname: null, version: null, features } as DaemonServerInfo;
}

describe("hostFeatureAvailability", () => {
  it("is null while the host has sent no server info", () => {
    expect(hostFeatureAvailability(null, "speechSettings")).toBeNull();
    expect(hostFeatureAvailability(undefined, "speechSettings")).toBeNull();
  });

  it("is false for a host whose server info lacks the feature", () => {
    expect(hostFeatureAvailability(serverInfo({}), "speechSettings")).toBe(false);
    expect(hostFeatureAvailability(serverInfo(undefined), "speechSettings")).toBe(false);
  });

  it("is true for a host whose server info has the feature", () => {
    expect(hostFeatureAvailability(serverInfo({ speechSettings: true }), "speechSettings")).toBe(
      true,
    );
  });
});

describe("selectHostFeatureAvailability", () => {
  const state = {
    sessions: {
      offline: { serverInfo: null },
      old: { serverInfo: serverInfo({}) },
      current: { serverInfo: serverInfo({ workspaceSortTimes: true }) },
    },
  };

  it("tells a host with no server info apart from one lacking the feature", () => {
    expect(selectHostFeatureAvailability(state, "offline", "workspaceSortTimes")).toBeNull();
    expect(selectHostFeatureAvailability(state, "unknown", "workspaceSortTimes")).toBeNull();
    expect(selectHostFeatureAvailability(state, "old", "workspaceSortTimes")).toBe(false);
    expect(selectHostFeatureAvailability(state, "current", "workspaceSortTimes")).toBe(true);
  });

  it("leaves selectHostFeature's yes or no as it was", () => {
    expect(selectHostFeature(state, "offline", "workspaceSortTimes")).toBe(false);
    expect(selectHostFeature(state, "current", "workspaceSortTimes")).toBe(true);
  });
});

describe("noHostLacksFeature", () => {
  it("leaves out hosts that have not connected yet", () => {
    expect(noHostLacksFeature([true, null])).toBe(true);
    expect(noHostLacksFeature([null])).toBe(true);
    expect(noHostLacksFeature([])).toBe(true);
  });

  it("is false once a connected host lacks the feature", () => {
    expect(noHostLacksFeature([true, false])).toBe(false);
    expect(noHostLacksFeature([null, false])).toBe(false);
  });
});
