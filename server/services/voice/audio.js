// Small PCM16 helpers (no dependencies).
export function pcm16ToWav(pcm, sampleRate = 16000) {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0); h.writeUInt32LE(36 + pcm.length, 4); h.write("WAVE", 8); h.write("fmt ", 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write("data", 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** Extract raw PCM16 from a WAV buffer by walking its chunks (does not assume a 44-byte header). */
export function wavToPcm16(wav) {
  if (wav.length < 12 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") throw new Error("Not a WAV file");
  let off = 12, sampleRate = null, bits = 16, channels = 1;
  while (off + 8 <= wav.length) {
    const id = wav.toString("ascii", off, off + 4); let size = wav.readUInt32LE(off + 4);
    if (id === "fmt ") { channels = wav.readUInt16LE(off + 10); sampleRate = wav.readUInt32LE(off + 12); bits = wav.readUInt16LE(off + 22); }
    if (id === "data") {
      if (size > wav.length - off - 8) size = wav.length - off - 8;      // streaming WAVs may carry a bogus size
      if (bits !== 16 || channels !== 1) throw new Error(`Unsupported WAV format (${channels}ch/${bits}bit); expected mono PCM16`);
      return { pcm: wav.subarray(off + 8, off + 8 + size), sampleRate };
    }
    off += 8 + size + (size % 2);
  }
  throw new Error("WAV has no data chunk");
}

export function rms(pcm) {
  const n = Math.floor(pcm.length / 2); if (!n) return 0;
  let sum = 0; for (let i = 0; i < n; i++) { const s = pcm.readInt16LE(i * 2); sum += s * s; }
  return Math.sqrt(sum / n);
}

/** Split into chunks that are a multiple of 320 bytes (Exotel requirement), padding the tail with silence. */
export function chunkPcm(pcm, chunkBytes = 3200) {
  const size = Math.max(320, Math.floor(chunkBytes / 320) * 320); const out = [];
  for (let i = 0; i < pcm.length; i += size) {
    let c = pcm.subarray(i, i + size);
    if (c.length % 320) c = Buffer.concat([c, Buffer.alloc(320 - (c.length % 320))]);
    out.push(c);
  }
  return out;
}
