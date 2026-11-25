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
export async function saveRecordingNative(file: RecordingFile, name = recordingFileName(file)): Promise<string> {
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

/**
 * 카메라 스트림을 동영상으로 함께 녹화한다(랜드마크와 같은 시계 performance.now로 시작 시각을 남김).
 * 영상은 개인 신체 데이터다. 폰 문서 폴더에만 저장하고 어디로도 보내지 않는다(이 앱은 INTERNET 권한이 없다).
 */
export class VideoRecorder {
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  startT = 0;
  mimeType = '';

  start(stream: MediaStream): void {
    const types = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    this.mimeType = types.find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
    this.chunks = [];
    this.rec = new MediaRecorder(stream, this.mimeType ? { mimeType: this.mimeType, videoBitsPerSecond: 2_500_000 } : undefined);
    this.rec.ondataavailable = (e) => { if (e.data.size > 0) this.chunks.push(e.data); };
    this.rec.start(1000);
    this.startT = performance.now();
  }

  /** 멈추고 영상 Blob을 돌려준다. 녹화 중이 아니면 null. */
  stop(): Promise<Blob | null> {
    const rec = this.rec;
    this.rec = null;
    if (!rec || rec.state === 'inactive') return Promise.resolve(null);
    return new Promise((resolve) => {
      rec.onstop = () => resolve(new Blob(this.chunks, { type: rec.mimeType || this.mimeType || 'video/webm' }));
      rec.stop();
    });
  }

  get extension(): string {
    return this.mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';
  }
}

function blobToBase64(b: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',', 2)[1] ?? '');
    r.onerror = () => reject(r.error);
    r.readAsDataURL(b);
  });
}

/** 영상 Blob을 폰 문서 폴더(실패하면 앱 전용 폴더)에 저장하고 위치를 돌려준다. */
export async function saveVideoNative(blob: Blob, name: string): Promise<string> {
  const data = await blobToBase64(blob);
  try {
    await Filesystem.writeFile({ path: name, data, directory: Directory.Documents });
    return `Documents/${name}`;
  } catch {
    await Filesystem.writeFile({ path: name, data, directory: Directory.Data });
    return `files/${name}`;
  }
}

/** 브라우저·PC 앱: 영상 Blob을 다운로드로 저장. */
export function downloadBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
