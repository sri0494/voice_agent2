// Runs in a child process (the storage factory caches its provider per process).
const mode = process.argv[2];
const { getStorage } = await import("../../server/services/storage/index.js");
try {
  const st = await getStorage();
  if (mode === "presign") {
    const url = await st.getSignedUrl("customers/c1/campaigns/k1/recordings/x.wav", { expiresIn: 300, contentType: "audio/wav", download: process.argv[3] === "download", filename: "recording-1.wav" });
    console.log(JSON.stringify({ name: st.name, presign: st.supportsPresign, url }));
  } else console.log(JSON.stringify({ name: st.name }));
} catch (e) { console.log(JSON.stringify({ error: e.message })); }
