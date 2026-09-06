import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, CheckCircle2, FileSearch, Plus, RotateCcw, Save } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Textarea } from "@/components/ui/input";
import { PageHeader } from "@/pages/common";
import { schemaStudioApi } from "./api";
import type {
  ChangeSet,
  SchemaDiagnostic,
  SchemaMigrationPlan,
  SchemaScanResult,
  SchemaValidationReport,
  VaultSchema,
  SchemaDraftRecord,
  ActiveSchemaState,
} from "./types";

const SAMPLE_SCHEMA: VaultSchema = {
  schemaFormatVersion: 1,
  id: "team-vault",
  revision: 1,
  types: [
    {
      id: "team-vault.issue",
      label: "요청",
      storage: { path: "projects/{projectId}/issues/{id}.md" },
      fields: [
        {
          id: "title",
          key: "title",
          label: "제목",
          valueSchema: { type: "string", minLength: 1 },
          aliases: [],
          defaultValue: null,
        },
        {
          id: "status",
          key: "status",
          label: "상태",
          valueSchema: { enum: ["new", "active", "done"] },
          aliases: [],
          defaultValue: null,
        },
      ],
      requiredFieldIds: ["title", "status"],
      body: { templateRef: null, requiredSectionIds: [] },
    },
  ],
};

const INITIAL_SOURCE = `${JSON.stringify(SAMPLE_SCHEMA, null, 2)}\n`;

function Diagnostics({ rows }: { rows: SchemaDiagnostic[] }) {
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">진단이 없습니다.</p>;
  }
  return (
    <div className="space-y-2">
      {rows.map((row, index) => (
        <div
          key={`${row.code}-${row.path}-${index}`}
          className="rounded-md border px-3 py-2 text-sm"
        >
          <div className="flex items-center gap-2">
            <Badge variant={row.severity === "error" ? "destructive" : "warning"}>
              {row.severity === "error" ? "오류" : "경고"}
            </Badge>
            <span className="font-medium">{row.code}</span>
            <code className="ml-auto text-xs text-muted-foreground">{row.path}</code>
          </div>
          <p className="mt-1 text-muted-foreground">{row.message}</p>
        </div>
      ))}
    </div>
  );
}

export default function SchemaStudioPage() {
  const [source, setSource] = useState(INITIAL_SOURCE);
  const [validation, setValidation] = useState<SchemaValidationReport | null>(null);
  const [scan, setScan] = useState<SchemaScanResult | null>(null);
  const [plan, setPlan] = useState<SchemaMigrationPlan | null>(null);
  const [changeSet, setChangeSet] = useState<ChangeSet | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [mode, setMode] = useState<"visual" | "json">("visual");
  const [selectedType, setSelectedType] = useState(0);
  const [draftId, setDraftId] = useState(`schema-${crypto.randomUUID()}`);
  const [drafts, setDrafts] = useState<SchemaDraftRecord[]>([]);
  const [catalog, setCatalog] = useState<VaultSchema[]>([]);
  const [active, setActive] = useState<ActiveSchemaState | null>(null);

  function schema(): VaultSchema {
    const parsed: unknown = JSON.parse(source);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("스키마 JSON 최상위 값은 object여야 합니다.");
    }
    return parsed as VaultSchema;
  }

  async function loadLibrary() {
    const [nextDrafts, nextCatalog, nextActive] = await Promise.all([
      schemaStudioApi.drafts(),
      schemaStudioApi.catalog(),
      schemaStudioApi.active(),
    ]);
    setDrafts(nextDrafts);
    setCatalog(nextCatalog);
    setActive(nextActive);
  }

  useEffect(() => {
    void loadLibrary().catch((error) => setMessage(String(error)));
  }, []);

  const parsed = useMemo(() => {
    try {
      return schema();
    } catch {
      return null;
    }
  }, [source]);
  const artifactType = parsed?.types[selectedType] ?? null;

  function setSchema(next: VaultSchema) {
    setSource(`${JSON.stringify(next, null, 2)}\n`);
    resetDerived();
  }

  function patchSchema(patch: Partial<VaultSchema>) {
    if (parsed) setSchema({ ...parsed, ...patch });
  }

  function patchType(patch: Partial<VaultSchema["types"][number]>) {
    if (!parsed || !artifactType) return;
    setSchema({
      ...parsed,
      types: parsed.types.map((item, index) =>
        index === selectedType ? { ...item, ...patch } : item,
      ),
    });
  }

  function resetDerived() {
    setValidation(null);
    setScan(null);
    setPlan(null);
    setChangeSet(null);
    setMessage(null);
  }

  async function execute<T>(label: string, work: () => Promise<T>): Promise<T | null> {
    setBusy(label);
    setMessage(null);
    try {
      return await work();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function validateSchema() {
    const result = await execute("validate", () => schemaStudioApi.validate(schema()));
    if (result) setValidation(result);
  }

  async function scanVault() {
    const parsed = (() => {
      try {
        return schema();
      } catch (error) {
        setMessage(error instanceof Error ? error.message : String(error));
        return null;
      }
    })();
    if (!parsed) return;
    const report = await execute("scan", () => schemaStudioApi.validate(parsed));
    if (!report) return;
    setValidation(report);
    if (!report.valid) {
      setMessage("스키마 오류를 고친 뒤 볼트를 검사하세요.");
      return;
    }
    const result = await execute("scan", () => schemaStudioApi.scan(parsed));
    if (result) {
      setScan(result);
      setPlan(null);
      setChangeSet(null);
    }
  }

  async function buildPlan() {
    if (!scan) return;
    const result = await execute("plan", () => schemaStudioApi.plan(schema(), scan));
    if (result) {
      setPlan(result);
      setChangeSet(null);
    }
  }

  async function previewChangeSet() {
    if (!plan || plan.moves.length + plan.rewrites.length === 0 || plan.conflicts.length > 0) return;
    const result = await execute("preview", () => schemaStudioApi.preview(plan));
    if (result) setChangeSet(result);
  }

  async function applyChangeSet() {
    if (!changeSet || changeSet.status !== "previewed") return;
    const result = await execute("apply", () => schemaStudioApi.apply(changeSet.id));
    if (result) setChangeSet(result);
  }

  async function rollbackChangeSet() {
    if (!changeSet || !["applied", "conflict"].includes(changeSet.status)) return;
    const result = await execute("rollback", () => schemaStudioApi.rollback(changeSet.id));
    if (result) setChangeSet(result);
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <PageHeader
        title="스키마 작업대"
        desc="문서 타입과 경로를 검사하고, 해시로 보호된 변경 계획만 볼트에 적용합니다."
      />
      <div className="min-h-0 flex-1 overflow-auto p-6">
        <div className="mx-auto grid max-w-7xl gap-5 xl:grid-cols-[minmax(0,1.05fr)_minmax(420px,0.95fr)]">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                스키마 정의
                {active && <Badge variant="success">활성 {active.id} r{active.revision}</Badge>}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant={mode === "visual" ? "secondary" : "ghost"} onClick={() => setMode("visual")}>시각 편집</Button>
                <Button size="sm" variant={mode === "json" ? "secondary" : "ghost"} onClick={() => setMode("json")}>고급 JSON</Button>
              </div>
              {mode === "json" ? (
                <Textarea
                  aria-label="VaultSchema JSON"
                  className="min-h-[560px] resize-y font-mono text-xs leading-5"
                  value={source}
                  onChange={(event) => { setSource(event.target.value); resetDerived(); }}
                  spellCheck={false}
                />
              ) : parsed ? (
                <div className="space-y-4">
                  <div className="grid gap-3 sm:grid-cols-3">
                    <label className="text-xs">스키마 ID<Input value={parsed.id} onChange={(event) => patchSchema({ id: event.target.value })} /></label>
                    <label className="text-xs">Revision<Input type="number" min={1} value={parsed.revision} onChange={(event) => patchSchema({ revision: Number(event.target.value) })} /></label>
                    <label className="text-xs">초안 ID<Input value={draftId} onChange={(event) => setDraftId(event.target.value)} /></label>
                  </div>
                  <div className="grid gap-4 lg:grid-cols-[190px_1fr]">
                    <div className="space-y-2">
                      <p className="text-xs font-semibold text-muted-foreground">문서 타입</p>
                      {parsed.types.map((item, index) => <button key={`${item.id}-${index}`} className={`w-full rounded-md border p-2 text-left text-xs ${selectedType === index ? "border-primary bg-primary/5" : ""}`} onClick={() => setSelectedType(index)}><strong className="block">{item.label}</strong><code>{item.id}</code></button>)}
                      <Button size="sm" variant="outline" className="w-full" onClick={() => { const index = parsed.types.length; patchSchema({ types: [...parsed.types, { id: `${parsed.id}.type-${index + 1}`, label: "새 문서", storage: { path: `documents/{id}.md` }, fields: [], requiredFieldIds: [], body: { templateRef: null, requiredSectionIds: [] } }] }); setSelectedType(index); }}><Plus /> 타입</Button>
                    </div>
                    {artifactType && <div className="space-y-3 rounded-lg border p-4">
                      <div className="grid gap-3 sm:grid-cols-2">
                        <label className="text-xs">타입 ID<Input value={artifactType.id} onChange={(event) => patchType({ id: event.target.value })} /></label>
                        <label className="text-xs">표시 이름<Input value={artifactType.label} onChange={(event) => patchType({ label: event.target.value })} /></label>
                        <label className="text-xs sm:col-span-2">저장 경로<Input value={artifactType.storage.path} onChange={(event) => patchType({ storage: { path: event.target.value } })} /></label>
                        <label className="text-xs">템플릿 참조<Input value={artifactType.body.templateRef ?? ""} onChange={(event) => patchType({ body: { ...artifactType.body, templateRef: event.target.value || null } })} /></label>
                        <label className="text-xs">필수 섹션(쉼표)<Input value={artifactType.body.requiredSectionIds.join(", ")} onChange={(event) => patchType({ body: { ...artifactType.body, requiredSectionIds: event.target.value.split(",").map((value) => value.trim()).filter(Boolean) } })} /></label>
                      </div>
                      <p className="text-xs font-semibold text-muted-foreground">Frontmatter 필드</p>
                      {artifactType.fields.map((field, index) => <div key={`${field.id}-${index}`} className="grid gap-2 rounded-md bg-muted p-3 sm:grid-cols-2">
                        <Input aria-label="필드 ID" value={field.id} onChange={(event) => patchType({ fields: artifactType.fields.map((item, fieldIndex) => fieldIndex === index ? { ...item, id: event.target.value } : item) })} />
                        <Input aria-label="frontmatter key" value={field.key} onChange={(event) => patchType({ fields: artifactType.fields.map((item, fieldIndex) => fieldIndex === index ? { ...item, key: event.target.value } : item) })} />
                        <Input aria-label="필드 이름" value={field.label} onChange={(event) => patchType({ fields: artifactType.fields.map((item, fieldIndex) => fieldIndex === index ? { ...item, label: event.target.value } : item) })} />
                        <Input aria-label="이전 key" placeholder="이전 key, 쉼표" value={(field.aliases ?? []).join(", ")} onChange={(event) => patchType({ fields: artifactType.fields.map((item, fieldIndex) => fieldIndex === index ? { ...item, aliases: event.target.value.split(",").map((value) => value.trim()).filter(Boolean) } : item) })} />
                        <Input aria-label="값 스키마" className="font-mono text-xs" value={JSON.stringify(field.valueSchema)} onChange={(event) => { try { const valueSchema = JSON.parse(event.target.value); patchType({ fields: artifactType.fields.map((item, fieldIndex) => fieldIndex === index ? { ...item, valueSchema } : item) }); } catch { setMessage("값 스키마 JSON을 확인하세요."); } }} />
                        <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={artifactType.requiredFieldIds.includes(field.id)} onChange={(event) => patchType({ requiredFieldIds: event.target.checked ? [...artifactType.requiredFieldIds, field.id] : artifactType.requiredFieldIds.filter((id) => id !== field.id) })} /> 필수</label>
                      </div>)}
                      <Button size="sm" variant="outline" onClick={() => patchType({ fields: [...artifactType.fields, { id: `field-${artifactType.fields.length + 1}`, key: `field${artifactType.fields.length + 1}`, label: "새 필드", valueSchema: { type: "string" }, aliases: [], defaultValue: null }] })}><Plus /> 필드</Button>
                    </div>}
                  </div>
                </div>
              ) : <p className="text-sm text-destructive">JSON을 고급 모드에서 수정하세요.</p>}
              <div className="space-y-2 rounded-md border p-3">
                <p className="text-xs font-semibold">발행 라이브러리</p>
                <div className="flex flex-wrap gap-1">{catalog.map((item) => <Button key={`${item.id}-${item.revision}`} size="sm" variant="ghost" onClick={() => { setSchema(item); setSelectedType(0); }}>{item.id} r{item.revision}</Button>)}</div>
                <p className="text-xs font-semibold">초안</p>
                <div className="flex flex-wrap gap-1">{drafts.map((item) => <Button key={item.draftId} size="sm" variant="ghost" onClick={() => { setSchema(item.schema); setDraftId(item.draftId); setSelectedType(0); }}>{item.schema.id} r{item.schema.revision}</Button>)}</div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="secondary" onClick={() => void execute("draft", async () => { const record = await schemaStudioApi.saveDraft(draftId, schema()); setValidation(record.validation); await loadLibrary(); })} disabled={busy !== null}><Save className="mr-2 size-4" />초안 저장</Button>
                <Button onClick={() => void validateSchema()} disabled={busy !== null}>
                  정의 검증
                </Button>
                <Button variant="outline" onClick={() => void execute("publish", async () => { await schemaStudioApi.publish(schema()); await loadLibrary(); setMessage("불변 schema revision을 발행했습니다."); })} disabled={busy !== null}>버전 발행</Button>
                <Button
                  variant="secondary"
                  onClick={() => void scanVault()}
                  disabled={busy !== null}
                >
                  <FileSearch className="mr-2 size-4" />
                  볼트 검사
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                지원 경로 변수: {"{id}"}, {"{projectId}"}, {"{slug}"}. 관리 문서는
                frontmatter의 id와 typeId로 식별합니다.
              </p>
            </CardContent>
          </Card>

          <div className="space-y-5">
            {message && (
              <div className="flex gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" />
                {message}
              </div>
            )}

            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  정의 진단
                  {validation && (
                    <Badge variant={validation.valid ? "success" : "destructive"}>
                      {validation.valid ? "유효" : "수정 필요"}
                    </Badge>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {validation ? (
                  <Diagnostics rows={validation.diagnostics} />
                ) : (
                  <p className="text-sm text-muted-foreground">정의를 먼저 검증하세요.</p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>볼트 검사</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {scan ? (
                  <>
                    <div className="grid grid-cols-3 gap-2 text-center text-sm">
                      <div className="rounded-md bg-muted p-3">
                        <strong className="block text-lg">{scan.scannedFiles}</strong>파일
                      </div>
                      <div className="rounded-md bg-muted p-3">
                        <strong className="block text-lg">{scan.managedArtifacts.length}</strong>
                        관리됨
                      </div>
                      <div className="rounded-md bg-muted p-3">
                        <strong className="block text-lg">{scan.unmanagedMarkdown.length}</strong>
                        보존됨
                      </div>
                    </div>
                    <Diagnostics rows={scan.diagnostics} />
                    <Button
                      variant="secondary"
                      onClick={() => void buildPlan()}
                      disabled={busy !== null}
                    >
                      이동 계획 만들기
                    </Button>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    검증된 스키마로 검사하면 관리 문서와 보존할 일반 Markdown을 구분합니다.
                  </p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>변경 계획과 적용</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {!plan ? (
                  <p className="text-sm text-muted-foreground">볼트 검사 뒤 이동 계획을 만드세요.</p>
                ) : (
                  <>
                    <div className="space-y-2">
                      {plan.moves.map((move) => (
                        <div key={`${move.source}-${move.target}`} className="rounded-md border p-3 text-sm">
                          <code>{move.source}</code>
                          <span className="mx-2 text-muted-foreground">→</span>
                          <code>{move.target}</code>
                        </div>
                      ))}
                      {plan.moves.length === 0 && (
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <CheckCircle2 className="size-4 text-success" /> 이동할 문서가 없습니다.
                        </div>
                      )}
                      {plan.rewrites.map((rewrite) => (
                        <div key={`rewrite-${rewrite.source}`} className="rounded-md border p-3 text-sm">
                          <code>{rewrite.source}</code>
                          <span className="ml-2 text-muted-foreground">
                            필드 {rewrite.fieldChanges} · 링크 {rewrite.linkChanges}
                          </span>
                        </div>
                      ))}
                    </div>
                    <Diagnostics rows={plan.conflicts} />
                    <Button
                      onClick={() => void previewChangeSet()}
                      disabled={
                        busy !== null || plan.moves.length + plan.rewrites.length === 0 || plan.conflicts.length > 0
                      }
                    >
                      ChangeSet 미리보기
                    </Button>
                  </>
                )}

                {changeSet && (
                  <div className="space-y-3 border-t pt-4">
                    <div className="flex items-center gap-2 text-sm">
                      <Badge variant={changeSet.status === "conflict" ? "destructive" : "outline"}>
                        {changeSet.status}
                      </Badge>
                      <code className="truncate text-xs text-muted-foreground">{changeSet.id}</code>
                    </div>
                    {changeSet.operations.map((operation) => (
                      <div key={operation.id} className="rounded-md bg-muted p-3 text-xs">
                        <div className="flex items-center gap-2">
                          <strong>{operation.kind}</strong>
                          <span>{operation.status}</span>
                        </div>
                        <div className="mt-1 font-mono">{operation.source ?? "(new)"} → {operation.target}</div>
                        {operation.error && <p className="mt-1 text-destructive">{operation.error}</p>}
                      </div>
                    ))}
                    <div className="flex gap-2">
                      <Button
                        onClick={() => void applyChangeSet()}
                        disabled={busy !== null || changeSet.status !== "previewed"}
                      >
                        변경 적용
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={() => void execute("activate", async () => {
                          const state = await schemaStudioApi.activate(schema(), changeSet.id);
                          setActive(state);
                          setMessage(`schema ${state.id} revision ${state.revision}을 활성화했습니다.`);
                        })}
                        disabled={busy !== null || changeSet.status !== "applied"}
                      >
                        활성화
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => void rollbackChangeSet()}
                        disabled={
                          busy !== null || !["applied", "conflict"].includes(changeSet.status)
                        }
                      >
                        <RotateCcw className="mr-2 size-4" />
                        롤백
                      </Button>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
