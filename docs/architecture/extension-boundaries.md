# 워크플로우·문서 스키마·확장의 경계

2026-09-08. 현재 구현과 번들 자산을 기준으로 정리했다.

| 구성 | 소유하는 것 | 정본 |
|---|---|---|
| 앱 코어 | 프로젝트, 작업, 공정 결정, 마일스톤, 실행, 볼트 점검 | `projects/`, `work/`, `calendar/`, `runs/`, 네이티브 `vault` 화면 |
| 워크플로우 | 단계, 산출물, 증거, 전이 규칙, 필요한 확장·프로그램 | `.sawhorse/workflows/<id>/<version>.json` |
| 문서 스키마 | 사용자 문서의 타입·필드·경로·이관 규칙 | `.sawhorse/schemas/<id>/<revision>.json` |
| 일지 확장 | 하루 기록, 빠른 메모, 일과 루틴, 업무 보고, 주간 회고 | `plugin/packs/journal/pack.json` |
| 할 일 확장 | 오늘·내일 체크리스트 화면 | `plugin/packs/todos/pack.json` |
| 개념 확장 | 개념 노트·분류·출처·연결 | `plugin/packs/concepts/pack.json` |
| 프로젝트 문서화 확장 | 제안서·코드베이스 기반 프로젝트 지식 문서 | `plugin/packs/project-docs/pack.json` |
| 확장 패키지 v2 | 프로젝트별 선택 기능과 권한·의존성·payload | `extension.json`, `.sawhorse/extensions.lock.json` |
| 에이전트 플러그인 | 코어·팩 스킬과 훅의 배포 | `plugin/.claude-plugin/plugin.json` |

팩은 사용자가 독립적으로 켜고 끌 수 있는 기능 하나와 그 기능의 문서·자동화를 묶는다. 업종·고객·업무방식은 확장 경계가 아니다. 공통 작업 생명주기와 볼트 점검은 앱 코어가 소유한다. 자동화 `TaskDef`는 저장한 실행 프롬프트이며 개발 `WorkItem`과 구별한다.

앱 공통 환경 목록에는 Obsidian과 Herdr만 둔다. Git·Node.js·Pandoc·Office 같은 도구와
`xlsx-export` 같은 패키지는 이를 쓰는 불변 워크플로우 revision의 `requirements`가 소유한다.
`required` 요구사항은 실행 직전에 프로젝트 extension lock과 로컬 실행 파일을 검사하고,
`recommended`·`optional`은 이식 가능한 안내 메타데이터로 남는다. 따라서 한 회사의 산출물
관행이 새 사용자의 시작 마법사나 다른 회사의 워크플로우에 새어 나오지 않는다.

## 제거한 잔재

- `improve` 호환 스킬과 사용되지 않는 설계·승격·구현 참조를 제거했다. 일반적인 개선 요청을 옛 저장 구조로 보내지 않는다.
- `SI 업무`와 `기본 작업` 묶음을 제거하고 `journal`, `todos`, `concepts`, `project-docs` 기능 확장으로 분해했다. 기존 `si`·`starter` 활성 설정과 일지 설정은 호환 읽기 후 첫 변경 때 새 ID로 정규화한다.
- `점검`은 팩의 `type: native` 기여에서 앱 코어 화면으로 이동했다. 어떤 기능 확장을 꺼도 점검 진입점은 사라지지 않는다.
- 이전 SI 묶음의 `improve-excel`과 전용 XLSX 코드를 제거했다. 내보내기는 선택 확장 `xlsx-export`가 소유한다. 과거 `kind: excel` 실행 요청은 확장 설치·활성화를 안내하는 오류를 반환한다.
- 개선·이슈·마일스톤의 이전 템플릿과 Base를 신규 볼트 시드에서 제거했다. 지식 대시보드에서 승인 체크박스와 이전 이슈 표를 제거했다.
- `issues`, `sdd`, 초기화·환경 진단·프로젝트 문서 스킬을 현재 워크플로우 계약에 맞췄다. 루틴에 복제된 위생 지침은 `vault-tidy`로 모았다.
- 범용 일지 템플릿은 `템플릿/journal/`에 배치하고 기존 업무일지 템플릿은 같은 일지 확장이 소유한다. 이미 만든 일지는 원래 절과 내용을 유지한다.
- XLSX v1.1.0은 현재 작업 레코드를 조회하고 프로젝트 문맥을 전달한다. payload 해시도 실제 파일과 일치시켰다.

## 문서 스키마와 정리

`.sawhorse/schema.json`은 코어 저장 형식의 버전 표식이다. 사용자 문서 타입 카탈로그와 같은 파일이 아니다. 스키마 편집기의 기본 예제는 `문서/{id}.md`에 저장하는 일반 문서다. 코어 레코드 경로와 숨김 상태 경로는 사용자 스키마 대상으로 허용하지 않는다.

볼트 위생 스크립트는 루트에 쌓인 첨부만 회수한다. 하위 폴더의 첨부는 문서·확장이 소유할 수 있으므로 이동하지 않는다. 제목·템플릿 정합은 일반 지식 문서에만 적용하고, `typeId` 문서와 코어·레거시 기록은 보존한다. 숨김 폴더와 심볼릭 링크는 순회하지 않는다. 스키마 스캔 역시 숨김 상태를 문서로 읽지 않는다.

## 남겨 둔 호환 경계

새 앱은 첫 실행에서 기존 사용자 볼트와 Sawhorse 설치본을 백업한 뒤 [자동 업그레이드](automatic-upgrades.md)한다. 저장소 검증 과정에서는 실제 사용자 데이터에 적용하지 않는다. `프로젝트/`·`사업/`의 과거 이슈·개선 노트, `migrated_to`, `improve.projects`, 과거 승인 필드, 잡 이력의 엑셀 경로는 기존 데이터의 조회·이관에 필요하다. 이 이름이 소스에 있다는 이유만으로 지우지 않는다. 과거 필드는 새 작업의 승인·상태 정본이 아니다.

사용자 팩 로더와 connector manifest는 기존 설치 지원을 위해 유지한다. 새 통합 기능은 package v2를 사용한다. 모든 기존 설치를 v2로 자동 변환하거나 공개 workflow 버전을 덮어쓰지 않는다.

앱의 플러그인 카탈로그는 팩의 선언 목록을 사용하므로 이전 설치에서 남은 미선언 스킬 폴더를 다시 노출하지 않는다. 새 앱의 첫 실행은 이전 Claude/Codex Sawhorse 설치 사본을 백업한 뒤 교체한다. 일반 수동 설치의 수정본 보존 정책과 별도로, 버전 업그레이드는 백업·검증·복구 기록을 사용한다.

## 검증

```bash
node plugin/validate.mjs
node plugin/extension-packages/validate.mjs
node --test plugin/hooks/hooks.test.mjs plugin/scripts/*.test.mjs plugin/extension-packages/*/skills/*/scripts/*.test.mjs
cd app
bun run build
cd src-tauri
cargo test --lib
```

팩 검사에서는 스킬 이름·선언·실제 디렉터리, 액션의 호출 대상, 시드 존재·경로 충돌, 번들 참조를 확인한다. 회귀 검증은 실제 임시 볼트에서 읽기 전용·멱등성·보존 경계와 폐지된 실행 경로를 확인한다. 검증은 CI에도 연결했다.

2026-09-08 검증 결과: 프런트엔드 프로덕션 빌드, Rust 365개 테스트 통과(1개 무시), Node 37개 테스트 통과, 번들 스킬 19개 검증, 두 확장 패키지 digest 검사 통과. 기능별 내비게이션 UI 회귀 1개도 통과했다. 전체 UI 회귀 묶음은 다시 실행하지 않았으므로 전체 통과로 간주하지 않는다.
