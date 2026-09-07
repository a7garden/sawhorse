// 선언형 뷰 렌더러. 팩이 `type: "notes"` 로 선언한 화면 전부가 이 한 컴포넌트로 그려진다.
// 호스트는 필드의 뜻을 모르고, 라벨·순서·묶는 기준은 매니페스트가 정한다.
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { ExternalLink, RefreshCw, Search } from "lucide-react";
import { api } from "@/lib/api";
import { actionJobKey } from "@/lib/jobs";
import { RunButton } from "@/components/RunButton";
import { useApp } from "@/lib/store";
import type {
  NoteRow,
  PackAction,
  PackView,
  QueryResult,
  ViewColumn,
} from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { cn } from "@/lib/utils";
import {
  Empty,
  MarkdownView,
  PageHeader,
  fmtDate,
  statusBadgeVariant,
} from "./common";

const ALL = "전체";

function asList(v: unknown): string[] {
  if (v == null) return [];
  if (Array.isArray(v))
    return v.map((x) => (typeof x === "string" ? x : JSON.stringify(x)));
  if (typeof v === "string") return v.length > 0 ? [v] : [];
  return [String(v)];
}

function cellText(row: NoteRow, col: ViewColumn): string {
  if (col.source === "title") return row.title;
  if (col.source === "mtime") return fmtDate(row.mtimeMs);
  if (col.source === "path") return row.rel;
  return asList(row.fields[col.field]).join(", ");
}

function Cell({ row, col }: { row: NoteRow; col: ViewColumn }) {
  const text = cellText(row, col);
  if (col.type === "badge") {
    return text ? (
      <Badge variant={statusBadgeVariant(text)}>{text}</Badge>
    ) : (
      <span className="text-muted-foreground">-</span>
    );
  }
  if (col.type === "check") {
    const on = row.fields[col.field] === true || text === "true";
    return (
      <span className={on ? "text-[var(--success)]" : "text-muted-foreground"}>
        {on ? "✓" : "-"}
      </span>
    );
  }
  if (col.type === "list") {
    const items = col.source ? [text] : asList(row.fields[col.field]);
    if (items.length === 0 || items[0] === "")
      return <span className="text-muted-foreground">-</span>;
    return (
      <span className="flex flex-wrap gap-1">
        {items.map((i) => (
          <Badge key={i} variant="outline">
            {i}
          </Badge>
        ))}
      </span>
    );
  }
  return (
    <span className={cn(!text && "text-muted-foreground")}>{text || "-"}</span>
  );
}

function DeclarativeRows({
  kind,
  rows,
  columns,
  groupBy,
  selected,
  selection,
  checked,
  onCheck,
  onOpen,
}: {
  kind: PackView["type"];
  rows: NoteRow[];
  columns: ViewColumn[];
  groupBy: string;
  selected: NoteRow | null;
  selection: PackView["selection"];
  checked: Set<string>;
  onCheck: (row: NoteRow, on: boolean) => void;
  onOpen: (row: NoteRow) => void;
}) {
  const { t } = useTranslation("packs");
  if (kind === "board") {
    const groups = new Map<string, NoteRow[]>();
    for (const row of rows) {
      const key = asList(row.fields[groupBy]).join(", ") || t("view.ungrouped");
      groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    return (
      <div className="flex min-w-max gap-3 p-4">
        {[...groups].map(([name, items]) => (
          <section key={name} className="w-64 rounded-lg bg-muted/60 p-3">
            <h3 className="mb-2 text-xs font-semibold">
              {name} · {items.length}
            </h3>
            {items.map((row) => (
              <button
                key={row.path}
                className="mb-2 w-full rounded-md border bg-background p-3 text-left text-xs hover:border-primary"
                onClick={() => onOpen(row)}
              >
                <strong className="block">{row.title}</strong>
                {columns.slice(1, 3).map((column, index) => (
                  <span
                    key={index}
                    className="mt-1 block text-muted-foreground"
                  >
                    {column.label}: {cellText(row, column) || "-"}
                  </span>
                ))}
              </button>
            ))}
          </section>
        ))}
      </div>
    );
  }
  if (kind === "metrics") {
    const grouped = new Map<string, number>();
    for (const row of rows) {
      const value = groupBy
        ? asList(row.fields[groupBy]).join(", ") || t("view.ungrouped")
        : ALL;
      grouped.set(value, (grouped.get(value) ?? 0) + 1);
    }
    return (
      <div className="grid gap-3 p-5 sm:grid-cols-2 lg:grid-cols-4">
        {[...grouped].map(([label, value]) => (
          <Card key={label}>
            <CardContent className="p-5">
              <strong className="block text-3xl">{value}</strong>
              <span className="text-xs text-muted-foreground">
                {label === ALL ? t("view.all") : label}
              </span>
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }
  if (["document", "form", "timeline", "graph"].includes(kind)) {
    return (
      <div className="space-y-2 p-4">
        {rows.map((row, index) => (
          <button
            key={row.path}
            className={cn(
              "grid w-full gap-2 rounded-md border p-3 text-left hover:bg-accent",
              kind === "timeline" && "grid-cols-[80px_1fr]",
              selected?.path === row.path && "border-primary",
            )}
            onClick={() => onOpen(row)}
          >
            {kind === "timeline" && (
              <time className="text-[10px] text-muted-foreground">
                {fmtDate(row.mtimeMs)}
              </time>
            )}
            <span>
              <strong className="block text-sm">{row.title}</strong>
              <span className="text-xs text-muted-foreground">
                {kind === "graph"
                  ? `${index > 0 ? "↳" : "●"} ${columns
                      .map((column) => cellText(row, column))
                      .filter(Boolean)
                      .join(" · ")}`
                  : row.rel}
              </span>
            </span>
          </button>
        ))}
      </div>
    );
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          {selection === "multiple" && (
            <TableHead className="w-10">
              <span className="sr-only">{t("view.select")}</span>
            </TableHead>
          )}
          {columns.map((column, index) => (
            <TableHead
              key={`${column.field}-${column.source}-${index}`}
              style={column.width ? { width: column.width } : undefined}
            >
              {column.label}
            </TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((row) => (
          <TableRow
            key={row.path}
            onClick={() => onOpen(row)}
            className={cn(
              "cursor-pointer",
              selected?.path === row.path && "bg-secondary",
            )}
          >
            {selection === "multiple" && (
              <TableCell>
                <input
                  type="checkbox"
                  aria-label={t("view.selectRowAria", {
                    title: asList(row.fields.title)[0] || row.title,
                  })}
                  checked={checked.has(row.path)}
                  onClick={(event) => event.stopPropagation()}
                  onChange={(event) => onCheck(row, event.target.checked)}
                />
              </TableCell>
            )}
            {columns.map((column, index) => (
              <TableCell key={`${column.field}-${column.source}-${index}`}>
                <Cell row={row} col={column} />
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

export default function PackViewPage({
  packId,
  viewId,
}: {
  packId: string;
  viewId: string;
}) {
  const { t } = useTranslation("packs");
  const packs = useApp((s) => s.packs);
  const refreshJobs = useApp((s) => s.refreshJobs);
  const setPage = useApp((s) => s.setPage);

  const pack = packs?.packs.find((p) => p.id === packId) ?? null;
  const view: PackView | null =
    pack?.views.find((v) => v.id === viewId) ?? null;
  const actions: PackAction[] = useMemo(
    () =>
      pack && view
        ? pack.actions.filter((a) => view.actions.includes(a.id))
        : [],
    [pack, view],
  );

  const [result, setResult] = useState<QueryResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [group, setGroup] = useState(ALL);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<NoteRow | null>(null);
  const [checkedPaths, setCheckedPaths] = useState<string[]>([]);
  const [body, setBody] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [extensionProjects, setExtensionProjects] = useState<string[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const extensionPackageId = packId.startsWith("x-") ? packId.slice(2) : null;

  useEffect(() => {
    if (!extensionPackageId) {
      setExtensionProjects([]);
      setProjectId(null);
      return;
    }
    let alive = true;
    void api
      .extensionLock()
      .then((lock) => {
        if (!alive) return;
        const projects = Object.entries(lock.projects)
          .filter(([, packages]) =>
            packages.some((item) => item.id === extensionPackageId),
          )
          .map(([id]) => id)
          .sort();
        setExtensionProjects(projects);
        setProjectId((current) =>
          current && projects.includes(current)
            ? current
            : (projects[0] ?? null),
        );
      })
      .catch((error) => alive && setErr(String(error)));
    return () => {
      alive = false;
    };
  }, [extensionPackageId]);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    if (extensionPackageId && !projectId) {
      setResult(null);
      setLoading(false);
      return;
    }
    try {
      setResult(await api.queryPackView(packId, viewId, projectId));
    } catch (e) {
      setErr(String(e));
      setResult(null);
    } finally {
      setLoading(false);
    }
  }, [extensionPackageId, packId, projectId, viewId]);

  useEffect(() => {
    setSel(null);
    setCheckedPaths([]);
    setBody(null);
    setGroup(ALL);
    setQ("");
    void load();
  }, [load]);

  const rows = result?.rows ?? [];
  const groups = useMemo(() => {
    if (!view?.groupBy) return [];
    const seen = new Set<string>();
    for (const r of rows) {
      const v = asList(r.fields[view.groupBy]).join(", ");
      if (v) seen.add(v);
    }
    return [...seen].sort();
  }, [rows, view?.groupBy]);

  const visible = rows.filter((r) => {
    if (view?.groupBy && group !== ALL) {
      if (asList(r.fields[view.groupBy]).join(", ") !== group) return false;
    }
    if (q.trim().length === 0) return true;
    const needle = q.trim().toLowerCase();
    const hay = [r.title, r.rel, ...Object.values(r.fields).flatMap(asList)]
      .join(" ")
      .toLowerCase();
    return hay.includes(needle);
  });
  const checked = useMemo(() => new Set(checkedPaths), [checkedPaths]);
  const selectedRows = rows.filter((row) => checked.has(row.path));
  const allVisibleChecked =
    visible.length > 0 && visible.every((row) => checked.has(row.path));

  function checkRow(row: NoteRow, on: boolean) {
    setCheckedPaths((current) =>
      on
        ? [...new Set([...current, row.path])]
        : current.filter((path) => path !== row.path),
    );
  }

  function checkVisible(on: boolean) {
    const visiblePaths = new Set(visible.map((row) => row.path));
    setCheckedPaths((current) =>
      on
        ? [...new Set([...current, ...visiblePaths])]
        : current.filter((path) => !visiblePaths.has(path)),
    );
  }

  async function openRow(row: NoteRow) {
    setSel(row);
    setBody(null);
    try {
      const note = await api.readNote(row.path);
      setBody(note.markdown);
    } catch (e) {
      setBody(`> ${t("view.readFailed", { error: String(e) })}`);
    }
  }

  /** 행을 고른 채 누른 액션은 그 문서를 대상으로 돈다. 중복 판정 키도 이 인자로 정해진다. */
  function paramsFor(targets: NoteRow[]): Record<string, unknown> {
    const params: Record<string, unknown> = {};
    const ids = targets
      .map((row) => asList(row.fields.id)[0])
      .filter(Boolean);
    if (ids.length > 0) params.ids = ids;
    if (view?.selection === "multiple") {
      params.selectionMode =
        targets.length > 0 && targets.length === rows.length
          ? "all"
          : "explicit";
    }
    const project = targets.length > 0
      ? asList(targets[0].fields.projectId ?? targets[0].fields.project)[0]
      : undefined;
    if (project) params.project = project;
    return params;
  }

  async function run(action: PackAction, targets: NoteRow[]) {
    setMsg(null);
    try {
      await api.runPackAction(packId, action.id, paramsFor(targets), projectId);
      await refreshJobs();
      setPage("jobs");
    } catch (e) {
      setMsg(String(e));
    }
  }

  if (!pack || !view) {
    return (
      <Empty className="pt-16">
        {t("view.viewNotFound")}
      </Empty>
    );
  }

  const columns =
    view.columns.length > 0
      ? view.columns
      : [
          { field: "", label: t("view.colTitle"), source: "title", type: "text", width: 0 },
          {
            field: "",
            label: t("view.colModified"),
            source: "mtime",
            type: "date",
            width: 110,
          },
        ];

  return (
    <div className="flex h-full flex-col">
      <PageHeader title={view.label}>
        {extensionPackageId && (
          <Select
            aria-label={t("view.projectAria")}
            className="h-8 w-40"
            value={projectId ?? ""}
            onChange={(event) => setProjectId(event.target.value || null)}
          >
            <option value="">{t("select.project")}</option>
            {extensionProjects.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </Select>
        )}
        {actions.map((a) => (
          <RunButton
            key={a.id}
            jobKey={actionJobKey(
              packId,
              a.id,
              paramsFor(view.selection === "multiple" ? selectedRows : []),
              projectId,
            )}
            label={a.label}
            title={a.description}
            disabled={Boolean(
              (extensionPackageId && !projectId) ||
                (view.selection === "multiple" && selectedRows.length === 0),
            )}
            onRun={() =>
              run(a, view.selection === "multiple" ? selectedRows : [])
            }
            onError={setMsg}
          />
        ))}
        <Button size="sm" variant="ghost" onClick={() => void load()}>
          <RefreshCw className={cn("size-3", loading && "animate-spin")} />{" "}
          {t("actions.refresh")}
        </Button>
      </PageHeader>

      {extensionPackageId && extensionProjects.length === 0 && (
        <div className="border-b bg-warning/10 px-4 py-2 text-xs">
          {t("view.noActiveProject")}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
        {view.selection === "multiple" && (
          <label className="flex items-center gap-1.5 text-xs">
            <input
              type="checkbox"
              aria-label={t("view.selectAllVisible")}
              checked={allVisibleChecked}
              onChange={(event) => checkVisible(event.target.checked)}
            />
            {selectedRows.length > 0
              ? t("view.selectedCount", { n: selectedRows.length })
              : t("view.chooseTargets")}
          </label>
        )}
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t("view.search")}
            className="h-7 w-48 pl-6 text-xs"
          />
        </div>
        {groups.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {[ALL, ...groups].map((g) => (
              <button
                key={g}
                onClick={() => setGroup(g)}
                className={cn(
                  "rounded-md px-2 py-1 text-[11px] transition-colors",
                  group === g
                    ? "bg-secondary font-semibold"
                    : "text-muted-foreground hover:bg-accent",
                )}
              >
                {g}
              </button>
            ))}
          </div>
        )}
        {result && result.folders.length > 0 && (
          <span
            className="ml-auto truncate text-[11px] text-muted-foreground"
            title={result.folders.join(", ")}
          >
            {t("view.folderCount", { n: result.folders.length })}
            {result.truncated && t("view.truncated")}
          </span>
        )}
      </div>

      {msg && (
        <div className="border-b bg-destructive/10 px-4 py-1.5 text-xs text-destructive">
          {msg}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-auto">
          {err && <Empty>{err}</Empty>}
          {!err && visible.length === 0 && (
            <Empty className="px-8">
              {rows.length === 0
                ? view.empty || t("view.noDocuments")
                : t("view.noResults")}
            </Empty>
          )}
          {visible.length > 0 && (
            <DeclarativeRows
              kind={view.type}
              rows={visible}
              columns={columns}
              groupBy={view.groupBy}
              selected={sel}
              selection={view.selection}
              checked={checked}
              onCheck={checkRow}
              onOpen={(row) => void openRow(row)}
            />
          )}
        </div>

        {sel && (
          <aside className="flex w-[26rem] shrink-0 flex-col border-l">
            <div className="flex items-center gap-2 border-b px-3 py-2">
              <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">
                {sel.title}
              </span>
              <Button
                size="xs"
                variant="ghost"
                onClick={() => void api.openPath(sel.path)}
                title={sel.path}
              >
                <ExternalLink className="size-3" /> {t("view.open")}
              </Button>
            </div>
            {actions.length > 0 && (
              <div className="flex flex-wrap gap-1.5 border-b px-3 py-2">
                {actions.map((a) => (
                  <RunButton
                    key={a.id}
                    size="xs"
                    jobKey={actionJobKey(
                      packId,
                      a.id,
                      paramsFor([sel]),
                      projectId,
                    )}
                    label={a.label}
                    title={a.description}
                    onRun={() => run(a, [sel])}
                    onError={setMsg}
                  />
                ))}
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
              {Object.keys(sel.fields).length > 0 && (
                <dl className="mb-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
                  {Object.entries(sel.fields).map(([k, v]) => (
                    <div key={k} className="contents">
                      <dt className="text-muted-foreground">{k}</dt>
                      <dd className="min-w-0 truncate">
                        {asList(v).join(", ") || "-"}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
              {body == null ? (
                <Empty>{t("view.loadingDoc")}</Empty>
              ) : (
                <MarkdownView src={body} notePath={sel.path} />
              )}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
