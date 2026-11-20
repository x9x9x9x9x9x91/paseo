/**
 * @vitest-environment jsdom
 */
import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n/i18next";
import { HostVoicePage } from "@/screens/settings/voice/voice-page";

const { theme } = vi.hoisted(() => ({
  theme: {
    spacing: { 1: 4, 2: 8, 3: 12, 4: 16, 6: 24, 8: 32 },
    colors: { foregroundMuted: "#aaa" },
  },
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) => (typeof factory === "function" ? factory(theme) : factory),
  },
  useUnistyles: () => ({ theme }),
}));

vi.mock("@/components/settings", () => ({
  SettingsCard: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  SettingsDetailRow: () => null,
  SettingsRow: () => null,
  SettingsSection: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/components/ui/alert", () => ({
  Alert: ({ title }: { title?: string }) => <div role="alert">{title}</div>,
}));

vi.mock("@/components/ui/loading-spinner", () => ({
  LoadingSpinner: () => <div data-testid="voice-loading" />,
}));

vi.mock("@/components/ui/switch", () => ({ Switch: () => null }));
vi.mock("@/contexts/toast-api-context", () => ({ useToast: () => ({ error: vi.fn() }) }));
vi.mock("./speech-provider-sheet", () => ({ SpeechProviderSheet: () => null }));
vi.mock("./use-local-speech-models", () => ({
  useLocalSpeechModels: () => ({ refresh: vi.fn() }),
}));

vi.mock("@/hooks/use-daemon-config", () => ({
  useDaemonConfig: () => ({ config: { features: {} }, patchConfig: vi.fn() }),
}));

const mockHost = vi.hoisted(() => ({
  isConnected: true,
  speechSettings: null as boolean | null,
}));

vi.mock("@/runtime/host-runtime", () => ({
  useHostRuntimeIsConnected: () => mockHost.isConnected,
}));

vi.mock("@/runtime/host-features", () => ({
  useHostFeatureAvailability: () => mockHost.speechSettings,
}));

describe("HostVoicePage", () => {
  beforeAll(async () => {
    await i18n.changeLanguage("en");
  });

  afterEach(() => {
    cleanup();
  });

  it("asks to connect an offline host", () => {
    mockHost.isConnected = false;
    mockHost.speechSettings = null;
    render(<HostVoicePage serverId="server-1" />);

    expect(screen.getByRole("alert").textContent).toBe("Connect to this host to configure voice.");
  });

  it("waits, rather than asking for an update, while a connected host's server info is still on its way", () => {
    mockHost.isConnected = true;
    mockHost.speechSettings = null;
    render(<HostVoicePage serverId="server-1" />);

    expect(screen.getByTestId("voice-loading")).toBeTruthy();
    expect(screen.queryByText("Update the host to configure voice.")).toBeNull();
  });

  it("asks to update a connected host that lacks speech settings", () => {
    mockHost.isConnected = true;
    mockHost.speechSettings = false;
    render(<HostVoicePage serverId="server-1" />);

    expect(screen.getByRole("alert").textContent).toBe("Update the host to configure voice.");
  });
});
