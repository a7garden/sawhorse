import { PathInput } from "@/components/ui/path-input";
import type {
  ConfigView,
  HerdrCleanup,
  HerdrMode,
  PermissionMode,
} from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useTranslation } from "react-i18next";

import {
  HERDR_CLEANUP_OPTIONS,
  HERDR_MODE_OPTIONS,
  PERMISSION_OPTIONS,
  clampInt,
} from "./constants";

export default function ExecutionSection({
  draft,
  patchDraft,
}: {
  draft: ConfigView;
  patchDraft: (fn: (d: ConfigView) => void) => void;
}) {
  const { t } = useTranslation("settings");
  return (
    <div className="grid items-start gap-4 p-4 lg:grid-cols-2">
      <div className="space-y-4">
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-[13px]">{t("exec.runOptions")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="claude-bin">{t("fields.claudeBin")}</Label>
              <PathInput
                directory={false}
                id="claude-bin"
                value={draft.dashboard.claudeBin}
                onValueChange={(value) =>
                  patchDraft((d) => (d.dashboard.claudeBin = value))
                }
                placeholder="claude"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="perm-mode">{t("fields.permissionMode")}</Label>
              <Select
                id="perm-mode"
                className="w-full"
                value={draft.dashboard.permissionMode}
                onChange={(e) =>
                  patchDraft(
                    (d) =>
                      (d.dashboard.permissionMode = e.target
                        .value as PermissionMode),
                  )
                }
              >
                {PERMISSION_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {t(o.key)}
                  </option>
                ))}
              </Select>
              <p className="text-[11px] text-muted-foreground">
                {t("exec.permissionHint")}
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-1">
          <CardTitle className="text-[13px]">{t("exec.herdrTitle")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="herdr-mode">{t("exec.mode")}</Label>
            <Select
              id="herdr-mode"
              className="w-full"
              value={draft.dashboard.herdr.mode}
              onChange={(e) =>
                patchDraft(
                  (d) => (d.dashboard.herdr.mode = e.target.value as HerdrMode),
                )
              }
            >
              {HERDR_MODE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {t(o.key)}
                </option>
              ))}
            </Select>
            <p className="text-[11px] text-muted-foreground">
              {t("exec.herdrHint")}
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="herdr-bin">{t("fields.herdrBin")}</Label>
              <PathInput
                directory={false}
                id="herdr-bin"
                value={draft.dashboard.herdr.bin}
                onValueChange={(value) =>
                  patchDraft((d) => (d.dashboard.herdr.bin = value))
                }
                placeholder="herdr"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="herdr-session">{t("exec.sessionName")}</Label>
              <Input
                id="herdr-session"
                value={draft.dashboard.herdr.session}
                onChange={(e) =>
                  patchDraft(
                    (d) => (d.dashboard.herdr.session = e.target.value),
                  )
                }
                placeholder={t("exec.sessionPlaceholder")}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="herdr-cleanup">{t("exec.cleanupLabel")}</Label>
              <Select
                id="herdr-cleanup"
                className="w-full"
                value={draft.dashboard.herdr.cleanup}
                onChange={(e) =>
                  patchDraft(
                    (d) =>
                      (d.dashboard.herdr.cleanup = e.target
                        .value as HerdrCleanup),
                  )
                }
              >
                {HERDR_CLEANUP_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                  {t(o.key)}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="herdr-parallel">{t("exec.parallel")}</Label>
              <Input
                id="herdr-parallel"
                type="number"
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
            </div>
            <div className="space-y-1">
              <Label htmlFor="herdr-start">{t("exec.startTimeout")}</Label>
              <Input
                id="herdr-start"
                type="number"
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
            </div>
            <div className="space-y-1">
              <Label htmlFor="herdr-timeout">{t("exec.jobTimeout")}</Label>
              <Input
                id="herdr-timeout"
                type="number"
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
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Switch
              id="herdr-notify"
              checked={draft.dashboard.herdr.notify}
              onCheckedChange={(on) =>
                patchDraft((d) => (d.dashboard.herdr.notify = on))
              }
            />
            <Label htmlFor="herdr-notify">{t("exec.notify")}</Label>
          </div>
          <p className="text-[11px] text-muted-foreground">
            {t("exec.workspaceHint", {
              workspace: draft.dashboard.herdr.workspaceLabel,
            })}
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
