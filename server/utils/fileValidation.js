// Upload safety helpers: filename sanitising and content ("magic byte") validation.
// A browser-supplied MIME type or extension alone is never trusted.
import fs from "node:fs";
import path from "node:path";

export function sanitizeFilename(name) {
  const base = path.basename(String(name || "").replace(/\\/g, "/"));          // drops any directory part, incl. ..\..\
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").replace(/[^\w.\- ()]+/g, "_").replace(/\.{2,}/g, ".").replace(/^\.+/, "");
  return (cleaned || "file").slice(0, 120);
}

export function hasTraversal(name) { return /(^|[\\/])\.\.([\\/]|$)/.test(String(name || "")) || /[\u0000]/.test(String(name || "")); }

function isTextBuffer(buf) {
  if (buf.includes(0)) return false;
  try { new TextDecoder("utf-8", { fatal: true }).decode(buf); return true; } catch { return false; }
}

const startsWith = (buf, bytes, at = 0) => bytes.every((b, i) => buf[at + i] === b);

/** Document uploads: returns the detected type ("PDF","DOCX","TXT","CSV","MD") or null if content does not match the extension. */
export function validateDocumentContent(head, ext) {
  switch (ext) {
    case ".pdf": return startsWith(head, [0x25, 0x50, 0x44, 0x46, 0x2d]) ? "PDF" : null;            // %PDF-
    case ".docx": return startsWith(head, [0x50, 0x4b, 0x03, 0x04]) ? "DOCX" : null;               // PK.. (zip)
    case ".txt": return isTextBuffer(head) ? "TXT" : null;
    case ".csv": return isTextBuffer(head) ? "CSV" : null;
    case ".md": return isTextBuffer(head) ? "MD" : null;
    default: return null;
  }
}

export function readHead(filePath, bytes = 65536) {
  const fd = fs.openSync(filePath, "r");
  try { const buf = Buffer.alloc(bytes); const n = fs.readSync(fd, buf, 0, bytes, 0); return buf.subarray(0, n); }
  finally { fs.closeSync(fd); }
}

/** Audio uploads: does the content look like the claimed container? */
export function validateAudioContent(buf, type) {
  switch (type) {
    case "audio/webm": return startsWith(buf, [0x1a, 0x45, 0xdf, 0xa3]);
    case "audio/ogg": return startsWith(buf, [0x4f, 0x67, 0x67, 0x53]);
    case "audio/wav": case "audio/x-wav": case "audio/wave":
      return startsWith(buf, [0x52, 0x49, 0x46, 0x46]) && startsWith(buf, [0x57, 0x41, 0x56, 0x45], 8);
    case "audio/mpeg": case "audio/mp3":
      return startsWith(buf, [0x49, 0x44, 0x33]) || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0);
    case "audio/mp4": case "audio/x-m4a": return startsWith(buf, [0x66, 0x74, 0x79, 0x70], 4);   // ....ftyp
    case "audio/aac": return buf[0] === 0xff && (buf[1] & 0xf0) === 0xf0;
    default: return false;
  }
}

/** Csv upload sanity (extension AND content). */
export const looksLikeCsv = (head, filename) => /\.csv$/i.test(filename || "") && isTextBuffer(head);
