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
  const { client, setConfig, volume } = useLiveAPIContext();
  // More aggressive debouncing strategy
  const lastIntentTimestampRef = useRef<number>(0);
  const lastIntentTextRef = useRef<string>("");
  const lastActionTargetRef = useRef<string>("");
  const processingIntentRef = useRef<boolean>(false);
  // Configure debounce thresholds (in milliseconds)
  const TEXT_DEBOUNCE_THRESHOLD = 2000; // For exact text matches
  const ACTION_DEBOUNCE_THRESHOLD = 3500; // For same action+target

  // ─── 2) Tell Gemini about our function, and instruct it to call it ─────────
  useEffect(() => {
    setConfig({
      model: "models/gemini-2.0-flash-exp",
      generationConfig: {
        responseModalities: "audio",
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: "Aoede" } },
        },
      },
      systemInstruction: {
        parts: [
          {
            text: `
            You are an intelligent browser assistant that helps users navigate the web through voice commands.
            Your goal is to understand and process browser actions from natural conversation.

            # ANTI-REPETITION - HIGHEST PRIORITY
            - NEVER repeat the same response for any reason
            - Users may have multiple tasks in a single request. Ensure you only call log_browser_intent() once per task.
            - Assume the user heard your response the first time
            - If you're unsure if an intent was processed, still only call the function once
            
            # SYSTEM UPDATES - HIGH PRIORITY
            When receiving messages starting with "[UPDATE]:", this is critical browser state information:
            - IMMEDIATELY incorporate this information in your response
            - NEVER mention the "[UPDATE]:" prefix itself
            - NEVER start the response with a filler affirmation like "Okay" or "Sure"
            - Present this information naturally as if you just discovered it
            - Base your next conversational turn on this update

            # Response Style
            - Use FUTURE TENSE for actions ("I'll search for..." NOT "Searching for...")
            - Keep responses brief (1 sentence when possible)
            - Don't say "I've understood" or "I'll help you with that" - just do it
            - Focus on what you're about to do, not what you've done
            
            # Browser Intent Extraction
            For each user request, extract:
            - ACTION: The browser operation (SEARCH, NAVIGATE, OPEN, etc.)
            - TARGET: What the action applies to (URL, search query, element, etc.)
            
            # Function Usage
            - Call log_browser_intent() EXACTLY ONCE for each user task
            - For ambiguous requests, ask a simple clarifying question
            - For non-browser requests, respond without calling the function

            # Examples:
            User: "Look up weather for Chicago"
            Response: "I'll check Chicago's weather."
            Function: log_browser_intent({action: "SEARCH", target: "weather Chicago", rawText: "Look up weather for Chicago"})
            
            User: "Search Amazon for tennis shoes"
            Response: "I'll search Amazon for tennis shoes."
            Function: log_browser_intent({action: "NAVIGATE", target: "Amazon", rawText: "Search Amazon for tennis shoes"})
            Function: log_browser_intent({action: "SEARCH", target: "tennis shoes", rawText: "Search Amazon for tennis shoes"})
            System: "[UPDATE]: Amazon is open. There is a list of available shoes."
            Response: "I found a list of available shoes on Amazon. Would you like to see them?"
            
            User: "Go back"
            Response: "I'll go back to the previous page."
            Function: log_browser_intent({action: "GO_BACK", target: "previous page", rawText: "Go back"})
            
            User: "What's the capital of France?"
            Response: "The capital of France is Paris. Would you like me to search for more information about Paris?"
            No function call for information requests.`,
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
  }, [volume]);

  // ─── 4) Listen for Gemini function-calls and log intents ───────────────────
  useEffect(() => {
    const onToolCall = async (toolCall: ToolCall) => {
      // Find our specific function invocation
      const fc = toolCall.functionCalls.find(
        (f) => f.name === logIntentDeclaration.name
      );
      if (!fc) return;

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

      const response = await fetch("http://localhost:8000/query", {
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

      if (!response.ok) {
        console.error("Failed to log intent:", response.statusText);
        return;
      }

      const responseText = await response.text();

      console.log("Sending response to Gemini:", responseText);
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

      // Release the processing lock after a short delay to ensure any response
      // from the LLM has time to be processed
      setTimeout(() => {
        processingIntentRef.current = false;
      }, 1500);
    };

    client.on("toolcall", onToolCall);
    return () => {
      client.off("toolcall", onToolCall);
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
