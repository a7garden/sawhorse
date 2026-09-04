import { useEffect, useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import type { PluginBundle } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Empty, MarkdownView } from "./common";

export default function PluginPage() {
  const [bundle, setBundle] = useState<PluginBundle | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sel, setSel] = useState<string | null>(null);
  const [doc, setDoc] = useState<string | null>(null);
  const [docErr, setDocErr] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      setBundle(await api.pluginInfo());
    } catch (e) {
      setErr(String(e));
      setBundle(null);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function openSkill(name: string) {
    setSel(name);
    setDoc(null);
    setDocErr(null);
    try {
      setDoc(await api.readSkill(name));
    } catch (e) {
      setDocErr(String(e));
    }
  }

  if (loading) return <Empty className="pt-16">플러그인 정보를 불러오는 중…</Empty>;
  if (err || !bundle) {
    return (
      <div className="mx-auto mt-16 max-w-md text-center text-xs text-muted-foreground">
        <p className="mb-2 font-medium text-foreground">플러그인 정보를 읽지 못했다</p>
        <p className="mb-3 break-all">{err}</p>
        <Button variant="outline" size="sm" onClick={() => void load()}>
          <RefreshCw className="size-3" /> 다시 시도
        </Button>
      </div>
    );
  }

  const repo = bundle.repository || bundle.homepage;
  const homepage =
    bundle.homepage && bundle.homepage !== bundle.repository ? bundle.homepage : null;

  return (
    <div className="flex h-full flex-col">
      <div className="border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold">{bundle.name}</span>
          {bundle.version && <Badge variant="secondary">v{bundle.version}</Badge>}
        </div>
        {bundle.description && (
          <p className="mt-1 text-xs text-muted-foreground">{bundle.description}</p>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {bundle.author && (
            <span className="text-[11px] text-muted-foreground">{bundle.author}</span>
          )}
          {bundle.license && <Badge variant="outline">{bundle.license}</Badge>}
          {bundle.keywords.map((k) => (
            <Badge key={k} variant="outline">
              {k}
            </Badge>
          ))}
          <span className="ml-auto flex gap-1.5">
            {repo && (
              <Button variant="outline" size="sm" onClick={() => void api.openExternal(repo)}>
                <ExternalLink className="size-3" /> GitHub
              </Button>
            )}
            {homepage && (
              <Button variant="outline" size="sm" onClick={() => void api.openExternal(homepage)}>
                <ExternalLink className="size-3" /> Homepage
              </Button>
            )}
          </span>
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="w-80 shrink-0 overflow-y-auto border-r p-2">
          {bundle.skills.map((s) => (
            <button
              key={s.name}
              onClick={() => void openSkill(s.name)}
              className={cn(
                "block w-full rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent",
                sel === s.name && "bg-secondary",
              )}
            >
              <div className="text-[13px] font-medium">{s.name}</div>
              <div className="truncate text-[11px] text-muted-foreground" title={s.description}>
                {s.description}
              </div>
            </button>
          ))}
        </div>
        <div className="min-w-0 flex-1 overflow-y-auto px-4 py-3">
          {docErr && <Empty>{docErr}</Empty>}
          {!docErr && !doc && <Empty>왼쪽에서 스킬을 선택하면 SKILL.md 전문이 표시된다</Empty>}
          {doc && <MarkdownView src={doc} />}
        </div>
      </div>
    </div>
  );
}
