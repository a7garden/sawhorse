import { useCallback, useEffect, useRef, useState } from "react";
import { CalendarDays, Check, CheckCheck, CircleAlert, Flag, Inbox, ListTodo, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/api";
import { useApp } from "@/lib/store";
import type { ManagedTodo, ManagedTodoInput } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { localDate, matchesView, sortTodos, todoViews, type TodoView } from "@/features/todos/model";
import "@/features/todos/todos.css";

const icons = { all: ListTodo, today: CalendarDays, upcoming: CalendarDays, undated: Inbox, overdue: CircleAlert, completed: CheckCheck };
const blank = (): ManagedTodoInput => ({ text: "", checked: false, dueDate: null, priority: "normal" });

export default function TodosPage() {
  const { t, i18n } = useTranslation("sessions");
  const journal = useApp((s) => s.todos);
  const [items, setItems] = useState<ManagedTodo[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [view, setView] = useState<TodoView>("all");
  const [query, setQuery] = useState("");
  const [priority, setPriority] = useState("all");
  const [sort, setSort] = useState("date");
  const [today, setToday] = useState(localDate);
  const [draft, setDraft] = useState<ManagedTodoInput>(blank);
  const [editorOpen, setEditorOpen] = useState(false);
  const [removing, setRemoving] = useState<ManagedTodo | null>(null);
  const busy = useRef(false);
  const request = useRef(0);
  const composer = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    const version = ++request.current;
    try {
      const result = await api.listManagedTodos();
      if (version === request.current) { setItems(result); setLoaded(true); setError(""); }
    } catch (cause) {
      if (version === request.current) setError(String(cause));
    }
  }, []);
  useEffect(() => { void refresh(); }, [journal, refresh]);
  useEffect(() => {
    const update = () => { setToday(localDate()); void refresh(); };
    const timer = window.setInterval(update, 60_000);
    window.addEventListener("focus", update);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", update); request.current++; };
  }, [refresh]);
  useEffect(() => { if (editorOpen) composer.current?.focus(); }, [editorOpen]);

  async function mutate(input: ManagedTodoInput, after?: () => void) {
    if (busy.current) return;
    busy.current = true;
    setPending(true);
    setError("");
    try {
      await api.saveManagedTodo(input);
      after?.();
      await refresh();
      void useApp.getState().refreshTodos().catch(() => {});
    } catch (cause) {
      setError(String(cause));
    } finally { busy.current = false; setPending(false); }
  }

  const counts = Object.fromEntries(todoViews.map((key) => [key, items.filter((item) => matchesView(item, key, today)).length]));
  const visible = sortTodos(items.filter((item) => matchesView(item, view, today) && (priority === "all" || item.priority === priority) && item.text.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase())), sort);
  const total = items.length;
  const completed = counts.completed;
  const groups = view === "all" && sort === "date"
    ? ["overdue", "today", "upcoming", "undated"].map((key) => ({ key, items: visible.filter((item) => matchesView(item, key as TodoView, today)) }))
    : [{ key: view, items: visible }];
  const dateLabel = (date: string) => {
    if (date === today) return t("todos.views.today");
    return new Intl.DateTimeFormat(i18n.language, { month: "short", day: "numeric", year: date.slice(0, 4) !== today.slice(0, 4) ? "numeric" : undefined }).format(new Date(`${date}T12:00:00`));
  };
  const priorityOptions = ["high", "normal", "low"].map((value) => ({ value, label: t(`todos.priorities.${value}`) }));
  function startNew() {
    const tomorrow = new Date(`${today}T12:00:00`); tomorrow.setDate(tomorrow.getDate() + 1);
    setDraft({ ...blank(), dueDate: view === "today" ? today : view === "upcoming" ? localDate(tomorrow) : null });
    setEditorOpen(true);
  }

  return <div className="todos-page">
    <header className="todos-header">
      <div><span className="todos-eyebrow">{t("todos.eyebrow")}</span><h1>{t("todos.title")}</h1><p>{t("todos.description")}</p></div>
      <Button onClick={startNew} disabled={pending}><Plus size={15} />{t("todos.new")}</Button>
    </header>
    <div className="todos-layout">
      <nav className="todos-nav" aria-label={t("todos.navigation")}>
        {todoViews.map((key) => { const Icon = icons[key]; return <button key={key} type="button" aria-current={view === key ? "page" : undefined} className={key === "overdue" && counts.overdue > 0 ? "has-overdue" : ""} onClick={() => setView(key)}><Icon size={16} /><span>{t(`todos.views.${key}`)}</span><b>{counts[key]}</b></button>; })}
        <div className="todos-progress"><div><span>{t("todos.progress")}</span><b>{completed}/{total}</b></div><progress value={completed} max={total || 1} aria-label={t("todos.progress")} /><p>{t("todos.persistenceHint")}</p></div>
      </nav>
      <section className="todos-content" aria-label={t("todos.list")} aria-busy={pending}>
        {error && <div role="alert" className="todos-error"><span>{error}</span><Button size="sm" variant="outline" disabled={pending} onClick={() => void refresh()}>{t("todos.retry")}</Button></div>}
        {editorOpen && <form className="todos-composer" onSubmit={(event) => { event.preventDefault(); void mutate(draft, () => { setDraft(blank()); setEditorOpen(false); if (!draft.id) { setView("all"); setQuery(""); setPriority("all"); } }); }}>
          <div className="todos-composer-heading"><strong>{t(draft.id ? "todos.edit" : "todos.new")}</strong><span>{t("todos.dateOptional")}</span></div>
          <Input ref={composer} aria-label={t("todos.taskTitle")} placeholder={t("todos.newItemPlaceholder")} value={draft.text} maxLength={1000} required disabled={pending} onChange={(event) => setDraft({ ...draft, text: event.target.value })} />
          <div className="todos-composer-fields">
            <label><span>{t("todos.dueDate")}</span><Input type="date" aria-label={t("todos.dueDate")} value={draft.dueDate ?? ""} disabled={pending} onChange={(event) => setDraft({ ...draft, dueDate: event.target.value || null })} /></label>
            <label><span>{t("todos.priority")}</span><Select aria-label={t("todos.priority")} options={priorityOptions} value={draft.priority} disabled={pending} onChange={(value) => setDraft({ ...draft, priority: value as ManagedTodo["priority"] })} /></label>
            <div className="todos-composer-actions"><Button type="button" variant="ghost" disabled={pending} onClick={() => { setEditorOpen(false); setDraft(blank()); }}>{t("todos.cancel")}</Button><Button type="submit" disabled={pending || !draft.text.trim()}><Check size={14} />{t(pending ? "todos.saving" : "todos.save")}</Button></div>
          </div>
        </form>}
        <div className="todos-list-heading"><div><h2>{t(`todos.views.${view}`)}</h2><span>{visible.length}</span></div><p>{t(`todos.hints.${view}`)}</p></div>
        <div className="todos-toolbar">
          <div className="todos-search"><Search size={15} /><Input aria-label={t("todos.search")} placeholder={t("todos.search")} value={query} onChange={(event) => setQuery(event.target.value)} /></div>
          <Select aria-label={t("todos.priorityFilter")} value={priority} onChange={setPriority} options={[{ value: "all", label: t("todos.allPriorities") }, ...priorityOptions]} />
          <Select aria-label={t("todos.sort")} value={sort} onChange={setSort} options={[{ value: "date", label: t("todos.sortDate") }, { value: "priority", label: t("todos.sortPriority") }]} />
        </div>
        {!loaded && !error && <p role="status" className="todos-empty">{t("todos.loading")}</p>}
        {loaded && visible.length === 0 && <div className="todos-empty"><Inbox size={30} /><h3>{t(query || priority !== "all" ? "todos.noMatches" : "todos.empty")}</h3><p>{t(query || priority !== "all" ? "todos.filterHint" : "todos.emptyHint")}</p>{query || priority !== "all" ? <Button variant="outline" onClick={() => { setQuery(""); setPriority("all"); }}>{t("todos.clearFilters")}</Button> : view !== "completed" && <Button variant="outline" onClick={startNew}><Plus size={14} />{t("todos.new")}</Button>}</div>}
        {groups.filter((group) => group.items.length).map((group) => <section className="todos-group" key={group.key} aria-label={t(`todos.views.${group.key}`)}>
          {view === "all" && sort === "date" && <h3 className={group.key === "overdue" ? "is-overdue" : ""}>{t(`todos.views.${group.key}`)}<span>{group.items.length}</span></h3>}
          <ul>{group.items.map((item) => <li key={item.id} className={`todos-row ${item.checked ? "is-completed" : ""}`}>
            <Checkbox checked={item.checked} disabled={pending} aria-label={t(item.checked ? "todos.reopenTask" : "todos.completeTask", { title: item.text })} onChange={(event) => void mutate({ ...item, checked: event.target.checked })} />
            <button className="todos-task-text" type="button" disabled={pending} onClick={() => { setDraft(item); setEditorOpen(true); }}><span>{item.text}</span><small>{item.source.endsWith("할 일.md") || item.source === "" ? t("todos.personal") : item.source}</small></button>
            <span className={`todos-priority is-${item.priority}`}><Flag size={12} />{t(`todos.priorities.${item.priority}`)}</span>
            <span className={`todos-due ${!item.checked && item.dueDate && item.dueDate < today ? "is-overdue" : ""}`} title={item.dueDate ?? undefined}><CalendarDays size={13} />{item.dueDate ? dateLabel(item.dueDate) : t("todos.views.undated")}</span>
            <div className="todos-row-actions"><Button variant="ghost" size="icon" disabled={pending} aria-label={t("todos.editTask", { title: item.text })} onClick={() => { setDraft(item); setEditorOpen(true); }}><Pencil size={14} /></Button><Button variant="ghost" size="icon" disabled={pending} aria-label={t("todos.deleteTask", { title: item.text })} onClick={() => setRemoving(item)}><Trash2 size={14} /></Button></div>
          </li>)}</ul>
        </section>)}
      </section>
    </div>
    <Dialog open={!!removing} title={t("todos.deleteTitle")} onClose={pending ? undefined : () => setRemoving(null)}>
      <p className="break-words text-sm">{removing?.text}</p><p className="mt-2 text-xs text-muted-foreground">{t("todos.deleteHint")}</p>
      <div className="mt-5 flex justify-end gap-2"><Button variant="ghost" disabled={pending} onClick={() => setRemoving(null)}>{t("todos.cancel")}</Button><Button variant="destructive" disabled={pending} onClick={() => removing && void mutate({ ...removing, deleted: true }, () => { if (draft.id === removing.id) setEditorOpen(false); setRemoving(null); })}>{t("todos.delete")}</Button></div>
      {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
    </Dialog>
  </div>;
}
