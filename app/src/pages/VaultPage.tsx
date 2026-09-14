import { useMemo, useState } from "react";
import { AtomicCodeMirrorEditor } from "@atomic-editor/editor";
import "@atomic-editor/editor/styles.css";
import { ListChecks, Pencil, RefreshCw, SquareTerminal, TriangleAlert } from "lucide-react";
import { useTranslation } from "react-i18next";
import i18n from "@/i18n";
import { api } from "@/lib/api";
import { useApp } from "@/lib/store";
import { jobRequestKey } from "@/lib/jobs";
import { vaultImageSources } from "@/features/workbench/embedded-images";
import { RunButton } from "@/components/RunButton";
import type { AuditIssue } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Empty, MarkdownView, PageHeader } from "./common";

const SEV: Record<
  AuditIssue["severity"],
  { label: string; variant: "destructive" | "warning" | "secondary" }
> = {
  get error() {
    return {
      label: i18n.t("settings:vault.sev.error"),
      variant: "destructive" as const,
    };
  },
  get warn() {
    return {
      label: i18n.t("settings:vault.sev.warn"),
      variant: "warning" as const,
    };
  },
  get info() {
    return {
      label: i18n.t("settings:vault.sev.info"),
      variant: "secondary" as const,
    };
  },
};

// Strips the vault-path prefix off the unpromoted list's absolute path, making it vault-relative.
// Separators are normalized to slashes; returns null when the path doesn't match the vault path.
function vaultRel(listPath: string, vaultPath: string): string | null {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");
  const v = norm(vaultPath);
  const f = norm(listPath);
  if (v.length === 0 || !f.startsWith(`${v}/`)) return null;
  return f.slice(v.length + 1);
}

type NoteEdit = {
  path: string;
  /** Pristine raw text the draft started from. */
  source: string;
  /** Digest of `source` on disk; sent back with every save attempt. */
  digest: string;
  draft: string;
  /** Bumped on every (re)load so the editor remounts with fresh content. */
  revision: number;
  saving: boolean;
};

// Reads a note's raw source and builds the edit state. Relative paths are
// resolved against the vault: the source commands canonicalize through the
// vault guard and so require absolute paths (openList stores relative ones).
async function loadNoteEdit(path: string, vaultPath: string, revision: number): Promise<NoteEdit> {
  const abs = path.startsWith("/") ? path : `${vaultPath}/${path}`;
  const src = await api.readVaultNoteSource(abs);
  return { path: abs, source: src.source, digest: src.digest, draft: src.source, revision, saving: false };
}

// Mirrors vault::split_frontmatter: the preview keeps showing the body after
// the closing `---`/`...` fence, not the raw frontmatter the editor holds.
function bodyAfterFrontmatter(source: string): string {
  const text = source.startsWith("\uFEFF") ? source.slice(1) : source;
  const lines = text.split("\n");
  if (lines[0]?.trimEnd() !== "---") return text;
  for (let i = 1; i < lines.length; i++) {
    const trimmed = lines[i].trimEnd();
    if (trimmed === "---" || trimmed === "...") {
      return lines.slice(i + 1).join("\n");
    }
  }
  return text;
}

export default function VaultPage() {
  const { t } = useTranslation("settings");
  const audit = useApp((s) => s.audit);
  const unpromoted = useApp((s) => s.unpromoted);
  const refreshAudit = useApp((s) => s.refreshAudit);
  const refreshJobs = useApp((s) => s.refreshJobs);
  const setPage = useApp((s) => s.setPage);
  const vaultPath = useApp((s) => s.config?.vaultPath ?? "");
  const [scanning, setScanning] = useState(false);
  const [promoting, setPromoting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<{
    title: string;
    md: string;
    path: string;
  } | null>(null);
  const [edit, setEdit] = useState<NoteEdit | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const imageExtensions = useMemo(() => (edit ? [vaultImageSources(edit.path)] : []), [edit?.path]);

  async function scan() {
    setScanning(true);
    try {
      await refreshAudit();
    } finally {
      setScanning(false);
    }
  }

  async function openPath(path: string) {
    try {
      const v = await api.readNote(path);
      const title = path.split("/").pop()?.replace(/\.md$/, "") ?? path;
      setView({ title, md: v.markdown, path });
    } catch {
      setView(null);
    }
  }

  // Unpromoted lists have no frontmatter, so read_note rejects them; open them with the vault-note read.
  async function openList(rel: string) {
    try {
      const v = await api.readVaultNote(rel);
      setView({ title: v.title, md: v.markdown, path: rel });
    } catch {
      setView(null);
    }
  }

  async function promote() {
    setPromoting(true);
    setError(null);
    try {
      await api.enqueueJob({ kind: "promote" });
      await refreshJobs();
      setPage("jobs");
    } catch (e) {
      setError(String(e));
    } finally {
      setPromoting(false);
    }
  }

  async function startEdit() {
    if (!view) return;
    setEditError(null);
    try {
      setEdit(await loadNoteEdit(view.path, vaultPath, 0));
    } catch (e) {
      setEditError(String(e));
    }
  }

  function cancelEdit() {
    setEdit(null);
    setEditError(null);
  }

  // Conflict resolution: drop the draft and continue from the current bytes.
  async function reloadEdit() {
    if (!edit || edit.saving) return;
    try {
      setEdit(await loadNoteEdit(edit.path, vaultPath, edit.revision + 1));
      setEditError(null);
    } catch (e) {
      setEditError(String(e));
    }
  }

  // Saves the draft at `digest`; true when it is now on disk. Overwrites pass
  // a freshly read digest — the caller's explicit decision to replace the
  // note's current bytes.
  async function persistDraft(digest: string): Promise<boolean> {
    if (!edit) return false;
    try {
      await api.saveVaultNoteSource(edit.path, digest, edit.draft);
      setView((v) =>
        v && (v.path.startsWith("/") ? v.path : `${vaultPath}/${v.path}`) === edit.path
          ? { ...v, md: bodyAfterFrontmatter(edit.draft) }
          : v,
      );
      setEdit(null);
      setEditError(null);
      return true;
    } catch (e) {
      setEdit((current) => (current ? { ...current, saving: false } : current));
      setEditError(String(e));
      return false;
    }
  }

  async function saveEdit() {
    if (!edit || edit.saving || edit.draft === edit.source) return;
    setEdit((current) => (current ? { ...current, saving: true } : current));
    setEditError(null);
    await persistDraft(edit.digest);
  }

  async function overwriteEdit() {
    if (!edit || edit.saving) return;
    setEdit((current) => (current ? { ...current, saving: true } : current));
    setEditError(null);
    try {
      const latest = await api.readVaultNoteSource(edit.path);
      if (await persistDraft(latest.digest)) return;
    } catch (e) {
      setEdit((current) => (current ? { ...current, saving: false } : current));
      setEditError(String(e));
    }
  }

  return (
    <div>
      <PageHeader title={t("vault.title")}>
        <Button size="sm" variant="outline" disabled={scanning} onClick={() => void scan()}>
          <RefreshCw /> {t("actions.rescan")}
        </Button>
        <RunButton
          size="sm"
          variant="default"
          icon={<SquareTerminal />}
          jobKey={jobRequestKey({ kind: "promote" })}
          label={t("vault.promoteRun")}
          disabled={promoting}
          onRun={promote}
          onError={setError}
        />
      </PageHeader>

      {error && (
        <p className="mx-4 mb-1 flex items-center gap-1.5 text-xs text-destructive">
          <TriangleAlert className="size-3.5 shrink-0" />{" "}
          {t("vault.promoteFailed", { error })}
        </p>
      )}

      <div className="grid gap-3 p-4 lg:grid-cols-2">
        <div className="space-y-3">
          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-1">
              <CardTitle className="text-[13px]">{t("vault.quickScan")}</CardTitle>
              {audit && (
                <span className="text-[11px] text-muted-foreground">
                  {t("vault.issueCount", { count: audit.issues.length })}
                </span>
              )}
            </CardHeader>
            <CardContent>
              {audit == null ? (
                <Empty>{t("vault.unchecked")}</Empty>
              ) : audit.issues.length === 0 ? (
                <Empty>{t("vault.noIssues")}</Empty>
              ) : (
                <ul className="space-y-1.5">
                  {audit.issues.map((iss, i) => (
                    <li key={i} className="rounded-md border px-2.5 py-1.5 text-xs">
                      <div className="flex items-center gap-2">
                        <Badge variant={SEV[iss.severity].variant}>{SEV[iss.severity].label}</Badge>
                        <span className="min-w-0 flex-1">{iss.message}</span>
                      </div>
                      {iss.path.length > 0 && (
                        <button onClick={() => void openPath(iss.path)} className="mt-0.5 block w-full truncate text-left text-[11px] text-muted-foreground hover:underline" title={iss.path}>
                          {iss.path}
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="flex-row items-center justify-between space-y-0 pb-1">
              <CardTitle className="text-[13px]">
                <ListChecks className="mr-1 inline size-3.5" />{" "}
                {t("vault.unpromotedTitle", { count: unpromoted.length })}
              </CardTitle>
            </CardHeader>
            <CardContent>
              {unpromoted.length === 0 ? (
                <Empty>{t("vault.emptyUnpromoted")}</Empty>
              ) : (
                <ul className="space-y-1">
                  {unpromoted.map((it, i) => {
                    const rel = vaultRel(it.listPath, vaultPath);
                    return (
                      <li key={i} className="flex items-start gap-2 text-xs">
                        <Badge variant="outline" className="shrink-0">{it.project}</Badge>
                        <span className="min-w-0 flex-1">{it.text}</span>
                        {rel ? (
                          <button onClick={() => void openList(rel)} className="shrink-0 text-[11px] text-muted-foreground hover:underline">
                            {t("vault.openList")}
                          </button>
                        ) : (
                          <span
                            className="shrink-0 text-[11px] text-muted-foreground"
                            title={t("vault.mismatchHint")}
                          >
                            {t("vault.mismatch")}
                          </span>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}
            </CardContent>
          </Card>
        </div>

        <Card className="self-start">
          <CardHeader className="flex-row items-center justify-between space-y-0 pb-1">
            <CardTitle className="text-[13px]">
              {view ? view.title : t("vault.preview")}
            </CardTitle>
            {view && !edit && (
              <Button size="sm" variant="outline" onClick={() => void startEdit()}>
                <Pencil /> {t("vault.edit", { defaultValue: "편집" })}
              </Button>
            )}
          </CardHeader>
          <CardContent>
            {edit ? (
              <div className="space-y-2">
                {editError && !editError.includes("external-change-conflict") && (
                  <p className="flex items-center gap-1.5 text-xs text-destructive">
                    <TriangleAlert className="size-3.5 shrink-0" /> {editError}
                  </p>
                )}
                {editError && editError.includes("external-change-conflict") && (
                  <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2.5">
                    <p className="flex items-center gap-1.5 text-xs text-destructive">
                      <TriangleAlert className="size-3.5 shrink-0" />{" "}
                      {t("vault.editConflict", { defaultValue: "노트가 외부에서 변경됐다. 어떻게 할까?" })}
                    </p>
                    <div className="mt-2 flex gap-2">
                      <Button size="sm" variant="outline" disabled={edit.saving} onClick={() => void reloadEdit()}>
                        {t("vault.editReload", { defaultValue: "다시 불러오기" })}
                      </Button>
                      <Button size="sm" variant="destructive" disabled={edit.saving} onClick={() => void overwriteEdit()}>
                        {t("vault.editOverwrite", { defaultValue: "덮어쓰기" })}
                      </Button>
                      <Button size="sm" variant="ghost" onClick={() => setEditError(null)}>
                        {t("vault.editCancel", { defaultValue: "취소" })}
                      </Button>
                    </div>
                  </div>
                )}
                <div className="max-h-[55vh] min-h-[240px] overflow-auto rounded-md border">
                  <AtomicCodeMirrorEditor
                    documentId={`vault-note:${edit.path}:${edit.revision}`}
                    markdownSource={edit.draft}
                    extensions={imageExtensions}
                    readOnly={edit.saving}
                    onMarkdownChange={(draft) => setEdit((current) => (current ? { ...current, draft } : current))}
                  />
                </div>
                <div className="flex justify-end gap-2">
                  <Button size="sm" variant="outline" disabled={edit.saving} onClick={cancelEdit}>
                    {t("vault.editCancel", { defaultValue: "취소" })}
                  </Button>
                  <Button size="sm" disabled={edit.saving || edit.draft === edit.source} onClick={() => void saveEdit()}>
                    {t("vault.editSave", { defaultValue: "저장" })}
                  </Button>
                </div>
              </div>
            ) : (
              <div className="space-y-2">
                {editError && (
                  <p className="flex items-center gap-1.5 text-xs text-destructive">
                    <TriangleAlert className="size-3.5 shrink-0" /> {editError}
                  </p>
                )}
                {view ? (
                  <MarkdownView src={view.md} notePath={view.path} className="selectable" />
                ) : (
                  <Empty>{t("vault.previewEmpty")}</Empty>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
