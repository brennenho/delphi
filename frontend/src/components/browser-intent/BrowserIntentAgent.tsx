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
  // Add a ref to track the last processed intent timestamp
  const lastIntentTimestampRef = useRef<number>(0);
  // Add a ref to track the last processed intent text
  const lastIntentTextRef = useRef<string>("");
  // Configure debounce threshold (in milliseconds)
  const DEBOUNCE_THRESHOLD = 2000;

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
            You are an intelligent, helpful browser assistant that helps users navigate the web through natural conversation. Your primary purpose is to understand and execute browser actions through voice commands.

            # Core Responsibilities
            1. Accurately extract browser intents from natural language
            2. Respond conversationally with acknowledgment and context
            3. Handle ambiguity and clarify when needed
            4. Structure extracted intents properly

            # Understanding Browser Intents
            For each user request, extract these components:
            - ACTION: The specific browser operation (SEARCH, NAVIGATE, OPEN, CLICK, SCROLL, GO_BACK, REFRESH, etc.)
            - TARGET: What the action applies to (specific URL, search query, UI element, etc.)
            
            # Response Guidelines
            - Be conversational and natural in your responses
            - Acknowledge what you've understood from the user
            - Add brief contextual information when appropriate
            - Use contractions and casual language to sound natural
            - Keep responses concise (1-2 sentences is often sufficient)
            - NEVER include technical terms like "BROWSER_INTENT" in your spoken responses

            # Intent Extraction Rules
            - Always call log_browser_intent() for valid browser requests
            - For ambiguous requests, ask a simple clarifying question
            - If multiple intents are detected, prioritize the primary one first
            - For non-browser requests, respond normally without calling the function

            # Examples of Good Interactions:

            Example 1:
            User: "I want to look up the weather forecast for Chicago this weekend"
            Response: "I'll search for Chicago's weekend weather forecast for you."
            Function: log_browser_intent({action: "SEARCH", target: "weather forecast Chicago this weekend", rawText: "I want to look up the weather forecast for Chicago this weekend"})

            Example 2:
            User: "Can you take me to Amazon to look for running shoes?"
            Response: "Sure, I'll open Amazon and search for running shoes."
            Function: log_browser_intent({action: "NAVIGATE_AND_SEARCH", target: "Amazon: running shoes", rawText: "Can you take me to Amazon to look for running shoes?"})

            Example 3: 
            User: "I'm trying to find a good pizza place"
            Response: "I'll search for good pizza places near you."
            Function: log_browser_intent({action: "SEARCH", target: "good pizza places near me", rawText: "I'm trying to find a good pizza place"})

            Example 4:
            User: "Go back to the previous page"
            Response: "Going back to the previous page."
            Function: log_browser_intent({action: "GO_BACK", target: "previous page", rawText: "Go back to the previous page"})

            Example 5:
            User: "What's the capital of France?"
            Response: "The capital of France is Paris. Would you like me to search for more information about Paris?"
            No function call needed for simple information requests.

            Example 6:
            User: "Open my Gmail"
            Response: "Opening Gmail for you."
            Function: log_browser_intent({action: "NAVIGATE", target: "Gmail", rawText: "Open my Gmail"})

            # Handling Edge Cases
            - For unclear requests: "I'm not sure if you want to search or navigate. Could you clarify what you'd like to do?"
            - For non-browser tasks: Respond helpfully without calling the function
            - For multi-step requests: Break down into primary actions and acknowledge the sequence

            Always call the log_browser_intent function during your response when you detect a valid browser action intent.`,
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
    const onToolCall = (toolCall: ToolCall) => {
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

      // Check if this is a duplicate intent (same text within threshold time)
      const now = Date.now();
      const isDuplicate =
        rawText === lastIntentTextRef.current &&
        now - lastIntentTimestampRef.current < DEBOUNCE_THRESHOLD;

      // Update refs for the next call
      lastIntentTextRef.current = rawText;
      lastIntentTimestampRef.current = now;

      // Exit if duplicate
      if (isDuplicate) {
        console.log("Skipping duplicate intent:", rawText);

        // Still acknowledge to the LLM that the call succeeded
        client.sendToolResponse({
          functionResponses: [
            {
              id: fc.id,
              response: { output: { success: true } },
            },
          ],
        });
        return;
      }

      fetch("http://localhost:8000/query", {
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
