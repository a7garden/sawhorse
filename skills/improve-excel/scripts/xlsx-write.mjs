// xlsx-write.mjs — 의존성 0 짜리 최소 XLSX 작성기
// xlsx 는 XML 파일들을 담은 zip 이다. node 내장 zlib 만으로 만든다.
import { deflateRawSync } from 'node:zlib';

// ── zip ───────────────────────────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function dosDateTime(d) {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

/** entries: [{ name, data: Buffer|string }] → Buffer (zip) */
export function zip(entries) {
  const { time, date } = dosDateTime(new Date());
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const raw = Buffer.isBuffer(e.data) ? e.data : Buffer.from(e.data, 'utf8');
    const comp = deflateRawSync(raw, { level: 9 });
    const crc = crc32(raw);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(0x0800, 6); // UTF-8 파일명 플래그
    lh.writeUInt16LE(8, 8); // deflate
    lh.writeUInt16LE(time, 10);
    lh.writeUInt16LE(date, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(name.length, 26);
    lh.writeUInt16LE(0, 28);
    locals.push(lh, name, comp);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(0x0800, 8);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(time, 12);
    ch.writeUInt16LE(date, 14);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(0, 30); // extra + comment len
    ch.writeUInt16LE(0, 34); // disk
    ch.writeUInt16LE(0, 36); // internal attrs
    ch.writeUInt32LE(0, 38); // external attrs
    ch.writeUInt32LE(offset, 42);
    centrals.push(ch, name);

    offset += lh.length + name.length + comp.length;
  }

  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...locals, cd, eocd]);
}

// ── 공통 ──────────────────────────────────────────────────────────────────────

export function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // 엑셀이 거부하는 제어문자 제거 (탭·개행은 남긴다)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

export function colName(n) {
  // 0 → A
  let s = '';
  n += 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Date | 'YYYY-MM-DD' → 엑셀 날짜 일련번호 (1899-12-30 기준) */
export function dateSerial(v) {
  if (!v) return null;
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const d = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : new Date(v);
  if (isNaN(d)) return null;
  return Math.round((d.getTime() - Date.UTC(1899, 11, 30)) / 86400000);
}

const PX_PER_EMU = 9525;
export const emu = (px) => Math.round(px * PX_PER_EMU);

/** PNG/JPEG 버퍼에서 픽셀 크기를 읽는다. 못 읽으면 null */
export function imageSize(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) {
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i < buf.length - 9) {
      if (buf[i] !== 0xff) { i++; continue; }
      const marker = buf[i + 1];
      const len = buf.readUInt16BE(i + 2);
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
        return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
      }
      i += 2 + len;
    }
  }
  return null;
}

// ── 스타일 ────────────────────────────────────────────────────────────────────
// 예시 파일(개선수정사항-체크리스트_예시.xlsx)의 서식을 그대로 재현한다.
//   남색 헤더 FF1F4E79 / 흰 굵은 글씨 · 본문 맑은 고딕 10pt · 얇은 회색 테두리 FFB0B0B0
// S.* 가 cellXfs 인덱스다.
export const S = {
  DEFAULT: 0,
  CENTER: 1,      // 본문 가운데
  WRAP: 2,        // 본문 왼쪽 + 줄바꿈
  LEFT: 3,        // 본문 왼쪽
  DATE: 4,        // 날짜 가운데
  HEADER: 5,      // 남색 헤더
  TITLE: 6,       // 제목
  GUIDE: 7,       // 회색 안내문
  LINK: 8,        // 하이퍼링크 (파랑 밑줄) + 줄바꿈
  MANUAL: 9,      // 손으로 채우는 칸 (연노랑 배경)
  H2: 10,         // 시트2 소제목
  CAPTION: 11,    // 시트2 캡션
  CENTER_WRAP: 12,
};

export const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy&quot;-&quot;mm&quot;-&quot;dd"/></numFmts>
<fonts count="7">
<font><sz val="11"/><name val="맑은 고딕"/><family val="2"/><charset val="129"/></font>
<font><sz val="10"/><name val="맑은 고딕"/><family val="2"/><charset val="129"/></font>
<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="맑은 고딕"/><family val="2"/><charset val="129"/></font>
<font><b/><sz val="15"/><name val="맑은 고딕"/><family val="2"/><charset val="129"/></font>
<font><u/><sz val="10"/><color rgb="FF0563C1"/><name val="맑은 고딕"/><family val="2"/><charset val="129"/></font>
<font><b/><sz val="12"/><name val="맑은 고딕"/><family val="2"/><charset val="129"/></font>
<font><sz val="9"/><color rgb="FF808080"/><name val="맑은 고딕"/><family val="2"/><charset val="129"/></font>
</fonts>
<fills count="4">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF1F4E79"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFEF2CB"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left style="thin"><color rgb="FFB0B0B0"/></left><right style="thin"><color rgb="FFB0B0B0"/></right><top style="thin"><color rgb="FFB0B0B0"/></top><bottom style="thin"><color rgb="FFB0B0B0"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="13">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
<xf numFmtId="164" fontId="1" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
<xf numFmtId="0" fontId="6" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
<xf numFmtId="0" fontId="4" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>
<xf numFmtId="0" fontId="1" fillId="3" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>
<xf numFmtId="0" fontId="5" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf>
<xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
</cellXfs>
<cellStyles count="1"><cellStyle name="표준" xfId="0" builtinId="0"/></cellStyles>
<dxfs count="0"/>
</styleSheet>`;

// ── 시트 XML ──────────────────────────────────────────────────────────────────

/**
 * cell: { v, s, t }  t: 's'(문자) | 'n'(숫자) | 'd'(날짜)
 * rows: [[cell|null, ...], ...]
 */
export function sheetXml({ rows, cols = [], merges = [], hyperlinks = [], freeze = 0, autoFilter = null, drawingRel = null, defaultRowHeight = null, rowHeights = {} }) {
  const parts = [];
  parts.push('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>');
  parts.push('<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">');

  const lastRow = rows.length || 1;
  const lastCol = Math.max(1, ...rows.map((r) => r.length));
  parts.push(`<dimension ref="A1:${colName(lastCol - 1)}${lastRow}"/>`);

  parts.push('<sheetViews><sheetView workbookViewId="0">');
  if (freeze > 0) {
    parts.push(`<pane ySplit="${freeze}" topLeftCell="A${freeze + 1}" activePane="bottomLeft" state="frozen"/>`);
    parts.push(`<selection pane="bottomLeft" activeCell="A${freeze + 1}" sqref="A${freeze + 1}"/>`);
  }
  parts.push('</sheetView></sheetViews>');

  parts.push(`<sheetFormatPr defaultRowHeight="${defaultRowHeight ?? 16.5}"/>`);

  if (cols.length) {
    parts.push('<cols>');
    cols.forEach((c, i) => {
      parts.push(`<col min="${i + 1}" max="${i + 1}" width="${c.w}" customWidth="1"${c.hidden ? ' hidden="1"' : ''}/>`);
    });
    parts.push('</cols>');
  }

  parts.push('<sheetData>');
  rows.forEach((row, ri) => {
    const r = ri + 1;
    const ht = rowHeights[r];
    const cells = [];
    row.forEach((cell, ci) => {
      if (cell == null) return;
      const ref = colName(ci) + r;
      const s = cell.s ? ` s="${cell.s}"` : '';
      if (cell.v === '' || cell.v == null) {
        if (cell.s) cells.push(`<c r="${ref}"${s}/>`);
        return;
      }
      if (cell.t === 'n' || cell.t === 'd') {
        cells.push(`<c r="${ref}"${s}><v>${cell.v}</v></c>`);
      } else {
        cells.push(`<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${esc(cell.v)}</t></is></c>`);
      }
    });
    if (!cells.length && !ht) return;
    parts.push(`<row r="${r}"${ht ? ` ht="${ht}" customHeight="1"` : ''}>${cells.join('')}</row>`);
  });
  parts.push('</sheetData>');

  if (autoFilter) parts.push(`<autoFilter ref="${autoFilter}"/>`);
  if (merges.length) {
    parts.push(`<mergeCells count="${merges.length}">`);
    merges.forEach((m) => parts.push(`<mergeCell ref="${m}"/>`));
    parts.push('</mergeCells>');
  }
  if (hyperlinks.length) {
    parts.push('<hyperlinks>');
    hyperlinks.forEach((h) => parts.push(`<hyperlink ref="${h.ref}" location="${esc(h.location)}" display="${esc(h.display || '')}"/>`));
    parts.push('</hyperlinks>');
  }
  parts.push('<pageMargins left="0.25" right="0.25" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>');
  if (drawingRel) parts.push(`<drawing r:id="${drawingRel}"/>`);
  parts.push('</worksheet>');
  return parts.join('');
}

/** images: [{ relId, col, row, wPx, hPx, name }] */
export function drawingXml(images) {
  const anchors = images.map((im, i) => `<xdr:oneCellAnchor>
<xdr:from><xdr:col>${im.col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${im.row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>
<xdr:ext cx="${emu(im.wPx)}" cy="${emu(im.hPx)}"/>
<xdr:pic>
<xdr:nvPicPr><xdr:cNvPr id="${i + 2}" name="${esc(im.name)}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>
<xdr:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="${im.relId}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>
<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${emu(im.wPx)}" cy="${emu(im.hPx)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr>
</xdr:pic>
<xdr:clientData/>
</xdr:oneCellAnchor>`).join('');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">${anchors}</xdr:wsDr>`;
}

/**
 * 워크북 조립.
 * sheets: [{ name, xml, drawing?: { xml, media: [{name, data}] } }]
 */
export function buildWorkbook({ sheets, title = '', creator = 'si-workbench' }) {
  const entries = [];
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');

  const exts = new Set(['png', 'jpeg', 'jpg', 'gif']);
  const defaults = ['<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>'];
  for (const e of exts) defaults.push(`<Default Extension="${e}" ContentType="image/${e === 'jpg' ? 'jpeg' : e}"/>`);

  const overrides = [
    '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
    '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>',
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>',
  ];

  const wbSheets = [];
  const wbRels = [];
  let drawingSeq = 0;

  sheets.forEach((sh, i) => {
    const n = i + 1;
    entries.push({ name: `xl/worksheets/sheet${n}.xml`, data: sh.xml });
    overrides.push(`<Override PartName="/xl/worksheets/sheet${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`);
    wbSheets.push(`<sheet name="${esc(sh.name)}" sheetId="${n}" r:id="rId${n}"/>`);
    wbRels.push(`<Relationship Id="rId${n}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${n}.xml"/>`);

    if (sh.drawing) {
      drawingSeq += 1;
      const d = drawingSeq;
      entries.push({
        name: `xl/worksheets/_rels/sheet${n}.xml.rels`,
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdDr" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${d}.xml"/></Relationships>`,
      });
      entries.push({ name: `xl/drawings/drawing${d}.xml`, data: sh.drawing.xml });
      overrides.push(`<Override PartName="/xl/drawings/drawing${d}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`);
      const rels = sh.drawing.media.map((m, k) => `<Relationship Id="rId${k + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/${m.name}"/>`).join('');
      entries.push({
        name: `xl/drawings/_rels/drawing${d}.xml.rels`,
        data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`,
      });
      sh.drawing.media.forEach((m) => entries.push({ name: `xl/media/${m.name}`, data: m.data }));
    }
  });

  const stylesRelId = `rId${sheets.length + 1}`;
  wbRels.push(`<Relationship Id="${stylesRelId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`);

  entries.unshift({
    name: '[Content_Types].xml',
    data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${defaults.join('')}${overrides.join('')}</Types>`,
  });
  entries.push({
    name: '_rels/.rels',
    data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>`,
  });
  entries.push({
    name: 'xl/workbook.xml',
    data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${wbSheets.join('')}</sheets></workbook>`,
  });
  entries.push({
    name: 'xl/_rels/workbook.xml.rels',
    data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${wbRels.join('')}</Relationships>`,
  });
  entries.push({ name: 'xl/styles.xml', data: STYLES_XML });
  entries.push({
    name: 'docProps/core.xml',
    data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(title)}</dc:title><dc:creator>${esc(creator)}</dc:creator><cp:lastModifiedBy>${esc(creator)}</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`,
  });
  entries.push({
    name: 'docProps/app.xml',
    data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>si-workbench</Application></Properties>`,
  });

  return zip(entries);
}
