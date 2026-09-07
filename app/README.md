# Sawhorse 데스크톱

React + TypeScript + Tauri 2. SDD 코어는 앱에 내장되며 기존 팩과 협업 기능도 유지한다.

작업대 위젯·작업과 예약·확장·전체 검색의 역할과 데이터 호환성은 [작업 중심 앱 구조](../docs/architecture/product-organization.md)를 참고한다.

```bash
npm ci
npm run tauri dev
npm run build
npx playwright install chromium
npm run test:e2e
(cd src-tauri && cargo test --lib)
npm run tauri build
```

프론트엔드만 실행할 때 `npm run dev` 후 `?preview=1`로 브라우저 체험을 연다.
체험 데이터는 브라우저의 localStorage에만 저장된다. 데스크톱 오류를 예제로 숨기지 않는다.

| 위치 | 역할 |
|---|---|
| src/features/workbench | 작업대·산출물 편집·동적 workflow UI·runtime ledger·SDD 호환 IPC |
| src/features/workflow-studio | 노드/산출물/하위 workflow 편집·검증·시뮬레이션·발행 |
| src/features/schema-studio | 문서 타입/필드/경로/템플릿 편집과 migration preview/apply |
| src/pages/OnboardingPage.tsx | snapshot 기반 프로젝트 가져오기·재개·근거·충돌 검토 |
| src-tauri/src/sdlc.rs | Markdown 스키마·CRUD·검토 결정·의존성·문서 충돌·검색 |
| src-tauri/src/sdlc_harness.rs | Herdr 실행·복구·출력 기록·제어·하위 실행 요청 |
| src-tauri/src/workflow | 정의·검증·중첩 실행 엔진·SQLite instance/node/event 장부 |
| src-tauri/src/schemas | schema draft/publish/activate와 필드·경로·링크 migration |
| src-tauri/src/changes | hash/CAS 기반 preview·journal·apply·rollback·recovery |
| src-tauri/src/extensions/package.rs | package v2 설치·resolve·lock·권한·portable export |
| src-tauri/src/ingestion.rs | 입력 snapshot·evidence·checkpoint·문서 초안·merge base |
| src-tauri/src/herdr.rs | Herdr CLI 어댑터 |
| src-tauri/src/collab | 기존 협업 세션·검토·통합 |
| src-tauri/src/packs.rs | 선택적 워크플로 팩 |
| ../plugin/skills/sdd | 하네스 에이전트의 산출물 규약 |
| tests | 브라우저 사용자 흐름 검증 |

코어 스키마의 정본은 vault의 `.sawhorse/schema.json`, 발행 schema/workflow JSON과 Markdown이다.
실행·가져오기 상태는 `.sawhorse/runtime.sqlite`, package 선택은 `.sawhorse/extensions.lock.json`이 정본이다.
사용자 환경 설정은 기존 `~/.claude/sawhorse/config.json`을 사용한다.
테스트는 임시 폴더와 명시적 브라우저 체험을 사용하며 실제 사용자 볼트를 변경하지 않는다.

## GitHub OAuth 설정

GitHub 확장의 계정 연결은 OAuth Device Flow를 사용한다. 기본 빌드에는 등록된 SawHorse
OAuth App의 공개 Client ID가 포함되어 있어 별도 설정 없이 로그인할 수 있다. Client Secret은
사용하지 않는다. 앱 등록에서 `Enable Device Flow`와 토큰 만료를 활성화했으며, 만료된 토큰은
refresh token으로 갱신한다. 등록된 리디렉션 URI `http://127.0.0.1`은 Device Flow에서 사용하지 않는다.

별도 OAuth App을 사용하려면 해당 앱의 `Enable Device Flow`를 켜고 Client ID를 다음처럼 지정한다.

```bash
SAWHORSE_GITHUB_CLIENT_ID=YOUR_CLIENT_ID npm run tauri dev
SAWHORSE_GITHUB_CLIENT_ID=YOUR_CLIENT_ID npm run tauri build
```

환경변수는 실행 시 값, 빌드 시 값, 기본 Client ID 순서로 적용된다. 비공개 저장소
탐색·가져오기를 위해 `read:user repo` 범위를 요청하며, 실제 확장 동작은 호스트 브로커가 허용한
읽기 요청과 Git clone으로 제한한다. 기존 버전에서 저장한 PAT는 연결 해제 전까지 읽을 수 있지만,
새 로그인 화면에서는 PAT 입력을 제공하지 않는다.

[전체 설계](../docs/architecture/sdd-workbench.md) · [API 계약](../docs/architecture/sdd-contract.md)
