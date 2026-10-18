import { expect, type Locator, type Page } from "@playwright/test";
import type { SeededWorkspace } from "./seed-client";

const RECORDED_NOTIFICATIONS_KEY = "__paseoRecordedNotifications";

interface RecordedNotification {
  title: string;
  workspaceId: string | null;
}

/**
 * Replaces the browser's Notification with one that records what the app raises, already
 * granted, so a spec can see every OS banner the app would show.
 */
export async function recordOsNotifications(page: Page): Promise<void> {
  await page.addInitScript((key) => {
    const recorded: { title: string; workspaceId: string | null }[] = [];
    Reflect.set(globalThis, key, recorded);
    class RecordingNotification {
      static permission = "granted";
      static async requestPermission(): Promise<string> {
        return "granted";
      }
      constructor(title: string, options?: { data?: Record<string, unknown> }) {
        const workspaceId = options?.data?.workspaceId;
        recorded.push({ title, workspaceId: typeof workspaceId === "string" ? workspaceId : null });
      }
      addEventListener(): void {}
      close(): void {}
    }
    Reflect.set(globalThis, "Notification", RecordingNotification);
  }, RECORDED_NOTIFICATIONS_KEY);
}

export async function readRecordedNotifications(page: Page): Promise<RecordedNotification[]> {
  return page.evaluate((key) => {
    const recorded: unknown = Reflect.get(globalThis, key);
    return Array.isArray(recorded) ? recorded : [];
  }, RECORDED_NOTIFICATIONS_KEY);
}

/** Runs a mock agent in the workspace to its end, which raises its attention as it finishes. */
export async function finishMockAgent(workspace: SeededWorkspace, title: string): Promise<void> {
  const agent = await workspace.client.createAgent({
    provider: "mock",
    cwd: workspace.repoPath,
    workspaceId: workspace.workspaceId,
    title,
    modeId: "load-test",
    model: "e2e-fast-stream",
    initialPrompt: "Reply briefly.",
  });
  await workspace.client.waitForFinish(agent.id, 30_000);
}

export function attentionProjectsSection(page: Page): Locator {
  return page.getByTestId("attention-projects-section");
}

export async function chooseAttentionScope(
  page: Page,
  from: "Every project" | "Chosen projects",
  to: "Every project" | "Chosen projects",
): Promise<void> {
  await page.getByRole("button", { name: `Projects: ${from}`, exact: true }).click();
  await page.getByRole("menuitem", { name: to, exact: true }).click();
  await expect(page.getByRole("button", { name: `Projects: ${to}`, exact: true })).toBeVisible();
}

export function attentionProjectSwitch(page: Page, workspace: SeededWorkspace): Locator {
  return page
    .getByTestId(`attention-project-${workspace.projectId}`)
    .getByRole("switch", { name: workspace.projectDisplayName, exact: true });
}
