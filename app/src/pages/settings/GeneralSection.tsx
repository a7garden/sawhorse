import type { ConfigView } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";

export default function GeneralSection({
  draft,
  patchDraft,
  onLaunchAtLogin,
}: {
  draft: ConfigView;
  patchDraft: (fn: (d: ConfigView) => void) => void;
  onLaunchAtLogin: (on: boolean) => void;
}) {
  return (
    <div className="grid items-start gap-4 p-4 lg:grid-cols-2">
      <Card>
        <CardHeader className="pb-1">
          <CardTitle className="text-[13px]">저장 위치</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="vault-path">볼트 경로</Label>
            <Input
              id="vault-path"
              value={draft.vaultPath}
              onChange={(e) => patchDraft((d) => (d.vaultPath = e.target.value))}
              placeholder="/path/to/vault"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="default-project">기본 프로젝트</Label>
            <Select
              id="default-project"
              className="w-full"
              value={draft.defaultProject}
              onChange={(e) => patchDraft((d) => (d.defaultProject = e.target.value))}
            >
              <option value="">(없음)</option>
              {draft.projects.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1">
            <Label htmlFor="excel-dir">엑셀 출력 폴더</Label>
            <Input
              id="excel-dir"
              value={draft.dashboard.excelOutputDir}
              onChange={(e) => patchDraft((d) => (d.dashboard.excelOutputDir = e.target.value))}
              placeholder="/path/to/output"
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-1">
          <CardTitle className="text-[13px]">앱</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center gap-2">
            <Switch
              id="launch-at-login"
              checked={draft.dashboard.launchAtLogin}
              onCheckedChange={(on) => onLaunchAtLogin(on)}
            />
            <Label htmlFor="launch-at-login">로그인 시 자동 시작</Label>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
