import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { useEffect, useRef, useState } from "react";
import { AtomicCodeMirrorEditor } from "@atomic-editor/editor";
import { ImagePlus, Loader2, Send, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { MarkdownView } from "@/pages/common";
import { sddApi } from "./api";
import { intentTitle, launchIntent, type IntentAttachment } from "./intent";
import type { Project, WorkItem } from "./types";
import "./intent.css";

export function IntentComposer({ initial, projects, onClose, onSaved }: {
  initial: WorkItem; projects: Project[]; onClose: () => void; onSaved: (work: WorkItem) => void;
}) {
  const { t } = useTranslation("workbench");
  const [markdown, setMarkdown] = useState(initial.description);
  const [projectId, setProjectId] = useState(initial.projectId || (projects.length === 1 ? projects[0].id : ""));
  const [images, setImages] = useState<IntentAttachment[]>([]);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState<WorkItem | null>(null);
  const id = useRef(`work-${crypto.randomUUID()}`);
  const files = useRef<HTMLInputElement>(null);
  const adding = useRef(false);
  const submitting = useRef(false);
  const project = projects.find((entry) => entry.id === projectId);
  const close = () => { if (!busy && !reading && (saved || (!markdown.trim() && !images.length) || window.confirm(t("intent.discard")))) onClose(); };
  async function addImages(incoming: File[]) {
    if (busy || saved || adding.current || !incoming.length) return;
    adding.current = true; setReading(true); setError("");
    try {
      if (images.length + incoming.length > 12) throw new Error(t("intent.imageLimit"));
      for (const file of incoming) {
        if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(file.type) || file.size > 10 * 1024 * 1024)
          throw new Error(t("intent.imageError"));
      }
      const added = await Promise.all(incoming.map((file) => new Promise<IntentAttachment>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve({ name: file.name, dataUrl: String(reader.result) });
        reader.onerror = () => reject(new Error(t("intent.imageError")));
        reader.readAsDataURL(file);
      })));
      setImages((previous) => [...previous, ...added]);
    } catch (error) { setError(String(error)); }
    finally { adding.current = false; setReading(false); }
  }
  const nativeDrop = useRef<(paths: string[]) => Promise<void>>(async () => {});
  nativeDrop.current = async (paths) => {
    if (busy || saved || adding.current) return;
    adding.current = true; setReading(true); setError("");
    try {
      if (images.length + paths.length > 12) throw new Error(t("intent.imageLimit"));
      const added = await Promise.all(paths.map(async (path) => ({ name: path.split(/[\\/]/).pop() || "image", dataUrl: await sddApi.captureImage(path) })));
      setImages((previous) => [...previous, ...added]);
    } catch (error) { setError(String(error)); }
    finally { adding.current = false; setReading(false); }
  };
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    void getCurrentWebview().onDragDropEvent((event) => {
      if (!disposed && event.payload.type === "drop") void nativeDrop.current(event.payload.paths);
    }).then((unlisten) => { if (disposed) unlisten(); else stop = unlisten; }).catch((error) => setError(String(error)));
    return () => { disposed = true; stop?.(); };
  }, []);
  async function submit(start: boolean) {
    if (submitting.current || reading || (!markdown.trim() && !images.length) || (start && !project)) return;
    submitting.current = true; setBusy(true); setError("");
    let item = saved;
    try {
      if (!item) {
        item = await sddApi.captureIntent({ ...initial, id: id.current, projectId,
          title: initial.title || intentTitle(markdown, t("intent.imageTitle")) }, markdown, images);
        setSaved(item);
      }
      if (start && project) await launchIntent(item, project);
      onSaved(item);
    } catch (error) { setError(`${item ? t("intent.savedLaunchFailed") + " " : ""}${String(error)}`); }
    finally { submitting.current = false; setBusy(false); }
  }
  return <Dialog open wide title={t("intent.new")} onClose={close} className="wb-intent-dialog">
    <div className="wb-intent-composer">
      <div className="wb-intent-heading"><h2>{t("intent.heading")}</h2><p>{t("intent.hint")}</p></div>
      <div className="wb-intent-route"><span>{t("intent.note")}</span><span>→</span><span>{t("intent.design")}</span><span>→</span><span>{t("intent.approval")}</span><span>→</span><span>{t("intent.build")}</span></div>
      <div className="wb-intent-editor" onPasteCapture={(event) => {
        const incoming = Array.from(event.clipboardData.files);
        if (incoming.length) { event.preventDefault(); event.stopPropagation(); void addImages(incoming); }
      }} onDragOver={(event) => { if (event.dataTransfer.types.includes("Files")) event.preventDefault(); }}
        onDropCapture={(event) => { if (event.dataTransfer.files.length) { event.preventDefault(); event.stopPropagation(); void addImages(Array.from(event.dataTransfer.files)); } }}>
        <div className="wb-intent-toolbar">
          <span>{t("intent.note")}</span>
          <Button type="button" size="xs" variant="ghost" aria-pressed={preview} onClick={() => setPreview(!preview)}>{t(preview ? "intent.edit" : "intent.preview")}</Button>
          <Button type="button" size="xs" variant="ghost" disabled={busy || reading || !!saved} onClick={() => files.current?.click()}><ImagePlus />{t("intent.addImage")}</Button>
          <input ref={files} hidden type="file" accept="image/png,image/jpeg,image/webp,image/gif" multiple aria-label={t("intent.addImage")}
            onChange={(event) => { void addImages(Array.from(event.target.files ?? [])); event.target.value = ""; }} />
        </div>
        {preview ? <MarkdownView className="wb-intent-preview" src={markdown || t("intent.emptyPreview")} /> :
          <div className="wb-atomic-editor"><AtomicCodeMirrorEditor documentId={id.current} markdownSource={markdown} readOnly={busy || !!saved} onMarkdownChange={setMarkdown} /></div>}
        {!markdown && !preview && <p className="wb-intent-placeholder">{t("intent.placeholder")}</p>}
        <div className="wb-intent-images">{images.map((image, index) => <figure key={index}>
          <img src={image.dataUrl} alt={image.name} /><figcaption>{image.name}</figcaption>
          <Button type="button" size="icon" variant="ghost" aria-label={t("intent.removeImage", { name: image.name })} disabled={busy || !!saved} onClick={() => setImages((all) => all.filter((_, i) => i !== index))}><X /></Button>
        </figure>)}</div>
        <p className="wb-intent-attachment-hint">{reading ? t("intent.readingImages") : t("intent.imageHint")}</p>
      </div>
      <div className="wb-intent-footer">
        <Select aria-label={t("form.project")} value={projectId} disabled={busy || !!saved} onChange={setProjectId}
          options={[{ value: "", label: t("intent.chooseProject") }, ...projects.map((project) => ({ value: project.id, label: project.name }))]} />
        <Button variant="outline" disabled={busy || reading || (!markdown.trim() && !images.length)} onClick={() => void submit(false)}>{t(saved ? "intent.openSaved" : "intent.saveNote")}</Button>
        <Button disabled={busy || reading || !project || (!markdown.trim() && !images.length)} onClick={() => void submit(true)}>{busy ? <Loader2 className="wb-spin" /> : <Send />}{t(saved ? "intent.retryDesign" : "intent.requestDesign")}</Button>
      </div>
      {!project && <p className="wb-intent-help">{t("intent.projectHint")}</p>}
      {error && <div className="wb-inline-error" role="alert">{error}</div>}
    </div>
  </Dialog>;
}
