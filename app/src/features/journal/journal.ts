import { useCallback, useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { NoteRow, QueryResult } from "@/lib/types";

export const journalPage = "view:starter:logs";
export function dateKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
export function noteDate(row: NoteRow): string | null {
  for (const value of [row.fields.date, row.title, row.rel.split("/").pop()]) {
    const match = String(value ?? "").match(/(?:^|\D)(\d{4}-\d{2}-\d{2})(?:\D|$)/);
    if (match && dateKey(new Date(`${match[1]}T12:00:00`)) === match[1]) return match[1];
  }
  return null;
}
export function fieldText(value: unknown): string {
  return Array.isArray(value) ? value.map(String).join(" · ") : value == null ? "" : String(value);
}
export function useJournal() {
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError("");
    api.queryPackView("starter", "logs").then((value) => {
      if (alive) setResult({ ...value, rows: [...value.rows].sort((a, b) =>
        (noteDate(b) ?? "").localeCompare(noteDate(a) ?? "") || b.mtimeMs - a.mtimeMs) });
    }).catch((cause) => { if (alive) setError(String(cause)); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [revision]);
  return { result, loading, error, refresh, revision };
}
