import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  BookOpen,
  ExternalLink,
  Inbox,
  RefreshCw,
  Rss,
  Search,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/api";
import {
  isFeedCfg,
  type ArticleRow,
  type SourceInstanceRow,
} from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import {
  CollectionEmpty,
  CollectionFilters,
  CollectionIntro,
  CollectionSearch,
} from "@/components/CollectionTools";
import { cn } from "@/lib/utils";
import { PageHeader } from "./common";
import SourcesPage from "./SourcesPage";

type ArticleFilter = "all" | "unread" | "archived";
const FILTERS: ArticleFilter[] = ["all", "unread", "archived"];

function parseTags(article: ArticleRow): string[] {
  try {
    const value = JSON.parse(article.tags);
    return Array.isArray(value) ? [...new Set(value.map(String))] : [];
  } catch {
    return [];
  }
}

function fmtWhen(iso: string, language: string): string {
  if (!iso) return "-";
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(language, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
}

export default function ReadingPage() {
  const { t, i18n } = useTranslation("sessions");
  const { t: tc } = useTranslation("collections");
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [instances, setInstances] = useState<SourceInstanceRow[]>([]);
  const [selId, setSelId] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ArticleFilter>("all");
  const [articles, setArticles] = useState<ArticleRow[]>([]);
  const [loadingSources, setLoadingSources] = useState(true);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);
  const [pendingIds, setPendingIds] = useState<Set<string>>(new Set());
  const articleRequest = useRef(0);

  const reloadInstances = useCallback(async () => {
    setLoadingSources(true);
    setMsg(null);
    try {
      const view = await api.sourcesListInstances();
      const feeds = view.instances.filter((instance) =>
        isFeedCfg(instance.config),
      );
      setInstances(feeds);
      setSelId((cur) =>
        cur && feeds.some((feed) => feed.instanceId === cur)
          ? cur
          : (feeds[0]?.instanceId ?? ""),
      );
    } catch (error) {
      setMsg(String(error));
    } finally {
      setLoadingSources(false);
    }
  }, []);

  const reloadArticles = useCallback(async (id: string) => {
    const request = ++articleRequest.current;
    if (!id) {
      setArticles([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const view = await api.articlesList(id);
      if (request === articleRequest.current) setArticles(view.articles);
    } catch (error) {
      if (request === articleRequest.current) {
        setArticles([]);
        setMsg(String(error));
      }
    } finally {
      if (request === articleRequest.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reloadInstances();
  }, [reloadInstances]);
  useEffect(() => {
    void reloadArticles(selId);
    return () => {
      articleRequest.current += 1;
    };
  }, [selId, reloadArticles]);

  function setArticleState(
    article: ArticleRow,
    patch: { read?: boolean; archived?: boolean },
  ) {
    const request = articleRequest.current;
    setPendingIds((ids) => new Set(ids).add(article.id));
    setArticles((rows) =>
      rows.map((row) =>
        row.id === article.id
          ? {
              ...row,
              read: patch.read === undefined ? row.read : patch.read ? 1 : 0,
              archived:
                patch.archived === undefined
                  ? row.archived
                  : patch.archived
                    ? 1
                    : 0,
            }
          : row,
      ),
    );
    void api
      .articleSetState({ articleId: article.id, ...patch })
      .catch((error) => {
        if (request === articleRequest.current) {
          setMsg(String(error));
          void reloadArticles(selId);
        }
      })
      .finally(() =>
        setPendingIds((ids) => {
          const next = new Set(ids);
          next.delete(article.id);
          return next;
        }),
      );
  }

  const counts = {
    all: articles.length,
    unread: articles.filter(
      (article) => article.read === 0 && article.archived === 0,
    ).length,
    archived: articles.filter((article) => article.archived === 1).length,
  };
  const filtered = useMemo(
    () =>
      articles.filter((article) => {
        const matchesState =
          filter === "unread"
            ? article.read === 0 && article.archived === 0
            : filter === "archived"
              ? article.archived === 1
              : true;
        return (
          matchesState &&
          `${article.title} ${article.summary} ${parseTags(article).join(" ")}`
            .toLocaleLowerCase()
            .includes(query.trim().toLocaleLowerCase())
        );
      }),
    [articles, filter, query],
  );
  const hasFilters = filter !== "all" || query.trim().length > 0;

  if (sourcesOpen)
    return (
      <div>
        <Button
          className="m-4"
          variant="ghost"
          onClick={() => {
            setSourcesOpen(false);
            void reloadInstances();
          }}
        >
          {t("reading.back")}
        </Button>
        <SourcesPage scope="rss" />
      </div>
    );

  return (
    <div>
      <PageHeader title={t("reading.title")}>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setSourcesOpen(true)}
        >
          <Rss />
          {t("reading.manageSources")}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={loadingSources || loading}
          onClick={() => {
            void reloadInstances();
            void reloadArticles(selId);
          }}
        >
          <RefreshCw
            className={cn(
              "size-3",
              (loadingSources || loading) && "animate-spin",
            )}
          />
          {t("actions.refresh")}
        </Button>
      </PageHeader>
      <div className="mx-auto max-w-5xl space-y-6 p-4 lg:p-6">
        <CollectionIntro description={tc("reading.description")}>
          {instances.length > 0 && !loading && (
            <span className="text-xs tabular-nums text-muted-foreground">
              {tc("reading.unread", { count: counts.unread })}
            </span>
          )}
        </CollectionIntro>
        {msg && (
          <p
            role="alert"
            className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive"
          >
            {msg}
          </p>
        )}
        {instances.length === 0 ? (
          <section className="rounded-xl border bg-background">
            <CollectionEmpty
              icon={loadingSources ? RefreshCw : Inbox}
              title={
                loadingSources
                  ? tc("loading")
                  : msg
                    ? tc("loadFailed")
                    : t("reading.emptyNoSources")
              }
              description={
                loadingSources || msg
                  ? undefined
                  : t("reading.emptyNoSourcesHint")
              }
            >
              {!loadingSources && !msg && (
                <Button size="sm" onClick={() => setSourcesOpen(true)}>
                  <Rss />
                  {t("reading.openSources")}
                </Button>
              )}
            </CollectionEmpty>
          </section>
        ) : (
          <section
            className="overflow-hidden rounded-xl border bg-background"
            aria-label={t("reading.title")}
          >
            <div className="flex flex-wrap items-center justify-between gap-3 border-b p-4">
              <Select
                aria-label={tc("reading.source")}
                value={selId}
                onChange={(value) => {
                  if (value === selId) return;
                  articleRequest.current += 1;
                  setSelId(value);
                  setArticles([]);
                  setLoading(true);
                  setMsg(null);
                }}
                options={instances.map((instance) => ({
                  value: instance.instanceId,
                  label: instance.instanceId,
                }))}
              />
              <CollectionSearch
                value={query}
                onChange={setQuery}
                label={tc("reading.search")}
              />
            </div>
            <div className="border-b px-3 py-2">
              <CollectionFilters
                value={filter}
                onChange={setFilter}
                label={tc("reading.filters")}
                options={FILTERS.map((f) => ({
                  value: f,
                  label: t(`filter.${f}`),
                  count: loading ? undefined : counts[f],
                }))}
              />
            </div>
            {loading ? (
              <CollectionEmpty icon={BookOpen} title={t("reading.loading")} />
            ) : filtered.length === 0 ? (
              <CollectionEmpty
                icon={hasFilters ? Search : BookOpen}
                title={
                  hasFilters ? tc("noResults") : t("reading.emptyNoArticles")
                }
                description={hasFilters ? tc("noResultsHint") : undefined}
              >
                {hasFilters && (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setQuery("");
                      setFilter("all");
                    }}
                  >
                    {tc("reset")}
                  </Button>
                )}
              </CollectionEmpty>
            ) : (
              <div className="divide-y">
                {filtered.map((article) => {
                  const tags = parseTags(article);
                  const read = article.read === 1;
                  const archived = article.archived === 1;
                  return (
                    <article
                      key={article.id}
                      className="px-5 py-5 transition-colors hover:bg-muted/20 sm:px-6"
                      aria-label={article.title || article.url}
                    >
                      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                        {!read && (
                          <span className="inline-flex items-center gap-1.5 text-primary">
                            <span className="size-1.5 rounded-full bg-primary" />
                            {t("filter.unread")}
                          </span>
                        )}
                        {archived && (
                          <span className="inline-flex items-center gap-1">
                            <Archive className="size-3" />
                            {t("filter.archived")}
                          </span>
                        )}
                        <time dateTime={article.publishedAt}>
                          {fmtWhen(article.publishedAt, i18n.language)}
                        </time>
                      </div>
                      <h2>
                        <button
                          className={cn(
                            "inline-flex items-start gap-2 text-left text-base font-semibold leading-relaxed hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                            read && "font-medium text-muted-foreground",
                          )}
                          title={article.url}
                          onClick={() =>
                            void api
                              .openExternal(article.url)
                              .catch((error) => setMsg(String(error)))
                          }
                        >
                          <span className="min-w-0 break-words">
                            {article.title || article.url}
                          </span>
                          <ExternalLink className="mt-1.5 size-3.5 shrink-0 text-muted-foreground" />
                        </button>
                      </h2>
                      {article.summary && (
                        <p className="mt-2 max-w-3xl line-clamp-3 text-sm leading-7 text-muted-foreground">
                          {article.summary}
                        </p>
                      )}
                      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
                        <div className="flex flex-wrap gap-1.5">
                          {tags.map((tag) => (
                            <Badge key={tag} variant="secondary">
                              {tag}
                            </Badge>
                          ))}
                        </div>
                        <div className="flex gap-1">
                          <Button
                            disabled={pendingIds.has(article.id)}
                            size="xs"
                            variant="ghost"
                            onClick={() =>
                              setArticleState(article, { read: !read })
                            }
                          >
                            <BookOpen />
                            {read
                              ? t("reading.markUnread")
                              : t("reading.markRead")}
                          </Button>
                          <Button
                            disabled={pendingIds.has(article.id)}
                            size="xs"
                            variant="ghost"
                            onClick={() =>
                              setArticleState(article, { archived: !archived })
                            }
                          >
                            <Archive />
                            {archived
                              ? t("reading.unarchive")
                              : t("reading.archive")}
                          </Button>
                        </div>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </section>
        )}
      </div>
    </div>
  );
}
