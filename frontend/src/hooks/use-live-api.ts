/**
 * Copyright 2024 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  MultimodalLiveAPIClientConnection,
  MultimodalLiveClient,
} from "../lib/multimodal-live-client";
import { LiveConfig, isModelTurn, ModelTurn } from "../multimodal-live-types";
import { AudioStreamer } from "../lib/audio-streamer";
import { audioContext } from "../lib/utils";
import VolMeterWorket from "../lib/worklets/vol-meter";

export type UseLiveAPIResults = {
  client: MultimodalLiveClient;
  setConfig: (config: LiveConfig) => void;
  config: LiveConfig;
  connected: boolean;
  connect: () => Promise<void>;
  disconnect: () => Promise<void>;
  volume: number;
  setMuted: (muted: boolean) => void;
  muted: boolean;
};

export function useLiveAPI({
  url,
  apiKey,
}: MultimodalLiveAPIClientConnection): UseLiveAPIResults {
  const client = useMemo(
    () => new MultimodalLiveClient({ url, apiKey }),
    [url, apiKey],
  );
  const audioStreamerRef = useRef<AudioStreamer | null>(null);
  
  // Buffer management for incoming audio
  const audioBufferQueue = useRef<Uint8Array[]>([]);
  const isProcessingAudio = useRef<boolean>(false);
  const processingTimeoutRef = useRef<number | null>(null);
  const audioContextReadyRef = useRef<boolean>(false);
  
  // Speech state tracking to prevent interruptions
  const isSpeakingRef = useRef<boolean>(false);
  const speechTimeoutRef = useRef<number | null>(null);
  const lastSpeechEndTimeRef = useRef<number>(0);
  
  // Minimum time to wait between speech segments to avoid interruptions
  const MIN_SPEECH_GAP = 500; // milliseconds

  const [connected, setConnected] = useState(false);
  const [config, setConfig] = useState<LiveConfig>({
    model: "models/gemini-2.0-flash-exp",
  });
  const [volume, setVolume] = useState(0);
  const [muted, setMuted] = useState(false);

  // register audio for streaming server -> speakers
  useEffect(() => {
    if (!audioStreamerRef.current) {
      audioContext({ id: "audio-out" }).then((audioCtx: AudioContext) => {
        audioStreamerRef.current = new AudioStreamer(audioCtx);
        audioStreamerRef.current
          .addWorklet<any>("vumeter-out", VolMeterWorket, (ev: any) => {
            setVolume(ev.data.volume);
          })
          .then(() => {
            audioContextReadyRef.current = true;
            // If we have buffered audio waiting to be processed, start processing it
            if (audioBufferQueue.current.length > 0 && !isProcessingAudio.current) {
              processAudioQueue();
            }
          });
      });
    }
  }, [audioStreamerRef]);
  
  // Process audio buffers in a controlled manner to prevent stuttering
  const processAudioQueue = useCallback(() => {
    if (!audioStreamerRef.current || !audioContextReadyRef.current) return;
    
    isProcessingAudio.current = true;
    
    const processNextBuffer = () => {
      if (audioBufferQueue.current.length === 0) {
        isProcessingAudio.current = false;
        return;
      }
      
      const buffer = audioBufferQueue.current.shift();
      if (buffer) {
        audioStreamerRef.current?.addPCM16(buffer);
        
        // Mark that speech is happening
        isSpeakingRef.current = true;
        
        // Clear any existing timeout
        if (speechTimeoutRef.current) {
          window.clearTimeout(speechTimeoutRef.current);
        }
        
        // Set timeout to mark end of speech after a delay
        speechTimeoutRef.current = window.setTimeout(() => {
          isSpeakingRef.current = false;
          lastSpeechEndTimeRef.current = Date.now();
          speechTimeoutRef.current = null;
        }, 1000) as unknown as number;
      }
      
      // Process next buffer with a small delay to avoid audio glitches
      processingTimeoutRef.current = window.setTimeout(processNextBuffer, 10) as unknown as number;
    };
    
    processNextBuffer();
  }, []);

  useEffect(() => {
    const onClose = () => {
      setConnected(false);
    };

    const stopAudioStreamer = () => {
      // Clear all processing and buffers
      if (processingTimeoutRef.current) {
        window.clearTimeout(processingTimeoutRef.current);
        processingTimeoutRef.current = null;
      }
      
      if (speechTimeoutRef.current) {
        window.clearTimeout(speechTimeoutRef.current);
        speechTimeoutRef.current = null;
      }
      
      audioBufferQueue.current = [];
      isProcessingAudio.current = false;
      isSpeakingRef.current = false;
      
      audioStreamerRef.current?.stop();
    };

    const onAudio = (data: ArrayBuffer) => {
      // Instead of directly sending to AudioStreamer, queue the buffer
      const now = Date.now();
      const timeSinceLastSpeech = now - lastSpeechEndTimeRef.current;
      
      // Add the buffer to the queue
      audioBufferQueue.current.push(new Uint8Array(data));
      
      // If we're not currently processing audio and the audio context is ready, start processing
      if (!isProcessingAudio.current && audioContextReadyRef.current &&
          (!isSpeakingRef.current || timeSinceLastSpeech > MIN_SPEECH_GAP)) {
        processAudioQueue();
      }
    };

    // Handle internal commands for muting/unmuting using the content event
    const onContent = (content: any) => {
      if (isModelTurn(content)) {
        const modelTurn = content as ModelTurn;
        const text = modelTurn.modelTurn.parts[0]?.text;
        if (text) {
          if (text === "[INTERNAL_COMMAND]: MUTE_MIC") {
            setMuted(true);
            console.log("Auto-muting microphone due to silence detection");
          } else if (text === "[INTERNAL_COMMAND]: UNMUTE_MIC") {
            setMuted(false);
            console.log("Auto-unmuting microphone due to detected speech");
          }
        }
      }
    };
    
    // Handle when a turn is complete, which means the model has finished speaking
    const onTurnComplete = () => {
      // Allow a small delay for any final audio buffers to be processed
      setTimeout(() => {
        isSpeakingRef.current = false;
        lastSpeechEndTimeRef.current = Date.now();
        
        // If there are still buffers in the queue, make sure they get processed
        if (audioBufferQueue.current.length > 0 && !isProcessingAudio.current) {
          processAudioQueue();
        }
      }, 100);
    };

    client
      .on("close", onClose)
      .on("interrupted", stopAudioStreamer)
      .on("audio", onAudio)
      .on("content", onContent)
      .on("turncomplete", onTurnComplete);

    return () => {
      client
        .off("close", onClose)
        .off("interrupted", stopAudioStreamer)
        .off("audio", onAudio)
        .off("content", onContent)
        .off("turncomplete", onTurnComplete);
    };
  }, [client, processAudioQueue]);

  // Clean up all audio resources when component unmounts
  useEffect(() => {
    return () => {
      if (processingTimeoutRef.current) {
        window.clearTimeout(processingTimeoutRef.current);
      }
      
      if (speechTimeoutRef.current) {
        window.clearTimeout(speechTimeoutRef.current);
      }
      
      audioStreamerRef.current?.stop();
    };
  }, []);

  const connect = useCallback(async () => {
    console.log(config);
    if (!config) {
      throw new Error("config has not been set");
    }
    client.disconnect();
    await client.connect(config);
    setConnected(true);
  }, [client, setConnected, config]);

  const disconnect = useCallback(async () => {
    client.disconnect();
    setConnected(false);
  }, [setConnected, client]);

  return {
    client,
    config,
    setConfig,
    connected,
    connect,
    disconnect,
    volume,
    setMuted,
    muted,
  };
}
