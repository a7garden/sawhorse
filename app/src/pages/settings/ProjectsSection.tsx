import { PathInput } from "@/components/ui/path-input";
import { Plus, Trash2 } from "lucide-react";
import type { ConfigView, ProjectCfg } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Empty } from "../common";

export default function ProjectsSection({
  draft,
  patchDraft,
}: {
  draft: ConfigView;
  patchDraft: (fn: (d: ConfigView) => void) => void;
}) {
  return (
    <div className="space-y-4 p-4">
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-1">
          <CardTitle className="text-[13px]">프로젝트</CardTitle>
          <Button
            size="xs"
            variant="outline"
            onClick={() =>
              patchDraft((d) => {
                const p: ProjectCfg = {
                  name: "",
                  path: "",
                  workBranch: "main",
                  portableBase: "",
                  idPrefix: "",
                  verify: "",
                };
                d.projects.push(p);
              })
            }
          >
            <Plus /> 추가
          </Button>
        </CardHeader>
        <CardContent className="space-y-2">
          {draft.projects.length === 0 && (
            <Empty className="py-4">등록된 프로젝트가 없습니다.</Empty>
          )}
          {draft.projects.map((p, i) => (
            <div key={i} className="space-y-2 rounded-lg border p-2.5">
              <div className="flex items-center gap-2">
                <Input
                  className="h-7 flex-1"
                  value={p.name}
                  onChange={(e) =>
                    patchDraft((d) => (d.projects[i].name = e.target.value))
                  }
                  placeholder="사업명"
                  aria-label="프로젝트 이름"
                />
                <Button
                  size="xs"
                  variant="ghost"
                  aria-label={`${p.name || "프로젝트"} 삭제`}
                  onClick={() => patchDraft((d) => d.projects.splice(i, 1))}
                >
                  <Trash2 />
                </Button>
              </div>
              <PathInput
                className="h-7"
                value={p.path}
                onValueChange={(value) =>
                  patchDraft((d) => (d.projects[i].path = value))
                }
                placeholder="프로젝트 경로"
                aria-label="프로젝트 경로"
              />
              <div className="grid grid-cols-2 gap-2">
                <Input
                  className="h-7"
                  value={p.workBranch}
                  onChange={(e) =>
                    patchDraft(
                      (d) => (d.projects[i].workBranch = e.target.value),
                    )
                  }
                  placeholder="작업 브랜치"
                  aria-label="작업 브랜치"
                />
                <Input
                  className="h-7"
                  value={p.idPrefix}
                  onChange={(e) =>
                    patchDraft((d) => (d.projects[i].idPrefix = e.target.value))
                  }
                  placeholder="ID 접두 (예: FDR)"
                  aria-label="ID 접두"
                />
                <PathInput
                  className="h-7"
                  value={p.portableBase}
                  onValueChange={(value) =>
                    patchDraft((d) => (d.projects[i].portableBase = value))
                  }
                  placeholder="portable 기준 경로"
                  aria-label="portable 기준 경로"
                />
                <Input
                  className="h-7"
                  value={p.verify}
                  onChange={(e) =>
                    patchDraft((d) => (d.projects[i].verify = e.target.value))
                  }
                  placeholder="검증 명령"
                  aria-label="검증 명령"
                />
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
