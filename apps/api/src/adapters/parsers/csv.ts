/**
 * RFC 4180 CSV parsing (quoted fields, escaped quotes, CRLF or LF line ends). Returns rows keyed by the
 * header row's column names.
 */

export class CsvError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(`${message} (line ${line})`);
    this.name = 'CsvError';
  }
}

/** Parse into arrays of cells. */
export function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let line = 1;
  let i = 0;
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  while (i < src.length) {
    const c = src.charAt(i);
    if (quoted) {
      if (c === '"') {
        if (src.charAt(i + 1) === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
      } else {
        if (c === '\n') line += 1;
        cell += c;
      }
      i += 1;
      continue;
    }
    if (c === '"') {
      if (cell !== '') throw new CsvError('quote inside an unquoted field', line);
      quoted = true;
    } else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src.charAt(i + 1) === '\n') i += 1;
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      line += 1;
    } else {
      cell += c;
    }
    i += 1;
  }
  if (quoted) throw new CsvError('unterminated quoted field', line);
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r.at(0) === ''));
}

export interface CsvTable {
  header: string[];
  /** Each record maps column name → cell. */
  records: Map<string, string>[];
}

export function parseCsv(text: string): CsvTable {
  const [header, ...body] = parseCsvRows(text);
  if (!header) return { header: [], records: [] };
  const names = header.map((h) => h.trim());
  if (new Set(names).size !== names.length) throw new CsvError('duplicate column names in header', 1);
  const records = body.map((cells, idx) => {
    if (cells.length !== names.length) {
      throw new CsvError(`expected ${names.length} fields, found ${cells.length}`, idx + 2);
    }
    return new Map(names.map((n, j) => [n, cells.at(j) ?? '']));
  });
  return { header: names, records };
}
