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

import { Content, GenerativeContentBlob, Part } from "@google/generative-ai";
import { EventEmitter } from "eventemitter3";
import { difference } from "lodash";
import {
  ClientContentMessage,
  isInterrupted,
  isModelTurn,
  isServerContentMessage,
  isSetupCompleteMessage,
  isToolCallCancellationMessage,
  isToolCallMessage,
  isTurnComplete,
  LiveIncomingMessage,
  ModelTurn,
  RealtimeInputMessage,
  ServerContent,
  SetupMessage,
  StreamingLog,
  ToolCall,
  ToolCallCancellation,
  ToolResponseMessage,
  type LiveConfig,
} from "../multimodal-live-types";
import { blobToJSON, base64ToArrayBuffer } from "./utils";

/**
 * the events that this client will emit
 */
interface MultimodalLiveClientEventTypes {
  open: () => void;
  log: (log: StreamingLog) => void;
  close: (event: CloseEvent) => void;
  audio: (data: ArrayBuffer) => void;
  content: (data: ServerContent) => void;
  interrupted: () => void;
  setupcomplete: () => void;
  turncomplete: () => void;
  toolcall: (toolCall: ToolCall) => void;
  toolcallcancellation: (toolcallCancellation: ToolCallCancellation) => void;
}

export type MultimodalLiveAPIClientConnection = {
  url?: string;
  apiKey: string;
};

/**
 * A event-emitting class that manages the connection to the websocket and emits
 * events to the rest of the application.
 * If you dont want to use react you can still use this.
 */
export class MultimodalLiveClient extends EventEmitter<MultimodalLiveClientEventTypes> {
  public ws: WebSocket | null = null;
  protected config: LiveConfig | null = null;
  public url: string = "";
  public getConfig() {
    return { ...this.config };
  }

  constructor({ url, apiKey }: MultimodalLiveAPIClientConnection) {
    super();
    url =
      url ||
      `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent`;
    url += `?key=${apiKey}`;
    this.url = url;
    this.send = this.send.bind(this);
  }

  log(type: string, message: StreamingLog["message"]) {
    const log: StreamingLog = {
      date: new Date(),
      type,
      message,
    };
    this.emit("log", log);
  }

  connect(config: LiveConfig): Promise<boolean> {
    this.config = config;

    const ws = new WebSocket(this.url);

    ws.addEventListener("message", async (evt: MessageEvent) => {
      if (evt.data instanceof Blob) {
        this.receive(evt.data);
      } else {
        console.log("non blob message", evt);
      }
    });
    return new Promise((resolve, reject) => {
      const onError = (ev: Event) => {
        this.disconnect(ws);
        const message = `Could not connect to "${this.url}"`;
        this.log(`server.${ev.type}`, message);
        reject(new Error(message));
      };
      ws.addEventListener("error", onError);
      ws.addEventListener("open", (ev: Event) => {
        if (!this.config) {
          reject("Invalid config sent to `connect(config)`");
          return;
        }
        this.log(`client.${ev.type}`, `connected to socket`);
        this.emit("open");

        this.ws = ws;

        const setupMessage: SetupMessage = {
          setup: this.config,
        };
        this._sendDirect(setupMessage);
        this.log("client.send", "setup");

        ws.removeEventListener("error", onError);
        ws.addEventListener("close", (ev: CloseEvent) => {
          this.disconnect(ws);
          let reason = ev.reason || "";
          if (reason.toLowerCase().includes("error")) {
            const prelude = "ERROR]";
            const preludeIndex = reason.indexOf(prelude);
            if (preludeIndex > 0) {
              reason = reason.slice(
                preludeIndex + prelude.length + 1,
                Infinity
              );
            }
          }
          this.log(
            `server.${ev.type}`,
            `disconnected ${reason ? `with reason: ${reason}` : ``}`
          );
          this.emit("close", ev);
        });
        resolve(true);
      });
    });
  }

  disconnect(ws?: WebSocket) {
    // could be that this is an old websocket and theres already a new instance
    // only close it if its still the correct reference
    if ((!ws || this.ws === ws) && this.ws) {
      this.ws.close();
      this.ws = null;
      this.log("client.close", `Disconnected`);
      return true;
    }
    return false;
  }

  protected async receive(blob: Blob) {
    const response: LiveIncomingMessage = (await blobToJSON(
      blob
    )) as LiveIncomingMessage;

    if (isToolCallMessage(response)) {
      this.emit("toolcall", response.toolCall);
      return;
    }
    if (isToolCallCancellationMessage(response)) {
      this.emit("toolcallcancellation", response.toolCallCancellation);
      return;
    }
    if (isSetupCompleteMessage(response)) {
      this.emit("setupcomplete");
      return;
    }

    if (isServerContentMessage(response)) {
      const { serverContent } = response;
      if (isInterrupted(serverContent)) {
        this.log("receive.serverContent", "interrupted");
        
        // First emit the interrupted event to clear any pending audio
        this.emit("interrupted");
        
        // Wait for clean-up before signaling turn completion
        setTimeout(() => {
          this.emit("turncomplete");
        }, 700);  // Increased from 500ms to 700ms for more clean-up time
        return;
      }
      
      if (isTurnComplete(serverContent)) {
        this.log("server.send", "turnComplete");
        
        // Allow a small delay before emitting the turn complete event
        // to ensure all audio processing is finished
        setTimeout(() => {
          this.emit("turncomplete");
        }, 150);
        
        // Don't return here as there might be more content in this message
      }

      if (isModelTurn(serverContent)) {
        let parts: Part[] = serverContent.modelTurn.parts;

        // When it's audio that is returned for modelTurn
        const audioParts = parts.filter(
          (p) => p.inlineData && p.inlineData.mimeType.startsWith("audio/pcm")
        );
        
        // Get all audio base64 data
        const base64s = audioParts.map((p) => p.inlineData?.data);

        // Strip the audio parts out of the modelTurn
        const otherParts = difference(parts, audioParts);
        
        // Group audio parts to avoid tiny chunks
        // Process the audio chunks in larger batches for smoother playback
        if (base64s.length > 0) {
          // Use a batch size that's appropriate for the audio
          const BATCH_SIZE = 3; // Process 3 chunks at a time
          
          for (let i = 0; i < base64s.length; i += BATCH_SIZE) {
            // Combine the chunks in this batch
            const batchChunks = base64s.slice(i, i + BATCH_SIZE).filter(Boolean);
            
            // Convert and emit each chunk in the batch
            for (const b64 of batchChunks) {
              if (b64) {
                const data = base64ToArrayBuffer(b64);
                this.emit("audio", data);
                this.log(`server.audio`, `buffer (${data.byteLength})`);
              }
            }
            
            // Small delay between batches to help with processing
            // This helps prevent buffer overflow while still maintaining 
            // a smooth audio experience
            if (i + BATCH_SIZE < base64s.length) {
              await new Promise(resolve => setTimeout(resolve, 10));
            }
          }
        }
        
        if (!otherParts.length) {
          return;
        }

        // Process the non-audio parts
        parts = otherParts;
        
        // Text processing - special handling for repeated content
        // This helps avoid the model repeating itself in speech
        if (parts.length > 0 && parts[0].text) {
          const content: ModelTurn = { 
            modelTurn: { 
              parts: otherParts.map(part => {
                // If this is text, check for repetitive phrases and remove them
                if (part.text) {
                  const text = this.removeRepeatedPhrases(part.text);
                  return { ...part, text };
                }
                return part;
              }) 
            } 
          };
          this.emit("content", content);
        } else {
          const content: ModelTurn = { modelTurn: { parts } };
          this.emit("content", content);
        }
        
        this.log(`server.content`, response);
      }
    } else {
      console.log("received unmatched message", response);
    }
  }
  
  // Helper method to detect and remove repetitive text patterns
  // This helps prevent the model from repeating itself in speech
  private removeRepeatedPhrases(text: string): string {
    // If text is very short, no need to process
    if (text.length < 10) return text;
    
    // Split into sentences
    const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 0);
    
    // If only one sentence, return as is
    if (sentences.length <= 1) return text;
    
    // Build a set of unique sentences to avoid repetition
    const uniqueSentences: string[] = [];
    const seenContent = new Set<string>();
    
    for (const sentence of sentences) {
      const trimmed = sentence.trim();
      
      // Skip very short sentences
      if (trimmed.length < 3) continue;
      
      // Normalize the sentence for comparison
      const normalized = trimmed.toLowerCase().replace(/\s+/g, ' ');
      
      // Check if we've seen similar content
      let isDuplicate = false;
      
      for (const seen of seenContent) {
        // Check for substantial overlap or if one contains the other
        if (normalized.includes(seen) || seen.includes(normalized) ||
            this.calculateSimilarity(normalized, seen) > 0.7) {
          isDuplicate = true;
          break;
        }
      }
      
      if (!isDuplicate) {
        uniqueSentences.push(trimmed);
        seenContent.add(normalized);
      }
    }
    
    // Return the filtered text
    return uniqueSentences.join('. ') + (text.endsWith('.') ? '.' : '');
  }
  
  // Calculate similarity between two strings (Jaccard similarity)
  private calculateSimilarity(str1: string, str2: string): number {
    const set1 = new Set(str1.split(' '));
    const set2 = new Set(str2.split(' '));
    
    // Calculate intersection size
    const intersection = new Set([...set1].filter(x => set2.has(x)));
    
    // Calculate union size
    const union = new Set([...set1, ...set2]);
    
    return intersection.size / union.size;
  }

  /**
   * send realtimeInput, this is base64 chunks of "audio/pcm" and/or "image/jpg"
   */
  sendRealtimeInput(chunks: GenerativeContentBlob[]) {
    let hasAudio = false;
    let hasVideo = false;
    for (let i = 0; i < chunks.length; i++) {
      const ch = chunks[i];
      if (ch.mimeType.includes("audio")) {
        hasAudio = true;
      }
      if (ch.mimeType.includes("image")) {
        hasVideo = true;
      }
      if (hasAudio && hasVideo) {
        break;
      }
    }
    const message =
      hasAudio && hasVideo
        ? "audio + video"
        : hasAudio
        ? "audio"
        : hasVideo
        ? "video"
        : "unknown";

    const data: RealtimeInputMessage = {
      realtimeInput: {
        mediaChunks: chunks,
      },
    };
    this._sendDirect(data);
    this.log(`client.realtimeInput`, message);
  }

  /**
   *  send a response to a function call and provide the id of the functions you are responding to
   */
  sendToolResponse(toolResponse: ToolResponseMessage["toolResponse"]) {
    const message: ToolResponseMessage = {
      toolResponse,
    };

    this._sendDirect(message);
    this.log(`client.toolResponse`, message);
  }

  /**
   * send normal content parts such as { text }
   */
  send(parts: Part | Part[], turnComplete: boolean = true) {
    parts = Array.isArray(parts) ? parts : [parts];
    const content: Content = {
      role: "user",
      parts,
    };

    const clientContentRequest: ClientContentMessage = {
      clientContent: {
        turns: [content],
        turnComplete,
      },
    };

    this._sendDirect(clientContentRequest);
    this.log(`client.send`, clientContentRequest);
  }

  /**
   *  used internally to send all messages
   *  don't use directly unless trying to send an unsupported message type
   */
  _sendDirect(request: object) {
    if (!this.ws) {
      throw new Error("WebSocket is not connected");
    }
    const str = JSON.stringify(request);
    this.ws.send(str);
  }
}
