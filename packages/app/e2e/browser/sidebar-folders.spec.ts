import { expect, type Locator, type Page } from "@playwright/test";
import { test } from "../support/fixtures";
import { gotoAppShell } from "../support/helpers/app";
import { seedWorkspace } from "../support/helpers/seed-client";
import { getServerId } from "../support/helpers/server-id";
import {
  closeSidebarDisplayPreferences,
  openProjectContextMenu,
  openSidebarProjectFilter,
  selectAllProjectsFilter,
  toggleProjectFilter,
} from "../support/helpers/sidebar";

async function openMoveToFolder(page: Page, projectKey: string) {
  await openProjectContextMenu(page, projectKey);
  await page.getByTestId(`sidebar-project-menu-folder-${projectKey}`).click();
}

function folderRow(page: Page) {
  return page.locator('[data-testid^="sidebar-folder-row-"]');
}

// The New folder page can mount again as it opens and drop the typed name, which leaves Create
// disabled, so the name is typed again until Create takes it.
async function createFolderFromMenu(page: Page, name: string) {
  const nameField = page.getByTestId("sidebar-folder-create-name");
  const submit = page.getByTestId("sidebar-folder-create-submit");
  await page.getByTestId("sidebar-folder-create").click();
  await expect(async () => {
    await nameField.fill(name);
    await expect(submit).toBeEnabled({ timeout: 1_000 });
  }).toPass();
  await submit.click();
}

function folderRowNamed(page: Page, name: string) {
  return folderRow(page).filter({ hasText: name });
}

async function expectAbove(upper: Locator, lower: Locator) {
  await expect
    .poll(async () => {
      const [upperBox, lowerBox] = await Promise.all([upper.boundingBox(), lower.boundingBox()]);
      return upperBox !== null && lowerBox !== null && upperBox.y < lowerBox.y;
    })
    .toBe(true);
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

  test("a project filter shows the match inside a folded folder and offers every folder", async ({
    page,
  }, testInfo) => {
    const chats = await seedWorkspace({ repoPrefix: "folders-filter-chats-", title: "My chat" });
    const alma = await seedWorkspace({ repoPrefix: "folders-filter-alma-", title: "Alma lane" });
    const substrate = await seedWorkspace({
      repoPrefix: "folders-filter-substrate-",
      title: "Substrate lane",
    });
    const serverId = getServerId();
    const workspaceRow = (workspaceId: string) =>
      page.getByTestId(`sidebar-workspace-row-${serverId}:${workspaceId}`);
    const projectRow = (projectKey: string) =>
      page.getByTestId(`sidebar-project-row-${projectKey}`);
    const sidebar = page.getByTestId("sidebar-project-workspace-list-scroll").first();
    const filterTo = async (projectKey: string) => {
      await openSidebarProjectFilter(page);
      await selectAllProjectsFilter(page);
      await toggleProjectFilter(page, projectKey);
      await closeSidebarDisplayPreferences(page);
    };

    try {
      await gotoAppShell(page);
      for (const workspace of [chats, alma, substrate]) {
        await expect(workspaceRow(workspace.workspaceId)).toBeVisible({ timeout: 30_000 });
      }
      await openMoveToFolder(page, alma.projectKey);
      await page.getByTestId("sidebar-folder-create").click();
      await page.getByTestId("sidebar-folder-create-name").fill("Workers");
      await page.getByTestId("sidebar-folder-create-submit").click();
      await openMoveToFolder(page, substrate.projectKey);
      await page.getByRole("menuitem", { name: "Workers" }).click();
      await expect(projectRow(alma.projectKey)).toHaveCount(0);

      await test.step("a filter on a project in a folded folder shows the project", async () => {
        await filterTo(alma.projectKey);
        await expect(folderRow(page)).toHaveText(/Workers/);
        await expect(workspaceRow(alma.workspaceId)).toBeVisible();
        await expect(projectRow(substrate.projectKey)).toHaveCount(0);
        await sidebar.screenshot({ path: testInfo.outputPath("filter-1-match-shown.png") });
      });

      await test.step("the folder folds under the filter", async () => {
        await folderRow(page).click();
        await expect(projectRow(alma.projectKey)).toHaveCount(0);
        await folderRow(page).click();
        await expect(projectRow(alma.projectKey)).toBeVisible();
      });

      await test.step("a folder the filter hides is still offered", async () => {
        await filterTo(chats.projectKey);
        await expect(folderRow(page)).toHaveCount(0);
        await openMoveToFolder(page, chats.projectKey);
        await page.getByRole("menuitem", { name: "Workers" }).click();
        await expect(folderRow(page)).toHaveText(/Workers/);
        await expect(workspaceRow(chats.workspaceId)).toBeVisible();
      });

      await test.step("without the filter the folder is folded as it was saved", async () => {
        await openSidebarProjectFilter(page);
        await selectAllProjectsFilter(page);
        await closeSidebarDisplayPreferences(page);
        await expect(folderRow(page)).toHaveText(/Workers/);
        for (const project of [chats, alma, substrate]) {
          await expect(projectRow(project.projectKey)).toHaveCount(0);
        }
        await sidebar.screenshot({ path: testInfo.outputPath("filter-2-cleared.png") });
      });
    } finally {
      await substrate.cleanup();
      await alma.cleanup();
      await chats.cleanup();
    }
  });

  // A project taken from the middle of a folder, loose or into a new folder, must not split that
  // folder in the project order: a filter showing it beside a later member would then put the
  // folder below it (ALM-5055).
  test("a folder keeps its place under a filter after a middle project leaves it", async ({
    page,
  }, testInfo) => {
    const first = await seedWorkspace({ repoPrefix: "folders-regroup-first-", title: "First" });
    const second = await seedWorkspace({ repoPrefix: "folders-regroup-second-", title: "Second" });
    const third = await seedWorkspace({ repoPrefix: "folders-regroup-third-", title: "Third" });
    const fourth = await seedWorkspace({ repoPrefix: "folders-regroup-fourth-", title: "Fourth" });
    const serverId = getServerId();
    const workspaceRow = (workspaceId: string) =>
      page.getByTestId(`sidebar-workspace-row-${serverId}:${workspaceId}`);
    const projectRow = (projectKey: string) =>
      page.getByTestId(`sidebar-project-row-${projectKey}`);
    const sidebar = page.getByTestId("sidebar-project-workspace-list-scroll").first();
    const filterTo = async (projectKeys: string[]) => {
      await openSidebarProjectFilter(page);
      await selectAllProjectsFilter(page);
      for (const projectKey of projectKeys) await toggleProjectFilter(page, projectKey);
      await closeSidebarDisplayPreferences(page);
    };

    try {
      await gotoAppShell(page);
      for (const workspace of [first, second, third, fourth]) {
        await expect(workspaceRow(workspace.workspaceId)).toBeVisible({ timeout: 30_000 });
      }
      await openMoveToFolder(page, first.projectKey);
      await createFolderFromMenu(page, "Workers");
      for (const project of [second, third, fourth]) {
        await openMoveToFolder(page, project.projectKey);
        await page.getByRole("menuitem", { name: "Workers" }).click();
        await expect(projectRow(project.projectKey)).toHaveCount(0);
      }
      await folderRowNamed(page, "Workers").click();
      await expect(projectRow(second.projectKey)).toBeVisible();

      await test.step("a middle project taken out leaves the folder whole", async () => {
        await openMoveToFolder(page, second.projectKey);
        await page.getByTestId("sidebar-folder-take-out").click();
        await filterTo([second.projectKey, third.projectKey]);
        await expect(projectRow(third.projectKey)).toBeVisible();
        // The filter is on: the unfiltered list has Workers above Second either way.
        await expect(projectRow(first.projectKey)).toHaveCount(0);
        await expectAbove(folderRowNamed(page, "Workers"), projectRow(second.projectKey));
        await sidebar.screenshot({ path: testInfo.outputPath("regroup-1-taken-out.png") });
      });

      await test.step("a new folder from a middle project leaves the old one whole", async () => {
        await filterTo([]);
        await expect(projectRow(third.projectKey)).toBeVisible();
        await openMoveToFolder(page, third.projectKey);
        await createFolderFromMenu(page, "Lanes");
        await expect(folderRowNamed(page, "Lanes")).toHaveCount(1);
        await filterTo([third.projectKey, fourth.projectKey]);
        await expect(projectRow(fourth.projectKey)).toBeVisible();
        await expect(projectRow(first.projectKey)).toHaveCount(0);
        await expectAbove(folderRowNamed(page, "Workers"), folderRowNamed(page, "Lanes"));
        await sidebar.screenshot({ path: testInfo.outputPath("regroup-2-new-folder.png") });
      });
    } finally {
      await fourth.cleanup();
      await third.cleanup();
      await second.cleanup();
      await first.cleanup();
    }
  });
});
