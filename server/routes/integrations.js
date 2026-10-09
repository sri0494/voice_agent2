import { Router } from "express";
import { query } from "../db/pool.js";
import { requireAuth, requireStaff, requireRole } from "../middleware/auth.js";
import { rbac, R } from "../middleware/rbac.js";
import { audit } from "../services/audit.js";

const router = Router();
router.use(requireAuth, requireStaff, rbac({ read: R.MANAGERS, write: R.ADMINS }));

// Reports which providers are configured — and, critically, whether a real
// adapter actually exists for the configured value and whether its
// required credentials are present. Previously this reported "CONNECTED"
// for ANY non-"mock" value, even typos or providers with no real
// implementation — which silently misled the UI into claiming a real
// connection while the backend kept using the mock provider underneath.
function evaluateProvider({ envVar, value, implemented, requiredKeys = [] }) {
  if (!value || value === "mock") {
    return { status: "DISCONNECTED", detail: "Using mock implementation (no real calls/output)" };
  }
  if (!implemented.includes(value)) {
    const looksLikeACredential = value.length > 24 || /[^a-z0-9._-]/i.test(value);
    const hint = looksLikeACredential
      ? ` This looks like it might be an API key pasted into the wrong field — ${envVar} should be a short provider name (e.g. "${implemented[0] || "mock"}"), and the actual key belongs in its own *_API_KEY variable.`
      : "";
    return { status: "ERROR", detail: `"${value}" has no real adapter implemented. Supported: ${implemented.join(", ") || "none yet"}.${hint} Falling back to mock.` };
  }
  const missingKeys = requiredKeys.filter((k) => !process.env[k]);
  if (missingKeys.length > 0) {
    return { status: "ERROR", detail: `Missing required env var(s): ${missingKeys.join(", ")}. Falling back to mock.` };
  }
  return { status: "CONNECTED", detail: "Real provider active" };
}

router.get("/", async (req, res, next) => {
  try {
    const ai = evaluateProvider({ envVar: "AI_PROVIDER", value: process.env.AI_PROVIDER, implemented: ["gemini"], requiredKeys: ["AI_API_KEY"] });
    const stt = evaluateProvider({ envVar: "STT_PROVIDER", value: process.env.STT_PROVIDER, implemented: [], requiredKeys: [] });
    const tts = evaluateProvider({ envVar: "TTS_PROVIDER", value: process.env.TTS_PROVIDER, implemented: [], requiredKeys: [] });
    const telephony = evaluateProvider({
      envVar: "TELEPHONY_PROVIDER", value: process.env.TELEPHONY_PROVIDER, implemented: ["twilio"],
      requiredKeys: ["TELEPHONY_API_KEY", "TELEPHONY_API_SECRET", "TELEPHONY_PHONE_NUMBER", "PUBLIC_BASE_URL"],
    });
    const embeddings = evaluateProvider({ envVar: "EMBEDDING_PROVIDER", value: process.env.EMBEDDING_PROVIDER, implemented: ["google", "gemini"], requiredKeys: [] });

    const builtIn = [
      { name: "AI Provider", type: "AI", envVar: "AI_PROVIDER", value: process.env.AI_PROVIDER || "mock", ...ai },
      { name: "Speech to Text", type: "STT", envVar: "STT_PROVIDER", value: process.env.STT_PROVIDER || "mock", ...stt,
        detail: process.env.STT_PROVIDER && process.env.STT_PROVIDER !== "mock"
          ? "No standalone STT provider is implemented. Real speech recognition happens via Twilio's built-in <Gather> when Telephony Provider = twilio."
          : stt.detail },
      { name: "Text to Speech", type: "TTS", envVar: "TTS_PROVIDER", value: process.env.TTS_PROVIDER || "mock", ...tts,
        detail: process.env.TTS_PROVIDER && process.env.TTS_PROVIDER !== "mock"
          ? "No standalone TTS provider is implemented. Real speech output happens via Twilio's built-in <Say> when Telephony Provider = twilio."
          : tts.detail },
      { name: "Telephony", type: "TELEPHONY", envVar: "TELEPHONY_PROVIDER", value: process.env.TELEPHONY_PROVIDER || "mock", ...telephony },
      { name: "Embeddings", type: "EMBEDDING", envVar: "EMBEDDING_PROVIDER", value: process.env.EMBEDDING_PROVIDER || "mock", ...embeddings },
    ];
    const { rows: custom } = await query(`SELECT * FROM integrations ORDER BY created_at DESC`);
    // Older "custom" integrations keep their settings in a JSON config that may contain keys/tokens: never send those values.
    const SECRET = /key|secret|token|password|authorization|credential/i;
    const mask = (v) => (v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, SECRET.test(k) ? (x ? "********" : x) : mask(x)])) : v);
    res.json({ success: true, data: { builtIn, custom: custom.map((c) => ({ ...c, config: mask(c.config) })) }, message: "Success" });
  } catch (err) { next(err); }
});

router.post("/", requireRole("SUPER_ADMIN", "ADMIN"), async (req, res, next) => {
  try {
    const { name, type, config } = req.body;
    const { rows } = await query(
      `INSERT INTO integrations (name, type, config) VALUES ($1,$2,$3) RETURNING *`,
      [name, type, JSON.stringify(config || {})]
    );
    res.status(201).json({ success: true, data: rows[0], message: "Integration saved" });
  } catch (err) { next(err); }
});

export default router;
