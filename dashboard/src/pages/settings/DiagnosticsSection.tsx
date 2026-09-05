import { RefreshCw } from "lucide-react";
import type { Diagnostics } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty } from "../common";

export default function DiagnosticsSection({
  diag,
  vaultPath,
  onRefresh,
}: {
  diag: Diagnostics | null;
  vaultPath: string;
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
    </div>
  );
}
