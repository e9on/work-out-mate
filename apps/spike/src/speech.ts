// 음성. 지금은 speechSynthesis만. Capacitor TTS 분기는 Task 9에서 speak() 안에 추가한다.
let koVoice: SpeechSynthesisVoice | null = null;

export function listVoices(): string[] {
  if (!('speechSynthesis' in window)) return [];
  return speechSynthesis.getVoices().map((v) => `${v.name}(${v.lang})`);
}

function pickKo(): SpeechSynthesisVoice | null {
  koVoice = speechSynthesis.getVoices().find((v) => v.lang.toLowerCase().startsWith('ko')) ?? null;
  return koVoice;
}

export async function speak(text: string): Promise<'ok' | 'unsupported'> {
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
  if (!('speechSynthesis' in window)) return;
  speechSynthesis.addEventListener('voiceschanged', () => {
    pickKo();
    cb();
  });
}
