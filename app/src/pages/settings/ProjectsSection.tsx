import { PathInput } from "@/components/ui/path-input";
import { Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
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
  const { t } = useTranslation("settings");
  return (
    <div className="space-y-4 p-4">
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0 pb-1">
          <CardTitle className="text-[13px]">{t("projects.title")}</CardTitle>
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
            <Plus /> {t("actions.add")}
          </Button>
        </CardHeader>
        <CardContent className="space-y-2">
          {draft.projects.length === 0 && (
            <Empty className="py-4">{t("projects.empty")}</Empty>
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
                  placeholder={t("projects.namePlaceholder")}
                  aria-label={t("projects.nameAria")}
                />
                <Button
                  size="xs"
                  variant="ghost"
                  aria-label={t("projects.deleteAria", {
                    name: p.name || t("projects.title"),
                  })}
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
                placeholder={t("projects.pathPlaceholder")}
                aria-label={t("projects.pathAria")}
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
                  placeholder={t("projects.branchPlaceholder")}
                  aria-label={t("projects.branchAria")}
                />
                <Input
                  className="h-7"
                  value={p.idPrefix}
                  onChange={(e) =>
                    patchDraft((d) => (d.projects[i].idPrefix = e.target.value))
                  }
                  placeholder={t("projects.idPrefixPlaceholder")}
                  aria-label={t("projects.idPrefixAria")}
                />
                <PathInput
                  className="h-7"
                  value={p.portableBase}
                  onValueChange={(value) =>
                    patchDraft((d) => (d.projects[i].portableBase = value))
                  }
                  placeholder={t("projects.portablePlaceholder")}
                  aria-label={t("projects.portableAria")}
                />
                <Input
                  className="h-7"
                  value={p.verify}
                  onChange={(e) =>
                    patchDraft((d) => (d.projects[i].verify = e.target.value))
                  }
                  placeholder={t("projects.verifyPlaceholder")}
                  aria-label={t("projects.verifyAria")}
                />
              </div>
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
