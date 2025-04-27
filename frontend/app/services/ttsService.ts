export class TtsService {
  private audioContext: AudioContext | null = null;
  private isPlaying: boolean = false;
  private onPlayingStateChange: ((isPlaying: boolean) => void) | null = null;

  constructor(onPlayingStateChange: (isPlaying: boolean) => void) {
    this.onPlayingStateChange = onPlayingStateChange;
    this.audioContext = new AudioContext();
  }

  async speak(text: string): Promise<void> {
    if (!this.audioContext) return;

    try {
      this.isPlaying = true;
      if (this.onPlayingStateChange) {
        this.onPlayingStateChange(true);
      }

      // Use the Web Speech API for TTS
      return new Promise((resolve, reject) => {
        const utterance = new SpeechSynthesisUtterance(text);

        utterance.onend = () => {
          this.isPlaying = false;
          if (this.onPlayingStateChange) {
            this.onPlayingStateChange(false);
          }
          resolve();
        };

        utterance.onerror = (event) => {
          this.isPlaying = false;
          if (this.onPlayingStateChange) {
            this.onPlayingStateChange(false);
          }
          reject(new Error(`Speech synthesis error: ${event.error}`));
        };

        speechSynthesis.speak(utterance);
      });
    } catch (error) {
      console.error("[TTS] Error speaking:", error);
      this.isPlaying = false;
      if (this.onPlayingStateChange) {
        this.onPlayingStateChange(false);
      }
      throw error;
    }
  }

  stop() {
    speechSynthesis.cancel();
    this.isPlaying = false;
    if (this.onPlayingStateChange) {
      this.onPlayingStateChange(false);
    }
  }
}
