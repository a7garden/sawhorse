// CollaborationSection — 설정 > 협업 섹션. 승인 정책 선택, 등록 프로젝트의 통합
// 대상 표시, 검증 프로필 편집, legacy 프로젝트 등록을 맡는다. 정책은 다른 draft
// 값과 달리 즉시 커밋한다 — 활성 세션은 시작 때 찍은 snapshot을 따르므로 안전.
import { useCallback, useEffect, useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/api";
import type {
  CollabProjectsView,
  CollabVerifyCheck,
  ConfigView,
  LocalIntegrationApproval,
} from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Empty } from "../common";
import { Notice, SectionCard } from "./parts";

const APPROVAL_OPTIONS: { value: LocalIntegrationApproval; key: string }[] = [
  { value: "required", key: "collab.approval.required" },
  { value: "autoAfterPreflight", key: "collab.approval.autoAfterPreflight" },
];

interface CheckDraft {
  kind: "command" | "http";
  cwd: string;
  argv: string; // 쉼표 구분 입력
  url: string;
}

function emptyCheck(kind: "command" | "http"): CheckDraft {
  return { kind, cwd: "", argv: "", url: "" };
}

function draftToCheck(d: CheckDraft): CollabVerifyCheck | null {
  if (d.kind === "http") {
    return d.url.trim() ? { kind: "http", url: d.url.trim() } : null;
  }
  const argv = d.argv
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (argv.length === 0) return null;
  return { kind: "command", cwd: d.cwd.trim(), argv };
}

function checkToDraft(c: CollabVerifyCheck): CheckDraft {
  if (c.kind === "http") return { kind: "http", cwd: "", argv: "", url: c.url };
  return { kind: "command", cwd: c.cwd, argv: c.argv.join(", "), url: "" };
}

export default function CollaborationSection({
  draft,
  patchDraft,
}: {
  draft: ConfigView;
  patchDraft: (fn: (d: ConfigView) => void) => void;
}) {
  const { t } = useTranslation("settings");
  const [projects, setProjects] = useState<CollabProjectsView | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  // 검증 프로필 폼
  const [profileProject, setProfileProject] = useState("");
  const [profileName, setProfileName] = useState("");
  const [checks, setChecks] = useState<CheckDraft[]>([]);
  const [manual, setManual] = useState<string[]>([]);

  const reload = useCallback(() => {
    void api
      .collabProjectsView()
      .then(setProjects)
      .catch(() => setProjects(null));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  async function setApproval(v: LocalIntegrationApproval) {
    patchDraft((d) => {
      d.dashboard.collaboration.localIntegrationApproval = v;
    });
    try {
      await api.saveConfig({
        dashboard: { collaboration: { localIntegrationApproval: v } },
      });
      setMsg({ ok: true, text: t("collab.approval.saved") });
    } catch (e) {
      setMsg({
        ok: false,
        text: t("collab.approval.saveFailed", { error: String(e) }),
      });
    }
  }

  async function saveProfile() {
    if (!profileProject) {
      setMsg({ ok: false, text: t("collab.projectRequired") });
      return;
    }
    if (profileName.trim().length === 0) {
      setMsg({ ok: false, text: t("collab.nameRequired") });
      return;
    }
    const built = checks
      .map(draftToCheck)
      .filter((c): c is CollabVerifyCheck => c != null);
    const manualList = manual.map((m) => m.trim()).filter(Boolean);
    setBusy(true);
    setMsg(null);
    try {
      await api.collabSaveVerifyProfile(profileProject, profileName.trim(), {
        checks: built,
        manual: manualList,
      });
      setMsg({
        ok: true,
        text: t("collab.profileSaved", { name: profileName.trim() }),
      });
      reload();
    } catch (e) {
      setMsg({
        ok: false,
        text: t("collab.profileSaveFailed", { error: String(e) }),
      });
    } finally {
      setBusy(false);
    }
  }

  async function register(
    name: string,
    path: string,
    branch: string,
    verifyProfile: string,
  ) {
    setBusy(true);
    setMsg(null);
    try {
      await api.collabRegisterProject(name, path, branch, verifyProfile);
      setMsg({ ok: true, text: t("collab.registeredMsg", { name }) });
      reload();
    } catch (e) {
      setMsg({
        ok: false,
        text: t("collab.registerFailed", { error: String(e) }),
      });
    } finally {
      setBusy(false);
    }
  }

  const registeredPaths = new Set(
    (projects?.registered ?? []).map((r) => r.path),
  );

  return (
    <div className="space-y-4">
      {msg && <Notice ok={msg.ok} text={msg.text} />}

      <SectionCard
        title={t("collab.approval.title")}
        desc={t("collab.approval.hint")}
      >
        <Select
          className="w-full sm:w-80"
          value={draft.dashboard.collaboration.localIntegrationApproval}
          onChange={(v) => void setApproval(v as LocalIntegrationApproval)}
          aria-label={t("collab.approval.aria")}
          options={APPROVAL_OPTIONS.map((o) => ({
            value: o.value,
            label: t(o.key),
          }))}
        />
      </SectionCard>

      <SectionCard
        title={t("collab.registeredTitle")}
        desc={t("collab.registeredDesc")}
        actions={
          (projects?.registered.length ?? 0) > 0 && (
            <span className="text-xs text-muted-foreground">
              {t("collab.registeredCount", {
                count: projects?.registered.length ?? 0,
              })}
            </span>
          )
        }
      >
        <div className="space-y-2">
          {projects && projects.registered.length === 0 && (
            <Empty className="py-3">{t("collab.noRegistered")}</Empty>
          )}
          {(projects?.registered ?? []).map((p) => (
            <div
              key={p.id}
              className="space-y-0.5 rounded-lg border p-2.5 text-xs"
            >
              <div className="font-medium">{p.name}</div>
              <div className="text-muted-foreground">
                {t("collab.path", { path: p.path })}
              </div>
              <div className="text-muted-foreground">
                {t("collab.integration", {
                  path: p.integration.path || p.path,
                  branch: p.integration.branch || t("collab.defaultBranch"),
                  profile: p.integration.verifyProfile || t("collab.defaultProfile"),
                })}
              </div>
            </div>
          ))}
        </div>
      </SectionCard>

      <SectionCard
        title={t("collab.profileTitle")}
        desc={t("collab.profileDesc")}
      >
        <div className="space-y-2">
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label>{t("collab.projectLabel")}</Label>
              <Select
                className="w-full"
                value={profileProject}
                onChange={(v) => setProfileProject(v)}
                options={[
                  { value: "", label: t("collab.select") },
                  ...(projects?.registered ?? []).map((p) => ({
                    value: p.id,
                    label: p.name,
                  })),
                ]}
              />
            </div>
            <div className="space-y-1">
              <Label>{t("collab.profileName")}</Label>
              <Input
                className="w-full"
                value={profileName}
                onChange={(e) => {
                  const name = e.target.value;
                  setProfileName(name);
                  const existing = profileProject
                    ? draft.coreProjects[profileProject]?.verifyProfiles[name]
                    : undefined;
                  if (existing) {
                    setChecks(existing.checks.map(checkToDraft));
                    setManual([...existing.manual]);
                  }
                }}
                placeholder={t("collab.profileNamePlaceholder")}
              />
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>{t("collab.autoChecks")}</Label>
              <div className="flex gap-1">
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() =>
                    setChecks((cs) => [...cs, emptyCheck("command")])
                  }
                >
                  <Plus /> {t("collab.command")}
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => setChecks((cs) => [...cs, emptyCheck("http")])}
                >
                  <Plus /> HTTP
                </Button>
              </div>
            </div>
            {checks.length === 0 && (
              <Empty className="py-2">{t("collab.noChecks")}</Empty>
            )}
            {checks.map((c, i) => (
              <div key={i} className="space-y-1 rounded-lg border p-2.5">
                <div className="flex items-center gap-2">
                  <Select
                    value={c.kind}
                    onChange={(v) =>
                      setChecks((cs) =>
                        cs.map((x, j) =>
                          j === i
                            ? {
                                ...x,
                                kind: v as "command" | "http",
                              }
                            : x,
                        ),
                      )
                    }
                    aria-label={t("collab.checkKindAria", { index: i + 1 })}
                    options={[
                      { value: "command", label: t("collab.command") },
                      { value: "http", label: t("collab.http") },
                    ]}
                  />
                  <Button
                    size="icon"
                    variant="ghost"
                    aria-label={t("collab.checkDeleteAria", { index: i + 1 })}
                    onClick={() =>
                      setChecks((cs) => cs.filter((_, j) => j !== i))
                    }
                  >
                    <Trash2 />
                  </Button>
                </div>
                {c.kind === "command" ? (
                  <div className="grid grid-cols-2 gap-2">
                    <Input
                      className="h-7"
                      value={c.cwd}
                      onChange={(e) =>
                        setChecks((cs) =>
                          cs.map((x, j) =>
                            j === i ? { ...x, cwd: e.target.value } : x,
                          ),
                        )
                      }
                      placeholder={t("collab.cwdPlaceholder")}
                      aria-label={t("collab.cwdAria", { index: i + 1 })}
                    />
                    <Input
                      className="h-7"
                      value={c.argv}
                      onChange={(e) =>
                        setChecks((cs) =>
                          cs.map((x, j) =>
                            j === i ? { ...x, argv: e.target.value } : x,
                          ),
                        )
                      }
                      placeholder={t("collab.argvPlaceholder")}
                      aria-label={t("collab.argvAria", { index: i + 1 })}
                    />
                  </div>
                ) : (
                  <Input
                    className="h-7"
                    value={c.url}
                    onChange={(e) =>
                      setChecks((cs) =>
                        cs.map((x, j) =>
                          j === i ? { ...x, url: e.target.value } : x,
                        ),
                      )
                    }
                    placeholder="http://localhost:5173"
                    aria-label={t("collab.urlAria", { index: i + 1 })}
                  />
                )}
              </div>
            ))}
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>{t("collab.manualTitle")}</Label>
              <Button
                size="xs"
                variant="outline"
                onClick={() => setManual((ms) => [...ms, ""])}
              >
                <Plus /> {t("collab.addItem")}
              </Button>
            </div>
            {manual.length === 0 && (
              <Empty className="py-2">
                {t("collab.noManual")}
              </Empty>
            )}
            {manual.map((m, i) => (
              <div key={i} className="flex items-center gap-2">
                <Textarea
                  className="min-h-[36px] flex-1"
                  rows={1}
                  value={m}
                  onChange={(e) =>
                    setManual((ms) =>
                      ms.map((x, j) => (j === i ? e.target.value : x)),
                    )
                  }
                  placeholder={t("collab.manualPlaceholder")}
                  aria-label={t("collab.manualAria", { index: i + 1 })}
                />
                <Button
                  size="icon"
                  variant="ghost"
                  aria-label={t("collab.manualDeleteAria", { index: i + 1 })}
                  onClick={() =>
                    setManual((ms) => ms.filter((_, j) => j !== i))
                  }
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
          </div>

          <div className="flex justify-end">
            <Button
              size="sm"
              disabled={busy}
              onClick={() => void saveProfile()}
            >
              {t("collab.saveProfile")}
            </Button>
          </div>
        </div>
      </SectionCard>

      <SectionCard
        title={t("collab.legacyTitle")}
        desc={t("collab.legacyDesc")}
      >
        <div className="space-y-2">
          {projects && projects.legacy.length === 0 && (
            <Empty className="py-3">
              {t("collab.noLegacy")}
            </Empty>
          )}
          {(projects?.legacy ?? []).map((p) => (
            <div
              key={p.name}
              className="flex items-center gap-2 rounded-lg border p-2.5 text-xs"
            >
              <div className="min-w-0 flex-1">
                <div className="font-medium">{p.name}</div>
                <div className="text-muted-foreground">
                  {t("collab.legacyMeta", {
                    path: p.path,
                    branch: p.workBranch || t("collab.defaultBranch"),
                    verify: p.verify || t("collab.verifyNone"),
                  })}
                </div>
              </div>
              <Button
                size="xs"
                variant="outline"
                disabled={busy || registeredPaths.has(p.path)}
                onClick={() =>
                  void register(p.name, p.path, p.workBranch, p.verify)
                }
              >
                {t("collab.register")}
              </Button>
            </div>
          ))}
        </div>
      </SectionCard>
    </div>
  );
}
