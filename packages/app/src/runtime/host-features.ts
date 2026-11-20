import { useMemo } from "react";
import { useShallow } from "zustand/shallow";
import type { DaemonServerInfo } from "@/stores/session-store";
import { useSessionStore } from "@/stores/session-store";

export type HostFeatureName = keyof NonNullable<DaemonServerInfo["features"]>;

export interface HostFeatureSessionState {
  sessions: Record<
    string,
    | {
        serverInfo: DaemonServerInfo | null;
      }
    | undefined
  >;
}

export function hostSupportsFeature(
  serverInfo: DaemonServerInfo | null | undefined,
  feature: HostFeatureName,
): boolean {
  return serverInfo?.features?.[feature] === true;
}

/**
 * Whether a host has a feature: `null` while it has sent no server info (never connected in this
 * app run), so an offline host reads as not connected rather than as one too old for the feature;
 * an "update the host" message is only for `false` (ALM-5046).
 */
export function hostFeatureAvailability(
  serverInfo: DaemonServerInfo | null | undefined,
  feature: HostFeatureName,
): boolean | null {
  return serverInfo ? hostSupportsFeature(serverInfo, feature) : null;
}

/**
 * Whether no host is known to lack the feature: a host with no server info yet (`null`) is left
 * out, so one offline host does not turn a feature off for every host (ALM-5046).
 */
export function noHostLacksFeature(availability: Iterable<boolean | null>): boolean {
  for (const supported of availability) {
    if (supported === false) return false;
  }
  return true;
}

export function selectHostFeature(
  state: HostFeatureSessionState,
  serverId: string,
  feature: HostFeatureName,
): boolean {
  return hostSupportsFeature(state.sessions[serverId]?.serverInfo, feature);
}

export function useHostFeature(
  serverId: string | null | undefined,
  feature: HostFeatureName,
): boolean {
  const normalizedServerId = serverId?.trim() ?? "";
  return useSessionStore((state) => selectHostFeature(state, normalizedServerId, feature));
}

export function selectHostFeatureAvailability(
  state: HostFeatureSessionState,
  serverId: string,
  feature: HostFeatureName,
): boolean | null {
  return hostFeatureAvailability(state.sessions[serverId]?.serverInfo, feature);
}

/** One host's `hostFeatureAvailability`: `null` until it has sent server info. */
export function useHostFeatureAvailability(
  serverId: string | null | undefined,
  feature: HostFeatureName,
): boolean | null {
  const normalizedServerId = serverId?.trim() ?? "";
  return useSessionStore((state) =>
    selectHostFeatureAvailability(state, normalizedServerId, feature),
  );
}

export function useHostFeatureMap(
  serverIds: readonly string[],
  feature: HostFeatureName,
): ReadonlyMap<string, boolean> {
  const flags = useSessionStore(
    useShallow((state) => serverIds.map((serverId) => selectHostFeature(state, serverId, feature))),
  );

  return useMemo(
    () => new Map(serverIds.map((serverId, index) => [serverId, flags[index] === true] as const)),
    [flags, serverIds],
  );
}

export function useHostFeatureAvailabilityMap(
  serverIds: readonly string[],
  feature: HostFeatureName,
): ReadonlyMap<string, boolean | null> {
  const flags = useSessionStore(
    useShallow((state) =>
      serverIds.map((serverId) => selectHostFeatureAvailability(state, serverId, feature)),
    ),
  );

  return useMemo(
    () => new Map(serverIds.map((serverId, index) => [serverId, flags[index]] as const)),
    [flags, serverIds],
  );
}
