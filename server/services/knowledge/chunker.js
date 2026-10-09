// chunker.js — splits cleaned text into overlapping chunks for embedding.
export function cleanText(text) {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * @param {string} text
 * @param {{ chunkSize?: number, overlap?: number }} opts
 * @returns {string[]}
 */
export function chunkText(text, { chunkSize = 1000, overlap = 150 } = {}) {
  const cleaned = cleanText(text);
  if (!cleaned) return [];

  const chunks = [];
  let start = 0;
  while (start < cleaned.length) {
    const end = Math.min(start + chunkSize, cleaned.length);
    chunks.push(cleaned.slice(start, end).trim());
    if (end === cleaned.length) break;
    start = end - overlap;
  }
  return chunks.filter((c) => c.length > 20); // drop trivial fragments
}
