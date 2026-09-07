# 목업 산출물 계약

등록 스크립트 입력은 UTF-8 JSON 한 파일이다.

```json
{
  "id": "mockup-20260907-account-settings",
  "title": "계정 설정 개선 목업",
  "projectId": "sample-app",
  "selectionMode": "explicit",
  "revision": 1,
  "parentMockupId": "",
  "issues": [
    { "id": "APP-012", "title": "알림 설정 구분", "screenId": "notification-settings" }
  ],
  "screens": [
    {
      "id": "notification-settings",
      "label": "알림 설정",
      "context": "설정 > 알림",
      "assignment": "explicit",
      "baseline": ["현재 이메일과 앱 알림이 한 토글로 묶여 있다."],
      "evidence": ["src/pages/settings/..."],
      "proposal": ["채널별 토글과 저장 피드백을 분리한다."],
      "acceptance": ["APP-012가 목업에서 조작 가능하다."],
      "html": "screens/notification-settings.html",
      "preview": "screens/notification-settings.png"
    }
  ]
}
```

`id`, `title`, `projectId`, `issues`, `screens`는 필수다. ID는 영문·숫자·하이픈·밑줄만 쓴다. `selectionMode`는 `explicit` 또는 `all`이다. 이슈는 중복될 수 없고 모든 이슈의 `screenId`가 실제 화면 하나를 가리켜야 한다. 화면 ID도 중복될 수 없다.

최초 생성은 `revision: 1`, `parentMockupId: ""`다. 개정본은 기존 `work/<parentMockupId>/mockup-manifest.json`을 실제로 찾아 같은 프로젝트인지 확인하며, `revision`은 부모보다 커야 한다. 생략하면 부모 revision + 1을 사용한다. 이전 목업은 수정하거나 덮어쓰지 않는다.

`html`은 manifest 파일 기준 상대경로나 절대경로다. 스크립트가 `work/<id>/assets/<screen-id>.html`로 복사한다. `preview`는 선택이며 PNG/JPG/WebP/SVG만 허용한다. 생략하면 로컬 Edge·Chrome·Chromium을 찾아 1440×1000으로 캡처하고, 브라우저가 없으면 현행/개선 요약이 든 SVG를 만든다.

HTML은 단일 파일로 동작해야 한다. 외부 `script`, `link`, `img`, `iframe`, CSS `url(http...)`, `fetch`, `XMLHttpRequest`, `WebSocket`, ES module import가 있으면 등록을 거부한다. 다른 화면으로 나누어야 할 때는 `screens` 항목을 추가하며 한 HTML에 여러 unrelated 화면을 몰아넣지 않는다.

등록 결과:

```text
work/<id>/
  work.md
  intent.md
  baseline.md
  proposal.md
  mockup.md
  feedback.md
  verification.md
  mockup-manifest.json
  assets/
    <screen-id>.html
    <screen-id>.png 또는 .svg
```

`proposal.md`는 거친 백로그를 화면별 문제·제안·수용 기준으로 정리한다. `mockup.md`에는 프로젝트·원본 이슈·화면 수·revision·부모 목업과 각 화면의 미리보기/HTML 링크가 들어간다. `feedback.md`는 화면별 수정 요청과 새 개선 제안의 인박스다. `work.md`는 `mockup-review@1.1.0`을 고정하며 작업대의 검토 대상으로 나타난다. 기존 경로가 있으면 덮어쓰지 않는다.

피드백 한 줄의 형식은 다음과 같다.

```markdown
## 목업 수정 요청

- [ ] [notification-settings] 저장 버튼을 하단에 고정한다

## 새 개선 제안

- [ ] [notification-settings] 키보드 포커스가 보이지 않는다
```

`process-feedback.mjs`는 체크되지 않은 줄을 각각 `issue-main@1.1.0` 백로그로 승격하고 성공한 줄만 체크한다. 생성한 이슈의 `intent.md`에는 원본 목업과 화면을 남긴다. 재실행할 때 이미 체크된 줄은 처리하지 않는다.
