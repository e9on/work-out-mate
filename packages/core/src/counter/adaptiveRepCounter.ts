import { RepEngine, type RepEvent } from './repEngine';
import { adaptiveStrategy, type AdaptiveStrategy } from './strategies';

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

/** 준비 자세 기준값을 어떻게 얻었는지: 안정 구간 측정 / 타임아웃 때 관측 최고점 / 기본값 */
export type CalibrationSource = 'measured' | 'observed' | 'default';

export type AdaptivePhase = 'calibrating' | 'rest' | 'out' | 'turned' | 'paused';

/**
 * 준비 자세를 기준으로 삼는 반복 카운터. 공통 껍데기(RepEngine)에 adaptiveStrategy를 끼운 파사드다.
 * 처음에 준비 자세(신호가 잠시 안정된 값)를 baseline으로 잡고, 바닥은 baseline 기준,
 * 시작과 복귀는 직전 최고점·이번 최저점 기준으로 상대 판정한다.
 * rest로 돌아간 뒤(확정·미달 복귀·보정 직후·오래 가림 뒤)에는 신호가 재무장선(baseline - depth/2)을
 * 한 번 지나야 다음 반복을 시작한다. 확정 시점이 바닥선 근처라 작은 흔들림으로 두 번 세는 것을 막는다.
 * 프레임마다 update(t, signal)을 한 번 부르면 그 자리에서 판단한다. 시간은 인자 t로만 본다.
 */
export class AdaptiveRepCounter {
  private readonly judge: AdaptiveStrategy;
  private readonly engine: RepEngine;

  constructor(cfg: AdaptiveConfig) {
    this.judge = adaptiveStrategy(cfg);
    this.engine = new RepEngine(this.judge, cfg);
  }

  get count(): number {
    return this.engine.count;
  }

  /** 보정 중에는 신호가 끊겨도 'calibrating'(안내를 계속 보이게). 그 외 null이면 'paused' */
  get phase(): AdaptivePhase {
    return this.engine.phase;
  }

  /** 지금 신호가 끊겨 있는지(null이 들어오는 중). 보정 중에도 phase와 따로 알려 준다 */
  get paused(): boolean {
    return this.engine.paused;
  }

  /** 준비 자세 기준값(원래 단위). 보정 전이면 null */
  get baseline(): number | null {
    return this.judge.baseline;
  }

  /** 기준값의 출처. 보정 전이면 null */
  get calibrationSource(): CalibrationSource | null {
    return this.judge.calibrationSource;
  }

  get calibrated(): boolean {
    return this.judge.calibrated;
  }

  reset(): void {
    this.engine.reset();
  }

  /**
   * @param ready 이 프레임이 준비 자세인지(운동 정의의 ready). 보정 중에만 본다.
   *   true인 프레임만 보정 구간에 쌓고, false·null이면 구간을 비운다. 생략하면 true.
   */
  update(t: number, signal: number | null, ready: boolean | null = true): RepEvent | null {
    return this.engine.update(t, signal, ready);
  }
}
