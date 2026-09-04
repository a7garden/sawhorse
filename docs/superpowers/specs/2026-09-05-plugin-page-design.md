# 대시보드 플러그인 정보 페이지 설계

날짜: 2026-09-05. 상태: 검토 대기.

## 목적

대시보드에서 si-workbench 플러그인 자체의 정보를 열람한다: 플러그인 메타데이터
(이름·버전·설명·라이선스·키워드), GitHub 링크, 스킬 14개의 이름·설명.
볼트나 Obsidian을 열지 않고도 "이 플러그인에 뭐가 있지?"를 답한다.

## 결정된 사항 (사용자 확인)

1. 배치: 전용 '플러그인' 페이지 (사이드바 8번째 항목, 설정 앞).
2. 범위: `plugin.json` 메타데이터 + `skills/*/SKILL.md`의 name·description.
   훅·스크립트·설정 상태는 제외.
3. 스킬 상세: 목록에서 클릭 시 SKILL.md 전문을 기존 마크다운 뷰어로 표시.

## 데이터 소스: 런타임 스캔

빌드타임 임베드(재빌드 전까지 stale, 스킬 편집마다 재컴파일)와 설정 경로 키
(config 스키마 변경 + 설정 마찰)를 기각. 런타임에 플러그인 저장소를 직접 읽어
항상 최신을 보장한다. 앱 재빌드 불요.

플러그인 루트 해석 체인 (`resolve_root()`):

1. `current_exe()`에서 상위 디렉터리로 올라가며 `.claude-plugin/plugin.json`이
   있는 지점 탐색 — target/debug, target/release, target 내 .app 번들 전부 커버.
2. 폴백: `env!("CARGO_MANIFEST_DIR")/../..` (빌드 머신의 저장소 경로).

설정 키 추가 없음. config.json 스키마 무변경.

## 백엔드 — 새 모듈 `src-tauri/src/plugin.rs`

- `resolve_root() -> Result<PathBuf, String>` — 위 체인. 실패 시 탐색한 경로를
  나열한 에러 메시지.
- `plugin_info()` command → `PluginBundle`:
  - `meta`: name, description, version, author, license, homepage, repository,
    keywords — plugin.json을 serde_json으로 파싱, 누락 필드는 빈 값 허용.
  - `skills`: `Vec<SkillInfo { name, description }>` — `skills/` 하위 디렉터리를
    동적 스캔(개수 하드코드 없음). SKILL.md frontmatter를 serde_yaml으로 파싱
    (모든 YAML 스타일 내성). SKILL.md 없거나 파싱 실패한 디렉터리는 건너뛰고
    name 기준 정렬.
- `read_skill(name)` command → `{ name, markdown }` —
  `skills/<name>/SKILL.md` 원문. **name 검증**: `/`, `\`, `..`, 빈 문자열 포함 시
  거부(경로 탈출 차단). 검증 후 `resolve_root()` 결과에 조립.
- `open_external(url)` command — `https://`로 시작하는 URL만 허용하고 이미
  등록된 `tauri_plugin_opener`로 연다. npm 의존성·capability 추가 없음.
- commands.rs에 얇은 래퍼 3개 추가, lib.rs invoke_handler 등록.

## 프론트엔드

- `src/pages/PluginPage.tsx` 신규:
  - 헤더 카드: 플러그인 이름 + 버전 배지, 설명, author·license·키워드 칩,
    GitHub Repository / Homepage 버튼(`open_external`). homepage가 repository와
    같으면 버튼 하나로 병합.
  - 스킬 목록: 이름 + 설명 행(설명은 길면 말줄임). 행 클릭 → 상세 패널에
    SKILL.md 전문을 `common.tsx`의 공용 Markdown 뷰어로 렌더 (DocsPage 패턴).
  - 데이터는 마운트 시 1회 조회. 로컬 컴포넌트 상태 사용 — zustand store에는
    PageId 추가 외 변경 없음.
- `store.ts`: `PageId` 유니언에 `"plugin"` 추가.
- `App.tsx`: NAV에 `{ id: "plugin", label: "플러그인", icon: Puzzle }` 추가
  (설정 앞), switch 분기 추가.

## 오류 처리

- 플러그인 루트 미발견 → 페이지에 탐색한 경로와 함께 에러 카드 표시
  (재시도 버튼).
- plugin.json 파싱 실패 → 동일 에러 카드(사유 표시).
- 개별 스킬 로드 실패 → 상세 패널에 에러 메시지. 목록은 유지.

## 테스트

- Rust 단위: 루트 해석(fixture 트리에서 상위 탐색), frontmatter 파싱
  (단일행/특수문자 description), read_skill 경로 탈출 거부.
- 빌드: cargo test, tsc + vite build.
- 부팅 스모크: 디버그 바이너리 직접 실행 수 초 생존 확인(setup 클로저 규칙 준수).
- 수동: 실행 후 플러그인 페이지에서 메타데이터·링크·스킬 상세 확인.

## 비목표 (v1)

- 훅·스크립트 문서화, 플러그인 정보의 설정 연동, 스킬 실행 버튼
  (잡 실행은 기존 개선/작업 페이지 역할), 스킬 검색/필터.
