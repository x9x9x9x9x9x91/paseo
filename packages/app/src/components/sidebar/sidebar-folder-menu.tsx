import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactElement,
} from "react";
import { useTranslation } from "react-i18next";
import { withUnistyles } from "react-native-unistyles";
import { Folder, FolderMinus, FolderPlus } from "lucide-react-native";
import {
  MenuItem,
  MenuSeparator,
  MenuSubTrigger,
  MenuTextField,
  useMenuContext,
  type MenuPageDefinition,
} from "@/components/ui/menu";
import { normalizeSidebarFolderName, type SidebarFolder } from "@/stores/sidebar-folders-store";
import type { Theme } from "@/styles/theme";

/** The `MenuSubTrigger` on a project's menu that opens its folder page. */
export const PROJECT_FOLDER_PAGE_ID = "projectFolder";
const PROJECT_FOLDER_CREATE_PAGE_ID = "projectFolderCreate";
/** The `MenuSubTrigger` on a folder's menu that opens its rename page. */
export const FOLDER_RENAME_PAGE_ID = "folderRename";

const MENU_ICON_SIZE = 14;
const mutedMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const ThemedFolder = withUnistyles(Folder);
const ThemedFolderMinus = withUnistyles(FolderMinus);
const ThemedFolderPlus = withUnistyles(FolderPlus);
const FOLDER_LEADING = <ThemedFolder size={MENU_ICON_SIZE} uniProps={mutedMapping} />;
const TAKE_OUT_LEADING = <ThemedFolderMinus size={MENU_ICON_SIZE} uniProps={mutedMapping} />;
const CREATE_LEADING = <ThemedFolderPlus size={MENU_ICON_SIZE} uniProps={mutedMapping} />;

/**
 * What a project's menu can do with folders. The project list provides it, since putting a
 * project in a folder also moves it in the project order; a list without folders (the status
 * grouping) provides none, and the menu then offers no folder row.
 */
export interface SidebarFolderActions {
  folders: readonly SidebarFolder[];
  folderIdOf: (projectKey: string) => string | null;
  moveProjectToFolder: (projectKey: string, folderId: string | null) => void;
  createFolderWithProject: (name: string, projectKey: string) => void;
}

const SidebarFolderActionsContext = createContext<SidebarFolderActions | null>(null);

export const SidebarFolderActionsProvider = SidebarFolderActionsContext.Provider;

export function useSidebarFolderActions(): SidebarFolderActions | null {
  return useContext(SidebarFolderActionsContext);
}

const NO_PAGES: readonly MenuPageDefinition[] = [];

/** The two pages behind a project's "Move to folder" row, for its kebab and its right-click. */
export function useProjectFolderMenuPages(projectKey: string): readonly MenuPageDefinition[] {
  const { t } = useTranslation();
  const actions = useSidebarFolderActions();
  return useMemo(() => {
    if (!actions) return NO_PAGES;
    return [
      {
        id: PROJECT_FOLDER_PAGE_ID,
        title: t("sidebar.folder.moveTo"),
        content: <ProjectFolderPickerPage projectKey={projectKey} actions={actions} />,
      },
      {
        id: PROJECT_FOLDER_CREATE_PAGE_ID,
        title: t("sidebar.folder.create"),
        // A page you type into is not one the pointer opens or dismisses on its own.
        hoverIntent: false,
        content: <ProjectFolderCreatePage projectKey={projectKey} actions={actions} />,
      },
    ];
  }, [actions, projectKey, t]);
}

function ProjectFolderPickerPage({
  projectKey,
  actions,
}: {
  projectKey: string;
  actions: SidebarFolderActions;
}): ReactElement {
  const { t } = useTranslation();
  const currentFolderId = actions.folderIdOf(projectKey);
  const takeOut = useCallback(
    () => actions.moveProjectToFolder(projectKey, null),
    [actions, projectKey],
  );
  return (
    <>
      {actions.folders.map((folder) => (
        <ProjectFolderRow
          key={folder.id}
          folder={folder}
          projectKey={projectKey}
          selected={folder.id === currentFolderId}
          actions={actions}
        />
      ))}
      {actions.folders.length > 0 ? <MenuSeparator /> : null}
      {currentFolderId ? (
        <MenuItem leading={TAKE_OUT_LEADING} onSelect={takeOut} testID="sidebar-folder-take-out">
          {t("sidebar.folder.takeOut")}
        </MenuItem>
      ) : null}
      <MenuSubTrigger
        id={PROJECT_FOLDER_CREATE_PAGE_ID}
        leading={CREATE_LEADING}
        testID="sidebar-folder-create"
      >
        {t("sidebar.folder.create")}
      </MenuSubTrigger>
    </>
  );
}

function ProjectFolderRow({
  folder,
  projectKey,
  selected,
  actions,
}: {
  folder: SidebarFolder;
  projectKey: string;
  selected: boolean;
  actions: SidebarFolderActions;
}): ReactElement {
  const select = useCallback(
    () => actions.moveProjectToFolder(projectKey, folder.id),
    [actions, folder.id, projectKey],
  );
  return (
    <MenuItem
      leading={FOLDER_LEADING}
      selected={selected}
      onSelect={select}
      testID={`sidebar-folder-move-to-${folder.id}`}
    >
      {folder.name}
    </MenuItem>
  );
}

function ProjectFolderCreatePage({
  projectKey,
  actions,
}: {
  projectKey: string;
  actions: SidebarFolderActions;
}): ReactElement {
  const { t } = useTranslation();
  const menu = useMenuContext("ProjectFolderCreatePage");
  const [name, setName] = useState("");
  const valid = normalizeSidebarFolderName(name).length > 0;
  const create = useCallback(() => {
    if (!normalizeSidebarFolderName(name)) return;
    actions.createFolderWithProject(name, projectKey);
  }, [actions, name, projectKey]);
  const submitFromField = useCallback(() => {
    if (!normalizeSidebarFolderName(name)) return;
    menu.setOpen(false);
    create();
  }, [create, menu, name]);
  return (
    <>
      <MenuTextField
        onChangeText={setName}
        placeholder={t("sidebar.folder.name")}
        autoFocus
        onSubmitEditing={submitFromField}
        testID="sidebar-folder-create-name"
      />
      <MenuSeparator />
      <MenuItem disabled={!valid} onSelect={create} testID="sidebar-folder-create-submit">
        {t("sidebar.folder.createConfirm")}
      </MenuItem>
    </>
  );
}

/** The rename page behind a folder's "Rename" row. */
export function useFolderMenuPages(
  folder: SidebarFolder,
  onRename: (name: string) => void,
): readonly MenuPageDefinition[] {
  const { t } = useTranslation();
  return useMemo(
    () => [
      {
        id: FOLDER_RENAME_PAGE_ID,
        title: t("sidebar.folder.rename"),
        hoverIntent: false,
        content: <FolderRenamePage folder={folder} onRename={onRename} />,
      },
    ],
    [folder, onRename, t],
  );
}

function FolderRenamePage({
  folder,
  onRename,
}: {
  folder: SidebarFolder;
  onRename: (name: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const menu = useMenuContext("FolderRenamePage");
  const [name, setName] = useState(folder.name);
  const valid = normalizeSidebarFolderName(name).length > 0;
  const rename = useCallback(() => {
    if (!normalizeSidebarFolderName(name)) return;
    onRename(name);
  }, [name, onRename]);
  const submitFromField = useCallback(() => {
    if (!normalizeSidebarFolderName(name)) return;
    menu.setOpen(false);
    rename();
  }, [menu, name, rename]);
  return (
    <>
      <MenuTextField
        initialValue={folder.name}
        onChangeText={setName}
        placeholder={t("sidebar.folder.name")}
        autoFocus
        onSubmitEditing={submitFromField}
        testID={`sidebar-folder-rename-name-${folder.id}`}
      />
      <MenuSeparator />
      <MenuItem
        disabled={!valid}
        onSelect={rename}
        testID={`sidebar-folder-rename-submit-${folder.id}`}
      >
        {t("sidebar.folder.renameConfirm")}
      </MenuItem>
    </>
  );
}
