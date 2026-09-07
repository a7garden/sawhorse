import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const safeId = /^[A-Za-z0-9_-]{1,128}$/;
const sectionNames = new Map([
  ["목업 수정 요청", "mockup-revision"],
  ["새 개선 제안", "mockup-feedback"],
]);

function fail(message) {
  throw new Error(message);
}

function yaml(value) {
  return JSON.stringify(value);
}

function md(value) {
  return String(value ?? "").replaceAll("|", "\\|").replace(/[\r\n]+/g, " ").trim();
}

function slug(value) {
  return value
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36) || "project";
}

function collect(markdown) {
  const lines = markdown.split(/\r?\n/);
  const items = [];
  let section = "";
  for (let index = 0; index < lines.length; index += 1) {
    const heading = /^##\s+(.+?)\s*$/.exec(lines[index]);
    if (heading) {
      section = sectionNames.has(heading[1]) ? heading[1] : "";
      continue;
    }
    if (!section) continue;
    const item = /^- \[ \]\s+\[([^\]]+)\]\s+(.+?)\s*$/.exec(lines[index]);
    if (!item) continue;
    items.push({ line: index, section, kind: sectionNames.get(section), screenId: item[1].trim(), text: item[2].trim() });
  }
  return { lines, items };
}

function frontmatter(fields) {
  return `---\n${Object.entries(fields).map(([key, value]) => `${key}: ${yaml(value)}`).join("\n")}\n---\n\n`;
}

async function nextId(vaultRoot, projectId, stamp, index) {
  const base = `${slug(projectId)}-feedback-${stamp}-${String(index + 1).padStart(2, "0")}`;
  let candidate = base;
  let suffix = 2;
  while (existsSync(join(vaultRoot, "work", candidate))) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

const mockupId = process.argv[2];
if (!mockupId) fail("사용법: process-feedback.mjs <mockup-id> [vault-root]");
if (!safeId.test(mockupId)) fail("mockup-id 형식이 안전하지 않습니다.");
const vaultRoot = resolve(process.argv[3] ?? process.cwd());
const mockupRoot = join(vaultRoot, "work", mockupId);
const manifestPath = join(mockupRoot, "mockup-manifest.json");
const feedbackPath = join(mockupRoot, "feedback.md");
if (!existsSync(manifestPath) || !existsSync(feedbackPath)) fail(`목업 피드백 산출물을 찾을 수 없습니다: ${mockupId}`);

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const projectId = String(manifest.projectId ?? "").trim();
if (!safeId.test(projectId)) fail("목업의 projectId 형식이 안전하지 않습니다.");
const screens = new Set((manifest.screens ?? []).map((screen) => screen.id));
const feedback = await readFile(feedbackPath, "utf8");
const parsed = collect(feedback);
if (parsed.items.length === 0) {
  console.log(JSON.stringify({ mockupId, created: [], revisionRequests: [], message: "처리할 체크되지 않은 의견이 없습니다." }, null, 2));
  process.exit(0);
}
for (const item of parsed.items) {
  if (!safeId.test(item.screenId) || !screens.has(item.screenId)) fail(`알 수 없는 화면 ID입니다: ${item.screenId}`);
  if (!item.text) fail(`비어 있는 피드백입니다: ${item.screenId}`);
}
const unique = new Set();
for (const item of parsed.items) {
  const key = `${item.kind}\u0000${item.screenId}\u0000${item.text}`;
  if (unique.has(key)) fail(`중복 피드백입니다: ${item.text}`);
  unique.add(key);
}

const createdAt = new Date(process.env.SAWHORSE_FEEDBACK_NOW ?? Date.now()).toISOString();
const stamp = createdAt.replace(/[-:TZ.]/g, "").slice(0, 14);
const created = [];
for (let index = 0; index < parsed.items.length; index += 1) {
  const item = parsed.items[index];
  const id = await nextId(vaultRoot, projectId, stamp, index);
  const title = item.text.length > 80 ? `${item.text.slice(0, 77)}...` : item.text;
  const workRoot = join(vaultRoot, "work", id);
  await mkdir(workRoot, { recursive: false });
  const work = frontmatter({
    id, projectId, stage: "request", status: "backlog", priority: "normal", owner: "",
    startDate: null, dueDate: null, dependsOn: [], tags: [item.kind, `screen:${item.screenId}`], createdAt, updatedAt: createdAt,
    decisions: [], artifacts: ["intent", "spec", "verification"], workflowId: "issue-main", workflowVersion: "1.1.0",
    workflowDigest: "", workflowInstanceId: null, activeNodes: [], issueType: "기능", executionType: "코드",
    labels: ["mockup-feedback", item.kind], assignees: [], milestone: "", approvalRequired: true, approve: false,
    approved: "", state: "open", closed: "", githubRepo: "", githubNumber: "", githubUrl: "", githubState: "", githubUpdated: "",
  }) + `# ${md(title)}\n\n목업 ${md(mockupId)}의 ${md(item.screenId)} 화면 검토에서 나온 백로그 후보입니다.\n`;
  const intent = `# 요청\n\n## 배경\n\n- 원본 목업: [${md(mockupId)}](../${md(mockupId)}/mockup.md)\n- 화면: ${md(item.screenId)}\n- 피드백 종류: ${item.kind === "mockup-revision" ? "목업 수정 요청" : "새 개선 제안"}\n\n${md(item.text)}\n\n## 원하는 결과\n\n현행 근거와 영향 범위를 확인해 실행 가능한 제안으로 구체화한다.\n\n## 근거 및 분석\n\n목업 검토에서 수집됨. 아직 코드·실행 화면 근거를 확인하지 않음.\n`;
  const spec = "# 설계\n\n### 방안 비교\n\n| 안 | 내용 | 장점 | 단점 | 영향 범위 |\n|---|---|---|---|---|\n\n### 선택\n\n### 변경 대상\n\n| 파일 | 변경 내용 |\n|---|---|\n\n### 목업\n\n### 검증 방법\n\n| 시나리오 | 기대 |\n|---|---|\n\n### 되돌리기 영향\n\n### 검토 의견\n\n### 개정 이력\n";
  const verification = "# 결과\n\n### 적용 내역\n\n### 증거 및 되돌리기\n\n### 남은 것\n";
  await writeFile(join(workRoot, "work.md"), work, "utf8");
  await writeFile(join(workRoot, "intent.md"), intent, "utf8");
  await writeFile(join(workRoot, "spec.md"), spec, "utf8");
  await writeFile(join(workRoot, "verification.md"), verification, "utf8");
  parsed.lines[item.line] = parsed.lines[item.line].replace("- [ ]", `- [x]`).concat(` → ${id}`);
  created.push({ id, kind: item.kind, screenId: item.screenId, text: item.text });
}

const historyIndex = parsed.lines.findIndex((line) => /^##\s+처리 이력\s*$/.test(line));
const history = `- ${createdAt} · ${created.map((item) => item.id).join(", ")} 승격`;
const placeholderIndex = parsed.lines.findIndex((line) => line.trim() === "아직 처리한 의견이 없습니다.");
if (placeholderIndex >= 0) parsed.lines.splice(placeholderIndex, 1);
if (historyIndex >= 0) parsed.lines.splice(historyIndex + 1, 0, "", history);
else parsed.lines.push("", "## 처리 이력", "", history);
const temporary = `${feedbackPath}.tmp-${process.pid}`;
await writeFile(temporary, `${parsed.lines.join("\n").replace(/\n*$/, "")}\n`, "utf8");
await rename(temporary, feedbackPath);

console.log(JSON.stringify({
  mockupId,
  created,
  revisionRequests: created.filter((item) => item.kind === "mockup-revision").map((item) => item.id),
  newProposals: created.filter((item) => item.kind === "mockup-feedback").map((item) => item.id),
}, null, 2));
