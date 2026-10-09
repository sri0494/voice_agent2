// SpeechToTextProvider — abstract interface for STT backends.
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

export function createSTTProvider() {
  const provider = (process.env.STT_PROVIDER || "mock").toLowerCase();
  switch (provider) {
    case "mock":
      return new MockSpeechToTextProvider();
    // case "google": return new GoogleSTTProvider(process.env.STT_API_KEY);
    // case "azure":  return new AzureSTTProvider(process.env.STT_API_KEY);
    default:
      console.warn(`[stt] Unknown STT_PROVIDER="${provider}", falling back to mock.`);
      return new MockSpeechToTextProvider();
  }
}
