import { invoke, isTauri } from "@tauri-apps/api/core";
import type {
  ChangeSet,
  SchemaMigrationPlan,
  SchemaScanResult,
  SchemaValidationReport,
  VaultSchema,
  SchemaDraftRecord,
  ActiveSchemaState,
} from "./types";

function desktopCall<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  if (!isTauri()) {
    return Promise.reject(
      new Error(
        "스키마 검사와 파일 적용은 Sawhorse 데스크톱 앱에서 사용할 수 있습니다.",
      ),
    );
  }
  return invoke<T>(command, args);
}

export const schemaStudioApi = {
  validate: (schema: VaultSchema): Promise<SchemaValidationReport> =>
    desktopCall("schema_validate", { schema }),
  scan: (schema: VaultSchema): Promise<SchemaScanResult> =>
    desktopCall("schema_scan", { schema }),
  plan: (
    schema: VaultSchema,
    scan: SchemaScanResult,
  ): Promise<SchemaMigrationPlan> =>
    desktopCall("schema_plan", { schema, scan }),
  preview: (plan: SchemaMigrationPlan): Promise<ChangeSet> =>
    desktopCall("schema_changeset_preview", { plan }),
  apply: (id: string): Promise<ChangeSet> =>
    desktopCall("changeset_apply", { id }),
  rollback: (id: string): Promise<ChangeSet> =>
    desktopCall("changeset_rollback", { id }),
  catalog: (): Promise<VaultSchema[]> => desktopCall("schema_catalog"),
  drafts: (): Promise<SchemaDraftRecord[]> => desktopCall("schema_draft_list"),
  saveDraft: (
    draftId: string,
    schema: VaultSchema,
  ): Promise<SchemaDraftRecord> =>
    desktopCall("schema_draft_save", { input: { draftId, schema } }),
  publish: (schema: VaultSchema): Promise<VaultSchema> =>
    desktopCall("schema_publish", { schema }),
  activate: (
    schema: VaultSchema,
    changeSetId?: string,
  ): Promise<ActiveSchemaState> =>
    desktopCall("schema_activate", {
      schema,
      changeSetId: changeSetId ?? null,
    }),
  active: (): Promise<ActiveSchemaState | null> => desktopCall("schema_active"),
};
