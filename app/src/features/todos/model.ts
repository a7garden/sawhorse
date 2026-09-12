import type { ManagedTodo } from "@/lib/types";
export const todoViews = ["all", "today", "upcoming", "undated", "overdue", "completed"] as const;
export type TodoView = typeof todoViews[number];
export function localDate(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
export function matchesView(item: ManagedTodo, view: TodoView, today: string): boolean {
  if (view === "completed") return item.checked;
  if (item.checked) return false;
  if (view === "all") return true;
  if (view === "undated") return !item.dueDate;
  if (view === "today") return item.dueDate === today;
  if (view === "upcoming") return !!item.dueDate && item.dueDate > today;
  return !!item.dueDate && item.dueDate < today;
}
const priorityRank = { high: 0, normal: 1, low: 2 };
export function sortTodos(items: ManagedTodo[], sort: string): ManagedTodo[] {
  const byDate = (a: ManagedTodo, b: ManagedTodo) => (a.dueDate ?? "9999").localeCompare(b.dueDate ?? "9999");
  const byPriority = (a: ManagedTodo, b: ManagedTodo) => priorityRank[a.priority] - priorityRank[b.priority];
  return [...items].sort((a, b) => (sort === "priority" ? byPriority(a,b) || byDate(a,b) : byDate(a,b) || byPriority(a,b)) || a.text.localeCompare(b.text));
}
