import { GoogleGenerativeAI } from "@google/generative-ai";

const genAI = new GoogleGenerativeAI(
  process.env.NEXT_PUBLIC_GEMINI_API_KEY || ""
);
const MODEL_NAME = "gemini-1.5-flash-8b";

export class TranscriptionService {
  private model;

  constructor() {
    this.model = genAI.getGenerativeModel({ model: MODEL_NAME });
  }

  async transcribeAudio(
    audioBase64: string,
    mimeType: string = "audio/wav"
  ): Promise<string> {
    try {
      const result = await this.model.generateContent([
        {
          inlineData: {
            mimeType: mimeType,
            data: audioBase64,
          },
        },
        {
          text: "Please transcribe the spoken language in this audio accurately. Ignore any background noise or non-speech sounds.",
        },
      ]);

      return result.response.text();
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
      const result = await this.model.generateContent([
        {
          text: `Determine if the following user query is related to browser tasks, web navigation, web search, opening websites, 
          interacting with web content, or other web-related activities.

          Examples of browser queries:
          - "Search for Italian restaurants near me"
          - "Go to nytimes.com"
          - "Open my Gmail"
          - "Show me the weather forecast"
          - "Find cheap flights to Paris"
          - "Navigate to YouTube"
          - "Look up how to bake chocolate cookies"
          
          Examples of non-browser queries:
          - "What's your name?"
          - "Tell me a joke"
          - "Can you write a poem?"
          - "What's the meaning of life?"
          - "Describe your capabilities"
          
          User query: "${transcribedText.trim()}"
          
          Respond with ONLY "BROWSER_QUERY" if it's a browser-related query, or "NOT_BROWSER_QUERY" if it's not.`,
        },
      ]);

      const classification = result.response.text().trim();

      if (classification === "BROWSER_QUERY") {
        return transcribedText.trim();
      } else {
        return null;
      }
    } catch (error) {
      console.error("Query classification error:", error);
      return null; // Default to not sending in case of error
    }
  }
}
