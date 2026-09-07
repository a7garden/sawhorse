// 설정 > 볼트 섹션. 문서와 작업 기록이 모이는 볼트 위치와, 볼트 안에서 작업을
// 맡길 프로젝트 등록을 한 화면에 둔다 — 프로젝트는 볼트 아래에 살고 기본
// 프로젝트도 프로젝트 목록을 따라 검증되므로 함께 봐야 관계가 보인다.
//
// 프로젝트 등록의 기본 흐름은 폴더 선택이다: 여러 폴더를 한 번에 고르면 폴더명이
// 프로젝트명으로 채워진 행이 된다(이미 등록된 경로는 건너뛴다). 이름·경로만 항상
// 보이고, 개선 사이클이 쓰는 상세 필드(브랜치·ID 접두·portable·검증)는 고급 접기에 둔다.
import type { ReactNode } from "react";
import { useState } from "react";
import { ChevronRight, Plus, Trash2 } from "lucide-react";
import { BrowseButton, PathInput } from "@/components/ui/path-input";
import { useTranslation } from "react-i18next";
import type { ConfigView, ProjectCfg } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { useApp } from "@/lib/store";
import { cn } from "@/lib/utils";
import { SettingsGroup, SettingRow } from "./parts";

/// 라벨 + 컨트롤 한 칸. 고급 접기 안의 모든 입력이 이 칸을 쓴다.
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

/// 경로 끝 조각을 폴더명으로. 윈도 구분자도 함께 자른다.
function folderName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/// 프로젝트 행 한 개. 이름·경로는 항상 보이고 상세는 고급 접기 뒤에 둔다.
function ProjectRow({
  index,
  project,
  patchDraft,
}: {
  index: number;
  project: ProjectCfg;
  patchDraft: (fn: (d: ConfigView) => void) => void;
}) {
  const { t } = useTranslation("settings");
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-2 py-3 first:pt-0 last:pb-0">
      <div className="flex items-center gap-1.5">
        <Input
          aria-label={t("projects.nameAria")}
          value={project.name}
          onChange={(e) =>
            patchDraft((d) => (d.projects[index].name = e.target.value))
          }
          placeholder={t("projects.namePlaceholder")}
        />
        <Button
          size="icon"
          variant="ghost"
          aria-label={t("projects.deleteAria", {
            name: project.name || t("projects.title"),
          })}
          onClick={() => patchDraft((d) => d.projects.splice(index, 1))}
        >
          <Trash2 />
        </Button>
      </div>
      <PathInput
        value={project.path}
        onValueChange={(value) =>
          patchDraft((d) => (d.projects[index].path = value))
        }
        placeholder={t("projects.pathPlaceholder")}
      />
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronRight
          className={cn("size-3 transition-transform", open && "rotate-90")}
        />
        {t("projects.advanced")}
      </button>
      {open && (
        <div className="grid grid-cols-2 gap-2 pt-1">
          <Field
            id={`project-${index}-branch`}
            label={t("projects.branchAria")}
          >
            <Input
              id={`project-${index}-branch`}
              value={project.workBranch}
              onChange={(e) =>
                patchDraft(
                  (d) => (d.projects[index].workBranch = e.target.value),
                )
              }
              placeholder={t("projects.branchPlaceholder")}
            />
          </Field>
          <Field
            id={`project-${index}-prefix`}
            label={t("projects.idPrefixAria")}
          >
            <Input
              id={`project-${index}-prefix`}
              value={project.idPrefix}
              onChange={(e) =>
                patchDraft(
                  (d) => (d.projects[index].idPrefix = e.target.value),
                )
              }
              placeholder={t("projects.idPrefixPlaceholder")}
            />
          </Field>
          <Field
            id={`project-${index}-portable`}
            label={t("projects.portableAria")}
          >
            <PathInput
              id={`project-${index}-portable`}
              value={project.portableBase}
              onValueChange={(value) =>
                patchDraft((d) => (d.projects[index].portableBase = value))
              }
              placeholder={t("projects.portablePlaceholder")}
            />
          </Field>
          <Field
            id={`project-${index}-verify`}
            label={t("projects.verifyAria")}
          >
            <Input
              id={`project-${index}-verify`}
              value={project.verify}
              onChange={(e) =>
                patchDraft(
                  (d) => (d.projects[index].verify = e.target.value),
                )
              }
              placeholder={t("projects.verifyPlaceholder")}
            />
          </Field>
        </div>
      )}
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

  // 폴더 여러 개를 한 번에 등록한다. 이미 있는 경로는 건너뛰고, 이름이 겹치면
  // "(2)" 접미로 겹치지 않게 만든다 — 저장 때 이름 중복으로 되돌아오지 않게.
  function addFolders(picked: string[]) {
    patchDraft((d) => {
      const names = new Set(d.projects.map((p) => p.name));
      const paths = new Set(d.projects.map((p) => p.path));
      for (const path of picked) {
        if (paths.has(path)) continue;
        paths.add(path);
        let name = folderName(path);
        for (let n = 2; names.has(name); n += 1) {
          name = `${folderName(path)} (${n})`;
        }
        names.add(name);
        d.projects.push({
          name,
          path,
          workBranch: "main",
          portableBase: "",
          idPrefix: "",
          verify: "",
        });
      }
    });
  }

  function addManual() {
    patchDraft((d) => {
      d.projects.push({
        name: "",
        path: "",
        workBranch: "main",
        portableBase: "",
        idPrefix: "",
        verify: "",
      });
    });
  }

  return (
    <div className="space-y-6">
      <SettingsGroup
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
      </SettingsGroup>

      <SettingsGroup
        title={t("projects.title")}
        desc={t("projects.desc")}
        actions={
          <>
            <BrowseButton
              directory
              multiple
              label={t("projects.pickFolders")}
              onSelect={addFolders}
            />
            <Button size="sm" variant="ghost" onClick={addManual}>
              <Plus /> {t("actions.add")}
            </Button>
          </>
        }
      >
        {draft.projects.length === 0 ? (
          <p className="py-2 text-xs leading-snug text-muted-foreground">
            {t("projects.emptyHint")}
          </p>
        ) : (
          <div className="divide-y divide-border">
            {draft.projects.map((p, i) => (
              <ProjectRow
                key={i}
                index={i}
                project={p}
                patchDraft={patchDraft}
              />
            ))}
          </div>
        )}
      </SettingsGroup>
    </div>
  );
}
