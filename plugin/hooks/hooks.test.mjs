// sawhorse hook tests (node:test). Run: node --test plugin/hooks/
// Ports the former Pester suite (tests/hook.tests.ps1) to the Node hooks.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { after, before, describe, it } from "node:test";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const blockPush = join(here, "block-push.mjs");
const journal = join(here, "journal-append.mjs");

const runHook = (script, stdin, env = {}) =>
  spawnSync(process.execPath, [script], {
    input: stdin,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });

describe("block-push.mjs", () => {
  const cases = [
    { cmd: "git push", expect: "ask" },
    { cmd: "GIT PUSH", expect: "ask" },
    { cmd: "git -C repo push origin main", expect: "ask" },
    { cmd: "git.exe push", expect: "ask" },
    { cmd: "git.cmd push", expect: "ask" },
    { cmd: "C:\\tools\\bin\\git.exe push origin", expect: "ask" },
    { cmd: "git add -A && git push", expect: "ask" },
    { cmd: "git push --force-with-lease", expect: "ask" },
    { cmd: "git push --no-verify", expect: "ask" },
    { cmd: "cd /w;git push", expect: "ask" },
    { cmd: "git -C work svn dcommit", expect: "ask" },
    { cmd: "git svn dcommit", expect: "ask" },
    { cmd: "git send-pack host refs/heads/main", expect: "ask" },
    { cmd: "svn ci -m x", expect: "ask" },
    { cmd: "svn -q commit -m x", expect: "ask" },
    { cmd: "svn import . file:///repo", expect: "ask" },
    { cmd: "hg push", expect: "ask" },
    { cmd: "hg.exe push", expect: "ask" },
    { cmd: "hg -R /repo push", expect: "ask" },
    { cmd: "git commit -m msg", expect: "allow" },
    { cmd: "git pushy --tags", expect: "allow" },
    { cmd: "git log push-fix", expect: "allow" },
    { cmd: "npm test", expect: "allow" },
    { cmd: "", expect: "allow" },
  ];

  for (const { cmd, expect } of cases) {
    it(`"${cmd}" => ${expect}`, () => {
      const r = runHook(blockPush, JSON.stringify({ tool_input: { command: cmd } }));
      assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}`);
      const out = r.stdout.trim();
      const decision = out ? JSON.parse(out).hookSpecificOutput.permissionDecision : "allow";
      assert.equal(decision, expect);
    });
  }

  it("malformed stdin never fails the session", () => {
    const r = runHook(blockPush, "{not json");
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), "");
  });
});

describe("journal-append.mjs", () => {
  let home;
  let prev;

  before(() => {
    home = mkdtempSync(join(tmpdir(), "sawhorse-journal-test-"));
    prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
  });

  after(() => {
    rmSync(home, { recursive: true, force: true });
  });

  const withHome = () => ({ HOME: home, USERPROFILE: home });

  it("appends BOM-less UTF-8 JSONL, preserved across invocations", () => {
    for (const sid of ["t1", "t2"]) {
      const r = runHook(
        journal,
        JSON.stringify({
          session_id: sid,
          cwd: "/work",
          transcript_path: `${sid}.jsonl`,
          reason: "exit",
        }),
        withHome(),
      );
      assert.equal(r.status, 0, `exit ${r.status}: ${r.stderr}`);
    }
    const jdir = join(home, ".claude", "sawhorse", "journal");
    assert.ok(existsAt(jdir), "journal dir created");
    const files = readdirSync(jdir).filter((f) => f.endsWith(".jsonl"));
    assert.equal(files.length, 1, "exactly one journal file");
    const bytes = readFileSync(join(jdir, files[0]));
    assert.ok(bytes[0] !== 0xef || bytes[1] !== 0xbb || bytes[2] !== 0xbf, "no BOM");
    const lines = bytes.toString("utf8").split("\n").filter((l) => l.trim());
    assert.equal(lines.length, 2, "two appended lines");
    const ids = lines.map((l) => JSON.parse(l).session_id);
    assert.ok(ids.includes("t1") && ids.includes("t2"), "appends preserved");
  });

  it("empty and session-less stdin are no-ops", () => {
    for (const input of ["", JSON.stringify({ cwd: "/work" }), "{not json"]) {
      const r = runHook(journal, input, withHome());
      assert.equal(r.status, 0);
    }
  });
});

function existsAt(p) {
  try {
    readdirSync(p);
    return true;
  } catch {
    return false;
  }
}
