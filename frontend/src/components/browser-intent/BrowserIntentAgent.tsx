/**
 * Browser Intent Agent - Captures and logs user's spoken browser navigation intents
 */
import { type FunctionDeclaration, SchemaType } from "@google/generative-ai";
import { memo, useEffect, useRef, useState } from "react";
import { useLiveAPIContext } from "../../contexts/LiveAPIContext";
import { ToolCall } from "../../multimodal-live-types";
import "./BrowserIntentAgent.scss";

// Object to store and format browser intents
interface BrowserIntent {
  id: string;
  action: string;
  target: string;
  rawText: string;
  timestamp: number;
}

// ─── 1) Define the function schema ────────────────────────────────────────────
const logIntentDeclaration: FunctionDeclaration = {
  name: "log_browser_intent",
  description:
    "Logs a structured browser intent (action, target, rawText) into the app.",
  parameters: {
    type: SchemaType.OBJECT,
    properties: {
      action: {
        type: SchemaType.STRING,
        description:
          "The extracted browser action, e.g. SEARCH, NAVIGATE, CLICK.",
      },
      target: {
        type: SchemaType.STRING,
        description:
          "What the action applies to (URL, search term, selector, etc.).",
      },
      rawText: {
        type: SchemaType.STRING,
        description: "The user's original spoken command.",
      },
    },
    required: ["action", "target", "rawText"],
  },
};

function BrowserIntentAgentComponent() {
  const [intents, setIntents] = useState<BrowserIntent[]>([]);
  const [isListening, setIsListening] = useState<boolean>(false);
  const [currentVolume, setCurrentVolume] = useState<number>(0);
  const { client, setConfig, volume, muted, setMuted } = useLiveAPIContext();
  // More aggressive debouncing strategy
  const lastIntentTimestampRef = useRef<number>(0);
  const lastIntentTextRef = useRef<string>("");
  const lastActionTargetRef = useRef<string>("");
  const processingIntentRef = useRef<boolean>(false);
  // Configure debounce thresholds (in milliseconds)
  const TEXT_DEBOUNCE_THRESHOLD = 2000; // For exact text matches
  const ACTION_DEBOUNCE_THRESHOLD = 3500; // For same action+target

  // Auto-mute functionality
  const [autoMuteEnabled, setAutoMuteEnabled] = useState<boolean>(true);
  const silenceTimerRef = useRef<number | null>(null);
  const silenceThreshold = 0.05; // Volume threshold to consider as silence
  const silenceDuration = 2000; // Duration of silence before muting (milliseconds)
  const lastVolumeTimeRef = useRef<number>(Date.now());
  const lastResponseTimeRef = useRef<number>(0); // Track when the last response was received
  const responseCooldownPeriod = 3000; // Don't auto-mute for 3 seconds after receiving a response

  // ─── 2) Tell Gemini about our function, and instruct it to call it ─────────
  useEffect(() => {
    setConfig({
      model: "models/gemini-2.0-flash-exp",
      generationConfig: {
        responseModalities: "audio",
        temperature: 0.2, // Lower temperature for more deterministic responses
        maxOutputTokens: 100, // Limit output length to avoid long rambling responses
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } },
        },
      },
      systemInstruction: {
        parts: [
          {
            text: `
            You are an intelligent browser assistant that helps users navigate the web through voice commands.
            Your goal is to understand and process browser actions from natural conversation with maximum efficiency.

            # NO QUESTIONS - ABSOLUTE HIGHEST PRIORITY
            - NEVER ask follow-up questions under any circumstances
            - Provide ONLY definitive statements about actions being taken
            - Assume user intent without seeking clarification
            - When uncertain, choose the most likely interpretation and proceed
            - End every response with a period, never a question mark
            - Focus solely on what you are doing, not what might come next
            - Skip all offers of additional help or information

            # ZERO REPETITION - HIGHEST PRIORITY
            - NEVER repeat words, phrases, or concepts within the same response
            - Each statement must contain 100% new information
            - If uncertain whether content was delivered, assume it was and NEVER repeat it
            - Use distinct vocabulary and phrasing for each sentence
            - AVOID echoing user words back unless absolutely necessary
            - Skip all acknowledgment phrases (like "okay," "sure," "got it")

            # SPEECH COHERENCE
            - Use complete, self-contained sentences with natural flow
            - Start sentences directly with key information
            - Use simple punctuation (periods, commas only)
            - Keep sentences under 15 words for optimal delivery
            - Create clear speech boundaries between concepts

            # SYSTEM UPDATES HANDLING
            When receiving messages starting with "[UPDATE]:", this is critical browser state information:
            - Begin response with the new information directly (no prefix)
            - Present as newly discovered fact without referencing update process
            - Never reference having received an update
            - Base conversation solely on this new information
            - Provide ONLY definitive statements about what you see, never questions

            # Response Style
            - Use FUTURE TENSE for actions ("I'll search" NOT "Searching")
            - One concise sentence per action when possible
            - Skip all preambles and acknowledgments
            - State actions without explaining them
            - End with definitive period, never seeking user input

            # Browser Intent Extraction
            For each request, extract:
            - ACTION: The browser operation (SEARCH, NAVIGATE, OPEN, etc.)
            - TARGET: What the action applies to (URL, search query, element, etc.)

            # Function Usage
            - Call log_browser_intent() EXACTLY ONCE per task
            - With ambiguous requests, choose most likely interpretation
            - For non-browser requests, respond with factual statement only

            # Examples:
            User: "Look up weather for Chicago"
            Response: "I'll check Chicago's weather."
            Function: log_browser_intent({action: "SEARCH", target: "weather Chicago", rawText: "Look up weather for Chicago"})

            User: "Search Amazon for tennis shoes"
            Response: "I'll search Amazon for tennis shoes."
            Function: log_browser_intent({action: "NAVIGATE", target: "Amazon", rawText: "Search Amazon for tennis shoes"})
            Function: log_browser_intent({action: "SEARCH", target: "tennis shoes", rawText: "Search Amazon for tennis shoes"})
            System: "[UPDATE]: Amazon is open. There is a list of available shoes."
            Response: "Tennis shoes available on Amazon."

            User: "Go back"
            Response: "I'll go back."
            Function: log_browser_intent({action: "GO_BACK", target: "previous page", rawText: "Go back"})

            User: "What's the capital of France?"
            Response: "Paris is the capital of France."
            [No function call for information requests]
            `,
          },
        ],
      },
      tools: [
        { googleSearch: {} },
        { functionDeclarations: [logIntentDeclaration] },
      ],
    });
  }, [setConfig]);

  // ─── 3) Volume bar visualizer ────────────────────────────────────────────────
  useEffect(() => {
    setCurrentVolume(volume);
    setIsListening(volume > 0.01);

    // Auto-mute functionality
    if (autoMuteEnabled) {
      const now = Date.now();
      
      // Don't auto-mute during the cooldown period after a response
      const isInResponseCooldown = now - lastResponseTimeRef.current < responseCooldownPeriod;
      
      // If volume is above threshold, consider as speaking
      if (volume > silenceThreshold) {
        lastVolumeTimeRef.current = now;
        
        // If mic was muted, unmute it
        if (muted) {
          setMuted(false);
          console.log("Auto-unmuting microphone due to detected speech");
        }
        
        // Clear any existing silence timer
        if (silenceTimerRef.current) {
          clearTimeout(silenceTimerRef.current);
          silenceTimerRef.current = null;
        }
      } 
      // If volume is below threshold and mic is not muted, start silence timer
      // But not during response cooldown period
      else if (!muted && !isInResponseCooldown && now - lastVolumeTimeRef.current > 500) {
        if (!silenceTimerRef.current) {
          silenceTimerRef.current = window.setTimeout(() => {
            // Double-check we're not in a cooldown period before muting
            if (Date.now() - lastResponseTimeRef.current >= responseCooldownPeriod) {
              // Mute the mic after silence duration
              setMuted(true);
              console.log("Auto-muting microphone due to silence detection");
            }
            silenceTimerRef.current = null;
          }, silenceDuration);
        }
      }
    }
  }, [volume, autoMuteEnabled, setMuted, muted]);

  // ─── 4) Listen for Gemini function-calls and log intents ───────────────────
  useEffect(() => {
    const onToolCall = async (toolCall: ToolCall) => {
      // Find our specific function invocation
      const fc = toolCall.functionCalls.find(
        (f) => f.name === logIntentDeclaration.name
      );
      if (!fc) return;

      // Update the last response time to prevent auto-muting during/immediately after responses
      lastResponseTimeRef.current = Date.now();

      // Pull out the structured arguments
      const { action, target, rawText } = fc.args as {
        action: string;
        target: string;
        rawText: string;
      };

      // Enhanced duplicate detection logic
      const now = Date.now();
      const actionTargetKey = `${action}:${target}`;

      // Check if we're still processing a previous intent
      if (processingIntentRef.current) {
        console.log("Still processing previous intent, skipping:", rawText);
        client.sendToolResponse({
          functionResponses: [
            {
              id: fc.id,
              response: { output: { success: true, skipped: true } },
            },
          ],
        });
        return;
      }

      // Check for three types of duplicates:
      // 1. Exact same text (most strict)
      // 2. Same action+target combo (less strict but catches rephrased commands)
      // 3. Rapid succession of any commands (throttling)
      const isExactDuplicate =
        rawText === lastIntentTextRef.current &&
        now - lastIntentTimestampRef.current < TEXT_DEBOUNCE_THRESHOLD;

      const isActionTargetDuplicate =
        actionTargetKey === lastActionTargetRef.current &&
        now - lastIntentTimestampRef.current < ACTION_DEBOUNCE_THRESHOLD;

      const isThrottled = now - lastIntentTimestampRef.current < 1000;

      const isDuplicate =
        isExactDuplicate || isActionTargetDuplicate || isThrottled;

      // Log the specific type of duplicate for debugging
      if (isDuplicate) {
        console.log(
          `Skipping duplicate intent: ${
            isExactDuplicate
              ? "exact text match"
              : isActionTargetDuplicate
              ? "action+target match"
              : "throttled"
          }`,
          { rawText, action, target }
        );

        // Still acknowledge to the LLM that the call succeeded
        client.sendToolResponse({
          functionResponses: [
            {
              id: fc.id,
              response: {
                output: {
                  success: true,
                  duplicateType: isExactDuplicate
                    ? "exact"
                    : isActionTargetDuplicate
                    ? "actionTarget"
                    : "throttled",
                },
              },
            },
          ],
        });
        return;
      }

      // Set processing flag to true to prevent parallel processing of intents
      processingIntentRef.current = true;

      // Update refs for the next call
      lastIntentTextRef.current = rawText;
      lastActionTargetRef.current = actionTargetKey;
      lastIntentTimestampRef.current = now;

      try {
        // Ensure we don't have any active audio playback before processing a new intent
        // This helps prevent audio overlap between responses
        await new Promise(resolve => setTimeout(resolve, 100));
        
        // Make the API call with a timeout to prevent hanging requests
        const fetchPromise = fetch("http://localhost:8000/query", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            action,
            target,
            rawText,
          }),
        });
        
        // Add a timeout to prevent hanging
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error("Request timeout")), 5000);
        });
        
        const response = await Promise.race([fetchPromise, timeoutPromise]) as Response;

        if (!response.ok) {
          console.error("Failed to log intent:", response.statusText);
          throw new Error(`HTTP error ${response.status}: ${response.statusText}`);
        }

        const responseText = await response.text();
        console.log("Sending response to Gemini:", responseText);
        
        // Add a small delay before sending the update to give time for audio to finish
        await new Promise(resolve => setTimeout(resolve, 200));
        
        // Send update to Gemini with a clear prefix format
        client.send({ text: `[UPDATE]: ${responseText}` });

        const newIntent: BrowserIntent = {
          id: `intent-${now}-${Math.random().toString(36).slice(2, 7)}`,
          action,
          target,
          rawText,
          timestamp: now,
        };

        // Append to our UI log
        setIntents((prev) => [...prev, newIntent]);

        // Acknowledge back to the LLM that the call succeeded
        client.sendToolResponse({
          functionResponses: [
            {
              id: fc.id,
              response: { output: { success: true } },
            },
          ],
        });
      } catch (error) {
        console.error("Error processing intent:", error);
        
        // Still acknowledge to prevent the model from hanging
        client.sendToolResponse({
          functionResponses: [
            {
              id: fc.id,
              response: { 
                output: { 
                  success: false,
                  error: error instanceof Error ? error.message : String(error)
                } 
              },
            },
          ],
        });
      } finally {
        // Release the processing lock after a delay
        // Using a longer delay to ensure responses have time to be processed
        setTimeout(() => {
          processingIntentRef.current = false;
        }, 2000);
      }
    };

    // Also track content events to update the last response time
    const onContent = () => {
      lastResponseTimeRef.current = Date.now();
    };

    client.on("toolcall", onToolCall);
    client.on("content", onContent);
    
    return () => {
      client.off("toolcall", onToolCall);
      client.off("content", onContent);
    };
  }, [client]);

  // ─── 5) Render UI ───────────────────────────────────────────────────────────
  // const generateVoiceBars = () => {
  //   const bars = [];
  //   const barCount = 5;
  //   for (let i = 0; i < barCount; i++) {
  //     let height = currentVolume * 100;
  //     if (isListening) {
  //       height = Math.min(
  //         100,
  //         Math.max(5, height * (0.7 + Math.random() * 0.6))
  //       );
  //     } else {
  //       height = 5;
  //     }
  //     bars.push(
  //       <div key={i} className="voice-bar" style={{ height: `${height}%` }} />
  //     );
  //   }
  //   return bars;
  // };

  return (
    <div className="browser-intent-agent">
      <div className="agent-header">
        <h2>Browser Voice Assistant</h2>
        {/* <div className={`listening-indicator ${isListening ? "active" : ""}`}>
          <div className="voice-bars">{generateVoiceBars()}</div>
          <span>{isListening ? "Listening..." : "Ready"}</span>
        </div> */}
        <div className="auto-mute-toggle">
          <label>
            <input
              type="checkbox"
              checked={autoMuteEnabled}
              onChange={() => setAutoMuteEnabled(!autoMuteEnabled)}
            />
            Auto-mute after speaking
          </label>
        </div>
      </div>

      <div className="instructions">
        <p>Speak commands like:</p>
        <ul>
          <li>"Search for Italian restaurants near me"</li>
          <li>"Open Twitter and check my notifications"</li>
          <li>"Go to YouTube and find cooking videos"</li>
        </ul>
      </div>

      <div className="intent-log">
        <h3>Captured Browser Intents</h3>
        {intents.length === 0 ? (
          <p className="no-intents">
            No browser intents captured yet. Try speaking a command.
          </p>
        ) : (
          <ul className="intent-list">
            {intents.map((intent) => (
              <li key={intent.id} className="intent-item">
                <div className="intent-action">{intent.action}</div>
                <div className="intent-target">{intent.target}</div>
                <div className="intent-time">
                  {new Date(intent.timestamp).toLocaleTimeString()}
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export const BrowserIntentAgent = memo(BrowserIntentAgentComponent);
