// SpeechToTextProvider — abstract interface for STT backends.
import { pcm16ToWav } from "../voice/audio.js";
export class SpeechToTextProvider {
  /**
   * @param {Buffer|ReadableStream} _audio
   * @param {{ language?: string }} _opts
   * @returns {Promise<{ text: string, confidence: number }>}
   */
  async transcribe(_audio, _opts = {}) {
    throw new Error("transcribe() not implemented");
  }
}

export class MockSpeechToTextProvider extends SpeechToTextProvider {
  async transcribe(_audio, { language = "English" } = {}) {
    // Deterministic placeholder so dev/test flows work without a real STT provider.
    return { text: "[mock transcription]", confidence: 0.0, language };
  }
}


// Sarvam AI speech-to-text (REST, short utterances). Audio in: a WAV Buffer, or raw PCM16 when opts.pcm=true (wrapped as WAV).
// Docs: POST {SARVAM_BASE_URL}/speech-to-text, header api-subscription-key, multipart file + model + language_code.
export const SARVAM_LANG = { English: "en-IN", Telugu: "te-IN", Hindi: "hi-IN", Tamil: "ta-IN", Kannada: "kn-IN", Malayalam: "ml-IN", Marathi: "mr-IN", Bengali: "bn-IN", Gujarati: "gu-IN", Punjabi: "pa-IN", Odia: "od-IN" };
export class SarvamSTTProvider extends SpeechToTextProvider {
  constructor({ apiKey, baseUrl, model, fetchImpl } = {}) {
    super();
    if (!apiKey) throw new Error("STT_API_KEY (Sarvam API key) is required when STT_PROVIDER=sarvam");
    this.apiKey = apiKey; this.baseUrl = (baseUrl || "https://api.sarvam.ai").replace(/\/$/, "");
    this.model = model || process.env.SARVAM_STT_MODEL || "saaras:v3"; this.fetch = fetchImpl || fetch;
  }
  async transcribe(audio, { language = "Telugu", pcm = false, sampleRate = 16000 } = {}) {
    const wav = pcm ? pcm16ToWav(audio, sampleRate) : audio;
    const form = new FormData();
    form.append("file", new Blob([wav], { type: "audio/wav" }), "utterance.wav");
    form.append("model", this.model);
    form.append("language_code", SARVAM_LANG[language] || language || "te-IN");
    const res = await this.fetch(`${this.baseUrl}/speech-to-text`, { method: "POST", headers: { "api-subscription-key": this.apiKey }, body: form, signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error(`Sarvam STT error ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
    const data = await res.json();
    return { text: String(data.transcript || "").trim(), confidence: null, language: data.language_code || SARVAM_LANG[language] || null };
  }
}

export function createSTTProvider() {
  const provider = (process.env.STT_PROVIDER || "mock").toLowerCase();
  switch (provider) {
    case "mock":
      return new MockSpeechToTextProvider();
    case "sarvam":
      return new SarvamSTTProvider({ apiKey: process.env.STT_API_KEY || process.env.SARVAM_API_KEY, baseUrl: process.env.SARVAM_BASE_URL });
    // case "google": return new GoogleSTTProvider(process.env.STT_API_KEY);
    // case "azure":  return new AzureSTTProvider(process.env.STT_API_KEY);
    default:
      console.warn(`[stt] Unknown STT_PROVIDER="${provider}", falling back to mock.`);
      return new MockSpeechToTextProvider();
  }
}
