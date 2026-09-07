export type FeedbackKind = "revision" | "proposal";
export const feedbackSections: Record<FeedbackKind, string> = {
  revision: "목업 수정 요청",
  proposal: "새 개선 제안",
};
export interface MockupFeedback {
  kind: FeedbackKind;
  screenId: string;
  text: string;
  processed: boolean;
}

// Ignore examples in HTML comments and fenced code, keeping line offsets intact.
function visibleLines(markdown: string) {
  let fence = "";
  return markdown
    .replace(/<!--[\s\S]*?(?:-->|$)/g, (comment) =>
      comment.replace(/[^\r\n]/g, " "),
    )
    .split(/\r?\n/)
    .map((line) => {
      const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (
        marker &&
        (!fence || (marker[0] === fence[0] && marker.length >= fence.length))
      ) {
        fence = fence ? "" : marker;
        return "";
      }
      return fence ? "" : line;
    });
}

export function readFeedback(markdown: string): MockupFeedback[] {
  let kind: FeedbackKind | undefined;
  const items: MockupFeedback[] = [];
  for (const line of visibleLines(markdown)) {
    const heading = /^#{1,2}\s+(.+?)\s*$/.exec(line);
    if (heading) {
      kind = (Object.keys(feedbackSections) as FeedbackKind[]).find(
        (key) => feedbackSections[key] === heading[1],
      );
      continue;
    }
    const item = /^- \[([ xX])\]\s+\[([A-Za-z0-9_-]{1,128})\]\s+(.+?)\s*$/.exec(
      line,
    );
    if (kind && item)
      items.push({
        kind,
        screenId: item[2],
        text: item[3],
        processed: item[1] !== " ",
      });
  }
  return items;
}

export function normalizeFeedback(text: string) {
  return text.replace(/[\r\n\u2028\u2029]+/g, " ").trim();
}

/** Preserve the existing document, including frontmatter and processing history. */
export function appendFeedback(
  markdown: string,
  kind: FeedbackKind,
  screenId: string,
  text: string,
): string {
  const normalized = normalizeFeedback(text);
  if (
    !/^[A-Za-z0-9_-]{1,128}$/.test(screenId) ||
    !normalized ||
    normalized.length > 4000
  ) {
    throw new Error("invalid-feedback");
  }
  if (
    readFeedback(markdown).some(
      (item) =>
        !item.processed &&
        item.kind === kind &&
        item.screenId === screenId &&
        item.text === normalized,
    )
  ) {
    throw new Error("duplicate-feedback");
  }
  const eol = markdown.includes("\r\n") ? "\r\n" : "\n";
  const lines = markdown.split(/\r?\n/);
  const visible = visibleLines(markdown);
  const start = visible.findIndex(
    (line) => line.trim() === `## ${feedbackSections[kind]}`,
  );
  const bullet = `- [ ] [${screenId}] ${normalized}`;
  if (start < 0)
    return `${markdown}${markdown.endsWith(eol) ? "" : eol}${eol}## ${feedbackSections[kind]}${eol}${eol}${bullet}${eol}`;
  const next = visible.findIndex(
    (line, index) => index > start && /^#{1,2}\s/.test(line),
  );
  lines.splice(next < 0 ? lines.length : next, 0, bullet, "");
  return lines.join(eol);
}
