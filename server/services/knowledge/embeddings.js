// embeddings.js — EmbeddingProvider abstraction + mock implementation.
// Real providers (OpenAI text-embedding-3, Voyage, Cohere, etc.) should
// implement embed() and be selected via EMBEDDING_PROVIDER.
const EMBEDDING_DIM = 1536; // must match `vector(1536)` column in schema.sql

export class EmbeddingProvider {
  async embed(_text) { throw new Error("embed() not implemented"); }
}

// Deterministic hash-based pseudo-embedding — NOT semantically meaningful,
// but lets the whole pipeline (chunk -> store -> similarity search -> RAG)
// be exercised end-to-end without any external API key.
export class MockEmbeddingProvider extends EmbeddingProvider {
  async embed(text) {
    const vec = new Array(EMBEDDING_DIM).fill(0);
    for (let i = 0; i < text.length; i++) {
      const idx = text.charCodeAt(i) % EMBEDDING_DIM;
      vec[idx] += 1;
    }
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
    return vec.map((v) => v / norm);
  }
}

export function createEmbeddingProvider() {
  const provider = (process.env.EMBEDDING_PROVIDER || "mock").toLowerCase();
  switch (provider) {
    case "mock":
      return new MockEmbeddingProvider();
    case "google":
    case "gemini":
      return new GoogleEmbeddingProvider(process.env.EMBEDDING_API_KEY || process.env.AI_API_KEY);
    // case "openai": return new OpenAIEmbeddingProvider(process.env.EMBEDDING_API_KEY);
    default:
      console.warn(`[embeddings] Unknown EMBEDDING_PROVIDER="${provider}", falling back to mock. Valid values: mock, google.`);
      return new MockEmbeddingProvider();
  }
}

// Real implementation — Google's gemini-embedding-001 via the embedContent
// REST API. Requested at outputDimensionality=1536 to exactly match the
// `vector(1536)` column already in schema.sql — no database migration
// needed. Falls back to AI_API_KEY if EMBEDDING_API_KEY isn't separately
// set, since these commonly share the same Google API key.
//
// IMPORTANT: if you switch EMBEDDING_PROVIDER after already having
// knowledge base chunks embedded with the mock provider (or a different
// real provider), you must re-index every document — embeddings from
// different providers/models are not comparable to each other, and mixing
// them silently produces meaningless similarity scores.
export class GoogleEmbeddingProvider extends EmbeddingProvider {
  constructor(apiKey) {
    super();
    if (!apiKey) throw new Error("EMBEDDING_API_KEY (or AI_API_KEY) is required when EMBEDDING_PROVIDER=google");
    this.apiKey = apiKey;
    this.model = process.env.EMBEDDING_MODEL || "gemini-embedding-001";
  }

  async embed(text) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:embedContent`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": this.apiKey },
      body: JSON.stringify({
        content: { parts: [{ text }] },
        taskType: "RETRIEVAL_DOCUMENT",
        outputDimensionality: EMBEDDING_DIM,
      }),
    });

    if (!res.ok) {
      const errBody = await res.text();
      throw new Error(`Gemini embedding API error ${res.status}: ${errBody.slice(0, 300)}`);
    }

    const data = await res.json();
    const values = data.embedding?.values;
    if (!values) throw new Error("Gemini embedding API returned no embedding values");

    // Matryoshka-truncated embeddings need re-normalization for cosine
    // similarity to behave correctly — Google's own docs call this out.
    const norm = Math.sqrt(values.reduce((s, v) => s + v * v, 0)) || 1;
    return values.map((v) => v / norm);
  }
}

export function toSqlVector(floatArray) {
  return `[${floatArray.join(",")}]`;
}
