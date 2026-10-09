import { useEffect, useRef, useState } from "react";
import * as api from "../services/http.js";

const MAX_SECONDS = 600; // auto-stop at 10 minutes

const pickMime = () =>
  ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"]
    .find((t) => window.MediaRecorder?.isTypeSupported?.(t)) || "";

const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;

/**
 * Browser voice recorder. Records from the microphone, lets you preview,
 * then uploads to object storage via POST /api/recordings.
 *   <VoiceRecorder callId={call.id} onSaved={() => reloadList()} />
 * Note: the browser only allows mic access on HTTPS (or localhost).
 */
export default function VoiceRecorder({ callId = null, onSaved }) {
  const [status, setStatus] = useState("idle"); // idle | recording | recorded | uploading
  const [seconds, setSeconds] = useState(0);
  const [error, setError] = useState("");
  const [blob, setBlob] = useState(null);
  const [previewUrl, setPreviewUrl] = useState("");
  const recRef = useRef(null);
  const streamRef = useRef(null);
  const chunksRef = useRef([]);
  const timerRef = useRef(null);
  const secondsRef = useRef(0);

  const releaseMic = () => {
    clearInterval(timerRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  };

  // Clean up mic + object URL if the component unmounts mid-recording.
  useEffect(() => () => { releaseMic(); if (previewUrl) URL.revokeObjectURL(previewUrl); }, [previewUrl]);

  const start = async () => {
    setError("");
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      return setError("Recording isn't supported in this browser.");
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      streamRef.current = stream;
      const mime = pickMime();
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      chunksRef.current = [];
      rec.ondataavailable = (e) => e.data.size && chunksRef.current.push(e.data);
      rec.onstop = () => {
        const b = new Blob(chunksRef.current, { type: rec.mimeType || mime || "audio/webm" });
        setBlob(b);
        setPreviewUrl(URL.createObjectURL(b));
        setStatus("recorded");
        releaseMic();
      };
      rec.start(1000);
      recRef.current = rec;
      secondsRef.current = 0;
      setSeconds(0);
      setStatus("recording");
      timerRef.current = setInterval(() => {
        secondsRef.current += 1;
        setSeconds(secondsRef.current);
        if (secondsRef.current >= MAX_SECONDS) stop();
      }, 1000);
    } catch (err) {
      releaseMic();
      setError(err?.name === "NotAllowedError" ? "Microphone permission was denied." : "Could not access the microphone.");
    }
  };

  const stop = () => {
    clearInterval(timerRef.current);
    if (recRef.current?.state === "recording") recRef.current.stop();
  };

  const discard = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setBlob(null); setPreviewUrl(""); setSeconds(0); setStatus("idle"); setError("");
  };

  const save = async () => {
    setStatus("uploading"); setError("");
    try {
      const saved = await api.uploadRecording(blob, { callId, durationSec: secondsRef.current });
      discard();
      onSaved?.(saved);
    } catch (err) {
      setError(err.message || "Upload failed. Try again.");
      setStatus("recorded");
    }
  };

  return (
    <div style={{ padding: "10px 0" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        {status === "idle" && <button type="button" className="btn btn-sm" onClick={start}>● Record</button>}
        {status === "recording" && (
          <>
            <button type="button" className="btn btn-sm btn-danger" onClick={stop}>■ Stop</button>
            <span style={{ fontVariantNumeric: "tabular-nums", fontSize: 13 }}>
              <span style={{ color: "#e5484d" }}>●</span> {mmss(seconds)}
            </span>
          </>
        )}
        {(status === "recorded" || status === "uploading") && (
          <>
            <audio controls src={previewUrl} style={{ height: 34, maxWidth: 260 }} />
            <button type="button" className="btn btn-sm btn-primary" onClick={save} disabled={status === "uploading"}>
              {status === "uploading" ? "Saving..." : "Save recording"}
            </button>
            <button type="button" className="btn btn-sm" onClick={discard} disabled={status === "uploading"}>Discard</button>
          </>
        )}
      </div>
      {error && <div role="alert" style={{ color: "#e5484d", fontSize: 12.5, marginTop: 6 }}>{error}</div>}
    </div>
  );
}
