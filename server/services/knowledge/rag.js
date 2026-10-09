// rag.js — Retrieval-Augmented Generation orchestration.
// Customer question -> embed -> search knowledge_chunks -> build context -> LLM -> answer.
// The AI must prefer the knowledge base over general knowledge, and must never
// hallucinate government rules, prices, or policy details it cannot ground in a chunk.
import { searchRelevantChunks } from "./vectorSearch.js";
import { createAIProvider } from "../ai/AIProvider.js";

const aiProvider = createAIProvider();
const SIMILARITY_THRESHOLD = 0.15; // below this, treat as "no relevant context found"

export async function answerWithRAG({ question, knowledgeBaseIds, agent, conversationHistory = [] }) {
  const chunks = await searchRelevantChunks(question, knowledgeBaseIds, 5);
  const relevant = chunks.filter((c) => c.similarity >= SIMILARITY_THRESHOLD);

  const context = relevant.map((c) => c.content).join("\n---\n");

  const { text, usedFallback } = await aiProvider.generateResponse({
    systemPrompt: agent?.system_prompt || "",
    context,
    temperature: agent?.temperature ?? 0.3,
    fallbackMessage: agent?.fallback_message,
    messages: [...conversationHistory, { role: "user", content: question }],
  });

  return {
    answer: text,
    usedFallback,
    sources: relevant.map((c) => ({ documentId: c.document_id, similarity: Number(c.similarity.toFixed(3)) })),
  };
}
