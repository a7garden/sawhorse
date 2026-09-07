import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const manifestPath = resolve(process.argv[2] ?? "");
const vaultRoot = resolve(process.argv[3] ?? process.cwd());
const safeId = /^[A-Za-z0-9_-]{1,128}$/;

function fail(message) {
  throw new Error(message);
}

function requiredText(value, label) {
  if (typeof value !== "string" || !value.trim()) fail(`${label} 값이 필요합니다.`);
  return value.trim();
}

function stringList(value, label) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    fail(`${label}은 문자열 배열이어야 합니다.`);
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function yaml(value) {
  return JSON.stringify(value);
}

function md(value) {
  return String(value ?? "").replaceAll("|", "\\|").replace(/[\r\n]+/g, " ").trim();
}

function xml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function resolveInput(value) {
  const raw = requiredText(value, "asset 경로");
  return isAbsolute(raw) ? resolve(raw) : resolve(dirname(manifestPath), raw);
}

function externalRuntime(html) {
  const patterns = [
    /<(?:script|img|iframe|link)\b[^>]*(?:src|href)\s*=\s*["']https?:/i,
    /url\(\s*["']?https?:/i,
    /\b(?:fetch|WebSocket|EventSource|XMLHttpRequest)\s*\(/i,
    /\bimport\s*(?:\(|[^;]*?\bfrom\s*)["']https?:/i,
  ];
  return patterns.some((pattern) => pattern.test(html));
}

function browserCandidates() {
  const env = process.env;
  const candidates = [
    "msedge", "microsoft-edge", "google-chrome", "chrome", "chromium", "chromium-browser",
    env.PROGRAMFILES && join(env.PROGRAMFILES, "Microsoft/Edge/Application/msedge.exe"),
    env["PROGRAMFILES(X86)"] && join(env["PROGRAMFILES(X86)"], "Microsoft/Edge/Application/msedge.exe"),
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Microsoft/Edge/Application/msedge.exe"),
    env.PROGRAMFILES && join(env.PROGRAMFILES, "Google/Chrome/Application/chrome.exe"),
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter(Boolean);
  return [...new Set(candidates)];
}

function capture(htmlPath, outputPath) {
  for (const browser of browserCandidates()) {
    if ((browser.includes("/") || browser.includes("\\")) && !existsSync(browser)) continue;
    const result = spawnSync(browser, [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--window-size=1440,1000",
      `--screenshot=${outputPath}`,
      pathToFileURL(htmlPath).href,
    ], { encoding: "utf8", windowsHide: true, timeout: 45_000 });
    if (result.status === 0 && existsSync(outputPath)) return browser;
  }
  return null;
}

function fallbackSvg(screen) {
  const baseline = screen.baseline.slice(0, 5);
  const proposal = screen.proposal.slice(0, 5);
  const lines = Math.max(baseline.length, proposal.length, 1);
  const height = Math.max(720, 260 + lines * 54);
  const column = (x, title, items, color) => {
    const content = (items.length ? items : ["기록된 요약 없음"]).map((item, index) =>
      `<text x="${x + 28}" y="${220 + index * 54}" font-size="20" fill="#cbd5e1">• ${xml(item).slice(0, 62)}</text>`
    ).join("");
    return `<rect x="${x}" y="120" width="620" height="${height - 170}" rx="18" fill="#111827" stroke="#334155"/><text x="${x + 28}" y="172" font-size="24" font-weight="700" fill="${color}">${xml(title)}</text>${content}`;
  };
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="${height}" viewBox="0 0 1440 ${height}"><rect width="1440" height="${height}" fill="#07111f"/><text x="70" y="62" font-family="sans-serif" font-size="30" font-weight="700" fill="#f8fafc">${xml(screen.label)}</text><text x="70" y="94" font-family="sans-serif" font-size="18" fill="#94a3b8">${xml(screen.context)}</text><g font-family="sans-serif">${column(70, "A · 현행", baseline, "#94a3b8")}${column(750, "B · 개선안", proposal, "#38bdf8")}</g></svg>`;
}

if (!process.argv[2]) fail("사용법: register-mockup.mjs <manifest.json> [vault-root]");
const input = JSON.parse(await readFile(manifestPath, "utf8"));
const id = requiredText(input.id, "id");
const title = requiredText(input.title, "title");
const projectId = requiredText(input.projectId, "projectId");
if (!safeId.test(id) || !safeId.test(projectId)) fail("id와 projectId 형식이 안전하지 않습니다.");
if (!["explicit", "all"].includes(input.selectionMode)) fail("selectionMode는 explicit 또는 all이어야 합니다.");
if (!Array.isArray(input.issues) || input.issues.length === 0) fail("issues가 비어 있습니다.");
if (!Array.isArray(input.screens) || input.screens.length === 0) fail("screens가 비어 있습니다.");
if (!existsSync(join(vaultRoot, "projects", projectId, "project.md"))) fail(`등록된 프로젝트가 없습니다: ${projectId}`);

const parentMockupId = input.parentMockupId == null || input.parentMockupId === ""
  ? ""
  : requiredText(input.parentMockupId, "parentMockupId");
if (parentMockupId && (!safeId.test(parentMockupId) || parentMockupId === id)) {
  fail("parentMockupId 형식이 안전하지 않거나 자기 자신을 가리킵니다.");
}
let parentRevision = 0;
if (parentMockupId) {
  const parentManifestPath = join(vaultRoot, "work", parentMockupId, "mockup-manifest.json");
  if (!existsSync(parentManifestPath)) fail(`부모 목업을 찾을 수 없습니다: ${parentMockupId}`);
  const parent = JSON.parse(await readFile(parentManifestPath, "utf8"));
  if (parent.projectId !== projectId) fail("부모 목업과 프로젝트가 다릅니다.");
  parentRevision = Number.isInteger(parent.revision) && parent.revision > 0 ? parent.revision : 1;
}
const revision = input.revision == null ? parentRevision + 1 : Number(input.revision);
if (!Number.isInteger(revision) || revision < 1 || (parentMockupId && revision <= parentRevision)) {
  fail("revision은 1 이상의 정수이며 부모 목업 revision보다 커야 합니다.");
}

const issueIds = new Set();
const issues = input.issues.map((issue, index) => {
  const issueId = requiredText(issue.id, `issues[${index}].id`);
  if (!safeId.test(issueId) || issueIds.has(issueId)) fail(`중복되거나 안전하지 않은 이슈 ID: ${issueId}`);
  if (!existsSync(join(vaultRoot, "work", issueId, "work.md"))) fail(`선택 이슈를 찾을 수 없습니다: ${issueId}`);
  issueIds.add(issueId);
  return {
    id: issueId,
    title: requiredText(issue.title, `issues[${index}].title`),
    screenId: requiredText(issue.screenId, `issues[${index}].screenId`),
  };
});

const screenIds = new Set();
const screens = input.screens.map((screen, index) => {
  const screenId = requiredText(screen.id, `screens[${index}].id`);
  if (!safeId.test(screenId) || screenIds.has(screenId)) fail(`중복되거나 안전하지 않은 화면 ID: ${screenId}`);
  screenIds.add(screenId);
  const assignment = screen.assignment ?? "inferred";
  if (!["explicit", "inferred"].includes(assignment)) fail(`화면 assignment가 잘못되었습니다: ${screenId}`);
  return {
    id: screenId,
    label: requiredText(screen.label, `screens[${index}].label`),
    context: requiredText(screen.context, `screens[${index}].context`),
    assignment,
    baseline: stringList(screen.baseline, `screens[${index}].baseline`),
    evidence: stringList(screen.evidence, `screens[${index}].evidence`),
    proposal: stringList(screen.proposal, `screens[${index}].proposal`),
    acceptance: stringList(screen.acceptance, `screens[${index}].acceptance`),
    htmlSource: resolveInput(screen.html),
    previewSource: screen.preview ? resolveInput(screen.preview) : null,
  };
});
for (const issue of issues) if (!screenIds.has(issue.screenId)) fail(`이슈 ${issue.id}의 screenId가 없습니다: ${issue.screenId}`);
for (const screen of screens) if (!issues.some((issue) => issue.screenId === screen.id)) fail(`선택 이슈가 배정되지 않은 화면입니다: ${screen.id}`);

for (const screen of screens) {
  if (extname(screen.htmlSource).toLowerCase() !== ".html") fail(`HTML 파일이 아닙니다: ${screen.htmlSource}`);
  const html = await readFile(screen.htmlSource, "utf8");
  if (externalRuntime(html)) fail(`외부 런타임 자원이 포함된 HTML입니다: ${screen.htmlSource}`);
  if (screen.previewSource) {
    const extension = extname(screen.previewSource).toLowerCase();
    if (![".png", ".jpg", ".jpeg", ".webp", ".svg"].includes(extension)) fail(`지원하지 않는 preview 형식입니다: ${extension}`);
  }
}

const workRoot = join(vaultRoot, "work", id);
if (existsSync(workRoot)) fail(`기존 산출물을 덮어쓸 수 없습니다: ${workRoot}`);
const assetRoot = join(workRoot, "assets");
await mkdir(assetRoot, { recursive: true });
const renderers = [];
for (const screen of screens) {
  const htmlTarget = join(assetRoot, `${screen.id}.html`);
  await copyFile(screen.htmlSource, htmlTarget);
  if (screen.previewSource) {
    const extension = extname(screen.previewSource).toLowerCase();
    screen.previewName = `${screen.id}${extension}`;
    await copyFile(screen.previewSource, join(assetRoot, screen.previewName));
    renderers.push(`${screen.id}: supplied`);
  } else {
    screen.previewName = `${screen.id}.png`;
    const browser = capture(htmlTarget, join(assetRoot, screen.previewName));
    if (browser) {
      renderers.push(`${screen.id}: ${basename(browser)}`);
    } else {
      screen.previewName = `${screen.id}.svg`;
      await writeFile(join(assetRoot, screen.previewName), fallbackSvg(screen), "utf8");
      renderers.push(`${screen.id}: fallback-svg`);
    }
  }
}

const createdAt = new Date(input.createdAt ?? Date.now()).toISOString();
const frontmatter = (fields) => `---\n${Object.entries(fields).map(([key, value]) => `${key}: ${yaml(value)}`).join("\n")}\n---\n\n`;
const issueTable = issues.map((issue) => `| ${md(issue.id)} | ${md(issue.title)} | ${md(screens.find((screen) => screen.id === issue.screenId)?.label)} |`).join("\n");
const work = frontmatter({
  id, title, projectId, stage: "review", status: "review", priority: "normal", owner: "",
  startDate: null, dueDate: null, dependsOn: [], tags: ["mockup"], createdAt, updatedAt: createdAt,
  decisions: [], artifacts: ["intent", "baseline", "proposal", "mockup", "feedback", "verification"], workflowId: "mockup-review",
  workflowVersion: "1.1.0", workflowDigest: "", workflowInstanceId: null, activeNodes: [], issueType: "작업",
  executionType: "문서", labels: ["mockup", "ui"], assignees: [], milestone: "", approvalRequired: false,
  approve: false, approved: "", state: "open", closed: "", githubRepo: "", githubNumber: "", githubUrl: "",
  githubState: "", githubUpdated: "",
}) + `# ${title}\n\n${issues.length}개 이슈를 ${screens.length}개 화면 맥락으로 나눈 개선 목업 검토 항목입니다.\n\n- 목업 revision: ${revision}\n${parentMockupId ? `- 이전 목업: [${md(parentMockupId)}](../${md(parentMockupId)}/mockup.md)\n` : ""}`;
const intent = `# 대상 이슈\n\n- 프로젝트: ${md(projectId)}\n- 선택 방식: ${md(input.selectionMode)}\n- 이슈 수: ${issues.length}\n- 화면 수: ${screens.length}\n- 목업 revision: ${revision}\n${parentMockupId ? `- 이전 목업: [${md(parentMockupId)}](../${md(parentMockupId)}/mockup.md)\n` : ""}\n| ID | 기능 제안 | 주 화면 |\n|---|---|---|\n${issueTable}\n`;
const baseline = `# 현행 분석\n\n${screens.map((screen) => `## ${md(screen.label)}\n\n- 화면 맥락: ${md(screen.context)}\n- 배정 근거: ${screen.assignment === "explicit" ? "명시" : "추론"}\n${screen.baseline.map((item) => `- ${md(item)}`).join("\n") || "- 확인한 현행 요약 없음"}\n\n### 근거\n\n${screen.evidence.map((item) => `- ${md(item)}`).join("\n") || "- 미확인"}`).join("\n\n")}\n`;
const proposal = `# 개선 제안\n\n거친 백로그 표현은 원문을 ${issues.length}개 대상 이슈로 보존하고, 아래처럼 화면별 검토 가능한 제안으로 구체화했습니다.\n\n${screens.map((screen) => `## ${md(screen.label)}\n\n- 화면 맥락: ${md(screen.context)}\n- 대상 이슈: ${issues.filter((issue) => issue.screenId === screen.id).map((issue) => issue.id).join(", ")}\n\n### 확인된 문제\n\n${screen.baseline.map((item) => `- ${md(item)}`).join("\n") || "- 현행 확인 필요"}\n\n### 제안\n\n${screen.proposal.map((item) => `- ${md(item)}`).join("\n") || "- 제안 구체화 필요"}\n\n### 수용 기준\n\n${screen.acceptance.map((item) => `- [ ] ${md(item)}`).join("\n") || "- [ ] 사용자 검토 필요"}`).join("\n\n")}\n`;
const mockupFields = { type: "mockup", id, workId: id, title, projectId, revision, parentMockupId, screenCount: screens.length, sourceIssueIds: issues.map((issue) => issue.id), screenContexts: screens.map((screen) => screen.context), createdAt };
const mockup = frontmatter(mockupFields) + `# ${title}\n\n- revision: ${revision}\n${parentMockupId ? `- 이전 목업: [${md(parentMockupId)}](../${md(parentMockupId)}/mockup.md)\n` : ""}\n${screens.map((screen) => `## ${md(screen.label)}\n\n- 맥락: ${md(screen.context)}\n- 반영 이슈: ${issues.filter((issue) => issue.screenId === screen.id).map((issue) => issue.id).join(", ")}\n\n![${md(screen.label)} 미리보기](<assets/${screen.previewName}>)\n\n[대화형 HTML 열기](<assets/${screen.id}.html>)\n\n### 개선안\n\n${screen.proposal.map((item) => `- ${md(item)}`).join("\n") || "- 기록 없음"}`).join("\n\n")}\n`;
const feedback = frontmatter({ type: "mockup-feedback", mockupId: id, projectId, revision, parentMockupId, sourceIssueIds: issues.map((issue) => issue.id) }) + `# 검토 의견\n\n<!-- 목업을 보면서 아래 두 절에 체크되지 않은 항목을 추가하세요. 대괄호에는 ${screens.map((screen) => screen.id).join(", ")} 중 해당 화면 ID를 적습니다. -->\n\n## 목업 수정 요청\n\n<!-- - [ ] [화면-ID] 이 목업에서 바꿀 내용 -->\n\n## 새 개선 제안\n\n<!-- - [ ] [화면-ID] 목업을 검토하다 새로 발견한 문제 또는 제안 -->\n\n## 처리 이력\n\n<!-- 아직 처리한 의견이 없습니다. -->\n`;
const verification = `# 검증\n\n## 이슈 포함 범위\n\n${issues.map((issue) => `- [x] ${md(issue.id)} — ${md(issue.title)} → ${md(issue.screenId)}`).join("\n")}\n\n## 화면별 수용 기준\n\n${screens.map((screen) => `### ${md(screen.label)}\n\n${screen.acceptance.map((item) => `- [ ] ${md(item)}`).join("\n") || "- [ ] 사용자 검토 필요"}`).join("\n\n")}\n\n## 개정 연결\n\n- revision: ${revision}\n- 이전 목업: ${parentMockupId || "없음"}\n\n## 렌더링\n\n${renderers.map((item) => `- ${md(item)}`).join("\n")}\n`;

await writeFile(join(workRoot, "work.md"), work, "utf8");
await writeFile(join(workRoot, "intent.md"), intent, "utf8");
await writeFile(join(workRoot, "baseline.md"), baseline, "utf8");
await writeFile(join(workRoot, "proposal.md"), proposal, "utf8");
await writeFile(join(workRoot, "mockup.md"), mockup, "utf8");
await writeFile(join(workRoot, "feedback.md"), feedback, "utf8");
await writeFile(join(workRoot, "verification.md"), verification, "utf8");
await writeFile(join(workRoot, "mockup-manifest.json"), `${JSON.stringify({ ...input, revision, parentMockupId }, null, 2)}\n`, "utf8");

for (const file of ["work.md", "intent.md", "baseline.md", "proposal.md", "mockup.md", "feedback.md", "verification.md", "mockup-manifest.json"]) {
  if (!existsSync(join(workRoot, file))) fail(`등록 후 파일 검증 실패: ${file}`);
}
console.log(JSON.stringify({ workId: id, workRoot, issues: issues.length, screens: screens.map((screen) => screen.id), renderers }, null, 2));
