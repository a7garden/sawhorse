import { PathInput } from "@/components/ui/path-input";
import { Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ConfigView, ProjectCfg } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Empty } from "../common";
import { SectionCard } from "./parts";

export default function ProjectsSection({
  draft,
  patchDraft,
}: {
  draft: ConfigView;
  patchDraft: (fn: (d: ConfigView) => void) => void;
}) {
  const { t } = useTranslation("settings");
  return (
    <SectionCard
      title={t("projects.title")}
      desc={t("projects.desc")}
      actions={
        <Button
          size="sm"
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
      }
    >
      <div className="space-y-3">
        {draft.projects.length === 0 && (
          <Empty className="py-4">{t("projects.empty")}</Empty>
        )}
        {draft.projects.map((p, i) => (
          <div key={i} className="space-y-2.5 rounded-lg border p-3">
            <div className="flex items-center gap-2">
              <Input
                value={p.name}
                onChange={(e) =>
                  patchDraft((d) => (d.projects[i].name = e.target.value))
                }
                placeholder={t("projects.namePlaceholder")}
                aria-label={t("projects.nameAria")}
              />
              <Button
                size="icon"
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
              value={p.path}
              onValueChange={(value) =>
                patchDraft((d) => (d.projects[i].path = value))
              }
              placeholder={t("projects.pathPlaceholder")}
              aria-label={t("projects.pathAria")}
            />
            <div className="grid grid-cols-2 gap-2">
              <Input
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
                value={p.idPrefix}
                onChange={(e) =>
                  patchDraft(
                    (d) => (d.projects[i].idPrefix = e.target.value),
                  )
                }
                placeholder={t("projects.idPrefixPlaceholder")}
                aria-label={t("projects.idPrefixAria")}
              />
              <PathInput
                value={p.portableBase}
                onValueChange={(value) =>
                  patchDraft((d) => (d.projects[i].portableBase = value))
                }
                placeholder={t("projects.portablePlaceholder")}
                aria-label={t("projects.portableAria")}
              />
              <Input
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
      </div>
    </SectionCard>
  );
}
