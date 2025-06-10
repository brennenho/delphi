export class TranscriptionService {
  async transcribeAudio(audioBase64: string, mimeType = "audio/wav"): Promise<string> {
    const res = await fetch("http://localhost:8005/transcribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: audioBase64, mime_type: mimeType }),
    });
    if (!res.ok) throw new Error("Transcription failed");
    const json = await res.json();
    return json.text as string;
  }

  async isBrowserQuery(text: string): Promise<string | null> {
    const res = await fetch("http://localhost:8005/classify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    if (!res.ok) return null;
    const json = await res.json();
    return json.label === "BROWSER_QUERY" ? text.trim() : null;
  }
}
