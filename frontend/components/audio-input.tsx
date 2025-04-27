"use client";

import { Base64 } from "js-base64";
import { Mic, MicOff } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { GeminiWebSocket } from "../app/services/geminiWebSocket";
import { TranscriptionService } from "../app/services/transcriptionService";
import { pcmToWav } from "../app/utils/audioUtils";
import { Button } from "./ui/button";

interface AudioInputProps {
  onTranscription: (text: string, speaker: "human" | "gemini") => void;
}

export default function AudioInput({ onTranscription }: AudioInputProps) {
  const audioContextRef = useRef<AudioContext | null>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [audioLevel, setAudioLevel] = useState(0);
  const geminiWsRef = useRef<GeminiWebSocket | null>(null);
  const audioWorkletNodeRef = useRef<AudioWorkletNode | null>(null);
  const [isAudioSetup, setIsAudioSetup] = useState(false);
  const setupInProgressRef = useRef(false);
  const [isWebSocketReady, setIsWebSocketReady] = useState(false);
  const [isModelSpeaking, setIsModelSpeaking] = useState(false);
  const [outputAudioLevel, setOutputAudioLevel] = useState(0);
  const [connectionStatus, setConnectionStatus] = useState<
    "disconnected" | "connecting" | "connected"
  >("disconnected");

  /* ──────────── NEW: buffer raw PCM, not base-64 ──────────── */
  const userChunksRef = useRef<Uint8Array[]>([]);
  const transcriptionServiceRef = useRef(new TranscriptionService());

  /* ──────────── helpers ──────────── */

  const cleanupAudio = useCallback(() => {
    if (audioWorkletNodeRef.current) {
      audioWorkletNodeRef.current.disconnect();
      audioWorkletNodeRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close();
      audioContextRef.current = null;
    }
  }, []);

  const cleanupWebSocket = useCallback(() => {
    if (geminiWsRef.current) {
      geminiWsRef.current.disconnect();
      geminiWsRef.current = null;
    }
  }, []);

  const sendAudioData = (b64Data: string) => {
    geminiWsRef.current?.sendMediaChunk(b64Data, "audio/pcm");
  };

  /* Flush → WAV → text */
  const flushUserAudio = useCallback(async () => {
    if (userChunksRef.current.length === 0) return;

    /* concat Uint8Array[] -> one Uint8Array */
    const total = userChunksRef.current.reduce((sum, c) => sum + c.length, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const c of userChunksRef.current) {
      merged.set(c, offset);
      offset += c.length;
    }
    const b64 = Base64.fromUint8Array(merged);

    try {
      const wav = await pcmToWav(b64, 16000);
      const txt = await transcriptionServiceRef.current.transcribeAudio(
        wav,
        "audio/wav"
      );
      onTranscription(txt, "human");
    } catch (err) {
      console.error("[UserTranscription] error:", err);
    } finally {
      userChunksRef.current = [];
    }
  }, [onTranscription]);

  /* Gemini transcription wrapper */
  const handleGeminiTranscription = useCallback(
    async (geminiText: string) => {
      await flushUserAudio(); // user first
      onTranscription(geminiText, "gemini");
    },
    [flushUserAudio, onTranscription]
  );

  /* ──────────── mic toggle ──────────── */

  const toggleMicrophone = async () => {
    if (isStreaming && stream) {
      setIsStreaming(false);
      cleanupWebSocket();
      cleanupAudio();
      stream.getTracks().forEach((t) => t.stop());
      setStream(null);
      userChunksRef.current = [];
      return;
    }

    try {
      const audioStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 16000,
          channelCount: 1,
          echoCancellation: true,
          autoGainControl: true,
          noiseSuppression: true,
        },
      });
      audioContextRef.current = new AudioContext({ sampleRate: 16000 });
      setStream(audioStream);
      setIsStreaming(true);
    } catch (err) {
      console.error("Error accessing audio devices:", err);
      cleanupAudio();
    }
  };

  /* ──────────── WebSocket ──────────── */

  useEffect(() => {
    if (!isStreaming) {
      setConnectionStatus("disconnected");
      return;
    }

    setConnectionStatus("connecting");
    geminiWsRef.current = new GeminiWebSocket(
      (txt) => console.log("Received from Gemini:", txt),
      () => {
        setIsWebSocketReady(true);
        setConnectionStatus("connected");
      },
      (playing) => setIsModelSpeaking(playing),
      (level) => setOutputAudioLevel(level),
      handleGeminiTranscription
    );
    geminiWsRef.current.connect();

    return () => {
      cleanupWebSocket();
      setIsWebSocketReady(false);
      setConnectionStatus("disconnected");
    };
  }, [isStreaming, handleGeminiTranscription, cleanupWebSocket]);

  /* ──────────── audio worklet ──────────── */

  useEffect(() => {
    if (
      !isStreaming ||
      !stream ||
      !audioContextRef.current ||
      !isWebSocketReady ||
      isAudioSetup ||
      setupInProgressRef.current
    )
      return;

    let active = true;
    setupInProgressRef.current = true;

    const setupAudioProcessing = async () => {
      try {
        const ctx = audioContextRef.current;
        if (!ctx || ctx.state === "closed" || !active) return;

        if (ctx.state === "suspended") await ctx.resume();
        await ctx.audioWorklet.addModule("/worklets/audio-processor.js");

        if (!active) return;

        audioWorkletNodeRef.current = new AudioWorkletNode(
          ctx,
          "audio-processor",
          {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            processorOptions: { sampleRate: 16000, bufferSize: 4096 },
            channelCount: 1,
            channelCountMode: "explicit",
            channelInterpretation: "speakers",
          }
        );

        const source = ctx.createMediaStreamSource(stream);
        audioWorkletNodeRef.current.port.onmessage = (e) => {
          if (!active || isModelSpeaking) return;

          const { pcmData, level } = e.data;
          setAudioLevel(level);

          const pcmArray = new Uint8Array(pcmData);
          const b64 = Base64.fromUint8Array(pcmArray);

          userChunksRef.current.push(pcmArray); // raw bytes
          sendAudioData(b64); // to Gemini
        };

        source.connect(audioWorkletNodeRef.current);
        setIsAudioSetup(true);
      } catch (err) {
        cleanupAudio();
        setIsAudioSetup(false);
      } finally {
        setupInProgressRef.current = false;
      }
    };

    setupAudioProcessing();

    return () => {
      active = false;
      setIsAudioSetup(false);
      setupInProgressRef.current = false;
      if (audioWorkletNodeRef.current) {
        audioWorkletNodeRef.current.disconnect();
        audioWorkletNodeRef.current = null;
      }
    };
  }, [isStreaming, stream, isWebSocketReady, isModelSpeaking]);

  /* ──────────── UI (unchanged) ──────────── */

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
