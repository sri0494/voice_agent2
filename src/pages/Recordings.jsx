import { useState } from "react";
import VoiceRecorder from "../components/VoiceRecorder.jsx";
import RecordingList from "../components/RecordingList.jsx";

/** Admin "Recordings" page (sidebar item): record a voice note and browse / play / delete stored recordings. */
export default function Recordings() {
  const [refreshKey, setRefreshKey] = useState(0);
  return (
    <div>
      <div className="section-title">Recordings</div>
      <div className="section-sub">Voice recorder and stored call recordings</div>
      <div className="card" style={{ margin: "16px 0" }}>
        <div style={{ fontWeight: 600 }}>Record</div>
        <VoiceRecorder onSaved={() => setRefreshKey((k) => k + 1)} />
      </div>
      <div className="card"><RecordingList refreshKey={refreshKey} /></div>
    </div>
  );
}
