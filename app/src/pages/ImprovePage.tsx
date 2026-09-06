import { useEffect, useState } from "react";
import { FileSpreadsheet, Hammer, Inbox, PencilRuler } from "lucide-react";
import { api } from "@/lib/api";
import { useApp } from "@/lib/store";
import { extractSection } from "@/lib/markdown";
import type { IssueNote } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog } from "@/components/ui/dialog";
import { Select } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Empty,
  MarkdownView,
  NOTE_STATUSES,
  PageHeader,
  PriorityBadge,
  StatusBadge,
  WARN_TEXT,
} from "./common";

type RunKind = "design" | "implement" | "excel";

export default function ImprovePage() {
  const config = useApp((s) => s.config);
  const improvements = useApp((s) => s.improvements);
  const inboxCount = useApp((s) => s.inboxCount);
  const refreshImprovements = useApp((s) => s.refreshImprovements);
  const refreshJobs = useApp((s) => s.refreshJobs);

  // null until config arrives, then default to the configured default project
  const [project, setProject] = useState<string | null>(null);
  const [status, setStatus] = useState<string>("전체");
  const [selected, setSelected] = useState<Set<string>>(new Set()); // note paths
  const [detailPath, setDetailPath] = useState<string | null>(null);
  const [detailMd, setDetailMd] = useState<string | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [busy, setBusy] = useState<RunKind | "approve" | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    if (project === null && config) setProject(config.defaultProject || "");
  }, [config, project]);

  const effectiveProject = project ?? "";
  const notes = improvements
    .filter((n) => effectiveProject === "" || n.project === effectiveProject)
    .filter((n) => status === "전체" || n.status === status)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  const selNotes = improvements.filter((n) => selected.has(n.path));
  const selectedProjects = [...new Set(selNotes.map((n) => n.project))];
  const selectedProject = selectedProjects.length === 1 ? selectedProjects[0] : "";
  // approve opens implementation permission; re-runs of in-flight work stay allowed
  const canExecute =
    selNotes.length > 0 &&
    selNotes.every((n) =>
      n.approve ||
      ["진행중", "부분완료", "구현중", "부분구현"].includes(n.status),
    );

  const detail = improvements.find((n) => n.path === detailPath) ?? null;
  const executionTargets = detailMd
    ? extractSection(detailMd, "실행 대상") || extractSection(detailMd, "변경 대상")
    : "";
  const canApprove = detail != null && !detail.approve && detail.status === "승인대기";

  function toggleRow(path: string, on: boolean) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(path);
      else next.delete(path);
      return next;
    });
  }

  async function openDetail(n: IssueNote) {
    setDetailPath(n.path);
    setDetailMd(null);
    setDetailLoading(true);
    try {
      const v = await api.readNote(n.path);
      setDetailMd(v.markdown);
    } catch (e) {
      setDetailMd(`> 노트를 읽지 못했습니다: ${String(e)}`);
    } finally {
      setDetailLoading(false);
    }
  }

  async function approve() {
    if (!detailPath) return;
    setBusy("approve");
    try {
      await api.approveIssue(detailPath);
      await refreshImprovements();
      const v = await api.readNote(detailPath);
      setDetailMd(v.markdown);
      setMsg("이슈를 승인했습니다.");
    } catch (e) {
      setMsg(`승인 실패: ${String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  async function run(kind: RunKind) {
    if (kind !== "excel" && selectedProjects.length !== 1) {
      setMsg("설계·실행할 이슈는 한 사업에서만 선택하세요.");
      return;
    }
    setBusy(kind);
    setMsg(null);
    try {
      await api.enqueueJob({
        kind,
        project: kind === "excel" ? undefined : selectedProject,
        ids: kind === "excel" ? undefined : selNotes.map((n) => n.id),
      });
      await refreshJobs();
      setMsg(
        kind === "design"
          ? "설계 작업을 큐에 등록했습니다."
          : kind === "implement"
            ? "실행 작업을 큐에 등록했습니다."
            : "엑셀 작업을 큐에 등록했습니다.",
      );
      setSelected(new Set());
    } catch (e) {
      setMsg(`큐 등록 실패: ${String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div>
      <PageHeader title="이슈" desc="이슈의 설계·승인·실행 기록을 관리합니다.">
        <Badge variant="warning" className={`gap-1 ${WARN_TEXT}`}>
          <Inbox className="size-3" /> 인박스 {inboxCount}
        </Badge>
        <Select
          className="w-40"
          value={effectiveProject}
          onChange={(e) => setProject(e.target.value)}
          aria-label="프로젝트"
        >
          <option value="">전체 프로젝트</option>
          {[...new Set([...improvements.map((n) => n.project), ...(config?.projects.map((p) => p.name) ?? [])])]
            .sort()
            .map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
        </Select>
        <Select
          className="w-32"
          value={status}
          onChange={(e) => setStatus(e.target.value)}
          aria-label="상태 필터"
        >
          {["전체", ...NOTE_STATUSES].map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
        <Button
          size="sm"
          disabled={selNotes.length === 0 || selectedProjects.length !== 1 || busy !== null}
          onClick={() => void run("design")}
          title="선택한 이슈의 설계안을 작성합니다."
        >
          <PencilRuler /> 설계 실행{selNotes.length > 0 ? ` (${selNotes.length})` : ""}
        </Button>
        <Button
          size="sm"
          disabled={selNotes.length === 0 || selectedProjects.length !== 1 || !canExecute || busy !== null}
          onClick={() => void run("implement")}
          title={
            canExecute
              ? "선택한 이슈를 실행하고 결과를 기록합니다."
              : "승인되지 않은 이슈가 포함되어 있습니다. 상세에서 승인 후 실행하세요."
          }
        >
          <Hammer /> 실행
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy !== null}
          onClick={() => void run("excel")}
          title="이슈 기반 엑셀 보고서를 생성합니다."
        >
          <FileSpreadsheet /> 엑셀
        </Button>
      </PageHeader>

      {msg && <div className="px-4 pt-2 text-xs text-muted-foreground">{msg}</div>}

      <div className="p-4">
        {notes.length === 0 ? (
          <Empty>조건에 맞는 이슈가 없습니다.</Empty>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead className="w-24">ID</TableHead>
                <TableHead>제목</TableHead>
                <TableHead className="w-28">마일스톤</TableHead>
                <TableHead className="w-28">실행 유형</TableHead>
                <TableHead className="w-20">중요도</TableHead>
                <TableHead className="w-24">상태</TableHead>
                <TableHead className="w-20">승인</TableHead>
                <TableHead className="w-24">의존</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {notes.map((n) => {
                const dep =
                  `전 ${n.dependsOn.length}`.trim() + ` / 후 ${n.dependents.length}`.trim();
                return (
                  <TableRow
                    key={n.path}
                    className="cursor-pointer"
                    onClick={() => void openDetail(n)}
                  >
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <Checkbox
                        checked={selected.has(n.path)}
                        onChange={(e) => toggleRow(n.path, e.target.checked)}
                        aria-label={`${n.id} 선택`}
                      />
                    </TableCell>
                    <TableCell className="font-mono text-xs">{n.id || "-"}</TableCell>
                    <TableCell>
                      <div className="max-w-[280px] truncate text-[13px]" title={n.title}>
                        {n.title}
                      </div>
                      {n.legacy && (
                        <div className="text-[11px] text-muted-foreground">레거시 개선 노트</div>
                      )}
                    </TableCell>
                    <TableCell className="truncate text-xs text-muted-foreground" title={n.milestone}>
                      {n.milestone || "-"}
                    </TableCell>
                    <TableCell className="truncate text-xs text-muted-foreground" title={n.executionType}>
                      {n.executionType || n.issueType || n.category || "-"}
                    </TableCell>
                    <TableCell>
                      <PriorityBadge p={n.priority} />
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={n.status} />
                    </TableCell>
                    <TableCell>
                      {n.approve ? (
                        <Badge variant="success" title={n.approved || undefined}>
                          승인
                        </Badge>
                      ) : (
                        <span className="text-xs text-muted-foreground">대기</span>
                      )}
                    </TableCell>
                    <TableCell
                      className="text-[11px] text-muted-foreground"
                      title={`선행: ${n.dependsOn.join(", ") || "없음"}\n후행: ${n.dependents.join(", ") || "없음"}`}
                    >
                      {n.dependsOn.length + n.dependents.length > 0 ? dep : "-"}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </div>

      <Dialog
        open={detailPath != null}
        onClose={() => setDetailPath(null)}
        wide
        title={detail ? `${detail.id || "무제"} ${detail.title}` : "불러오는 중…"}
      >
        {detail && (
          <div className="mb-3 flex flex-wrap items-center gap-1.5">
            <Badge variant="secondary">{detail.project}</Badge>
            {detail.legacy && <Badge variant="warning">레거시</Badge>}
            <StatusBadge status={detail.status} />
            <PriorityBadge p={detail.priority} />
            {detail.milestone && <Badge variant="outline">{detail.milestone}</Badge>}
            {detail.executionType && <Badge variant="outline">{detail.executionType}</Badge>}
            {detail.issueType && <Badge variant="outline">{detail.issueType}</Badge>}
            {detail.url && <Badge variant="outline">{detail.url}</Badge>}
            {detail.githubNumber && <Badge variant="outline">GitHub #{detail.githubNumber}</Badge>}
            <span className="text-[11px] text-muted-foreground">
              검증 {detail.verified || "미확인"}
              {detail.commits.length > 0 ? ` · 커밋 ${detail.commits.length}건` : ""}
            </span>
          </div>
        )}
        {canApprove && (
          <div className="mb-3 rounded-lg border bg-muted/40 p-3">
            <div className="text-xs font-semibold">실행 대상</div>
            <div className="mt-1">
              {executionTargets ? (
                <MarkdownView src={executionTargets} />
              ) : (
                <div className={`text-xs ${WARN_TEXT}`}>
                  `### 실행 대상` 절이 비어 있습니다 — 승인해도 실행되지 않습니다.
                </div>
              )}
            </div>
            <div className="mt-2 flex items-center gap-2">
              <Button size="sm" variant="success" disabled={busy !== null} onClick={() => void approve()}>
                승인
              </Button>
              <span className="text-[11px] text-muted-foreground">
                승인하면 approve·approved·status 3개 키만 갱신되고 본문은 보존됩니다.
              </span>
            </div>
          </div>
        )}
        {detailLoading ? (
          <Empty>노트를 불러오는 중…</Empty>
        ) : detailMd != null ? (
          <MarkdownView src={detailMd} className="selectable" />
        ) : null}
      </Dialog>
    </div>
  );
}
