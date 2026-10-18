import { expect, test } from "../support/fixtures";
import {
  attentionProjectSwitch,
  attentionProjectsSection,
  chooseAttentionScope,
  finishMockAgent,
  readRecordedNotifications,
  recordOsNotifications,
} from "../support/helpers/attention-projects";
import { seedWorkspace } from "../support/helpers/seed-client";
import { openSettingsSection } from "../support/helpers/settings";

test("raises OS notifications only for the chosen projects", async ({ page }, testInfo) => {
  test.setTimeout(120_000);
  const chats = await seedWorkspace({ repoPrefix: "attention-chats-" });
  const builds = await seedWorkspace({ repoPrefix: "attention-builds-" });
  const notifiedWorkspaces = async () =>
    (await readRecordedNotifications(page)).map((notification) => notification.workspaceId);

  try {
    await recordOsNotifications(page);
    await page.goto("/settings");
    await expect(page.getByTestId("settings-sidebar")).toBeVisible();
    await openSettingsSection(page, "notifications");
    await expect(attentionProjectsSection(page)).toBeVisible();

    await test.step("every project raises a notification by default", async () => {
      await expect(
        page.getByRole("button", { name: "Projects: Every project", exact: true }),
      ).toBeVisible();
      await expect(attentionProjectSwitch(page, builds)).toHaveCount(0);
      await finishMockAgent(builds, "Build lane before the choice");
      await expect.poll(notifiedWorkspaces, { timeout: 30_000 }).toEqual([builds.workspaceId]);
    });

    await test.step("chosen projects list every project switched off", async () => {
      await chooseAttentionScope(page, "Every project", "Chosen projects");
      await expect(attentionProjectSwitch(page, chats)).toHaveAttribute("aria-checked", "false");
      await expect(attentionProjectSwitch(page, builds)).toHaveAttribute("aria-checked", "false");
      await attentionProjectSwitch(page, chats).click();
      await expect(attentionProjectSwitch(page, chats)).toHaveAttribute("aria-checked", "true");
      await attentionProjectsSection(page).screenshot({
        path: testInfo.outputPath("attention-projects-chosen.png"),
      });
    });

    await test.step("only the chosen project raises a notification", async () => {
      // The build agent finishes first, so its banner would land before the chat's.
      await finishMockAgent(builds, "Build lane after the choice");
      await finishMockAgent(chats, "Chat");
      await expect
        .poll(notifiedWorkspaces, { timeout: 30_000 })
        .toEqual([builds.workspaceId, chats.workspaceId]);
    });

    await test.step("the choice survives a reload", async () => {
      await page.reload();
      await expect(attentionProjectSwitch(page, chats)).toHaveAttribute("aria-checked", "true");
      await expect(attentionProjectSwitch(page, builds)).toHaveAttribute("aria-checked", "false");
    });
  } finally {
    await chats.cleanup();
    await builds.cleanup();
  }
});
