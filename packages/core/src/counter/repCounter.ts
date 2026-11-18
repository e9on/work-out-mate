export type RepConfig = {
  /** 시작 자세에서 신호가 큰 쪽('high')인지 작은 쪽('low')인지 */
  restSide: 'high' | 'low';
  /** 이 값을 넘어가면(restSide 반대 방향) '동작 중' */
  enter: number;
  /** 이 값까지 가야 '반환점 도달' */
  turn: number;
  /** 다시 이 값을 넘어 돌아오면 1회 확정 (enter와 히스테리시스) */
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

export type RepEvent = {
  index: number;
  startT: number;
  turnT: number;
  endT: number;
  outMs: number;
  backMs: number;
};

type Inner = 'rest' | 'out' | 'turned';

/**
 * 상태 기계 기반 반복 카운터. 프레임마다 update(t, signal)을 한 번 부르면
 * 그 자리에서 판단한다(미래 프레임을 기다리지 않음). 시간은 인자 t로만 본다.
 */
export class RepCounter {
  private inner: Inner = 'rest';
  private n = 0;
  private startT = 0;
  private turnT = 0;
  private pausedSince: number | null = null;
  /** 시작 자세 쪽(exit 너머)을 한 번 지나야 true. false면 rest에서 out으로 넘어가지 않는다. */
  private armed = false;

  constructor(private readonly cfg: RepConfig) {}

  get count(): number {
    return this.n;
  }

  get phase(): RepPhase {
    return this.pausedSince !== null ? 'paused' : this.inner;
  }

  reset(): void {
    this.inner = 'rest';
    this.n = 0;
    this.startT = 0;
    this.turnT = 0;
    this.pausedSince = null;
    this.armed = false;
  }

  /** 가림이 길어져 진행 중 반복을 버린다. 시작 자세를 다시 지나야 센다. */
  private discard(): void {
    this.inner = 'rest';
    this.armed = false;
  }

  update(t: number, signal: number | null): RepEvent | null {
    if (signal === null) {
      if (this.pausedSince === null) this.pausedSince = t;
      if (t - this.pausedSince >= this.cfg.pauseAfterMs) this.discard();
      return null;
    }
    if (this.pausedSince !== null) {
      if (t - this.pausedSince >= this.cfg.pauseAfterMs) this.discard();
      this.pausedSince = null;
    }

    const { enter, turn, exit } = this.cfg;
    // 'high'면 값이 작아지는 쪽이 동작 방향. 'low'는 부호를 뒤집어 같은 식으로 비교한다.
    const s = this.cfg.restSide === 'high' ? signal : -signal;
    const e = this.cfg.restSide === 'high' ? enter : -enter;
    const tn = this.cfg.restSide === 'high' ? turn : -turn;
    const x = this.cfg.restSide === 'high' ? exit : -exit;

    switch (this.inner) {
      case 'rest':
        if (!this.armed) {
          if (s > x) this.armed = true;
          return null;
        }
        if (s < e) {
          this.inner = 'out';
          this.startT = t;
        }
        return null;
      case 'out':
        if (s <= tn) {
          this.turnT = t;
          if (this.cfg.countAt === 'turn') {
            // 바닥 도달 즉시 확정. 최소 시간 미달이어도 재무장 전에는 새 반복을 시작하지 않는다.
            this.inner = 'rest';
            this.armed = false;
            if (t - this.startT < this.cfg.minRepMs) return null;
            this.n += 1;
            return { index: this.n, startT: this.startT, turnT: t, endT: t, outMs: t - this.startT, backMs: 0 };
          }
          this.inner = 'turned';
        } else if (s > x) {
          this.inner = 'rest';
          this.armed = true;
        }
        return null;
      case 'turned': {
        if (s <= x) return null;
        this.inner = 'rest';
        this.armed = true;
        const outMs = this.turnT - this.startT;
        const backMs = t - this.turnT;
        if (t - this.startT < this.cfg.minRepMs) return null;
        this.n += 1;
        return { index: this.n, startT: this.startT, turnT: this.turnT, endT: t, outMs, backMs };
      }
    }
  }
}
