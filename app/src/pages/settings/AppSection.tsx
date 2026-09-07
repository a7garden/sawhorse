import { Check, Monitor, Moon, Sun, Zap } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ConfigView } from "@/lib/types";
import { useTheme } from "@/lib/theme";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { getLanguage, setLanguage, type Language } from "@/i18n";
import { SettingsGroup, SettingRow } from "./parts";

export default function AppSection({ draft, onLaunchAtLogin }: {
  draft: ConfigView;
  onLaunchAtLogin: (on: boolean) => void;
}) {
  const { t } = useTranslation("common");
  const { t: ts } = useTranslation("settings");
  const theme = useTheme((s) => s.theme);
  const setTheme = useTheme((s) => s.setTheme);
  const themes = [
    { value: "light", Icon: Sun },
    { value: "dark", Icon: Moon },
    { value: "system", Icon: Monitor },
  ] as const;
  return (
    <div className="space-y-6">
      <SettingsGroup title={ts("appearance.title")} desc={ts("appearance.desc")}>
        <div className="settings-theme-options" role="radiogroup" aria-label={ts("appearance.title")}>
          {themes.map(({ value, Icon }) => (
            <label key={value} className="settings-theme-option">
              <input className="settings-theme-input" type="radio" name="settings-theme" value={value}
                checked={theme === value} onChange={() => setTheme(value)} />
              <span className="settings-theme-preview" data-theme={value} aria-hidden>
                <i /><span><b /><b /><em /></span>
              </span>
              <span className="settings-theme-label"><Icon aria-hidden className="size-3.5" />
                {ts(`appearance.${value}`)}{theme === value && <Check aria-hidden className="settings-theme-check size-3.5" />}
              </span>
            </label>
          ))}
        </div>
      </SettingsGroup>
      <SettingsGroup title={ts("appearance.general")}>
        <div className="divide-y divide-border">
          <SettingRow label={t("language")} hint={ts("appearance.languageHint")}
            htmlFor="app-language" control={
              <Select id="app-language" className="w-52" value={getLanguage()}
                onChange={(v) => setLanguage(v as Language)}
                options={[{ value: "ko", label: "한국어" }, { value: "en", label: "English" }]} />
            } />
          <SettingRow label={ts("general.launchAtLogin")} hint={ts("appearance.launchHint")}
            htmlFor="launch-at-login" control={
              <Switch id="launch-at-login" checked={draft.dashboard.launchAtLogin}
                onCheckedChange={onLaunchAtLogin} />
            } />
        </div>
      </SettingsGroup>
      <p className="settings-inline-note"><Zap aria-hidden className="size-3 shrink-0" />{ts("appearance.immediate")}</p>
    </div>
  );
}
