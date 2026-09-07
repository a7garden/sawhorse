import { useCallback, useEffect, useState } from "react";
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
import type { GitHubRepository } from "@/lib/types";
import type { Project } from "@/features/workbench/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog } from "@/components/ui/dialog";
import { PathInput } from "@/components/ui/path-input";
import { toast } from "@/components/ui/toast";
import { PageHeader } from "./common";
import SourcesPage from "./SourcesPage";
import OnboardingPage from "./OnboardingPage";

export default function GitHubExtensionPage() {
  const core = useCoreExtensions();
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
  useEffect(() => {
    if (!core.github) return;
    void run(async () => {
      const user = await api.githubAccount();
      setAccount(user);
      if (user) await loadRepositories();
    });
  }, [core.github]);

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
          setNotice(`${result.account.login} 계정으로 로그인했습니다.`);
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
          GitHub 관리
        </Button>
        <SourcesPage scope="github" />
      </>
    );
  return (
    <div>
      <PageHeader title="GitHub">
        <span className="mr-auto text-xs text-muted-foreground">
          {core.githubInstalled ? "설치됨 · v0.1.0" : "설치 가능"}
        </span>
        {core.github && (
          <Button size="sm" variant="outline" onClick={() => setSync(true)}>
            이슈 동기화 관리
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
            ? "사용 중지"
            : core.githubInstalled
              ? "사용 시작"
              : "확장 설치·사용"}
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
            <h2 className="font-semibold">GitHub 확장</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              계정을 연결하면 저장소를 탐색하고 프로젝트와 이슈를 가져올 수
              있습니다. 사용을 중지해도 계정과 연결 설정은 유지됩니다.
            </p>
          </div>
        ) : (
          <>
            <section
              className="rounded-xl border bg-card p-5"
              aria-label="GitHub 계정"
            >
              {account ? (
                <div className="flex flex-wrap items-center gap-3">
                  <Github className="size-6" />
                  <div className="mr-auto">
                    <h2 className="font-semibold">
                      {account.name || account.login}
                    </h2>
                    <p className="text-xs text-muted-foreground">
                      @{account.login} · 연결됨
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
                    계정 연결 해제
                  </Button>
                </div>
              ) : (
                <div className="space-y-3">
                  <h2 className="font-semibold">계정 연결</h2>
                  <p className="text-sm text-muted-foreground">
                    브라우저에서 GitHub OAuth로 로그인합니다. 비공개 저장소를
                    가져오기 위해 repo 범위를 요청하지만, Sawhorse는 현재
                    저장소와 이슈를 읽는 작업에만 사용합니다.
                  </p>
                  {oauthFlow ? (
                    <div
                      className="space-y-3 rounded-lg border bg-secondary/40 p-4"
                      aria-label="GitHub OAuth 승인"
                    >
                      <p className="text-sm">
                        브라우저의 GitHub 페이지에 아래 코드를 입력하고
                        승인하세요.
                      </p>
                      <p className="font-mono text-2xl font-semibold tracking-widest">
                        {oauthFlow.userCode}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        승인 완료를 기다리는 중… 코드는 약{" "}
                        {Math.ceil(oauthFlow.expiresIn / 60)}분 동안 유효합니다.
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
                          GitHub 인증 페이지 다시 열기
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
                          로그인 취소
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
                              "브라우저를 자동으로 열지 못했습니다. 아래 버튼으로 GitHub 인증 페이지를 여세요.",
                            );
                          }
                        })
                      }
                    >
                      <Github />
                      GitHub로 로그인
                    </Button>
                  )}
                  <p className="text-xs text-muted-foreground">
                    OAuth 토큰은 이 Mac의 키체인에만 저장됩니다. 개인 액세스
                    토큰을 직접 만들거나 붙여넣을 필요가 없습니다.
                  </p>
                </div>
              )}
            </section>
            {imported && (
              <section className="flex flex-wrap items-center gap-3 rounded-xl border bg-card p-4">
                <FolderGit2 />
                <div className="mr-auto">
                  <h2 className="text-sm font-semibold">
                    {imported.name} 가져오기 완료
                  </h2>
                  <p className="text-xs text-muted-foreground">
                    {imported.repoPath}
                  </p>
                </div>
                <Button size="sm" onClick={() => setDocuments(true)}>
                  프로젝트 문서 만들기
                </Button>
              </section>
            )}
            {account && (
              <section
                aria-label="내 GitHub 저장소"
                className="overflow-hidden rounded-xl border bg-card"
              >
                <div className="flex flex-wrap items-center gap-3 border-b p-4">
                  <h2 className="mr-auto font-semibold">
                    내 저장소{" "}
                    <span className="ml-1 text-xs font-normal text-muted-foreground">
                      {repositories.length}
                    </span>
                  </h2>
                  <div className="relative">
                    <Search className="absolute left-2.5 top-2.5 size-4 text-muted-foreground" />
                    <Input
                      className="pl-8"
                      aria-label="저장소 검색"
                      placeholder="불러온 저장소 검색"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    aria-label="저장소 새로고침"
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
                              <LockKeyhole size={12} aria-label="비공개" />
                            )}
                            {repo.archived && (
                              <span className="text-xs font-normal text-muted-foreground">
                                보관됨
                              </span>
                            )}
                          </h3>
                          {repo.description && (
                            <p className="mt-1 truncate text-xs text-muted-foreground">
                              {repo.description}
                            </p>
                          )}
                          <p className="mt-2 text-[11px] text-muted-foreground">
                            {repo.language ?? ""} ·{" "}
                            {new Date(repo.updatedAt).toLocaleDateString()}{" "}
                            업데이트
                          </p>
                        </div>
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={busy}
                          onClick={() =>
                            void run(async () => {
                              await api.sourcesUpsertInstance({
                                instanceId: `github-${repo.id}`,
                                extensionId: "github",
                                componentId: "issues",
                                config: {
                                  account: account.login,
                                  repository: repo.fullName,
                                  repositoryId: repo.id,
                                  state: "open",
                                },
                                network: ["api.github.com"],
                              });
                              setNotice(
                                `${repo.fullName} 이슈 연결을 추가했습니다. 이슈 동기화 관리에서 가져올 이슈를 확인하세요.`,
                              );
                            })
                          }
                        >
                          이슈 연결
                        </Button>
                        <Button
                          size="sm"
                          disabled={busy}
                          onClick={() => {
                            setError("");
                            setSelected(repo);
                          }}
                        >
                          프로젝트로 가져오기
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
                    {busy ? "저장소 불러오는 중…" : "표시할 저장소가 없습니다."}
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
                      저장소 더 보기
                    </Button>
                  </div>
                )}
              </section>
            )}
          </>
        )}
      </div>
      <Dialog
        open={!!selected}
        onClose={() => {
          if (!busy) {
            setSelected(null);
            setError("");
          }
        }}
        title="프로젝트로 가져오기"
      >
        <div className="space-y-4">
          <p className="font-medium">{selected?.fullName}</p>
          <label className="block space-y-2 text-sm">
            저장할 상위 폴더
            <PathInput
              directory
              value={parentPath}
              onValueChange={setParentPath}
              placeholder="폴더를 선택하세요"
            />
          </label>
          <p className="break-all text-xs text-muted-foreground">
            {parentPath
              ? `${parentPath}/${selected?.name}`
              : "선택한 폴더 안에 저장소 이름으로 새 폴더를 만듭니다."}
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
            {busy ? "저장소 가져오는 중…" : "가져오기"}
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
