// 선언형 뷰 렌더러. 팩이 `type: "notes"` 로 선언한 화면 전부가 이 한 컴포넌트로 그려진다.
// 호스트는 필드의 뜻을 모르고, 라벨·순서·묶는 기준은 매니페스트가 정한다.
import { useCallback, useEffect, useMemo, useState } from "react";
import { ExternalLink, Play, RefreshCw, Search } from "lucide-react";
import { api } from "@/lib/api";
import { useApp } from "@/lib/store";
import type { NoteRow, PackAction, PackView, QueryResult, ViewColumn } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { cn } from "@/lib/utils";
import { Empty, MarkdownView, PageHeader, fmtDate, statusBadgeVariant } from "./common";

const ALL = "전체";

function asList(v: unknown): string[] {
  if (v == null) return [];
  if (Array.isArray(v)) return v.map((x) => (typeof x === "string" ? x : JSON.stringify(x)));
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
    return text ? <Badge variant={statusBadgeVariant(text)}>{text}</Badge> : <span className="text-muted-foreground">-</span>;
  }
  if (col.type === "check") {
    const on = row.fields[col.field] === true || text === "true";
    return <span className={on ? "text-[var(--success)]" : "text-muted-foreground"}>{on ? "✓" : "-"}</span>;
  }
  if (col.type === "list") {
    const items = col.source ? [text] : asList(row.fields[col.field]);
    if (items.length === 0 || items[0] === "") return <span className="text-muted-foreground">-</span>;
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
  return <span className={cn(!text && "text-muted-foreground")}>{text || "-"}</span>;
}

export default function PackViewPage({ packId, viewId }: { packId: string; viewId: string }) {
  const packs = useApp((s) => s.packs);
  const refreshJobs = useApp((s) => s.refreshJobs);
  const setPage = useApp((s) => s.setPage);

  const pack = packs?.packs.find((p) => p.id === packId) ?? null;
  const view: PackView | null = pack?.views.find((v) => v.id === viewId) ?? null;
  const actions: PackAction[] = useMemo(
    () => (pack && view ? pack.actions.filter((a) => view.actions.includes(a.id)) : []),
    [pack, view],
  );

  const [result, setResult] = useState<QueryResult | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [group, setGroup] = useState(ALL);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<NoteRow | null>(null);
  const [body, setBody] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      setResult(await api.queryPackView(packId, viewId));
    } catch (e) {
      setErr(String(e));
      setResult(null);
    } finally {
      setLoading(false);
    }
  }, [packId, viewId]);

  useEffect(() => {
    setSel(null);
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
    const hay = [r.title, r.rel, ...Object.values(r.fields).flatMap(asList)].join(" ").toLowerCase();
    return hay.includes(needle);
  });

  async function openRow(row: NoteRow) {
    setSel(row);
    setBody(null);
    try {
      const note = await api.readNote(row.path);
      setBody(note.markdown);
    } catch (e) {
      setBody(`> 노트를 읽지 못했습니다: ${String(e)}`);
    }
  }

  async function run(action: PackAction, row: NoteRow | null) {
    setMsg(null);
    const params: Record<string, unknown> = {};
    const id = row ? asList(row.fields.id)[0] : undefined;
    if (id) params.ids = [id];
    const project = row ? asList(row.fields.project)[0] : undefined;
    if (project) params.project = project;
    try {
      await api.runPackAction(packId, action.id, params);
      await refreshJobs();
      setPage("jobs");
    } catch (e) {
      setMsg(String(e));
    }
  }

  if (!pack || !view) {
    return <Empty className="pt-16">화면 정의를 찾지 못했습니다. 확장 탭에서 팩 상태를 확인하세요.</Empty>;
  }

  const columns = view.columns.length > 0 ? view.columns : [
    { field: "", label: "제목", source: "title", type: "text", width: 0 },
    { field: "", label: "수정", source: "mtime", type: "date", width: 110 },
  ];

  return (
    <div className="flex h-full flex-col">
      <PageHeader title={view.label} desc={`${pack.name} 확장 · ${rows.length}건`}>
        {actions.map((a) => (
          <Button key={a.id} size="sm" variant="outline" title={a.description} onClick={() => void run(a, null)}>
            <Play /> {a.label}
          </Button>
        ))}
        <Button size="sm" variant="ghost" onClick={() => void load()}>
          <RefreshCw className={cn("size-3", loading && "animate-spin")} /> 새로고침
        </Button>
      </PageHeader>

      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="검색"
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
                  group === g ? "bg-secondary font-semibold" : "text-muted-foreground hover:bg-accent",
                )}
              >
                {g}
              </button>
            ))}
          </div>
        )}
        {result && result.folders.length > 0 && (
          <span className="ml-auto truncate text-[11px] text-muted-foreground" title={result.folders.join(", ")}>
            {result.folders.length}개 폴더
            {result.truncated && " · 일부만 표시"}
          </span>
        )}
      </div>

      {msg && <div className="border-b bg-destructive/10 px-4 py-1.5 text-xs text-destructive">{msg}</div>}

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-auto">
          {err && <Empty>{err}</Empty>}
          {!err && visible.length === 0 && (
            <Empty className="px-8">
              {rows.length === 0 ? view.empty || "표시할 노트가 없습니다." : "검색 결과가 없습니다."}
            </Empty>
          )}
          {visible.length > 0 && (
            <Table>
              <TableHeader>
                <TableRow>
                  {columns.map((c, i) => (
                    <TableHead key={`${c.field}-${c.source}-${i}`} style={c.width ? { width: c.width } : undefined}>
                      {c.label}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((r) => (
                  <TableRow
                    key={r.path}
                    onClick={() => void openRow(r)}
                    className={cn("cursor-pointer", sel?.path === r.path && "bg-secondary")}
                  >
                    {columns.map((c, i) => (
                      <TableCell key={`${c.field}-${c.source}-${i}`}>
                        <Cell row={r} col={c} />
                      </TableCell>
                    ))}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </div>

        {sel && (
          <aside className="flex w-[26rem] shrink-0 flex-col border-l">
            <div className="flex items-center gap-2 border-b px-3 py-2">
              <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{sel.title}</span>
              <Button size="xs" variant="ghost" onClick={() => void api.openPath(sel.path)} title={sel.path}>
                <ExternalLink className="size-3" /> 열기
              </Button>
            </div>
            {actions.length > 0 && (
              <div className="flex flex-wrap gap-1.5 border-b px-3 py-2">
                {actions.map((a) => (
                  <Button key={a.id} size="xs" variant="outline" onClick={() => void run(a, sel)}>
                    <Play className="size-3" /> {a.label}
                  </Button>
                ))}
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
              {Object.keys(sel.fields).length > 0 && (
                <dl className="mb-3 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[11px]">
                  {Object.entries(sel.fields).map(([k, v]) => (
                    <div key={k} className="contents">
                      <dt className="text-muted-foreground">{k}</dt>
                      <dd className="min-w-0 truncate">{asList(v).join(", ") || "-"}</dd>
                    </div>
                  ))}
                </dl>
              )}
              {body == null ? <Empty>노트를 읽는 중…</Empty> : <MarkdownView src={body} />}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
