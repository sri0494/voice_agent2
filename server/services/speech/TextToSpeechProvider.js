// TextToSpeechProvider — abstract interface for TTS backends.
import { wavToPcm16 } from "../voice/audio.js";
export class TextToSpeechProvider {
  /**
   * @param {string} _text
   * @param {{ voice?: string, language?: string }} _opts
   * @returns {Promise<{ audioUrl: string|null, audioBuffer: Buffer|null }>}
   */
  async synthesize(_text, _opts = {}) {
    throw new Error("synthesize() not implemented");
  }
}

export class MockTextToSpeechProvider extends TextToSpeechProvider {
  async synthesize(text, { voice = "default" } = {}) {
    // No real audio generated — returns null buffer so callers can branch on mock mode.
    return { audioUrl: null, audioBuffer: null, meta: { voice, textLength: text.length, mock: true } };
  }
}


// Sarvam AI text-to-speech (REST). Returns base64 WAV; we hand callers raw PCM16 + its sample rate.
// Docs: POST {SARVAM_BASE_URL}/text-to-speech {text (<=1500 chars), target_language_code, speaker, model, speech_sample_rate}.
const SARVAM_LANG = { English: "en-IN", Telugu: "te-IN", Hindi: "hi-IN", Tamil: "ta-IN", Kannada: "kn-IN", Malayalam: "ml-IN", Marathi: "mr-IN", Bengali: "bn-IN", Gujarati: "gu-IN" };
export class SarvamTTSProvider extends TextToSpeechProvider {
  constructor({ apiKey, baseUrl, model, speaker, fetchImpl } = {}) {
    super();
    if (!apiKey) throw new Error("TTS_API_KEY (Sarvam API key) is required when TTS_PROVIDER=sarvam");
    this.apiKey = apiKey; this.baseUrl = (baseUrl || "https://api.sarvam.ai").replace(/\/$/, "");
    this.model = model || process.env.SARVAM_TTS_MODEL || "bulbul:v3"; this.speaker = speaker || process.env.SARVAM_TTS_SPEAKER || "";
    this.fetch = fetchImpl || fetch;
  }
  async synthesize(text, { language = "Telugu", sampleRate = 16000, voice } = {}) {
    const clean = String(text || "").trim().slice(0, 1500);
    if (!clean) return { audioUrl: null, audioBuffer: null, pcm: Buffer.alloc(0), sampleRate };
    const body = { text: clean, target_language_code: SARVAM_LANG[language] || language || "te-IN", model: this.model, speech_sample_rate: sampleRate };
    const speaker = voice && voice !== "default" ? voice : this.speaker; if (speaker) body.speaker = speaker;
    const res = await this.fetch(`${this.baseUrl}/text-to-speech`, {
      method: "POST", headers: { "api-subscription-key": this.apiKey, "Content-Type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`Sarvam TTS error ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    const data = await res.json();
    const b64 = data.audios?.[0]; if (!b64) throw new Error("Sarvam TTS returned no audio");
    const wav = Buffer.from(b64, "base64"); const { pcm, sampleRate: sr } = wavToPcm16(wav);
    return { audioUrl: null, audioBuffer: wav, pcm, sampleRate: sr || sampleRate };
  }
}

export function createTTSProvider() {
  const provider = (process.env.TTS_PROVIDER || "mock").toLowerCase();
  switch (provider) {
    case "mock":
      return new MockTextToSpeechProvider();
    case "sarvam":
      return new SarvamTTSProvider({ apiKey: process.env.TTS_API_KEY || process.env.SARVAM_API_KEY, baseUrl: process.env.SARVAM_BASE_URL });
    // case "elevenlabs": return new ElevenLabsTTSProvider(process.env.TTS_API_KEY);
    // case "azure":      return new AzureTTSProvider(process.env.TTS_API_KEY);
    default:
      console.warn(`[tts] Unknown TTS_PROVIDER="${provider}", falling back to mock.`);
      return new MockTextToSpeechProvider();
  }
}
