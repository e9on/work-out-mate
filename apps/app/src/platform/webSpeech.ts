import type { Speech } from '../ports/speech';

export type WebSpeechEnv = {
  synth: SpeechSynthesis | undefined;
  Utterance: typeof SpeechSynthesisUtterance | undefined;
};

function defaultEnv(): WebSpeechEnv {
  const g = globalThis as {
    speechSynthesis?: SpeechSynthesis;
    SpeechSynthesisUtterance?: typeof SpeechSynthesisUtterance;
  };
  return { synth: g.speechSynthesis, Utterance: g.SpeechSynthesisUtterance };
}

/**
 * 브라우저 speechSynthesis 음성. ko 음성이 없으면(목록이 아직 비어 있어도) 'unsupported'.
 * 음성 목록이 비동기로 채워지는 브라우저가 있어, ko 음성을 찾을 때까지 말할 때마다 다시 찾는다.
 * 새 문구는 이전 문구를 끊는다(세는 소리가 밀리지 않게).
 */
export function createWebSpeech(env: WebSpeechEnv = defaultEnv()): Speech {
  let ko: SpeechSynthesisVoice | null = null;
  const pick = (): SpeechSynthesisVoice | null => {
    if (!ko && env.synth) ko = env.synth.getVoices().find((v) => v.lang.toLowerCase().startsWith('ko')) ?? null;
    return ko;
  };
  return {
    speak(text) {
      const { synth, Utterance } = env;
      if (!synth || !Utterance) return Promise.resolve('unsupported');
      const voice = pick();
      if (!voice) return Promise.resolve('unsupported');
      return new Promise((resolve) => {
        const u = new Utterance(text);
        u.voice = voice;
        u.lang = voice.lang;
        u.onend = () => resolve('ok');
        u.onerror = () => resolve('unsupported');
        synth.cancel();
        synth.speak(u);
      });
    },
    cancel() {
      env.synth?.cancel();
    },
  };
}
