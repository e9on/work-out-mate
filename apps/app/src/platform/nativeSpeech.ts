import { TextToSpeech } from '@capacitor-community/text-to-speech';
import type { Speech } from '../ports/speech';

/** Capacitor 네이티브 TTS(ko-KR). 실패하면 'unsupported' */
export function createNativeSpeech(): Speech {
  return {
    async speak(text) {
      try {
        // queueStrategy 0 = Flush: 새 문구가 이전 문구를 끊는다.
        await TextToSpeech.speak({ text, lang: 'ko-KR', rate: 1.0, pitch: 1.0, volume: 1.0, queueStrategy: 0 });
        return 'ok';
      } catch {
        return 'unsupported';
      }
    },
    cancel() {
      void TextToSpeech.stop().catch(() => undefined);
    },
  };
}
