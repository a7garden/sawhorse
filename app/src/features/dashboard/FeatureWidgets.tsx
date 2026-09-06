import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { useApp } from "@/lib/store";
import { useCoreExtensions } from "@/lib/core-extensions";
import { isFeedCfg, type ArticleRow, type TaskRow } from "@/lib/types";
export function ScheduledTasksWidget() {
  const [rows, setRows] = useState<TaskRow[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let alive = true;
    const refresh = () =>
      api
        .listTasks()
        .then((view) => {
          if (alive) {
            setRows(
              [...view.builtin, ...view.tasks].filter((r) => r.def.schedule),
            );
            setError("");
          }
        })
        .catch((error) => {
          if (alive) setError(String(error));
        });
    void refresh();
    const timer = window.setInterval(() => void refresh(), 15000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);
  return (
    <>
      {error && (
        <div className="wb-slot-empty" role="status">
          {error}
        </div>
      )}
      {rows.map(({ def }) => (
        <div key={def.id} className="wb-slot-empty">
          <strong>{def.title}</strong> ·{" "}
          {def.schedule?.kind === "once"
            ? def.schedule.date
            : def.schedule?.kind === "weekdays"
              ? "평일"
              : "매일"}{" "}
          {def.schedule?.time} {!def.enabled && "· 일시정지"}
        </div>
      ))}
      {!rows.length && !error && (
        <div className="wb-slot-empty">
          작업을 만들고 실행 시간을 지정하세요.
        </div>
      )}
    </>
  );
}
export function ReadingWidget() {
  const enabled = useCoreExtensions((s) => s.feeds);
  const setPage = useApp((s) => s.setPage);
  const [articles, setArticles] = useState<ArticleRow[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const refresh = async () => {
      try {
        const { instances } = await api.sourcesListInstances();
        const groups = await Promise.all(
          instances
            .filter((i) => isFeedCfg(i.config))
            .map((i) => api.articlesList(i.instanceId)),
        );
        if (alive) {
          setArticles(
            groups
              .flatMap((g) => g.articles)
              .filter((a) => !a.archived && !a.read)
              .slice(0, 8),
          );
          setError("");
        }
      } catch (error) {
        if (alive) setError(String(error));
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 30000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [enabled]);
  if (!enabled)
    return (
      <div className="wb-slot-empty">
        확장에서 읽을거리를 켜면 새 글이 표시됩니다.
      </div>
    );
  return (
    <>
      {articles.map((a) => (
        <button
          key={a.id}
          className="block w-full border-b p-3 text-left text-sm hover:bg-accent"
          onClick={() => setPage("reading")}
        >
          {a.title}
        </button>
      ))}
      {!articles.length && (
        <div className="wb-slot-empty">
          {error || "읽지 않은 새 글이 없습니다."}
        </div>
      )}
    </>
  );
}
