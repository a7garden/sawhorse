import { useTranslation } from "react-i18next";
import { ArrowLeft } from "lucide-react";
import { useApp } from "@/lib/store";

const parents: Record<string, { page: string; labelKey: string }> = {
  workflows: { page: "packs", labelKey: "nav.back.workflows" },
  schemas: { page: "settings", labelKey: "nav.back.schemas" },
  onboarding: { page: "projects", labelKey: "nav.back.onboarding" },
  sources: { page: "reading", labelKey: "nav.back.sources" },
};
export function DetailNavigation() {
  const page = useApp((s) => s.page);
  const { t } = useTranslation("common");
  const parent = parents[page];
  if (!parent) return null;
  return (
    <div className="border-b bg-background px-5 py-2">
      <button
        className="flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground"
        onClick={() => {
          if (
            window.dispatchEvent(
              new Event("sawhorse:navigate", { cancelable: true }),
            )
          )
            useApp.getState().setPage(parent.page);
        }}
      >
        <ArrowLeft size={14} />
        {t(parent.labelKey)}
      </button>
    </div>
  );
}
