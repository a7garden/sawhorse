import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const root = await mkdtemp(join(tmpdir(), "sawhorse-mockup-test-"));
try {
  await mkdir(join(root, "projects", "demo"), { recursive: true });
  await mkdir(join(root, "work", "DEMO-1"), { recursive: true });
  await mkdir(join(root, "source"), { recursive: true });
  await writeFile(join(root, "projects", "demo", "project.md"), "---\nid: demo\n---\n", "utf8");
  await writeFile(join(root, "work", "DEMO-1", "work.md"), "---\nid: DEMO-1\nprojectId: demo\n---\n", "utf8");
  await writeFile(join(root, "source", "screen.html"), "<!doctype html><title>demo</title><button>저장</button>", "utf8");
  await writeFile(join(root, "source", "screen.svg"), "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"20\" height=\"20\"/>", "utf8");
  const manifest = {
    id: "mockup-demo",
    title: "데모 목업",
    projectId: "demo",
    selectionMode: "all",
    parentMockupId: "",
    issues: [{ id: "DEMO-1", title: "저장 피드백", screenId: "settings" }],
    screens: [{
      id: "settings",
      label: "설정",
      context: "설정 > 일반",
      assignment: "explicit",
      baseline: ["저장 결과가 보이지 않는다."],
      evidence: ["현재 화면 확인"],
      proposal: ["저장 토스트를 표시한다."],
      acceptance: ["저장 후 성공 상태가 보인다."],
      html: "source/screen.html",
      preview: "source/screen.svg"
    }]
  };
  const manifestPath = join(root, "manifest.json");
  await writeFile(manifestPath, JSON.stringify(manifest), "utf8");
  const script = join(dirname(fileURLToPath(import.meta.url)), "register-mockup.mjs");
  const result = spawnSync(process.execPath, [script, manifestPath, root], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const work = await readFile(join(root, "work", "mockup-demo", "work.md"), "utf8");
  const mockup = await readFile(join(root, "work", "mockup-demo", "mockup.md"), "utf8");
  const proposal = await readFile(join(root, "work", "mockup-demo", "proposal.md"), "utf8");
  const feedback = await readFile(join(root, "work", "mockup-demo", "feedback.md"), "utf8");
  assert.match(work, /workflowId: "mockup-review"/);
  assert.match(work, /workflowVersion: "1.1.0"/);
  assert.match(mockup, /sourceIssueIds: \["DEMO-1"\]/);
  assert.match(mockup, /revision: 1/);
  assert.match(mockup, /assets\/settings\.svg/);
  assert.match(proposal, /저장 토스트를 표시한다/);
  assert.match(feedback, /새 개선 제안/);
  const revisionManifest = { ...manifest, id: "mockup-demo-v2", revision: 2, parentMockupId: "mockup-demo" };
  const revisionPath = join(root, "manifest-v2.json");
  await writeFile(revisionPath, JSON.stringify(revisionManifest), "utf8");
  const revision = spawnSync(process.execPath, [script, revisionPath, root], { encoding: "utf8" });
  assert.equal(revision.status, 0, revision.stderr);
  const revisionMockup = await readFile(join(root, "work", "mockup-demo-v2", "mockup.md"), "utf8");
  assert.match(revisionMockup, /parentMockupId: "mockup-demo"/);
  assert.match(revisionMockup, /revision: 2/);
  const duplicate = spawnSync(process.execPath, [script, manifestPath, root], { encoding: "utf8" });
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /덮어쓸 수 없습니다/);
  console.log("ok register-mockup");
} finally {
  await rm(root, { recursive: true, force: true });
}
