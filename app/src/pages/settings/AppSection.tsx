// 설정 > 앱 섹션. 언어와 시스템 시작 동작. 두 값 모두 draft 를 타지 않고
// 즉시 적용된다 — 언어는 i18n 저장소에, 자동 시작은 macOS/Windows 시스템 설정에
// 각자 기록되기 때문이다.
import type { ConfigView } from "@/lib/types";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useTranslation } from "react-i18next";

import { getLanguage, setLanguage, type Language } from "@/i18n";
import { SectionCard, SettingRow } from "./parts";

export default function AppSection({
  draft,
  onLaunchAtLogin,
}: {
  draft: ConfigView;
  onLaunchAtLogin: (on: boolean) => void;
}) {
  const { t } = useTranslation("common");
  const { t: ts } = useTranslation("settings");
  return (
    <SectionCard>
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
  );
}
