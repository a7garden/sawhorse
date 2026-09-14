import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  Check,
  FileStack,
  Inbox,
  Loader2,
  Plus,
  Star,
  Trash2,
} from "lucide-react";
import { pdcApi } from "@/lib/api";
import type { PdcScan } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { PdcDocumentEditor } from "./PdcDocumentEditor";
import "./pdc-documents.css";

/**
 * The PDC 정문서 plane screen: scans the default document space, lists documents
 * (live list vs 휴지통), warns about duplicate ids, and opens documents in the
 * editor view. Outside the desktop app every invoke rejects — the page degrades
 * to a quiet empty state instead of crashing, so browser e2e stays green.
 */

type Transport = "markdown" | "html";

function markdownSeedBody(title: string): string {
  return `# ${title}\n\n`;
}

function htmlSeedBody(title: string): string {
  const safe = title.replace(/</g, "&lt;");
  return `<!doctype html>\n<html lang="ko">\n<head><meta charset="utf-8"><title>${safe}</title></head>\n<body>\n<h1>${safe}</h1>\n</body>\n</html>`;
}

function profileLabel(bodyProfile: string | null): string {
  return bodyProfile
    ? bodyProfile.replace(/^pdc-/, "").replace(/\/1$/, "")
    : "doc";
}

function formatStamp(value: string | null): string {
  if (!value) return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function CreateDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: () => void;
}) {
  const { t } = useTranslation("documents");
  const [title, setTitle] = useState("");
  const [transport, setTransport] = useState<Transport>("markdown");
  // The stem follows the title until the user edits it explicitly.
  const [stem, setStem] = useState("");
  const [stemTouched, setStemTouched] = useState(false);
  const [dir, setDir] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const trimmedTitle = title.trim();
  const effectiveStem = (stemTouched ? stem : trimmedTitle).trim();

  const create = () => {
    setBusy(true);
    setError("");
    pdcApi
      .create({
        dir: dir.trim(),
        stem: effectiveStem,
        transport,
        title: trimmedTitle,
        body: transport === "markdown" ? markdownSeedBody(trimmedTitle) : htmlSeedBody(trimmedTitle),
      })
      .then(onCreated)
      .catch((err) => setError(String(err)))
      .finally(() => setBusy(false));
  };

  return (
    <Dialog open title={t("createTitle")} onClose={busy ? undefined : onClose}>
      <div className="pdc-dialog-fields">
        <label>
          <span>{t("titleLabel")}</span>
          <Input
            value={title}
            autoFocus
            disabled={busy}
            aria-label={t("titleLabel")}
            onChange={(event) => setTitle(event.target.value)}
          />
        </label>
        <span>{t("kind")}</span>
        <div className="pdc-kind-picker" role="radiogroup" aria-label={t("kind")}>
          <label>
            <input
              type="radio"
              name="pdc-transport"
              checked={transport === "markdown"}
              disabled={busy}
              onChange={() => setTransport("markdown")}
            />
            {t("kindMarkdown")}
          </label>
          <label>
            <input
              type="radio"
              name="pdc-transport"
              checked={transport === "html"}
              disabled={busy}
              onChange={() => setTransport("html")}
            />
            {t("kindHtml")}
          </label>
        </div>
        <label>
          <span>{t("nameLabel")}</span>
          <Input
            value={stemTouched ? stem : effectiveStem}
            disabled={busy}
            aria-label={t("nameLabel")}
            onChange={(event) => {
              setStem(event.target.value);
              setStemTouched(true);
            }}
          />
        </label>
        <label>
          <span>{t("folderLabel")}</span>
          <Input
            value={dir}
            disabled={busy}
            aria-label={t("folderLabel")}
            placeholder={t("folderHint")}
            onChange={(event) => setDir(event.target.value)}
          />
        </label>
      </div>
      {error && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="pdc-dialog-actions">
        <Button variant="ghost" disabled={busy} onClick={onClose}>
          {t("cancel")}
        </Button>
        <Button disabled={busy || !trimmedTitle || !effectiveStem} onClick={create}>
          {busy ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
          {t("create")}
        </Button>
      </div>
    </Dialog>
  );
}

export default function PdcDocumentsPage() {
  const { t } = useTranslation("documents");
  const [scan, setScan] = useState<PdcScan | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [trash, setTrash] = useState(false);
  const [creating, setCreating] = useState(false);
  const [openPath, setOpenPath] = useState<string | null>(null);

  const refresh = useCallback(() => {
    pdcApi
      .scan()
      .then((next) => {
        setScan(next);
        setError("");
      })
      .catch((err) => setError(String(err)))
      .finally(() => setLoaded(true));
  }, []);
  useEffect(() => {
    refresh();
  }, [refresh]);

  if (openPath) {
    return (
      <PdcDocumentEditor
        path={openPath}
        scan={scan}
        onBack={() => setOpenPath(null)}
        onChanged={refresh}
      />
    );
  }

  const rows = (scan?.documents ?? [])
    .filter((doc) => doc.deleted === trash)
    .sort(
      (a, b) =>
        Number(b.favorite) - Number(a.favorite) ||
        (b.updated ?? "").localeCompare(a.updated ?? ""),
    );

  return (
    <div className="pdc-page">
      <header className="pdc-header">
        <div>
          <span className="pdc-eyebrow">{t("eyebrow")}</span>
          <h1>{t("title")}</h1>
          <p>{t("description")}</p>
        </div>
        <div className="pdc-header-actions">
          <Button
            variant={trash ? "default" : "outline"}
            aria-pressed={trash}
            onClick={() => setTrash((value) => !value)}
          >
            <Trash2 size={15} />
            {t("trash")}
          </Button>
          {!trash && (
            <Button onClick={() => setCreating(true)}>
              <Plus size={15} />
              {t("create")}
            </Button>
          )}
        </div>
      </header>

      {scan && scan.duplicateIds.length > 0 && (
        <div className="pdc-banner" role="alert">
          <strong>
            <AlertTriangle size={13} />
            {t("duplicateIds")}
          </strong>
          <ul>
            {scan.duplicateIds.map((duplicate) => (
              <li key={duplicate.id}>
                <code>{duplicate.id}</code> — {duplicate.paths.join(" · ")}
              </li>
            ))}
          </ul>
        </div>
      )}
      {error && (
        <div className="pdc-empty is-error" role="alert">
          <FileStack size={30} />
          <h3>{t("unavailableTitle")}</h3>
          <p>{error}</p>
        </div>
      )}

      {!error && !loaded && (
        <p role="status" className="pdc-empty">
          <Loader2 className="animate-spin" />
        </p>
      )}

      {!error && loaded && rows.length === 0 && (
        <div className="pdc-empty">
          <Inbox size={30} />
          <h3>{trash ? t("trashEmpty") : t("listEmpty")}</h3>
          <p>{trash ? t("trashEmptyHint") : t("listEmptyHint")}</p>
          {!trash && (
            <Button variant="outline" onClick={() => setCreating(true)}>
              <Plus size={14} />
              {t("create")}
            </Button>
          )}
        </div>
      )}

      {rows.length > 0 && (
        <ul className="pdc-list">
          {rows.map((doc) => (
            <li key={doc.path} className="pdc-row">
              <button
                type="button"
                className="pdc-row-open"
                aria-label={`${doc.displayTitle} · ${t("edit")}`}
                onClick={() => setOpenPath(doc.path)}
              >
                <span className="pdc-row-title">
                  <Star
                    size={13}
                    className={doc.favorite ? "is-fav" : "is-dim"}
                    aria-label={t("favorite")}
                  />
                  {doc.displayTitle}
                </span>
                <small>{doc.path}</small>
              </button>
              {doc.bodyProfile && (
                <span className="pdc-badge">{profileLabel(doc.bodyProfile)}</span>
              )}
              {!doc.editable && (
                <span
                  className="pdc-badge is-code"
                  title={doc.message ?? undefined}
                >
                  {doc.code}
                </span>
              )}
              {doc.deleted && (
                <span className="pdc-badge is-readonly">{t("trashed")}</span>
              )}
              <time>{formatStamp(doc.updated)}</time>
            </li>
          ))}
        </ul>
      )}

      {creating && (
        <CreateDialog
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false);
            refresh();
          }}
        />
      )}
    </div>
  );
}
