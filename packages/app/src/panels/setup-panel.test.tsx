/**
 * @vitest-environment jsdom
 */
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n/i18next";
import { setupPanelRegistration } from "@/panels/setup-panel";

const { theme } = vi.hoisted(() => ({
  theme: {
    spacing: { 1: 4, 1.5: 6, 2: 8, 3: 12, 4: 16 },
    borderWidth: { 1: 1 },
    borderRadius: { md: 6, lg: 8 },
    fontSize: { xs: 11, sm: 13, base: 15, code: 12 },
    fontFamily: { mono: "monospace" },
    fontWeight: { normal: "400", medium: "500", semibold: "600" },
    colors: {
      border: "#444",
      foreground: "#fff",
      foregroundMuted: "#aaa",
      surface0: "#000",
      surface1: "#111",
      palette: {
        green: { 500: "#22c55e" },
        red: { 100: "#fee2e2", 500: "#ef4444", 800: "#991b1b" },
      },
    },
  },
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) => (typeof factory === "function" ? factory(theme) : factory),
  },
  useUnistyles: () => ({ theme }),
  withUnistyles: (Component: React.ComponentType<Record<string, unknown>>) => Component,
}));

vi.mock("lucide-react-native", () => ({
  CheckCircle2: () => null,
  ChevronRight: () => null,
  CircleAlert: () => null,
  SquareTerminal: () => null,
}));

vi.mock("@/components/ui/alert", () => ({
  Alert: ({ title }: { title?: string }) => <div role="alert">{title}</div>,
}));

vi.mock("@/components/ui/button", () => ({ Button: () => null }));
vi.mock("@/components/ui/loading-spinner", () => ({ LoadingSpinner: () => null }));

vi.mock("@/panels/pane-context", () => ({
  usePaneContext: () => ({
    serverId: "server-1",
    target: { kind: "setup", workspaceId: "workspace-1" },
  }),
}));

vi.mock("@/panels/panel-registry", () => ({
  definePanel: (_id: string, definition: unknown) => definition,
}));

vi.mock("@/workspace-tabs/model", () => ({
  buildWorkspaceTabPersistenceKey: () => "server-1:workspace-1",
}));

vi.mock("@/stores/workspace-setup-store", () => ({
  useWorkspaceSetupStore: (selector: (state: unknown) => unknown) =>
    selector({ snapshots: {}, applySnapshot: () => undefined }),
}));

vi.mock("@/runtime/host-runtime", () => ({ useHostRuntimeClient: () => null }));
vi.mock("@/stores/session-store-hooks", () => ({ useWorkspaceFields: () => null }));
vi.mock("@/components/retained-panel", () => ({ useRetainedPanelActive: () => true }));
vi.mock("@/hooks/use-app-visible", () => ({ useAppActivelyVisible: () => true }));

const mockObservation = vi.hoisted(() => ({ current: null as boolean | null }));

vi.mock("@/runtime/host-features", () => ({
  useHostFeature: () => false,
  useHostFeatureAvailability: (_serverId: string, feature: string) =>
    feature === "workspaceSetupObservation" ? mockObservation.current : null,
}));

const SetupPanel = (setupPanelRegistration as unknown as { component: React.ComponentType })
  .component;

describe("SetupPanel", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    cleanup();
  });

  it("says the host is not connected, not to update it, while the host has sent no server info", () => {
    mockObservation.current = null;
    render(<SetupPanel />);

    expect(screen.getByRole("alert").textContent).toBe("Host is not connected");
    expect(screen.queryByText("Update the host to view workspace setup details")).toBeNull();
  });

  it("asks to update a connected host that lacks setup observation", () => {
    mockObservation.current = false;
    render(<SetupPanel />);

    expect(screen.getByRole("alert").textContent).toBe(
      "Update the host to view workspace setup details",
    );
  });

  it("shows no host notice when the host supports setup observation", () => {
    mockObservation.current = true;
    render(<SetupPanel />);

    expect(screen.queryByRole("alert")).toBeNull();
  });
});
