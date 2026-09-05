// 워크벤치 스킬 설치 카드 — Claude Code 개인 스킬(~/.claude)·Codex 프롬프트(~/.codex)의
// 설치 상태를 보여주고 설치 버튼을 제공한다. 백엔드: plugin.rs install_skill/skill_status.
import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { SkillInstall } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default function WorkbenchSkillCard() {
  const [status, setStatus] = useState<SkillInstall[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const refresh = useCallback(async () => setStatus(await api.skillStatus()), []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const install = async (target: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await api.installSkill(target);
      await refresh();
    } catch (e) {
      setMsg({ ok: false, text: `스킬 설치 실패: ${String(e)}` });
    } finally {
      setBusy(false);
    }
  };
  const label: Record<string, string> = { claude: "Claude Code", codex: "Codex" };
  return (
    <Card>
      <CardHeader className="pb-1">
        <CardTitle className="text-[13px]">워크벤치 스킬</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <p className="text-[11px] text-muted-foreground">
          터미널 에이전트가 “워크벤치에 작업 만들어줘”로 작업을 등록하는 스킬을 설치합니다.
        </p>
        {["claude", "codex"].map((t) => {
          const s = status?.find((x) => x.target === t);
          return (
            <div key={t} className="flex items-center gap-2">
              <span className="w-24 text-xs font-medium">{label[t]}</span>
              <Badge variant={s?.written ? "success" : "outline"}>
                {s?.written ? "설치됨" : "미설치"}
              </Badge>
              <Button size="xs" variant="outline" disabled={busy} onClick={() => void install(t)}>
                설치
              </Button>
              {s?.path && (
                <span className="truncate text-[11px] text-muted-foreground" title={s.path}>
                  {s.path}
                </span>
              )}
            </div>
          );
        })}
        {msg && (
          <div className={`text-xs ${msg.ok ? "text-success" : "text-destructive"}`}>{msg.text}</div>
        )}
      </CardContent>
    </Card>
  );
}
