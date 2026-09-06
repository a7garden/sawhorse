import { useEffect, useMemo, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, FileText, Folder, FolderOpen, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import { useApp } from "@/lib/store";
import type { VaultNode } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Empty, MarkdownView } from "./common";

interface TreeNode {
  name: string;
  rel: string;
  dir: boolean;
  children: TreeNode[];
}

// Rebuild the hierarchy from the flattened VaultNode list (rel paths, "/"-separated).
function buildTree(nodes: VaultNode[]): TreeNode[] {
  const root: TreeNode = { name: "", rel: "", dir: true, children: [] };
  for (const n of nodes) {
    const parts = n.rel.split("/");
    let cur = root;
    for (let i = 0; i < parts.length; i++) {
      const isLast = i === parts.length - 1;
      const rel = parts.slice(0, i + 1).join("/");
      let next = cur.children.find((c) => c.name === parts[i]);
      if (!next) {
        next = { name: parts[i], rel, dir: isLast ? n.dir : true, children: [] };
        cur.children.push(next);
      }
      cur = next;
    }
  }
  const sortRec = (list: TreeNode[]) => {
    list.sort((a, b) =>
      a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1,
    );
    for (const c of list) sortRec(c.children);
  };
  sortRec(root.children);
  return root.children;
}

export default function DocsPage() {
  const vaultTree = useApp((s) => s.vaultTree);
  const refreshTree = useApp((s) => s.refreshTree);

  const tree = useMemo(() => buildTree(vaultTree), [vaultTree]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [sel, setSel] = useState<string | null>(null);
  const [view, setView] = useState<{ title: string; md: string; isBase: boolean } | null>(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // first load: open the top two levels so the tree is navigable at a glance
  useEffect(() => {
    if (tree.length > 0 && expanded.size === 0) {
      setExpanded(new Set(tree.filter((n) => n.dir).map((n) => n.rel)));
    }
  }, [tree, expanded.size]);

  function toggleDir(rel: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(rel)) next.delete(rel);
      else next.add(rel);
      return next;
    });
  }

  async function openNote(node: TreeNode) {
    setSel(node.rel);
    setLoading(true);
    setErr(null);
    try {
      const v = await api.readVaultNote(node.rel);
      setView({ title: v.title, md: v.markdown, isBase: node.rel.endsWith(".base") });
    } catch (e) {
      setErr(String(e));
      setView(null);
    } finally {
      setLoading(false);
    }
  }

  function renderNodes(nodes: TreeNode[], depth: number): ReactNode {
    return nodes.map((node) => {
      const open = expanded.has(node.rel);
      const rowCls =
        "flex w-full items-center gap-1.5 rounded-md py-1 pr-1.5 text-left text-xs transition-colors hover:bg-accent";
      if (node.dir) {
        return (
          <div key={node.rel}>
            <button
              className={rowCls}
              style={{ paddingLeft: 6 + depth * 12 }}
              onClick={() => toggleDir(node.rel)}
            >
              {open ? (
                <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
              ) : (
                <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
              )}
              {open ? (
                <FolderOpen className="size-3.5 shrink-0 text-muted-foreground" />
              ) : (
                <Folder className="size-3.5 shrink-0 text-muted-foreground" />
              )}
              <span className="truncate font-medium">{node.name}</span>
            </button>
            {open && renderNodes(node.children, depth + 1)}
          </div>
        );
      }
      return (
        <button
          key={node.rel}
          className={cn(rowCls, sel === node.rel && "bg-secondary font-medium")}
          style={{ paddingLeft: 6 + depth * 12 + 15 }}
          onClick={() => void openNote(node)}
          title={node.rel}
        >
          <FileText className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{node.name}</span>
        </button>
      );
    });
  }

  return (
    <div className="flex h-full">
      <aside className="flex w-60 shrink-0 flex-col border-r">
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-xs font-semibold">문서</span>
          <Button size="xs" variant="ghost" onClick={() => void refreshTree()} aria-label="트리 새로고침">
            <RefreshCw />
          </Button>
        </div>
        <div className="flex-1 overflow-y-auto p-1.5">
          {tree.length === 0 ? (
            <Empty>볼트가 비어 있거나 찾을 수 없습니다.</Empty>
          ) : (
            renderNodes(tree, 0)
          )}
        </div>
      </aside>

      <section className="min-w-0 flex-1 overflow-y-auto">
        {loading ? (
          <Empty>문서를 불러오는 중…</Empty>
        ) : err ? (
          <div className="p-4 text-xs text-destructive">{err}</div>
        ) : view ? (
          <>
            <div className="sticky top-0 z-10 border-b bg-background/95 px-4 py-2 backdrop-blur">
              <div className="text-sm font-bold">{view.title}</div>
              {sel && <div className="text-[11px] text-muted-foreground">{sel}</div>}
            </div>
            <div className="px-4 py-3">
              {view.isBase ? (
                <pre className="whitespace-pre-wrap text-xs leading-relaxed selectable">{view.md}</pre>
              ) : (
                <MarkdownView src={view.md} className="selectable" />
              )}
            </div>
          </>
        ) : (
          <Empty className="mt-16">왼쪽에서 문서를 선택하세요.</Empty>
        )}
      </section>
    </div>
  );
}
