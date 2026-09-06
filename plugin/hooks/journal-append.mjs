#!/usr/bin/env node
// sawhorse SessionEnd hook: append one JSONL line to the daily work journal.
// Never fails the session: every error is swallowed, exit code is always 0.
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const readStdin = () =>
  new Promise((resolve) => {
    let raw = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (raw += chunk));
    process.stdin.on("end", () => resolve(raw));
  });

// Local calendar date (journal is per work day — UTC would shift the file at night).
const localDate = (d = new Date()) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

try {
  const raw = await readStdin();
  if (!raw) process.exit(0);
  const e = JSON.parse(raw);
  if (!e.session_id) process.exit(0);
  const dir = join(homedir(), ".claude", "sawhorse", "journal");
  mkdirSync(dir, { recursive: true });
  const rec = {
    ts: new Date().toISOString(),
    session_id: e.session_id,
    cwd: e.cwd,
    transcript_path: e.transcript_path,
    reason: e.reason,
  };
  const line = JSON.stringify(rec) + "\n"; // JSON.stringify is BOM-less UTF-8
  const path = join(dir, localDate() + ".jsonl");
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      appendFileSync(path, line);
      break;
    } catch (err) {
      if (attempt === 4) {
        const errFile = join(tmpdir(), "sawhorse-journal.err");
        try {
          appendFileSync(
            errFile,
            `${new Date().toISOString()} journal write failed after 5 attempts: ${err?.message ?? err}\n`,
          );
        } catch {}
      } else {
        await new Promise((r) => setTimeout(r, 10 + Math.floor(Math.random() * 50)));
      }
    }
  }
} catch {}
process.exit(0);
