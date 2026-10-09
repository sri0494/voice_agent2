// conversationOrchestrator.js — the central conversation intelligence
// service (spec sections 3, 5, 6, 29, 47). This is the piece that makes
// this a "Conversation Intelligence Platform" rather than a bare
// Speech -> LLM -> Speech loop: every customer utterance is classified
// for relevance BEFORE the LLM is asked to respond, steered against the
// agent's configured objective, grounded in the knowledge base, and
// logged as structured data — not just a transcript line.
import { query } from "../../db/pool.js";
import { classify } from "./relevanceEngine.js";
import { searchRelevantChunks } from "../knowledge/vectorSearch.js";
import { createAIProvider } from "../ai/AIProvider.js";
import { logger } from "../../utils/logger.js";

const aiProvider = createAIProvider();

async function getOrCreateSession(sessionId, callId, agentId) {
  if (sessionId) {
    const { rows } = await query(`SELECT * FROM conversation_sessions WHERE id = $1`, [sessionId]);
    if (rows[0]) return rows[0];
  }
  if (callId) {
    const { rows } = await query(`SELECT * FROM conversation_sessions WHERE call_id = $1`, [callId]);
    if (rows[0]) return rows[0];
  }
  const { rows } = await query(
    `INSERT INTO conversation_sessions (call_id, agent_id) VALUES ($1, $2) RETURNING *`,
    [callId || null, agentId]
  );
  return rows[0];
}

function buildOffTopicResponse(agent, session, briefAnswer) {
  const overLimit = session.off_topic_turn_count >= agent.max_off_topic_turns;
  if (overLimit) {
    return `It looks like we're discussing something outside the purpose of this call. Let's continue — ${agent.primary_objective || "how can I help with your original question?"}`;
  }
  if (agent.off_topic_strategy === "STRICT_KNOWLEDGE_ONLY") {
    return "I don't have that information in my available information. I can help you with the services covered by this agent.";
  }
  if (agent.off_topic_strategy === "BRIEF_ANSWER_THEN_REDIRECT" && briefAnswer) {
    return `${briefAnswer} That said, ${agent.primary_objective ? `I'm here to help with ${agent.primary_objective.toLowerCase()}.` : "let's get back to how I can help you."} What would you like to know?`;
  }
  return "I'm here to help with our services. Could you tell me more about what you need?";
}

// Naive objective-progress heuristic: fraction of the agent's configured
// required_information fields that have been extracted so far in this
// session. Real progress tracking benefits from an LLM judging conversation
// completeness, but this gives an honest, non-fabricated number in mock mode.
function computeObjectiveProgress(agent, extractedData) {
  const required = agent.required_information || [];
  if (required.length === 0) return extractedData && Object.keys(extractedData).length > 0 ? 50 : 10;
  const filledCount = required.filter((key) => extractedData[key] !== undefined && extractedData[key] !== null).length;
  return Math.round((filledCount / required.length) * 100);
}

/**
 * Core orchestration entrypoint — matches the contract in spec section 29:
 * POST /api/conversation/process
 *
 * @param {Object} input
 * @param {string} input.agentId
 * @param {string} [input.callId]
 * @param {string} [input.sessionId] - pass the sessionId returned from a
 *   previous turn to continue the same session when there's no real call
 *   (e.g. the Testing Playground). Without this, every turn without a
 *   callId starts a fresh session and objective progress never accumulates.
 * @param {string} input.customerText
 * @param {Array<{role, content}>} [input.conversationHistory]
 */
export async function processConversationTurn({ agentId, callId, sessionId, customerText, conversationHistory = [] }) {
  const { rows: agentRows } = await query(`SELECT * FROM agents WHERE id = $1`, [agentId]);
  const agent = agentRows[0];
  if (!agent) throw new Error("Agent not found");

  const { rows: kbRows } = await query(
    `SELECT knowledge_base_id FROM agent_knowledge_bases WHERE agent_id = $1`,
    [agentId]
  );
  const knowledgeBaseIds = kbRows.map((r) => r.knowledge_base_id);

  const session = await getOrCreateSession(sessionId, callId, agentId);

  // 1. Knowledge retrieval (needed before classification, since relevance
  //    depends partly on whether the KB actually covers this question).
  const knowledgeMatches = knowledgeBaseIds.length
    ? await searchRelevantChunks(customerText, knowledgeBaseIds, 5)
    : [];

  // 2. Relevance / sentiment / topic / entity classification.
  const analysis = classify({ text: customerText, agent, knowledgeMatches });

  // 3. Steering: decide next_action and whether to redirect off-topic.
  let nextAction = "continue";
  let offTopicTurnCount = session.off_topic_turn_count;
  let responseText;

  if (analysis.relevance === "UNSAFE") {
    nextAction = "transfer";
    responseText = "For your security, I can't help with that over this line. Let me connect you with a team member.";
  } else if (analysis.relevance === "OFF_TOPIC") {
    offTopicTurnCount += 1;
    nextAction = "redirect";

    let briefAnswer = null;
    if (agent.off_topic_strategy === "BRIEF_ANSWER_THEN_REDIRECT" && offTopicTurnCount < agent.max_off_topic_turns) {
      // Attempt a short answer to the off-topic question before redirecting.
      // Honesty note: in mock mode there's no real knowledge for an
      // off-topic question, so this will usually just be the AI provider's
      // generic fallback text rather than a genuinely useful brief answer —
      // this becomes meaningfully better once a real AI_PROVIDER is connected.
      const briefResult = await aiProvider.generateResponse({
        systemPrompt: agent.system_prompt || "",
        context: "",
        temperature: agent.temperature,
        fallbackMessage: null,
        messages: [{ role: "user", content: customerText }],
      });
      briefAnswer = briefResult.usedFallback ? null : briefResult.text;
    }

    responseText = buildOffTopicResponse(agent, { ...session, off_topic_turn_count: offTopicTurnCount }, briefAnswer);
  } else {
    const relevantChunks = knowledgeMatches.filter((c) => c.similarity >= Number(agent.confidence_threshold ?? 0.5));
    const context = relevantChunks.map((c) => c.content).join("\n---\n");

    if (agent.knowledge_only_mode && !context && analysis.relevance !== "SURVEY_RESPONSE" && analysis.relevance !== "FEEDBACK") {
      nextAction = "ask_clarification";
      responseText = agent.fallback_message || "I don't have that information in my available information. I can help you with the services covered by this agent.";
    } else {
      const aiResult = await aiProvider.generateResponse({
        systemPrompt: agent.system_prompt || "",
        context,
        temperature: agent.temperature,
        fallbackMessage: agent.fallback_message,
        messages: [...conversationHistory, { role: "user", content: customerText }],
      });
      responseText = aiResult.text;
      if (analysis.relevance === "SURVEY_RESPONSE") nextAction = "complete_survey";
      else if (Object.keys(analysis.entities).length > 0) nextAction = "collect_information";
    }
  }

  // 4. Merge extracted entities into session state, compute objective progress.
  const extractedData = { ...session.extracted_data, ...analysis.entities };
  const objectiveProgress = computeObjectiveProgress(agent, extractedData);

  await query(
    `UPDATE conversation_sessions SET
      extracted_data = $2, objective_progress = $3, off_topic_turn_count = $4, updated_at = now()
     WHERE id = $1`,
    [session.id, JSON.stringify(extractedData), objectiveProgress, offTopicTurnCount]
  );

  const { rows: countRows } = await query(`SELECT COUNT(*) FROM conversation_events WHERE session_id = $1`, [session.id]);
  const nextSequence = Number(countRows[0].count) + 1;

  await query(
    `INSERT INTO conversation_events (session_id, sequence, speaker, raw_text, relevance, topic, sentiment, entities, confidence, next_action)
     VALUES ($1,$2,'CUSTOMER',$3,$4,$5,$6,$7,$8,$9)`,
    [session.id, nextSequence, customerText, analysis.relevance, analysis.topic, analysis.sentiment,
     JSON.stringify(analysis.entities), analysis.confidence, nextAction]
  );
  await query(
    `INSERT INTO conversation_events (session_id, sequence, speaker, raw_text, next_action)
     VALUES ($1,$2,'AI',$3,$4)`,
    [session.id, nextSequence + 1, responseText, nextAction]
  );

  logger.info("conversation_turn_processed", { agentId, sessionId: session.id, relevance: analysis.relevance, nextAction });

  return {
    sessionId: session.id,
    intent: analysis.relevance === "BUSINESS_RELEVANT" ? "business_enquiry" : analysis.relevance.toLowerCase(),
    relevance: analysis.relevance,
    sentiment: analysis.sentiment,
    entities: analysis.entities,
    knowledge_context: knowledgeMatches.map((c) => ({ documentId: c.document_id, similarity: c.similarity })),
    response: responseText,
    next_action: nextAction,
    objective_progress: objectiveProgress,
    confidence: analysis.confidence,
  };
}
