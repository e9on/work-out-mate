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

/** 브라우저 다운로드로 저장. Android 저장은 Task 9. */
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
