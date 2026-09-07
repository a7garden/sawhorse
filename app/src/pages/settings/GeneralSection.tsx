import { PathInput } from "@/components/ui/path-input";
import type { ConfigView } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useTranslation } from "react-i18next";

import { getLanguage, setLanguage, type Language } from "@/i18n";

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
    <div className="grid items-start gap-4 p-4 lg:grid-cols-2">
      <Card>
        <CardHeader className="pb-1">
          <CardTitle className="text-[13px]">{ts("general.saveLocation")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="vault-path">{ts("fields.vaultPath")}</Label>
            <PathInput
              id="vault-path"
              value={draft.vaultPath}
              onValueChange={(value) =>
                patchDraft((d) => (d.vaultPath = value))
              }
              placeholder="/path/to/vault"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="default-project">{ts("fields.defaultProject")}</Label>
            <Select
              id="default-project"
              className="w-full"
              value={draft.defaultProject}
              onChange={(e) =>
                patchDraft((d) => (d.defaultProject = e.target.value))
              }
            >
              <option value="">{ts("general.noProject")}</option>
              {draft.projects.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                </option>
              ))}
            </Select>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-1">
          <CardTitle className="text-[13px]">{ts("general.appTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2">
            <Switch
              id="launch-at-login"
              checked={draft.dashboard.launchAtLogin}
              onCheckedChange={(on) => onLaunchAtLogin(on)}
            />
            <Label htmlFor="launch-at-login">{ts("general.launchAtLogin")}</Label>
          </div>
          <div className="flex items-center gap-2">
            <Label htmlFor="app-language">{t("language")}</Label>
            <Select
              id="app-language"
              className="w-full"
              value={getLanguage()}
              onChange={(e) => setLanguage(e.target.value as Language)}
            >
              <option value="ko">한국어</option>
              <option value="en">English</option>
            </Select>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
