import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { sddApi } from "./api";
import type { ResourceAssignment, ResourceDocument } from "./lifecycle-v2";
import "./lifecycle.css";

const templateRoles = ["brief", "spec", "plan", "verification", "rollback"];

/** Projects select shared resources here; authoring belongs to the global library. */
export function ProjectResourcePicker({ projectId }: { projectId: string }) {
  const { t } = useTranslation("workbench");
  const [items, setItems] = useState<ResourceDocument[]>([]);
  const [assignment, setAssignment] = useState<ResourceAssignment | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [retry, setRetry] = useState(0);
  const lock = useRef(false);

  useEffect(() => {
    let alive = true;
    setLoading(true); setAssignment(null); setError(""); setNotice("");
    void Promise.all([sddApi.resources(), sddApi.projectResources(projectId)])
      .then(([resources, selected]) => { if (alive) { setItems(resources); setAssignment(selected); } })
      .catch((e) => { if (alive) setError(String(e)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [projectId, retry]);

  const select = async (role: string, resourceId: string) => {
    if (lock.current || !assignment) return;
    lock.current = true; setBusy(true); setError(""); setNotice("");
    try {
      setAssignment(await sddApi.assignResource(projectId, resourceId, role));
      setNotice(t(resourceId ? "resources.applied" : "resources.detached"));
    } catch (e) { setError(String(e)); }
    finally { lock.current = false; setBusy(false); }
  };

  const options = (kind: ResourceDocument["kind"], selected: string) => [
    { value: "", label: t(kind === "design" ? "resources.repoDesign" : "resources.noTemplate") },
    ...items.filter((item) => item.kind === kind).map((item) => ({ value: item.id, label: item.title })),
    ...(selected && !items.some((item) => item.id === selected)
      ? [{ value: selected, label: t("resources.unavailable"), disabled: true }] : []),
  ];

  return <section className="wb-project-resources" aria-label={t("resources.selectLibrary")}>
    <p>{t("resources.selectionHint")}</p>
    {loading && <p role="status">{t("common.loading")}</p>}
    {assignment && <>
      <label>{t("resources.assigned")}
        <Select aria-label={t("resources.assigned")} value={assignment.designId} disabled={busy}
          options={options("design", assignment.designId)} onChange={(id) => void select("design", id)} />
      </label>
      {Array.from(new Set([...templateRoles, ...Object.keys(assignment.templates)])).map((role) => <label key={role}>
        {t("resources.templateFor", { role: t(`lifecycle.docs.${role}`, { defaultValue: role }) })}
        <Select aria-label={t("resources.templateFor", { role: t(`lifecycle.docs.${role}`, { defaultValue: role }) })}
          value={assignment.templates[role] || ""} disabled={busy}
          options={options("template", assignment.templates[role] || "")} onChange={(id) => void select(role, id)} />
      </label>)}
      {!items.length && <p>{t("resources.selectionEmpty")}</p>}
      <p className="wb-lifecycle-notice">{t("resources.applyHint")}</p>
    </>}
    {error && <div className="wb-inline-error" role="alert">{error}</div>}
    {!loading && !assignment && <Button variant="outline" onClick={() => setRetry((value) => value + 1)}>{t("common.refresh")}</Button>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
