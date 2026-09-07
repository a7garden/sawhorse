import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Github,
  FolderGit2,
  LockKeyhole,
  Search,
  RefreshCw,
  ArrowLeft,
} from "lucide-react";
import { api } from "@/lib/api";
import { useCoreExtensions } from "@/lib/core-extensions";
import { isGitHubCfg, type GitHubRepository } from "@/lib/types";
import type { Project } from "@/features/workbench/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog } from "@/components/ui/dialog";
import { PathInput } from "@/components/ui/path-input";
import { toast } from "@/components/ui/toast";
import { PageHeader } from "./common";
import { sddApi } from "@/features/workbench/api";
import SourcesPage from "./SourcesPage";
import OnboardingPage from "./OnboardingPage";

export default function GitHubExtensionPage() {
  const core = useCoreExtensions();
  const { t } = useTranslation("packs");
  const [account, setAccount] = useState<{
    login: string;
    name: string | null;
  } | null>(null);
  const [repositories, setRepositories] = useState<GitHubRepository[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [query, setQuery] = useState("");
  const [oauthFlow, setOAuthFlow] = useState<{
    flowId: string;
    userCode: string;
    verificationUri: string;
    expiresIn: number;
    interval: number;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  // 액션 결과는 상단 토스트로 알린다.
  const setNotice = useCallback((text: string) => {
    if (text) toast({ tone: "info", text });
  }, []);
  const [sync, setSync] = useState(false);
  const [selected, setSelected] = useState<GitHubRepository | null>(null);
  const [parentPath, setParentPath] = useState("");
  const [imported, setImported] = useState<Project | null>(null);
  const [documents, setDocuments] = useState(false);
  // 이슈 연결은 프로젝트를 전제로 한다. 동기화 인스턴스는 어떤 프로젝트로
  // 가져올지 기억하고, 프로젝트는 어느 저장소와 묶였는지 저장소 쪽에도 기록한다.
  const [projects, setProjects] = useState<Project[]>([]);
  const [linkedRepoIds, setLinkedRepoIds] = useState<Set<string>>(new Set());
  const [linkFor, setLinkFor] = useState<GitHubRepository | null>(null);
  const [linkProjectId, setLinkProjectId] = useState("");

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  async function loadRepositories(next = 1) {
    const result = await api.githubRepositories(next);
    setRepositories((current) =>
      next === 1
        ? result.repositories
        : [
            ...current,
            ...result.repositories.filter(
              (r) => !current.some((c) => c.id === r.id),
            ),
          ],
    );
    setPage(next);
    setHasMore(result.hasMore);
  }

  // 연결 대상 프로젝트 목록과 이미 동기화 중인 저장소를 읽어 둔다.
  useEffect(() => {
    if (!core.github) return;
    void sddApi
      .snapshot()
      .then((snapshot) => setProjects(snapshot.projects))
      .catch(() => setProjects([]));
    void api
      .sourcesListInstances()
      .then((view) =>
        setLinkedRepoIds(
          new Set(
            view.instances
              .map((row) => row.config)
              .filter(isGitHubCfg)
              .map((config) => config.repositoryId),
          ),
        ),
      )
      .catch(() => undefined);
  }, [core.github]);
  useEffect(() => {
    if (!core.github) return;
    void run(async () => {
      const user = await api.githubAccount();
      setAccount(user);
      if (user) await loadRepositories();
    });
  }, [core.github]);

  function openLinkDialog(repo: GitHubRepository) {
    setError("");
    setLinkFor(repo);
    // 이 저장소에 이미 묶인 프로젝트를 기본 선택으로 둔다.
    const bound = projects.find((project) =>
      (project.githubRepos ?? []).includes(repo.fullName),
    );
    setLinkProjectId(bound?.id ?? projects[0]?.id ?? "");
  }

  async function confirmLink() {
    const repo = linkFor;
    const project = projects.find((item) => item.id === linkProjectId);
    if (!repo || !project || !account) return;
    await run(async () => {
      // 프로젝트 쪽에도 저장소 바인딩을 남긴다. 이슈 가져오기 목적지가
      // 여기서 결정되므로 양쪽이 항상 같은 사실을 가리킨다.
      if (!(project.githubRepos ?? []).includes(repo.fullName)) {
        const nextRepos = [...(project.githubRepos ?? []), repo.fullName];
        await sddApi.saveProject({ ...project, githubRepos: nextRepos });
        setProjects((current) =>
          current.map((item) =>
            item.id === project.id ? { ...item, githubRepos: nextRepos } : item,
          ),
        );
      }
      await api.sourcesUpsertInstance({
        instanceId: `github-${repo.id}`,
        extensionId: "github",
        componentId: "issues",
        config: {
          account: account.login,
          repository: repo.fullName,
          repositoryId: repo.id,
          state: "open",
          projectId: project.id,
        },
        network: ["api.github.com"],
      });
      setLinkedRepoIds((current) => new Set(current).add(repo.id));
      setNotice(
        t("github.issueLinked", {
          repo: repo.fullName,
          project: project.name,
        }),
      );
      setLinkFor(null);
    });
  }

  useEffect(() => {
    if (!oauthFlow) return;
    let active = true;
    let timer: number | undefined;
    const poll = async () => {
      try {
        const result = await api.githubOAuthPoll(oauthFlow.flowId);
        if (!active) return;
        if (result.status === "complete") {
          setAccount(result.account);
          setOAuthFlow(null);
          setNotice(
            t("github.loggedInAs", { login: result.account.login }),
          );
          try {
            await loadRepositories();
          } catch (e) {
            if (active) setError(String(e));
          }
          return;
        }
        timer = window.setTimeout(poll, Math.max(1, result.retryAfter) * 1000);
      } catch (e) {
        if (!active) return;
        setOAuthFlow(null);
        setError(String(e));
      }
    };
    timer = window.setTimeout(poll, Math.max(1, oauthFlow.interval) * 1000);
    return () => {
      active = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [oauthFlow?.flowId]);

  if (documents && imported)
    return (
      <OnboardingPage project={imported} onBack={() => setDocuments(false)} />
    );
  if (sync && core.github)
    return (
      <>
        <Button variant="ghost" className="m-4" onClick={() => setSync(false)}>
          <ArrowLeft />
          {t("github.manage")}
        </Button>
        <SourcesPage scope="github" />
      </>
    );
  return (
    <div>
      <PageHeader title="GitHub">
        <span className="mr-auto text-xs text-muted-foreground">
          {core.githubInstalled
            ? t("github.installedBadge", { version: "0.1.0" })
            : t("github.available")}
        </span>
        {core.github && (
          <Button size="sm" variant="outline" onClick={() => setSync(true)}>
            {t("github.manageSync")}
          </Button>
        )}
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() =>
            void run(() => core.setEnabled("github", !core.github))
          }
        >
          {core.github
            ? t("toggle.disable")
            : core.githubInstalled
              ? t("toggle.enable")
              : t("toggle.installAndUse")}
        </Button>
      </PageHeader>
      <div className="mx-auto max-w-6xl space-y-6 p-6">
        {error && !selected && (
          <p
            role="alert"
            className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive"
          >
            {error}
          </p>
        )}
        {!core.github ? (
          <div className="rounded-xl border bg-card p-6">
            <Github className="mb-3 size-7" />
            <h2 className="font-semibold">{t("github.extensionTitle")}</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              {t("github.extensionDesc")}
            </p>
          </div>
        ) : (
          <>
            <section
              className="rounded-xl border bg-card p-5"
              aria-label={t("github.accountAria")}
            >
              {account ? (
                <div className="flex flex-wrap items-center gap-3">
                  <Github className="size-6" />
                  <div className="mr-auto">
                    <h2 className="font-semibold">
                      {account.name || account.login}
                    </h2>
                    <p className="text-xs text-muted-foreground">
                      {t("github.connected", { login: account.login })}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await api.githubDisconnect();
                        setAccount(null);
                        setRepositories([]);
                      })
                    }
                  >
                    {t("github.disconnect")}
                  </Button>
                </div>
              ) : (
                <div className="space-y-3">
                  <h2 className="font-semibold">{t("github.connectTitle")}</h2>
                  <p className="text-sm text-muted-foreground">
                    {t("github.oauthDesc")}
                  </p>
                  {oauthFlow ? (
                    <div
                      className="space-y-3 rounded-lg border bg-secondary/40 p-4"
                      aria-label={t("github.oauthAria")}
                    >
                      <p className="text-sm">
                        {t("github.codeHint")}
                      </p>
                      <p className="font-mono text-2xl font-semibold tracking-widest">
                        {oauthFlow.userCode}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {t("github.waiting", {
                          minutes: Math.ceil(oauthFlow.expiresIn / 60),
                        })}
                      </p>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          size="sm"
                          type="button"
                          onClick={() =>
                            void run(() =>
                              api.openExternal(oauthFlow.verificationUri),
                            )
                          }
                        >
                          {t("github.reopenAuth")}
                        </Button>
                        <Button
                          size="sm"
                          type="button"
                          variant="ghost"
                          onClick={() => {
                            const flowId = oauthFlow.flowId;
                            setOAuthFlow(null);
                            void run(() => api.githubOAuthCancel(flowId));
                          }}
                        >
                          {t("github.cancelLogin")}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <Button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          const flow = await api.githubOAuthStart();
                          setOAuthFlow(flow);
                          try {
                            await api.openExternal(flow.verificationUri);
                          } catch {
                            setNotice(
                              t("github.openFailed"),
                            );
                          }
                        })
                      }
                    >
                      <Github />
                      {t("github.signIn")}
                    </Button>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {t("github.keychainNote")}
                  </p>
                </div>
              )}
            </section>
            {imported && (
              <section className="flex flex-wrap items-center gap-3 rounded-xl border bg-card p-4">
                <FolderGit2 />
                <div className="mr-auto">
                  <h2 className="text-sm font-semibold">
                    {t("github.imported", { name: imported.name })}
                  </h2>
                  <p className="text-xs text-muted-foreground">
                    {imported.repoPath}
                  </p>
                </div>
                <Button size="sm" onClick={() => setDocuments(true)}>
                  {t("github.createProjectDocs")}
                </Button>
              </section>
            )}
            {account && (
              <section
                aria-label={t("github.reposAria")}
                className="overflow-hidden rounded-xl border bg-card"
              >
                <div className="flex flex-wrap items-center gap-3 border-b p-4">
                  <h2 className="mr-auto font-semibold">
                    {t("github.myRepos")}{" "}
                    <span className="ml-1 text-xs font-normal text-muted-foreground">
                      {repositories.length}
                    </span>
                  </h2>
                  <div className="relative">
                    <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
                    <Input
                      className="pl-8"
                      aria-label={t("github.searchReposAria")}
                      placeholder={t("github.searchRepos")}
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    aria-label={t("github.refreshReposAria")}
                    onClick={() => void run(() => loadRepositories())}
                  >
                    <RefreshCw />
                  </Button>
                </div>
                <div className="divide-y">
                  {repositories
                    .filter((r) =>
                      `${r.fullName} ${r.description ?? ""}`
                        .toLowerCase()
                        .includes(query.toLowerCase()),
                    )
                    .map((repo) => (
                      <article
                        key={repo.id}
                        className="flex flex-wrap items-center gap-4 p-4 hover:bg-accent/30"
                      >
                        <FolderGit2 className="size-5 shrink-0 text-muted-foreground" />
                        <div className="min-w-0 flex-1">
                          <h3 className="flex items-center gap-2 text-sm font-semibold">
                            {repo.fullName}
                            {repo.private && (
                              <LockKeyhole
                                size={12}
                                aria-label={t("github.private")}
                              />
                            )}
                            {repo.archived && (
                              <span className="text-xs font-normal text-muted-foreground">
                                {t("github.archived")}
                              </span>
                            )}
                          </h3>
                          {repo.description && (
                            <p className="mt-1 truncate text-xs text-muted-foreground">
                              {repo.description}
                            </p>
                          )}
                          <p className="mt-2 text-[11px] text-muted-foreground">
                            {linkedRepoIds.has(repo.id) && (
                              <span className="mr-1 rounded bg-secondary px-1.5 py-0.5 text-[10px] text-secondary-foreground">
                                {t("github.linkedBadge")}
                              </span>
                            )}
                            {repo.language ?? ""} ·{" "}
                            {t("github.updatedSuffix", {
                              date: new Date(
                                repo.updatedAt,
                              ).toLocaleDateString(),
                            })}
                          </p>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() => openLinkDialog(repo)}
                        >
                          {t("github.linkIssues")}
                        </Button>
                        <Button
                          size="sm"
                          disabled={busy}
                          onClick={() => {
                            setError("");
                            setSelected(repo);
                          }}
                        >
                          {t("github.importProject")}
                        </Button>
                      </article>
                    ))}
                </div>
                {!repositories.some((r) =>
                  `${r.fullName} ${r.description ?? ""}`
                    .toLowerCase()
                    .includes(query.toLowerCase()),
                ) && (
                  <p className="p-8 text-center text-sm text-muted-foreground">
                    {busy ? t("github.loading") : t("github.noRepos")}
                  </p>
                )}
                {hasMore && (
                  <div className="border-t p-3 text-center">
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() => void run(() => loadRepositories(page + 1))}
                    >
                      {t("github.more")}
                    </Button>
                  </div>
                )}
              </section>
            )}
          </>
        )}
      </div>
      <Dialog
        open={!!linkFor}
        onClose={() => {
          if (!busy) {
            setLinkFor(null);
            setError("");
          }
        }}
        title={t("github.linkIssues")}
      >
        <div className="space-y-4">
          <p className="font-medium">{linkFor?.fullName}</p>
          {projects.length === 0 ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                {t("github.linkNeedsProject")}
              </p>
              <Button
                disabled={busy}
                onClick={() => {
                  const repo = linkFor;
                  setLinkFor(null);
                  if (repo) setSelected(repo);
                }}
              >
                {t("github.importProject")}
              </Button>
            </div>
          ) : (
            <>
              <label className="block space-y-2 text-sm">
                {t("github.linkTargetProject")}
                <div className="max-h-64 space-y-1 overflow-y-auto">
                  {projects.map((project) => (
                    <label
                      key={project.id}
                      className="flex items-center gap-2 rounded-md border p-2 text-sm"
                    >
                      <input
                        type="radio"
                        name="link-project"
                        checked={linkProjectId === project.id}
                        onChange={() => setLinkProjectId(project.id)}
                      />
                      <span className="min-w-0 flex-1 truncate">
                        {project.name}
                      </span>
                      {(project.githubRepos ?? []).includes(
                        linkFor?.fullName ?? "",
                      ) && (
                        <span className="text-[11px] text-muted-foreground">
                          {t("github.linkBoundBadge")}
                        </span>
                      )}
                    </label>
                  ))}
                </div>
              </label>
              <p className="text-xs text-muted-foreground">
                {t("github.linkHint")}
              </p>
              {error && (
                <p role="alert" className="text-sm text-destructive">
                  {error}
                </p>
              )}
              <div className="flex justify-end gap-2">
                <Button variant="ghost" size="sm" onClick={() => setLinkFor(null)}>
                  {t("actions.cancel")}
                </Button>
                <Button
                  size="sm"
                  disabled={busy || !linkProjectId}
                  onClick={() => void confirmLink()}
                >
                  {busy ? t("github.linking") : t("github.linkConfirm")}
                </Button>
              </div>
            </>
          )}
        </div>
      </Dialog>

      <Dialog
        open={!!selected}
        onClose={() => {
          if (!busy) {
            setSelected(null);
            setError("");
          }
        }}
        title={t("github.importProject")}
      >
        <div className="space-y-4">
          <p className="font-medium">{selected?.fullName}</p>
          <label className="block space-y-2 text-sm">
            {t("github.parentFolder")}
            <PathInput
              directory
              value={parentPath}
              onValueChange={setParentPath}
              placeholder={t("github.chooseFolder")}
            />
          </label>
          <p className="break-all text-xs text-muted-foreground">
            {parentPath
              ? `${parentPath}/${selected?.name}`
              : t("github.importHint")}
          </p>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <Button
            disabled={busy || !parentPath || !selected}
            onClick={() =>
              void run(async () => {
                const result = await api.githubCloneProject(
                  selected!.fullName,
                  parentPath,
                );
                setImported(result);
                setSelected(null);
              })
            }
          >
            {busy ? t("github.importing") : t("github.import")}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
