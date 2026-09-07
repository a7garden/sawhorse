---
name: vault-tidy
description: Inspect and tidy SI journal and knowledge documents, root attachments, and document links. Use for explicit vault cleanup or as the document-maintenance step of a Sawhorse routine.
---

# 문서 정리

일지·개념·프로젝트 지식 문서를 정리한다. 앱의 작업 데이터나 확장 산출물까지 SI 템플릿으로 정규화하지 않는다.

## 범위

- 문서: `일지/`, `기록/`, `문서/`, `노트/`, `개념/`, `프로젝트/`, `사업/`의 지식 문서. 기존 이름을 읽되 폴더 이름만 보고 일괄 이동하지 않는다.
- 보존: `.sawhorse/` 등 숨김 디렉터리, `work/`, `projects/`, `calendar/`, `runs/`, 확장 출력 폴더, `typeId`가 있는 사용자 스키마 문서, 심볼릭 링크, 과거 `이슈/·개선/·마일스톤/` 기록. 이들의 이동·필드 변경은 앱의 전용 작업·스키마·이관 경로를 사용한다.
- 스키마: 일반 지식 문서는 볼트에 있는 해당 템플릿을 참고한다. 사용자 필드를 삭제하지 않는다. 코어 `.sawhorse/schema.json`과 사용자 문서 스키마 `.sawhorse/schemas/`는 SI 템플릿으로 대체하지 않는다.

## 점검

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/vault-hygiene.mjs --vault "<vaultPath>" --mode scan
```

경로는 실행 문맥 또는 사용자 홈의 `.claude/sawhorse/config.json`의 `vaultPath`에서 읽는다.

| 모드 | 처리 |
|---|---|
| `scan` | 읽기 전용 링크·첨부·문서 템플릿 진단 |
| `quick` | 루트 첨부 회수, 사용 중인 Obsidian 첨부 설정, 번들 문서 인덱스 점검, 일반 문서 중복 제목 정리 |
| `fix` | quick 처리 후 상세 진단 |

루틴에서 지정한 모드나 사용자가 요청한 정리 범위를 따른다. 스크립트는 고아 첨부 삭제, 문서 분류·병합, 레거시 이관을 수행하지 않는다. 하위 폴더의 첨부는 그 문서나 확장의 산출물일 수 있으므로 자동 회수하지 않는다.

## 판단이 필요한 정리

진단 목록에서 실제로 해결할 항목의 문맥을 읽는다. 명확한 누락과 링크 수정은 요청 범위에서 처리하고, 병합·이동 후보는 대상 경로와 링크 영향을 구체적으로 정리한다. 이동할 때는 파일 충돌과 상대 링크를 확인하고 원문·근거를 보존한다. 과거 Base나 레거시 폴더가 없다는 이유로 다시 만들지 않는다.

일지의 개념 수집 항목은 `/sawhorse:wiki`의 지식 문서 규칙으로 정리한다. 새 작업 요청은 후보로 남겨 앱의 공통 작업으로 연결한다. 문서 정리를 위해 Git 저장소를 새로 만들거나 전체 볼트를 자동 커밋하지 않는다.

마지막에는 변경한 경로, 점검 결과, 남겨 둔 후보와 이유를 보고한다.
