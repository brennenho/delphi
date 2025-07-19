const BACKEND_HOST = process.env.NEXT_PUBLIC_BACKEND_HOST || "localhost:8004";
const BACKEND_URL = `http://${BACKEND_HOST}`;

export class TranscriptionService {
  constructor() {
    // No longer need to initialize a model - using backend API
  }

  async transcribeAudio(
    audioBase64: string,
    mimeType: string = "audio/wav"
  ): Promise<string> {
    try {
      const response = await fetch(`${BACKEND_URL}/transcribe`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          audioBase64: audioBase64,
          mimeType: mimeType,
        }),
      });

      if (!response.ok) {
        throw new Error(`Transcription failed: ${response.statusText}`);
      }

      const result = await response.json();
      return result.transcription;
    } catch (error) {
      console.error("Transcription error:", error);
      throw error;
    }
  }

  /**
   * Determines if the transcribed text is related to browser tasks or queries
   * Returns the text if it's a browser query, or null if it's not
   */
  async isBrowserQuery(transcribedText: string): Promise<string | null> {
    if (!transcribedText || transcribedText.trim().length === 0) {
      return null;
    }

    try {
      const response = await fetch(`${BACKEND_URL}/browser-query`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text: transcribedText.trim(),
        }),
      });

      if (!response.ok) {
        throw new Error(`Classification failed: ${response.statusText}`);
      }

      const result = await response.json();
      
      if (result.isBrowserQuery) {
        return result.query;
      } else {
        return null;
      }
    } catch (error) {
      console.error("Query classification error:", error);
      return null; // Default to not sending in case of error
    }
  }
}
