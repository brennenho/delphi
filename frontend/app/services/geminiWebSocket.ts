import { pcmToWav } from "../utils/audioUtils";
import { TranscriptionService } from "./transcriptionService";

const MODEL = "models/gemini-2.0-flash-live-001";
const BACKEND_HOST = process.env.NEXT_PUBLIC_BACKEND_HOST || "localhost:8004";
const WS_URL = `ws://${BACKEND_HOST}/gemini-proxy`;

const SYSTEM_PROMPT = `
You are an intelligent browser assistant that helps users navigate the web through voice commands.
Your goal is to understand and process browser actions from natural conversation with maximum efficiency.

# Action Detection
- Detect browser action requests: search queries, navigation, opening/closing tabs, etc.
- For non-browser requests, respond conversationally as a helpful assistant

# Response Style
- For browser actions:
  * Use FUTURE TENSE for actions ("I'll search" NOT "Searching")
  * Be concise - one sentence per action when possible
  * Skip all preambles and acknowledgments
  * State actions without explaining them (e.g. "I'll search for coffee shops nearby")
  
- For conversational exchanges:
  * Respond naturally and helpfully
  * Keep responses concise and focused
  * Maintain a friendly, assistant-like tone

# Examples
User: "Show me the weather in New York"
Response: "I'll search for weather in New York."

User: "What's the capital of France?"
Response: "The capital of France is Paris."

User: "Open Gmail in a new tab"
Response: "I'll open Gmail in a new tab."

User: "Tell me about quantum computing"
Response: "Quantum computing uses quantum mechanics principles like superposition and entanglement to process information. Unlike classical computers that use bits, quantum computers use quantum bits or qubits that can represent multiple states simultaneously."
`;

export class GeminiWebSocket {
  private ws: WebSocket | null = null;
  private isConnected: boolean = false;
  private isSetupComplete: boolean = false;
  private onMessageCallback: ((text: string) => void) | null = null;
  private onSetupCompleteCallback: (() => void) | null = null;
  private audioContext: AudioContext | null = null;

  // Audio queue management
  private audioQueue: Float32Array[] = [];
  private isPlaying: boolean = false;
  private currentSource: AudioBufferSourceNode | null = null;
  private isPlayingResponse: boolean = false;
  private onPlayingStateChange: ((isPlaying: boolean) => void) | null = null;
  private onAudioLevelChange: ((level: number) => void) | null = null;
  private onTranscriptionCallback: ((text: string) => void) | null = null;
  private transcriptionService: TranscriptionService;
  private accumulatedPcmData: string[] = [];
  private isPaused: boolean = false;

  constructor(
    onMessage: (text: string) => void,
    onSetupComplete: () => void,
    onPlayingStateChange: (isPlaying: boolean) => void,
    onAudioLevelChange: (level: number) => void,
    onTranscription: (text: string) => void
  ) {
    this.onMessageCallback = onMessage;
    this.onSetupCompleteCallback = onSetupComplete;
    this.onPlayingStateChange = onPlayingStateChange;
    this.onAudioLevelChange = onAudioLevelChange;
    this.onTranscriptionCallback = onTranscription;
    // Create AudioContext for playback
    this.audioContext = new AudioContext({
      sampleRate: 24000, // Match the response audio rate
    });
    this.transcriptionService = new TranscriptionService();
  }

  connect() {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return;
    }

    // Use a client ID for this connection
    const clientId = Math.random().toString(36).substring(7);
    this.ws = new WebSocket(`${WS_URL}/${clientId}`);

    this.ws.onopen = () => {
      this.isConnected = true;
      this.sendInitialSetup();
    };

    this.ws.onmessage = async (event) => {
      try {
        let messageText: string;
        if (event.data instanceof Blob) {
          const arrayBuffer = await event.data.arrayBuffer();
          const bytes = new Uint8Array(arrayBuffer);
          messageText = new TextDecoder("utf-8").decode(bytes);
        } else {
          messageText = event.data;
        }

        await this.handleMessage(messageText);
      } catch (error) {
        console.error("[WebSocket] Error processing message:", error);
      }
    };

    this.ws.onerror = (error) => {
      console.error("[WebSocket] Error:", error);
    };

    this.ws.onclose = (event) => {
      this.isConnected = false;

      // Only attempt to reconnect if we haven't explicitly called disconnect
      if (!event.wasClean && this.isSetupComplete) {
        setTimeout(() => this.connect(), 1000);
      }
    };
  }

  private sendInitialSetup() {
    const setupMessage = {
      setup: {
        model: MODEL,
        generation_config: {
          response_modalities: ["AUDIO"],
        },
        system_instruction: {
          parts: [{ text: SYSTEM_PROMPT }],
        },
      },
    };
    this.ws?.send(JSON.stringify(setupMessage));
  }

  sendMediaChunk(b64Data: string, mimeType: string) {
    if (!this.isConnected || !this.ws || !this.isSetupComplete) return;

    const message = {
      realtime_input: {
        media_chunks: [
          {
            mime_type: mimeType === "audio/pcm" ? "audio/pcm" : mimeType,
            data: b64Data,
          },
        ],
      },
    };

    try {
      this.ws.send(JSON.stringify(message));
    } catch (error) {
      console.error("[WebSocket] Error sending media chunk:", error);
    }
  }

  public sendTextInput(text: string) {
    if (!this.isConnected || !this.ws || !this.isSetupComplete) return;

    const message = {
      content: {
        parts: [{ text: "Hello! How are you today?" }],
      },
    };

    console.log("[TESTING] Sending text input:", message);

    try {
      this.ws.send(JSON.stringify(message));
    } catch (error) {
      console.error("[WebSocket] Error sending text input:", error);
    }
  }

  private async playAudioResponse(base64Data: string) {
    if (!this.audioContext) return;

    try {
      // Decode base64 to bytes
      const binaryString = atob(base64Data);
      const bytes = new Uint8Array(binaryString.length);
      for (let i = 0; i < binaryString.length; i++) {
        bytes[i] = binaryString.charCodeAt(i);
      }

      // Convert to Int16Array (PCM format)
      const pcmData = new Int16Array(bytes.buffer);

      // Convert to float32 for Web Audio API
      const float32Data = new Float32Array(pcmData.length);
      for (let i = 0; i < pcmData.length; i++) {
        float32Data[i] = pcmData[i] / 32768.0;
      }

      // Add to queue and start playing if not already playing
      this.audioQueue.push(float32Data);
      this.playNextInQueue();
    } catch (error) {
      console.error("[WebSocket] Error processing audio:", error);
    }
  }

  private async playNextInQueue() {
    if (
      !this.audioContext ||
      this.isPlaying ||
      this.audioQueue.length === 0 ||
      this.isPaused
    )
      return;

    try {
      this.isPlaying = true;
      this.isPlayingResponse = true;
      this.onPlayingStateChange?.(true);
      const float32Data = this.audioQueue.shift()!;

      // Calculate audio level
      let sum = 0;
      for (let i = 0; i < float32Data.length; i++) {
        sum += Math.abs(float32Data[i]);
      }
      const level = Math.min((sum / float32Data.length) * 100 * 5, 100);
      this.onAudioLevelChange?.(level);

      const audioBuffer = this.audioContext.createBuffer(
        1,
        float32Data.length,
        24000
      );
      audioBuffer.getChannelData(0).set(float32Data);

      this.currentSource = this.audioContext.createBufferSource();
      this.currentSource.buffer = audioBuffer;
      this.currentSource.connect(this.audioContext.destination);

      this.currentSource.onended = () => {
        this.isPlaying = false;
        this.currentSource = null;
        if (this.audioQueue.length === 0) {
          this.isPlayingResponse = false;
          this.onPlayingStateChange?.(false);
        }
        this.playNextInQueue();
      };

      this.currentSource.start();
    } catch (error) {
      console.error("[WebSocket] Error playing audio:", error);
      this.isPlaying = false;
      this.isPlayingResponse = false;
      this.onPlayingStateChange?.(false);
      this.currentSource = null;
      this.playNextInQueue();
    }
  }

  private stopCurrentAudio() {
    if (this.currentSource) {
      try {
        this.currentSource.stop();
      } catch (e) {
        // Ignore errors if already stopped
      }
      this.currentSource = null;
    }
    this.isPlaying = false;
    this.isPlayingResponse = false;
    this.onPlayingStateChange?.(false);
    this.audioQueue = []; // Clear queue
  }

  pauseAudio() {
    this.stopCurrentAudio();
    this.isPaused = true;
  }

  resumeAudio() {
    this.isPaused = false;
    this.playNextInQueue(); // Resume playing any queued audio
  }

  private async handleMessage(message: string) {
    try {
      const messageData = JSON.parse(message);

      if (messageData.setupComplete) {
        this.isSetupComplete = true;
        this.onSetupCompleteCallback?.();
        return;
      }

      // Handle audio data
      if (messageData.serverContent?.modelTurn?.parts) {
        const parts = messageData.serverContent.modelTurn.parts;
        for (const part of parts) {
          if (part.inlineData?.mimeType === "audio/pcm;rate=24000") {
            this.accumulatedPcmData.push(part.inlineData.data);
            this.playAudioResponse(part.inlineData.data);
          }
        }
      }

      // Handle turn completion separately
      if (messageData.serverContent?.turnComplete === true) {
        if (this.accumulatedPcmData.length > 0) {
          try {
            const fullPcmData = this.accumulatedPcmData.join("");
            const wavData = await pcmToWav(fullPcmData, 24000);

            const transcription =
              await this.transcriptionService.transcribeAudio(
                wavData,
                "audio/wav"
              );
            console.log("[Transcription]:", transcription);

            this.onTranscriptionCallback?.(transcription);
            this.accumulatedPcmData = []; // Clear accumulated data
          } catch (error) {
            console.error("[WebSocket] Transcription error:", error);
          }
        }
      }
    } catch (error) {
      console.error("[WebSocket] Error parsing message:", error);
    }
  }

  disconnect() {
    this.isSetupComplete = false;
    if (this.ws) {
      this.ws.close(1000, "Intentional disconnect");
      this.ws = null;
    }
    this.isConnected = false;
    this.accumulatedPcmData = [];
  }
}
