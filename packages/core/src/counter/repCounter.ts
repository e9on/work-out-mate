import { RepEngine, type RepEvent } from './repEngine';
import { fixedStrategy } from './strategies';

export type { RepEvent } from './repEngine';

export type RepConfig = {
  /** 시작 자세에서 신호가 큰 쪽('high')인지 작은 쪽('low')인지 */
  restSide: 'high' | 'low';
  /** 이 값을 넘어가면(restSide 반대 방향) '동작 중' */
  enter: number;
  /** 이 값까지 가야 '반환점 도달' */
  turn: number;
  /**
   * 다시 이 값을 넘어 돌아오면 1회 확정 (enter와 히스테리시스). 미달 복귀·재무장 기준도 이 값.
   * enter보다 시작 자세 쪽이어야 한다('high'면 exit ≥ enter, 'low'면 exit ≤ enter).
   */
  exit: number;
  /** 반복 전체(startT→endT) 최소 시간(ms). 구간별 최소 시간은 두지 않는다 */
  minRepMs: number;
  /** 신호 null이 이만큼 이어지면 진행 중 반복을 버림(ms) */
  pauseAfterMs: number;
  /**
   * 반복을 확정하는 시점. 기본 'return'(시작 자세로 돌아올 때).
   * 'turn'이면 반환점에 닿는 프레임에서 바로 확정한다(네거티브처럼 돌아오는 동작이 운동이 아닐 때).
   * 확정 뒤에는 시작 자세 쪽으로 exit를 넘어야 다음 반복을 시작한다.
   */
  countAt?: 'return' | 'turn';
};

export type RepPhase = 'rest' | 'out' | 'turned' | 'paused';

/**
 * 고정 임계값 반복 카운터. 공통 껍데기(RepEngine)에 fixedStrategy를 끼운 파사드다.
 * 프레임마다 update(t, signal)을 한 번 부르면 그 자리에서 판단한다. 시간은 인자 t로만 본다.
 */
export class RepCounter {
  private readonly engine: RepEngine;

  constructor(cfg: RepConfig) {
    this.engine = new RepEngine(fixedStrategy(cfg), cfg);
  }

  get count(): number {
    return this.engine.count;
  }

  get phase(): RepPhase {
    // fixedStrategy는 항상 준비돼 있어 'calibrating'이 나오지 않는다.
    return this.engine.phase as RepPhase;
  }

  reset(): void {
    this.engine.reset();
  }

  update(t: number, signal: number | null): RepEvent | null {
    return this.engine.update(t, signal);
  }
}
