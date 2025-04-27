"use client";

import { Base64 } from "js-base64";
import { Mic, MicOff } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { GeminiWebSocket } from "../app/services/geminiWebSocket";
import { TranscriptionService } from "../app/services/transcriptionService";
import { TtsService } from "../app/services/ttsService";
import { pcmToWav } from "../app/utils/audioUtils";
import { Button } from "./ui/button";

/* ───── VAD tuning ───── */
const START_LEVEL = 5; // % that counts as “voice has started”
const SILENCE_LEVEL = 5; // % considered “quiet”
const SILENCE_MS = 1500; // pause that ends an utterance
const SAMPLE_RATE = 16000;

interface AudioInputProps {
  onTranscription: (
    text: string,
    speaker: "human" | "gemini" | "backend"
  ) => void;
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
        await fetch("http://localhost:8004/query", {
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

          // First, pause any ongoing Gemini audio to avoid overlap
          if (geminiWsRef.current) {
            geminiWsRef.current.pauseAudio();
          }

          // Feed the message as text input to Gemini
          if (geminiWsRef.current) {
            // Optional: add a small delay to ensure any current audio has stopped
            await new Promise((resolve) => setTimeout(resolve, 100));

            // Send the backend message as text input to Gemini
            geminiWsRef.current.sendTextInput(
              `[ANNOUNCEMENT]: ${data.message}`
            );

            // Resume Gemini's audio processing
            geminiWsRef.current.resumeAudio();
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

  /* ───── UI (unchanged except prop) ───── */
  return (
    <div className="space-y-4">
      <div className="relative bg-muted rounded-lg w-[640px] h-[150px] flex items-center justify-center">
        {isStreaming ? (
          <div className="text-center space-y-2">
            <div className="text-lg font-medium">Microphone Active</div>
            <div className="text-sm text-muted-foreground">
              {connectionStatus === "connected"
                ? "Connected to Gemini"
                : "Connecting..."}
            </div>
          </div>
        ) : (
          <div className="text-center space-y-2">
            <div className="text-lg font-medium">Microphone Inactive</div>
            <div className="text-sm text-muted-foreground">
              Click the button below to start
            </div>
          </div>
        )}

        {isStreaming && connectionStatus !== "connected" && (
          <div className="absolute inset-0 bg-black/50 flex items-center justify-center rounded-lg backdrop-blur-sm">
            <div className="text-center space-y-2">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-white mx-auto" />
              <p className="text-white font-medium">
                {connectionStatus === "connecting"
                  ? "Connecting to Gemini..."
                  : "Disconnected"}
              </p>
              <p className="text-white/70 text-sm">
                Please wait while we establish a secure connection
              </p>
            </div>
          </div>
        )}

        <Button
          onClick={toggleMicrophone}
          size="icon"
          className={`absolute left-1/2 bottom-4 -translate-x-1/2 rounded-full w-12 h-12 backdrop-blur-sm transition-colors
            ${
              isStreaming
                ? "bg-red-500/50 hover:bg-red-500/70 text-white"
                : "bg-green-500/50 hover:bg-green-500/70 text-white"
            }`}
        >
          {isStreaming ? (
            <MicOff className="h-6 w-6" />
          ) : (
            <Mic className="h-6 w-6" />
          )}
        </Button>
      </div>

      {isStreaming && (
        <div className="w-[640px] h-2 rounded-full bg-green-100">
          <div
            className="h-full rounded-full transition-all bg-green-500"
            style={{
              width: `${isModelSpeaking ? outputAudioLevel : audioLevel}%`,
              transition: "width 100ms ease-out",
            }}
          />
        </div>
      )}
    </div>
  );
}
