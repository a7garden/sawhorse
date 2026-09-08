import { useEffect, useMemo, useState, type MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { ArrowLeft, ArrowUpRight, BookOpen, CalendarDays, ChevronLeft, ChevronRight, Copy, RefreshCw, Search } from "lucide-react";
import { api } from "@/lib/api";
import { useApp } from "@/lib/store";
import { Button } from "@/components/ui/button";
import { useContextMenu } from "@/components/ui/context-menu";
import { toast } from "@/components/ui/toast";
import { MarkdownView, PageHeader } from "@/pages/common";
import { cn } from "@/lib/utils";
import { dateKey, fieldText, journalPage, noteDate, useJournal } from "./journal";
import "./journal.css";

export default function JournalPage() {
  const { t, i18n } = useTranslation("journal");
  const { result, loading, error, refresh, revision } = useJournal();
  const [month, setMonth] = useState(dateKey().slice(0, 7));
  const [query, setQuery] = useState("");
  const [path, setPath] = useState<string | null>(null);
  const [mobileReader, setMobileReader] = useState(false);
  const [body, setBody] = useState<{ path: string; markdown: string } | null>(null);
  const [readError, setReadError] = useState("");
  const [openError, setOpenError] = useState("");
  const rows = result?.rows ?? [];
  const today = dateKey();
  const locale = i18n.language === "ko" ? "ko-KR" : "en-US";
  const format = (key: string, options: Intl.DateTimeFormatOptions) => new Date(`${key}T12:00:00`).toLocaleDateString(locale, options);
  const visible = useMemo(() => (result?.rows ?? []).filter((row) => query.trim()
    ? [row.title, row.rel, ...Object.values(row.fields).map(fieldText)].join(" ").toLowerCase().includes(query.trim().toLowerCase())
    : noteDate(row)?.startsWith(month) || !noteDate(row)), [result, month, query]);
  const selected = visible.find((row) => row.path === path) ?? visible[0] ?? null;
  const selectedPath = selected?.path;
  const dates = new Set(rows.map(noteDate).filter((date): date is string => Boolean(date)));
  const monthDays = [...dates].filter((date) => date.startsWith(month)).length;
  const start = new Date(`${month}-01T12:00:00`);
  const days = new Date(start.getFullYear(), start.getMonth() + 1, 0).getDate();
  const offset = (start.getDay() + 6) % 7;

  useEffect(() => {
    let alive = true;
    setBody(null);
    setReadError("");
    setOpenError("");
    if (selectedPath) api.readNote(selectedPath).then((note) => {
      if (alive) setBody({ path: selectedPath, markdown: note.markdown });
    }).catch((cause) => { if (alive) setReadError(String(cause)); });
    return () => { alive = false; };
  }, [selectedPath, revision]);

  function moveMonth(delta: number) {
    setMonth(dateKey(new Date(start.getFullYear(), start.getMonth() + delta, 1)).slice(0, 7));
    setQuery("");
    setPath(null);
  }
  function chooseDate(key: string) {
    setQuery("");
    setMonth(key.slice(0, 7));
    setPath(rows.find((row) => noteDate(row) === key)?.path ?? null);
    setMobileReader(true);
  }
  const menu = useContextMenu();
  const openEntryMenu = (event: MouseEvent, row: (typeof rows)[number]) => menu.open(event, [
    { type: "label", label: row.rel },
    { label: t("menu.read"), icon: <BookOpen />, onSelect: () => { setPath(row.path); const date = noteDate(row); if (date) setMonth(date.slice(0, 7)); setMobileReader(true); } },
    { label: t("openFile"), icon: <ArrowUpRight />, onSelect: () => { void api.openPath(row.path).catch((cause) => toast({ tone: "error", text: String(cause) })); } },
    { type: "separator" },
    { label: t("menu.copyPath"), icon: <Copy />, onSelect: () => { void navigator.clipboard.writeText(row.path).then(() => toast({ tone: "success", text: t("menu.copied") }), (cause) => toast({ tone: "error", text: String(cause) })); } },
  ]);
  return <div className="journal-page">
    <PageHeader title={t("title")}>
      <Button size="sm" variant="ghost" onClick={refresh} disabled={loading}><RefreshCw className={cn("size-3", loading && "animate-spin")} />{t("refresh")}</Button>
    </PageHeader>
    <div className={cn("journal-layout", mobileReader && "is-reading")}>
      <section className="journal-index" aria-label={t("browse")}>
        <div className="journal-calendar">
          <div className="journal-calendar-heading"><CalendarDays size={16} /><strong>{format(`${month}-01`, { year: "numeric", month: "long" })}</strong>
            <button aria-label={t("previousMonth")} onClick={() => moveMonth(-1)}><ChevronLeft size={16} /></button>
            <button aria-label={t("nextMonth")} onClick={() => moveMonth(1)}><ChevronRight size={16} /></button>
          </div>
          <div className="journal-calendar-grid">
            {Array.from({ length: 7 }, (_, index) => <span className="journal-weekday" key={`week-${index}`}>{format(`2026-06-${String(index + 1).padStart(2, "0")}`, { weekday: "short" })}</span>)}
            {Array.from({ length: offset }, (_, index) => <span key={`blank-${index}`} />)}
            {Array.from({ length: days }, (_, index) => {
              const key = `${month}-${String(index + 1).padStart(2, "0")}`;
              return <button key={key} disabled={!dates.has(key)} aria-label={t(dates.has(key) ? "recordDate" : "emptyDate", { date: key })}
                aria-pressed={Boolean(selected && noteDate(selected) === key)}
                aria-current={key === today ? "date" : undefined}
                className={cn("journal-day", dates.has(key) && "has-entry", selected && noteDate(selected) === key && "is-selected", key === today && "is-today")}
                onClick={() => chooseDate(key)}>{index + 1}<i /></button>;
            })}
          </div>
          <div className="journal-calendar-footer"><span><i />{t("recordedDays", { count: monthDays })}</span><button onClick={() => { setMonth(today.slice(0, 7)); setQuery(""); setPath(rows.find((row) => noteDate(row) === today)?.path ?? null); }}>{t("today")}</button></div>
        </div>
        <label className="journal-search"><Search size={15} /><input aria-label={t("search")} placeholder={t("search")} value={query} onChange={(event) => setQuery(event.target.value)} /></label>
        <div className="journal-list-heading"><span>{query ? t("results") : t("entries")}</span><span>{visible.length}</span></div>
        <div className="journal-entry-list" aria-busy={loading}>
          {error ? <p className="journal-empty" role="alert">{error}</p> : loading && !result ? <p className="journal-empty" role="status">{t("loading")}</p> : visible.length === 0 ? <div className="journal-empty"><BookOpen size={24} /><p>{query ? t("noResults") : t("emptyMonth")}</p>{rows.length > 0 && !query && <button onClick={() => { const latest = rows.find(noteDate); if (latest) chooseDate(noteDate(latest)!); }}>{t("latest")}</button>}</div> : visible.map((row) => {
            const date = noteDate(row);
            return <button className={cn("journal-entry", selectedPath === row.path && "is-selected")} key={row.path} aria-pressed={selectedPath === row.path} onClick={() => { setPath(row.path); if (date) setMonth(date.slice(0, 7)); setMobileReader(true); }} onContextMenu={(event) => openEntryMenu(event, row)}>
              <span className="journal-date-tile"><strong>{date ? date.slice(8) : <BookOpen size={20} />}</strong><small>{date ? format(date, { weekday: "short" }) : "—"}</small></span>
              <span className="journal-entry-copy"><strong>{date === today ? t("todayEntry") : row.title}</strong><small>{fieldText(row.fields.summary) || fieldText(row.fields.tags) || (date ? format(date, { month: "long", day: "numeric" }) : row.rel)}</small></span><ChevronRight size={14} />
            </button>;
          })}
        </div>
        {result?.truncated && <p className="journal-limit">{t("limited")}</p>}
      </section>
      <section className="journal-reader" aria-label={t("reader")}>
        <button className="journal-back" onClick={() => setMobileReader(false)}><ArrowLeft size={15} />{t("browse")}</button>
        {selected && !error ? <article className="journal-paper selectable" key={selectedPath}>
          <header className="journal-paper-header">
            <div className="journal-eyebrow"><BookOpen size={14} />{t("dailyRecord")}{noteDate(selected) === today && <span>{t("today")}</span>}</div>
            <h2>{noteDate(selected) ? format(noteDate(selected)!, { month: "long", day: "numeric", weekday: "long" }) : selected.title}</h2>
            <div className="journal-paper-meta"><span>{noteDate(selected)?.slice(0, 4)}</span>{fieldText(selected.fields.mood) && <span>{fieldText(selected.fields.mood)}</span>}{fieldText(selected.fields.tags) && <span>{fieldText(selected.fields.tags)}</span>}</div>
            <div className="journal-file"><span title={selected.rel}>{selected.rel}</span><button onClick={() => { void api.openPath(selected.path).catch((cause) => setOpenError(String(cause))); }}>{t("openFile")}<ArrowUpRight size={13} /></button></div>
          </header>
          {openError && <p role="alert">{openError}</p>}
          {readError ? <p className="journal-empty" role="alert">{readError}</p> : body?.path === selectedPath ? <div className="journal-prose"><MarkdownView src={body.markdown} notePath={selected.path} /></div> : <p className="journal-empty" role="status">{t("loading")}</p>}
          <footer className="journal-paper-footer">{t("modified", { date: new Date(selected.mtimeMs).toLocaleString(locale, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) })}</footer>
        </article> : <div className="journal-reader-empty"><BookOpen size={36} strokeWidth={1} /><h2>{t("emptyTitle")}</h2><p>{error || (loading ? t("loading") : t(rows.length ? "chooseEntry" : "emptyHint"))}</p></div>}
      </section>
    </div>
    {menu.element}
  </div>;
}

export function JournalWidget() {
  const { t, i18n } = useTranslation("journal");
  const { result, error, loading, refresh } = useJournal();
  const setPage = useApp((state) => state.setPage);
  const today = dateKey();
  const dates = new Set((result?.rows ?? []).map(noteDate));
  const open = () => setPage(journalPage);
  return <div className="journal-widget">
    <button className="journal-widget-heading" onClick={open}><span className="journal-widget-icon"><BookOpen size={21} /></span><span><strong>{t("title")}</strong><small>{t(dates.has(today) ? "todayRecorded" : "recentEntries")}</small></span><ArrowUpRight size={17} /></button>
    <div className="journal-week" aria-label={t("lastWeek")}>{Array.from({ length: 7 }, (_, index) => {
      const date = new Date(); date.setDate(date.getDate() - 6 + index);
      const key = dateKey(date);
      return <div className={cn(dates.has(key) && "has-entry", key === today && "is-today")} key={key} title={t(dates.has(key) ? "recordDate" : "emptyDate", { date: key })}><span>{date.toLocaleDateString(i18n.language, { weekday: "short" })}</span><strong>{date.getDate()}</strong><i /></div>;
    })}</div>
    {error ? <div className="journal-empty" role="alert">{error}<button onClick={refresh}>{t("refresh")}</button></div> : loading ? <p className="journal-empty">{t("loading")}</p> : <button className="journal-widget-latest" onClick={open}><span>{result?.rows[0]?.title ?? t("emptyTitle")}</span><span>{t("viewEntries")}<ChevronRight size={13} /></span></button>}
  </div>;
}
