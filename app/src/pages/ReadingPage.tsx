// ReadingPage — 읽을거리. feed instance의 기사 목록을 읽음/보관 상태와 함께 본다(설계 721-786줄).
import { useCallback, useEffect, useMemo, useState } from "react";
import { Archive, ExternalLink, Inbox, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import { useTranslation } from "react-i18next";
import SourcesPage from "./SourcesPage";
import { isFeedCfg } from "@/lib/types";
import type { ArticleRow, SourceInstanceRow } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Select } from "@/components/ui/select";
import { cn } from "@/lib/utils";
import { Empty, PageHeader } from "./common";

type ArticleFilter = "all" | "unread" | "archived";

const FILTERS: ArticleFilter[] = ["all", "unread", "archived"];

function parseTags(a: ArticleRow): string[] {
  try {
    const v = JSON.parse(a.tags);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function fmtWhen(iso: string): string {
  if (!iso) return "-";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export default function ReadingPage() {
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const [instances, setInstances] = useState<SourceInstanceRow[]>([]);
  const [selId, setSelId] = useState("");
  const [filter, setFilter] = useState<ArticleFilter>("all");
  const [articles, setArticles] = useState<ArticleRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<string | null>(null);
  const { t } = useTranslation("sessions");

  const reloadInstances = useCallback(async () => {
    const v = await api.sourcesListInstances().catch(() => null);
    const feeds = (v?.instances ?? []).filter((i) => isFeedCfg(i.config));
    setInstances(feeds);
    setSelId((cur) =>
      cur && feeds.some((f) => f.instanceId === cur)
        ? cur
        : (feeds[0]?.instanceId ?? ""),
    );
  }, []);

  const reloadArticles = useCallback(async (id: string) => {
    if (!id) {
      setArticles([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const v = await api.articlesList(id).catch(() => null);
    setArticles(v?.articles ?? []);
    setLoading(false);
  }, []);

  useEffect(() => {
    void reloadInstances();
  }, [reloadInstances]);

  useEffect(() => {
    void reloadArticles(selId);
  }, [selId, reloadArticles]);

  /** 낙관적으로 상태를 바꾸고 서버 기록. 실패면 되돌린다. */
  function setArticleState(
    a: ArticleRow,
    patch: { read?: boolean; archived?: boolean },
  ) {
    setArticles((rows) =>
      rows.map((r) =>
        r.id === a.id
          ? {
              ...r,
              read: patch.read === undefined ? r.read : patch.read ? 1 : 0,
              archived:
                patch.archived === undefined
                  ? r.archived
                  : patch.archived
                    ? 1
                    : 0,
            }
          : r,
      ),
    );
    api.articleSetState({ articleId: a.id, ...patch }).catch((e) => {
      setMsg(String(e));
      void reloadArticles(selId);
    });
  }

  const filtered = useMemo(() => {
    if (filter === "unread")
      return articles.filter((a) => a.read === 0 && a.archived === 0);
    if (filter === "archived") return articles.filter((a) => a.archived === 1);
    return articles;
  }, [articles, filter]);

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
    <div className="flex h-full flex-col">
      <PageHeader title={t("reading.title")}>
        <Button
          size="sm"
          variant="outline"
          onClick={() => setSourcesOpen(true)}
        >
          {t("reading.manageSources")}
        </Button>
        {instances.length > 0 && (
          <>
            <Select value={selId} onChange={(e) => setSelId(e.target.value)}>
              {instances.map((i) => (
                <option key={i.instanceId} value={i.instanceId}>
                  {i.instanceId}
                </option>
              ))}
            </Select>
            <Select
              value={filter}
              onChange={(e) => setFilter(e.target.value as ArticleFilter)}
            >
              {FILTERS.map((f) => (
                <option key={f} value={f}>
                  {t(`filter.${f}`)}
                </option>
              ))}
            </Select>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                void reloadInstances();
                void reloadArticles(selId);
              }}
            >
              <RefreshCw className="size-3" /> {t("actions.refresh")}
            </Button>
          </>
        )}
      </PageHeader>

      {msg && (
        <div className="border-b px-4 py-1.5 text-xs text-destructive">
          {msg}
        </div>
      )}

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-4">
        {instances.length === 0 && (
          <Empty className="pt-16">
            <div className="space-y-3 text-center">
              <p>{t("reading.emptyNoSources")}</p>
              <p className="text-[11px]">
                {t("reading.emptyNoSourcesHint")}
              </p>
              <Button size="sm" onClick={() => setSourcesOpen(true)}>
                <Inbox /> {t("reading.openSources")}
              </Button>
            </div>
          </Empty>
        )}

        {instances.length > 0 && !selId && (
          <Empty>{t("reading.selectInstance")}</Empty>
        )}

        {instances.length > 0 && selId && loading && (
          <Empty>{t("reading.loading")}</Empty>
        )}

        {instances.length > 0 && selId && !loading && filtered.length === 0 && (
          <Empty>
            {filter === "all"
              ? t("reading.emptyNoArticles")
              : t("reading.emptyNoArticlesFiltered", {
                  filter: t(`filter.${filter}`),
                })}
          </Empty>
        )}

        {filtered.map((a) => {
          const tags = parseTags(a);
          const read = a.read === 1;
          const archived = a.archived === 1;
          return (
            <Card key={a.id} className={cn(read && "opacity-70")}>
              <CardContent className="space-y-1">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <button
                      className="flex items-start gap-1.5 text-left text-[13px] font-medium hover:underline"
                      title={a.url}
                      onClick={() => void api.openExternal(a.url)}
                    >
                      <ExternalLink className="mt-0.5 size-3 shrink-0 text-muted-foreground" />
                      <span className="min-w-0">{a.title || a.url}</span>
                    </button>
                    <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[10px] text-muted-foreground">
                      {!read && <Badge variant="default">{t("filter.unread")}</Badge>}
                      {archived && <Badge variant="warning">{t("filter.archived")}</Badge>}
                      <span>{fmtWhen(a.publishedAt)}</span>
                      {tags.map((t) => (
                        <Badge key={t} variant="secondary">
                          {t}
                        </Badge>
                      ))}
                    </div>
                    {a.summary && (
                      <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">
                        {a.summary}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 flex-col gap-1.5">
                    <Button
                      size="xs"
                      variant={read ? "ghost" : "outline"}
                      onClick={() => setArticleState(a, { read: !read })}
                    >
                      {read ? t("reading.markUnread") : t("reading.markRead")}
                    </Button>
                    <Button
                      size="xs"
                      variant={archived ? "ghost" : "outline"}
                      onClick={() =>
                        setArticleState(a, { archived: !archived })
                      }
                    >
                      <Archive className="size-3" />{" "}
                      {archived ? t("reading.unarchive") : t("reading.archive")}
                    </Button>
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
