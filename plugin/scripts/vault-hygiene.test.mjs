import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync, lstatSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const script = fileURLToPath(new URL("./vault-hygiene.mjs", import.meta.url));
const write = (root, path, text) => {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
};
function snapshot(root, dir = root, output = {}) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) snapshot(root, path, output);
    else output[path.slice(root.length)] = readFileSync(path).toString("base64");
  }
  return output;
}
function run(vault, mode) {
  const result = spawnSync(process.execPath, [script, "--vault", vault, "--mode", mode], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}
for (const mode of ["scan", "quick", "fix"]) {
  test(`${mode} preserves host, schema, legacy, extension, and linked data`, (t) => {
    const root = mkdtempSync(join(tmpdir(), "sawhorse-hygiene-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const vault = join(root, "vault");
    mkdirSync(vault);
    const protectedFiles = {
      "work/w-1/intent.md": "# intent\n\nEvidence ![screen](assets/screen.png)\n",
      "work/w-1/assets/screen.png": "screen",
      "projects/p-1/project.md": "# project\n",
      "calendar/event.md": "# event\n",
      "runs/run.md": "# run\n",
      ".sawhorse/evidence/result.png": "evidence",
      ".git/objects/retained.md": "# retained\n",
      "exports/report.xlsx": "xlsx",
      "custom/mockup.png": "mockup",
      "개념/typed.md": "---\ntypeId: team.document\nid: typed\n---\n\n# typed\n",
      "프로젝트/P/이슈/old.md": "---\ntype: 이슈\n---\n# old\n",
      "사업/P/개선/old.md": "---\ntype: 개선\n---\n# old\n",
      "프로젝트/P/마일스톤/m.md": "# m\n",
      "custom/view.base": 'filters:\n  and:\n    - type == "문서"\n',
    };
    for (const [path, text] of Object.entries(protectedFiles)) write(vault, path, text);
    write(vault, "일지/today.md", "---\ntype: 일지\n---\n\n# today\n\nKeep this body.\n");
    write(vault, "loose.png", "root screenshot");
    write(root, "external/outside.md", "# outside\n");
    symlinkSync(join(root, "external"), join(vault, "일지", "linked"), process.platform === "win32" ? "junction" : "dir");
    symlinkSync(vault, join(vault, "cycle"), process.platform === "win32" ? "junction" : "dir");
    const before = snapshot(root);
    const output = run(vault, mode);
    for (const [path, text] of Object.entries(protectedFiles)) assert.equal(readFileSync(join(vault, path), "utf8"), text, path);
    assert.equal(readFileSync(join(root, "external/outside.md"), "utf8"), "# outside\n");
    assert.equal(existsSync(join(vault, ".obsidian")), false);
    assert.doesNotMatch(output, /typed\.md : type 없음|work\/w-1\/intent\.md : frontmatter 없음|이슈base/);
    if (mode === "scan") {
      assert.deepEqual(snapshot(root), before);
    } else {
      assert.equal(existsSync(join(vault, "loose.png")), false);
      assert.equal(readFileSync(join(vault, "첨부/스크린샷/loose.png"), "utf8"), "root screenshot");
      assert.doesNotMatch(readFileSync(join(vault, "일지/today.md"), "utf8"), /# today/);
      const after = snapshot(root);
      run(vault, mode);
      assert.deepEqual(snapshot(root), after, "repeat cleanup is idempotent");
    }
  });
}
