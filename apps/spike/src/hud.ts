import type { TrackerState } from '@wom/core';

export type HudInfo = {
  state: TrackerState;
  fps: number;
  avgMs: number;
  p95Ms: number;
  delegate: string;
  note: string;
  recFrames: number | null;
  voices: string[];
  skipped: number;
};

export class Hud {
  constructor(private big: HTMLElement, private box: HTMLElement) {}

  render(i: HudInfo): void {
    const s = i.state;
    this.big.textContent = `횟수 ${s.count}  ·  매달림 ${(s.heldMs / 1000).toFixed(1)}초${s.paused ? '  (일시정지)' : ''}`;
    const ko = i.voices.filter((v) => /\(ko/i.test(v)).join(', ');
    this.box.textContent = [
      `FPS(처리) ${i.fps}   추론 평균 ${i.avgMs.toFixed(1)}ms / p95 ${i.p95Ms.toFixed(1)}ms   건너뜀 ${i.skipped}`,
      `처리 장치 ${i.delegate}${i.note ? `   ${i.note}` : ''}`,
      `녹화 ${i.recFrames === null ? '꺼짐' : `${i.recFrames}프레임`}`,
      `음성 ${i.voices.length ? ko || `ko 없음 (전체 ${i.voices.length}개)` : '목록 없음'}`,
    ].join('\n');
  }
}

/** 최근 값 N개의 평균과 p95. */
export class Stat {
  private v: number[] = [];
  constructor(private n = 120) {}
  add(x: number): void { this.v.push(x); if (this.v.length > this.n) this.v.shift(); }
  avg(): number { return this.v.length ? this.v.reduce((a, b) => a + b, 0) / this.v.length : 0; }
  p95(): number {
    if (!this.v.length) return 0;
    const s = [...this.v].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]!;
  }
}
