import { expect, type Page } from "@playwright/test";
import { test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import { openProjectContextMenu } from "../support/helpers/sidebar";

async function openMoveToFolder(page: Page, projectKey: string) {
  await openProjectContextMenu(page, projectKey);
  await page.getByTestId(`sidebar-project-menu-folder-${projectKey}`).click();
}

function folderRow(page: Page) {
  return page.locator('[data-testid^="sidebar-folder-row-"]');
}

test.describe("Sidebar folders", () => {
  test.describe.configure({ timeout: 180_000 });

  test("puts projects in a folder that folds them out of sight and keeps them", async ({
    page,
  }, testInfo) => {
    const chats = await seedWorkspace({ repoPrefix: "folders-chats-", title: "My chat" });
    const alma = await seedWorkspace({ repoPrefix: "folders-alma-", title: "Alma lane" });
    const substrate = await seedWorkspace({
      repoPrefix: "folders-substrate-",
      title: "Substrate lane",
    });
    const serverId = getServerId();
    const workspaceRow = (workspaceId: string) =>
      page.getByTestId(`sidebar-workspace-row-${serverId}:${workspaceId}`);
    const projectRow = (projectKey: string) =>
      page.getByTestId(`sidebar-project-row-${projectKey}`);
    const sidebar = page.getByTestId("sidebar-project-workspace-list-scroll").first();

    try {
      await gotoAppShell(page);
      for (const workspace of [chats, alma, substrate]) {
        await expect(workspaceRow(workspace.workspaceId)).toBeVisible({ timeout: 30_000 });
      }
      await sidebar.screenshot({ path: testInfo.outputPath("1-before.png") });

      await test.step("a new folder takes the project's place, folded", async () => {
        await openMoveToFolder(page, alma.projectKey);
        await page.getByTestId("sidebar-folder-create").click();
        await page.getByTestId("sidebar-folder-create-name").fill("Workers");
        await page.getByTestId("sidebar-folder-create-submit").click();
        await expect(folderRow(page)).toHaveText(/Workers/);
        await expect(projectRow(alma.projectKey)).toHaveCount(0);
        await expect(workspaceRow(chats.workspaceId)).toBeVisible();
      });

      await test.step("a second project joins the folder from its menu", async () => {
        await openMoveToFolder(page, substrate.projectKey);
        await page.getByRole("menuitem", { name: "Workers" }).click();
        await expect(projectRow(substrate.projectKey)).toHaveCount(0);
        await expect(folderRow(page)).toHaveCount(1);
        await sidebar.screenshot({ path: testInfo.outputPath("2-folded.png") });
      });

      await test.step("the folder opens to its projects", async () => {
        await folderRow(page).click();
        await expect(projectRow(alma.projectKey)).toBeVisible();
        await expect(projectRow(substrate.projectKey)).toBeVisible();
        await sidebar.screenshot({ path: testInfo.outputPath("3-open.png") });
        await folderRow(page).click();
        await expect(projectRow(alma.projectKey)).toHaveCount(0);
      });

      await test.step("the folder survives a reload", async () => {
        await page.reload();
        await expect(workspaceRow(chats.workspaceId)).toBeVisible({ timeout: 30_000 });
        await expect(folderRow(page)).toHaveText(/Workers/);
        await expect(projectRow(alma.projectKey)).toHaveCount(0);
      });

      await test.step("removing the folder puts its projects back in the list", async () => {
        await folderRow(page).click({ button: "right" });
        await page.getByRole("menuitem", { name: "Remove folder" }).click();
        await expect(folderRow(page)).toHaveCount(0);
        await expect(projectRow(alma.projectKey)).toBeVisible();
        await expect(projectRow(substrate.projectKey)).toBeVisible();
      });
    } finally {
      await substrate.cleanup();
      await alma.cleanup();
      await chats.cleanup();
    }
  });
});
