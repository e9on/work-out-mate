import type { Diagnosis, TrackerState } from '@wom/core';

const DIAGNOSIS_NOTE: Record<Diagnosis, string> = {
  ok: '',
  notVisible: '  (몸이 안 보여요)',
  notReady: '  (준비 자세가 아니에요)',
  calibratedByDefault: '  (기본값으로 보정됨)',
};

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
  /** 왜 안 세는지 보는 진단 줄 */
  diag: string;
};

export class Hud {
  constructor(private big: HTMLElement, private box: HTMLElement) {}

  render(i: HudInfo): void {
    const s = i.state;
    // 'hold'(매달리기)면 버틴 초, 'reps'면 횟수를 보여 준다.
    const main = s.kind === 'hold' ? `버틴 시간 ${(s.heldMs / 1000).toFixed(1)}초` : `횟수 ${s.count}`;
    // 보정 중에는 신호가 끊겨도 준비 자세 안내를 계속 보여 준다. 그 밖에는 진단 사유를 보여 준다.
    const calibrating = s.kind === 'reps' && s.phase === 'calibrating';
    const paused = s.kind === 'reps' ? s.phase === 'paused' : s.diagnosis === 'notVisible';
    const note = calibrating
      ? s.diagnosis === 'notVisible' ? '  (준비 자세를 잡아 주세요, 몸이 안 보여요)' : '  (준비 자세를 잡아 주세요)'
      : paused ? '  (일시정지)' : DIAGNOSIS_NOTE[s.diagnosis];
    this.big.textContent = `${main}${note}`;
    const ko = i.voices.filter((v) => /\(ko/i.test(v)).join(', ');
    this.box.textContent = [
      i.diag,
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
  clear(): void { this.v = []; }
  add(x: number): void { this.v.push(x); if (this.v.length > this.n) this.v.shift(); }
  avg(): number { return this.v.length ? this.v.reduce((a, b) => a + b, 0) / this.v.length : 0; }
  p95(): number {
    if (!this.v.length) return 0;
    const s = [...this.v].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor(s.length * 0.95))]!;
  }
}
