import { useState } from "react";
import { Plus } from "lucide-react";
import { api } from "@/lib/api";
import { useApp } from "@/lib/store";
import type { TodoItem, TodoSection } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { Empty, PageHeader, WARN_TEXT } from "./common";
import { useTranslation } from "react-i18next";

const SECTIONS: { key: TodoSection }[] = [
  { key: "today" },
  { key: "tomorrow" },
];

export default function TodosPage() {
  const todos = useApp((s) => s.todos);
  const refreshTodos = useApp((s) => s.refreshTodos);
  const [drafts, setDrafts] = useState<Record<TodoSection, string>>({
    today: "",
    tomorrow: "",
  });
  const [pending, setPending] = useState(false);
  const { t } = useTranslation("sessions");

  async function toggle(
    section: TodoSection,
    item: TodoItem,
    checked: boolean,
  ) {
    setPending(true);
    try {
      await api.toggleTodo(section, item.index, checked);
      await refreshTodos();
    } finally {
      setPending(false);
    }
  }

  async function add(section: TodoSection) {
    const text = drafts[section].trim();
    if (text.length === 0) return;
    setPending(true);
    try {
      await api.addTodo(section, text);
      setDrafts((d) => ({ ...d, [section]: "" }));
      await refreshTodos();
    } finally {
      setPending(false);
    }
  }

  return (
    <div>
      <PageHeader title={t("todos.title")} />

      {todos && !todos.fileExists && (
        <div className={`px-4 pt-3 text-xs ${WARN_TEXT}`}>
          {t("todos.noJournal")}
        </div>
      )}

      <div className="grid gap-4 p-4 md:grid-cols-2">
        {SECTIONS.map((sec) => {
          const items = todos?.[sec.key] ?? [];
          const done = items.filter((i) => i.checked).length;
          return (
            <Card key={sec.key}>
              <CardHeader className="flex-row items-center justify-between space-y-0 pb-1">
                <CardTitle className="text-[13px]">
                  {t(`section.${sec.key}`)}
                </CardTitle>
                <Badge variant="secondary">
                  {done}/{items.length}
                </Badge>
              </CardHeader>
              <CardContent className="space-y-1.5">
                {items.length === 0 && (
                  <Empty className="py-4">{t("todos.empty")}</Empty>
                )}
                {items.map((it) => (
                  <label
                    key={it.index}
                    className="flex items-start gap-2 rounded px-1 py-1 text-[13px] transition-colors hover:bg-muted/50"
                  >
                    <Checkbox
                      className="mt-0.5"
                      checked={it.checked}
                      disabled={pending}
                      onChange={(e) =>
                        void toggle(sec.key, it, e.target.checked)
                      }
                    />
                    <span
                      className={cn(
                        "break-words",
                        it.checked && "text-muted-foreground line-through",
                      )}
                    >
                      {it.text}
                    </span>
                  </label>
                ))}
                <form
                  className="flex gap-1.5 pt-1"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void add(sec.key);
                  }}
                >
                  <Input
                    value={drafts[sec.key]}
                    onChange={(e) =>
                      setDrafts((d) => ({ ...d, [sec.key]: e.target.value }))
                    }
                    placeholder={t("todos.newItemPlaceholder")}
                  />
                  <Button
                    type="submit"
                    size="sm"
                    disabled={pending || drafts[sec.key].trim().length === 0}
                  >
                    <Plus /> {t("actions.add")}
                  </Button>
                </form>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
