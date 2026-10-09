// documentParser.js — extracts raw text from uploaded documents by file type.
import fs from "fs/promises";
import path from "path";

async function parsePDF(filePath) {
  const pdfParse = (await import("pdf-parse")).default;
  const buffer = await fs.readFile(filePath);
  const data = await pdfParse(buffer);
  return data.text;
}

async function parseDOCX(filePath) {
  const mammoth = await import("mammoth");
  const { value } = await mammoth.extractRawText({ path: filePath });
  return value;
}

async function parseTXTorMD(filePath) {
  return fs.readFile(filePath, "utf-8");
}

async function parseCSV(filePath) {
  const { parse } = await import("csv-parse/sync");
  const raw = await fs.readFile(filePath, "utf-8");
  const records = parse(raw, { columns: true, skip_empty_lines: true });
  // Flatten rows into readable text so it can be chunked/embedded like any other document.
  return records.map((row) => Object.entries(row).map(([k, v]) => `${k}: ${v}`).join(", ")).join("\n");
}

export async function parseDocument(filePath, fileType) {
  const type = (fileType || path.extname(filePath).replace(".", "")).toUpperCase();
  switch (type) {
    case "PDF":
      return parsePDF(filePath);
    case "DOCX":
      return parseDOCX(filePath);
    case "CSV":
      return parseCSV(filePath);
    case "TXT":
    case "MD":
      return parseTXTorMD(filePath);
    default:
      throw new Error(`Unsupported document type: ${type}`);
  }
}
