#!/usr/bin/env node
// sawhorse PreToolUse hook: force confirmation for remote-mutating VCS commands (company policy).
// Emits a PreToolUse "ask" decision when the command touches a remote; otherwise prints nothing.
const REMOTE_MUTATORS = [
  /(^|[&|(>;\s\\/])git(\.exe|\.cmd)?(\s+[^ ;&|>]+)*\s+(push|send-pack)(?![A-Za-z0-9_-])/i,
  /(^|[&|(>;\s\\/])svn(\.exe|\.cmd)?(\s+[^ ;&|>]+)*\s+(commit|ci|import)(?![A-Za-z0-9_-])/i,
  /(^|[&|(>;\s\\/])git(\.exe|\.cmd)?(\s+[^ ;&|>]+)*\s+svn\s+dcommit(?![A-Za-z0-9_-])/i,
  /(^|[&|(>;\s\\/])hg(\.exe|\.cmd)?(\s+[^ ;&|>]+)*\s+push(?![A-Za-z0-9_-])/i,
];

const readStdin = () =>
  new Promise((resolve) => {
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (raw += chunk));
    process.stdin.on("end", () => resolve(raw));
  });

try {
  const raw = await readStdin();
  if (raw) {
    const e = JSON.parse(raw);
    const cmd = e?.tool_input?.command ? String(e.tool_input.command) : "";
    if (cmd && REMOTE_MUTATORS.some((re) => re.test(cmd))) {
      console.log(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "ask",
            permissionDecisionReason:
              "sawhorse 회사 정책 확인: 원격 저장소 변경(git push / svn commit)입니다. 회사 규정상 허용되는 경우에만 실행을 승인하세요.",
          },
        }),
      );
    }
  }
} catch {}
process.exit(0);
