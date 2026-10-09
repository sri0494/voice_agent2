// relevanceEngine.js — Conversation Relevance Engine (spec section 4).
//
// IMPORTANT HONESTY NOTE: this is a rule-based / keyword heuristic
// classifier, not a real NLU model. It exists so the full conversation
// pipeline (relevance -> steering -> RAG -> response) is wired end-to-end
// and testable without any paid AI provider. Classification quality here
// is intentionally basic. Once a real AI_PROVIDER with tool-use/structured
// output is connected (see server/services/ai/AIProvider.js), replace
// classify() with a real LLM call that returns the same shape — every
// caller (conversationOrchestrator.js) is written against this return
// shape, so no other file needs to change.

const OFF_TOPIC_KEYWORDS = ["weather", "cricket", "movie", "politics", "joke", "song", "recipe", "football", "election"];
const UNSAFE_KEYWORDS = ["otp", "pin", "cvv", "password", "upi pin", "atm pin", "bank login"];
const FEEDBACK_KEYWORDS = ["good", "bad", "satisfied", "unsatisfied", "happy", "unhappy", "complaint", "polite", "rude", "excellent", "poor", "waiting", "delay"];
const CLARIFICATION_KEYWORDS = ["what do you mean", "can you repeat", "didn't understand", "again please", "explain"];

const POSITIVE_WORDS = ["good", "great", "excellent", "happy", "satisfied", "polite", "thank", "nice", "love", "perfect"];
const NEGATIVE_WORDS = ["bad", "poor", "unhappy", "unsatisfied", "rude", "angry", "complaint", "delay", "waiting", "worst", "disappointed"];

// Word-boundary match — NOT plain .includes(). Short keywords like "pin" or
// "otp" as a bare substring match would false-positive on ordinary words
// (e.g. "pin" inside "shopping" or "opinion"), which is exactly the wrong
// failure mode for a check whose purpose is protecting OTP/PIN/CVV safety.
// Multi-word phrases (e.g. "atm pin") are checked as a literal substring,
// which is safe since a false-positive there would require the exact
// adjacent word pair to appear coincidentally.
function matchesAny(lowerText, keywords) {
  return keywords.some((k) =>
    k.includes(" ") ? lowerText.includes(k) : new RegExp(`\\b${k}\\b`, "i").test(lowerText)
  );
}

function scoreSentiment(text) {
  const lower = text.toLowerCase();
  const positiveHits = POSITIVE_WORDS.filter((w) => matchesAny(lower, [w])).length;
  const negativeHits = NEGATIVE_WORDS.filter((w) => matchesAny(lower, [w])).length;
  if (positiveHits > 0 && negativeHits > 0) return "Mixed";
  if (positiveHits > negativeHits) return "Positive";
  if (negativeHits > positiveHits) return "Negative";
  return "Neutral";
}

// Extracts simple numeric entities (amounts) and, more loosely, short free-text
// entities by naive keyword proximity. Real, general entity extraction needs
// an LLM — this only reliably covers the common "budget is 30000" style
// utterance for number fields. Text-type fields (e.g. "product", "customer_name")
// are NOT extracted here; that needs real NLP/LLM and is intentionally left
// for when a real AI_PROVIDER is connected, rather than faking it with a
// heuristic that would misfire constantly.
function extractEntities(text, extractionFields = []) {
  const entities = {};
  const numberMatch = text.match(/(\d{3,7})/);
  const budgetFieldNames = ["budget", "amount", "price"];

  for (const field of extractionFields) {
    const key = field.key || field.label?.toLowerCase().replace(/\s+/g, "_");
    if (!key) continue;
    if (field.type === "number" && numberMatch && budgetFieldNames.some((b) => key.includes(b))) {
      entities[key] = Number(numberMatch[1]);
    }
  }
  return entities;
}

/**
 * @param {Object} opts
 * @param {string} opts.text - the customer's utterance (already transcribed)
 * @param {Object} opts.agent - the agent row (includes allowed_topics, restricted_topics, extraction_fields)
 * @param {Array} opts.knowledgeMatches - chunks retrieved from vectorSearch for this utterance
 * @returns {{ relevance, sentiment, topic, entities, confidence }}
 */
export function classify({ text, agent, knowledgeMatches = [] }) {
  const lower = text.toLowerCase();

  let relevance = "UNKNOWN";
  let confidence = 0.4;

  if (matchesAny(lower, UNSAFE_KEYWORDS)) {
    relevance = "UNSAFE";
    confidence = 0.95;
  } else if (CLARIFICATION_KEYWORDS.some((k) => lower.includes(k))) {
    relevance = "CLARIFICATION";
    confidence = 0.7;
  } else if (matchesAny(lower, OFF_TOPIC_KEYWORDS)) {
    relevance = "OFF_TOPIC";
    confidence = 0.75;
  } else if (matchesAny(lower, FEEDBACK_KEYWORDS)) {
    relevance = (agent?.agent_type || "").toLowerCase().includes("survey") ? "SURVEY_RESPONSE" : "FEEDBACK";
    confidence = 0.65;
  } else if (knowledgeMatches.length > 0 && knowledgeMatches[0].similarity >= Number(agent?.confidence_threshold ?? 0.5)) {
    relevance = "BUSINESS_RELEVANT";
    confidence = Math.min(0.95, knowledgeMatches[0].similarity + 0.2);
  } else if (knowledgeMatches.length > 0) {
    relevance = "PARTIALLY_RELEVANT";
    confidence = 0.5;
  } else if (/\?|enti|cheppandi|price|cost|available/i.test(lower)) {
    relevance = "INFORMATION_REQUEST";
    confidence = 0.55;
  }

  return {
    relevance,
    sentiment: scoreSentiment(text),
    topic: knowledgeMatches[0]?.content?.slice(0, 60) || null,
    entities: extractEntities(text, agent?.extraction_fields || []),
    confidence: Number(confidence.toFixed(3)),
  };
}
