# 크로스플랫폼 런타임 설계 — Windows를 1급 플랫폼으로

날짜: 2026-09-07. 상태: 설계 (구현 전).

## 문제

**Windows 번들은 정기적으로 출하되는데, Windows 코드는 출하 전 단 한 번도
컴파일·실행된 적이 없다.** 근거:

| 관찰 | 위치 |
|---|---|
| 릴리스는 Windows 번들(nsis)을 만든다 | `release.yml` windows-latest |
| CI 매트릭스는 macos + ubuntu뿐 — `cargo test`가 Windows에서 돈 적이 없다 | `ci.yml` app job |
| 사례 1 (수정됨): 콘솔 자식 스폰에 `CREATE_NO_WINDOW` 부재. 백그라운드 틱(collab 3s · 하니스 5s · 스케줄러 20s · 작업 폴링 1s)이 스폰할 때마다 콘솔 창이 깜빡임 | `spawn.rs` 이전 전역, 커밋 9db1979 |
| 사례 2 (미수정): 확장 시크릿 저장이 macOS `security` CLI를 플랫폼 가드 없이 호출 — Windows에서 GitHub OAuth 토큰 저장·조회가 전부 실패 | `extensions/broker.rs` `secrets` |
| headless 러너 폴백이 존재하지만 Windows에서 검증된 적 없음 | `config.rs` `effective_runner` |
| 매 틱 `config::load_view()` — 45곳. 틱마다 디스크 동기 읽기, 틱 사이 설정 불일치 여지 | 전역 |
| `Result<_, String>` 문자열 오류 — "미설치"와 "크래시"를 UI가 구분 불가 | 전역 |

사례 1·2는 같은 부류다: **개발 머신(macOS)에서 실행되지 않는 `cfg(windows)`
분기는 검증자가 없고, 검증자가 없는 코드는 반드시 썩는다.**

## 설계 원칙

1. **플랫폼 차이는 `spawn.rs` 한 곳에서 흡수한다.** 빌더마다 복제하지 않는다.
2. **양쪽 플랫폼의 보증 경로는 headless 러너다.** herdr는 향상 레이어다.
3. **검증은 CI가 한다.** "macOS에서 컴파일됐다"는 Windows를 위한 근거가 아니다.

## 결정 1 — Windows CI 게이트 (최우선)

`ci.yml` app job 매트릭스에 `windows-latest` 추가:

- `npm run build` (tsc 포함) — 프론트엔드 타입 게이트
- `cargo test` — `cfg(windows)` 분기가 **실제로 컴파일되고 실행**된다

스포 계약 스모크 테스트 1개를 cargo test에 추가한다: fixture 에이전트
(`.cmd` / `.sh` 각 플랫폼용)를 스폰 → stdout 수집 → 정상 종료를 단언.
`cmd /c` 래핑, `.cmd` 셈 해석, `CREATE_NO_WINDOW`, stderr 파이프가
매 푸시마다 검증된다.

근거: 오늘의 두 사례 모두 "컴파일된 적 없는 분기"에서 나왔다. 이 게이트
하나로 부류 전체가 차단된다.

## 결정 2 — `spawn.rs`를 프로세스 정책의 유일한 문으로

현황: `CREATE_NO_WINDOW`는 통합됐으나(9db1979) `cmd /c` 래핑이 여전히
4개 빌더(`config.rs` · `detect.rs` · `herdr.rs` · `jobs.rs`)에 복제돼 있고,
PATHEXT 해석은 `detect.rs`에 있다.

변경: `spawn.rs`에 std/tokio 공용 `platform_command(bin, args)`를 둔다.

- Windows에서 `.cmd`/`.bat`은 `cmd /c` 래핑 (빌더별 중복 제거)
- `CREATE_NO_WINDOW` 상시 적용
- cwd/env는 기존 빌더 체인 그대로

새 스폰 지점은 `crate::spawn`만 쓴다. `Command::new` 직접 사용은
grep 게이트로 검사한다(래퍼 자체와 테스트 제외).

## 결정 3 — 시크릿 저장소 추상화

`broker.rs` `secrets`의 `security` CLI 호출을 **`keyring` 크레이트**로
교체한다 (macOS Keychain · Windows Credential Manager · Linux Secret
Service 네이티브 백엔드). DB에는 계속 secret_ref 이름만 남긴다 —
"DB에 시크릿 본문을 저장하지 않는다"는 기존 계약(설계 512줄) 유지.

대가: 의존성 1개 추가. 대신 3플랫폼 보안 저장소가 표준 구현으로 해결되고,
Windows에서 확장 GitHub OAuth가 동작하게 된다.

## 결정 4 — 러너 계약 고정

- **headless = 보증 경로.** 파이프 stdio + 트랜스크립트 폴링. 모든
  플랫폼에서 반드시 동작한다. herdr가 없어도 제품은 완전히 동작한다.
- **herdr = 대화형 강화 레이어.** 도달 가능하면 쓰고, 아니면 폴백한다
  (기존 `effective_runner` 로직 유지).
- 변화: 폴백이 조용히 일어나지 않게 한다. `HerdrDiag`에 폴백 사유를
  담고 작업대 UI에 노출한다 — "herdr 미설치, headless로 실행 중".

명시적 한계: herdr 없는 Windows에서 하니스의 화면 캡처 기반 관찰은
트랜스크립트 폴링로 대체되며 관찰 해상도가 낮아진다. 이는 제거할 수
없는 한계가 아니라 herdr의 Windows 지원 범위에 달린 문제로, 앱 쪽
계약은 "headless로도 완결"로 고정한다.

herdr CLI의 spawn-per-op 구조는 유지한다(데몬이 소켓으로 실제 서비스를
제공하므로 비용은 프로세스 기동 + 수십 ms). 장기 연결 전환은 herdr 쪽
과제로 분리하고, 이 문서의 범위가 아니다.

## 결정 5 — 오류 타입화

`thiserror`로 코어 오류 코드 체계를 도입한다: `spawn_not_found` ·
`spawn_failed` · `timeout` · `agent_exit` · `config_invalid` 등.
`HerdrError { code, message }` 패턴을 일반화한다.

효과: UI가 코드로 분기해 플랫폼별 안내가 가능해진다 — "PATH에 claude가
없다(설치 경로 확인)"과 "에이전트가 크래시했다(로그 확인)"는 다른 메시지여야
한다. 진단·로그·재시도 정책도 코드 기준으로 정리된다.

## 결정 6 — 설정 스냅샷

부팅 1회 로드 + `save_patch` 시 갱신 + notify 워처로 외부 변경 반영하는
`ArcSwap<ConfigView>` 단일 스냅샷을 둔다. 45곳의 `load_view()` 호출을
스냅샷 read로 교체한다.

효과: 틱마다 디스크 읽기 제거, 틱 사이 설정 일관성 보장. 쓰기는
`save_patch` 단일 진입점이라 갱신 트리거를 모으기 쉽다(읽기 45곳만 교체).

## 마이그레이션 순서

**1단계 — 버그 등급 (플랫폼 안정성 직결)**

1. `ci.yml`에 windows-latest 추가 + 스폰 스모크 테스트 (결정 1)
2. `spawn.rs` 프로세스 정책 통합, 4개 빌더의 `cmd /c` 제거 (결정 2)

**2단계 — 기능 결손**

3. `keyring` 이주, `security` CLI 삭제 (결정 3)

**3단계 — 계약 고정**

4. 러너 폴백 진단 UI 노출 (결정 4)
5. 오류 타입화 (결정 5)

**4단계 — 체질 개선 (별도 트랙)**

6. 설정 스냅샷 (결정 6)
7. `jobs.rs`(2501줄) · `WorkbenchPage.tsx`(4553줄) 분할과 e2e 확대는
   별도 설계로 — 플랫폼 안정성과 직결되지 않아 이 문서의 급이 아니다.

각 단계는 CI 게이트 위에서 끝낸다. 1단계가 먼저인 이유는 이후 모든
단계의 검증을 그 게이트가 대신하기 때문이다.

## 버리는 것

- macOS `security` CLI 직접 호출 (`broker.rs` secrets)
- 4곳에 복제된 `cmd /c` 래핑
- 매 틱 config 파일 읽기
- "macOS에서 됐으니 Windows도 되겠지" 출하 관행

## 대가와 리스크

- **CI 시간 증가** (Windows 러너 추가) — `fail-fast: false` 유지로 한쪽
  고장이 다른 쪽을 막지 않게 한다.
- **`keyring` 의존성** — OS 네이티브 백엔드를 쓰는 표준 크레이트. 봇인
  환경(CI)에서는 키체인이 없어 실패할 수 있으므로 시크릿 경로 테스트는
  로컬·수동 검증 항목으로 남긴다.
- **스냅샷 도입** — 설정 갱신 경로를 모두 스냅샷 갱신으로 모아야 한다.
  쓰기가 `save_patch` 단일 진입점이라 통제 가능하다.
- **headless 관찰 해상도** — 위 결정 4의 명시적 한계.
