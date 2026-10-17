import ExcelJS from 'exceljs';
import PDFDocument from 'pdfkit';
import type { Tally } from './query.js';
import type { Register, StudentExport } from './service.js';

/**
 * Downloads: Excel for working with the numbers, PDF for printing and circulating.
 * Every file says which term, which filter and which minimum it was made with.
 */

export type ExportMeta = {
  institute: string;
  /** e.g. "Computer Engineering › SY · Data Structures" or "All students". */
  scope: string;
  timezone: string;
  generatedAt: Date;
};

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
export const PDF_MIME = 'application/pdf';

// Plain hyphen: the PDF's built-in font has no minus sign.
const RULE = 'Attendance % = present ÷ (classes - excused). Cancelled sessions and sessions still taking attendance are not counted.';

const percentText = (t: Tally) => (t.percentage === null ? '—' : `${t.percentage.toFixed(1)}%`);
const percentValue = (t: Tally | undefined) => (t && t.percentage !== null ? t.percentage / 100 : null);
const counted = (t: Tally) => t.total - t.excused;

function stamp(meta: ExportMeta): string {
  return new Intl.DateTimeFormat('en-IN', { timeZone: meta.timezone, dateStyle: 'medium', timeStyle: 'short' }).format(meta.generatedAt);
}

function sessionLabel(iso: string, timezone: string): string {
  return new Intl.DateTimeFormat('en-IN', { timeZone: timezone, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(
    new Date(iso),
  );
}

/** "19\nOct": a register column header in the PDF. */
function dayLabel(iso: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-IN', { timeZone: timezone, day: '2-digit', month: 'short' }).formatToParts(new Date(iso));
  return `${parts.find((p) => p.type === 'day')?.value}\n${parts.find((p) => p.type === 'month')?.value}`;
}

/** Spreadsheet apps run cells starting with = + - @ as formulas. */
const safe = (s: string) => (/^[=+\-@]/.test(s) ? `'${s}` : s);

const FILL = {
  header: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEDF2FF' } },
  below: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFE3E3' } },
  present: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFD3F9D8' } },
  absent: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFE3E3' } },
  excused: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF3BF' } },
} satisfies Record<string, ExcelJS.Fill>;

function aboutSheet(workbook: ExcelJS.Workbook, lines: [string, string][]) {
  const about = workbook.addWorksheet('About');
  about.getColumn(1).width = 22;
  about.getColumn(2).width = 100;
  for (const [k, v] of lines) about.addRow([k, safe(v)]).getCell(1).font = { bold: true };
}

// ---------------------------------------------------------------------------
// Student list (defaulters)
// ---------------------------------------------------------------------------

export async function studentsWorkbook(data: StudentExport, meta: ExportMeta, belowOnly: boolean): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Attendance');
  const fixed = ['Roll no.', 'Username', 'Name', 'Class', 'Present', 'Absent', 'Excused', 'Classes', 'Attendance %', 'Below minimum'];
  const header = sheet.addRow([...fixed, ...data.subjects.map((s) => `${s.code} %`)]);
  header.font = { bold: true };
  header.eachCell((cell) => {
    cell.fill = FILL.header;
  });
  data.subjects.forEach((s, i) => {
    sheet.getCell(1, fixed.length + i + 1).note = s.name;
  });

  for (const r of data.rows) {
    const subjects = data.bySubject.get(r.student.id);
    const row = sheet.addRow([
      safe(r.student.rollNo ?? ''),
      safe(r.student.username),
      safe(r.student.fullName),
      safe(r.student.unitPath.join(' › ')),
      r.present,
      r.absent,
      r.excused,
      r.total,
      percentValue(r),
      r.below ? 'Yes' : '',
      ...data.subjects.map((s) => percentValue(subjects?.get(s.subjectId))),
    ]);
    if (r.below) row.getCell(9).fill = FILL.below;
    data.subjects.forEach((s, i) => {
      const t = subjects?.get(s.subjectId);
      if (t && t.percentage !== null && t.percentage < data.minimumPercent) row.getCell(fixed.length + i + 1).fill = FILL.below;
    });
  }

  sheet.columns.forEach((col, i) => {
    col.width = [10, 16, 26, 30][i] ?? 12;
    if (i === 8 || i >= fixed.length) col.numFmt = '0.0%';
  });
  sheet.views = [{ state: 'frozen', ySplit: 1, xSplit: 3 }];
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: fixed.length + data.subjects.length } };

  aboutSheet(workbook, [
    ['Institute', meta.institute],
    ['Term', data.term?.name ?? '—'],
    ['Students', meta.scope],
    ['List', belowOnly ? `Only students below ${data.minimumPercent}%` : 'All students'],
    ['Minimum attendance', `${data.minimumPercent}%`],
    ['How it is counted', RULE],
    ['Generated', stamp(meta)],
  ]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

export function studentsPdf(data: StudentExport, meta: ExportMeta, belowOnly: boolean): Promise<Buffer> {
  return pdf({ layout: 'portrait' }, (doc) => {
    heading(doc, belowOnly ? `Students below ${data.minimumPercent}% attendance` : 'Student attendance', [
      `${meta.institute} · ${data.term?.name ?? 'No term'}`,
      `${meta.scope} · ${data.rows.length} student${data.rows.length === 1 ? '' : 's'} · minimum ${data.minimumPercent}%`,
    ]);
    table(doc, {
      columns: [
        { header: '#', width: 28, align: 'right' },
        { header: 'Roll', width: 44 },
        { header: 'Name', width: 150 },
        { header: 'Class', width: 142 },
        { header: 'Present', width: 70, align: 'right' },
        { header: '%', width: 50, align: 'right' },
      ],
      rows: data.rows.map((r, i) => ({
        cells: [
          String(i + 1),
          r.student.rollNo ?? '',
          r.student.fullName,
          r.student.unitPath.join(' › '),
          `${r.present} / ${counted(r)}`,
          percentText(r),
        ],
        highlight: r.below,
      })),
      empty: belowOnly ? 'No student is below the minimum.' : 'No attendance recorded yet.',
    });
    footnote(doc, `${RULE} Generated ${stamp(meta)}.`);
  });
}

// ---------------------------------------------------------------------------
// Register
// ---------------------------------------------------------------------------

const MARK_LETTER = { present: 'P', absent: 'A', excused: 'E' } as const;

export async function registerWorkbook(register: Register, meta: ExportMeta): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('Register');
  const fixed = ['Roll no.', 'Username', 'Name', 'Class'];
  const totals = ['Present', 'Classes', 'Attendance %'];
  const header = sheet.addRow([
    ...fixed,
    ...register.sessions.map((s) => sessionLabel(s.startedAt, meta.timezone) + (s.open ? ' (open)' : '')),
    ...totals,
  ]);
  header.font = { bold: true };
  header.alignment = { wrapText: true, vertical: 'top' };
  header.eachCell((cell) => {
    cell.fill = FILL.header;
  });
  register.sessions.forEach((s, i) => {
    if (s.topic) sheet.getCell(1, fixed.length + i + 1).note = s.topic;
  });

  for (const st of register.students) {
    const row = sheet.addRow([
      safe(st.rollNo ?? ''),
      safe(st.username),
      safe(st.fullName),
      safe(st.unitPath.join(' › ')),
      ...st.marks.map((m) => (m ? MARK_LETTER[m] : '')),
      st.present,
      counted(st),
      percentValue(st),
    ]);
    st.marks.forEach((m, i) => {
      if (m) row.getCell(fixed.length + i + 1).fill = FILL[m];
    });
    if (st.below) row.getCell(fixed.length + register.sessions.length + 3).fill = FILL.below;
  }

  sheet.columns.forEach((col, i) => {
    if (i < fixed.length) col.width = [10, 16, 26, 26][i]!;
    else if (i < fixed.length + register.sessions.length) {
      col.width = 8;
      col.alignment = { horizontal: 'center' };
    } else col.width = 12;
  });
  sheet.getColumn(fixed.length + register.sessions.length + 3).numFmt = '0.0%';
  sheet.views = [{ state: 'frozen', ySplit: 1, xSplit: 3 }];

  aboutSheet(workbook, [
    ['Institute', meta.institute],
    ['Subject', `${register.offering.subject.code} ${register.offering.subject.name}`],
    ['Term', register.offering.term.name],
    ['Taught by', register.offering.faculty.join(', ')],
    ['Marks', 'P = present, A = absent, E = excused, blank = not on that session’s list'],
    ['Minimum attendance', `${register.minimumPercent}%`],
    ['How it is counted', RULE],
    ['Generated', stamp(meta)],
  ]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** Sessions per page across, so the marks stay readable; students repeat on each block. */
const REGISTER_SESSIONS_PER_PAGE = 24;

export function registerPdf(register: Register, meta: ExportMeta): Promise<Buffer> {
  return pdf({ layout: 'landscape' }, (doc) => {
    const title = `${register.offering.subject.code} ${register.offering.subject.name} — attendance register`;
    const sub = [
      `${meta.institute} · ${register.offering.term.name} · ${register.offering.faculty.join(', ')}`,
      `${register.students.length} students · ${register.sessions.length} sessions · minimum ${register.minimumPercent}% · P present, A absent, E excused`,
    ];
    const blocks: number[][] = [];
    for (let i = 0; i < Math.max(register.sessions.length, 1); i += REGISTER_SESSIONS_PER_PAGE) {
      blocks.push(register.sessions.slice(i, i + REGISTER_SESSIONS_PER_PAGE).map((_, j) => i + j));
    }
    blocks.forEach((block, b) => {
      if (b > 0) doc.addPage();
      heading(doc, title, blocks.length > 1 ? [...sub, `Sessions ${block[0]! + 1}–${block.at(-1)! + 1} of ${register.sessions.length}`] : sub);
      table(doc, {
        columns: [
          { header: 'Roll', width: 34 },
          { header: 'Name', width: 120 },
          ...block.map((i) => ({ header: dayLabel(register.sessions[i]!.startedAt, meta.timezone), width: 22, align: 'center' as const })),
          { header: 'Present', width: 50, align: 'right' as const },
          { header: '%', width: 42, align: 'right' as const },
        ],
        headerHeight: 30,
        fontSize: 7.5,
        rows: register.students.map((st) => ({
          cells: [
            st.rollNo ?? '',
            st.fullName,
            ...block.map((i) => {
              const m = st.marks[i];
              return m ? MARK_LETTER[m] : '';
            }),
            `${st.present} / ${counted(st)}`,
            percentText(st),
          ],
          highlight: st.below,
        })),
        empty: 'No sessions yet.',
      });
    });
    footnote(doc, `${RULE} Generated ${stamp(meta)}.`);
  });
}

// ---------------------------------------------------------------------------
// PDF helpers
// ---------------------------------------------------------------------------

type Doc = PDFKit.PDFDocument;
const MARGIN = 36;
const COLORS = { text: '#1a1b1e', dim: '#5c6370', line: '#d0d5e0', headerBg: '#edf2ff', highlight: '#fff0f0', highlightText: '#c92a2a' };

function pdf(options: { layout: 'portrait' | 'landscape' }, draw: (doc: Doc) => void): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', layout: options.layout, margin: MARGIN, bufferPages: true, info: { Title: 'Attendance report' } });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  draw(doc);
  const pages = doc.bufferedPageRange();
  for (let i = 0; i < pages.count; i++) {
    doc.switchToPage(pages.start + i);
    // The footer sits in the bottom margin; without this PDFKit would start a new page for it.
    doc.page.margins.bottom = 0;
    doc
      .fontSize(7)
      .fillColor(COLORS.dim)
      .text(`Page ${i + 1} of ${pages.count}`, MARGIN, doc.page.height - MARGIN + 10, {
        width: doc.page.width - 2 * MARGIN,
        align: 'right',
        lineBreak: false,
      });
  }
  doc.end();
  return done;
}

function heading(doc: Doc, title: string, lines: string[]) {
  doc.fontSize(14).fillColor(COLORS.text).font('Helvetica-Bold').text(title, MARGIN, MARGIN);
  doc.font('Helvetica').fontSize(9).fillColor(COLORS.dim);
  for (const line of lines) doc.text(line);
  doc.moveDown(0.6);
}

function footnote(doc: Doc, text: string) {
  const width = doc.page.width - 2 * MARGIN;
  if (doc.y + 30 > doc.page.height - MARGIN) doc.addPage();
  doc.moveDown(0.8).font('Helvetica').fontSize(7.5).fillColor(COLORS.dim).text(text, MARGIN, doc.y, { width });
}

type Column = { header: string; width: number; align?: 'left' | 'right' | 'center' };

/** A table that continues across pages, repeating its header. Highlighted rows are below the minimum. */
function table(
  doc: Doc,
  opts: {
    columns: Column[];
    rows: { cells: string[]; highlight?: boolean }[];
    empty: string;
    fontSize?: number;
    headerHeight?: number;
  },
) {
  const fontSize = opts.fontSize ?? 8.5;
  const rowHeight = fontSize + 7;
  const headerHeight = opts.headerHeight ?? rowHeight + 2;
  const tableWidth = opts.columns.reduce((w, c) => w + c.width, 0);
  const bottom = () => doc.page.height - MARGIN - 14;

  const drawRow = (cells: string[], y: number, height: number, style: { bold?: boolean; fill?: string; color?: string }) => {
    if (style.fill) doc.rect(MARGIN, y, tableWidth, height).fill(style.fill);
    doc.font(style.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(fontSize).fillColor(style.color ?? COLORS.text);
    let x = MARGIN;
    opts.columns.forEach((col, i) => {
      doc.text(cells[i] ?? '', x + 3, y + 3.5, {
        width: col.width - 6,
        height: height - 4,
        align: col.align ?? 'left',
        lineBreak: style.bold,
        ellipsis: !style.bold,
      });
      x += col.width;
    });
    doc
      .moveTo(MARGIN, y + height)
      .lineTo(MARGIN + tableWidth, y + height)
      .lineWidth(0.5)
      .strokeColor(COLORS.line)
      .stroke();
  };
  const header = () => {
    const y = doc.y;
    drawRow(
      opts.columns.map((c) => c.header),
      y,
      headerHeight,
      { bold: true, fill: COLORS.headerBg },
    );
    doc.y = y + headerHeight;
  };

  header();
  if (opts.rows.length === 0) {
    doc.font('Helvetica').fontSize(fontSize).fillColor(COLORS.dim).text(opts.empty, MARGIN + 3, doc.y + 6);
    return;
  }
  for (const row of opts.rows) {
    if (doc.y + rowHeight > bottom()) {
      doc.addPage();
      doc.y = MARGIN;
      header();
    }
    const y = doc.y;
    drawRow(row.cells, y, rowHeight, row.highlight ? { fill: COLORS.highlight, color: COLORS.highlightText } : {});
    doc.y = y + rowHeight;
  }
  doc.x = MARGIN;
}
