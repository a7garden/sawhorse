# Sawhorse extension packages

각 하위 폴더는 `manifestVersion: 2`인 `extension.json`과 digest로 고정된 payload를 가진다.
앱의 확장 화면은 로컬 폴더·portable JSON 파일·정확한 Git commit·HTTPS에서 패키지를 설치하고,
의존성과 엔진 API 범위를 해석한 뒤 프로젝트별 권한과 정확한 digest를
`.sawhorse/extensions.lock.json`에 기록한다.

```bash
node plugin/extension-packages/validate.mjs
```

CI도 같은 명령으로 번들 패키지의 전체 파일 목록, SHA-256, contribution 경로를 검사한다.
앱에서 내보낸 `*.sawhorse-package.json`은 payload를 base64로 보존하므로 텍스트와 바이너리를
같은 방식으로 다시 설치할 수 있다. 설치는 스킬이나 액션을 실행하지 않는다.

현재 `xlsx-export`는 기본 코어와 SI 팩에서 분리된 선택 확장이다. 활성화하지 않은 프로젝트에는
XLSX 액션과 화면이 나타나지 않으며, 활성화할 때 `adapter:xlsx-export`와 볼트 권한을 명시적으로
승인해야 한다.

`ui-mockup`은 이슈 목록에서 체크한 항목만 대상으로 현행 UI를 조사하고, 화면 맥락별 A/B 목업을
만드는 선택 확장이다. 전부 선택해도 서로 다른 화면을 한 목업에 합치지 않는다. 결과는
`mockup-review` 작업과 HTML·미리보기 산출물로 등록되어 작업대와 「목업 산출물」 화면에서 검토한다.
거친 백로그도 화면별 문제·제안·수용 기준으로 구체화하며, 검토 의견은 원본 화면에 연결된 새 백로그와
덮어쓰지 않는 목업 revision으로 순환한다. 작업대는 승인과 수정 요청을 서로 다른 전환으로 보여 준다.
선택형 액션을 제공하는 선언형 뷰는 `selection: "multiple"`을 선언해야 하며, 호스트는 체크한 행의
ID와 전체 선택 여부를 액션 파라미터로 전달한다.
