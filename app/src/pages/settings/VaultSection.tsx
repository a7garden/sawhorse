// Settings > vault section. Places the vault location (where documents and work
// notes collect) and project registration (work delegation within the vault) on one
// screen — projects live under the vault and the default project is validated along
// with the project list, so the relationship is only visible together.
//
// The default flow for adding projects is folder selection: picking several folders
// at once fills rows with the folder name as the project name (already-registered
// paths are skipped). Only name·path are always visible; the detail fields used by
// the improvement cycle (branch·ID prefix·portable·validation) go in the advanced fold.
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

/// One label + control cell. Every input inside the advanced fold uses this cell.
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

/// Last path segment as the folder name. Also trims Windows separators.
function folderName(path: string): string {
  const parts = path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

/// A single project row. Name·path always visible, details behind the advanced fold.
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

  // Registers several folders at once. Skips existing paths; on name collisions adds
  // a "(2)" suffix to deduplicate — so saving never bounces back with a duplicate-name error.
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
