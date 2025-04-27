"use client";
import { Mic } from "lucide-react";
import { useCallback, useState } from "react";
import AudioInput from "../components/audio-input";

export default function Home() {
  const [messages, setMessages] = useState<
    { type: "human" | "gemini"; text: string }[]
  >([]);

  const handleTranscription = useCallback(
    (text: string, speaker: "human" | "gemini") => {
      setMessages((prev) => [...prev, { type: speaker, text }]);
    },
    []
  );

  return (
    <main className="flex flex-col items-center justify-center min-h-screen bg-gradient-to-b from-indigo-50 to-white w-full">
      {/* Header with pulsing mic icon */}
      <header className="flex items-center space-x-3">
        <Mic className="w-12 h-12 text-black" />
        <h1 className="text-5xl sm:text-6xl  text-gray-900">Delphi</h1>
      </header>

      {/* Glassmorphic card around AudioInput */}
      <div className="w-full max-w-sm rounded-2xl">
        <AudioInput onTranscription={handleTranscription} />
      </div>
    </main>
  );
}
