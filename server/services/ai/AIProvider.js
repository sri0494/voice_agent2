// AIProvider — abstract interface every LLM backend must implement.
// Swap providers purely through env vars (AI_PROVIDER=...); no other code should change.
export class AIProvider {
  /**
   * @param {Object} opts
   * @param {string} opts.systemPrompt
   * @param {Array<{role:'user'|'assistant', content:string}>} opts.messages
   * @param {string} [opts.context] - RAG context injected from the knowledge base
   * @param {number} [opts.temperature]
   * @returns {Promise<{ text: string, usedFallback: boolean }>}
   */
  async generateResponse(_opts) {
    throw new Error("generateResponse() not implemented");
  }
}

// Development/mock implementation — deterministic, no external calls, no API key needed.
// This lets the whole app (RAG, campaigns, live-call simulation) be tested without
// real AI provider credentials.
export class MockAIProvider extends AIProvider {
  async generateResponse({ systemPrompt = "", context = "", messages = [], fallbackMessage, knowledgeOnly = true }) {
    const lastUserMsg = [...messages].reverse().find((m) => m.role === "user")?.content || "";

    if (!context || context.trim().length === 0) {
      if (!knowledgeOnly && systemPrompt.trim()) return { text: `[MOCK AI] (no knowledge-base match; answering from the agent instructions) regarding "${lastUserMsg}".`, usedFallback: false };
      return {
        text: fallbackMessage || "I don't have enough information to answer that accurately. I can connect you with a human representative.",
        usedFallback: true,
      };
    }

    // Deterministic mock: surfaces the retrieved context so devs can verify RAG wiring end-to-end.
    const snippet = context.slice(0, 220).trim();
    return {
      text: `[MOCK AI] Based on the knowledge base: "${snippet}${context.length > 220 ? "..." : ""}" — regarding "${lastUserMsg}".`,
      usedFallback: false,
    };
  }
}

// Real implementation — Google Gemini via the generateContent REST API.
// Requires AI_API_KEY. Model is configurable via GEMINI_MODEL (defaults to
// gemini-2.5-flash — fast and inexpensive; use gemini-2.5-pro for higher quality).
export class GeminiAIProvider extends AIProvider {
  constructor(apiKey, model) {
    super();
    if (!apiKey) throw new Error("AI_API_KEY is required when AI_PROVIDER=gemini");
    this.apiKey = apiKey;
    this.model = model || process.env.GEMINI_MODEL || "gemini-2.5-flash";
  }

  async generateResponse({ systemPrompt = "", context = "", messages = [], temperature = 0.3, fallbackMessage, knowledgeOnly = true }) {
    // Ground the model strictly in the retrieved knowledge base context —
    // this is the core anti-hallucination guardrail (see rag.js). If there's
    // no context, don't even call the model; return the fallback directly,
    // same behavior as the mock provider, so callers don't need to branch
    // on which provider is active.
    const hasContext = Boolean(context && context.trim().length);
    // "Knowledge only" agents never answer without a matching passage. Every other agent still follows its own prompt:
    // refusing to call the model whenever retrieval found nothing made normal conversation (greetings, Telugu, small talk) always return the fallback.
    if (!hasContext && (knowledgeOnly || !systemPrompt.trim())) {
      return {
        text: fallbackMessage || "I don't have enough information to answer that accurately. I can connect you with a human representative.",
        usedFallback: true,
      };
    }

    const fullSystemPrompt = [
      systemPrompt,
      "Reply in the same language and script the customer uses. Keep answers short and natural for a phone call.",
      hasContext
        ? "Use the KNOWLEDGE BASE CONTEXT below for facts. If the answer is not contained in it, say you don't have that information and offer to connect the person with a human. " +
          "Never invent prices, policies, availability, or facts not present in the context."
        : "No knowledge-base passage matched this message. Follow the agent instructions above. Do not invent prices, policies, availability or other specific facts; if asked for one, say you will check or connect the person with a human.",
      hasContext ? `KNOWLEDGE BASE CONTEXT:\n${context}` : "",
    ].filter(Boolean).join("\n\n");

    const contents = [
      ...messages.map((m) => ({
        role: m.role === "assistant" ? "model" : "user",
        parts: [{ text: m.content }],
      })),
    ];

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`;
    // gemini-2.5 models spend part of maxOutputTokens on hidden "thinking"; with a small cap the visible answer came back EMPTY and the
    // fallback message was shown. Disable thinking on flash models (not supported on pro) and leave room for the answer.
    const isFlash = /flash/i.test(this.model) && /2\.5/.test(this.model);
    const generationConfig = { temperature: Number(temperature) || 0.3, maxOutputTokens: isFlash ? 1024 : 2048, ...(isFlash ? { thinkingConfig: { thinkingBudget: 0 } } : {}) };
    const body = JSON.stringify({ contents, systemInstruction: { parts: [{ text: fullSystemPrompt }] }, generationConfig });

    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {                       // one retry for transient provider errors (429 / 5xx / timeout)
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000);
      try {
        const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey }, body, signal: controller.signal });
        if (!res.ok) {
          const errBody = await res.text();
          const err = new Error(`Gemini API error ${res.status}: ${errBody.slice(0, 300)}`); err.transient = res.status === 429 || res.status >= 500; throw err;
        }
        const data = await res.json();
        const cand = data.candidates?.[0];
        const text = (cand?.content?.parts || []).map((p) => p.text || "").join("").trim();
        if (!text) {
          const why = data.promptFeedback?.blockReason || cand?.finishReason || "empty";
          const err = new Error(`Gemini returned no text (${why})`); err.transient = why === "empty" || why === "MAX_TOKENS" ? attempt === 0 : false; if (!err.transient) { return { text: fallbackMessage || "I don't have enough information to answer that accurately.", usedFallback: true, error: err.message }; } throw err;
        }
        return { text, usedFallback: false };
      } catch (err) {
        lastErr = err;
        if (err.name === "AbortError") { lastErr = new Error("Gemini request timed out"); lastErr.transient = true; }
        if (!(lastErr.transient && attempt === 0)) break;
        await new Promise((r) => setTimeout(r, 700));
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastErr;
  }
}

export function createAIProvider() {
  const provider = (process.env.AI_PROVIDER || "mock").toLowerCase();
  switch (provider) {
    case "mock":
      return new MockAIProvider();
    case "gemini":
      return new GeminiAIProvider(process.env.AI_API_KEY);
    // case "anthropic": return new AnthropicAIProvider(process.env.AI_API_KEY);
    // case "openai":    return new OpenAIProvider(process.env.AI_API_KEY);
    default:
      console.warn(`[ai] Unknown AI_PROVIDER="${provider}", falling back to mock. Valid values: mock, gemini.`);
      return new MockAIProvider();
  }
}
