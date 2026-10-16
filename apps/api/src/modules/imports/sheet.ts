import { parse as parseCsv } from 'csv-parse/sync';
import ExcelJS from 'exceljs';
import { badRequest } from '../../lib/errors.js';

export const MAX_IMPORT_ROWS = 20_000;

export type SheetRow = {
  /** 1-based row number as the user sees it in Excel (header is row 1). */
  rowNumber: number;
  /** Cell text by normalised header. */
  cells: Map<string, string>;
};

export type Sheet = { headers: string[]; rows: SheetRow[] };

/** "Roll No." → "roll_no", "Full Name" → "full_name", "E-mail" → "e_mail". */
export function normalizeHeader(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    if ('richText' in value) return value.richText.map((r) => r.text).join('');
    if ('formula' in value || 'sharedFormula' in value) return cellText((value as ExcelJS.CellFormulaValue).result as ExcelJS.CellValue);
    if ('text' in value) return typeof value.text === 'string' ? value.text : cellText(value.text as ExcelJS.CellValue);
    if ('error' in value) return '';
  }
  return String(value);
}

function toSheet(table: string[][]): Sheet {
  const [headerRow, ...body] = table;
  if (!headerRow || headerRow.every((h) => !h.trim())) throw badRequest('EMPTY_FILE', 'The file has no header row');

  const headers = headerRow.map(normalizeHeader);
  const seen = new Set<string>();
  for (const [i, h] of headers.entries()) {
    if (!h) continue;
    if (seen.has(h)) throw badRequest('DUPLICATE_COLUMN', `Column "${headerRow[i]!.trim()}" appears more than once`);
    seen.add(h);
  }

  const rows: SheetRow[] = [];
  for (const [i, raw] of body.entries()) {
    if (raw.every((c) => !c?.trim())) continue;
    const cells = new Map<string, string>();
    headers.forEach((h, col) => {
      if (h) cells.set(h, (raw[col] ?? '').trim());
    });
    rows.push({ rowNumber: i + 2, cells });
  }
  if (rows.length > MAX_IMPORT_ROWS) {
    throw badRequest('TOO_MANY_ROWS', `At most ${MAX_IMPORT_ROWS} rows per file; split the file and import in parts`);
  }
  return { headers: headers.filter(Boolean), rows };
}

/** Reads the first worksheet of an .xlsx file, or a UTF-8 .csv file. */
export async function parseSpreadsheet(buffer: Buffer): Promise<Sheet> {
  const isZip = buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
  const isOle = buffer.subarray(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]));
  if (isOle) throw badRequest('UNSUPPORTED_FILE', 'Old .xls files are not supported; save as .xlsx or .csv');

  if (!isZip) {
    let table: string[][];
    try {
      table = parseCsv(buffer, { bom: true, relax_column_count: true, skip_empty_lines: true });
    } catch (err) {
      throw badRequest('INVALID_CSV', `Could not read the CSV file: ${(err as Error).message}`);
    }
    return toSheet(table);
  }

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    throw badRequest('INVALID_XLSX', 'Could not read the Excel file');
  }
  const sheet = workbook.worksheets[0];
  if (!sheet) throw badRequest('EMPTY_FILE', 'The workbook has no sheets');

  const width = sheet.columnCount;
  const table: string[][] = [];
  for (let r = 1; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const cells: string[] = [];
    for (let c = 1; c <= width; c++) cells.push(cellText(row.getCell(c).value));
    table.push(cells);
  }
  return toSheet(table);
}

/** An .xlsx with the given column headers, plus an "Instructions" sheet. */
export async function buildTemplate(columns: string[], instructions: string[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const data = workbook.addWorksheet('Data');
  data.addRow(columns).font = { bold: true };
  data.columns.forEach((col) => {
    col.width = 20;
  });
  data.views = [{ state: 'frozen', ySplit: 1 }];

  const help = workbook.addWorksheet('Instructions');
  help.getColumn(1).width = 120;
  for (const line of instructions) help.addRow([line]);

  return Buffer.from(await workbook.xlsx.writeBuffer());
}
