import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, GripVertical } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { TaskRow, TaskSchedule } from "@/lib/types";

export function localDate(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
function monday(date: Date) {
  const result = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  result.setDate(result.getDate() - ((result.getDay() + 6) % 7));
  return result;
}
function occurs(schedule: TaskSchedule | null, day: number, date: string) {
  if (!schedule) return false;
  return schedule.kind === "once"
    ? schedule.date === date
    : schedule.kind === "daily" ||
        (schedule.kind === "weekdays" ? day < 5 : schedule.days?.includes(day));
}
export function placedSchedule(
  row: TaskRow,
  date: string,
  day: number,
  time: string,
  repeat: boolean,
  sourceDay?: number,
): TaskSchedule {
  const previous = row.def.schedule;
  if (sourceDay !== undefined && previous && previous.kind !== "once") {
    const days =
      previous.kind === "daily"
        ? [0, 1, 2, 3, 4, 5, 6]
        : previous.kind === "weekdays"
          ? [0, 1, 2, 3, 4]
          : (previous.days ?? []);
    return {
      kind: "weekly",
      time,
      days: [...new Set(days.map((d) => (d === sourceDay ? day : d)))].sort(),
      date: null,
    };
  }
  return (sourceDay !== undefined ? previous?.kind !== "once" : repeat)
    ? { kind: "weekly", time, days: [day], date: null }
    : { kind: "once", time, date };
}

export default function AutomationTimeline({
  rows,
  busy,
  onPlace,
  onEdit,
}: {
  rows: TaskRow[];
  busy: boolean;
  onPlace: (row: TaskRow, schedule: TaskSchedule) => Promise<void>;
  onEdit: (row: TaskRow) => void;
}) {
  const { t, i18n } = useTranslation("settings");
  const [week, setWeek] = useState(() => monday(new Date()));
  const [repeat, setRepeat] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const scroll = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (scroll.current) scroll.current.scrollTop = 8 * 80;
  }, []);
  const dates = Array.from({ length: 7 }, (_, day) => {
    const date = new Date(week);
    date.setDate(date.getDate() + day);
    return localDate(date);
  });
  // One pass over rows instead of a schedule parse per grid cell (48 slots x 7 days).
  const cellRows = useMemo(() => {
    const map: Record<string, TaskRow[]> = {};
    for (const row of rows) {
      const schedule = row.def.schedule;
      if (!schedule) continue;
      const slot = Math.floor(
        (Number(schedule.time.slice(0, 2)) * 60 +
          Number(schedule.time.slice(3))) /
          30,
      );
      dates.forEach((date, day) => {
        if (!occurs(schedule, day, date)) return;
        const key = `${day}-${slot}`;
        (map[key] ??= []).push(row);
      });
    }
    return map;
    // `dates` is derived solely from `week`, so `week` keeps the memo stable.
  }, [rows, week]);
  function moveWeek(delta: number) {
    const date = new Date(week);
    date.setDate(date.getDate() + delta * 7);
    setWeek(date);
  }
  async function place(
    id: string,
    day: number,
    time: string,
    sourceDay?: number,
  ) {
    if (busy) return;
    const row = rows.find((row) => row.def.id === id);
    if (!row) return;
    const schedule = placedSchedule(
      row,
      dates[day],
      day,
      time,
      repeat,
      sourceDay,
    );
    if (
      schedule.kind === "once" &&
      new Date(`${schedule.date}T${time}`).getTime() <= Date.now()
    ) {
      setMessage(t("tasks.timeline.past"));
      return;
    }
    setMessage("");
    await onPlace(row, schedule);
    setSelected(null);
  }
  function drag(event: React.DragEvent, id: string, day?: number) {
    event.dataTransfer.setData(
      "application/x-sawhorse-task",
      JSON.stringify({ id, day }),
    );
    event.dataTransfer.effectAllowed = "move";
  }
  return (
    <section
      className="overflow-hidden rounded-xl border"
      aria-label={t("tasks.timeline.title")}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b p-3">
        <div>
          <h2 className="text-sm font-semibold">{t("tasks.timeline.title")}</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {t("tasks.timeline.hint")}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="icon"
            variant="ghost"
            aria-label={t("tasks.timeline.previous")}
            onClick={() => moveWeek(-1)}
          >
            <ChevronLeft />
          </Button>
          <Input
            type="date"
            className="w-36"
            aria-label={t("tasks.timeline.week")}
            value={localDate(week)}
            onChange={(event) => {
              if (event.target.value)
                setWeek(monday(new Date(`${event.target.value}T12:00`)));
            }}
          />
          <Button
            size="icon"
            variant="ghost"
            aria-label={t("tasks.timeline.next")}
            onClick={() => moveWeek(1)}
          >
            <ChevronRight />
          </Button>
          <Button
            size="xs"
            variant="outline"
            onClick={() => setWeek(monday(new Date()))}
          >
            {t("tasks.timeline.today")}
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-b bg-muted/20 p-3">
        <span className="text-xs text-muted-foreground">
          {t("tasks.timeline.newSchedule")}
        </span>
        <Button
          size="xs"
          variant={repeat ? "default" : "outline"}
          aria-pressed={repeat}
          onClick={() => setRepeat(true)}
        >
          {t("tasks.timeline.repeat")}
        </Button>
        <Button
          size="xs"
          variant={!repeat ? "default" : "outline"}
          aria-pressed={!repeat}
          onClick={() => setRepeat(false)}
        >
          {t("tasks.timeline.once")}
        </Button>
      </div>
      <div
        className="flex flex-wrap gap-2 border-b p-3"
        role="group"
        aria-label={t("tasks.timeline.choose")}
      >
        {rows.map((row) => (
          <Button
            key={row.def.id}
            size="xs"
            variant={selected === row.def.id ? "default" : "outline"}
            draggable={!busy}
            disabled={busy}
            onDragStart={(event) => drag(event, row.def.id)}
            onClick={() =>
              setSelected(selected === row.def.id ? null : row.def.id)
            }
            aria-pressed={selected === row.def.id}
          >
            <GripVertical />
            {row.def.title}
          </Button>
        ))}
        {!rows.length && (
          <p className="text-xs text-muted-foreground">
            {t("tasks.empty.library")}
          </p>
        )}
      </div>
      <p className="px-3 py-2 text-xs text-muted-foreground" role="status">
        {message ||
          (selected
            ? t("tasks.timeline.selected", {
                title: rows.find((r) => r.def.id === selected)?.def.title,
              })
            : t("tasks.timeline.editHint"))}
      </p>
      <div
        ref={scroll}
        className="max-h-[540px] overflow-auto border-t"
        tabIndex={0}
        aria-label={t("tasks.timeline.grid")}
      >
        <div className="min-w-[700px]">
          <div className="sticky top-0 z-10 grid grid-cols-[52px_repeat(7,minmax(0,1fr))] border-b bg-background shadow-sm">
            <span className="p-2 text-[10px] text-muted-foreground">
              {t("tasks.timeline.local")}
            </span>
            {dates.map((date, day) => (
              <div
                key={date}
                className={`border-l p-2 text-center text-xs ${date === localDate(new Date()) ? "bg-primary/10 text-primary" : ""}`}
              >
                <span className="font-semibold">{t(`tasks.days.${day}`)}</span>
                <span className="ml-1 text-muted-foreground">
                  {new Intl.DateTimeFormat(i18n.language, {
                    month: "numeric",
                    day: "numeric",
                  }).format(new Date(`${date}T12:00`))}
                </span>
              </div>
            ))}
          </div>
          {Array.from({ length: 48 }, (_, slot) => {
            const time = `${String(Math.floor(slot / 2)).padStart(2, "0")}:${slot % 2 ? "30" : "00"}`;
            return (
              <div
                key={slot}
                className="grid h-10 grid-cols-[52px_repeat(7,minmax(0,1fr))]"
              >
                <span className="border-b p-1 text-right text-[10px] tabular-nums text-muted-foreground">
                  {time}
                </span>
                {dates.map((date, day) => {
                  const key = `${day}-${slot}`;
                  const items = cellRows[key] ?? [];
                  return (
                    <div
                      key={day}
                      className={`relative flex min-w-0 border-b border-l ${hover === key ? "bg-primary/15" : "hover:bg-muted/40"}`}
                      onDragOver={(event) => {
                        if (
                          !busy &&
                          event.dataTransfer.types.includes(
                            "application/x-sawhorse-task",
                          )
                        ) {
                          event.preventDefault();
                          setHover(key);
                        }
                      }}
                      onDragLeave={() => setHover(null)}
                      onDrop={(event) => {
                        event.preventDefault();
                        setHover(null);
                        try {
                          const payload = JSON.parse(
                            event.dataTransfer.getData(
                              "application/x-sawhorse-task",
                            ),
                          );
                          void place(payload.id, day, time, payload.day);
                        } catch {
                          /* Ignore unrelated drag payloads. */
                        }
                      }}
                    >
                      <button
                      className={`absolute inset-0 focus-visible:z-10 focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary ${selected ? "z-[2] cursor-crosshair hover:bg-primary/10" : ""}`}
                        disabled={busy || !selected}
                        aria-label={`${date} ${time}`}
                        onClick={() => {
                          if (selected) void place(selected, day, time);
                        }}
                      />
                      {items.map((row) => (
                        <button
                          key={row.def.id}
                          draggable={!busy}
                          disabled={busy}
                          onDragStart={(event) => drag(event, row.def.id, day)}
                          onClick={() => onEdit(row)}
                          aria-label={`${row.def.title} ${date} ${row.def.schedule!.time}`}
                          title={`${row.def.title} · ${row.def.schedule!.time}`}
                          className={`relative z-[1] m-0.5 min-w-0 flex-1 truncate rounded border px-1 text-left text-[10px] focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary ${row.def.enabled ? "border-primary/25 bg-primary/10 text-primary" : "border-dashed bg-muted text-muted-foreground"}`}
                        >
                          <span className="block truncate font-medium">
                            {row.def.title}
                          </span>
                          {row.def.schedule!.time}
                          {!row.def.enabled ? ` · ${t("tasks.state.off")}` : ""}
                        </button>
                      ))}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
