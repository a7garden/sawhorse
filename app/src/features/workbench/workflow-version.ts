import type { WorkflowDefinition } from "./types";

/**
 * 게시된 workflow는 불변이고, 한 id의 옛 판은 이미 만들어진 항목을
 * digest로 여는 용도로만 남는다. 새 프로젝트·새 항목이 묶여야 하는 것은
 * id별 최신 판이다. 이 모듈은 카탈로그에서 그 최신 판을 가려 낸다.
 */

/** x.y.z 비교. 백엔드 validation.rs가 3조각을 보장하지만, 방어적으로 숫자화한다. */
export function compareWorkflowVersions(a: string, b: string): number {
  const left = a.split("-")[0].split(".").map((piece) => Number(piece) || 0);
  const right = b.split("-")[0].split(".").map((piece) => Number(piece) || 0);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const delta = (left[index] ?? 0) - (right[index] ?? 0);
    if (delta) return delta;
  }
  return 0;
}

/** workflow id별 최신 버전. 카탈로그(빌트인 + 발행 파일)에서 계산한다. */
export function latestWorkflowVersions(
  catalog: WorkflowDefinition[],
): Map<string, string> {
  const latest = new Map<string, string>();
  for (const definition of catalog) {
    const current = latest.get(definition.id);
    if (!current || compareWorkflowVersions(definition.version, current) > 0)
      latest.set(definition.id, definition.version);
  }
  return latest;
}
