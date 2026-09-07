// 예약 카드 — 활성 팩이 선언한 예약 가능 액션 목록. 루틴 3종을 손으로 적어두던 자리다.
//
// 설정 draft 와 저장 버튼을 타지 않는다: 예약은 `set_schedule` 로 즉시 커밋되고
// (config 의 `dashboard.schedules` 에 재정의로 쌓인다) 목록 자체는 백엔드가 만든다.
// 그래서 이 카드는 draft 를 받지 않고 스토어를 직접 본다.
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

/** 예약 한 줄. 시각은 타이핑 중 저장하지 않고, 형식이 맞을 때만 커밋한다. */
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
