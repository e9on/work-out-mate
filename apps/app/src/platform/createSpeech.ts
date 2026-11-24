import { Capacitor } from '@capacitor/core';
import type { Speech } from '../ports/speech';
import { createNativeSpeech } from './nativeSpeech';
import { createWebSpeech } from './webSpeech';

/** Capacitor 네이티브 앱이면 기기 TTS, 아니면 브라우저 speechSynthesis */
export function createSpeech(isNative: boolean = Capacitor.isNativePlatform()): Speech {
  return isNative ? createNativeSpeech() : createWebSpeech();
}
