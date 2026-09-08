import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Sparkles, Upload, Download, Loader2 } from "lucide-react";
import { save } from "@tauri-apps/plugin-dialog";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/select";
import { MarkdownView } from "@/pages/common";
import { isWorkbenchPreview, sddApi } from "./api";
import type { ResourceAssignment, ResourceDocument } from "./lifecycle-v2";
import type { Project } from "./types";
import "./lifecycle.css";
const blank = (kind: "template" | "design"): ResourceDocument => ({ id: "", kind, title: "", markdown: "", source: "", revision: "" });
export function ResourceLibrary({ projects, initialProjectId = "" }: { projects: Project[]; initialProjectId?: string }) {
  const { t } = useTranslation("workbench");
  const [items, setItems] = useState<ResourceDocument[]>([]);
  const [draft, setDraft] = useState<ResourceDocument>(blank("design"));
  const [projectId, setProjectId] = useState(initialProjectId || projects[0]?.id || "");
  const [assignment, setAssignment] = useState<ResourceAssignment>({ designId: "", templates: {} });
  const [role, setRole] = useState("spec"), [source, setSource] = useState("");
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [preview, setPreview] = useState(false), [dirty, setDirty] = useState(false);
  const files = useRef<HTMLInputElement>(null); const lock = useRef(false);
  const project = projects.find((p) => p.id === projectId);
  useEffect(() => { void sddApi.resources().then(setItems).catch((e) => setError(String(e))); }, []);
  useEffect(() => { let alive = true; if (projectId) void sddApi.projectResources(projectId).then((a) => { if (alive) setAssignment(a); }).catch((e) => { if (alive) setError(String(e)); }); return () => { alive = false; }; }, [projectId]);
  const select = (doc: ResourceDocument) => { if (dirty && !window.confirm(t("detail.confirmClose"))) return; setDraft(doc); setSource(""); setDirty(false); setNotice(""); };
  const update = (patch: Partial<ResourceDocument>) => { setDraft((doc) => ({ ...doc, ...patch })); setDirty(true); };
  async function perform(task: () => Promise<unknown>) { if (lock.current) return; lock.current = true; setBusy(true); setError(""); setNotice(""); try { await task(); } catch (e) { setError(String(e)); } finally { setBusy(false); lock.current = false; } }
  return <section className="wb-resources" aria-label={t("resources.title")}>
    <div className="wb-intent-flow-head"><div><h2>{t("resources.title")}</h2><p>{t("resources.hint")}</p></div><div className="wb-lifecycle-actions"><Button size="sm" variant="outline" disabled={busy} onClick={() => select(blank("design"))}><Plus />DESIGN.md</Button><Button size="sm" variant="outline" disabled={busy} onClick={() => select(blank("template"))}><Plus />{t("resources.template")}</Button></div></div>
    <div className="wb-resource-layout"><aside className="wb-resource-list">
      {items.map((doc) => <button disabled={busy} key={doc.id} aria-pressed={draft.id === doc.id} onClick={() => select(doc)}><strong>{doc.title}</strong><small>{doc.kind === "design" ? "DESIGN.md" : t("resources.template")}</small></button>)}
      {!items.length && <p>{t("resources.empty")}</p>}
    </aside><div className="wb-resource-editor">
      <label htmlFor="resource-title">{t("resources.name")}</label><input id="resource-title" value={draft.title} disabled={busy} onChange={(e) => update({ title: e.target.value })} placeholder={draft.kind === "design" ? "DESIGN.md" : t("resources.template")} />
      <Select aria-label={t("resources.project")} value={projectId} disabled={busy} onChange={setProjectId} options={[{ value: "", label: t("resources.chooseProject") }, ...projects.map((p) => ({ value: p.id, label: p.name }))]} />
      <p className="wb-lifecycle-notice">{t("resources.assigned")}: {items.find((d) => d.id === assignment.designId)?.title || t("resources.repoDesign")}</p>
      <details><summary>{t("resources.fromDocument")}</summary><p className="wb-lifecycle-notice">{t("resources.sourceHint")}</p><div className="wb-lifecycle-actions">
        <Button size="sm" variant="outline" disabled={busy} onClick={() => files.current?.click()}><Upload />{t("resources.import")}</Button>
        {draft.kind === "design" && <Button size="sm" variant="outline" disabled={busy || !project} onClick={() => void perform(async () => { setSource(await sddApi.designSource(projectId)); update({ source: project!.repoPath }); })}>{t("resources.readProject")}</Button>}
        <input ref={files} hidden type="file" accept=".md,.txt,.html,.css,.scss" onChange={(e) => { const file = e.target.files?.[0]; if (file) void perform(async () => { if (file.size > 256000) throw new Error(t("resources.sourceLimit")); setSource(await file.text()); update({ source: file.name }); }); e.target.value = ""; }} />
      </div><textarea className="wb-resource-source" aria-label={t("resources.source")} value={source} disabled={busy} onChange={(e) => setSource(e.target.value)} />
      <Button size="sm" disabled={busy || !source.trim() || !project} onClick={() => void perform(async () => { update({ markdown: await sddApi.generateResource(draft.kind, source, project!.defaultAgent) }); })}>{busy ? <Loader2 className="wb-spin" /> : <Sparkles />}{t("resources.generate")}</Button></details>
      <label htmlFor="resource-markdown">{draft.kind === "design" ? "DESIGN.md" : t("resources.content")}</label>
      <Button size="sm" variant="ghost" onClick={() => setPreview(!preview)}>{t(preview ? "intent.edit" : "intent.preview")}</Button>
      {preview ? <MarkdownView src={draft.markdown} /> : <textarea id="resource-markdown" value={draft.markdown} disabled={busy} onChange={(e) => update({ markdown: e.target.value })} placeholder={t(draft.kind === "design" ? "resources.designPlaceholder" : "resources.templatePlaceholder")} />}
      {error && <div className="wb-inline-error" role="alert">{error}</div>}{notice && <p role="status">{notice}</p>}
      <div className="wb-lifecycle-actions"><Button disabled={busy || !draft.title.trim() || !draft.markdown.trim()} onClick={() => void perform(async () => { const saved = await sddApi.saveResource(draft); setDraft(saved); setDirty(false); setItems(await sddApi.resources()); setNotice(t("resources.saved")); })}>{t("common.save")}</Button>
        {draft.kind === "template" && <Select aria-label={t("resources.role")} value={role} onChange={setRole} options={["brief", "spec", "plan", "verification", "rollback"].map((value) => ({ value, label: t(`lifecycle.docs.${value}`) }))} />}
        <Button variant="outline" disabled={busy || !draft.id || dirty || !project} onClick={() => void perform(async () => { setAssignment(await sddApi.assignResource(projectId, draft.id, draft.kind === "design" ? "design" : role)); setNotice(t("resources.applied")); })}>{t("resources.apply")}</Button>
        <Button variant="ghost" disabled={busy || !project || !(draft.kind === "design" ? assignment.designId : assignment.templates[role])} onClick={() => void perform(async () => { setAssignment(await sddApi.assignResource(projectId, "", draft.kind === "design" ? "design" : role)); setNotice(t("resources.detached")); })}>{t("resources.detach")}</Button>
        <Button variant="ghost" disabled={busy || !draft.id || dirty} onClick={() => void perform(async () => {
          if (isWorkbenchPreview) { const url = URL.createObjectURL(new Blob([draft.markdown], { type: "text/markdown" })); const a = document.createElement("a"); a.href = url; a.download = draft.kind === "design" ? "DESIGN.md" : "template.md"; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); return; }
          const path = await save({ defaultPath: draft.kind === "design" ? "DESIGN.md" : "template.md", filters: [{ name: "Markdown", extensions: ["md"] }] }); if (path) await sddApi.exportResource(draft.id, path);
        })}><Download />{t("resources.export")}</Button>
      </div><p className="wb-lifecycle-notice">{t("resources.applyHint")}</p>
    </div></div>
  </section>;
}
