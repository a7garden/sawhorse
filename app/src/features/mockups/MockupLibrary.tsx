import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { sddApi } from "@/features/workbench/api";
import type { WorkItem, Project } from "@/features/workbench/types";
import type { Mockup } from "./types";
import { sandboxedMockupHtml } from "./preview-html";
import "./mockups.css";
function Thumbnail({ mockup }: { mockup: Mockup }) {
  const [html, setHtml] = useState("");
  useEffect(() => { let alive = true; void sddApi.readMockupHtml(mockup.id, mockup.screens[0].id).then((s) => { if (alive) setHtml(sandboxedMockupHtml(s)); }).catch(() => {}); return () => { alive = false; }; }, [mockup.id, mockup.revision]);
  return <div className="mockup-library-thumbnail" aria-hidden="true">{html && <iframe title={mockup.title} sandbox="" tabIndex={-1} srcDoc={html} loading="lazy" />}</div>;
}
export function MockupLibrary({ work, projects, onSelectWork }: { work: WorkItem[]; projects: Project[]; onSelectWork: (id: string) => void }) {
  const { t } = useTranslation("workbench");
  const [items, setItems] = useState<Mockup[]>([]), [errors, setErrors] = useState<string[]>([]);
  const [latestOnly, setLatestOnly] = useState(true), [loading, setLoading] = useState(false);
  const key = work.filter((w) => w.workflowId === "mockup-review" || w.artifacts.includes("mockup")).map((w) => `${w.id}:${w.updatedAt}`).sort().join("|");
  useEffect(() => { let alive = true; setLoading(true);
    const ids = key ? key.split("|").map((value) => value.split(":")[0]) : [];
    void Promise.allSettled(ids.map((id) => sddApi.readMockup(id))).then((results) => {
      if (!alive) return;
      setItems(results.flatMap((r) => r.status === "fulfilled" ? [r.value] : []));
      setErrors(results.flatMap((r, i) => r.status === "rejected" ? [`${ids[i]}: ${String(r.reason)}`] : [])); setLoading(false);
    }); return () => { alive = false; };
  }, [key]);
  const parents = new Set(items.map((m) => m.parentMockupId).filter(Boolean));
  const shown = items.filter((m) => !latestOnly || !parents.has(m.id)).sort((a,b) => b.revision - a.revision || a.title.localeCompare(b.title));
  return <section className="mockup-library" aria-label={t("mockupLibrary.title")}>
    <header><div><h2>{t("mockupLibrary.title")}</h2><p>{t("mockupLibrary.hint")}</p></div><Button variant="outline" aria-pressed={latestOnly} onClick={() => setLatestOnly(!latestOnly)}>{t(latestOnly ? "mockupLibrary.latest" : "mockupLibrary.all")}</Button></header>
    {loading && <p role="status">{t("common.loading")}</p>}
    {errors.length > 0 && <details><summary>{t("mockupLibrary.unavailable", { count: errors.length })}</summary>{errors.map((e) => <p key={e}>{e}</p>)}</details>}
    <div className="mockup-library-grid">{shown.map((m) => <article key={m.id}>
      <button className="mockup-library-open" onClick={() => onSelectWork(m.id)} aria-label={m.title}><Thumbnail mockup={m} /><div className="mockup-library-body"><small>{projects.find((p) => p.id === m.projectId)?.name} · Rev {m.revision}</small><h3>{m.title}</h3><p>{t("mockupLibrary.count", { screens: m.screens.length, issues: m.issues.length })}</p><div className="mockup-library-screens">{m.screens.map((s) => <span key={s.id}>{s.label}</span>)}</div></div></button>
      <footer><span>{t(`status.${work.find((w) => w.id === m.id)?.status}`, { defaultValue: work.find((w) => w.id === m.id)?.status })}</span>{m.parentMockupId && <Button size="sm" variant="ghost" onClick={() => onSelectWork(m.parentMockupId)}>{t("mockupLibrary.previous")}</Button>}</footer>
    </article>)}</div>{!loading && !shown.length && <p className="wb-lifecycle-notice">{t("mockupLibrary.empty")}</p>}
  </section>;
}
