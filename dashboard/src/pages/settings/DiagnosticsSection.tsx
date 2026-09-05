import { RefreshCw } from "lucide-react";
import type { AgentPresence, Diagnostics, RequirementStatus } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty } from "../common";
import DetectRow, { InstallButton, NeedBadge } from "../setup/DetectRow";

export default function DiagnosticsSection({
  diag,
  vaultPath,
  requirements,
  agents,
  defaultAgent,
  onRefresh,
}: {
  diag: Diagnostics | null;
  vaultPath: string;
  requirements: RequirementStatus[];
  agents: AgentPresence[];
  defaultAgent: string;
  onRefresh: () => void;
}) {
  return (
    <div className="space-y-4 p-4">
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-1">
          <CardTitle className="text-[13px]">진단</CardTitle>
          <Button size="xs" variant="outline" onClick={onRefresh}>
            <RefreshCw /> 다시 검사
          </Button>
        </CardHeader>
        <CardContent className="space-y-1.5">
          {!diag ? (
            <Empty className="py-4">검사 결과가 없습니다.</Empty>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <span className="w-24 text-xs font-medium">설정 파일</span>
                <Badge variant={diag.configExists ? "success" : "destructive"}>
                  {diag.configExists ? "정상" : "없음"}
                </Badge>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-24 text-xs font-medium">볼트 경로</span>
                <Badge variant={diag.vaultPathOk ? "success" : "destructive"}>
                  {diag.vaultPathOk ? "정상" : "문제"}
                </Badge>
                <span className="truncate text-[11px] text-muted-foreground" title={vaultPath}>
                  {vaultPath}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="w-24 text-xs font-medium">claude CLI</span>
                <Badge variant={diag.claudeOk ? "success" : "destructive"}>
                  {diag.claudeOk ? "정상" : "없음"}
                </Badge>
                {diag.claudeVersion && (
                  <span className="truncate text-[11px] text-muted-foreground">
                    {diag.claudeVersion}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                <span className="w-24 text-xs font-medium">herdr</span>
                <Badge
                  variant={
                    diag.herdr.mode === "headless"
                      ? "secondary"
                      : diag.herdr.serverOk
                        ? "success"
                        : "warning"
                  }
                >
                  {diag.herdr.mode === "headless"
                    ? "사용 안 함"
                    : diag.herdr.serverOk
                      ? "서버 연결됨"
                      : diag.herdr.binOk
                        ? "서버 없음"
                        : "미설치"}
                </Badge>
                <span className="truncate text-[11px] text-muted-foreground">
                  다음 잡: {diag.herdr.effectiveRunner === "herdr" ? "herdr 세션" : "백그라운드"}
                  {diag.herdr.version ? ` · ${diag.herdr.version}` : ""}
                </span>
              </div>
              {diag.projects.map((p) => (
                <div key={p.name} className="flex items-center gap-2 rounded border px-2 py-1">
                  <span className="w-24 truncate text-xs font-medium" title={p.name}>
                    {p.name}
                  </span>
                  <Badge variant={p.pathOk ? "success" : "destructive"}>경로</Badge>
                  <Badge variant={p.gitOk ? "success" : "destructive"}>git</Badge>
                  <Badge
                    variant={
                      p.branchOk == null ? "secondary" : p.branchOk ? "success" : "warning"
                    }
                  >
                    브랜치
                  </Badge>
                </div>
              ))}
            </>
          )}
        </CardContent>
      </Card>

      {/* 마법사의 「프로그램」 단계와 같은 목록. 첫 설치 뒤에 도구를 깔았을 때 마법사를
          다시 열지 않고 여기서 확인·설치할 수 있어야 한다. */}
      <Card>
        <CardHeader className="pb-1">
          <CardTitle className="text-[13px]">필요한 프로그램</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1.5">
          {requirements.length === 0 ? (
            <Empty className="py-4">검사 결과가 없습니다.</Empty>
          ) : (
            requirements.map((r) => (
              <DetectRow
                key={r.id}
                name={r.name}
                ok={r.detected}
                warn={r.outdated}
                badge={<NeedBadge need={r.need} missing={!r.detected} />}
                version={r.version}
                detail={r.why}
                path={r.detected ? r.path : undefined}
                hint={!r.detected ? r.installHint || undefined : undefined}
                action={
                  r.detected && !r.outdated ? undefined : <InstallButton url={r.installUrl} />
                }
              />
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-1">
          <CardTitle className="text-[13px]">에이전트</CardTitle>
        </CardHeader>
        <CardContent className="space-y-1.5">
          {agents.filter((a) => a.detected).length === 0 ? (
            <Empty className="py-4">감지된 에이전트가 없습니다.</Empty>
          ) : (
            agents
              .filter((a) => a.detected)
              .map((a) => (
                <DetectRow
                  key={a.id}
                  name={a.name}
                  ok
                  badge={
                    <>
                      {a.id === defaultAgent && <Badge variant="success">기본</Badge>}
                      {a.installable && <Badge variant="outline">스킬 설치 가능</Badge>}
                      {a.runsJobs && <Badge variant="outline">잡 실행</Badge>}
                    </>
                  }
                  version={a.version}
                  path={a.path}
                />
              ))
          )}
          <p className="text-[11px] text-muted-foreground">
            기본 에이전트는 마법사(설정 상단의 「마법사 다시 열기」)에서 바꿉니다.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
