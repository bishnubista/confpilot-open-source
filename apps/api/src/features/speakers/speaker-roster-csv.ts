import type { RawSpeakerRosterRow } from "./speaker-roster-ingest-service";

const EXPECTED_HEADERS = ["name", "email", "title", "company", "bio"] as const;
const HEADER_SET = new Set<string>(EXPECTED_HEADERS);

interface CsvRecord {
  rowNumber: number;
  cells: string[];
  error?: string;
}

function records(csv: string): CsvRecord[] {
  const result: CsvRecord[] = [];
  let cells: string[] = [];
  let field = "";
  let rowNumber = 1;
  let recordStart = 1;
  let inQuotes = false;
  let afterQuote = false;
  let error = "";

  const finish = () => {
    cells.push(field);
    result.push({ rowNumber: recordStart, cells, ...(error ? { error } : {}) });
    cells = [];
    field = "";
    afterQuote = false;
    error = "";
    recordStart = rowNumber + 1;
  };

  for (let index = 0; index < csv.length; index += 1) {
    const character = csv[index]!;
    if (inQuotes) {
      if (character === '"') {
        if (csv[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
          afterQuote = true;
        }
      } else {
        field += character;
        if (character === "\n") rowNumber += 1;
      }
      continue;
    }
    if (afterQuote && character !== "," && character !== "\r" && character !== "\n") {
      error ||= "Unexpected text follows a quoted CSV field.";
    }
    if (character === '"' && field.length === 0 && !afterQuote) {
      inQuotes = true;
    } else if (character === ",") {
      cells.push(field);
      field = "";
      afterQuote = false;
    } else if (character === "\n") {
      finish();
      rowNumber += 1;
    } else if (character !== "\r") {
      field += character;
    }
  }
  if (inQuotes) error ||= "Quoted CSV field is not terminated.";
  if (field.length > 0 || cells.length > 0 || error) finish();
  return result;
}

export function parseSpeakerRosterCsv(csv: string): RawSpeakerRosterRow[] {
  const parsed = records(csv.replace(/^\uFEFF/, ""));
  const header = parsed.shift();
  if (!header || header.error) {
    return [{ rowNumber: header?.rowNumber ?? 1, value: {}, parseError: header?.error ?? "CSV header row is required." }];
  }
  const headers = header.cells.map((cell) => cell.trim().toLowerCase());
  const invalidHeader = headers.some((value) => !HEADER_SET.has(value))
    || new Set(headers).size !== headers.length
    || !headers.includes("name")
    || !headers.includes("email");
  if (invalidHeader) {
    return [{
      rowNumber: header.rowNumber,
      value: {},
      parseError: "CSV headers must be unique and use name,email,title,company,bio; name and email are required.",
    }];
  }
  const dataRows = parsed.filter((record) => record.cells.some((cell) => cell.trim() !== "") || record.error);
  if (dataRows.length > 500) {
    return [{ rowNumber: 1, value: {}, parseError: "CSV imports are limited to 500 data rows." }];
  }
  return dataRows.map((record) => {
    if (record.error || record.cells.length !== headers.length) {
      return {
        rowNumber: record.rowNumber,
        value: {},
        parseError: record.error ?? `Expected ${headers.length} columns but found ${record.cells.length}.`,
      };
    }
    return {
      rowNumber: record.rowNumber,
      value: Object.fromEntries(headers.map((headerName, index) => [headerName, record.cells[index] ?? ""])),
    };
  });
}
