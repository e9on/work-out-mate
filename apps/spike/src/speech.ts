// 음성. Capacitor 네이티브 앱이면 Android TTS 플러그인, 브라우저면 speechSynthesis.
import { Capacitor } from '@capacitor/core';
import { TextToSpeech } from '@capacitor-community/text-to-speech';

const native = Capacitor.isNativePlatform();

let koVoice: SpeechSynthesisVoice | null = null;

/** 네이티브 앱: 기기 TTS가 지원하는 언어 중 한국어 여부를 HUD용 문자열로 돌려준다. */
export async function listNativeVoices(): Promise<string[]> {
  try {
    const { languages } = await TextToSpeech.getSupportedLanguages();
    const ko = languages.filter((l) => l.toLowerCase().startsWith('ko'));
    return ko.length ? ko.map((l) => `Android TTS(${l})`) : [`ko 미지원 (지원 언어 ${languages.length}개)`];
  } catch (e) {
    return [`TTS 조회 실패: ${e instanceof Error ? e.message : String(e)}`];
  }
}

export function listVoices(): string[] {
  if (native) return [];
  if (!('speechSynthesis' in window)) return [];
  return speechSynthesis.getVoices().map((v) => `${v.name}(${v.lang})`);
}

function pickKo(): SpeechSynthesisVoice | null {
  koVoice = speechSynthesis.getVoices().find((v) => v.lang.toLowerCase().startsWith('ko')) ?? null;
  return koVoice;
}

export async function speak(text: string): Promise<'ok' | 'unsupported'> {
  if (native) {
    try {
      await TextToSpeech.speak({ text, lang: 'ko-KR', rate: 1.0, pitch: 1.0, volume: 1.0, queueStrategy: 0 });
      return 'ok';
    } catch {
      return 'unsupported';
    }
  }
  if (!('speechSynthesis' in window)) return 'unsupported';
  const voice = koVoice ?? pickKo();
  if (!voice) return 'unsupported';
  return new Promise((resolve) => {
    const u = new SpeechSynthesisUtterance(text);
    u.voice = voice;
    u.lang = voice.lang;
    u.onend = () => resolve('ok');
    u.onerror = () => resolve('unsupported');
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  });
}

/** 음성 목록이 비동기로 채워지는 브라우저가 있어 변경 시 콜백. */
export function onVoicesChanged(cb: () => void): void {
  if (native) return;
  if (!('speechSynthesis' in window)) return;
  speechSynthesis.addEventListener('voiceschanged', () => {
    pickKo();
    cb();
  });
}
