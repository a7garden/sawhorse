import type { Project } from "@/features/workbench/types";
import { sddApi } from "@/features/workbench/api";
import { Select } from "@/components/ui/select";
import { BrowseButton } from "@/components/ui/path-input";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  FileInput,
  Pause,
  Play,
  RotateCw,
  ShieldCheck,
  StopCircle,
} from "lucide-react";
import { api } from "@/lib/api";
import type { IngestionJob } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Textarea } from "@/components/ui/input";
import { PageHeader } from "./common";

export default function OnboardingPage({
  project,
  onBack,
}: {
  project?: Project;
  onBack?: () => void;
}) {
  const { t } = useTranslation("packs");
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectId, setProjectId] = useState(project?.id ?? "");
  const [paths, setPaths] = useState(project?.repoPath ?? "");
  const [outputPrefix, setOutputPrefix] = useState("generated");
  const [autoApply, setAutoApply] = useState(false);
  const [jobs, setJobs] = useState<IngestionJob[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function load() {
    const list = await api.ingestionList();
    setJobs(list);
    const relevant = list.filter(
      (item) => !projectId || item.projectId === projectId,
    );
    if (!relevant.some((item) => item.id === selected))
      setSelected(relevant[0]?.id ?? null);
  }
  useEffect(() => {
    void sddApi
      .snapshot()
      .then((s) => setProjects(s.projects))
      .catch((e) => setMessage(String(e)));
    void load().catch((error) => setMessage(String(error)));
  }, []);
  const visibleJobs = jobs.filter(
    (item) => !projectId || item.projectId === projectId,
  );
  const job = visibleJobs.find((item) => item.id === selected) ?? null;

  async function action(work: () => Promise<unknown>) {
    setBusy(true);
    setMessage(null);
    try {
      await work();
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {onBack && (
        <div className="border-b px-5 py-2">
          <Button size="sm" variant="ghost" onClick={onBack}>
            ← {project?.name ?? t("onboarding.backFallback")}
          </Button>
        </div>
      )}
      <PageHeader
        title={
          project
            ? t("onboarding.titleWithProject", { name: project.name })
            : t("onboarding.title")
        }
      />
      <div className="min-h-0 flex-1 overflow-auto p-5">
        <div className="mx-auto grid max-w-7xl gap-4 lg:grid-cols-[360px_1fr]">
          <div className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>{t("onboarding.newImport")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-3">
                <label className="text-xs">
                  {t("onboarding.project")}
                  <Select
                    aria-label={t("onboarding.projectAria")}
                    value={projectId}
                    disabled={!!project}
                    onChange={(event) => {
                      setProjectId(event.target.value);
                      setSelected(null);
                    }}
                  >
                    <option value="">{t("select.project")}</option>
                    {(project ? [project] : projects).map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.name}
                      </option>
                    ))}
                  </Select>
                </label>
                <label className="text-xs">
                  {t("onboarding.inputPaths")}
                  <Textarea
                    className="min-h-28"
                    value={paths}
                    onChange={(event) => setPaths(event.target.value)}
                    placeholder="/path/to/repository&#10;/path/to/proposal.docx"
                  />
                </label>
                <div className="flex gap-2">
                  {[true, false].map((directory) => (
                    <BrowseButton
                      key={String(directory)}
                      directory={directory}
                      multiple
                      onSelect={(selected) =>
                        setPaths((current) =>
                          [
                            ...new Set([
                              ...current.split("\n").filter(Boolean),
                              ...selected,
                            ]),
                          ].join("\n"),
                        )
                      }
                    />
                  ))}
                </div>
                <label className="text-xs">
                  {t("onboarding.outputFolder")}
                  <Input
                    value={outputPrefix}
                    onChange={(event) => setOutputPrefix(event.target.value)}
                  />
                </label>
                <label className="flex items-center gap-2 text-xs">
                  <input
                    type="checkbox"
                    checked={autoApply}
                    onChange={(event) => setAutoApply(event.target.checked)}
                  />{" "}
                  {t("onboarding.autoApply")}
                </label>
                <Button
                  disabled={busy || !projectId || !paths.trim()}
                  onClick={() =>
                    void action(async () => {
                      const sourcePaths = paths
                        .split("\n")
                        .map((value) => value.trim())
                        .filter(Boolean);
                      const created = await api.ingestionStart({
                        projectId,
                        outputPrefix,
                        autoApply,
                        sources: sourcePaths.map((path, index) => ({
                          path,
                          label: `source-${index + 1}`,
                        })),
                      });
                      setSelected(created.id);
                    })
                  }
                >
                  <FileInput /> {t("onboarding.createDrafts")}
                </Button>
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>{t("onboarding.runs")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-2">
                {visibleJobs.map((item) => (
                  <button
                    key={item.id}
                    onClick={() => setSelected(item.id)}
                    className={`w-full rounded-md border p-3 text-left text-xs ${selected === item.id ? "border-primary" : ""}`}
                  >
                    <span className="flex items-center gap-2">
                      <strong>{item.projectId}</strong>
                      <Badge
                        variant={
                          item.status === "failed"
                            ? "destructive"
                            : item.status === "applied"
                              ? "success"
                              : "outline"
                        }
                      >
                        {item.status}
                      </Badge>
                    </span>
                    <span className="mt-1 block text-muted-foreground">
                      {item.processedFiles}/{item.totalFiles} · {item.stage}
                    </span>
                  </button>
                ))}
              </CardContent>
            </Card>
          </div>
          <Card>
            <CardHeader>
              <CardTitle>{t("onboarding.progress")}</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              {message && (
                <div className="flex gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
                  <AlertTriangle className="size-4" />
                  {message}
                </div>
              )}
              {!job ? (
                <p className="text-sm text-muted-foreground">
                  {t("onboarding.pickHint")}
                </p>
              ) : (
                <>
                  <div className="grid grid-cols-3 gap-2 text-center text-xs">
                    <div className="rounded-md bg-muted p-3">
                      <strong className="block text-xl">
                        {job.processedFiles}
                      </strong>
                      {t("onboarding.processed")}
                    </div>
                    <div className="rounded-md bg-muted p-3">
                      <strong className="block text-xl">
                        {job.totalFiles}
                      </strong>
                      {t("onboarding.total")}
                    </div>
                    <div className="rounded-md bg-muted p-3">
                      <strong className="block text-xl">
                        {Math.round(job.processedBytes / 1024)}
                      </strong>
                      KiB
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      disabled={
                        busy || !["paused", "failed"].includes(job.status)
                      }
                      onClick={() =>
                        void action(() => api.ingestionResume(job.id))
                      }
                    >
                      <Play /> {t("onboarding.resume")}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={busy || job.status !== "running"}
                      onClick={() =>
                        void action(() => api.ingestionPause(job.id))
                      }
                    >
                      <Pause /> {t("onboarding.pause")}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={
                        busy || ["applied", "cancelled"].includes(job.status)
                      }
                      onClick={() =>
                        void action(() => api.ingestionCancel(job.id))
                      }
                    >
                      <StopCircle /> {t("onboarding.cancel")}
                    </Button>
                    <Button
                      size="sm"
                      disabled={
                        busy ||
                        job.status !== "waiting-review" ||
                        job.drafts.some((draft) => draft.conflict)
                      }
                      onClick={() =>
                        void action(() => api.ingestionApply(job.id))
                      }
                    >
                      <ShieldCheck /> {t("onboarding.applyReviewed")}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => void action(load)}
                    >
                      <RotateCw /> {t("actions.refresh")}
                    </Button>
                  </div>
                  {job.error && (
                    <p className="text-sm text-destructive">{job.error}</p>
                  )}
                  <div className="space-y-3">
                    {job.drafts.map((draft) => (
                      <article
                        key={draft.path}
                        className="rounded-md border p-3"
                      >
                        <div className="flex items-center gap-2">
                          <code className="text-xs">{draft.path}</code>
                          {draft.conflict && (
                            <Badge variant="destructive">
                              {t("onboarding.conflict")}
                            </Badge>
                          )}
                        </div>
                        {draft.conflictReason && (
                          <p className="mt-1 text-xs text-destructive">
                            {draft.conflictReason}
                          </p>
                        )}
                        <p className="mt-2 text-xs text-muted-foreground">
                          {t("onboarding.draftMeta", {
                            provenance: draft.provenance.length,
                            chars: draft.content.length,
                          })}
                        </p>
                        <details className="mt-2">
                          <summary className="cursor-pointer text-xs">
                            {t("onboarding.viewDraft")}
                          </summary>
                          <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-muted p-3 text-[11px]">
                            {draft.content}
                          </pre>
                        </details>
                      </article>
                    ))}
                  </div>
                </>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
