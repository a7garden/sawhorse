import type { Project } from "@/features/workbench/types";
import { sddApi } from "@/features/workbench/api";
import { Select } from "@/components/ui/select";
import { BrowseButton } from "@/components/ui/path-input";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  AlertTriangle,
  FileStack,
  Inbox,
  Loader2,
  Pause,
  Play,
  ShieldCheck,
  StopCircle,
  X,
} from "lucide-react";
import { api } from "@/lib/api";
import type { IngestionJob } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader } from "./common";

const statusKey: Record<IngestionJob["status"], string> = {
  paused: "onboarding.statusPaused",
  running: "onboarding.statusRunning",
  "waiting-review": "onboarding.statusReview",
  applied: "onboarding.statusApplied",
  cancelled: "onboarding.statusCancelled",
  failed: "onboarding.statusFailed",
};

function statusVariant(status: IngestionJob["status"]) {
  if (status === "failed") return "destructive" as const;
  if (status === "applied") return "success" as const;
  return status === "waiting-review" ? ("default" as const) : ("outline" as const);
}

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
  const [sources, setSources] = useState<string[]>([]);
  const [dropping, setDropping] = useState(false);
  const [jobs, setJobs] = useState<IngestionJob[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 드라이브 중에는 배치 사이 진행이 화면에 흐른다. 사용자가 멈추면 다음 배치 전에 끝난다.
  const [drivingId, setDrivingId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const stopDrive = useRef(false);
  const busyRef = useRef(false);
  busyRef.current = busy || drivingId !== null;

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
    // 러스트 의존성 없음 — 끌어다 놓은 폴더·파일의 실제 경로를 받는다.
    if (!isTauri()) return;
    const listening = getCurrentWebview().onDragDropEvent((event) => {
      const payload = event.payload;
      if (payload.type === "enter") setDropping(true);
      else if (payload.type === "leave") setDropping(false);
      else if (payload.type === "drop") {
        setDropping(false);
        if (busyRef.current || !payload.paths.length) return;
        setSources((current) => [...new Set([...current, ...payload.paths])]);
      }
    });
    return () => {
      void listening.then((unlisten) => unlisten());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visibleJobs = jobs.filter(
    (item) => !projectId || item.projectId === projectId,
  );
  const job = visibleJobs.find((item) => item.id === selected) ?? null;
  const driving = drivingId !== null;

  function patch(next: IngestionJob) {
    setJobs((current) =>
      current.map((item) => (item.id === next.id ? next : item)),
    );
  }

  function addSources(paths: string[]) {
    if (busyRef.current || !paths.length) return;
    setSources((current) => [...new Set([...current, ...paths])]);
  }

  function removeSource(path: string) {
    if (busyRef.current) return;
    setSources((current) => current.filter((item) => item !== path));
  }

  // 던진 재료를 앱이 끝까지 읽는다. 배치 한계(200파일)마다 이어서 자동 호출.
  async function drive(id: string) {
    stopDrive.current = false;
    setDrivingId(id);
    setMessage(null);
    try {
      let current = await api.ingestionResume(id);
      while (current.status === "paused" && !stopDrive.current) {
        patch(current);
        current = await api.ingestionResume(id);
      }
      patch(current);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      await load().catch(() => undefined);
    } finally {
      setDrivingId(null);
    }
  }

  async function toss() {
    if (driving || !projectId || !sources.length) return;
    setMessage(null);
    const chosen = sources;
    try {
      setBusy(true);
      const created = await api.ingestionStart({
        projectId,
        outputPrefix: "",
        autoApply: false,
        sources: chosen.map((path, index) => ({
          path,
          label: `source-${index + 1}`,
        })),
      });
      setSources([]);
      setSelected(created.id);
      setJobs((current) => [
        created,
        ...current.filter((item) => item.id !== created.id),
      ]);
      setBusy(false);
      await drive(created.id);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      setBusy(false);
    }
  }

  async function act(work: () => Promise<IngestionJob>) {
    if (!job) return;
    setBusy(true);
    setMessage(null);
    try {
      patch(await work());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function pauseDrive() {
    if (!drivingId) return;
    stopDrive.current = true;
    await act(() => api.ingestionPause(drivingId));
  }

  const percent =
    job && job.totalFiles > 0
      ? Math.min(100, Math.round((job.processedFiles / job.totalFiles) * 100))
      : 0;

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
      <div className="min-h-0 flex-1 overflow-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-5 p-5">
          <section className="space-y-3">
            {!project && (
              <label className="block max-w-sm text-xs">
                {t("onboarding.project")}
                <Select
                  aria-label={t("onboarding.projectAria")}
                  value={projectId}
                  onChange={(v) => {
                    setProjectId(v);
                    setSelected(null);
                  }}
                  options={[
                    { value: "", label: t("select.project") },
                    ...projects.map((item) => ({
                      value: item.id,
                      label: item.name,
                    })),
                  ]}
                />
              </label>
            )}
            <div
              data-dropping={dropping || undefined}
              aria-label={t("onboarding.dropAria")}
              className={`flex flex-col items-center justify-center gap-3 rounded-lg border-2 border-dashed p-10 text-center transition-colors ${
                dropping ? "border-primary bg-primary/5" : ""
              }`}
            >
              <Inbox className="size-8 text-muted-foreground" />
              <p className="text-sm font-medium">{t("onboarding.dropTitle")}</p>
              <p className="max-w-md text-xs text-muted-foreground">
                {t("onboarding.dropHint")}
              </p>
              <div className="flex gap-2">
                <BrowseButton directory multiple onSelect={addSources} />
                <BrowseButton directory={false} multiple onSelect={addSources} />
              </div>
            </div>
            {sources.length > 0 && (
              <ul
                className="flex flex-wrap gap-2"
                aria-label={t("onboarding.sourcesAria")}
              >
                {sources.map((path) => (
                  <li
                    key={path}
                    className="flex max-w-full items-center gap-1 rounded-full border bg-muted/50 py-1 pl-3 pr-1 text-xs"
                  >
                    <span className="truncate" title={path}>
                      {path}
                    </span>
                    <button
                      type="button"
                      aria-label={t("onboarding.removeSource")}
                      className="rounded-full p-0.5 hover:bg-muted"
                      onClick={() => removeSource(path)}
                    >
                      <X className="size-3" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                {t("onboarding.produces")}
              </p>
              <Button
                disabled={busy || driving || !projectId || !sources.length}
                onClick={() => void toss()}
              >
                {driving ? <Loader2 className="animate-spin" /> : <FileStack />}
                {driving ? t("onboarding.tossBusy") : t("onboarding.toss")}
              </Button>
            </div>
          </section>
          <Card>
            <CardHeader>
              <CardTitle>{t("onboarding.runsTitle")}</CardTitle>
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
                  {t("onboarding.emptyRuns")}
                </p>
              ) : (
                <>
                  <div className="flex items-center justify-between gap-3">
                    <span className="flex items-center gap-2">
                      <Badge variant={statusVariant(job.status)}>
                        {t(statusKey[job.status])}
                      </Badge>
                      <span className="text-xs text-muted-foreground">
                        {t("onboarding.progressFiles", {
                          processed: job.processedFiles,
                          total: job.totalFiles,
                        })}
                      </span>
                    </span>
                    {drivingId === job.id && (
                      <span className="flex items-center gap-1 text-xs text-muted-foreground">
                        <Loader2 className="size-3 animate-spin" />
                        {t("onboarding.tossBusy")}
                      </span>
                    )}
                  </div>
                  <div className="h-1.5 overflow-hidden rounded bg-muted">
                    <div
                      className="h-full rounded bg-primary transition-all"
                      style={{ width: `${percent}%` }}
                    />
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {["paused", "failed", "running"].includes(job.status) &&
                      (drivingId === job.id ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => void pauseDrive()}
                        >
                          <Pause /> {t("onboarding.pause")}
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          disabled={busy || driving}
                          onClick={() => void drive(job.id)}
                        >
                          <Play /> {t("onboarding.continue")}
                        </Button>
                      ))}
                    {job.status === "waiting-review" && (
                      <Button
                        size="sm"
                        disabled={
                          busy || job.drafts.some((draft) => draft.conflict)
                        }
                        onClick={() =>
                          void act(() => api.ingestionApply(job.id))
                        }
                      >
                        <ShieldCheck /> {t("onboarding.applyReviewed")}
                      </Button>
                    )}
                    {!["applied", "cancelled"].includes(job.status) && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() =>
                          void act(() => api.ingestionCancel(job.id))
                        }
                      >
                        <StopCircle /> {t("onboarding.cancel")}
                      </Button>
                    )}
                  </div>
                  {job.error && (
                    <p className="text-sm text-destructive">{job.error}</p>
                  )}
                  {job.drafts.length > 0 && (
                    <div className="space-y-3">
                      <p className="text-xs text-muted-foreground">
                        {t("onboarding.reviewHint")}
                      </p>
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
                  )}
                </>
              )}
              {visibleJobs.length > 1 && (
                <div className="space-y-2 border-t pt-3">
                  {visibleJobs.map((item) => (
                    <button
                      key={item.id}
                      onClick={() => setSelected(item.id)}
                      className={`w-full rounded-md border p-2 text-left text-xs ${
                        selected === item.id ? "border-primary" : ""
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        <Badge variant={statusVariant(item.status)}>
                          {t(statusKey[item.status])}
                        </Badge>
                        <span className="truncate text-muted-foreground">
                          {t("onboarding.progressFiles", {
                            processed: item.processedFiles,
                            total: item.totalFiles,
                          })}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  );
}
