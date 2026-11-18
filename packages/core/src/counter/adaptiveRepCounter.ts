import type { RepEvent } from './repCounter';

export type AdaptiveConfig = {
  /** 준비 자세에서 신호가 큰 쪽('high')인지 작은 쪽('low')인지 */
  restSide: 'high' | 'low';
  /** 준비 자세(baseline)보다 이만큼 굽혀야 바닥 도달: turn = baseline - depth */
  depth: number;
  /** 이번 반복의 최저점(valley)보다 이만큼 다시 펴지면 1회 완료 */
  rebound: number;
  /** 직전 최고점(peak)보다 이만큼 내려가면 반복 시작 */
  startDrop: number;
  /** 이 시간 동안 신호 변동폭이 calibrateTol 이하이면 준비 자세로 확정(ms) */
  calibrateMs: number;
  calibrateTol: number;
  /** 첫 유효 신호 후 이 시간 안에 준비 자세를 못 잡으면 defaultBaseline 사용(ms) */
  calibrateTimeoutMs: number;
  defaultBaseline: number;
  /** 이보다 굽힌 자세는 준비 자세로 인정하지 않음(바닥에서 가만히 있는 경우 등) */
  minBaseline: number;
  /** 반복 전체(startT→endT) 최소 시간(ms) */
  minRepMs: number;
  /** 신호 null이 이만큼 이어지면 진행 중 반복을 버림(ms) */
  pauseAfterMs: number;
};

export type AdaptivePhase = 'calibrating' | 'rest' | 'out' | 'turned' | 'paused';

type Inner = 'calibrating' | 'rest' | 'out' | 'turned';

/**
 * 준비 자세를 기준으로 삼는 반복 카운터. 처음에 준비 자세(신호가 잠시 안정된 값)를 baseline으로 잡고,
 * 바닥은 baseline 기준, 시작과 복귀는 직전 최고점·이번 최저점 기준으로 상대 판정한다.
 * 프레임마다 update(t, signal)을 한 번 부르면 그 자리에서 판단한다. 시간은 인자 t로만 본다.
 *
 * 내부는 'high' 기준으로만 계산한다. 'low'면 신호·기준을 부호 반전해 같은 식을 쓴다.
 */
export class AdaptiveRepCounter {
  private inner: Inner = 'calibrating';
  private n = 0;
  /** 내부 부호 기준 baseline. null이면 아직 보정 전 */
  private base: number | null = null;
  private peak = 0;
  private valley = 0;
  private startT = 0;
  private turnT = 0;
  private pausedSince: number | null = null;
  /** 보정 구간: 최근 calibrateMs를 덮는 최소한의 유효 신호들(내부 부호) */
  private win: Array<[number, number]> = [];
  private firstValidT: number | null = null;

  constructor(private readonly cfg: AdaptiveConfig) {}

  private get sign(): 1 | -1 {
    return this.cfg.restSide === 'high' ? 1 : -1;
  }

  get count(): number {
    return this.n;
  }

  get phase(): AdaptivePhase {
    return this.pausedSince !== null ? 'paused' : this.inner;
  }

  /** 준비 자세 기준값(원래 단위). 보정 전이면 null */
  get baseline(): number | null {
    return this.base === null ? null : this.sign * this.base;
  }

  get calibrated(): boolean {
    return this.base !== null;
  }

  reset(): void {
    this.inner = 'calibrating';
    this.n = 0;
    this.base = null;
    this.peak = 0;
    this.valley = 0;
    this.startT = 0;
    this.turnT = 0;
    this.pausedSince = null;
    this.win = [];
    this.firstValidT = null;
  }

  update(t: number, signal: number | null): RepEvent | null {
    if (signal === null) {
      if (this.pausedSince === null) this.pausedSince = t;
      // 보정 중 가림은 보정 구간을 비운다(가림 앞뒤를 이어 붙여 확정하지 않음).
      if (this.inner === 'calibrating') this.win = [];
      return null;
    }
    const s = this.sign * signal;
    const longPause = this.pausedSince !== null && t - this.pausedSince >= this.cfg.pauseAfterMs;
    this.pausedSince = null;
    if (longPause && this.inner !== 'calibrating') {
      // 진행 중 반복을 버린다. peak를 지금 값에서 다시 시작하므로
      // 바닥에서 재개해 올라와도 peak만 따라 올라가고 세지 않는다.
      this.inner = 'rest';
      this.peak = s;
      return null;
    }

    switch (this.inner) {
      case 'calibrating':
        this.calibrate(t, s);
        return null;
      case 'rest':
        this.peak = Math.max(this.peak, s);
        if (s <= this.peak - this.cfg.startDrop) {
          this.inner = 'out';
          this.startT = t;
        }
        return null;
      case 'out':
        if (s <= this.base! - this.cfg.depth) {
          this.inner = 'turned';
          this.turnT = t;
          this.valley = s;
        } else if (s >= this.peak - this.cfg.startDrop / 2) {
          // 바닥에 못 가고 다시 올라옴: 세지 않는다.
          this.inner = 'rest';
          this.peak = s;
        }
        return null;
      case 'turned': {
        this.valley = Math.min(this.valley, s);
        if (s < this.valley + this.cfg.rebound) return null;
        this.inner = 'rest';
        this.peak = s;
        if (t - this.startT < this.cfg.minRepMs) return null;
        this.n += 1;
        return {
          index: this.n,
          startT: this.startT,
          turnT: this.turnT,
          endT: t,
          outMs: this.turnT - this.startT,
          backMs: t - this.turnT,
        };
      }
    }
  }

  private calibrate(t: number, s: number): void {
    const { calibrateMs, calibrateTol, calibrateTimeoutMs, defaultBaseline, minBaseline } = this.cfg;
    if (this.firstValidT === null) this.firstValidT = t;
    this.win.push([t, s]);
    // calibrateMs를 덮는 최소 구간만 남긴다(두 번째 표본부터도 calibrateMs 이상이면 맨 앞은 버림).
    while (this.win.length > 1 && t - this.win[1]![0] >= calibrateMs) this.win.shift();

    if (t - this.win[0]![0] >= calibrateMs) {
      let min = Infinity, max = -Infinity, sum = 0;
      for (const [, v] of this.win) {
        if (v < min) min = v;
        if (v > max) max = v;
        sum += v;
      }
      const mean = sum / this.win.length;
      if (max - min <= calibrateTol && mean >= this.sign * minBaseline) {
        this.finishCalibration(mean, s);
        return;
      }
    }
    if (t - this.firstValidT >= calibrateTimeoutMs) {
      this.finishCalibration(this.sign * defaultBaseline, s);
    }
  }

  private finishCalibration(base: number, s: number): void {
    this.base = base;
    this.inner = 'rest';
    this.peak = s;
    this.win = [];
  }
}
