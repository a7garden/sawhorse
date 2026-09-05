---
name: improve
description: Backward-compatible entry point for the previous improvement command. Use when users say "개선" or invoke /sawhorse:improve; route new work to the issue workflow and preserve legacy 개선 notes until the user approves migration.
---

# improve 호환 명령

`improve`는 더 이상 별도 도메인 모델이 아니다. `/sawhorse:issues`의 **코드형 이슈 실행 호환 진입점**이다.

1. 새 요청은 `템플릿/이슈.md`, `사업/<사업명>/이슈/`에 `execution_type: 코드`로 만든다.
2. 설계·사람 승인·실행·검증·경로 한정 커밋·되돌리기는 `sawhorse:issues`의 불변식과 절차를 그대로 따른다.
3. 기존 `사업/<사업명>/개선/`, `type: 개선` 노트는 읽을 수 있지만 자동으로 이동·변환하지 않는다. 이관은 `issues 이관`의 미리보기와 사용자 승인을 거친다.
4. 새 Markdown 표·Base·MOC를 `개선` 이름으로 만들지 않는다.

코드형 이슈의 안전 규칙은 `${CLAUDE_PLUGIN_ROOT}/skills/issues/SKILL.md`의 「코드 실행」이 정본이다.
