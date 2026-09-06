// xlsx-read.mjs — 의존성 0 짜리 최소 XLSX 읽기
// 기존 체크리스트 엑셀에서 "볼트에 없는 열"(요구자·담당자 등 손으로 채운 값)을
// FDR ID 로 찾아 되살리기 위한 용도. 서식은 읽지 않는다.
import { inflateRawSync } from 'node:zlib';

/** zip 버퍼 → { 파일명: Buffer } */
export function unzip(buf) {
  // 중앙 디렉터리(EOCD)부터 읽는다. 로컬 헤더의 크기 필드는 비어 있을 수 있다.
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 22 - 65536; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip 이 아닙니다 (EOCD 없음)');

  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = {};

  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen = buf.readUInt16LE(p + 32);
    const lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);

    const lNameLen = buf.readUInt16LE(lho + 26);
    const lExtraLen = buf.readUInt16LE(lho + 28);
    const dataStart = lho + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(dataStart, dataStart + csize);
    out[name] = method === 0 ? Buffer.from(raw) : inflateRawSync(raw);

    p += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}

function unesc(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

function parseSharedStrings(xml) {
  if (!xml) return [];
  const out = [];
  for (const m of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    let t = '';
    for (const tm of m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) t += tm[1];
    out.push(unesc(t));
  }
  return out;
}

function refToCol(ref) {
  const m = ref.match(/^([A-Z]+)/);
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * 워크시트 → 2차원 배열(문자열). 날짜는 일련번호 문자열 그대로 나온다.
 */
export function sheetToRows(xml, shared) {
  const rows = [];
  for (const rm of xml.matchAll(/<row[^>]*\sr="(\d+)"[^>]*>([\s\S]*?)<\/row>/g)) {
    const r = +rm[1] - 1;
    const row = rows[r] || (rows[r] = []);
    for (const cm of rm[2].matchAll(/<c\s+r="([A-Z]+\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[2] || '';
      const inner = cm[3] || '';
      const t = (attrs.match(/\st="([^"]*)"/) || [])[1];
      let v;
      if (t === 'inlineStr') {
        v = [...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((a) => unesc(a[1])).join('');
      } else {
        const vm = inner.match(/<v>([\s\S]*?)<\/v>/);
        if (!vm) continue;
        v = t === 's' ? (shared[+vm[1]] ?? '') : unesc(vm[1]);
      }
      row[refToCol(cm[1])] = v;
    }
  }
  for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];
  return rows;
}

/** xlsx 버퍼 → [{ name, rows }] */
export function readWorkbook(buf) {
  const files = unzip(buf);
  const shared = parseSharedStrings(files['xl/sharedStrings.xml']?.toString('utf8'));
  const wb = files['xl/workbook.xml'].toString('utf8');
  const rels = files['xl/_rels/workbook.xml.rels'].toString('utf8');

  const relMap = {};
  for (const m of rels.matchAll(/<Relationship[^>]*Id="([^"]*)"[^>]*Target="([^"]*)"/g)) relMap[m[1]] = m[2];

  const sheets = [];
  for (const m of wb.matchAll(/<sheet[^>]*\/>/g)) {
    const name = unesc((m[0].match(/name="([^"]*)"/) || [])[1] || '');
    const rid = (m[0].match(/r:id="([^"]*)"/) || [])[1];
    let target = relMap[rid] || '';
    if (!target) continue;
    if (!target.startsWith('xl/')) target = 'xl/' + target.replace(/^\/?/, '');
    const f = files[target] || files[target.replace('xl/', '')];
    if (!f) continue;
    sheets.push({ name, rows: sheetToRows(f.toString('utf8'), shared) });
  }
  return sheets;
}
