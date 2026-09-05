import type { ConfigView, HerdrCleanup, HerdrMode, PermissionMode } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  HERDR_CLEANUP_OPTIONS,
  HERDR_MODE_OPTIONS,
  PERMISSION_OPTIONS,
  ROUTINES,
  clampInt,
} from "./constants";

export default function ExecutionSection({
  draft,
  patchDraft,
}: {
  draft: ConfigView;
  patchDraft: (fn: (d: ConfigView) => void) => void;
}) {
  return (
    <div className="grid items-start gap-4 p-4 lg:grid-cols-2">
      <div className="space-y-4">
        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-[13px]">루틴 예약</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2.5">
            {ROUTINES.map((r) => {
              const s = draft.dashboard.schedules[r.key];
              return (
                <div key={r.key} className="flex items-center gap-2">
                  <Switch
                    id={`sched-${r.key}`}
                    checked={s.enabled}
                    onCheckedChange={(on) =>
                      patchDraft((d) => {
                        d.dashboard.schedules[r.key].enabled = on;
                      })
                    }
                  />
                  <Label htmlFor={`sched-${r.key}`} className="w-10">
                    {r.label}
                  </Label>
                  <Input
                    className="w-24"
                    value={s.time}
                    onChange={(e) =>
                      patchDraft((d) => {
                        d.dashboard.schedules[r.key].time = e.target.value;
                      })
                    }
                    placeholder="HH:MM"
                    aria-label={`${r.label} 루틴 시각`}
                  />
                </div>
              );
            })}
            <p className="text-[11px] text-muted-foreground">
              시각이 지나도 앱이 꺼져 있었다면 자동 실행하지 않고 홈에 알립니다.
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-1">
            <CardTitle className="text-[13px]">실행 옵션</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="claude-bin">claude 실행 파일</Label>
              <Input
                id="claude-bin"
                value={draft.dashboard.claudeBin}
                onChange={(e) => patchDraft((d) => (d.dashboard.claudeBin = e.target.value))}
                placeholder="claude"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="perm-mode">권한 모드</Label>
              <Select
                id="perm-mode"
                className="w-full"
                value={draft.dashboard.permissionMode}
                onChange={(e) =>
                  patchDraft((d) => (d.dashboard.permissionMode = e.target.value as PermissionMode))
                }
              >
                {PERMISSION_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
              <p className="text-[11px] text-muted-foreground">
                무인 루틴·구현 실행에는 권한 우회가 필요합니다. 안전망은 플러그인 승인·범위 게이트와 훅입니다.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-1">
          <CardTitle className="text-[13px]">herdr 세션</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="herdr-mode">실행 방식</Label>
            <Select
              id="herdr-mode"
              className="w-full"
              value={draft.dashboard.herdr.mode}
              onChange={(e) =>
                patchDraft((d) => (d.dashboard.herdr.mode = e.target.value as HerdrMode))
              }
            >
              {HERDR_MODE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
            <p className="text-[11px] text-muted-foreground">
              herdr로 실행하면 잡이 보이는 터미널 세션이 됩니다 — 도중에 이어받고, 승인
              프롬프트에 직접 답하고, 대시보드를 재시작해도 세션이 살아남습니다.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="herdr-bin">herdr 실행 파일</Label>
              <Input
                id="herdr-bin"
                value={draft.dashboard.herdr.bin}
                onChange={(e) => patchDraft((d) => (d.dashboard.herdr.bin = e.target.value))}
                placeholder="herdr"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="herdr-session">세션 이름</Label>
              <Input
                id="herdr-session"
                value={draft.dashboard.herdr.session}
                onChange={(e) =>
                  patchDraft((d) => (d.dashboard.herdr.session = e.target.value))
                }
                placeholder="(기본 세션)"
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="herdr-cleanup">끝난 뒤 탭</Label>
              <Select
                id="herdr-cleanup"
                className="w-full"
                value={draft.dashboard.herdr.cleanup}
                onChange={(e) =>
                  patchDraft(
                    (d) => (d.dashboard.herdr.cleanup = e.target.value as HerdrCleanup),
                  )
                }
              >
                {HERDR_CLEANUP_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1">
              <Label htmlFor="herdr-parallel">동시 실행</Label>
              <Input
                id="herdr-parallel"
                type="number"
                min={1}
                max={8}
                value={draft.dashboard.herdr.maxParallel}
                onChange={(e) =>
                  patchDraft(
                    (d) =>
                      (d.dashboard.herdr.maxParallel = clampInt(e.target.value, 1, 8, 1)),
                  )
                }
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="herdr-start">기동 대기 (초)</Label>
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
              <Label htmlFor="herdr-timeout">최대 실행 (분, 0=무제한)</Label>
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
              onCheckedChange={(on) => patchDraft((d) => (d.dashboard.herdr.notify = on))}
            />
            <Label htmlFor="herdr-notify">승인 대기·실패 시 herdr 알림</Label>
          </div>
          <p className="text-[11px] text-muted-foreground">
            잡마다 「{draft.dashboard.herdr.workspaceLabel}」 워크스페이스에 탭 하나가
            생깁니다. 승인 대기가 실제로 쓸모 있으려면 권한 모드를 `default` 또는
            `acceptEdits`로 두세요.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
