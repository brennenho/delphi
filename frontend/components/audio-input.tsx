"use client";

import { Base64 } from "js-base64";
import { Mic, MicOff } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { GeminiWebSocket } from "../app/services/geminiWebSocket";
import { TranscriptionService } from "../app/services/transcriptionService";
import { TtsService } from "../app/services/ttsService";
import { pcmToWav } from "../app/utils/audioUtils";

/* ───── VAD tuning ───── */
const START_LEVEL = 5; // % that counts as "voice has started"
const SILENCE_LEVEL = 5; // % considered "quiet"
const SILENCE_MS = 1500; // pause that ends an utterance
const SAMPLE_RATE = 16000;

interface AudioInputProps {
  onTranscription: (text: string, speaker: "human" | "gemini") => void;
}

export default function AudioInput({ onTranscription }: AudioInputProps) {
  /* ───── refs & state ───── */
  const audioCtxRef = useRef<AudioContext | null>(null);
  const geminiWsRef = useRef<GeminiWebSocket | null>(null);
  const backendWsRef = useRef<WebSocket | null>(null);
  const ttsServiceRef = useRef<TtsService | null>(null);
  const workletRef = useRef<AudioWorkletNode | null>(null);

  const userChunksRef = useRef<Uint8Array[]>([]);
  const lastVoiceMsRef = useRef<number>(0);
  const speakingRef = useRef(false);

  const modelSpeakingRef = useRef(false);
  const [isModelSpeaking, setIsModelSpeaking] = useState(false);

  const transcriptionSvc = useRef(new TranscriptionService());

  const [isStreaming, setIsStreaming] = useState(false);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [audioLevel, setAudioLevel] = useState(0);
  const [outputAudioLevel, setOutputAudioLevel] = useState(0);
  const [isAudioSetup, setIsAudioSetup] = useState(false);
  const [isWebSocketReady, setIsWebSocketReady] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<
    "disconnected" | "connecting" | "connected"
  >("disconnected");
  const [backendConnected, setBackendConnected] = useState(false);

  /* ───── cleanup helpers ───── */
  const cleanupAudio = useCallback(() => {
    workletRef.current?.disconnect();
    workletRef.current = null;
    audioCtxRef.current?.close();
    audioCtxRef.current = null;
  }, []);

  const cleanupWs = useCallback(() => {
    geminiWsRef.current?.disconnect();
    geminiWsRef.current = null;
  }, []);

  const cleanupBackendWs = useCallback(() => {
    if (backendWsRef.current) {
      backendWsRef.current.close();
      backendWsRef.current = null;
      setBackendConnected(false);
    }
  }, []);

  const sendToGemini = (b64: string) =>
    geminiWsRef.current?.sendMediaChunk(b64, "audio/pcm");

  /* ───── flush & transcribe ───── */
  const flushUserAudio = useCallback(async () => {
    if (!speakingRef.current || userChunksRef.current.length === 0) return;

    const total = userChunksRef.current.reduce((s, c) => s + c.length, 0);
    const merged = new Uint8Array(total);
    userChunksRef.current.reduce(
      (off, c) => (merged.set(c, off), off + c.length),
      0
    );
    userChunksRef.current = [];
    speakingRef.current = false;

    try {
      const wav = await pcmToWav(Base64.fromUint8Array(merged), SAMPLE_RATE);
      const text = await transcriptionSvc.current.transcribeAudio(
        wav,
        "audio/wav"
      );

      onTranscription(text, "human");

      const isBrowserQuery = await transcriptionSvc.current.isBrowserQuery(
        text
      );

      if (isBrowserQuery) {
        console.log("Browser query detected:", isBrowserQuery);
        await fetch("http://localhost:8000/query", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            text: text,
          }),
        });
      }
    } catch (err) {
      console.error("[UserTranscription] error:", err);
    }
  }, [onTranscription]);

  /* ───── Gemini callback ───── */
  const handleGeminiText = useCallback(
    async (geminiText: string) => {
      await flushUserAudio(); // finish any pending utterance first
      onTranscription(geminiText, "gemini");
    },
    [flushUserAudio, onTranscription]
  );

  /* ───── mic toggle ───── */
  const toggleMicrophone = async () => {
    if (isStreaming && stream) {
      setIsStreaming(false);
      cleanupWs();
      cleanupBackendWs();
      cleanupAudio();
      stream.getTracks().forEach((t) => t.stop());
      setStream(null);
      speakingRef.current = false;
      userChunksRef.current = [];
      return;
    }

    try {
      const s = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: SAMPLE_RATE,
          channelCount: 1,
          echoCancellation: true,
          autoGainControl: true,
          noiseSuppression: true,
        },
      });
      audioCtxRef.current = new AudioContext({ sampleRate: SAMPLE_RATE });
      setStream(s);
      setIsStreaming(true);
    } catch (err) {
      console.error("getUserMedia failed:", err);
      cleanupAudio();
    }
  };

  /* ───── WebSocket setup (runs once per start/stop) ───── */
  useEffect(() => {
    if (!isStreaming) {
      setConnectionStatus("disconnected");
      return;
    }

    setConnectionStatus("connecting");
    geminiWsRef.current = new GeminiWebSocket(
      () => {},
      () => {
        setIsWebSocketReady(true);
        setConnectionStatus("connected");
      },
      (playing) => {
        modelSpeakingRef.current = playing;
        setIsModelSpeaking(playing);
      },
      (lvl) => setOutputAudioLevel(lvl),
      handleGeminiText
    );
    geminiWsRef.current.connect();

    return () => {
      cleanupWs();
      setIsWebSocketReady(false);
    };
  }, [isStreaming, handleGeminiText, cleanupWs]);

  /* ───── Backend WebSocket setup ───── */
  useEffect(() => {
    if (!isStreaming) {
      cleanupBackendWs();
      return;
    }

    if (!ttsServiceRef.current) {
      ttsServiceRef.current = new TtsService((isPlaying) => {
        if (!isPlaying && geminiWsRef.current && !modelSpeakingRef.current) {
          geminiWsRef.current.resumeAudio();
        }
      });
    }

    const backendUrl = "ws://localhost:8004/ws/1";
    const ws = new WebSocket(backendUrl);

    ws.onopen = () => {
      console.log("[Backend WebSocket] Connected");
      setBackendConnected(true);
    };

    ws.onmessage = async (event) => {
      try {
        const data = JSON.parse(event.data);

        if (data.message) {
          console.log("[Backend WebSocket] Received message:", data.message);

          if (geminiWsRef.current) {
            geminiWsRef.current.pauseAudio();
          }

          if (ttsServiceRef.current) {
            await ttsServiceRef.current.speak(data.message);

            if (geminiWsRef.current) {
              geminiWsRef.current.resumeAudio();
            }
          }
        }
      } catch (error) {
        console.error("[Backend WebSocket] Error processing message:", error);
      }
    };

    ws.onerror = (error) => {
      console.error("[Backend WebSocket] Error:", error);
    };

    ws.onclose = () => {
      console.log("[Backend WebSocket] Disconnected");
      setBackendConnected(false);
    };

    backendWsRef.current = ws;

    return () => {
      cleanupBackendWs();
    };
  }, [isStreaming, onTranscription]);

  // useEffect(() => {
  //   if (!isStreaming) {
  //     cleanupBackendWs();
  //     return;
  //   }

  //   if (!ttsServiceRef.current) {
  //     ttsServiceRef.current = new TtsService((isPlaying) => {
  //       if (!isPlaying && geminiWsRef.current && !modelSpeakingRef.current) {
  //         geminiWsRef.current.resumeAudio();
  //       }
  //     });
  //   }

  //   const backendUrl = "ws://localhost:8004/ws/1";
  //   const ws = new WebSocket(backendUrl);

  //   ws.onopen = () => {
  //     console.log("[Backend WebSocket] Connected");
  //     setBackendConnected(true);
  //   };

  //   ws.onmessage = async (event) => {
  //     try {
  //       const data = JSON.parse(event.data);

  //       if (data.message) {
  //         console.log("[Backend WebSocket] Received message:", data.message);

  //         // First, pause any ongoing Gemini audio to avoid overlap
  //         if (geminiWsRef.current) {
  //           geminiWsRef.current.pauseAudio();
  //         }

  //         // Feed the message as text input to Gemini
  //         if (geminiWsRef.current) {
  //           // Optional: add a small delay to ensure any current audio has stopped
  //           await new Promise((resolve) => setTimeout(resolve, 100));

  //           // Send the backend message as text input to Gemini
  //           geminiWsRef.current.sendTextInput(
  //             `[ANNOUNCEMENT]: ${data.message}`
  //           );

  //           // Resume Gemini's audio processing
  //           geminiWsRef.current.resumeAudio();
  //         }
  //       }
  //     } catch (error) {
  //       console.error("[Backend WebSocket] Error processing message:", error);
  //     }
  //   };

  //   ws.onerror = (error) => {
  //     console.error("[Backend WebSocket] Error:", error);
  //   };

  //   ws.onclose = () => {
  //     console.log("[Backend WebSocket] Disconnected");
  //     setBackendConnected(false);
  //   };

  //   backendWsRef.current = ws;

  //   return () => {
  //     cleanupBackendWs();
  //   };
  // }, [isStreaming, onTranscription]);

  /* ───── AudioWorklet setup (runs once; NOT tied to modelSpeaking) ───── */
  useEffect(() => {
    if (
      !isStreaming ||
      !stream ||
      !audioCtxRef.current ||
      !isWebSocketReady ||
      isAudioSetup
    )
      return;

    let active = true;
    (async () => {
      try {
        const ctx = audioCtxRef.current!;
        if (ctx.state === "suspended") await ctx.resume();
        await ctx.audioWorklet.addModule("/worklets/audio-processor.js");
        if (!active) return;

        workletRef.current = new AudioWorkletNode(ctx, "audio-processor", {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          processorOptions: { sampleRate: SAMPLE_RATE, bufferSize: 4096 },
          channelCount: 1,
          channelCountMode: "explicit",
          channelInterpretation: "speakers",
        });

        const source = ctx.createMediaStreamSource(stream);
        workletRef.current.port.onmessage = (ev) => {
          if (!active) return;

          const { pcmData, level } = ev.data;
          setAudioLevel(level);

          /* ─── voice-activity detection ─── */
          const now = performance.now();

          if (level >= START_LEVEL && !modelSpeakingRef.current) {
            if (!speakingRef.current) {
              speakingRef.current = true;
              userChunksRef.current = [];
            }
            lastVoiceMsRef.current = now;
          }

          /* buffer only while speaking (and when model isn't talking) */
          if (speakingRef.current && !modelSpeakingRef.current) {
            const pcmArr = new Uint8Array(pcmData);
            userChunksRef.current.push(pcmArr);
          }

          /* always stream raw audio to Gemini */
          sendToGemini(Base64.fromUint8Array(new Uint8Array(pcmData)));

          /* detect end-of-utterance */
          if (
            speakingRef.current &&
            !modelSpeakingRef.current &&
            level <= SILENCE_LEVEL &&
            now - lastVoiceMsRef.current > SILENCE_MS
          ) {
            flushUserAudio();
          }
        };

        source.connect(workletRef.current);
        setIsAudioSetup(true);
      } catch (err) {
        console.error("Audio worklet error:", err);
        cleanupAudio();
        setIsAudioSetup(false);
      }
    })();

    return () => {
      active = false;
      cleanupAudio();
      setIsAudioSetup(false);
    };
  }, [isStreaming, stream, isWebSocketReady, flushUserAudio]);

  // Calculate the number of wave circles to display based on audio level
  const getWaveCircles = () => {
    const activeLevel = isModelSpeaking ? outputAudioLevel : audioLevel;
    // Define how many circles to show at minimum and maximum
    const minCircles = 1;
    const maxCircles = 4;

    // Scale the number of circles based on the audio level
    const scaledCircles = Math.max(
      minCircles,
      Math.round((activeLevel / 100) * maxCircles)
    );

    return Array.from({ length: maxCircles }, (_, i) => {
      const isActive = i < scaledCircles;
      return (
        <div
          key={`wave-${i}`}
          className={`absolute rounded-full border transition-all duration-300 ${
            isActive
              ? isModelSpeaking
                ? "border-blue-400 opacity-70 animate-pulse"
                : "border-purple-400 opacity-70"
              : "border-gray-300 opacity-10"
          }`}
          style={{
            width: `${140 + i * 40}px`,
            height: `${140 + i * 40}px`,
            animationDelay: `${i * 0.2}s`,
            transform: `scale(${isActive ? 1 : 0.8})`,
          }}
        />
      );
    });
  };

  /* ───── Updated UI for Siri-like interface ───── */
  return (
    <div className="flex flex-col items-center justify-center gap-3">
      <div className="relative flex items-center justify-center h-64 w-64">
        {/* Pulsing wave circles */}
        {isStreaming && getWaveCircles()}

        {/* Center microphone button */}
        <button
          onClick={toggleMicrophone}
          className={`relative z-10 flex items-center justify-center w-32 h-32 rounded-full transition-all duration-300 shadow-lg ${
            isStreaming
              ? isModelSpeaking
                ? "bg-blue-500"
                : speakingRef.current
                ? "bg-purple-500"
                : "bg-purple-400"
              : "bg-gray-200 hover:bg-gray-300"
          }`}
        >
          {isStreaming ? (
            <MicOff className="h-10 w-10 text-white" />
          ) : (
            <Mic className="h-10 w-10 text-gray-700" />
          )}
        </button>

        {/* Status text below */}
        <div className="absolute -bottom-12 text-center">
          {isStreaming ? (
            connectionStatus === "connected" ? (
              <span className="text-sm font-medium text-gray-700">
                {isModelSpeaking
                  ? "AI is speaking..."
                  : speakingRef.current
                  ? "Listening..."
                  : "Ready to listen"}
              </span>
            ) : (
              <span className="text-sm font-medium text-amber-600">
                Connecting...
              </span>
            )
          ) : (
            <span className="text-sm font-medium text-gray-500">
              Tap to activate
            </span>
          )}
        </div>

        {/* Loading overlay when connecting */}
        {isStreaming && connectionStatus !== "connected" && (
          <div className="absolute inset-0 bg-black/30 flex items-center justify-center rounded-full backdrop-blur-sm z-20">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white" />
          </div>
        )}
      </div>

      {/* Additional debug information - can be removed in production */}
      {isStreaming && (
        <div className="mt-8 text-xs text-gray-500">
          {isModelSpeaking
            ? `AI Response Level: ${Math.round(outputAudioLevel)}%`
            : `Mic Level: ${Math.round(audioLevel)}%`}
        </div>
      )}
    </div>
  );
}
