"use client";

import { motion } from "framer-motion";
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
  const [bars, setBars] = useState(Array(50).fill(0));

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
      resetBars();
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

  // Update bars based on audio level
  const updateBars = useCallback((volume: number) => {
    setBars(bars.map(() => Math.random() * volume * 0.5));
  }, []);

  // Reset bars when audio is not streaming
  const resetBars = useCallback(() => {
    setBars(Array(50).fill(0));
  }, []);

  // Update visualizer bars based on audio levels
  useEffect(() => {
    if (isStreaming) {
      const activeLevel = isModelSpeaking ? outputAudioLevel : audioLevel;
      updateBars(activeLevel);
    } else {
      resetBars();
    }
  }, [
    audioLevel,
    outputAudioLevel,
    isModelSpeaking,
    isStreaming,
    updateBars,
    resetBars,
  ]);

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
  }, [isStreaming, onTranscription, cleanupBackendWs]);

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
  }, [isStreaming, stream, isWebSocketReady, flushUserAudio, cleanupAudio]);

  /* ───── Radial Card UI ───── */
  return (
    <div className="border text-center justify-items-center p-4 rounded-2xl">
      <div
        className="flex items-center justify-center h-full relative"
        style={{ width: "300px", height: "300px" }}
      >
        {isStreaming ? (
          <MicOff
            size={24}
            className="text-black dark:text-white"
            onClick={toggleMicrophone}
            style={{ cursor: "pointer", zIndex: 10 }}
          />
        ) : (
          <Mic
            size={28}
            className="text-black dark:text-white"
            onClick={toggleMicrophone}
            style={{ cursor: "pointer", zIndex: 10 }}
          />
        )}
        <svg
          width="100%"
          height="100%"
          viewBox="0 0 300 300"
          style={{ position: "absolute", top: 0, left: 0 }}
        >
          {bars.map((height, index) => {
            const angle = (index / bars.length) * 360;
            const radians = (angle * Math.PI) / 180;
            const x1 = 150 + Math.cos(radians) * 50;
            const y1 = 150 + Math.sin(radians) * 50;
            const x2 = 150 + Math.cos(radians) * (100 + height);
            const y2 = 150 + Math.sin(radians) * (100 + height);

            return (
              <motion.line
                key={index}
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                className="stroke-current text-black dark:text-white dark:opacity-70 opacity-70"
                strokeWidth="2"
                initial={{ x2: x1, y2: y1 }}
                animate={{ x2, y2 }}
                transition={{ type: "spring", stiffness: 300, damping: 20 }}
              />
            );
          })}
        </svg>
        <span className="absolute top-48 w-[calc(100%-70%)] h-[calc(100%-70%)] bg-primary blur-[120px]"></span>

        {/* Status indicator */}
        <div className="absolute -bottom-8 text-center">
          <span className="text-sm font-medium">
            {!isStreaming
              ? "Tap to activate"
              : connectionStatus !== "connected"
              ? "Connecting..."
              : isModelSpeaking
              ? "Gemini is speaking"
              : speakingRef.current
              ? "Listening..."
              : "Ready"}
          </span>
        </div>
      </div>
    </div>
  );
}
