// 설정 > 볼트 섹션. 문서와 작업 기록이 모이는 볼트 위치와, 볼트 안에서 작업을
// 맡길 프로젝트 등록을 한 화면에 둔다 — 프로젝트는 볼트 아래에 살고 기본
// 프로젝트도 프로젝트 목록을 따라 검증되므로 함께 봐야 관계가 보인다.
import type { ReactNode } from "react";
import { PathInput } from "@/components/ui/path-input";
import { Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ConfigView, ProjectCfg } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { useApp } from "@/lib/store";
import { Empty } from "../common";
import { SectionCard, SettingRow } from "./parts";

/// 라벨 + 컨트롤 한 칸. placeholder 만 있는 입력은 무엇을 넣는지 알기 어려워
/// 프로젝트 폼의 모든 필드가 이 칸을 쓴다.
function Field({
  id,
  label,
  children,
}: {
  id: string;
  label: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id}>{label}</Label>
      {children}
    </div>
  );
}

export default function VaultSection({
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
        title={t("general.saveLocation")}
        desc={t("general.saveLocationDesc")}
      >
        <div className="divide-y divide-border">
          <SettingRow
            stacked
            label={t("fields.vaultPath")}
            htmlFor="vault-path"
            control={
              <PathInput
                id="vault-path"
                value={draft.vaultPath}
                onValueChange={(value) =>
                  patchDraft((d) => (d.vaultPath = value))
                }
                placeholder="/path/to/vault"
              />
            }
          />
          <SettingRow
            label={t("fields.defaultProject")}
            htmlFor="default-project"
            control={
              <Select
                id="default-project"
                className="w-52"
                value={draft.defaultProject}
                onChange={(v) => patchDraft((d) => (d.defaultProject = v))}
                options={[
                  { value: "", label: t("general.noProject") },
                  ...draft.projects.map((p) => ({
                    value: p.name,
                    label: p.name,
                  })),
                ]}
              />
            }
          />
          <SettingRow
            label={t("page.schemas")}
            hint={t("general.schemasHint")}
            control={
              <Button
                size="sm"
                variant="outline"
                onClick={() => useApp.getState().setPage("schemas")}
              >
                {t("general.open")}
              </Button>
            }
          />
        </div>
      </SectionCard>

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
              <Field
                id={`project-${i}-name`}
                label={t("projects.nameAria")}
              >
                <div className="flex items-center gap-2">
                  <Input
                    id={`project-${i}-name`}
                    value={p.name}
                    onChange={(e) =>
                      patchDraft((d) => (d.projects[i].name = e.target.value))
                    }
                    placeholder={t("projects.namePlaceholder")}
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
              </Field>
              <Field
                id={`project-${i}-path`}
                label={t("projects.pathAria")}
              >
                <PathInput
                  id={`project-${i}-path`}
                  value={p.path}
                  onValueChange={(value) =>
                    patchDraft((d) => (d.projects[i].path = value))
                  }
                  placeholder={t("projects.pathPlaceholder")}
                />
              </Field>
              <div className="grid grid-cols-2 gap-2">
                <Field
                  id={`project-${i}-branch`}
                  label={t("projects.branchAria")}
                >
                  <Input
                    id={`project-${i}-branch`}
                    value={p.workBranch}
                    onChange={(e) =>
                      patchDraft(
                        (d) => (d.projects[i].workBranch = e.target.value),
                      )
                    }
                    placeholder={t("projects.branchPlaceholder")}
                  />
                </Field>
                <Field
                  id={`project-${i}-prefix`}
                  label={t("projects.idPrefixAria")}
                >
                  <Input
                    id={`project-${i}-prefix`}
                    value={p.idPrefix}
                    onChange={(e) =>
                      patchDraft(
                        (d) => (d.projects[i].idPrefix = e.target.value),
                      )
                    }
                    placeholder={t("projects.idPrefixPlaceholder")}
                  />
                </Field>
                <Field
                  id={`project-${i}-portable`}
                  label={t("projects.portableAria")}
                >
                  <PathInput
                    id={`project-${i}-portable`}
                    value={p.portableBase}
                    onValueChange={(value) =>
                      patchDraft((d) => (d.projects[i].portableBase = value))
                    }
                    placeholder={t("projects.portablePlaceholder")}
                  />
                </Field>
                <Field
                  id={`project-${i}-verify`}
                  label={t("projects.verifyAria")}
                >
                  <Input
                    id={`project-${i}-verify`}
                    value={p.verify}
                    onChange={(e) =>
                      patchDraft(
                        (d) => (d.projects[i].verify = e.target.value),
                      )
                    }
                    placeholder={t("projects.verifyPlaceholder")}
                  />
                </Field>
              </div>
            </div>
          ))}
        </div>
      </SectionCard>
    </div>
  );
}
