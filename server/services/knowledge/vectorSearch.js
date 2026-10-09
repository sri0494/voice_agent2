// vectorSearch.js — semantic search over knowledge_chunks using pgvector cosine distance.
import { query } from "../../db/pool.js";
import { createEmbeddingProvider, toSqlVector } from "./embeddings.js";

const embeddingProvider = createEmbeddingProvider();

/**
 * @param {string} questionText
 * @param {string[]} knowledgeBaseIds
 * @param {number} topK
 */
export async function searchRelevantChunks(questionText, knowledgeBaseIds, topK = 5) {
  if (!knowledgeBaseIds || knowledgeBaseIds.length === 0) return [];

  const queryEmbedding = await embeddingProvider.embed(questionText);
  const vectorLiteral = toSqlVector(queryEmbedding);

  const { rows } = await query(
    `SELECT id, document_id, content, 1 - (embedding <=> $1::vector) AS similarity
     FROM knowledge_chunks
     WHERE knowledge_base_id = ANY($2::uuid[])
     ORDER BY embedding <=> $1::vector
     LIMIT $3`,
    [vectorLiteral, knowledgeBaseIds, topK]
  );
  return rows;
}

/** The ONLY knowledge bases an agent may retrieve from: the ones explicitly linked to it. */
export async function getAuthorizedKnowledgeBaseIds(agentId) {
  const { rows } = await query(
    `SELECT akb.knowledge_base_id FROM agent_knowledge_bases akb
     JOIN knowledge_bases kb ON kb.id = akb.knowledge_base_id WHERE akb.agent_id = $1`, [agentId]);
  return rows.map((r) => r.knowledge_base_id);
}

/** Retrieval scoped by the server to the agent's own knowledge bases (callers cannot widen it). */
export async function searchForAgent(agentId, questionText, topK = 5) {
  return searchRelevantChunks(questionText, await getAuthorizedKnowledgeBaseIds(agentId), topK);
}
