import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const root = await mkdtemp(join(tmpdir(), "sawhorse-feedback-test-"));
try {
  await mkdir(join(root, "projects", "demo"), { recursive: true });
  await mkdir(join(root, "work", "mockup-demo"), { recursive: true });
  await writeFile(join(root, "projects", "demo", "project.md"), "---\nid: demo\n---\n", "utf8");
  await writeFile(join(root, "work", "mockup-demo", "mockup-manifest.json"), JSON.stringify({
    id: "mockup-demo",
    projectId: "demo",
    revision: 1,
    screens: [{ id: "settings" }],
  }), "utf8");
  await writeFile(join(root, "work", "mockup-demo", "feedback.md"), `# 검토 의견

## 목업 수정 요청

- [ ] [settings] 저장 버튼을 고정한다

## 새 개선 제안

- [ ] [settings] 키보드 초점을 표시한다

## 처리 이력
`, "utf8");
  const script = join(dirname(fileURLToPath(import.meta.url)), "process-feedback.mjs");
  const env = { ...process.env, SAWHORSE_FEEDBACK_NOW: "2026-09-07T12:34:56.000Z" };
  const result = spawnSync(process.execPath, [script, "mockup-demo", root], { encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.created.length, 2);
  assert.equal(output.revisionRequests.length, 1);
  assert.equal(output.newProposals.length, 1);
  for (const item of output.created) {
    const work = await readFile(join(root, "work", item.id, "work.md"), "utf8");
    const intent = await readFile(join(root, "work", item.id, "intent.md"), "utf8");
    assert.match(work, /status: "backlog"/);
    assert.match(work, /workflowId: "issue-main"/);
    assert.match(intent, /mockup-demo/);
  }
  const feedback = await readFile(join(root, "work", "mockup-demo", "feedback.md"), "utf8");
  assert.doesNotMatch(feedback, /- \[ \]/);
  assert.match(feedback, /승격/);
  const duplicate = spawnSync(process.execPath, [script, "mockup-demo", root], { encoding: "utf8", env });
  assert.equal(duplicate.status, 0, duplicate.stderr);
  assert.equal(JSON.parse(duplicate.stdout).created.length, 0);
  console.log("ok process-feedback");
} finally {
  await rm(root, { recursive: true, force: true });
}
