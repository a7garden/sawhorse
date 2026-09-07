import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { dirname, resolve, relative, isAbsolute, sep, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const json = (path) => JSON.parse(readFileSync(path, "utf8"));
function inside(root, path) {
  const absolute = resolve(root, path);
  const rel = relative(root, absolute);
  assert(rel && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), `path escapes root: ${path}`);
  return absolute;
}
function skillName(path) {
  const text = readFileSync(join(path, "SKILL.md"), "utf8");
  const header = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert(header, `missing frontmatter: ${path}`);
  const name = header[1].match(/^name:\s*([a-z0-9-]+)\s*$/m)?.[1];
  assert(name && /^description:\s*\S/m.test(header[1]), `missing skill metadata: ${path}`);
  return name;
}
export function validatePlugin(root) {
  root = resolve(root);
  const plugin = json(join(root, ".claude-plugin/plugin.json"));
  const catalog = new Set();
  const declaredDirs = new Set(plugin.skills.map((path) => inside(root, path)));
  for (const dir of declaredDirs) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const name = skillName(join(dir, entry.name));
      assert.equal(name, entry.name, `skill folder/name mismatch: ${dir}/${entry.name}`);
      assert(!catalog.has(name), `duplicate skill: ${name}`);
      catalog.add(name);
    }
  }
  const seeds = new Map();
  for (const entry of readdirSync(join(root, "packs"), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const packRoot = join(root, "packs", entry.name);
    const pack = json(join(packRoot, "pack.json"));
    assert.equal(pack.id, entry.name, "pack directory/id mismatch");
    const dir = join(packRoot, "skills");
    assert(declaredDirs.has(dir), `pack missing from plugin catalog: ${pack.id}`);
    const actual = readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
    assert.deepEqual([...pack.skills].sort(), actual, `undeclared or missing skill in ${pack.id}`);
    for (const seed of pack.workspace?.files ?? []) {
      const source = inside(packRoot, seed.src);
      assert(statSync(source).isFile(), `missing seed: ${source}`);
      inside(root, seed.dest);
      const content = readFileSync(source);
      if (seeds.has(seed.dest)) assert(content.equals(seeds.get(seed.dest)), `conflicting workspace seed: ${seed.dest}`);
      seeds.set(seed.dest, content);
    }
    for (const action of pack.actions ?? []) {
      for (const match of action.prompt.matchAll(/\/\{\{ns\}\}:([a-z0-9-]+)/g)) {
        assert(pack.skills.includes(match[1]), `action ${pack.id}.${action.id} calls undeclared skill: ${match[1]}`);
      }
    }
  }
  // Plugin-root resource references must point to bundled files/directories.
  function references(dir) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) references(path);
      else if (entry.name.endsWith(".md")) {
        const text = readFileSync(path, "utf8");
        for (const match of text.matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^\s`"'<>]+)/g)) {
          const ref = match[1].replace(/[),.;]+$/, "");
          if (ref.includes("*") || ref.includes("${")) continue;
          assert(existsSync(inside(root, ref)), `missing bundled reference in ${path}: ${ref}`);
        }
      }
    }
  }
  references(join(root, "skills"));
  references(join(root, "packs"));
  return { skills: catalog.size, seeds: seeds.size };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = validatePlugin(process.argv[2] ?? dirname(fileURLToPath(import.meta.url)));
  console.log(`ok plugin: ${result.skills} skills, ${result.seeds} workspace seeds`);
}
