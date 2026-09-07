import { PathInput } from "@/components/ui/path-input";
import type {
  ConfigView,
  HerdrCleanup,
  HerdrMode,
  PermissionMode,
} from "@/lib/types";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useTranslation } from "react-i18next";

import {
  HERDR_CLEANUP_OPTIONS,
  HERDR_MODE_OPTIONS,
  PERMISSION_OPTIONS,
  clampInt,
} from "./constants";
import { SectionCard, SettingRow } from "./parts";

export default function ExecutionSection({
  draft,
  patchDraft,
}: {
  draft: ConfigView;
  patchDraft: (fn: (d: ConfigView) => void) => void;
}) {
  const { t } = useTranslation("settings");
  return (
    <div className="space-y-4">
      <SectionCard
        title={t("exec.runOptions")}
        desc={t("exec.runOptionsDesc")}
      >
        <div className="divide-y divide-border">
          <SettingRow
            stacked
            label={t("fields.claudeBin")}
            htmlFor="claude-bin"
            control={
              <PathInput
                directory={false}
                id="claude-bin"
                value={draft.dashboard.claudeBin}
                onValueChange={(value) =>
                  patchDraft((d) => (d.dashboard.claudeBin = value))
                }
                placeholder="claude"
              />
            }
          />
          <SettingRow
            stacked
            label={t("fields.permissionMode")}
            htmlFor="perm-mode"
            hint={t("exec.permissionHint")}
            control={
              <Select
                id="perm-mode"
                className="w-full sm:w-80"
                value={draft.dashboard.permissionMode}
                onChange={(v) =>
                  patchDraft(
                    (d) => (d.dashboard.permissionMode = v as PermissionMode),
                  )
                }
                options={PERMISSION_OPTIONS.map((o) => ({
                  value: o.value,
                  label: t(o.key),
                }))}
              />
            }
          />
        </div>
      </SectionCard>

      <SectionCard title={t("exec.herdrTitle")} desc={t("exec.herdrDesc")}>
        <div className="divide-y divide-border">
          <SettingRow
            stacked
            label={t("exec.mode")}
            htmlFor="herdr-mode"
            hint={t("exec.herdrHint")}
            control={
              <Select
                id="herdr-mode"
                className="w-full sm:w-80"
                value={draft.dashboard.herdr.mode}
                onChange={(v) =>
                  patchDraft(
                    (d) => (d.dashboard.herdr.mode = v as HerdrMode),
                  )
                }
                options={HERDR_MODE_OPTIONS.map((o) => ({
                  value: o.value,
                  label: t(o.key),
                }))}
              />
            }
          />
          <SettingRow
            stacked
            label={t("fields.herdrBin")}
            htmlFor="herdr-bin"
            control={
              <PathInput
                directory={false}
                id="herdr-bin"
                value={draft.dashboard.herdr.bin}
                onValueChange={(value) =>
                  patchDraft((d) => (d.dashboard.herdr.bin = value))
                }
                placeholder="herdr"
              />
            }
          />
          <SettingRow
            label={t("exec.sessionName")}
            htmlFor="herdr-session"
            control={
              <Input
                id="herdr-session"
                className="w-52"
                value={draft.dashboard.herdr.session}
                onChange={(e) =>
                  patchDraft(
                    (d) => (d.dashboard.herdr.session = e.target.value),
                  )
                }
                placeholder={t("exec.sessionPlaceholder")}
              />
            }
          />
          <SettingRow
            label={t("exec.cleanupLabel")}
            htmlFor="herdr-cleanup"
            control={
              <Select
                id="herdr-cleanup"
                className="w-52"
                value={draft.dashboard.herdr.cleanup}
                onChange={(v) =>
                  patchDraft(
                    (d) => (d.dashboard.herdr.cleanup = v as HerdrCleanup),
                  )
                }
                options={HERDR_CLEANUP_OPTIONS.map((o) => ({
                  value: o.value,
                  label: t(o.key),
                }))}
              />
            }
          />
          <SettingRow
            label={t("exec.parallel")}
            htmlFor="herdr-parallel"
            control={
              <Input
                id="herdr-parallel"
                type="number"
                className="w-20"
                min={1}
                max={8}
                value={draft.dashboard.herdr.maxParallel}
                onChange={(e) =>
                  patchDraft(
                    (d) =>
                      (d.dashboard.herdr.maxParallel = clampInt(
                        e.target.value,
                        1,
                        8,
                        1,
                      )),
                  )
                }
              />
            }
          />
          <SettingRow
            label={t("exec.startTimeout")}
            htmlFor="herdr-start"
            control={
              <Input
                id="herdr-start"
                type="number"
                className="w-20"
                min={10}
                max={600}
                value={draft.dashboard.herdr.startTimeoutSec}
                onChange={(e) =>
                  patchDraft(
                    (d) =>
                      (d.dashboard.herdr.startTimeoutSec = clampInt(
                        e.target.value,
                        10,
                        600,
                        60,
                      )),
                  )
                }
              />
            }
          />
          <SettingRow
            label={t("exec.jobTimeout")}
            htmlFor="herdr-timeout"
            control={
              <Input
                id="herdr-timeout"
                type="number"
                className="w-20"
                min={0}
                value={draft.dashboard.herdr.jobTimeoutMin}
                onChange={(e) =>
                  patchDraft(
                    (d) =>
                      (d.dashboard.herdr.jobTimeoutMin = clampInt(
                        e.target.value,
                        0,
                        10080,
                        120,
                      )),
                  )
                }
              />
            }
          />
          <SettingRow
            label={t("exec.notify")}
            htmlFor="herdr-notify"
            control={
              <Switch
                id="herdr-notify"
                checked={draft.dashboard.herdr.notify}
                onCheckedChange={(on) =>
                  patchDraft((d) => (d.dashboard.herdr.notify = on))
                }
              />
            }
          />
        </div>
        <p className="mt-3 border-t pt-3 text-xs leading-snug text-muted-foreground">
          {t("exec.workspaceHint", {
            workspace: draft.dashboard.herdr.workspaceLabel,
          })}
        </p>
      </SectionCard>
    </div>
  );
}
