// TextToSpeechProvider — abstract interface for TTS backends.
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

export function createTTSProvider() {
  const provider = (process.env.TTS_PROVIDER || "mock").toLowerCase();
  switch (provider) {
    case "mock":
      return new MockTextToSpeechProvider();
    // case "elevenlabs": return new ElevenLabsTTSProvider(process.env.TTS_API_KEY);
    // case "azure":      return new AzureTTSProvider(process.env.TTS_API_KEY);
    default:
      console.warn(`[tts] Unknown TTS_PROVIDER="${provider}", falling back to mock.`);
      return new MockTextToSpeechProvider();
  }
}
