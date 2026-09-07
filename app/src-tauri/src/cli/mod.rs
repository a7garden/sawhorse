//! Headless console adapter. No Tauri application, tray, watchers, or agents are
//! started here; all mutations use the same services as the desktop commands.
mod skills;

use crate::{
    sdlc,
    workflow::{self, *},
};
use clap::{Parser, Subcommand, ValueEnum};
use serde::{de::DeserializeOwned, Serialize};
use serde_json::{json, Value};
use std::{
    ffi::OsString,
    fs,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    process::ExitCode,
};

type Result<T> = std::result::Result<T, CliError>;

#[derive(Debug, Serialize)]
pub(super) struct CliError {
    code: String,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    details: Option<Value>,
    #[serde(skip)]
    exit: u8,
}
impl CliError {
    fn new(code: impl Into<String>, message: impl Into<String>, exit: u8) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details: None,
            exit,
        }
    }
    fn details(mut self, details: impl Serialize) -> Self {
        self.details = serde_json::to_value(details).ok();
        self
    }
    fn operation(message: String) -> Self {
        let prefix = message.split(':').next().unwrap_or("");
        match prefix {
            "revision-conflict" | "workspace-busy" => Self::new(prefix, message.clone(), 4),
            "unsafe-path" => Self::new(prefix, message.clone(), 2),
            _ => Self::new("operation-failed", message, 1),
        }
    }
}

#[derive(Parser)]
#[command(
    name = "sawhorse",
    version,
    about = "Author Sawhorse workflows from any terminal agent",
    long_about = "Author, validate, simulate, and register Sawhorse workflows without starting the desktop app. Use --json for a stable machine-readable response."
)]
struct Cli {
    /// Emit one UTF-8 JSON response, including structured errors
    #[arg(long, global = true)]
    json: bool,
    /// Workspace directory (otherwise ancestors of cwd, then app configuration)
    #[arg(long, global = true, env = "SAWHORSE_VAULT")]
    vault: Option<PathBuf>,
    #[command(subcommand)]
    command: Command,
}
#[derive(Subcommand)]
enum Command {
    /// Author and register workflow definitions
    Workflow {
        #[command(subcommand)]
        command: WorkflowCommand,
    },
    /// Inspect or initialize a workspace
    Workspace {
        #[command(subcommand)]
        command: WorkspaceCommand,
    },
    /// Discover projects for workflow activation
    Project {
        #[command(subcommand)]
        command: ProjectCommand,
    },
    /// Install the bundled workflow-authoring skill
    Skill {
        #[command(subcommand)]
        command: SkillCommand,
    },
}
#[derive(Subcommand)]
enum WorkflowCommand {
    /// List built-in and published definitions
    List,
    /// Read one exact ID@VERSION definition
    Show { reference: String },
    /// Export a raw JSON definition (not a CLI response envelope)
    Export {
        reference: String,
        #[arg(short, long)]
        output: PathBuf,
        #[arg(long)]
        force: bool,
    },
    /// Generate the JSON Schema from the installed Rust types
    Schema {
        #[arg(long, value_enum, default_value_t = SchemaKind::Definition)]
        kind: SchemaKind,
    },
    /// Create an editable raw JSON file from an existing definition
    Init {
        id: String,
        #[arg(long)]
        from: Option<String>,
        #[arg(long, default_value = "1.0.0")]
        version: String,
        #[arg(long)]
        label: Option<String>,
        #[arg(short, long)]
        output: PathBuf,
        #[arg(long)]
        force: bool,
    },
    /// Validate a definition and its exact subworkflow references
    Validate {
        file: PathBuf,
        #[arg(long = "dependency")]
        dependencies: Vec<PathBuf>,
    },
    /// Simulate events without executing agents or commands
    Simulate {
        file: PathBuf,
        /// JSON array of {event, facts}; use '-' to read standard input
        #[arg(long)]
        events: Option<PathBuf>,
        #[arg(long = "dependency")]
        dependencies: Vec<PathBuf>,
        #[arg(long)]
        max_steps: Option<u32>,
        /// Fail unless the supplied events reach a completed workflow
        #[arg(long)]
        require_complete: bool,
    },
    /// Manage editable Studio drafts with revision checks
    Draft {
        #[command(subcommand)]
        command: DraftCommand,
    },
    /// Import a JSON definition as an editable Studio draft
    Import {
        file: PathBuf,
        #[arg(long)]
        id: String,
        #[arg(long)]
        expected_revision: Option<String>,
    },
    /// Publish one or more definitions as immutable exact versions
    Publish {
        #[arg(required = true, num_args = 1..)]
        files: Vec<PathBuf>,
        /// Validate the complete publication without writing any files
        #[arg(long)]
        dry_run: bool,
    },
    /// Select a project's default workflow for NEW tasks
    Activate {
        reference: String,
        #[arg(long)]
        project: String,
        #[arg(long)]
        expected_revision: Option<String>,
        #[arg(long)]
        dry_run: bool,
    },
}
#[derive(Clone, Copy, ValueEnum)]
enum SchemaKind {
    Definition,
    Simulation,
}
#[derive(Subcommand)]
enum DraftCommand {
    List,
    Show {
        id: String,
    },
    /// Creates a draft; updating it requires the revision returned by show/list
    Save {
        file: PathBuf,
        #[arg(long)]
        id: String,
        #[arg(long)]
        expected_revision: Option<String>,
    },
}
#[derive(Subcommand)]
enum WorkspaceCommand {
    Show,
    /// Initialize the explicit --vault directory, preserving existing content
    Init,
}
#[derive(Subcommand)]
enum ProjectCommand {
    List,
    Show { id: String },
}
#[derive(Subcommand)]
enum SkillCommand {
    Show,
    Install {
        #[arg(long, value_parser = ["codex", "claude"], required_unless_present = "dir", conflicts_with = "dir")]
        agent: Option<String>,
        /// An agent's skills directory, for a project-local or custom installation
        #[arg(long)]
        dir: Option<PathBuf>,
        /// Explicitly replace a different installed skill after reviewing it
        #[arg(long)]
        force: bool,
    },
}

struct Output {
    data: Value,
    text: Option<String>,
}
impl Output {
    fn data(value: impl Serialize) -> Result<Self> {
        Ok(Self {
            data: serde_json::to_value(value)
                .map_err(|e| CliError::new("serialization", e.to_string(), 1))?,
            text: None,
        })
    }
    fn text(value: impl Serialize, text: String) -> Result<Self> {
        let mut result = Self::data(value)?;
        result.text = Some(text);
        Ok(result)
    }
}

pub fn run() -> ExitCode {
    let args: Vec<OsString> = std::env::args_os().collect();
    let wants_json = args.iter().any(|arg| arg == "--json");
    let result = match Cli::try_parse_from(args) {
        Ok(cli) => return emit(dispatch(&cli), cli.json),
        Err(error) => {
            let success = matches!(
                error.kind(),
                clap::error::ErrorKind::DisplayHelp | clap::error::ErrorKind::DisplayVersion
            );
            if success {
                let text = error.to_string();
                Output::text(json!({"text": text}), text)
            } else {
                Err(CliError::new("usage", error.to_string(), 2))
            }
        }
    };
    emit(result, wants_json)
}

fn emit(result: Result<Output>, as_json: bool) -> ExitCode {
    let (exit, bytes, stderr) = match result {
        Ok(output) => {
            let text = if as_json {
                serde_json::to_string(&json!({"schemaVersion": 1, "ok": true, "data": output.data}))
                    .unwrap()
            } else {
                output
                    .text
                    .unwrap_or_else(|| serde_json::to_string_pretty(&output.data).unwrap())
            };
            (0, text, false)
        }
        Err(error) => {
            let text = if as_json {
                serde_json::to_string(&json!({"schemaVersion": 1, "ok": false, "error": error}))
                    .unwrap()
            } else {
                let mut text = format!("{}: {}", error.code, error.message);
                if let Some(details) = &error.details {
                    text.push_str(&format!(
                        "\n{}",
                        serde_json::to_string_pretty(details).unwrap()
                    ));
                }
                text
            };
            (error.exit, text, !as_json)
        }
    };
    let result = if stderr {
        writeln!(io::stderr().lock(), "{}", bytes.trim_end())
    } else {
        writeln!(io::stdout().lock(), "{}", bytes.trim_end())
    };
    match result {
        Ok(_) => ExitCode::from(exit),
        Err(e) if e.kind() == io::ErrorKind::BrokenPipe => ExitCode::SUCCESS,
        Err(_) => ExitCode::from(1),
    }
}

fn resolve_vault(explicit: Option<&Path>, required: bool) -> Result<Option<PathBuf>> {
    let candidate = if let Some(path) = explicit {
        Some(path.to_path_buf())
    } else {
        let cwd = std::env::current_dir()
            .map_err(|e| CliError::new("working-directory", e.to_string(), 1))?;
        let discovered = cwd
            .ancestors()
            .find(|path| {
                path.join(".sawhorse/schema.json").is_file()
                    || path.join(".sawhorse/workspace.json").is_file()
            })
            .map(Path::to_path_buf);
        if discovered.is_some() {
            discovered
        } else {
            configured_vault(&crate::config::config_path())?
        }
    };
    match candidate {
        Some(path) if path.is_dir() => Ok(Some(path.canonicalize().map_err(|e| CliError::new("workspace-path", e.to_string(), 1))?)),
        Some(path) => Err(CliError::new("workspace-not-found", format!("Workspace directory does not exist: {}. Use workspace init --vault PATH to create it.", path.display()), 2)),
        None if required => Err(CliError::new("workspace-required", "Specify --vault PATH or run inside an initialized Sawhorse workspace", 2)),
        None => Ok(None),
    }
}

fn configured_vault(config: &Path) -> Result<Option<PathBuf>> {
    match fs::read(config) {
        Ok(bytes) => {
            let value: Value = decode_json(&bytes, config)?;
            let view = crate::config::view(&value, true);
            let path = view.vault_path.trim();
            Ok((!path.is_empty()).then(|| PathBuf::from(path)))
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(CliError::new("config-read-failed", e.to_string(), 1)),
    }
}

fn exact_ref(value: &str) -> Result<(&str, &str)> {
    let (id, version) = value.rsplit_once('@').ok_or_else(|| {
        CliError::new("invalid-reference", "Use an exact ID@VERSION reference", 2)
    })?;
    if id.is_empty() || semver::Version::parse(version).is_err() {
        return Err(CliError::new(
            "invalid-reference",
            "Use an exact ID@VERSION reference with a SemVer version",
            2,
        ));
    }
    Ok((id, version))
}

fn read_json<T: DeserializeOwned>(path: &Path) -> Result<T> {
    let bytes = if path == Path::new("-") {
        let mut bytes = Vec::new();
        io::stdin()
            .lock()
            .take(16 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| CliError::new("input-read-failed", e.to_string(), 1))?;
        bytes
    } else {
        fs::read(path).map_err(|e| {
            CliError::new("input-read-failed", format!("{}: {e}", path.display()), 1)
        })?
    };
    if bytes.len() > 16 * 1024 * 1024 {
        return Err(CliError::new(
            "input-too-large",
            "JSON input exceeds 16 MiB",
            2,
        ));
    }
    decode_json(&bytes, path)
}

fn decode_json<T: DeserializeOwned>(bytes: &[u8], path: &Path) -> Result<T> {
    let text = if bytes.starts_with(&[0xff, 0xfe]) || bytes.starts_with(&[0xfe, 0xff]) {
        if bytes.len() % 2 != 0 {
            return Err(CliError::new(
                "invalid-encoding",
                "Incomplete UTF-16 input",
                2,
            ));
        }
        let little = bytes[0] == 0xff;
        let words = bytes[2..]
            .chunks_exact(2)
            .map(|b| {
                if little {
                    u16::from_le_bytes([b[0], b[1]])
                } else {
                    u16::from_be_bytes([b[0], b[1]])
                }
            })
            .collect::<Vec<_>>();
        String::from_utf16(&words)
            .map_err(|e| CliError::new("invalid-encoding", e.to_string(), 2))?
    } else {
        String::from_utf8(
            bytes
                .strip_prefix(&[0xef, 0xbb, 0xbf])
                .unwrap_or(bytes)
                .to_vec(),
        )
        .map_err(|e| CliError::new("invalid-encoding", e.to_string(), 2))?
    };
    let mut decoder = serde_json::Deserializer::from_str(&text);
    let value = serde_path_to_error::deserialize(&mut decoder).map_err(|e| {
        CliError::new("invalid-json", format!("{}: {e}", path.display()), 2)
            .details(json!({"path": e.path().to_string()}))
    })?;
    decoder
        .end()
        .map_err(|e| CliError::new("invalid-json", e.to_string(), 2))?;
    Ok(value)
}

fn write_json(path: &Path, data: &impl Serialize, force: bool) -> Result<()> {
    if path == Path::new("-") {
        return Err(CliError::new(
            "usage",
            "Use workflow show for stdout; --output requires a file path",
            2,
        ));
    }
    if path.exists() && !force {
        return Err(CliError::new(
            "output-exists",
            format!(
                "{} already exists; use a new path or --force",
                path.display()
            ),
            4,
        ));
    }
    let mut bytes = serde_json::to_vec_pretty(data)
        .map_err(|e| CliError::new("serialization", e.to_string(), 1))?;
    bytes.push(b'\n');
    crate::workspace_io::write_atomic(path, &bytes, force).map_err(CliError::operation)
}

fn registry_with(
    root: Option<&Path>,
    definitions: Vec<WorkflowDefinition>,
) -> Result<Vec<WorkflowDefinition>> {
    let mut registry = workflow::catalog(root).map_err(CliError::operation)?;
    // Drafts may shadow a published version while being edited, but supplied
    // definitions must not disagree with each other.
    let mut supplied = std::collections::HashMap::new();
    for definition in definitions {
        let key = (definition.id.clone(), definition.version.clone());
        if let Some(previous) = supplied.insert(key, definition.clone()) {
            if previous != definition {
                return Err(CliError::new(
                    "conflicting-definitions",
                    "Two input files specify different content for the same ID/version",
                    3,
                ));
            }
        }
        registry.retain(|item| item.id != definition.id || item.version != definition.version);
        registry.push(definition);
    }
    Ok(registry)
}

fn dependencies(paths: &[PathBuf]) -> Result<Vec<WorkflowDefinition>> {
    paths
        .iter()
        .map(|path| {
            if path == Path::new("-") {
                return Err(CliError::new(
                    "usage",
                    "--dependency requires a file path",
                    2,
                ));
            }
            read_json(path)
        })
        .collect()
}

fn validate_report(registry: &[WorkflowDefinition]) -> ValidationReport {
    let issues = workflow::validation::validate_registry(registry);
    ValidationReport {
        valid: !issues
            .iter()
            .any(|issue| issue.severity == IssueSeverity::Error),
        issues,
    }
}
fn validated(report: ValidationReport) -> Result<Output> {
    if report.valid {
        Output::data(report)
    } else {
        Err(CliError::new("validation-failed", "Workflow validation failed", 3).details(report))
    }
}

fn dispatch(cli: &Cli) -> Result<Output> {
    // Commands which do not need a workspace do not read the user's config.
    match &cli.command {
        Command::Skill {
            command: SkillCommand::Show,
        } => {
            return Output::text(
                json!({"name": skills::NAME, "content": skills::CONTENT}),
                skills::CONTENT.into(),
            )
        }
        Command::Skill {
            command: SkillCommand::Install { agent, dir, force },
        } => return Output::data(skills::install(agent.as_deref(), dir.as_deref(), *force)?),
        Command::Workflow {
            command: WorkflowCommand::Schema { kind },
        } => {
            return match kind {
                SchemaKind::Definition => Output::data(schemars::schema_for!(WorkflowDefinition)),
                SchemaKind::Simulation => Output::data(schemars::schema_for!(SimulationInput)),
            }
        }
        Command::Workspace {
            command: WorkspaceCommand::Init,
        } => {
            let root = cli.vault.as_deref().ok_or_else(|| {
                CliError::new(
                    "workspace-required",
                    "workspace init requires --vault PATH",
                    2,
                )
            })?;
            let snapshot = sdlc::initialize(root).map_err(CliError::operation)?;
            return Output::data(json!({"vault": root, "initialized": snapshot.initialized}));
        }
        _ => {}
    }
    let root = resolve_vault(cli.vault.as_deref(), false)?;
    let required = || {
        root.as_deref().ok_or_else(|| {
            CliError::new(
                "workspace-required",
                "Specify --vault PATH or run inside an initialized Sawhorse workspace",
                2,
            )
        })
    };
    match &cli.command {
        Command::Workspace {
            command: WorkspaceCommand::Show,
        } => Output::data(
            json!({"vault": required()?, "initialized": required()?.join(".sawhorse/schema.json").is_file()}),
        ),
        Command::Project {
            command: ProjectCommand::List,
        } => {
            let snapshot = sdlc::snapshot(required()?).map_err(CliError::operation)?;
            Output::data(
                json!({"projects": snapshot.projects, "diagnostics": snapshot.diagnostics}),
            )
        }
        Command::Project {
            command: ProjectCommand::Show { id },
        } => {
            let root = required()?;
            // Keep the project and its revision from the same read transaction.
            sdlc::validate_id(id).map_err(CliError::operation)?;
            let _guard = crate::workspace_io::lock(root, &format!("project-{id}"))
                .map_err(CliError::operation)?;
            Output::data(
                json!({"project": sdlc::project_by_id(root, id).map_err(CliError::operation)?, "revision": sdlc::project_revision_at(root, id).map_err(CliError::operation)?}),
            )
        }
        Command::Workflow { command } => match command {
            WorkflowCommand::List => {
                let definitions =
                    workflow::catalog(root.as_deref()).map_err(CliError::operation)?;
                let text = definitions
                    .iter()
                    .map(|item| format!("{}@{}\t{}", item.id, item.version, item.label))
                    .collect::<Vec<_>>()
                    .join("\n");
                Output::text(definitions, text)
            }
            WorkflowCommand::Show { reference } | WorkflowCommand::Export { reference, .. } => {
                let (id, version) = exact_ref(reference)?;
                let definition = workflow::resolve(root.as_deref(), id, version)
                    .map_err(|e| CliError::new("workflow-not-found", e, 2))?;
                if let WorkflowCommand::Export { output, force, .. } = command {
                    write_json(output, &definition, *force)?;
                    Output::data(json!({"path": output, "id": id, "version": version}))
                } else {
                    Output::data(definition)
                }
            }
            WorkflowCommand::Init {
                id,
                from,
                version,
                label,
                output,
                force,
            } => {
                let default = format!("{DEFAULT_WORKFLOW_ID}@{DEFAULT_WORKFLOW_VERSION}");
                let (source_id, source_version) = exact_ref(from.as_deref().unwrap_or(&default))?;
                let mut definition = workflow::resolve(root.as_deref(), source_id, source_version)
                    .map_err(CliError::operation)?;
                definition.id = id.clone();
                definition.version = version.clone();
                definition.label = label.clone().unwrap_or_else(|| id.clone());
                let report = workflow::validate_draft_at(root.as_deref(), &definition);
                if !report.valid {
                    return validated(report);
                }
                write_json(output, &definition, *force)?;
                Output::data(json!({"path": output, "definition": definition}))
            }
            WorkflowCommand::Validate {
                file,
                dependencies: paths,
            } => {
                let definition: WorkflowDefinition = read_json(file)?;
                let structural = workflow::validation::validate(&definition);
                let mut supplied = dependencies(paths)?;
                supplied.push(definition);
                let mut report = validate_report(&registry_with(root.as_deref(), supplied)?);
                // Keep warnings on the edited root as well as registry errors.
                report.issues.extend(
                    structural
                        .issues
                        .into_iter()
                        .filter(|i| i.severity == IssueSeverity::Warning),
                );
                validated(report)
            }
            WorkflowCommand::Simulate {
                file,
                events,
                dependencies: paths,
                max_steps,
                require_complete,
            } => {
                if file == Path::new("-") && events.as_deref() == Some(Path::new("-")) {
                    return Err(CliError::new("usage", "Only one input may read stdin", 2));
                }
                let definition = read_json(file)?;
                let definitions = registry_with(root.as_deref(), dependencies(paths)?)?;
                let events = events
                    .as_ref()
                    .map(|path| read_json(path))
                    .transpose()?
                    .unwrap_or_default();
                let result = workflow::runtime::simulate(SimulationInput {
                    definition,
                    definitions,
                    events,
                    max_steps: *max_steps,
                });
                let failed = matches!(
                    result.status,
                    SimulationStatus::Failed | SimulationStatus::Invalid
                ) || (*require_complete
                    && result.status != SimulationStatus::Completed);
                if failed {
                    Err(CliError::new(
                        "simulation-failed",
                        "Simulation did not satisfy the requested outcome",
                        3,
                    )
                    .details(result))
                } else {
                    Output::data(result)
                }
            }
            WorkflowCommand::Draft {
                command: DraftCommand::List,
            } => Output::data(workflow::list_drafts_at(required()?).map_err(CliError::operation)?),
            WorkflowCommand::Draft {
                command: DraftCommand::Show { id },
            } => {
                Output::data(workflow::get_draft_at(required()?, id).map_err(CliError::operation)?)
            }
            WorkflowCommand::Draft {
                command:
                    DraftCommand::Save {
                        file,
                        id,
                        expected_revision,
                    },
            }
            | WorkflowCommand::Import {
                file,
                id,
                expected_revision,
            } => {
                let input = WorkflowDraftSaveInput {
                    draft_id: id.clone(),
                    definition: read_json(file)?,
                    expected_revision: expected_revision.clone(),
                };
                Output::data(
                    workflow::save_draft_at(required()?, input).map_err(CliError::operation)?,
                )
            }
            WorkflowCommand::Publish { files, dry_run } => {
                if files
                    .iter()
                    .filter(|path| path.as_path() == Path::new("-"))
                    .count()
                    > 1
                {
                    return Err(CliError::new("usage", "Only one input may read stdin", 2));
                }
                let definitions: Vec<WorkflowDefinition> = files
                    .iter()
                    .map(|path| read_json(path))
                    .collect::<Result<_>>()?;
                let root = required()?;
                workflow::publication_plan_at(root, &definitions)
                    .map_err(|message| CliError::new("publication-invalid", message, 3))?;
                if !dry_run {
                    workflow::publish_all_at(root, definitions.clone())
                        .map_err(CliError::operation)?;
                }
                let revisions: Vec<Value> = definitions.iter().map(|definition| Ok(json!({"id": definition.id, "version": definition.version, "digest": workflow::definition_digest(definition).map_err(CliError::operation)?}))).collect::<Result<_>>()?;
                Output::data(json!({"dryRun": dry_run, "workflows": revisions}))
            }
            WorkflowCommand::Activate {
                reference,
                project,
                expected_revision,
                dry_run,
            } => {
                let root = required()?;
                let (id, version) = exact_ref(reference)?;
                if *dry_run {
                    let before = sdlc::project_by_id(root, project).map_err(CliError::operation)?;
                    let definition =
                        workflow::resolve(Some(root), id, version).map_err(CliError::operation)?;
                    let revision =
                        sdlc::project_revision_at(root, project).map_err(CliError::operation)?;
                    if expected_revision
                        .as_ref()
                        .is_some_and(|value| *value != revision)
                    {
                        return Err(CliError::new(
                            "revision-conflict",
                            "Project changed; read it again",
                            4,
                        ));
                    }
                    Output::data(
                        json!({"dryRun": true, "projectId": project, "before": {"id": before.workflow_id, "version": before.workflow_version}, "after": {"id": id, "version": version, "digest": workflow::definition_digest(&definition).map_err(CliError::operation)?}, "revision": revision}),
                    )
                } else {
                    let result = sdlc::activate_project_workflow_checked_at(
                        root,
                        project,
                        id,
                        version,
                        expected_revision.as_deref(),
                    )
                    .map_err(CliError::operation)?;
                    Output::data(json!({"dryRun": false, "project": result}))
                }
            }
            WorkflowCommand::Schema { .. } => unreachable!(),
        },
        _ => unreachable!(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_configuration_resolves_the_same_vault_without_mutating_it() {
        let temp = tempfile::tempdir().unwrap();
        let config = temp.path().join("config.json");
        let vault = temp.path().join("팀 작업공간");
        fs::create_dir(&vault).unwrap();
        let bytes = serde_json::to_vec(&json!({"vaultPath": vault, "dashboard": {"custom": true}}))
            .unwrap();
        fs::write(&config, &bytes).unwrap();
        assert_eq!(configured_vault(&config).unwrap(), Some(vault));
        assert_eq!(fs::read(&config).unwrap(), bytes);
        assert_eq!(
            configured_vault(&temp.path().join("missing.json")).unwrap(),
            None
        );
        fs::write(&config, b"invalid-json").unwrap();
        assert_eq!(configured_vault(&config).unwrap_err().code, "invalid-json");
    }
}
