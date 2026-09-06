#!/usr/bin/env node
// sawhorse 볼트 위생 점검. morning/lunch/evening 이 모드별로 호출한다.
//
// quick : 즉시형. 표준 폴더 밖 첨부 회수, attachmentFolderPath 교정, .base 템플릿 제외 보정,
//         인덱스 자산 존재 확인. 되돌릴 수 있는 기계적 조치만 수행한다. (morning)
// scan  : 진단 전용. 죽은 링크, 고아 첨부, frontmatter 스키마 이탈을 찾아 보고만 한다.
//         어떤 파일도 쓰지 않는다. (lunch)
// fix   : quick + scan. 기계적 조치를 하고, 판단이 필요한 항목은 목록으로 넘긴다. (evening)
//
// 스킬이 노트를 하나씩 열어 읽는 대신 이 스크립트 한 번으로 목록만 받는 것이 목적이다.
//
// Usage: node vault-hygiene.mjs --vault <vault-path> --mode <quick|scan|fix>
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, sep } from "node:path";

// ---------- args ----------

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
};
const vaultPath = argOf("--vault");
const mode = argOf("--mode") ?? "";

if (!vaultPath || !existsSync(vaultPath)) {
  console.log(`[오류] vault 경로 없음: ${vaultPath ?? "(없음)"}`);
  process.exit(1);
}
if (!["quick", "scan", "fix"].includes(mode)) {
  console.log(`[오류] mode 는 quick|scan|fix 중 하나여야 합니다: ${mode}`);
  process.exit(1);
}
const V = vaultPath.replace(/[\\/]+$/, "");

// ---------- constants ----------

const StdFolders = ["일지", "사업", "개념", "첨부", "템플릿"];
const ImageExt = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp"];
const AttachExt = [...ImageExt, ".pdf", ".xlsx", ".xls", ".docx", ".doc", ".hwp", ".hwpx", ".pptx", ".zip", ".csv"];
const IndexAssets = [
  "대시보드.md",
  "개념/개념.base",
  "사업/사업.base",
  "사업/이슈.base",
  "사업/마일스톤.base",
  "일지/일지.base",
];

const writeUtf8 = (full, text) => writeFileSync(full, text, "utf8"); // BOM-less

const relOf = (full) => relative(V, full).split(sep).join("/");
const excluded = (full) => /(^|[\\/])\.(obsidian|git|trash)[\\/]/.test(full);

// ---------- walk ----------

const walk = (dir, filter) => {
  const out = [];
  const visit = (d) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      const st = statSync(full);
      if (st.isDirectory()) {
        if (!excluded(full)) visit(full);
      } else if (st.isFile() && filter(name, full)) {
        out.push(full);
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
const warn = [];

const say = (line) => console.log(line);

// 파일명과 같은 H1 은 Obsidian 인라인 제목과 중복이다 (wiki 규범 제7조).
// 파일명과 "다른" H1 은 파일명이 닫지 못한 정보이므로 절대 건드리지 않는다.
const titleDedup = (doFix) => {
  const hit = [];
  const reFm = /^---\r?\n[\s\S]*?\r?\n---\r?\n/;
  const reH1 = /^# (.+?)[ \t]*$/m;
  const reTail = /^\r?\n(\r?\n)?/;
  for (const full of mdFiles) {
    const rel = relOf(full);
    if (rel.startsWith("템플릿/")) continue;
    let txt;
    try {
      txt = readFileSync(full, "utf8");
    } catch {
      continue;
    }
    if (!txt) continue;
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

  // 1) 표준 폴더 밖 첨부 회수
  const strays = allFiles.filter((full) => {
    const ext = basename(full).replace(/^.*(\.[^.]+)$/, "$1").toLowerCase();
    if (!AttachExt.includes(ext)) return false;
    const rel = relOf(full);
    const top = rel.split("/")[0];
    return rel === basename(full) || !StdFolders.includes(top);
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
  if (strays.length === 0) say("[이동] 표준 폴더 밖 첨부 없음");

  // 2) attachmentFolderPath (붙여넣기 이미지가 루트에 쌓이는 근본 원인)
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
  } else {
    mkdirSync(join(V, ".obsidian"), { recursive: true });
    writeUtf8(appJson, '{"attachmentFolderPath":"첨부/스크린샷"}\n');
    say("[설정] app.json 생성, attachmentFolderPath = 첨부/스크린샷");
    fixed++;
  }

  // 3) 루트에 남은 미분류 노트 (판단이 필요하므로 옮기지 않고 보고만)
  const rootNotes = mdFiles.filter((full) => relOf(full) === basename(full) && basename(full) !== "대시보드.md");
  if (rootNotes.length > 0) {
    say(`[미분류] 루트 노트 ${rootNotes.length}건 — 어디로 보낼지 판단 필요`);
    for (const n of rootNotes) say(`  - ${basename(n)}`);
  } else {
    say("[미분류] 루트 노트 없음");
  }

  // 4) 인덱스 자산 존재 확인 (없으면 안내만 — 여기서 만들지 않는다)
  const missingAssets = IndexAssets.filter((a) => !existsSync(join(V, a)));
  if (missingAssets.length > 0) {
    say(`[자산] 없음: ${missingAssets.join(", ")} — /sawhorse:init-vault 필요`);
  } else {
    say("[자산] 대시보드·base 5종 모두 있음");
  }

  // 5) .base 가 템플릿 폴더를 제외하는지 (템플릿 노트도 진짜 type 값을 갖고 있다)
  const bases = walk(V, (name) => name.toLowerCase().endsWith(".base"));
  for (const full of bases) {
    const txt = readFileSync(full, "utf8");
    // 이미 폴더로 범위를 좁힌 base(개선의 사업 범위)는 템플릿이 섞일 수 없으므로 건드리지 않는다.
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

  // 5-b) 이슈(및 레거시 개선) 폴더의 범위별 base 존재 확인 + 파생 표 잔존 탐지
  const impRoot = join(V, "사업");
  if (existsSync(impRoot)) {
    const impDirs = walkDirs(impRoot).filter(
      (d) => ["이슈", "개선"].includes(basename(d)) && !excluded(d),
    );
    for (const d of impDirs) {
      const mdIn = walk(d, (name) => name.toLowerCase().endsWith(".md"));
      const hasNote = mdIn.some((full) => {
        try {
          return readFileSync(full, "utf8")
            .split(/\r?\n/)
            .slice(0, 16)
            .some((l) => /^type:\s*(이슈|개선)\s*$/.test(l));
        } catch {
          return false;
        }
      });
      if (!hasNote) continue;
      const ownBases = readdirSync(d).filter((n) => n.toLowerCase().endsWith(".base"));
      if (ownBases.length === 0) {
        const kind = basename(d) === "이슈" ? "이슈" : "개선(레거시)";
        say(`[이슈base] ${relOf(d)} — ${kind} 사업 범위 base 없음 (/sawhorse:issues 가 만든다)`);
      }
      // 이슈 폴더는 평면이다 — 화면·마일스톤은 프로퍼티가 나눈다. 하위 폴더는 보고만 한다.
      for (const sd of walkDirs(d, false)) {
        const n = readdirSync(sd).filter((x) => statSync(join(sd, x)).isFile() && x.toLowerCase().endsWith(".md")).length;
        if (n > 0) {
          say(
            `[이슈폴더] ${relOf(sd)} — 하위 폴더. 이슈 노트를 이슈/ 바로 아래로 둘 것 — 화면·마일스톤은 프로퍼티가 나눈다`,
          );
        }
      }
      // 노트 프로퍼티를 베껴 둔 표(행이 [[링크]] 로 시작)는 반드시 어긋난다.
      for (const full of mdIn) {
        const rows = (readFileSync(full, "utf8").match(/^[ \t]*\|[ \t]*\[\[/gm) || []).length;
        if (rows >= 3) {
          say(`[파생표] ${relOf(full)} — 이슈 노트를 베낀 표 ${rows} 행. .base 뷰 임베드로 바꿀 것`);
        }
      }
    }
  }

  // 6) 파일명과 같은 H1 제거 (Obsidian 은 파일명을 인라인 제목으로 이미 보여준다 — 규범 제7조)
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

  // 링크 해석 사전: 노트 basename + 첨부 파일명 + aliases
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

  // 링크 수집 전에 "링크가 아닌 것"을 걷어낸다:
  //   HTML 주석 — 템플릿에서 복사돼 온 안내 주석의 설명용 예시([[링크]] 등)
  //   코드펜스·인라인 코드 — 위키링크 문법 자체를 설명하는 문장의 `[[링크]]`
  // 걷어내지 않으면 노트마다 가짜 죽은 링크가 생겨 진짜 죽은 링크가 묻힌다.
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

  // 템플릿 안의 예시 링크(다른개념 등)는 죽은 링크가 아니다
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

  // 개념 수집 섹션 — '## 개념 수집' 아래에서 아직 승격되지 않은 줄
  // 사용자는 아무 노트에나 이 섹션을 만들고 용어를 문맥과 함께 적어둔다.
  // 이미 [[링크]]가 붙은 줄은 승격된 것으로 보고 건너뛴다(재실행 멱등).
  // 목록이 하나라도 있는 섹션에서는 목록이 아닌 줄을 "공통 문맥"으로 보고 용어로 세지 않는다.
  // (예: 머리글 문장이 매번 승격 대기로 뜨는 것을 막는다.)
  // 목록이 전혀 없는 섹션은 한 줄에 용어 하나로 적은 것이므로 모든 줄을 후보로 본다.
  const harvest = [];
  const reList = /^\s*([-*+]|\d+\.)\s+/;
  for (const [full, txt] of bodies) {
    const rel = relOf(full);
    if (rel.startsWith("템플릿/")) continue;
    const lines = txt.split(/\r?\n/);
    const sections = [];
    let cur = null;
    let inSec = false;
    let secLevel = 0;
    let inComment = false;
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      // 여러 줄 HTML 주석 건너뛰기 (안내 주석이 용어로 잡히면 안 된다)
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
        // 정확히 '개념 수집' 인 헤딩만 (대시보드의 '개념 수집함' 등은 제외)
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
      if (ln.includes("[[")) continue; // 이미 승격된 줄
      cur.items.push({ line: i + 1, text: ln.trim(), isList });
    }
    for (const s of sections) {
      for (const it of s.items) {
        if (s.hasList && !it.isList) continue; // 목록 있는 섹션의 산문 줄 = 문맥
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

  // 고아 첨부 (참조 없음) — 삭제하지 않는다
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

  // frontmatter 스키마 대조
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
  const typeAlias = { 연구: "사업" };
  const issues = [];
  for (const [full, raw] of bodies) {
    const rel = relOf(full);
    if (rel.startsWith("템플릿/")) continue;
    const name = basename(full);
    // improve 스킬이 의도적으로 frontmatter 없이 두는 산출물
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

  // 파일명과 같은 H1 (scan 은 진단만 — 제거는 quick/fix 가 한다)
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
  // 같은 볼륨이면 rename — Move-Item 의미 유지. 실패는 호출자가 경고로 기록한다.
  renameSync(from, to);
}

function walkDirs(root, recursive = true) {
  const out = [];
  const visit = (d) => {
    for (const name of readdirSync(d)) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) {
        out.push(full);
        if (recursive) visit(full);
      }
    }
  };
  visit(root);
  return out;
}
