import { ArrowLeft } from "lucide-react";
import { useApp } from "@/lib/store";

const parents: Record<string, { page: string; label: string }> = {
  workflows: { page: "packs", label: "확장 관리" },
  schemas: { page: "settings", label: "설정" },
  onboarding: { page: "projects", label: "프로젝트" },
  sources: { page: "reading", label: "읽을거리" },
};
export function DetailNavigation() {
  const page = useApp((s) => s.page);
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
        {parent.label}으로 돌아가기
      </button>
    </div>
  );
}
