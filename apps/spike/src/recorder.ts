import { Capacitor } from '@capacitor/core';
import { Directory, Encoding, Filesystem } from '@capacitor/filesystem';
import type { ExerciseId, PoseFrame, RecordingFile } from '@wom/core';

export class Recorder {
  private frames: PoseFrame[] = [];
  private on = false;

  get recording(): boolean { return this.on; }
  get length(): number { return this.frames.length; }

  start(): void { this.frames = []; this.on = true; }
  add(f: PoseFrame): void { if (this.on) this.frames.push(f); }

  /** 녹화를 멈추고 RecordingFile을 돌려준다. */
  stop(exercise: ExerciseId, model: 'lite' | 'full'): RecordingFile {
    this.on = false;
    const file: RecordingFile = {
      version: 1,
      device: navigator.userAgent,
      exercise,
      model,
      frames: this.frames,
    };
    this.frames = [];
    return file;
  }
}

function pad(n: number): string { return String(n).padStart(2, '0'); }

export function recordingFileName(file: RecordingFile, d = new Date()): string {
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return `wom-${file.exercise}-${file.model}-${stamp}.json`;
}

/**
 * 개발 서버(PC)로 녹화 파일을 보낸다. 같은 Wi-Fi 안의 PC에만 가고, PC는
 * packages/core/test/fixtures/private/ 에 저장한다(vite.config.ts의 개발용 엔드포인트).
 * 성공하면 저장된 파일 이름, 실패하면 null.
 */
export async function sendRecordingToPc(file: RecordingFile): Promise<string | null> {
  const name = recordingFileName(file);
  try {
    const res = await fetch(`/__wom/recording?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(file),
    });
    return res.ok ? name : null;
  } catch {
    return null;
  }
}

export const isNativeApp = Capacitor.isNativePlatform();

/**
 * 네이티브 앱: 먼저 문서(Documents) 폴더에 저장하고, 실패하면 앱 전용 폴더(Data, 권한 불필요)에 다시 저장한다.
 * 저장된 위치를 한국어 문자열로 돌려준다. 둘 다 실패할 때만 오류를 던진다.
 */
export async function saveRecordingNative(file: RecordingFile): Promise<string> {
  const name = recordingFileName(file);
  const data = JSON.stringify(file);
  try {
    const res = await Filesystem.writeFile({ path: name, data, directory: Directory.Documents, encoding: Encoding.UTF8 });
    return `문서 폴더 Documents/${name} (${res.uri})`;
  } catch (e1) {
    try {
      const res = await Filesystem.writeFile({ path: name, data, directory: Directory.Data, encoding: Encoding.UTF8 });
      return `앱 전용 폴더 files/${name} (${res.uri}) - 문서 폴더 저장 실패: ${e1 instanceof Error ? e1.message : String(e1)}`;
    } catch (e2) {
      throw new Error(`문서 폴더와 앱 전용 폴더 모두 저장 실패 (${e2 instanceof Error ? e2.message : String(e2)})`);
    }
  }
}

/** 브라우저 다운로드로 저장. */
export function downloadRecording(file: RecordingFile): string {
  const name = recordingFileName(file);
  const url = URL.createObjectURL(new Blob([JSON.stringify(file)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return name;
}
