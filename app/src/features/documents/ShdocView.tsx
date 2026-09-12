import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, AlertTriangle, Eye, FilePenLine, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { HtmlDocumentView } from "@/features/workbench/api";
import { sandboxShdocHtml } from "./sandbox";
import "./ShdocView.css";

/**
 * Reads and edits the raw source of an shdoc HTML artifact inside the workbench
 * artifact pane. Reading is a fully sandboxed iframe (no scripts, no network);
 * editing is a plain textarea on the HTML source — section-level editing is a
 * later unit. Saving, revision conflicts, and dirty protection are owned by
 * ArtifactEditor and reached through the callbacks below.
 */
export function ShdocView({
  view,
  draft,
  busy,
  dirty,
  onDraftChange,
  onSave,
}: {
  view: HtmlDocumentView;
  /** Current HTML source draft; differs from view.html while dirty. */
  draft: string;
  busy: boolean;
  dirty: boolean;
  onDraftChange: (html: string) => void;
  onSave: () => void;
}) {
  const { t } = useTranslation("workbench");
  const [editing, setEditing] = useState(false);
  const framed = useMemo(() => sandboxShdocHtml(draft), [draft]);
  const shortDigest =
    view.sourceDigest.length > 12
      ? `${view.sourceDigest.slice(0, 12)}…`
      : view.sourceDigest;
  const title = view.title || t("shdoc.untitled");
  return (
    <section className="shdoc" aria-label={title}>
      <header className="shdoc-head">
        <div className="shdoc-head-title">
          <strong title={title}>{title}</strong>
          <small>
            <span>{view.documentId || "—"}</span>
            <span title={view.sourceDigest}>{shortDigest}</span>
            <span>{view.path}</span>
          </small>
        </div>
        <div className="shdoc-modes">
          <button
            type="button"
            className={!editing ? "active" : ""}
            onClick={() => setEditing(false)}
          >
            <Eye size={12} />
            {t("shdoc.readMode")}
          </button>
          <button
            type="button"
            className={editing ? "active" : ""}
            onClick={() => setEditing(true)}
          >
            <FilePenLine size={12} />
            {t("shdoc.editSource")}
          </button>
        </div>
      </header>
      {view.errors.length > 0 && (
        <div className="shdoc-banner shdoc-banner-error" role="alert">
          <strong>
            <AlertCircle size={13} />
            {t("shdoc.restrictedTitle")}
          </strong>
          <p>{t("shdoc.restrictedDescription")}</p>
          <ul>
            {view.errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
        </div>
      )}
      {view.warnings.length > 0 && (
        <div className="shdoc-banner shdoc-banner-warning">
          <strong>
            <AlertTriangle size={13} />
            {t("shdoc.warningsTitle")}
          </strong>
          <ul>
            {view.warnings.map((warning) => (
              <li key={warning}>{warning}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="shdoc-body">
        {editing ? (
          <div className="shdoc-edit">
            <p className="shdoc-edit-hint">{t("shdoc.editHint")}</p>
            <textarea
              className="shdoc-source"
              value={draft}
              spellCheck={false}
              disabled={busy}
              aria-label={t("shdoc.editSource")}
              onChange={(event) => onDraftChange(event.target.value)}
            />
            <div className="shdoc-edit-actions">
              <Button size="xs" onClick={onSave} disabled={busy || !dirty}>
                {busy ? <Loader2 className="wb-spin" /> : t("common.save")}
              </Button>
            </div>
          </div>
        ) : view.safeForDisplay ? (
          <iframe
            className="shdoc-frame"
            title={title}
            sandbox=""
            srcDoc={framed}
          />
        ) : (
          <div className="shdoc-restricted">
            <AlertCircle size={20} />
            {t("shdoc.restrictedTitle")}
          </div>
        )}
      </div>
    </section>
  );
}
