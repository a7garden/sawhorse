import { PathInput } from "@/components/ui/path-input";
import type { ConfigView } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useTranslation } from "react-i18next";
import { useApp } from "@/lib/store";

import { getLanguage, setLanguage, type Language } from "@/i18n";
import { SectionCard, SettingRow } from "./parts";

export default function GeneralSection({
  draft,
  patchDraft,
  onLaunchAtLogin,
}: {
  draft: ConfigView;
  patchDraft: (fn: (d: ConfigView) => void) => void;
  onLaunchAtLogin: (on: boolean) => void;
}) {
  const { t } = useTranslation("common");
  const { t: ts } = useTranslation("settings");
  return (
    <div className="space-y-4">
      <SectionCard
        title={ts("general.saveLocation")}
        desc={ts("general.saveLocationDesc")}
      >
        <div className="divide-y divide-border">
          <SettingRow
            stacked
            label={ts("fields.vaultPath")}
            htmlFor="vault-path"
            control={
              <PathInput
                id="vault-path"
                value={draft.vaultPath}
                onValueChange={(value) =>
                  patchDraft((d) => (d.vaultPath = value))
                }
                placeholder="/path/to/vault"
              />
            }
          />
          <SettingRow
            label={ts("fields.defaultProject")}
            htmlFor="default-project"
            control={
              <Select
                id="default-project"
                className="w-52"
                value={draft.defaultProject}
                onChange={(v) => patchDraft((d) => (d.defaultProject = v))}
                options={[
                  { value: "", label: ts("general.noProject") },
                  ...draft.projects.map((p) => ({
                    value: p.name,
                    label: p.name,
                  })),
                ]}
              />
            }
          />
          <SettingRow
            label={ts("page.schemas")}
            hint={ts("general.schemasHint")}
            control={
              <Button
                size="sm"
                variant="outline"
                onClick={() => useApp.getState().setPage("schemas")}
              >
                {ts("general.open")}
              </Button>
            }
          />
        </div>
      </SectionCard>

      <SectionCard title={ts("general.appTitle")}>
        <div className="divide-y divide-border">
          <SettingRow
            label={t("language")}
            htmlFor="app-language"
            control={
              <Select
                id="app-language"
                className="w-52"
                value={getLanguage()}
                onChange={(v) => setLanguage(v as Language)}
                options={[
                  { value: "ko", label: "한국어" },
                  { value: "en", label: "English" },
                ]}
              />
            }
          />
          <SettingRow
            label={ts("general.launchAtLogin")}
            htmlFor="launch-at-login"
            control={
              <Switch
                id="launch-at-login"
                checked={draft.dashboard.launchAtLogin}
                onCheckedChange={onLaunchAtLogin}
              />
            }
          />
        </div>
      </SectionCard>
    </div>
  );
}
