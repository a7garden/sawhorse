export interface StorageDefinition {
  path: string;
}

export interface FieldDefinition {
  id: string;
  key: string;
  label: string;
  valueSchema: Record<string, unknown>;
  aliases: string[];
  defaultValue: unknown | null;
}

export interface BodyDefinition {
  templateRef: string | null;
  requiredSectionIds: string[];
}

export interface ArtifactTypeDefinition {
  id: string;
  label: string;
  storage: StorageDefinition;
  fields: FieldDefinition[];
  requiredFieldIds: string[];
  body: BodyDefinition;
}

export interface VaultSchema {
  schemaFormatVersion: number;
  id: string;
  revision: number;
  types: ArtifactTypeDefinition[];
}

export interface SchemaDiagnostic {
  severity: "error" | "warning";
  code: string;
  path: string;
  message: string;
}

export interface SchemaValidationReport {
  valid: boolean;
  diagnostics: SchemaDiagnostic[];
}

export interface ScannedArtifact {
  path: string;
  id: string;
  typeId: string;
  schemaRevision: number | null;
  projectId: string | null;
  expectedPath: string | null;
  contentHash: string;
  diagnostics: SchemaDiagnostic[];
}

export interface SchemaScanResult {
  schemaId: string;
  schemaRevision: number;
  scannedFiles: number;
  managedArtifacts: ScannedArtifact[];
  unmanagedMarkdown: string[];
  diagnostics: SchemaDiagnostic[];
}

export interface SchemaMoveProposal {
  artifactId: string;
  typeId: string;
  source: string;
  target: string;
  expectedSourceHash: string;
  reason: string;
}

export interface SchemaMigrationPlan {
  schemaId: string;
  schemaRevision: number;
  moves: SchemaMoveProposal[];
  rewrites: SchemaRewriteProposal[];
  conflicts: SchemaDiagnostic[];
}

export interface SchemaRewriteProposal {
  artifactId: string | null;
  source: string;
  target: string;
  expectedSourceHash: string;
  content: string;
  fieldChanges: number;
  linkChanges: number;
  reason: string;
}

export interface SchemaDraftRecord {
  draftId: string;
  schema: VaultSchema;
  validation: SchemaValidationReport;
  updatedAt: string;
}

export interface ActiveSchemaState {
  id: string;
  revision: number;
}

export interface ChangeOperation {
  id: string;
  kind: "create" | "write" | "move" | null;
  source: string | null;
  target: string;
  reason: string;
  expectedSourceHash: string | null;
  expectedTargetHash: string | null;
  appliedHash: string | null;
  status: "pending" | "applying" | "applied" | "rolled-back" | "conflict";
  error: string | null;
}

export interface ChangeSet {
  formatVersion: number;
  id: string;
  rootIdentity: string;
  status:
    | "previewed"
    | "applying"
    | "applied"
    | "rolling-back"
    | "rolled-back"
    | "conflict";
  createdAt: string;
  updatedAt: string;
  operations: ChangeOperation[];
}
