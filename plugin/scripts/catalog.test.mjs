import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validatePlugin } from "../validate.mjs";

const source = fileURLToPath(new URL("../", import.meta.url));
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "sawhorse-catalog-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of [".claude-plugin", "skills", "packs", "scripts"]) cpSync(join(source, path), join(root, path), { recursive: true });
  return root;
}
function change(root, path, mutate) {
  const file = join(root, path);
  const data = JSON.parse(readFileSync(file, "utf8"));
  mutate(data);
  writeFileSync(file, JSON.stringify(data));
}
test("bundled public catalog and seeds are consistent", () => assert.doesNotThrow(() => validatePlugin(source)));
test("built-in extensions are feature units and audit stays native", () => {
  const ids = readdirSync(join(source, "packs"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  assert.deepEqual(ids, ["concepts", "journal", "project-docs", "todos"]);
  for (const id of ids) {
    const pack = JSON.parse(readFileSync(join(source, "packs", id, "pack.json"), "utf8"));
    assert((pack.views ?? []).every((view) => view.component !== "vault"), `${id} must not own native audit`);
  }
});
test("an undeclared skill cannot silently ship", (t) => {
  const root = fixture(t);
  change(root, "packs/journal/pack.json", (pack) => pack.skills.pop());
  assert.throws(() => validatePlugin(root), /undeclared or missing skill/);
});
test("conflicting templates cannot depend on pack installation order", (t) => {
  const root = fixture(t);
  change(root, "packs/concepts/pack.json", (pack) => pack.workspace.files[0].dest = "템플릿/일지.md");
  assert.throws(() => validatePlugin(root), /conflicting workspace seed/);
});
test("an action cannot invoke a retired command", (t) => {
  const root = fixture(t);
  change(root, "packs/journal/pack.json", (pack) => pack.actions[0].prompt = "/{{ns}}:improve");
  assert.throws(() => validatePlugin(root), /calls undeclared skill/);
});
