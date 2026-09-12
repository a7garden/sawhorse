#!/usr/bin/env node
// sawhorse vault hygiene check. Invoked by morning/lunch/evening, one mode each.
//
// quick : immediate. Recovers vault-root attachments, corrects attachmentFolderPath, patches .base
//         template exclusions, checks index assets. Performs only reversible mechanical actions. (morning)
// scan  : diagnostics only. Finds dead links, orphan attachments, and frontmatter schema drift;
//         reports only. Writes no files. (lunch)
// fix   : quick + scan. Applies the mechanical actions and hands anything needing judgment over as a list. (evening)
//
// The goal is for the skill to get lists from this one script instead of opening and reading notes one by one.
//
// Usage: node vault-hygiene.mjs --vault <vault-path> --mode <quick|scan|fix>
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, lstatSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";

// ---------- args ----------

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
};
const vaultPath = argOf("--vault");
const mode = argOf("--mode") ?? "";

if (!vaultPath || !existsSync(vaultPath) || !statSync(vaultPath).isDirectory()) {
  console.log(`[오류] vault 경로 없음: ${vaultPath ?? "(없음)"}`);
  process.exit(1);
}
if (!["quick", "scan", "fix"].includes(mode)) {
  console.log(`[오류] mode 는 quick|scan|fix 중 하나여야 합니다: ${mode}`);
  process.exit(1);
}
const V = vaultPath.replace(/[\\/]+$/, "");

// ---------- constants ----------

// Project document root. Before the rename the vault only had 사업/ (business); migration is the user's call.
const ProjectRoot = existsSync(join(V, "프로젝트")) ? "프로젝트" : "사업";
const DocumentFolders = ["일지", "기록", "문서", "노트", "개념", "프로젝트", "사업"];
const ImageExt = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"];
const AttachExt = [...ImageExt, ".pdf", ".xlsx", ".xls", ".docx", ".doc", ".hwp", ".hwpx", ".pptx", ".zip", ".csv"];
const IndexAssets = [
  "대시보드.md",
  "개념/개념.base",
  `${ProjectRoot}/${ProjectRoot}.base`,
  "일지/일지.base",
];

const writeUtf8 = (full, text) => writeFileSync(full, text, "utf8"); // BOM-less

const relOf = (full) => relative(V, full).split(sep).join("/");
// Hidden state and linked directories are never traversed. The previous trailing
// slash check entered .git/.sawhorse before recognizing their descendants.
const excluded = (full) => relOf(full).split("/").some((part) => part.startsWith("."));
const legacyPath = (full) => /^(프로젝트|사업)\/[^/]+\/(이슈|개선|마일스톤)(\/|$)/.test(relOf(full));
const documentPath = (full) => DocumentFolders.includes(relOf(full).split("/")[0]) && !legacyPath(full);
const schemaManaged = (text) => /^---\r?\n[\s\S]*?^typeId:/m.test(text.split(/\r?\n---(?:\r?\n|$)/)[0]);

// ---------- walk ----------

// Declared before the walk runs so visit() can record unreadable entries.
const warn = [];

const walk = (dir, filter) => {
  const out = [];
  const visit = (d) => {
    let names;
    try {
      names = readdirSync(d);
    } catch (e) {
      warn.push(`[탐색실패] ${relOf(d) || "."} — 디렉터리 읽기 실패: ${e?.message ?? e}`);
      return;
    }
    for (const name of names) {
      const full = join(d, name);
      if (excluded(full)) continue;
      try {
        const st = lstatSync(full);
        if (st.isSymbolicLink()) continue;
        if (st.isDirectory()) {
          if (!excluded(full)) visit(full);
        } else if (st.isFile() && filter(name, full)) {
          out.push(full);
        }
      } catch (e) {
        warn.push(`[탐색실패] ${relOf(full)} — 항목 확인 실패: ${e?.message ?? e}`);
      }
    }
  };
  visit(dir);
  return out;
};

const mdFiles = walk(V, (name) => name.toLowerCase().endsWith(".md"));
const allFiles = walk(V, (name) => !name.startsWith("."));

const baseName = (full) => {
  const b = basename(full);
  return b.replace(/\.[^.]+$/, "");
};

let moved = 0;
let fixed = 0;

const say = (line) => console.log(line);

// An H1 identical to the filename duplicates Obsidian's inline title (wiki convention article 7).
// An H1 "different" from the filename carries information the filename cannot hold, so it is never touched.
const titleDedup = (doFix) => {
  const hit = [];
  const reFm = /^---\r?\n[\s\S]*?\r?\n---\r?\n/;
  const reH1 = /^# (.+?)[ \t]*$/m;
  const reTail = /^\r?\n(\r?\n)?/;
  for (const full of mdFiles) {
    const rel = relOf(full);
    if (!documentPath(full)) continue;
    let txt;
    try {
      txt = readFileSync(full, "utf8");
    } catch {
      continue;
    }
    if (!txt || schemaManaged(txt)) continue;
    let prefix = 0;
    let rest = txt;
    const fm = txt.match(reFm);
    if (fm) {
      prefix = fm[0].length;
      rest = txt.slice(prefix);
    }
    const h1 = rest.match(reH1);
    if (!h1 || h1.index === undefined) continue;
    if (h1[1].trim() !== baseName(full)) continue;
    hit.push(rel);
    if (!doFix) continue;
    let end = h1.index + h1[0].length;
    const tail = rest.slice(end).match(reTail);
    if (tail) end += tail[0].length;
    writeUtf8(full, txt.slice(0, prefix) + rest.slice(0, h1.index) + rest.slice(end));
  }
  return hit;
};

// ======================= quick / fix =======================

if (mode === "quick" || mode === "fix") {
  say("== 볼트 위생: 즉시 점검 ==");

  // 1) Recover vault-root attachments
  const strays = allFiles.filter((full) => {
    const ext = basename(full).replace(/^.*(\.[^.]+)$/, "$1").toLowerCase();
    if (!AttachExt.includes(ext)) return false;
    const rel = relOf(full);
    return rel === basename(full);
  });
  for (const full of strays) {
    const ext = basename(full).replace(/^.*(\.[^.]+)$/, "$1").toLowerCase();
    const destDir = join(V, ImageExt.includes(ext) ? join("첨부", "스크린샷") : "첨부");
    if (!existsSync(destDir)) mkdirSync(destDir, { recursive: true });
    const dest = join(destDir, basename(full));
    if (existsSync(dest)) {
      warn.push(`[충돌] ${relOf(full)} — 대상에 같은 이름 존재, 이동하지 않음`);
    } else {
      statSync(full); // keep liveness check parity with Move-Item failure
      try {
        renameOrCopy(full, dest);
        say(`[이동] ${relOf(full)} -> ${relOf(dest)}`);
        moved++;
      } catch (e) {
        warn.push(`[이동실패] ${relOf(full)} — ${e?.message ?? e}`);
      }
    }
  }
  if (strays.length === 0) say("[이동] 볼트 루트 첨부 없음");

  // 2) attachmentFolderPath (root cause of pasted images piling up in the vault root)
  const appJson = join(V, ".obsidian", "app.json");
  if (existsSync(appJson)) {
    let cfg = {};
    try {
      cfg = JSON.parse(readFileSync(appJson, "utf8"));
    } catch {
      warn.push("[설정] .obsidian/app.json 읽기 실패 — attachmentFolderPath 를 건드리지 않음");
      cfg = null;
    }
    if (cfg) {
      const cur = Object.prototype.hasOwnProperty.call(cfg, "attachmentFolderPath")
        ? cfg.attachmentFolderPath
        : null;
      if (cur == null || String(cur).trim() === "" || cur === "/" || cur === ".") {
        cfg.attachmentFolderPath = "첨부/스크린샷";
        writeUtf8(appJson, JSON.stringify(cfg, null, 2) + "\n");
        say("[설정] attachmentFolderPath = 첨부/스크린샷 (새로 지정)");
        fixed++;
      } else {
        say(`[설정] attachmentFolderPath = ${cur} (사용자 설정 유지)`);
      }
    }
  } else if (existsSync(join(V, ".obsidian"))) {
    mkdirSync(join(V, ".obsidian"), { recursive: true });
    writeUtf8(appJson, '{"attachmentFolderPath":"첨부/스크린샷"}\n');
    say("[설정] app.json 생성, attachmentFolderPath = 첨부/스크린샷");
    fixed++;
  }

  // 3) Unclassified notes left in the root (needs judgment, so report only, never move)
  const rootNotes = mdFiles.filter((full) => relOf(full) === basename(full) && basename(full) !== "대시보드.md");
  if (rootNotes.length > 0) {
    say(`[미분류] 루트 노트 ${rootNotes.length}건 — 어디로 보낼지 판단 필요`);
    for (const n of rootNotes) say(`  - ${basename(n)}`);
  } else {
    say("[미분류] 루트 노트 없음");
  }

  // 4) Check index assets exist (announce only when missing — never created here)
  const missingAssets = IndexAssets.filter((a) => !existsSync(join(V, a)));
  if (missingAssets.length > 0) {
    say(`[자산] 없음: ${missingAssets.join(", ")} — /sawhorse:init-vault 필요`);
  } else {
    say("[자산] 문서 인덱스 모두 있음");
  }

  // 5) Whether .base files exclude the template folder (template notes carry real type values too)
  const bases = walk(V, (name) => name.toLowerCase().endsWith(".base"));
  for (const full of bases) {
    if (!IndexAssets.includes(relOf(full))) continue;
    const txt = readFileSync(full, "utf8");
    // Bases already scoped to a folder (the improvements list's project scope) cannot mix in templates, so leave them alone.
    const scoped = /file\.inFolder\("[^"]+"\)/.test(txt);
    if (/^[ \t]*-[ \t]*type[ \t]*==/m.test(txt) && !scoped) {
      const ins = '$1    - not:\n        - file.inFolder("템플릿")\n';
      const patched = txt.replace(/^(filters:\r?\n  and:\r?\n)/m, ins);
      if (patched !== txt) {
        writeUtf8(full, patched);
        say(`[base] ${relOf(full)} — 템플릿 폴더 제외 추가`);
        fixed++;
      } else {
        warn.push(`[base] ${relOf(full)} — 템플릿 제외 누락, 구조가 달라 자동 보정 실패`);
      }
    }
  }

  // 6) Remove H1s identical to the filename (Obsidian already shows the filename as the inline title — wiki convention article 7)
  const dupTitles = titleDedup(true);
  if (dupTitles.length > 0) {
    say(`[제목중복] 파일명과 같은 H1 ${dupTitles.length}건 제거`);
    for (const d of dupTitles) say(`  - ${d}`);
    fixed += dupTitles.length;
  } else {
    say("[제목중복] 없음");
  }
}

// ======================= scan / fix =======================

if (mode === "scan" || mode === "fix") {
  say("");
  say("== 볼트 위생: 진단 ==");

  const readMd = (full) => {
    try {
      return readFileSync(full, "utf8");
    } catch {
      return "";
    }
  };

  // Link resolution dictionary: note basenames + attachment filenames + aliases
  const names = new Set();
  for (const full of mdFiles) names.add(baseName(full));
  for (const full of allFiles) names.add(basename(full));

  const bodies = new Map(mdFiles.map((full) => [full, readMd(full)]));
  for (const txt of bodies.values()) {
    for (const m of txt.matchAll(/^aliases:[ \t]*\[(.+?)\]/gm)) {
      for (const raw of m[1].split(",")) {
        const a = raw.trim().replace(/^"|"$/g, "").replace(/^'|'$/g, "");
        if (a) names.add(a);
      }
    }
  }

  // Strip "not actually links" before collecting links:
  //   HTML comments — explanatory examples ([[link]] etc.) inside guidance comments copied from templates
  //   code fences and inline code — `[[link]]` inside sentences explaining wikilink syntax itself
  // Without this, every note sprouts fake dead links that bury the real ones.
  const linkRefs = new Map();
  for (const [full, txt] of bodies) {
    const visible = txt
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/```[\s\S]*?```/g, "")
      .replace(/`[^`\r\n]*`/g, "");
    for (const m of visible.matchAll(/\[\[([^\]\|#]+)/g)) {
      const t = m[1].replace(/\\+$/, "").trim();
      if (!t) continue;
      if (!linkRefs.has(t)) linkRefs.set(t, []);
      linkRefs.get(t).push(relOf(full));
    }
  }

  // Example links inside templates (e.g. 다른개념 (other-concept)) are not dead links
  const dead = [];
  for (const [t, srcs] of linkRefs) {
    if (names.has(t)) continue;
    const src = [...new Set(srcs.filter((s) => !s.startsWith("템플릿/")))];
    if (src.length > 0) dead.push({ target: t, sources: src });
  }
  if (dead.length === 0) {
    say("[죽은링크] 없음");
  } else {
    say(`[죽은링크] ${dead.length}건`);
    for (const d of [...dead].sort((a, b) => (a.target < b.target ? -1 : a.target > b.target ? 1 : 0))) {
      say(`  - [[${d.target}]] <- ${d.sources.join(", ")}`);
    }
  }

  // Concept harvest section — lines under '## 개념 수집' (concept collection) not yet promoted
  // The user creates this section in any note and writes terms there with their context.
  // Lines already carrying a [[link]] count as promoted and are skipped (idempotent across reruns).
  // In a section containing at least one list, non-list lines are treated as "shared context" and not counted as terms.
  // (e.g. it keeps a lead-in sentence from showing up as pending promotion on every run.)
  // A section with no lists at all holds one term per line, so every line is a candidate.
  const harvest = [];
  const reList = /^\s*([-*+]|\d+\.)\s+/;
  for (const [full, txt] of bodies) {
    const rel = relOf(full);
    if (!documentPath(full) || schemaManaged(txt)) continue;
    const lines = txt.split(/\r?\n/);
    const sections = [];
    let cur = null;
    let inSec = false;
    let secLevel = 0;
    let inComment = false;
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      // Skip multi-line HTML comments (guidance comments must not be picked up as terms)
      if (inComment) {
        if (ln.includes("-->")) inComment = false;
        continue;
      }
      if (ln.includes("<!--") && !ln.includes("-->")) {
        inComment = true;
        continue;
      }
      if (/^\s*<!--/.test(ln)) continue;

      const h = ln.match(/^(#{2,6})\s*(.+?)\s*$/);
      if (h) {
        const lvl = h[1].length;
        // Only headings exactly '개념 수집' (concept collection); excludes the dashboard's '개념 수집함' (collection box) etc.
        if (/^개념\s*수집$/.test(h[2])) {
          cur = { hasList: false, items: [] };
          sections.push(cur);
          inSec = true;
          secLevel = lvl;
          continue;
        }
        if (inSec && lvl <= secLevel) {
          inSec = false;
          cur = null;
        }
        continue;
      }
      if (!inSec || !cur) continue;
      if (!ln.trim()) continue;
      const isList = reList.test(ln);
      if (isList) cur.hasList = true;
      if (ln.includes("[[")) continue; // line already promoted
      cur.items.push({ line: i + 1, text: ln.trim(), isList });
    }
    for (const s of sections) {
      for (const it of s.items) {
        if (s.hasList && !it.isList) continue; // prose line in a section with lists = context
        harvest.push(`${rel} : ${it.line} : ${it.text}`);
      }
    }
  }
  if (harvest.length === 0) {
    say("[수집] 승격 대기 없음");
  } else {
    say(`[수집] 승격 대기 ${harvest.length}줄 — 문맥째로 읽어 개념 노트로 올릴 것`);
    for (const h of harvest) say(`  - ${h}`);
  }

  // Orphan attachments (no references) — never deleted
  const mdText = [...bodies.values()].join("\n");
  const attachments = allFiles.filter((full) =>
    AttachExt.includes(basename(full).replace(/^.*(\.[^.]+)$/, "$1").toLowerCase()),
  );
  const orphans = attachments.filter((full) => !mdText.includes(basename(full)));
  if (orphans.length === 0) {
    say("[고아첨부] 없음");
  } else {
    say(`[고아첨부] ${orphans.length}건 (삭제하지 않음)`);
    for (const o of orphans) say(`  - ${relOf(o)}`);
  }

  // frontmatter schema comparison
  const tplKeys = new Map();
  const tplDir = join(V, "템플릿");
  if (existsSync(tplDir)) {
    for (const name of readdirSync(tplDir)) {
      if (!name.toLowerCase().endsWith(".md")) continue;
      const full = join(tplDir, name);
      if (!statSync(full).isFile()) continue;
      const m = readMd(full).match(/^---\r?\n([\s\S]*?)\r?\n---/);
      if (m) {
        tplKeys.set(
          baseName(full),
          [...m[1].matchAll(/^([A-Za-z_][A-Za-z0-9_]*):/gm)].map((x) => x[1]),
        );
      }
    }
  }
  const typeAlias = { 연구: "프로젝트" };
  const issues = [];
  for (const [full, raw] of bodies) {
    const rel = relOf(full);
    if (!documentPath(full) || schemaManaged(raw)) continue;
    const name = basename(full);
    // The legacy documents' inbox and MOC files are excluded from template comparison
    if (/^문제목록 - .*\.md$/.test(name) || / 문제목록\.md$/.test(name) || / 이슈목록\.md$/.test(name)) continue;
    if (name === "개선.md" && /(^|\/)개선\/개선\.md$/.test(rel)) continue;
    if (name === "이슈.md" && /(^|\/)이슈\/이슈\.md$/.test(rel)) continue;
    const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!m) {
      issues.push(`${rel} : frontmatter 없음`);
      continue;
    }
    const fm = m[1];
    const tm = fm.match(/^type:\s*(\S+)/m);
    if (!tm) {
      issues.push(`${rel} : type 없음`);
      continue;
    }
    let type = tm[1];
    if (type === "대시보드") continue;
    if (typeAlias[type]) type = typeAlias[type];
    if (!tplKeys.has(type)) {
      issues.push(`${rel} : type '${type}' 에 맞는 템플릿 없음`);
      continue;
    }
    const have = [...fm.matchAll(/^([A-Za-z_][A-Za-z0-9_]*):/gm)].map((x) => x[1]);
    const miss = tplKeys.get(type).filter((k) => !have.includes(k));
    if (miss.length > 0) issues.push(`${rel} : 키 누락 ${miss.join(", ")}`);
  }
  if (issues.length === 0) {
    say(`[스키마] 이상 없음 (${mdFiles.length}개 노트)`);
  } else {
    say(`[스키마] ${issues.length}건`);
    for (const s of issues) say(`  - ${s}`);
  }

  // H1s identical to the filename (scan only diagnoses — quick/fix does the removal)
  if (mode === "scan") {
    const dupTitles = titleDedup(false);
    if (dupTitles.length > 0) {
      say(`[제목중복] 파일명과 같은 H1 ${dupTitles.length}건 — 다음 quick/fix 실행이 제거한다`);
      for (const d of dupTitles) say(`  - ${d}`);
    } else {
      say("[제목중복] 없음");
    }
  }
}

for (const w of warn) say(w);
say("");
say(`[요약] mode=${mode} · 이동 ${moved} · 교정 ${fixed} · 경고 ${warn.length}`);

// ---------- helpers below (hoisted) ----------

function renameOrCopy(from, to) {
  // Same volume means rename — preserves Move-Item semantics. Failures are logged as warnings by the caller.
  renameSync(from, to);
}
