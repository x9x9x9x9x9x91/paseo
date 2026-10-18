import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";
import {
  SettingsCard,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
  SettingsSwitch,
} from "@/components/settings";
import { useAppSettings } from "@/hooks/use-settings";
import { useProjects } from "@/hooks/use-projects";
import {
  buildAttentionProjectRows,
  setProjectCountedForAttention,
  type AttentionProjectRow,
  type AttentionProjects,
} from "@/utils/attention-projects";

const SCOPES: readonly AttentionProjects["scope"][] = ["all", "chosen"];

function AttentionProjectSwitch({
  row,
  onCountedChange,
}: {
  row: AttentionProjectRow;
  onCountedChange: (projectId: string, counted: boolean) => void;
}) {
  const changeCounted = useCallback(
    (counted: boolean) => onCountedChange(row.projectId, counted),
    [onCountedChange, row.projectId],
  );
  return (
    <SettingsSwitch
      label={row.name}
      hint={row.hostName ?? undefined}
      value={row.counted}
      onValueChange={changeCounted}
      testID={`attention-project-${row.projectId}`}
    />
  );
}

/** Settings > Notifications: which projects count toward the dock badge and raise OS banners. */
export function AttentionProjectsSection() {
  const { t } = useTranslation();
  const { settings, updateSettings } = useAppSettings();
  const preference = settings.attentionProjects;
  const isChosen = preference.scope === "chosen";
  const { projects } = useProjects({ enabled: isChosen });
  const rows = useMemo(
    () => buildAttentionProjectRows(projects, preference),
    [projects, preference],
  );

  const scopeOptions = useMemo(
    () =>
      SCOPES.map((value) => ({
        value,
        label: t(`settings.notifications.projects.scope.options.${value}`),
      })),
    [t],
  );

  const changeScope = useCallback(
    (scope: AttentionProjects["scope"]) =>
      void updateSettings((current) => ({
        attentionProjects: { ...current.attentionProjects, scope },
      })),
    [updateSettings],
  );
  const changeCounted = useCallback(
    (projectId: string, counted: boolean) =>
      void updateSettings((current) => ({
        attentionProjects: setProjectCountedForAttention(
          current.attentionProjects,
          projectId,
          counted,
        ),
      })),
    [updateSettings],
  );

  return (
    <SettingsSection
      title={t("settings.notifications.projects.title")}
      info={t("settings.notifications.projects.info")}
      testID="attention-projects-section"
    >
      <SettingsCard>
        <SettingsSelect
          label={t("settings.notifications.projects.scope.label")}
          hint={t("settings.notifications.projects.scope.hint")}
          value={preference.scope}
          options={scopeOptions}
          onValueChange={changeScope}
        />
        {isChosen && rows.length === 0 ? (
          <SettingsRow label={t("settings.notifications.projects.empty")} />
        ) : null}
        {isChosen
          ? rows.map((row) => (
              <AttentionProjectSwitch
                key={row.projectId}
                row={row}
                onCountedChange={changeCounted}
              />
            ))
          : null}
      </SettingsCard>
    </SettingsSection>
  );
}
