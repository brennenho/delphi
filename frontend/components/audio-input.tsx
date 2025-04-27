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

// Utility to give the worklet a moment to deliver its last buffer
const wait = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

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
    backendWsRef.current?.close();
    backendWsRef.current = null;
    setBackendConnected(false);
  }, []);

  const sendToGemini = (b64: string) =>
    geminiWsRef.current?.sendMediaChunk(b64, "audio/pcm");

  /* ───── flush & transcribe (now **audio‑only** to Gemini) ───── */
  const flushUserAudio = useCallback(
    async (force = false) => {
      if (userChunksRef.current.length === 0) {
        speakingRef.current = false;
        return;
      }

      const total = userChunksRef.current.reduce((acc, c) => acc + c.length, 0);
      const merged = new Uint8Array(total);
      userChunksRef.current.reduce(
        (off, c) => (merged.set(c, off), off + c.length),
        0
      );

      // *** Removed duplicate send to Gemini ***
      // Gemini already received the incremental PCM chunks in realtime.
      // Sending the merged buffer again created a second copy of the query.

      userChunksRef.current = [];
      const wasSpeaking = speakingRef.current || force;
      speakingRef.current = false;

      try {
        if (total > 0 && wasSpeaking) {
          const wav = await pcmToWav(
            Base64.fromUint8Array(merged),
            SAMPLE_RATE
          );
          const text = await transcriptionSvc.current.transcribeAudio(
            wav,
            "audio/wav"
          );

          if (text.trim()) {
            onTranscription(text, "human");

            const isBrowserQuery =
              await transcriptionSvc.current.isBrowserQuery(text);
            if (isBrowserQuery) {
              await fetch("http://localhost:8000/query", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ text }),
              });
            }
          }
        }
      } catch (err) {
        console.error("[UserTranscription] error:", err);
      }
    },
    [onTranscription]
  );

  /* ───── Gemini callback ───── */
  const handleGeminiText = useCallback(
    async (geminiText: string) => {
      await flushUserAudio();
      onTranscription(geminiText, "gemini");
    },
    [flushUserAudio, onTranscription]
  );

  /* ───── mic toggle ───── */
  const toggleMicrophone = async () => {
    // 🔇 turning off ---------------------------------------------------------
    if (isStreaming && stream) {
      await wait(250); // let last worklet message arrive
      await flushUserAudio(true);
      stream.getTracks().forEach((t) => t.stop());
      setStream(null);
      setIsStreaming(false);
      workletRef.current?.disconnect();
      workletRef.current = null;
      return;
    }

    // 🎙️ turning on ----------------------------------------------------------
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
      if (!audioCtxRef.current)
        audioCtxRef.current = new AudioContext({ sampleRate: SAMPLE_RATE });
      setStream(s);
      setIsStreaming(true);
    } catch (err) {
      console.error("getUserMedia failed:", err);
    }
  };

  /* ───── bars visualiser helpers ───── */
  const updateBars = useCallback(
    (vol: number) => setBars((b) => b.map(() => Math.random() * vol * 0.5)),
    []
  );
  const resetBars = useCallback(() => setBars(Array(50).fill(0)), []);

  useEffect(() => {
    const level = isStreaming
      ? isModelSpeaking
        ? outputAudioLevel
        : audioLevel
      : isModelSpeaking
      ? outputAudioLevel
      : 0;
    level > 0 ? updateBars(level) : resetBars();
  }, [
    audioLevel,
    outputAudioLevel,
    isModelSpeaking,
    isStreaming,
    updateBars,
    resetBars,
  ]);

  /* ───── WebSocket setup ───── */
  useEffect(() => {
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

    ttsServiceRef.current = new TtsService((isPlay) => {
      if (!isPlay && geminiWsRef.current && !modelSpeakingRef.current)
        geminiWsRef.current.resumeAudio();
    });

    const ws = new WebSocket("ws://localhost:8004/ws/1");
    ws.onopen = () => setBackendConnected(true);
    ws.onmessage = async ({ data }) => {
      try {
        const { message } = JSON.parse(data);
        if (message) {
          geminiWsRef.current?.pauseAudio();
          await ttsServiceRef.current?.speak(message);
          geminiWsRef.current?.resumeAudio();
        }
      } catch (e) {
        console.error("[Backend WS]", e);
      }
    };
    ws.onclose = () => setBackendConnected(false);
    ws.onerror = console.error;
    backendWsRef.current = ws;

    return () => {
      cleanupWs();
      setIsWebSocketReady(false);
      cleanupBackendWs();
      cleanupAudio();
    };
  }, [handleGeminiText, cleanupWs, cleanupBackendWs, cleanupAudio]);

  /* ───── AudioWorklet setup ───── */
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

        const src = ctx.createMediaStreamSource(stream);
        workletRef.current.port.onmessage = ({ data: { pcmData, level } }) => {
          if (!active) return;
          setAudioLevel(level);

          const now = performance.now();
          if (level >= START_LEVEL && !modelSpeakingRef.current) {
            if (!speakingRef.current) {
              speakingRef.current = true;
              userChunksRef.current = [];
            }
            lastVoiceMsRef.current = now;
          }

          if (speakingRef.current && !modelSpeakingRef.current)
            userChunksRef.current.push(new Uint8Array(pcmData));

          sendToGemini(Base64.fromUint8Array(new Uint8Array(pcmData)));

          if (
            speakingRef.current &&
            !modelSpeakingRef.current &&
            level <= SILENCE_LEVEL &&
            now - lastVoiceMsRef.current > SILENCE_MS
          )
            flushUserAudio();
        };

        src.connect(workletRef.current);
        setIsAudioSetup(true);
      } catch (err) {
        console.error("Audio worklet error:", err);
        workletRef.current?.disconnect();
        workletRef.current = null;
        setIsAudioSetup(false);
      }
    })();

    return () => {
      active = false;
      workletRef.current?.disconnect();
      workletRef.current = null;
      setIsAudioSetup(false);
    };
  }, [isStreaming, stream, isWebSocketReady, flushUserAudio]);

  /* ───── UI ───── */
  return (
    <div
      className="text-center p-4 rounded-2xl cursor-pointer"
      onClick={toggleMicrophone}
    >
      <div
        className="flex items-center justify-center h-full relative"
        style={{ width: 300, height: 300 }}
      >
        {isStreaming ? (
          <MicOff size={24} className="text-red-700" style={{ zIndex: 10 }} />
        ) : (
          <Mic
            size={28}
            className="text-indigo-500 animate-pulse"
            style={{ zIndex: 10 }}
          />
        )}
        <svg
          width="100%"
          height="100%"
          viewBox="0 0 300 300"
          style={{ position: "absolute", top: 0, left: 0 }}
        >
          {bars.map((h, i) => {
            const angle = (i / bars.length) * 360;
            const rad = (angle * Math.PI) / 180;
            const x1 = 150 + Math.cos(rad) * 50;
            const y1 = 150 + Math.sin(rad) * 50;
            const x2 = 150 + Math.cos(rad) * (100 + h);
            const y2 = 150 + Math.sin(rad) * (100 + h);
            return (
              <motion.line
                key={i}
                x1={x1}
                y1={y1}
                x2={x2}
                y2={y2}
                className="stroke-current text-indigo-500 dark:text-white opacity-70"
                strokeWidth="2"
                initial={{ x2: x1, y2: y1 }}
                animate={{ x2, y2 }}
                transition={{ type: "spring", stiffness: 300, damping: 20 }}
              />
            );
          })}
        </svg>
        <span className="absolute top-48 w-1/3 h-1/3 bg-primary blur-[120px]" />
        <div className="absolute -bottom-4 text-center text-sm font-medium">
          {connectionStatus !== "connected"
            ? "connecting..."
            : isModelSpeaking
            ? "delphi is speaking"
            : isStreaming
            ? speakingRef.current
              ? "listening..."
              : "ready for input"
            : "mic off - tap to enable"}
        </div>
      </div>
    </div>
  );
}
