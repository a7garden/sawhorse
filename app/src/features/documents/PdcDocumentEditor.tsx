import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  ArrowLeft,
  Eye,
  EyeOff,
  FolderInput,
  ImagePlus,
  Link2,
  Loader2,
  RotateCcw,
  Save,
  Star,
  Trash2,
} from "lucide-react";
import { AtomicCodeMirrorEditor } from "@atomic-editor/editor";
import "@atomic-editor/editor/styles.css";
import { pdcApi } from "@/lib/api";
import type {
  PdcDocumentSummary,
  PdcDocumentView,
  PdcSaveOutcome,
  PdcSavePatch,
  PdcScan,
} from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { sandboxPdcHtml } from "./sandboxPdc";

/**
 * Reads one PDC 정문서 and edits its envelope fields plus body. The edit target is
 * the extracted `body` only — the raw `source` is never rewritten. Saving diffs the
 * buffers against the loaded snapshot so the patch carries changed fields only, and
 * resolves the digest-expected outcome triage (saved / unchanged / conflict) the
 * backend writer guarantees.
 */

const PREVIEW_DEBOUNCE_MS = 400;

type Transport = "markdown" | "html";

function transportOf(view: PdcDocumentView): Transport {
  // 편집 분기에 도달하는 건 v2 정문서뿐이다 — HTML이 아니면 Markdown이다.
  return view.envelope?.bodyProfile.startsWith("pdc-html") ? "html" : "markdown";
}

/** Escapes text destined for a double-quoted HTML attribute or plain element text. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function parseTags(text: string): string[] {
  return text
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function formatStamp(value: string | null | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

/** Inserts before the closing body tag so fragments stay inside the document. */
function insertBeforeBodyClose(html: string, fragment: string): string {
  const close = html.toLowerCase().lastIndexOf("</body>");
  if (close === -1) return `${html.replace(/\s*$/, "")}\n${fragment}\n`;
  return `${html.slice(0, close)}${fragment}\n${html.slice(close)}`;
}

export function PdcDocumentEditor({
  path,
  scan,
  onBack,
  onChanged,
}: {
  path: string;
  scan: PdcScan | null;
  onBack: () => void;
  onChanged: () => void;
}) {
  const { t } = useTranslation("documents");
  const [view, setView] = useState<PdcDocumentView | null>(null);
  const [loadError, setLoadError] = useState("");
  // Edit buffers — the loaded snapshot in `view` stays the dirty-check baseline.
  const [title, setTitle] = useState("");
  const [tagsText, setTagsText] = useState("");
  const [favorite, setFavorite] = useState(false);
  const [body, setBody] = useState("");
  // Bumped whenever the body is replaced programmatically or reloaded, so the
  // CodeMirror editor (whose doc is source of truth after mount) remounts.
  const [epoch, setEpoch] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [conflict, setConflict] = useState<{
    currentDigest: string;
    currentUpdated: string | null;
  } | null>(null);
  const [previewOn, setPreviewOn] = useState(true);
  const [previewHtml, setPreviewHtml] = useState("");
  const [previewBusy, setPreviewBusy] = useState(false);
  const [previewError, setPreviewError] = useState("");
  const [moveOpen, setMoveOpen] = useState(false);
  const [movePath, setMovePath] = useState(path);
  const [moveError, setMoveError] = useState("");
  const [linkPick, setLinkPick] = useState("");
  const assetInput = useRef<HTMLInputElement>(null);
  const previewRun = useRef(0);

  const load = (target: string, mode: "initial" | "reload") => {
    setBusy(true);
    setError("");
    pdcApi
      .read(target)
      .then((fresh) => {
        setView(fresh);
        setTitle(fresh.envelope?.title ?? "");
        setTagsText((fresh.envelope?.tags ?? []).join(", "));
        setFavorite(fresh.envelope?.favorite ?? false);
        setBody(fresh.body);
        setEpoch((current) => current + 1);
        setNotice(mode === "reload" ? t("reloaded") : "");
      })
      .catch((err) => setLoadError(String(err)))
      .finally(() => setBusy(false));
  };

  useEffect(() => {
    setView(null);
    setLoadError("");
    setConflict(null);
    setNotice("");
    setPreviewHtml("");
    setMoveOpen(false);
    setMovePath(path);
    load(path, "initial");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  const editable = !!view?.editable && !!view.envelope;
  const transport: Transport = view ? transportOf(view) : "markdown";

  // Debounced preview: markdown goes through the backend renderer, html is the body itself.
  useEffect(() => {
    if (!previewOn || !editable) return;
    const timer = window.setTimeout(() => {
      const run = ++previewRun.current;
      setPreviewBusy(true);
      setPreviewError("");
      const render =
        transport === "html"
          ? Promise.resolve(sandboxPdcHtml(body, undefined))
          : transport === "markdown"
            ? pdcApi
                .previewMarkdown(body)
                .then((html) => sandboxPdcHtml(html, undefined))
            : pdcApi
                .previewDjot(body)
                .then((html) => sandboxPdcHtml(html, undefined));
      render
        .then((html) => {
          if (previewRun.current === run) setPreviewHtml(html);
        })
        .catch((err) => {
          if (previewRun.current === run) {
            setPreviewHtml("");
            setPreviewError(String(err));
          }
        })
        .finally(() => {
          if (previewRun.current === run) setPreviewBusy(false);
        });
    }, PREVIEW_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [body, transport, previewOn, editable]);

  const tags = parseTags(tagsText);
  const patch: PdcSavePatch = {};
  if (view?.envelope) {
    if (body !== view.body) patch.body = body;
    if (title !== view.envelope.title) patch.title = title;
    if (tags.join(",") !== view.envelope.tags.join(",")) patch.tags = tags;
    if (favorite !== view.envelope.favorite) patch.favorite = favorite;
  }
  const patchEmpty = Object.keys(patch).length === 0;

  const applyOutcome = (outcome: PdcSaveOutcome) => {
    if (outcome.status === "saved") {
      setView(
        (current) =>
          current && {
            ...current,
            body,
            digest: outcome.digest,
            envelope:
              current.envelope && {
                ...current.envelope,
                title,
                tags,
                favorite,
                updated: outcome.updated,
              },
          },
      );
      setNotice(t("saved"));
      setConflict(null);
      onChanged();
    } else if (outcome.status === "unchanged") {
      setNotice(t("unchanged"));
      setConflict(null);
    } else {
      setConflict(outcome);
      setNotice("");
    }
  };

  const commit = (expectedDigest: string) => {
    if (!view || patchEmpty) return;
    setBusy(true);
    setError("");
    pdcApi
      .save(view.path, expectedDigest, patch)
      .then(applyOutcome)
      .catch((err) => setError(String(err)))
      .finally(() => setBusy(false));
  };

  const setDeleted = (deleted: boolean) => {
    if (!view) return;
    setBusy(true);
    setError("");
    pdcApi
      .save(view.path, view.digest, { deleted })
      .then((outcome) => {
        if (outcome.status === "saved") {
          onChanged();
          onBack();
        } else if (outcome.status === "conflict") {
          setConflict(outcome);
        } else {
          setNotice(t(deleted ? "deletedNotice" : "restoredNotice"));
        }
      })
      .catch((err) => setError(String(err)))
      .finally(() => setBusy(false));
  };

  const move = () => {
    if (!view) return;
    const to = movePath.trim();
    if (!to || to === view.path) return;
    setBusy(true);
    setMoveError("");
    pdcApi
      .move(view.path, to, view.digest)
      .then(() => {
        setMoveOpen(false);
        onChanged();
        onBack();
      })
      .catch((err) => setMoveError(String(err)))
      .finally(() => setBusy(false));
  };

  /** Appends at the end of the body (CodeMirror owns the caret, so no insertion point). */
  const appendBody = (fragment: string) => {
    setBody((current) => `${current.replace(/\s*$/, "")}\n\n${fragment}\n`);
    setEpoch((current) => current + 1);
  };

  const attachImage = (file: File | undefined) => {
    if (!file || !view) return;
    setBusy(true);
    setError("");
    file
      .arrayBuffer()
      .then((buffer) =>
        pdcApi.addAsset(new Uint8Array(buffer), file.name, file.type || undefined),
      )
      .then((stored) => {
        const mediaType = stored.mediaType ?? file.type ?? "";
        if (transport === "markdown") {
          appendBody(`![${file.name}](${stored.uri})`);
        } else {
          const fragment = `<img src="${stored.uri}" alt="${escapeHtml(file.name)}" data-pdc-filename="${escapeHtml(file.name)}"${mediaType ? ` data-pdc-media-type="${escapeHtml(mediaType)}"` : ""}>`;
          setBody((current) => insertBeforeBodyClose(current, fragment));
        }
      })
      .catch((err) => setError(String(err)))
      .finally(() => setBusy(false));
  };

  const linkable = (scan?.documents ?? []).filter(
    (doc) => doc.id && !doc.deleted && doc.path !== path,
  );
  const insertLink = (doc: PdcDocumentSummary) => {
    if (!doc.id) return;
    if (transport === "markdown") {
      appendBody(`[${doc.displayTitle}](pdc://document/${doc.id})`);
    } else {
      const fragment = `<a href="pdc://document/${doc.id}">${escapeHtml(doc.displayTitle)}</a>`;
      setBody((current) => insertBeforeBodyClose(current, fragment));
    }
  };

  if (loadError) {
    return (
      <div className="pdc-page">
        <div className="pdc-empty is-error" role="alert">
          <AlertTriangle size={26} />
          <h3>{t("errorTitle")}</h3>
          <p>{loadError}</p>
          <Button variant="outline" onClick={onBack}>
            <ArrowLeft size={14} />
            {t("back")}
          </Button>
        </div>
      </div>
    );
  }

  if (!view) {
    return (
      <div className="pdc-page">
        <p role="status" className="pdc-empty">
          <Loader2 className="animate-spin" />
        </p>
      </div>
    );
  }

  const profile = view.envelope?.bodyProfile ?? "";
  const badge = profile
    ? profile.replace(/^pdc-/, "").replace(/\/1$/, "")
    : t("diagnostics");

  return (
    <div className="pdc-page">
      <div className="pdc-editor">
        <header className="pdc-editor-head">
          <Button variant="ghost" size="icon" aria-label={t("back")} onClick={onBack}>
            <ArrowLeft size={16} />
          </Button>
          <h2>{view.envelope?.title || path}</h2>
          <span className="pdc-badge">{badge}</span>
          {!view.editable && (
            <span className="pdc-badge is-readonly">{t("legacyReadOnly")}</span>
          )}
          <div className="pdc-editor-head-meta">
            {notice && <span className="pdc-notice">{notice}</span>}
            <time>{formatStamp(view.envelope?.updated)}</time>
          </div>
        </header>

        {error && (
          <p className="pdc-error" role="alert">
            {error}
          </p>
        )}

        {!view.editable || !view.envelope ? (
          <>
            <div className="pdc-banner" role="alert">
              <strong>
                <AlertTriangle size={13} />
                {t("diagnostics")} · {view.code}
              </strong>
              {view.message && <span>{view.message}</span>}
              <span>{t("legacyReadOnly")}</span>
            </div>
            <div className="pdc-pane">
              <div className="pdc-pane-head">
                <span>{t("source")}</span>
                <small>{path}</small>
              </div>
              <pre className="pdc-source-readonly">{view.source}</pre>
            </div>
          </>
        ) : (
          <>
            <div className="pdc-meta" role="group" aria-label={t("metadata")}>
              <label>
                <span>{t("titleLabel")}</span>
                <Input
                  value={title}
                  disabled={busy}
                  aria-label={t("titleLabel")}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </label>
              <label>
                <span>{t("tagsLabel")}</span>
                <Input
                  value={tagsText}
                  disabled={busy}
                  placeholder={t("tagsHint")}
                  aria-label={t("tagsLabel")}
                  onChange={(event) => setTagsText(event.target.value)}
                />
              </label>
              <label className="pdc-meta-favorite">
                <Checkbox
                  checked={favorite}
                  disabled={busy}
                  aria-label={t("favorite")}
                  onChange={(event) => setFavorite(event.target.checked)}
                />
                <Star size={13} className={favorite ? "is-fav" : "is-dim"} />
                <span>{t("favorite")}</span>
              </label>
              <div className="pdc-meta-facts">
                <span>id: {view.envelope.id}</span>
                <span>
                  {t("created")}: {formatStamp(view.envelope.created)}
                </span>
                <span>
                  {t("updated")}: {formatStamp(view.envelope.updated)}
                </span>
                <span>{path}</span>
              </div>
            </div>

            <div className="pdc-toolbar">
              <Button
                size="sm"
                variant="outline"
                aria-pressed={previewOn}
                onClick={() => setPreviewOn((on) => !on)}
              >
                {previewOn ? <EyeOff size={14} /> : <Eye size={14} />}
                {t("preview")}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => assetInput.current?.click()}
              >
                <ImagePlus size={14} />
                {t("attachImage")}
              </Button>
              <input
                ref={assetInput}
                type="file"
                accept="image/*"
                hidden
                onChange={(event) => {
                  attachImage(event.target.files?.[0]);
                  event.target.value = "";
                }}
              />
              {linkable.length > 0 && (
                <Select
                  size="sm"
                  className="pdc-toolbar-select"
                  aria-label={t("insertLink")}
                  placeholder={t("insertLinkPick")}
                  value={linkPick}
                  options={linkable.map((doc) => ({
                    value: doc.path,
                    label: doc.displayTitle,
                  }))}
                  onChange={(value) => {
                    const doc = linkable.find((item) => item.path === value);
                    if (doc) insertLink(doc);
                    setLinkPick("");
                  }}
                />
              )}
              <div className="pdc-toolbar-spacer" />
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => setMoveOpen(true)}>
                <FolderInput size={14} />
                {t("rename")}
              </Button>
              {view.envelope.deleted ? (
                <Button size="sm" variant="outline" disabled={busy} onClick={() => setDeleted(false)}>
                  <RotateCcw size={14} />
                  {t("restore")}
                </Button>
              ) : (
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => setDeleted(true)}>
                  <Trash2 size={14} />
                  {t("delete")}
                </Button>
              )}
              <Button
                size="sm"
                disabled={busy || patchEmpty}
                onClick={() => commit(view.digest)}
              >
                {busy ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                {t("save")}
              </Button>
            </div>

            <div className={`pdc-work${previewOn ? " is-split" : ""}`}>
              <div className="pdc-pane">
                <div className="pdc-pane-head">
                  <span>{t("body")}</span>
                  {previewBusy && <Loader2 size={12} className="animate-spin" />}
                </div>
                  {transport === "markdown" ? (
                  <div className="pdc-cm">
                    <AtomicCodeMirrorEditor
                      documentId={`${view.path}#${epoch}`}
                      markdownSource={body}
                      readOnly={busy}
                      onMarkdownChange={setBody}
                    />
                  </div>
                ) : (
                  <textarea
                    className="pdc-source"
                    value={body}
                    spellCheck={false}
                    disabled={busy}
                    aria-label={t("body")}
                    onChange={(event) => setBody(event.target.value)}
                  />
                )}
              </div>
              {previewOn && (
                <div className="pdc-pane">
                  <div className="pdc-pane-head">
                    <span>{t("preview")}</span>
                  </div>
                  {previewError ? (
                    <p className="pdc-preview-error" role="alert">
                      {previewError}
                    </p>
                  ) : (
                    <iframe
                      className="pdc-frame"
                      title={t("preview")}
                      sandbox=""
                      srcDoc={previewHtml}
                    />
                  )}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      <Dialog
        open={moveOpen}
        title={t("rename")}
        onClose={busy ? undefined : () => setMoveOpen(false)}
      >
        <label className="pdc-dialog-fields">
          <span>{t("movePrompt")}</span>
          <Input
            value={movePath}
            disabled={busy}
            aria-label={t("movePrompt")}
            onChange={(event) => setMovePath(event.target.value)}
          />
        </label>
        <p className="mt-2 text-xs text-muted-foreground">{t("moveHint")}</p>
        {moveError && (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {moveError}
          </p>
        )}
        <div className="pdc-dialog-actions">
          <Button variant="ghost" disabled={busy} onClick={() => setMoveOpen(false)}>
            {t("cancel")}
          </Button>
          <Button disabled={busy || movePath.trim() === path} onClick={move}>
            <Link2 size={14} />
            {t("move")}
          </Button>
        </div>
      </Dialog>

      <Dialog
        open={!!conflict}
        title={t("conflictTitle")}
        onClose={busy ? undefined : () => setConflict(null)}
      >
        <p className="text-sm">
          {t("conflictDescription", {
            updated: conflict?.currentUpdated ? formatStamp(conflict.currentUpdated) : "",
          })}
        </p>
        <div className="pdc-dialog-actions">
          <Button variant="ghost" disabled={busy} onClick={() => setConflict(null)}>
            {t("conflictCancel")}
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            onClick={() => {
              if (!view) return;
              setConflict(null);
              load(view.path, "reload");
            }}
          >
            <RotateCcw size={14} />
            {t("conflictReload")}
          </Button>
          <Button
            variant="destructive"
            disabled={busy || !conflict || patchEmpty}
            onClick={() => conflict && commit(conflict.currentDigest)}
          >
            <Save size={14} />
            {t("conflictOverwrite")}
          </Button>
        </div>
        <p className="mt-3 text-xs text-muted-foreground">{t("conflictOverwriteHint")}</p>
      </Dialog>
    </div>
  );
}
