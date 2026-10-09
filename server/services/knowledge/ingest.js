// ingest.js — Document Upload -> Text Extraction -> Cleaning -> Chunking ->
// Embedding Generation -> Vector Storage. Runs asynchronously so the upload
// request returns immediately with status PENDING/PROCESSING.
import { query } from "../../db/pool.js";
import { parseDocument } from "./documentParser.js";
import { chunkText } from "./chunker.js";
import { createEmbeddingProvider, toSqlVector } from "./embeddings.js";
import { logger } from "../../utils/logger.js";

const embeddingProvider = createEmbeddingProvider();

export async function processDocument(documentId) {
  const { rows } = await query(`SELECT * FROM knowledge_documents WHERE id = $1`, [documentId]);
  const doc = rows[0];
  if (!doc) return;

  try {
    await query(`UPDATE knowledge_documents SET status = 'PROCESSING', updated_at = now() WHERE id = $1`, [documentId]);

    const rawText = doc.source_type === "FILE"
      ? await parseDocument(doc.file_path, doc.file_type)
      : doc.raw_text || "";

    const chunks = chunkText(rawText, { chunkSize: 1000, overlap: 150 });

    await query(`DELETE FROM knowledge_chunks WHERE document_id = $1`, [documentId]);

    let index = 0;
    for (const chunk of chunks) {
      const embedding = await embeddingProvider.embed(chunk);
      await query(
        `INSERT INTO knowledge_chunks (document_id, knowledge_base_id, chunk_index, content, embedding)
         VALUES ($1, $2, $3, $4, $5::vector)`,
        [documentId, doc.knowledge_base_id, index, chunk, toSqlVector(embedding)]
      );
      index++;
    }

    await query(
      `UPDATE knowledge_documents SET status = 'READY', chunk_count = $2, updated_at = now() WHERE id = $1`,
      [documentId, chunks.length]
    );
    logger.info("document_processed", { documentId, chunkCount: chunks.length });
  } catch (err) {
    logger.error("document_processing_failed", { documentId, error: err.message });
    await query(
      `UPDATE knowledge_documents SET status = 'FAILED', error_message = $2, updated_at = now() WHERE id = $1`,
      [documentId, err.message]
    );
  }
}

export async function reindexDocument(documentId) {
  return processDocument(documentId);
}
