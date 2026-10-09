// Speech-to-text via any OpenAI-compatible /audio/transcriptions endpoint.
// Configure in .env:
//   STT_API_KEY   — required to enable voice
//   STT_API_URL   — full endpoint (default OpenAI)
//   STT_MODEL     — model name (default whisper-1)
const STT_API_KEY = process.env.STT_API_KEY || "";
const STT_API_URL = process.env.STT_API_URL || "https://api.openai.com/v1/audio/transcriptions";
const STT_MODEL = process.env.STT_MODEL || "whisper-1";

function enabled() {
  return Boolean(STT_API_KEY);
}

// buffer: audio bytes, filename: e.g. voice.ogg (Telegram voice notes are OGG/Opus)
async function transcribe(buffer, filename = "voice.ogg") {
  if (!STT_API_KEY) throw new Error("STT not configured");
  const form = new FormData();
  form.append("file", new Blob([buffer]), filename);
  form.append("model", STT_MODEL);
  const res = await fetch(STT_API_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${STT_API_KEY}` },
    body: form
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(`STT ${res.status}: ${t.slice(0, 200)}`);
  }
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    const j = await res.json();
    return (j.text || "").trim();
  }
  return (await res.text()).trim();
}

module.exports = { enabled, transcribe };
