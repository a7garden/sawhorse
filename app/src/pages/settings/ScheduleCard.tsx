// Schedule card — list of schedulable actions declared by active packs. This is where
// the three routines used to be hand-written.
//
// Doesn't touch the settings draft or save button: schedules commit immediately via
// `set_schedule` (stacked as overrides in the config's `dashboard.schedules`), and the
// backend builds the list itself.
// So this card takes no draft and reads the store directly.
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/api";
import { useApp } from "@/lib/store";
import type { ScheduleView } from "@/lib/types";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Empty } from "../common";

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** One schedule row. The time isn't saved while typing; commits only when the format is valid. */
function ScheduleRow({
  entry,
  onSaved,
}: {
  entry: ScheduleView;
  onSaved: () => void;
}) {
  const { t } = useTranslation("settings");
  const [time, setTime] = useState(entry.time);
  const [err, setErr] = useState(false);
  useEffect(() => setTime(entry.time), [entry.time]);

  async function save(enabled: boolean, value: string) {
    if (!HHMM.test(value.trim())) {
      setErr(true);
      return;
    }
    setErr(false);
    try {
      await api.setSchedule(entry.key, enabled, value.trim());
      onSaved();
    } catch {
      setErr(true);
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Switch
        id={`sched-${entry.key}`}
        checked={entry.enabled}
        onCheckedChange={(on) => void save(on, time)}
      />
      <Label
        htmlFor={`sched-${entry.key}`}
        className="min-w-0 flex-1 truncate"
        title={entry.label}
      >
        {entry.label}
      </Label>
      <span className="shrink-0 text-[10px] text-muted-foreground">
        {entry.kind === "weekdays" ? t("schedule.weekdays") : t("schedule.daily")}
      </span>
      <Input
        className={`w-24 shrink-0 ${err ? "border-destructive" : ""}`}
        value={time}
        onChange={(e) => setTime(e.target.value)}
        onBlur={() => void save(entry.enabled, time)}
        placeholder="HH:MM"
        aria-label={t("schedule.timeAria", { label: entry.label })}
      />
    </div>
  );
}

export default function ScheduleCard({ onChange }: { onChange?: () => void }) {
  const { t } = useTranslation("settings");
  const schedules = useApp((s) => s.schedules);
  const refreshSchedules = useApp((s) => s.refreshSchedules);
  const refreshConfig = useApp((s) => s.refreshConfig);
  const onSaved = () => {
    void refreshSchedules();
    void refreshConfig();
    onChange?.();
  };

  return (
    <Card>
      <CardHeader className="pb-1">
        <CardTitle className="text-[13px]">{t("schedule.title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2.5">
        {schedules.length === 0 && (
          <Empty className="py-4">
            {t("schedule.empty")}
          </Empty>
        )}
        {schedules.map((s) => (
          <ScheduleRow key={s.key} entry={s} onSaved={onSaved} />
        ))}
        <p className="text-[11px] text-muted-foreground">
          {t("schedule.hint")}
        </p>
      </CardContent>
    </Card>
  );
}
