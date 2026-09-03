#!/usr/bin/env node
// improve-xlsx.mjs — 볼트의 개선 노트(type: 개선) → 「개선수정사항 체크리스트」 엑셀
//
//   node improve-xlsx.mjs --out <파일.xlsx> [옵션]
//
// 옵션
//   --vault <경로>     생략하면 ~/.claude/si-workbench/config.json 의 vaultPath
//   --project <이름>   사업 폴더명. 생략하면 config 의 improve.defaultProject, 그것도 없으면 사업/ 아래 전부
//   --out <경로>       만들 xlsx (필수)
//   --prev <경로>      기존 체크리스트 xlsx. 손으로 채운 열(요구자·담당자 등)을 문제 ID 로 이어받는다
//   --owner <이름>     담당자 기본값 (--prev 에 값이 없을 때만)
//   --org <이름>       요구기관 기본값 (기본: origin 에서 파생)
//   --title <문자열>   A1 제목
//   --no-images        「근거이미지」 시트를 만들지 않는다
//   --max-image-w <px> 이미지 최대 가로 (기본 860)
//   --status <목록>    쉼표로 구분한 status 화이트리스트 (기본: 전부)
//   --json <경로>      만들어진 행 데이터를 JSON 으로도 떨군다 (점검용)

import fs from 'node:fs';
import path from 'node:path';
import { buildWorkbook, sheetXml, drawingXml, dateSerial, imageSize, colName, S } from './xlsx-write.mjs';
import { readWorkbook } from './xlsx-read.mjs';

// ── 인자 ──────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const opt = (name, def = null) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def;
};
const flag = (name) => argv.includes('--' + name);

// 볼트 경로와 기본 사업은 si-workbench 설정에서 가져온다. 인자를 주면 인자가 이긴다.
function loadConfig() {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  try { return JSON.parse(fs.readFileSync(path.join(home, '.claude', 'si-workbench', 'config.json'), 'utf8')); }
  catch { return {}; }
}
const CONFIG = loadConfig();

const VAULT = opt('vault', CONFIG.vaultPath || '');
const PROJECT = opt('project', CONFIG.improve?.defaultProject || null);
const OUT = opt('out');
const PREV = opt('prev');
const OWNER = opt('owner', '');
const ORG = opt('org');
const MAX_IMG_W = +opt('max-image-w', 860);
const WITH_IMAGES = !flag('no-images');
const STATUS_FILTER = opt('status') ? opt('status').split(',').map((s) => s.trim()) : null;
const JSON_OUT = opt('json');

if (!OUT) {
  console.error('--out <파일.xlsx> 가 필요합니다.');
  process.exit(1);
}
if (!VAULT) {
  console.error('볼트 경로를 찾지 못했습니다. --vault 로 주거나 /si-workbench:setup 을 먼저 실행하세요.');
  process.exit(1);
}

// ── 볼트 읽기 ─────────────────────────────────────────────────────────────────

function walk(dir, out = []) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    if (e.name.startsWith('.')) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

/** 아주 작은 YAML 프런트매터 파서 — 이 볼트가 쓰는 형태만 다룬다 */
function parseFrontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!m) return { fm: null, body: text };
  const fm = {};
  for (const line of m[1].split(/\r?\n/)) {
    const km = line.match(/^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/);
    if (!km) continue;
    let [, key, raw] = km;
    raw = raw.trim();
    if (raw === '') { fm[key] = ''; continue; }
    if (raw === 'true' || raw === 'false') { fm[key] = raw === 'true'; continue; }
    if (raw.startsWith('[') && raw.endsWith(']')) {
      const inner = raw.slice(1, -1).trim();
      fm[key] = inner ? inner.split(/\s*,\s*/).map((s) => s.replace(/^["']|["']$/g, '')) : [];
      continue;
    }
    fm[key] = raw.replace(/^["']|["']$/g, '');
  }
  return { fm, body: text.slice(m[0].length) };
}

const vaultFiles = walk(VAULT);

// 첨부 파일 색인 (파일명 → 실제 경로). 같은 이름이 여럿이면 첫 번째.
const attachIndex = new Map();
for (const p of vaultFiles) {
  if (!/\.(png|jpe?g|gif)$/i.test(p)) continue;
  const base = path.basename(p);
  if (!attachIndex.has(base)) attachIndex.set(base, p);
  const stem = base.replace(/\.[^.]+$/, '');
  if (!attachIndex.has(stem)) attachIndex.set(stem, p);
}

const projectRoot = PROJECT ? path.join(VAULT, '사업', PROJECT) : path.join(VAULT, '사업');

const notes = [];
for (const p of vaultFiles) {
  if (!p.endsWith('.md')) continue;
  if (!p.startsWith(projectRoot)) continue;
  const text = fs.readFileSync(p, 'utf8');
  const { fm, body } = parseFrontmatter(text);
  if (!fm || fm.type !== '개선' || !fm.id) continue;
  notes.push({ file: p, fm, body, title: path.basename(p, '.md') });
}
notes.sort((a, b) => String(a.fm.id).localeCompare(String(b.fm.id), 'en', { numeric: true }));

if (!notes.length) {
  console.error(`개선 노트를 찾지 못했습니다: ${projectRoot}`);
  process.exit(1);
}

// ── 노트 → 행 ─────────────────────────────────────────────────────────────────

const ORG_BY_ORIGIN = { '사용자 제안': '내부리뷰', '인수인계': '인수인계', '점검 발견': '내부점검' };
const RESULT_BY_CATEGORY = { '버그': '오류수정', 'UI 개선': '개선요청', '성능': '개선요청', '리팩터링': '기타' };
const PRIORITY_MAP = { '최우선': '상', '중요': '중', '보통': '하', '': '하' };
const DONE_BY_STATUS = {
  '구현완료': '완료', '구현중': '진행', '부분구현': '진행',
  '보류': '보류', '반려': '반려',
  '제안': '대기', '승인대기': '대기', '승인': '대기',
};

/** 노트 제목에서 "FDR-013 " 접두사를 뗀다 */
const stripId = (title) => title.replace(/^FDR-\d+\s+/, '');

/** 본문에서 ![[...]] 임베드를 찾아 실제 이미지 파일로 해석 */
function collectImages(body) {
  const out = [];
  const seen = new Set();
  let heading = '';
  for (const line of body.split(/\r?\n/)) {
    const hm = line.match(/^#{2,4}\s+(.+?)\s*$/);
    if (hm) { heading = hm[1]; continue; }
    for (const m of line.matchAll(/!\[\[([^\]|#]+?)(?:\|[^\]]*)?\]\]/g)) {
      const name = m[1].trim();
      if (name === '파일명.png') continue; // 템플릿 자리표시자
      const file = attachIndex.get(name);
      if (!file || seen.has(file)) continue;
      seen.add(file);
      out.push({ file, name, section: heading });
    }
  }
  return out;
}

const rows = notes
  .filter((n) => !STATUS_FILTER || STATUS_FILTER.includes(n.fm.status))
  .map((n) => {
    const fm = n.fm;
    const category = fm.category || '';
    return {
      id: String(fm.id),
      note: n,
      접수일: fm.raised || '',
      요구기관: ORG || ORG_BY_ORIGIN[fm.origin] || fm.origin || '',
      요구자: '',
      '화면 명': fm.screen || fm.url || '',
      항목: fm.item || '',
      '개선요구사항 및 오류사항': fm.summary || stripId(n.title),
      검토결과: RESULT_BY_CATEGORY[category] || (category ? '기타' : '개선요청'),
      조치내용: fm.action || '',
      '완료일(예정일)': fm.due || '',
      우선순위: PRIORITY_MAP[fm.priority ?? ''] ?? '하',
      완료여부: DONE_BY_STATUS[fm.status] || fm.status || '',
      담당자: OWNER,
      비고: fm.remark || '',
      images: WITH_IMAGES ? collectImages(n.body) : [],
    };
  });

// ── 기존 엑셀에서 손으로 채운 값 이어받기 ─────────────────────────────────────

const HEADERS = ['No', '접수일', '요구기관', '요구자', '화면 명', '항목', '개선요구사항 및 오류사항',
  '검토결과', '조치내용', '완료일(예정일)', '우선순위', '완료여부', '담당자', '비고', 'FDR'];

// 볼트가 정본인 열. 나머지(요구자·담당자·기타)는 엑셀이 정본이라 그대로 이어받는다.
const VAULT_OWNED = new Set(['접수일', '요구기관', '화면 명', '항목', '개선요구사항 및 오류사항',
  '검토결과', '조치내용', '완료일(예정일)', '우선순위', '완료여부', '비고']);

const carried = { manual: 0, filled: 0, missing: [] };
const extraCols = [];

if (PREV) {
  if (!fs.existsSync(PREV)) {
    console.error(`--prev 파일이 없습니다: ${PREV}`);
    process.exit(1);
  }
  const sheets = readWorkbook(fs.readFileSync(PREV));
  const sheet = sheets[0];
  const hdrIdx = sheet.rows.findIndex((r) => r.includes('No') && (r.includes('비고') || r.includes('개선요구사항 및 오류사항')));
  if (hdrIdx < 0) {
    console.error(`--prev 에서 헤더 행(No … 비고)을 찾지 못했습니다: ${PREV}`);
    process.exit(1);
  }
  const hdr = sheet.rows[hdrIdx];
  const idCol = hdr.indexOf('FDR');
  if (idCol < 0) {
    console.error('--prev 에 FDR ID 열(헤더 "FDR")이 없어 이어받을 수 없습니다.');
    console.error('  이 스크립트가 만든 엑셀이라면 O열에 숨겨져 있습니다. 다른 파일이면 --prev 없이 새로 만드세요.');
    process.exit(1);
  }

  for (let i = 0; i < hdr.length; i++) {
    if (hdr[i] && !HEADERS.includes(hdr[i])) extraCols.push({ header: hdr[i], col: i });
  }

  const prevById = new Map();
  for (let r = hdrIdx + 1; r < sheet.rows.length; r++) {
    const row = sheet.rows[r];
    const id = (row[idCol] || '').trim();
    if (id) prevById.set(id, row);
  }

  for (const row of rows) {
    const prev = prevById.get(row.id);
    if (!prev) { carried.missing.push(row.id); continue; }
    for (let i = 0; i < hdr.length; i++) {
      const h = hdr[i];
      const v = (prev[i] ?? '').toString().trim();
      if (!h || h === 'No' || h === 'FDR' || !v) continue;
      if (!VAULT_OWNED.has(h)) {
        // 엑셀이 정본인 열 — 무조건 이어받는다
        row[h] = v;
        carried.manual++;
      } else if (!row[h]) {
        // 볼트가 정본이지만 값이 비어 있으면 유실하지 않고 이어받는다
        row[h] = /^\d{5}$/.test(v) && (h === '접수일' || h === '완료일(예정일)')
          ? new Date(Date.UTC(1899, 11, 30) + +v * 86400000).toISOString().slice(0, 10)
          : v;
        carried.filled++;
      }
    }
  }
}

// ── 시트1 「수정보완_체크리스트」 ─────────────────────────────────────────────

const COLS = [
  { h: 'No', w: 7, s: S.CENTER },
  { h: '접수일', w: 12, s: S.DATE, date: true },
  { h: '요구기관', w: 12, s: S.CENTER },
  { h: '요구자', w: 10, s: S.MANUAL },
  { h: '화면 명', w: 22, s: S.CENTER_WRAP },
  { h: '항목', w: 22, s: S.WRAP },
  { h: '개선요구사항 및 오류사항', w: 62, s: S.WRAP },
  { h: '검토결과', w: 12, s: S.CENTER },
  { h: '조치내용', w: 30, s: S.WRAP },
  { h: '완료일(예정일)', w: 14, s: S.DATE, date: true },
  { h: '우선순위', w: 10, s: S.CENTER },
  { h: '완료여부', w: 10, s: S.CENTER },
  { h: '담당자', w: 10, s: S.MANUAL },
  { h: '비고', w: 40, s: S.WRAP },
  { h: 'FDR', w: 14, s: S.CENTER, hidden: true },
  ...extraCols.map((c) => ({ h: c.header, w: 20, s: S.WRAP })),
];

const HEADER_ROW = 3;
const FIRST_DATA_ROW = HEADER_ROW + 1;
const lastColName = colName(COLS.length - 1);
const visibleLastCol = colName(COLS.length - 1 - (extraCols.length ? 0 : 1) - (extraCols.length ? 1 : 0));

const title = opt('title') || `□ ${PROJECT || '개선'} 개선요구사항 및 오류개선사항`;

const s1rows = [];
s1rows[0] = [{ v: title, s: S.TITLE }];
s1rows[1] = [{
  v: `${new Date().toISOString().slice(0, 10)} 기준 · 총 ${rows.length}건`
    + (WITH_IMAGES ? ' · 「개선요구사항」 칸의 파란 글씨는 클릭하면 「근거이미지」 시트로 이동합니다' : '')
    + ' · 노란 칸(요구자·담당자)은 직접 채우는 칸입니다',
  s: S.GUIDE,
}];
s1rows[2] = COLS.map((c) => ({ v: c.h, s: S.HEADER }));

// 이미지가 있는 FDR 은 시트2 어느 행으로 가는지 먼저 계산해야 하이퍼링크를 걸 수 있다
const IMG_SHEET = '근거이미지';
const ROW_PX = 22;
const imageBlocks = [];
if (WITH_IMAGES) {
  let cursor = 4; // 시트2 4행부터 (1 제목 / 2 안내 / 3 여백)
  for (const row of rows) {
    if (!row.images.length) continue;
    const block = { id: row.id, row, headingRow: cursor, items: [] };
    cursor += 1; // 소제목
    for (const im of row.images) {
      const buf = fs.readFileSync(im.file);
      const size = imageSize(buf) || { w: 800, h: 450 };
      const scale = Math.min(1, MAX_IMG_W / size.w, 1200 / size.h);
      const wPx = Math.round(size.w * scale);
      const hPx = Math.round(size.h * scale);
      block.items.push({ ...im, buf, wPx, hPx, captionRow: cursor, imageRow: cursor + 1 });
      cursor += 1 + Math.ceil(hPx / ROW_PX) + 1; // 캡션 + 이미지 + 여백
    }
    cursor += 2;
    imageBlocks.push(block);
  }
}
const blockById = new Map(imageBlocks.map((b) => [b.id, b]));

const hyperlinks = [];
rows.forEach((row, i) => {
  const r = FIRST_DATA_ROW + i;
  const block = blockById.get(row.id);
  const cells = COLS.map((c, ci) => {
    if (c.h === 'No') return { v: i + 1, t: 'n', s: c.s };
    if (c.h === 'FDR') return { v: row.id, s: c.s };
    const raw = row[c.h] ?? '';
    if (c.date) {
      const ser = dateSerial(raw);
      return ser == null ? { v: '', s: c.s } : { v: ser, t: 'd', s: c.s };
    }
    if (c.h === '개선요구사항 및 오류사항' && block) {
      hyperlinks.push({
        ref: `${colName(ci)}${r}`,
        location: `'${IMG_SHEET}'!A${block.headingRow}`,
        display: String(raw),
      });
      return { v: raw, s: S.LINK };
    }
    return { v: raw, s: c.s };
  });
  s1rows[r - 1] = cells;
});

const sheet1 = sheetXml({
  rows: s1rows,
  cols: COLS.map((c) => ({ w: c.w, hidden: c.hidden })),
  merges: [`A1:${lastColName}1`, `A2:${lastColName}2`],
  hyperlinks,
  freeze: HEADER_ROW,
  autoFilter: `A${HEADER_ROW}:${colName(COLS.length - 1)}${HEADER_ROW}`,
  rowHeights: { 1: 24, 2: 18, 3: 30 },
});

const sheets = [{ name: '수정보완_체크리스트', xml: sheet1 }];

// ── 시트2 「근거이미지」 ──────────────────────────────────────────────────────

if (WITH_IMAGES && imageBlocks.length) {
  const s2rows = [];
  const s2links = [];
  const media = [];
  const anchors = [];
  const rowHeights = {};

  s2rows[0] = [{ v: '근거 이미지', s: S.TITLE }];
  s2rows[1] = [{ v: '문제 노트에 붙어 있는 스크린샷·목업 캡처입니다. 소제목을 클릭하면 체크리스트로 돌아갑니다.', s: S.GUIDE }];

  for (const block of imageBlocks) {
    const listRow = FIRST_DATA_ROW + rows.indexOf(block.row);
    s2rows[block.headingRow - 1] = [{ v: `${block.id} · ${block.row['개선요구사항 및 오류사항']}`, s: S.H2 }];
    s2links.push({
      ref: `A${block.headingRow}`,
      location: `'수정보완_체크리스트'!A${listRow}`,
      display: block.id,
    });
    rowHeights[block.headingRow] = 24;

    block.items.forEach((im, k) => {
      const ext = path.extname(im.file).slice(1).toLowerCase().replace('jpg', 'jpeg');
      const mediaName = `image${media.length + 1}.${ext}`;
      media.push({ name: mediaName, data: im.buf });
      const label = im.section ? `${k + 1}. ${im.section} — ${im.name}` : `${k + 1}. ${im.name}`;
      s2rows[im.captionRow - 1] = [{ v: label, s: S.CAPTION }];
      anchors.push({
        relId: `rId${media.length}`,
        col: 0,
        row: im.imageRow - 1,
        wPx: im.wPx,
        hPx: im.hPx,
        name: `${block.id}-${k + 1}`,
      });
    });
  }
  for (let i = 0; i < s2rows.length; i++) if (!s2rows[i]) s2rows[i] = [];

  sheets.push({
    name: IMG_SHEET,
    xml: sheetXml({
      rows: s2rows,
      cols: [{ w: 130 }],
      hyperlinks: s2links,
      freeze: 2,
      rowHeights,
      drawingRel: 'rIdDr',
    }),
    drawing: { xml: drawingXml(anchors), media },
  });
}

// ── 쓰기 ──────────────────────────────────────────────────────────────────────

fs.mkdirSync(path.dirname(path.resolve(OUT)), { recursive: true });
fs.writeFileSync(OUT, buildWorkbook({ sheets, title }));

if (JSON_OUT) {
  fs.writeFileSync(JSON_OUT, JSON.stringify(rows.map(({ note, images, ...r }) => ({ ...r, images: images.map((i) => i.name) })), null, 2), 'utf8');
}

// ── 보고 ──────────────────────────────────────────────────────────────────────

const imgCount = imageBlocks.reduce((a, b) => a + b.items.length, 0);
console.log(`만듦: ${path.resolve(OUT)}`);
console.log(`  행 ${rows.length}건 · 이미지 ${imgCount}장 (${imageBlocks.length}개 문제)`);
if (PREV) {
  console.log(`  기존 엑셀에서 이어받음: 수기 열 ${carried.manual}칸 · 볼트 빈칸 보완 ${carried.filled}칸`);
  if (carried.missing.length) console.log(`  기존 엑셀에 없던 새 문제 ${carried.missing.length}건: ${carried.missing.join(', ')}`);
  if (extraCols.length) console.log(`  기존 엑셀의 추가 열 ${extraCols.length}개 보존: ${extraCols.map((c) => c.header).join(', ')}`);
}

const empty = {};
for (const c of COLS) {
  if (c.h === 'No' || c.h === 'FDR' || c.h === '요구자' || c.h === '담당자') continue;
  const n = rows.filter((r) => !String(r[c.h] ?? '').trim()).length;
  if (n) empty[c.h] = n;
}
if (Object.keys(empty).length) {
  console.log('  비어 있는 칸:');
  for (const [h, n] of Object.entries(empty)) console.log(`    ${h.padEnd(22)} ${n}건`);
}
