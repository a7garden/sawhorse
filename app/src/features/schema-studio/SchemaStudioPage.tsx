import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  CheckCircle2,
  FileSearch,
  Plus,
  RotateCcw,
  Save,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Textarea } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
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
  const { t } = useTranslation("dashboard");
  if (rows.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {t("schemaStudio.noDiagnostics")}
      </p>
    );
  }
  return (
    <div className="space-y-2">
      {rows.map((row, index) => (
        <div
          key={`${row.code}-${row.path}-${index}`}
          className="rounded-md border px-3 py-2 text-sm"
        >
          <div className="flex items-center gap-2">
            <Badge
              variant={row.severity === "error" ? "destructive" : "warning"}
            >
              {row.severity === "error"
                ? t("schemaStudio.error")
                : t("schemaStudio.warning")}
            </Badge>
            <span className="font-medium">{row.code}</span>
            <code className="ml-auto text-xs text-muted-foreground">
              {row.path}
            </code>
          </div>
          <p className="mt-1 text-muted-foreground">{row.message}</p>
        </div>
      ))}
    </div>
  );
}

export default function SchemaStudioPage() {
  const { t } = useTranslation("dashboard");
  const [source, setSource] = useState(INITIAL_SOURCE);
  const [validation, setValidation] = useState<SchemaValidationReport | null>(
    null,
  );
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
      throw new Error(t("schemaStudio.topLevelObject"));
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
  }, [source, t]);
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

  async function execute<T>(
    label: string,
    work: () => Promise<T>,
  ): Promise<T | null> {
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
    const result = await execute("validate", () =>
      schemaStudioApi.validate(schema()),
    );
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
    const report = await execute("scan", () =>
      schemaStudioApi.validate(parsed),
    );
    if (!report) return;
    setValidation(report);
    if (!report.valid) {
      setMessage(t("schemaStudio.fixSchemaFirst"));
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
    const result = await execute("plan", () =>
      schemaStudioApi.plan(schema(), scan),
    );
    if (result) {
      setPlan(result);
      setChangeSet(null);
    }
  }

  async function previewChangeSet() {
    if (
      !plan ||
      plan.moves.length + plan.rewrites.length === 0 ||
      plan.conflicts.length > 0
    )
      return;
    const result = await execute("preview", () =>
      schemaStudioApi.preview(plan),
    );
    if (result) setChangeSet(result);
  }

  async function applyChangeSet() {
    if (!changeSet || changeSet.status !== "previewed") return;
    const result = await execute("apply", () =>
      schemaStudioApi.apply(changeSet.id),
    );
    if (result) setChangeSet(result);
  }

  async function rollbackChangeSet() {
    if (!changeSet || !["applied", "conflict"].includes(changeSet.status))
      return;
    const result = await execute("rollback", () =>
      schemaStudioApi.rollback(changeSet.id),
    );
    if (result) setChangeSet(result);
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <PageHeader title={t("schemaStudio.title")} />
      <div className="min-h-0 flex-1 overflow-auto p-6">
        <div className="mx-auto grid max-w-7xl gap-5 xl:grid-cols-[minmax(0,1.05fr)_minmax(420px,0.95fr)]">
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                {t("schemaStudio.typesAndFields")}
                {active && (
                  <Badge variant="success">
                    {t("schemaStudio.activeBadge", {
                      id: active.id,
                      revision: active.revision,
                    })}
                  </Badge>
                )}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant={mode === "visual" ? "secondary" : "ghost"}
                  onClick={() => setMode("visual")}
                >
                  {t("schemaStudio.visualEdit")}
                </Button>
                <Button
                  size="sm"
                  variant={mode === "json" ? "secondary" : "ghost"}
                  onClick={() => setMode("json")}
                >
                  {t("schemaStudio.advancedJson")}
                </Button>
              </div>
              {mode === "json" ? (
                <Textarea
                  aria-label="VaultSchema JSON"
                  className="min-h-[560px] resize-y font-mono text-xs leading-5"
                  value={source}
                  onChange={(event) => {
                    setSource(event.target.value);
                    resetDerived();
                  }}
                  spellCheck={false}
                />
              ) : parsed ? (
                <div className="space-y-4">
                  <div className="grid gap-3 sm:grid-cols-3">
                    <label className="text-xs">
                      {t("schemaStudio.schemaId")}
                      <Input
                        value={parsed.id}
                        onChange={(event) =>
                          patchSchema({ id: event.target.value })
                        }
                      />
                    </label>
                    <label className="text-xs">
                      Revision
                      <Input
                        type="number"
                        min={1}
                        value={parsed.revision}
                        onChange={(event) =>
                          patchSchema({ revision: Number(event.target.value) })
                        }
                      />
                    </label>
                    <label className="text-xs">
                      {t("schemaStudio.draftId")}
                      <Input
                        value={draftId}
                        onChange={(event) => setDraftId(event.target.value)}
                      />
                    </label>
                  </div>
                  <div className="grid gap-4 lg:grid-cols-[190px_1fr]">
                    <div className="space-y-2">
                      <p className="text-xs font-semibold text-muted-foreground">
                        {t("schemaStudio.types")}
                      </p>
                      {parsed.types.map((item, index) => (
                        <button
                          key={`${item.id}-${index}`}
                          className={`w-full rounded-md border p-2 text-left text-xs ${selectedType === index ? "border-primary bg-primary/5" : ""}`}
                          onClick={() => setSelectedType(index)}
                        >
                          <strong className="block">{item.label}</strong>
                          <code>{item.id}</code>
                        </button>
                      ))}
                      <Button
                        size="sm"
                        variant="outline"
                        className="w-full"
                        onClick={() => {
                          const index = parsed.types.length;
                          patchSchema({
                            types: [
                              ...parsed.types,
                              {
                                id: `${parsed.id}.type-${index + 1}`,
                                label: "새 문서",
                                storage: { path: `documents/{id}.md` },
                                fields: [],
                                requiredFieldIds: [],
                                body: {
                                  templateRef: null,
                                  requiredSectionIds: [],
                                },
                              },
                            ],
                          });
                          setSelectedType(index);
                        }}
                      >
                        <Plus /> {t("schemaStudio.addType")}
                      </Button>
                    </div>
                    {artifactType && (
                      <div className="space-y-3 rounded-lg border p-4">
                        <div className="grid gap-3 sm:grid-cols-2">
                          <label className="text-xs">
                            {t("schemaStudio.typeId")}
                            <Input
                              value={artifactType.id}
                              onChange={(event) =>
                                patchType({ id: event.target.value })
                              }
                            />
                          </label>
                          <label className="text-xs">
                            {t("schemaStudio.displayName")}
                            <Input
                              value={artifactType.label}
                              onChange={(event) =>
                                patchType({ label: event.target.value })
                              }
                            />
                          </label>
                          <label className="text-xs sm:col-span-2">
                            {t("schemaStudio.storagePath")}
                            <Input
                              value={artifactType.storage.path}
                              onChange={(event) =>
                                patchType({
                                  storage: { path: event.target.value },
                                })
                              }
                            />
                          </label>
                          <label className="text-xs">
                            {t("schemaStudio.templateRef")}
                            <Input
                              value={artifactType.body.templateRef ?? ""}
                              onChange={(event) =>
                                patchType({
                                  body: {
                                    ...artifactType.body,
                                    templateRef: event.target.value || null,
                                  },
                                })
                              }
                            />
                          </label>
                          <label className="text-xs">
                            {t("schemaStudio.requiredSections")}
                            <Input
                              value={artifactType.body.requiredSectionIds.join(
                                ", ",
                              )}
                              onChange={(event) =>
                                patchType({
                                  body: {
                                    ...artifactType.body,
                                    requiredSectionIds: event.target.value
                                      .split(",")
                                      .map((value) => value.trim())
                                      .filter(Boolean),
                                  },
                                })
                              }
                            />
                          </label>
                        </div>
                        <p className="text-xs font-semibold text-muted-foreground">
                          {t("schemaStudio.fields")}
                        </p>
                        {artifactType.fields.map((field, index) => (
                          <div
                            key={index}
                            className="grid gap-2 rounded-md bg-muted p-3 sm:grid-cols-2"
                          >
                            <Input
                              aria-label={t("schemaStudio.fieldId")}
                              value={field.id}
                              onChange={(event) =>
                                patchType({
                                  fields: artifactType.fields.map(
                                    (item, fieldIndex) =>
                                      fieldIndex === index
                                        ? { ...item, id: event.target.value }
                                        : item,
                                  ),
                                  requiredFieldIds:
                                    artifactType.requiredFieldIds.map((id) =>
                                      id === field.id ? event.target.value : id,
                                    ),
                                })
                              }
                            />
                            <Input
                              aria-label="frontmatter key"
                              value={field.key}
                              onChange={(event) =>
                                patchType({
                                  fields: artifactType.fields.map(
                                    (item, fieldIndex) =>
                                      fieldIndex === index
                                        ? { ...item, key: event.target.value }
                                        : item,
                                  ),
                                })
                              }
                            />
                            <Input
                              aria-label={t("schemaStudio.fieldName")}
                              value={field.label}
                              onChange={(event) =>
                                patchType({
                                  fields: artifactType.fields.map(
                                    (item, fieldIndex) =>
                                      fieldIndex === index
                                        ? { ...item, label: event.target.value }
                                        : item,
                                  ),
                                })
                              }
                            />
                            <Input
                              aria-label={t("schemaStudio.prevKey")}
                              placeholder={t(
                                "schemaStudio.prevKeyPlaceholder",
                              )}
                              value={(field.aliases ?? []).join(", ")}
                              onChange={(event) =>
                                patchType({
                                  fields: artifactType.fields.map(
                                    (item, fieldIndex) =>
                                      fieldIndex === index
                                        ? {
                                            ...item,
                                            aliases: event.target.value
                                              .split(",")
                                              .map((value) => value.trim())
                                              .filter(Boolean),
                                          }
                                        : item,
                                  ),
                                })
                              }
                            />
                            <label className="text-xs">
                              {t("schemaStudio.inputType")}
                              <Select
                                aria-label={t("schemaStudio.inputType")}
                                className="mt-1"
                                value={
                                  Array.isArray(field.valueSchema.enum)
                                    ? "enum"
                                    : String(field.valueSchema.type ?? "custom")
                                }
                                onChange={(v) => {
                                  const valueSchema =
                                    v === "enum"
                                      ? { enum: ["새 항목"] }
                                      : v === "custom"
                                        ? field.valueSchema
                                        : { type: v };
                                  patchType({
                                    fields: artifactType.fields.map(
                                      (item, j) =>
                                        j === index
                                          ? { ...item, valueSchema }
                                          : item,
                                    ),
                                  });
                                }}
                                options={[
                                  {
                                    value: "string",
                                    label: t("schemaStudio.inputTypes.string"),
                                  },
                                  {
                                    value: "number",
                                    label: t("schemaStudio.inputTypes.number"),
                                  },
                                  {
                                    value: "integer",
                                    label: t("schemaStudio.inputTypes.integer"),
                                  },
                                  {
                                    value: "boolean",
                                    label: t("schemaStudio.inputTypes.boolean"),
                                  },
                                  {
                                    value: "enum",
                                    label: t("schemaStudio.inputTypes.enum"),
                                  },
                                  {
                                    value: "custom",
                                    label: t("schemaStudio.inputTypes.custom"),
                                  },
                                ]}
                              />
                            </label>
                            {Array.isArray(field.valueSchema.enum) && (
                              <label className="text-xs">
                                {t("schemaStudio.enumValues")}
                                <Input
                                  aria-label={t("schemaStudio.enumValuesAria")}
                                  value={field.valueSchema.enum.join(", ")}
                                  onChange={(event) =>
                                    patchType({
                                      fields: artifactType.fields.map(
                                        (item, j) =>
                                          j === index
                                            ? {
                                                ...item,
                                                valueSchema: {
                                                  ...item.valueSchema,
                                                  enum: event.target.value
                                                    .split(",")
                                                    .map((v) => v.trim()),
                                                },
                                              }
                                            : item,
                                      ),
                                    })
                                  }
                                />
                              </label>
                            )}

                            <label className="flex items-center gap-2 text-xs">
                              <input
                                type="checkbox"
                                checked={artifactType.requiredFieldIds.includes(
                                  field.id,
                                )}
                                onChange={(event) =>
                                  patchType({
                                    requiredFieldIds: event.target.checked
                                      ? [
                                          ...artifactType.requiredFieldIds,
                                          field.id,
                                        ]
                                      : artifactType.requiredFieldIds.filter(
                                          (id) => id !== field.id,
                                        ),
                                  })
                                }
                              />{" "}
                              {t("schemaStudio.required")}
                            </label>
                          </div>
                        ))}
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() =>
                            patchType({
                              fields: [
                                ...artifactType.fields,
                                {
                                  id: `field-${artifactType.fields.length + 1}`,
                                  key: `field${artifactType.fields.length + 1}`,
                                  label: "새 필드",
                                  valueSchema: { type: "string" },
                                  aliases: [],
                                  defaultValue: null,
                                },
                              ],
                            })
                          }
                        >
                          <Plus /> {t("schemaStudio.addField")}
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <p className="text-sm text-destructive">
                  {t("schemaStudio.fixInJson")}
                </p>
              )}
              <div className="space-y-2 rounded-md border p-3">
                <p className="text-xs font-semibold">
                  {t("schemaStudio.publishLibrary")}
                </p>
                <div className="flex flex-wrap gap-1">
                  {catalog.map((item) => (
                    <Button
                      key={`${item.id}-${item.revision}`}
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setSchema(item);
                        setSelectedType(0);
                      }}
                    >
                      {item.id} r{item.revision}
                    </Button>
                  ))}
                </div>
                <p className="text-xs font-semibold">
                  {t("schemaStudio.drafts")}
                </p>
                <div className="flex flex-wrap gap-1">
                  {drafts.map((item) => (
                    <Button
                      key={item.draftId}
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setSchema(item.schema);
                        setDraftId(item.draftId);
                        setSelectedType(0);
                      }}
                    >
                      {item.schema.id} r{item.schema.revision}
                    </Button>
                  ))}
                </div>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  onClick={() =>
                    void execute("draft", async () => {
                      const record = await schemaStudioApi.saveDraft(
                        draftId,
                        schema(),
                      );
                      setValidation(record.validation);
                      await loadLibrary();
                    })
                  }
                  disabled={busy !== null}
                >
                  <Save className="mr-2 size-4" />
                  {t("schemaStudio.saveDraft")}
                </Button>
                <Button
                  onClick={() => void validateSchema()}
                  disabled={busy !== null}
                >
                  {t("schemaStudio.validate")}
                </Button>
                <Button
                  variant="outline"
                  onClick={() =>
                    void execute("publish", async () => {
                      await schemaStudioApi.publish(schema());
                      await loadLibrary();
                      setMessage(t("schemaStudio.published"));
                    })
                  }
                  disabled={busy !== null}
                >
                  {t("schemaStudio.publish")}
                </Button>
                <Button
                  variant="secondary"
                  onClick={() => void scanVault()}
                  disabled={busy !== null}
                >
                  <FileSearch className="mr-2 size-4" />
                  {t("schemaStudio.scanVault")}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                {t("schemaStudio.pathVarsHelp")}
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
                  {t("schemaStudio.diagnostics")}
                  {validation && (
                    <Badge
                      variant={validation.valid ? "success" : "destructive"}
                    >
                      {validation.valid
                        ? t("schemaStudio.valid")
                        : t("schemaStudio.needsFix")}
                    </Badge>
                  )}
                </CardTitle>
              </CardHeader>
              <CardContent>
                {validation ? (
                  <Diagnostics rows={validation.diagnostics} />
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {t("schemaStudio.validateFirst")}
                  </p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>{t("schemaStudio.scan")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {scan ? (
                  <>
                    <div className="grid grid-cols-3 gap-2 text-center text-sm">
                      <div className="rounded-md bg-muted p-3">
                        <strong className="block text-lg">
                          {scan.scannedFiles}
                        </strong>
                        {t("schemaStudio.files")}
                      </div>
                      <div className="rounded-md bg-muted p-3">
                        <strong className="block text-lg">
                          {scan.managedArtifacts.length}
                        </strong>
                        {t("schemaStudio.managed")}
                      </div>
                      <div className="rounded-md bg-muted p-3">
                        <strong className="block text-lg">
                          {scan.unmanagedMarkdown.length}
                        </strong>
                        {t("schemaStudio.preserved")}
                      </div>
                    </div>
                    <Diagnostics rows={scan.diagnostics} />
                    <Button
                      variant="secondary"
                      onClick={() => void buildPlan()}
                      disabled={busy !== null}
                    >
                      {t("schemaStudio.makePlan")}
                    </Button>
                  </>
                ) : (
                  <p className="text-sm text-muted-foreground">
                    {t("schemaStudio.scanHelp")}
                  </p>
                )}
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>{t("schemaStudio.planAndApply")}</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                {!plan ? (
                  <p className="text-sm text-muted-foreground">
                    {t("schemaStudio.planEmpty")}
                  </p>
                ) : (
                  <>
                    <div className="space-y-2">
                      {plan.moves.map((move) => (
                        <div
                          key={`${move.source}-${move.target}`}
                          className="rounded-md border p-3 text-sm"
                        >
                          <code>{move.source}</code>
                          <span className="mx-2 text-muted-foreground">→</span>
                          <code>{move.target}</code>
                        </div>
                      ))}
                      {plan.moves.length === 0 && (
                        <div className="flex items-center gap-2 text-sm text-muted-foreground">
                          <CheckCircle2 className="size-4 text-success" />{" "}
                          {t("schemaStudio.noMoves")}
                        </div>
                      )}
                      {plan.rewrites.map((rewrite) => (
                        <div
                          key={`rewrite-${rewrite.source}`}
                          className="rounded-md border p-3 text-sm"
                        >
                          <code>{rewrite.source}</code>
                          <span className="ml-2 text-muted-foreground">
                            {t("schemaStudio.rewriteStats", {
                              fields: rewrite.fieldChanges,
                              links: rewrite.linkChanges,
                            })}
                          </span>
                        </div>
                      ))}
                    </div>
                    <Diagnostics rows={plan.conflicts} />
                    <Button
                      onClick={() => void previewChangeSet()}
                      disabled={
                        busy !== null ||
                        plan.moves.length + plan.rewrites.length === 0 ||
                        plan.conflicts.length > 0
                      }
                    >
                      {t("schemaStudio.previewChangeSet")}
                    </Button>
                  </>
                )}

                {changeSet && (
                  <div className="space-y-3 border-t pt-4">
                    <div className="flex items-center gap-2 text-sm">
                      <Badge
                        variant={
                          changeSet.status === "conflict"
                            ? "destructive"
                            : "outline"
                        }
                      >
                        {changeSet.status}
                      </Badge>
                      <code className="truncate text-xs text-muted-foreground">
                        {changeSet.id}
                      </code>
                    </div>
                    {changeSet.operations.map((operation) => (
                      <div
                        key={operation.id}
                        className="rounded-md bg-muted p-3 text-xs"
                      >
                        <div className="flex items-center gap-2">
                          <strong>{operation.kind}</strong>
                          <span>{operation.status}</span>
                        </div>
                        <div className="mt-1 font-mono">
                          {operation.source ?? "(new)"} → {operation.target}
                        </div>
                        {operation.error && (
                          <p className="mt-1 text-destructive">
                            {operation.error}
                          </p>
                        )}
                      </div>
                    ))}
                    <div className="flex gap-2">
                      <Button
                        onClick={() => void applyChangeSet()}
                        disabled={
                          busy !== null || changeSet.status !== "previewed"
                        }
                      >
                        {t("schemaStudio.applyChanges")}
                      </Button>
                      <Button
                        variant="secondary"
                        onClick={() =>
                          void execute("activate", async () => {
                            const state = await schemaStudioApi.activate(
                              schema(),
                              changeSet.id,
                            );
                            setActive(state);
                            setMessage(
                              t("schemaStudio.activated", {
                                id: state.id,
                                revision: state.revision,
                              }),
                            );
                          })
                        }
                        disabled={
                          busy !== null || changeSet.status !== "applied"
                        }
                      >
                        {t("schemaStudio.activate")}
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => void rollbackChangeSet()}
                        disabled={
                          busy !== null ||
                          !["applied", "conflict"].includes(changeSet.status)
                        }
                      >
                        <RotateCcw className="mr-2 size-4" />
                        {t("schemaStudio.rollback")}
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
