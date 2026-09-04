# 플러그인 정보 페이지 구현 플랜

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 대시보드에 플러그인 메타데이터·GitHub 링크·스킬 14개 설명(클릭 시 SKILL.md 전문)을 보여주는 '플러그인' 페이지를 추가한다.

**Architecture:** 런타임에 플러그인 루트(`.claude-plugin/plugin.json` 발견 지점)를 스캔해 plugin.json + skills/*/SKILL.md frontmatter를 읽는 Rust 모듈 `plugin.rs`와, 이를 소비하는 React 페이지. config 스키마 무변경, npm 의존성 무추가.

**Tech Stack:** Tauri 2 command, serde_json/serde_yaml, React 18 + zustand(페이지 로컬 상태만), 공용 MarkdownView.

**Spec:** `docs/superpowers/specs/2026-09-05-plugin-page-design.md`

## Global Constraints

- UI 문구·에러 메시지 한국어. 코드/커밋 영어.
- npm 의존성 추가 금지 (opener는 Rust 쪽 기존 플러그인 사용).
- config.json 스키마 변경 금지.
- Rust contract 타입: `#[derive(Serialize)] #[serde(rename_all = "camelCase")]`.
- skills 디렉터리 동적 스캔 — 개수/이름 하드코드 금지.
- `open_external`은 `https://` 시작 URL만 허용. `read_skill`은 이름에 `/`, `\`, `..` 포함 시 거부.
- 커밋: conventional (feat:), 영어. 기존 미커밋 WIP는 내 커밋에 섞지 않는다(스테이지 단위 분리).

---

### Task 0: 베이스라인 확보 (기존 WIP 커밋)

**Files:**
- Commit-only: 현재 트리의 미커밋 변경분 (내 기능과 무관한 이전 세션 WIP — issue workflow, promote/initVault/setup 잡 종류 등)

**인터페이스:** 이후 태스크가 같은 파일(commands.rs, lib.rs, api.ts, store.ts, App.tsx 등)을 고치므로, WIP가 커밋되어 있어야 내 커밋이 순수하다.

- [ ] **Step 1: 빌드 확인** — `cd dashboard/src-tauri && cargo check` (통과 확인됨: 12.7s, 에러 없음) 및 `cd dashboard && npx tsc --noEmit` (통과 확인됨, 출력 없음=클린). 이미 실행해 그린이므로 재실행 불요.
- [ ] **Step 2: WIP를 별도 커밋으로 확정**

```bash
git add -A
git commit -m "feat: dashboard issue workflow, promote/init-vault/setup jobs (pre-existing WIP)"
```

- [ ] **Step 3: 클린 트리 확인** — `git status --porcelain` 출력 비어 있어야 함. 빈 값 아니면 중단하고 보고.

### Task 1: 백엔드 — `plugin.rs` 모듈 + command 등록

**Files:**
- Create: `dashboard/src-tauri/src/plugin.rs`
- Modify: `dashboard/src-tauri/src/lib.rs` (mod 선언 1-7행 영역 + invoke_handler 목록)
- Modify: `dashboard/src-tauri/src/commands.rs` (래퍼 3개 추가, `use crate::plugin;`)

**Interfaces:**
- Consumes: 없음 (신규 모듈). 기존 deps만: serde_json, serde_yaml, uuid(테스트 temp dir), tauri_plugin_opener.
- Produces (Task 2가 소비하는 Tauri command JSON 계약):
  - `plugin_info()` → `PluginBundle` (camelCase): `{ name, description, version, author, license, homepage, repository, keywords: string[], root: string, skills: { name, description }[] }` — Result, 실패 시 한국어 에러 문자열.
  - `read_skill(name: string)` → `string` (SKILL.md 원문) — Result.
  - `open_external(url: string)` → `void` — Result. https 한정.

- [ ] **Step 1: 실패하는 테스트 먼저 작성** — `plugin.rs`를 아래 골격과 테스트로 생성 (`lib.rs`에 `mod plugin;` 아직 없음 → 컴파일 실패가 실패 확인)

```rust
// plugin.rs — plugin metadata + skill catalog, read at runtime from the plugin root.

use std::path::{Path, PathBuf};

use serde::Serialize;

const MARKER: &str = ".claude-plugin/plugin.json";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginMeta {
    pub name: String,
    pub description: String,
    pub version: String,
    pub author: String,
    pub license: String,
    pub homepage: String,
    pub repository: String,
    pub keywords: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillInfo {
    pub name: String,
    pub description: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginBundle {
    pub root: String,
    #[serde(flatten)]
    pub meta: PluginMeta,
    pub skills: Vec<SkillInfo>,
}

/// Walk up from `start` looking for a directory containing `.claude-plugin/plugin.json`.
fn walk_up(start: &Path) -> Option<PathBuf> {
    let mut dir = Some(start);
    while let Some(d) = dir {
        if d.join(MARKER).is_file() {
            return Some(d.to_path_buf());
        }
        dir = d.parent();
    }
    None
}

/// Try each candidate (and its ancestors); error lists every searched root.
fn resolve_from(candidates: &[PathBuf]) -> Result<PathBuf, String> {
    let mut tried = Vec::new();
    for c in candidates {
        if let Some(root) = walk_up(c) {
            return Ok(root);
        }
        tried.push(c.display().to_string());
    }
    Err(format!(
        "플러그인 루트를 찾지 못했다. 탐색한 위치: {}",
        tried.join(", ")
    ))
}

/// exe 디렉터리 상위 탐색 → 빌드 머신 저장소 폴백. 설정 키 불필요.
pub fn resolve_root() -> Result<PathBuf, String> {
    let mut candidates: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            candidates.push(dir.to_path_buf());
        }
    }
    candidates.push(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."));
    resolve_from(&candidates).map(|p| p.canonicalize().unwrap_or(p))
}

/// Parse `name`/`description` from a SKILL.md YAML frontmatter block.
fn parse_frontmatter(text: &str) -> Option<(String, String)> {
    let text = text.replace("\r\n", "\n");
    let rest = text.strip_prefix("---\n")?;
    let end = rest.find("\n---")?;
    let v: serde_yaml::Value = serde_yaml::from_str(&rest[..end]).ok()?;
    let name = v.get("name")?.as_str()?.trim().to_string();
    if name.is_empty() {
        return None;
    }
    let desc = v
        .get("description")
        .and_then(|d| d.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    Some((name, desc))
}

pub fn list_skills(root: &Path) -> Vec<SkillInfo> {
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(root.join("skills")) else {
        return out;
    };
    for entry in rd.flatten() {
        let p = entry.path();
        if !p.is_dir() {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(p.join("SKILL.md")) else {
            continue;
        };
        if let Some((name, description)) = parse_frontmatter(&text) {
            out.push(SkillInfo { name, description });
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

pub fn plugin_info() -> Result<PluginBundle, String> {
    let root = resolve_root()?;
    let raw = std::fs::read_to_string(root.join(MARKER))
        .map_err(|e| format!("plugin.json 읽기 실패: {e}"))?;
    let v: serde_json::Value =
        serde_json::from_str(&raw).map_err(|e| format!("plugin.json 파싱 실패: {e}"))?;
    let s = |k: &str| {
        v.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string()
    };
    let author = match v.get("author") {
        Some(serde_json::Value::String(a)) => a.clone(),
        Some(o @ serde_json::Value::Object(_)) => {
            o.get("name").and_then(|n| n.as_str()).unwrap_or("").to_string()
        }
        _ => String::new(),
    };
    let keywords = v
        .get("keywords")
        .and_then(|k| k.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    Ok(PluginBundle {
        root: root.display().to_string(),
        meta: PluginMeta {
            name: s("name"),
            description: s("description"),
            version: s("version"),
            author,
            license: s("license"),
            homepage: s("homepage"),
            repository: s("repository"),
            keywords,
        },
        skills: list_skills(&root),
    })
}

pub fn read_skill(root: &Path, name: &str) -> Result<String, String> {
    if name.is_empty() || name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err("잘못된 스킬 이름".into());
    }
    let p = root.join("skills").join(name).join("SKILL.md");
    std::fs::read_to_string(&p).map_err(|e| format!("SKILL.md 읽기 실패: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn tempdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir()
            .join(format!("swdash-plugin-{tag}-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn walk_up_finds_marker_above_start() {
        let root = tempdir("root");
        fs::create_dir_all(root.join(".claude-plugin")).unwrap();
        fs::write(root.join(".claude-plugin/plugin.json"), "{}").unwrap();
        let deep = root.join("dashboard/src-tauri/target/debug");
        fs::create_dir_all(&deep).unwrap();
        assert_eq!(walk_up(&deep), Some(root.clone()));
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn resolve_from_lists_missed_candidates() {
        let a = tempdir("a");
        let b = tempdir("b");
        let msg = resolve_from(&[a.clone(), b.clone()]).unwrap_err();
        assert!(msg.contains(&a.display().to_string()));
        assert!(msg.contains(&b.display().to_string()));
        fs::remove_dir_all(&a).unwrap();
        fs::remove_dir_all(&b).unwrap();
    }

    #[test]
    fn parse_frontmatter_reads_name_and_description() {
        let md = "---\nname: morning\ndescription: 출근 브리핑 스킬\n---\n\n# morning\n본문";
        let got = parse_frontmatter(md).unwrap();
        assert_eq!(got.0, "morning");
        assert_eq!(got.1, "출근 브리핑 스킬");
    }

    #[test]
    fn parse_frontmatter_tolerates_crlf_and_missing_description() {
        let got = parse_frontmatter("---\r\nname: wiki\r\n---\r\n본문").unwrap();
        assert_eq!(got.0, "wiki");
        assert_eq!(got.1, "");
        assert!(parse_frontmatter("frontmatter 없음").is_none());
        assert!(parse_frontmatter("---\ndescription: 이름 없음\n---\n").is_none());
    }

    #[test]
    fn read_skill_rejects_path_tricks() {
        let root = tempdir("guard");
        for bad in ["", "../x", "a/b", "a\\b", ".."] {
            assert!(read_skill(&root, bad).is_err(), "{bad}");
        }
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn list_skills_skips_broken_dirs_and_sorts() {
        let root = tempdir("skills");
        let mk = |n: &str, md: &str| {
            let d = root.join("skills").join(n);
            fs::create_dir_all(&d).unwrap();
            if !md.is_empty() {
                fs::write(d.join("SKILL.md"), md).unwrap();
            }
        };
        mk("zzz", "---\nname: zzz\ndescription: last\n---\n");
        mk("aaa", "---\nname: aaa\ndescription: first\n---\n");
        mk("broken", "frontmatter 없음");
        mk("empty", "");
        let got = list_skills(&root);
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].name, "aaa");
        assert_eq!(got[1].description, "last");
        fs::remove_dir_all(&root).unwrap();
    }
}
```

- [ ] **Step 2: 실패 확인** — `cd dashboard/src-tauri && cargo test plugin::` → 모듈 미등록으로 컴파일 에러 (기대된 실패)
- [ ] **Step 3: 등록** — `lib.rs` 1-7행 mod 목록에 `mod plugin;` 추가
- [ ] **Step 4: 테스트 통과** — `cargo test plugin::` → 6개 PASS
- [ ] **Step 5: command 래퍼 추가** — `commands.rs` 끝에:

```rust
#[tauri::command]
pub fn plugin_info() -> Result<plugin::PluginBundle, String> {
    plugin::plugin_info()
}

#[tauri::command]
pub fn read_skill(name: String) -> Result<String, String> {
    let root = plugin::resolve_root()?;
    plugin::read_skill(&root, &name)
}

#[tauri::command]
pub fn open_external(app: AppHandle, url: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    if !url.starts_with("https://") {
        return Err("https URL만 허용".into());
    }
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| format!("링크 열기 실패: {e}"))
}
```

`commands.rs` 상단 use 블록에 `use crate::plugin;` 추가.
- [ ] **Step 6: 핸들러 등록** — `lib.rs` invoke_handler 목록(`commands::get_launch_at_login,` 뒤)에 추가:

```rust
            commands::plugin_info,
            commands::read_skill,
            commands::open_external,
```

- [ ] **Step 7: 전체 빌드** — `cargo check` 통과
- [ ] **Step 8: 커밋**

```bash
git add dashboard/src-tauri/src/plugin.rs dashboard/src-tauri/src/lib.rs dashboard/src-tauri/src/commands.rs
git commit -m "feat: plugin info backend (root scan, skill catalog, external links)"
```

### Task 2: 프론트엔드 — 타입·API·PluginPage·내비게이션

**Files:**
- Modify: `dashboard/src/lib/types.ts` (PluginBundle, SkillInfo 추가)
- Modify: `dashboard/src/lib/api.ts` (3개 호출 추가)
- Modify: `dashboard/src/lib/store.ts` (PageId 유니언에 `"plugin"`)
- Create: `dashboard/src/pages/PluginPage.tsx`
- Modify: `dashboard/src/App.tsx` (NAV 항목, import, switch 분기)

**Interfaces:**
- Consumes: Task 1의 command 계약 그대로 (`plugin_info` → PluginBundle, `read_skill` → string, `open_external`).
- Produces: 없음 (최상위 소비자).

- [ ] **Step 1: 타입 추가** — `types.ts`:

```ts
export interface SkillInfo {
  name: string;
  description: string;
}

export interface PluginBundle {
  name: string;
  description: string;
  version: string;
  author: string;
  license: string;
  homepage: string;
  repository: string;
  keywords: string[];
  root: string;
  skills: SkillInfo[];
}
```

- [ ] **Step 2: API 추가** — `api.ts` types import에 `PluginBundle` 추가, api 객체에:

```ts
  pluginInfo: (): Promise<PluginBundle> => invoke("plugin_info"),
  readSkill: (name: string): Promise<string> => invoke("read_skill", { name }),
  openExternal: (url: string): Promise<void> => invoke("open_external", { url }),
```

- [ ] **Step 3: PageId 확장** — `store.ts` 17행:

```ts
export type PageId = "home" | "improve" | "jobs" | "todos" | "docs" | "vault" | "plugin" | "settings";
```

- [ ] **Step 4: PluginPage 생성** — `dashboard/src/pages/PluginPage.tsx`:

```tsx
import { useEffect, useState } from "react";
import { ExternalLink, RefreshCw } from "lucide-react";
import { api } from "@/lib/api";
import type { PluginBundle } from "@/lib/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Empty, MarkdownView } from "./common";

export default function PluginPage() {
  const [bundle, setBundle] = useState<PluginBundle | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sel, setSel] = useState<string | null>(null);
  const [doc, setDoc] = useState<string | null>(null);
  const [docErr, setDocErr] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setErr(null);
    try {
      setBundle(await api.pluginInfo());
    } catch (e) {
      setErr(String(e));
      setBundle(null);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
  }, []);

  async function openSkill(name: string) {
    setSel(name);
    setDoc(null);
    setDocErr(null);
    try {
      setDoc(await api.readSkill(name));
    } catch (e) {
      setDocErr(String(e));
    }
  }

  if (loading) return <Empty className="pt-16">플러그인 정보를 불러오는 중…</Empty>;
  if (err || !bundle) {
    return (
      <div className="mx-auto mt-16 max-w-md text-center text-xs text-muted-foreground">
        <p className="mb-2 font-medium text-foreground">플러그인 정보를 읽지 못했다</p>
        <p className="mb-3 break-all">{err}</p>
        <Button variant="outline" size="sm" onClick={() => void load()}>
          <RefreshCw className="size-3" /> 다시 시도
        </Button>
      </div>
    );
  }

  const repo = bundle.repository || bundle.homepage;
  const homepage =
    bundle.homepage && bundle.homepage !== bundle.repository ? bundle.homepage : null;

  return (
    <div className="flex h-full flex-col">
      <div className="border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold">{bundle.name}</span>
          {bundle.version && <Badge variant="secondary">v{bundle.version}</Badge>}
        </div>
        {bundle.description && (
          <p className="mt-1 text-xs text-muted-foreground">{bundle.description}</p>
        )}
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          {bundle.author && <span className="text-[11px] text-muted-foreground">{bundle.author}</span>}
          {bundle.license && <Badge variant="outline">{bundle.license}</Badge>}
          {bundle.keywords.map((k) => (
            <Badge key={k} variant="outline">{k}</Badge>
          ))}
          <span className="ml-auto flex gap-1.5">
            {repo && (
              <Button variant="outline" size="sm" onClick={() => void api.openExternal(repo)}>
                <ExternalLink className="size-3" /> GitHub
              </Button>
            )}
            {homepage && (
              <Button variant="outline" size="sm" onClick={() => void api.openExternal(homepage)}>
                <ExternalLink className="size-3" /> Homepage
              </Button>
            )}
          </span>
        </div>
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="w-80 shrink-0 overflow-y-auto border-r p-2">
          {bundle.skills.map((s) => (
            <button
              key={s.name}
              onClick={() => void openSkill(s.name)}
              className={cn(
                "block w-full rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent",
                sel === s.name && "bg-secondary",
              )}
            >
              <div className="text-[13px] font-medium">{s.name}</div>
              <div className="truncate text-[11px] text-muted-foreground" title={s.description}>
                {s.description}
              </div>
            </button>
          ))}
        </div>
        <div className="min-w-0 flex-1 overflow-y-auto px-4 py-3">
          {docErr && <Empty>{docErr}</Empty>}
          {!docErr && !doc && <Empty>왼쪽에서 스킬을 선택하면 SKILL.md 전문이 표시된다</Empty>}
          {doc && <MarkdownView src={doc} />}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: App.tsx 연결** — lucide import에 `Puzzle` 추가, `import PluginPage from "@/pages/PluginPage";`, NAV의 vault 항목 뒤에 추가:

```ts
  { id: "plugin", label: "플러그인", icon: Puzzle },
```

switch에 추가:

```ts
      case "plugin":
        return <PluginPage />;
```

- [ ] **Step 6: 타입체크+빌드** — `cd dashboard && npm run build` 통과
- [ ] **Step 7: README 갱신** — `dashboard/README.md`에 페이지 목록이 있으면 `- 플러그인 — 메타데이터·GitHub 링크·스킬 설명 열람` 한 줄 추가 (목록 없으면 생략)
- [ ] **Step 8: 커밋**

```bash
git add dashboard/src/lib/types.ts dashboard/src/lib/api.ts dashboard/src/lib/store.ts dashboard/src/pages/PluginPage.tsx dashboard/src/App.tsx dashboard/README.md
git commit -m "feat: plugin info page (metadata, github links, skill docs)"
```

### Task 3: 검증 (부팅 스모크 + 화면 확인)

**Files:**
- Create 없음. 산출물은 검증 증거.

- [ ] **Step 1: 전체 Rust 테스트** — `cd dashboard/src-tauri && cargo test` 전부 PASS
- [ ] **Step 2: 프론트 빌드** — `cd dashboard && npm run build` 통과
- [ ] **Step 3: 부팅 스모크** — 실행 중 인스턴스 있으면 `pgrep -fl si-workbench`로 확인하고 스킵(사용자 앱 방해 금지), 없으면:

```bash
cd dashboard/src-tauri && cargo build && BIN=$(cargo metadata --no-deps --format-version 1 | jq -r '.packages[0].targets[] | select(.kind[0]=="bin") | .name') && (./target/debug/$BIN &) && sleep 6 && pgrep -fl "$BIN"
```

6초 생존 확인(setup 클로저 토큰 런타임 패닉 재발 방지).
- [ ] **Step 4: 화면 확인(베스트 에포트)** — `screencapture -x /tmp/dash-plugin.png` 후 사이드바에 '플러그인' 항목 노출 확인. 페이지 클릭은 osascript 접근성 권한에 좌우되므로 불가하면 부팅 스모크+단위 테스트를 증거로 명시하고 보고.
- [ ] **Step 5: 트리 클린 확인** — `git status --porcelain` 비어 있음. 파일이 남으면 batch-commit-autonomously로 정리.

---

## Self-Review 기록

- **Spec 커버리지**: 메타데이터 카드(=Task 2 헤더), GitHub/Homepage 링크(=open_external+버튼), 스킬 목록+전문(=리스트+MarkdownView), 루트 해석 체인(=resolve_root), 에러 카드+재시도(=PluginPage 오류 분기), 단위 테스트 6종(=Task 1), 부팅 스모크(=Task 3) — 스펙 전 섹션 매핑 완료.
- **플레이스홀더**: 없음 — 모든 코드 블록 완전 본문.
- **타입 일관성**: `PluginBundle`/`SkillInfo` 필드명 Rust(camelCase serde)↔TS 1:1 확인. `read_skill` 반환 string, Task 2 Step 2와 일치. `resolve_from`/`walk_up` 서명 Task 1 내부 일치.
