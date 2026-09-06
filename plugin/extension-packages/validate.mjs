import { createHash } from "node:crypto";
import { readdir, readFile, lstat } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));

async function payloadFiles(packageRoot, directory = packageRoot, output = new Map()) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name);
    const metadata = await lstat(absolute);
    if (metadata.isSymbolicLink()) throw new Error(`symlink is forbidden: ${absolute}`);
    if (metadata.isDirectory()) {
      await payloadFiles(packageRoot, absolute, output);
    } else if (metadata.isFile() && entry.name !== "extension.json") {
      const path = relative(packageRoot, absolute).replaceAll("\\", "/");
      output.set(path, createHash("sha256").update(await readFile(absolute)).digest("hex"));
    }
  }
  return output;
}

const failures = [];
for (const entry of await readdir(root, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const packageRoot = resolve(root, entry.name);
  try {
    const manifest = JSON.parse(await readFile(join(packageRoot, "extension.json"), "utf8"));
    if (manifest.manifestVersion !== 2) throw new Error("manifestVersion must be 2");
    const actual = await payloadFiles(packageRoot);
    const declared = new Map(Object.entries(manifest.fileDigests ?? {}));
    if (actual.size !== declared.size) {
      throw new Error(`fileDigests count ${declared.size} does not match payload count ${actual.size}`);
    }
    for (const [path, digest] of actual) {
      if (declared.get(path) !== digest) throw new Error(`digest mismatch: ${path}`);
    }
    for (const paths of Object.values(manifest.contributions ?? {})) {
      for (const path of paths) {
        const covered = declared.has(path) || [...declared.keys()].some((file) => file.startsWith(`${path}/`));
        if (!covered) throw new Error(`contribution is not digest-covered: ${path}`);
      }
    }
    console.log(`ok ${manifest.id}@${manifest.version} (${actual.size} files)`);
  } catch (error) {
    failures.push(`${entry.name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (failures.length) {
  for (const failure of failures) console.error(failure);
  process.exitCode = 1;
}
