use serde_json::{json, Value};
use std::{
    fs,
    io::Write,
    path::Path,
    process::{Command, Output, Stdio},
};

const BIN: &str = env!("CARGO_BIN_EXE_sawhorse");
fn cli(root: &Path) -> Command {
    let mut cmd = Command::new(BIN);
    cmd.arg("--json").arg("--vault").arg(root);
    cmd
}
fn result(output: Output, status: i32) -> Value {
    assert_eq!(
        output.status.code(),
        Some(status),
        "stdout: {}\nstderr: {}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        output.stderr.is_empty(),
        "JSON mode keeps stderr clean: {}",
        String::from_utf8_lossy(&output.stderr)
    );
    let value: Value = serde_json::from_slice(&output.stdout).expect("one UTF-8 JSON response");
    assert_eq!(value["schemaVersion"], 1);
    assert_eq!(value["ok"], status == 0);
    value
}
fn run(root: &Path, args: &[&str], status: i32) -> Value {
    result(cli(root).args(args).output().unwrap(), status)
}
fn fixture() -> tempfile::TempDir {
    tempfile::Builder::new()
        .prefix("sawhorse 한글 공백 ")
        .tempdir()
        .unwrap()
}
fn write(path: &Path, value: &Value) {
    fs::write(path, serde_json::to_vec_pretty(value).unwrap()).unwrap();
}
fn definition(id: &str) -> Value {
    json!({"definitionVersion": 1, "id": id, "label": "고객 요청 처리", "version": "1.0.0", "entry": "request",
        "artifacts": [{"role": "request", "label": "요청", "path": "work/{workId}/요청 문서.md", "template": "# 요청\n"}],
        "nodes": [
            {"id":"request", "label":"요청 작성", "kind":"artifact", "artifactRole":"request"},
            {"id":"review", "label":"고객 확인", "kind":"human", "decision":"customer-review"},
            {"id":"done", "label":"완료", "kind":"end"}],
        "edges": [{"from":"request", "to":"review", "on":"submitted"}, {"from":"review", "to":"done", "on":"approved"},
            {"from":"review", "to":"request", "on":"rejected", "loopRef":"revision"}],
        "loops": [{"id":"revision", "maxIterations":2, "onLimit":"pause"}]
    })
}

#[test]
fn author_validate_simulate_save_publish_activate_and_read_back_without_gui() {
    let temp = fixture();
    let root = temp.path();
    run(root, &["workspace", "init"], 0);
    let source = root.join("흐름 초안.json");
    let source_arg = source.to_str().unwrap();
    result(
        cli(root)
            .args(["workflow", "init", "customer-fix", "--output"])
            .arg(&source)
            .output()
            .unwrap(),
        0,
    );
    write(&source, &definition("customer-fix"));
    run(root, &["workflow", "validate", source_arg], 0);
    let events = root.join("events.json");
    write(
        &events,
        &json!([{"event":"submitted"}, {"event":"approved"}]),
    );
    let simulation = result(
        cli(root)
            .args(["workflow", "simulate", source_arg, "--events"])
            .arg(&events)
            .arg("--require-complete")
            .output()
            .unwrap(),
        0,
    );
    assert_eq!(simulation["data"]["status"], "completed");
    run(
        root,
        &["workflow", "simulate", source_arg, "--require-complete"],
        3,
    );
    write(
        &events,
        &json!([{"event":"submitted"}, {"event":"rejected"}, {"event":"submitted"}, {"event":"approved"}]),
    );
    result(
        cli(root)
            .args(["workflow", "simulate", source_arg, "--events"])
            .arg(&events)
            .arg("--require-complete")
            .output()
            .unwrap(),
        0,
    );
    let draft = run(
        root,
        &["workflow", "draft", "save", source_arg, "--id", "customer"],
        0,
    );
    let revision = draft["data"]["revision"].as_str().unwrap();
    let mut changed = definition("customer-fix");
    changed["label"] = json!("고객 수정 흐름");
    write(&source, &changed);
    assert_eq!(
        run(
            root,
            &["workflow", "draft", "save", source_arg, "--id", "customer"],
            4
        )["error"]["code"],
        "revision-conflict"
    );
    run(
        root,
        &[
            "workflow",
            "draft",
            "save",
            source_arg,
            "--id",
            "customer",
            "--expected-revision",
            revision,
        ],
        0,
    );
    run(
        root,
        &[
            "workflow",
            "draft",
            "save",
            source_arg,
            "--id",
            "customer",
            "--expected-revision",
            revision,
        ],
        4,
    );
    assert_eq!(
        run(root, &["workflow", "draft", "show", "customer"], 0)["data"]["definition"]["label"],
        changed["label"]
    );
    run(root, &["workflow", "publish", source_arg, "--dry-run"], 0);
    assert!(!root.join(".sawhorse/workflows/customer-fix").exists());
    let published = run(root, &["workflow", "publish", source_arg], 0);
    run(root, &["workflow", "publish", source_arg], 0);
    let shown = run(root, &["workflow", "show", "customer-fix@1.0.0"], 0);
    let exported = root.join("내보낸 정의.json");
    result(
        cli(root)
            .args(["workflow", "export", "customer-fix@1.0.0", "--output"])
            .arg(&exported)
            .output()
            .unwrap(),
        0,
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&fs::read(&exported).unwrap()).unwrap(),
        shown["data"]
    );
    result(
        cli(root)
            .args(["workflow", "export", "customer-fix@1.0.0", "--output"])
            .arg(&exported)
            .output()
            .unwrap(),
        4,
    );
    let project_dir = root.join("projects/demo");
    fs::create_dir_all(&project_dir).unwrap();
    let project_path = project_dir.join("project.md");
    fs::write(&project_path, "---\r\nid: demo\r\nname: 고객 프로젝트\r\ncustomField: 보존\r\n---\r\n\r\n사람이 작성한 설명\r\n").unwrap();
    let existing_work = root.join("work/existing/work.md");
    fs::create_dir_all(existing_work.parent().unwrap()).unwrap();
    fs::write(
        &existing_work,
        "existing pinned task -- never migrate on activation",
    )
    .unwrap();
    let before = fs::read(&existing_work).unwrap();
    let project = run(root, &["project", "show", "demo"], 0);
    let project_revision = project["data"]["revision"].as_str().unwrap();
    run(
        root,
        &[
            "workflow",
            "activate",
            "customer-fix@1.0.0",
            "--project",
            "demo",
            "--expected-revision",
            project_revision,
            "--dry-run",
        ],
        0,
    );
    let activated = run(
        root,
        &[
            "workflow",
            "activate",
            "customer-fix@1.0.0",
            "--project",
            "demo",
            "--expected-revision",
            project_revision,
        ],
        0,
    );
    assert_eq!(
        activated["data"]["project"]["workflowDigest"],
        published["data"]["workflows"][0]["digest"]
    );
    assert!(fs::read_to_string(project_path)
        .unwrap()
        .contains("customField: 보존"));
    assert!(activated["data"]["project"]["description"]
        .as_str()
        .unwrap()
        .contains("사람이 작성한 설명"));
    assert_eq!(fs::read(existing_work).unwrap(), before);
    run(
        root,
        &[
            "workflow",
            "activate",
            "customer-fix@1.0.0",
            "--project",
            "demo",
            "--expected-revision",
            project_revision,
        ],
        4,
    );
}

#[test]
fn composition_batch_order_conflicts_and_child_simulation() {
    let temp = fixture();
    let root = temp.path();
    let child = definition("child");
    let parent = json!({"id":"parent", "label":"부모", "version":"1.0.0", "entry":"nested", "nodes":[
        {"id":"nested", "label":"하위 흐름", "kind":"subworkflow", "workflowRef":{"id":"child", "version":"1.0.0"}},
        {"id":"done", "label":"끝", "kind":"end"}], "edges":[{"from":"nested", "to":"done", "on":"succeeded"}]});
    let child_file = root.join("child.json");
    let parent_file = root.join("parent.json");
    write(&child_file, &child);
    write(&parent_file, &parent);
    let c = child_file.to_str().unwrap();
    let p = parent_file.to_str().unwrap();
    run(root, &["workflow", "validate", p], 3);
    run(root, &["workflow", "validate", p, "--dependency", c], 0);
    run(root, &["workflow", "publish", p], 3);
    assert!(!root.join(".sawhorse").exists());
    run(root, &["workflow", "publish", p, c], 0);
    let original = fs::read(root.join(".sawhorse/workflows/child/1.0.0.json")).unwrap();
    let mut conflict = child;
    conflict["label"] = json!("changed");
    write(&child_file, &conflict);
    run(root, &["workflow", "publish", p, c], 3);
    assert_eq!(
        fs::read(root.join(".sawhorse/workflows/child/1.0.0.json")).unwrap(),
        original
    );
    let events = root.join("events.json");
    write(
        &events,
        &json!([{"event":"submitted"},{"event":"approved"}]),
    );
    result(
        cli(root)
            .args(["workflow", "simulate", p, "--events"])
            .arg(events)
            .arg("--require-complete")
            .output()
            .unwrap(),
        0,
    );
}

#[test]
fn input_encoding_stdin_schema_usage_and_portable_paths() {
    let temp = fixture();
    let root = temp.path();
    let source = root.join("정의.json");
    let text = serde_json::to_string(&definition("portable")).unwrap();
    let mut utf16 = vec![0xff, 0xfe];
    for word in text.encode_utf16() {
        utf16.extend(word.to_le_bytes());
    }
    fs::write(&source, utf16).unwrap();
    result(
        cli(root)
            .args(["workflow", "validate"])
            .arg(&source)
            .output()
            .unwrap(),
        0,
    );
    let mut child = cli(root)
        .args(["workflow", "validate", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(format!("\u{feff}{text}").as_bytes())
        .unwrap();
    result(child.wait_with_output().unwrap(), 0);
    let mut invalid = definition("CON");
    write(&source, &invalid);
    let failed = result(
        cli(root)
            .args(["workflow", "validate"])
            .arg(&source)
            .output()
            .unwrap(),
        3,
    );
    assert!(failed["error"]["details"]["issues"]
        .as_array()
        .unwrap()
        .iter()
        .any(|i| i["code"] == "invalid-id"));
    invalid["id"] = json!("portable");
    invalid["artifacts"][0]["path"] = json!("C:\\outside.md");
    write(&source, &invalid);
    result(
        cli(root)
            .args(["workflow", "validate"])
            .arg(&source)
            .output()
            .unwrap(),
        3,
    );
    let mut typo = definition("portable");
    typo["nodes"][0]["artifactRolle"] = json!("request");
    write(&source, &typo);
    let failed = result(
        cli(root)
            .args(["workflow", "validate"])
            .arg(&source)
            .output()
            .unwrap(),
        2,
    );
    assert_eq!(failed["error"]["code"], "invalid-json");
    assert!(failed["error"]["details"]["path"]
        .as_str()
        .unwrap()
        .starts_with("nodes[0]"));
    assert!(!root.join(".sawhorse").exists());
    let schema = run(root, &["workflow", "schema"], 0);
    assert!(schema["data"]["properties"]["nodes"].is_object());
    assert_eq!(schema["data"]["additionalProperties"], false);
    run(root, &["workflow", "does-not-exist"], 2);
    run(root, &["--help"], 0);
}

#[test]
fn process_lock_blocks_mutation_and_is_released_without_deleting_lock_file() {
    let temp = fixture();
    let root = temp.path();
    let source = root.join("workflow.json");
    write(&source, &definition("locked"));
    let locks = root.join(".sawhorse/locks");
    fs::create_dir_all(&locks).unwrap();
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(locks.join("workflow.lock"))
        .unwrap();
    fs2::FileExt::try_lock_exclusive(&lock).unwrap();
    let args = ["workflow", "publish", source.to_str().unwrap()];
    assert_eq!(run(root, &args, 4)["error"]["code"], "workspace-busy");
    assert!(!root.join(".sawhorse/workflows/locked").exists());
    drop(lock);
    run(root, &args, 0);
}

#[test]
fn skill_installation_is_self_contained_idempotent_and_preserves_user_edits() {
    let temp = fixture();
    let root = temp.path();
    let install = || {
        cli(root)
            .args(["skill", "install", "--dir"])
            .arg(root.join("agent skills"))
            .output()
            .unwrap()
    };
    let first = result(install(), 0);
    let path = std::path::PathBuf::from(first["data"]["path"].as_str().unwrap());
    assert!(fs::read_to_string(&path)
        .unwrap()
        .contains("name: sawhorse-workflow-author"));
    assert_eq!(result(install(), 0)["data"]["changed"], false);
    fs::write(&path, "my custom skill").unwrap();
    result(install(), 4);
    assert_eq!(fs::read_to_string(&path).unwrap(), "my custom skill");
    result(
        cli(root)
            .args(["skill", "install", "--dir"])
            .arg(path.parent().unwrap().parent().unwrap())
            .arg("--force")
            .output()
            .unwrap(),
        0,
    );
}

#[test]
fn workspace_discovery_and_environment_work_with_spaces_and_unicode() {
    let temp = fixture();
    let root = temp.path();
    run(root, &["workspace", "init"], 0);
    let nested = root.join("하위 폴더/inside");
    fs::create_dir_all(&nested).unwrap();
    let discovered = result(
        Command::new(BIN)
            .env_remove("SAWHORSE_VAULT")
            .current_dir(nested)
            .args(["workspace", "show", "--json"])
            .output()
            .unwrap(),
        0,
    );
    assert_eq!(
        Path::new(discovered["data"]["vault"].as_str().unwrap()),
        root.canonicalize().unwrap()
    );
    result(
        Command::new(BIN)
            .env("SAWHORSE_VAULT", root)
            .args(["workspace", "show", "--json"])
            .output()
            .unwrap(),
        0,
    );
}

#[cfg(unix)]
#[test]
fn symlinked_managed_storage_cannot_escape_the_vault() {
    let temp = fixture();
    let outside = fixture();
    let root = temp.path();
    std::os::unix::fs::symlink(outside.path(), root.join(".sawhorse")).unwrap();
    let source = root.join("workflow.json");
    write(&source, &definition("escape"));
    result(
        cli(root)
            .args(["workflow", "publish"])
            .arg(source)
            .output()
            .unwrap(),
        3,
    );
    assert_eq!(fs::read_dir(outside.path()).unwrap().count(), 0);
}
