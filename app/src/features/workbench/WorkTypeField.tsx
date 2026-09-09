import { useTranslation } from "react-i18next";
import { Select } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { ISSUE_TYPES } from "./types";

export const workTypeKey = (value: string) => ({ "기능": "feature", "버그": "bug", "리팩토링": "refactor", "작업": "task", "질문": "question" })[value] ?? "task";

/** Purpose changes the writing guide, never the workflow's stages or gates. */
export function WorkTypeField({ value, onChange, disabled, empty, onTemplate }: {
  value: string; onChange: (value: string) => void; disabled: boolean;
  empty: boolean; onTemplate: (markdown: string) => void;
}) {
  const { t } = useTranslation("workbench");
  const key = workTypeKey(value);
  return <div className="wb-work-type">
    <label className="wb-field">{t("workType.label")}
      <Select aria-label={t("workType.label")} value={value || "작업"} onChange={onChange} disabled={disabled}
        options={ISSUE_TYPES.map((type) => ({ value: type, label: t(`issueType.${workTypeKey(type)}`) }))} />
    </label>
    <p className="wb-muted">{t("workType.hint")}</p>
    <p>{t(`workType.guides.${key}`)}</p>
    {empty && <Button type="button" size="sm" variant="outline" disabled={disabled}
      onClick={() => onTemplate(t(`workType.templates.${key}`))}>{t("workType.insertTemplate")}</Button>}
  </div>;
}
