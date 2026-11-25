export type RepEvent = {
  index: number;
  startT: number;
  turnT: number;
  endT: number;
  outMs: number;
  backMs: number;
  /** 그 반복의 신호 최저점(원래 신호 단위). 'high' 운동은 최소값, 'low' 운동은 최대값 */
  valley: number;
  /** valley에 처음 닿은 시각(실제 최저점 시각). turnT는 반환선을 처음 지난 시각이라 하강 도중이다.
   * countAt 'turn' 설정은 반환선에서 바로 확정하므로 turnT와 같다 */
  valleyT: number;
};

export type RestSide = 'high' | 'low';

export type RepEnginePhase = 'calibrating' | 'rest' | 'out' | 'turned' | 'paused';

export type RepEngineConfig = {
  /** 시작 자세에서 신호가 큰 쪽('high')인지 작은 쪽('low')인지 */
  restSide: RestSide;
  /** 반복 전체(startT→endT) 최소 시간(ms) */
  minRepMs: number;
  /** 신호 null이 이만큼 이어지면 진행 중 반복을 버림(ms) */
  pauseAfterMs: number;
  /** 반복을 확정하는 시점. 기본 'return'. 'turn'이면 반환점에 닿는 프레임에서 확정 */
  countAt?: 'return' | 'turn';
};

/**
 * 내부 부호. 껍데기와 전략은 모두 'high' 기준(시작 자세 쪽이 큰 값)으로만 계산한다.
 * 'low'면 신호와 설정값에 -1을 곱해 같은 식을 쓴다. 부호 규칙은 여기 한 곳에만 둔다.
 */
export function restSign(side: RestSide): 1 | -1 {
  return side === 'high' ? 1 : -1;
}

/**
 * 판정 전략. 껍데기(RepEngine)가 상태·시간·가림·재무장·이벤트를 맡고, 전략은 "선"만 정한다.
 * 모든 값은 내부 부호 기준(시작 자세 쪽이 크다)이다. 비교는 껍데기가 한다:
 * 시작은 s < 선, 반환점은 s ≤ 선, 복귀·미달 복귀·재무장은 s > 선(경계값과 같으면 반환점만 도달).
 */
export interface JudgeStrategy {
  /** 판정할 준비가 됐는지. false인 동안 껍데기는 'calibrating'이고 프레임을 calibrate()로만 넘긴다 */
  ready(): boolean;
  /** 준비 전 프레임마다 호출. s가 null이면 가림 */
  calibrate(t: number, s: number | null, ready: boolean | null): void;
  /** rest → out: s가 이 선 아래로 */
  startLine(peak: number): number;
  /** out → turned: s ≤ 이 선 */
  turnLine(): number;
  /** turned → rest(1회): s가 이 선 위로 */
  completeLine(valley: number): number;
  /** out 중 반환점 미도달 복귀: s가 이 선 위로 */
  abortLine(peak: number): number;
  /** 재무장: s가 이 선 위로 */
  rearmLine(): number;
  reset(): void;
}

type Inner = 'calibrating' | 'rest' | 'out' | 'turned';

/**
 * 반복 카운터 공통 껍데기. 프레임마다 update(t, signal)을 한 번 부르면 그 자리에서 판단한다
 * (미래 프레임을 기다리지 않음). 시간은 인자 t로만 본다.
 *
 * - 가림: null이 들어오는 동안 'paused'. pauseAfterMs 이상 이어졌으면 신호가 돌아온 프레임에서
 *   진행 중 반복을 버리고 rest로 간다(그 프레임은 판정하지 않음). 준비 전(calibrating)에는 따지지 않는다.
 * - 재무장: rest로 돌아가면 재무장선을 한 번 지나야 다음 반복을 시작한다. rest로 돌아온 그 프레임
 *   (확정·미달 복귀·오래 가림 복귀·보정 직후)이 이미 재무장선 너머면 바로 무장한다.
 *   반환점 확정(countAt 'turn') 뒤에는 그 프레임으로 무장하지 않는다.
 * - peak(rest 중 최고점)·valley(turned 중 최저점)를 추적해 전략의 선 계산에 넘긴다.
 * - 최소 시간: startT→endT가 minRepMs 미만이면 rest로 가되 세지 않는다.
 */
export class RepEngine {
  private inner: Inner;
  private n = 0;
  private startT = 0;
  private turnT = 0;
  private peak = 0;
  private valley = 0;
  private valleyT = 0;
  private pausedSince: number | null = null;
  private armed = false;
  private readonly sign: 1 | -1;

  constructor(
    private readonly strategy: JudgeStrategy,
    private readonly cfg: RepEngineConfig,
  ) {
    this.sign = restSign(cfg.restSide);
    this.inner = strategy.ready() ? 'rest' : 'calibrating';
  }

  get count(): number {
    return this.n;
  }

  /** 준비 전에는 신호가 끊겨도 'calibrating'(안내를 계속 보이게). 그 외 null이면 'paused' */
  get phase(): RepEnginePhase {
    if (this.inner === 'calibrating') return 'calibrating';
    return this.pausedSince !== null ? 'paused' : this.inner;
  }

  /** 지금 신호가 끊겨 있는지. 준비 전에도 phase와 따로 알려 준다 */
  get paused(): boolean {
    return this.pausedSince !== null;
  }

  reset(): void {
    this.strategy.reset();
    this.inner = this.strategy.ready() ? 'rest' : 'calibrating';
    this.n = 0;
    this.startT = 0;
    this.turnT = 0;
    this.peak = 0;
    this.valley = 0;
    this.valleyT = 0;
    this.pausedSince = null;
    this.armed = false;
  }

  /** @param ready 이 프레임이 준비 자세인지. 준비 전에만 전략에 넘긴다. 생략하면 true */
  update(t: number, signal: number | null, ready: boolean | null = true): RepEvent | null {
    const st = this.strategy;
    if (signal === null) {
      if (this.pausedSince === null) this.pausedSince = t;
      if (this.inner === 'calibrating') st.calibrate(t, null, ready);
      return null;
    }
    const s = this.sign * signal;
    const longPause = this.pausedSince !== null && t - this.pausedSince >= this.cfg.pauseAfterMs;
    this.pausedSince = null;

    if (this.inner === 'calibrating') {
      st.calibrate(t, s, ready);
      if (st.ready()) this.toRest(s, true);
      return null;
    }
    if (longPause) {
      // 진행 중 반복을 버린다. peak를 지금 값에서 다시 시작하므로 바닥에서 재개해 올라와도 세지 않는다.
      this.toRest(s, true);
      return null;
    }

    switch (this.inner) {
      case 'rest':
        this.peak = Math.max(this.peak, s);
        if (!this.armed) {
          if (s <= st.rearmLine()) return null;
          this.armed = true;
        }
        if (s < st.startLine(this.peak)) {
          this.inner = 'out';
          this.startT = t;
        }
        return null;
      case 'out':
        if (s <= st.turnLine()) {
          this.turnT = t;
          this.valley = s;
          this.valleyT = t;
          if (this.cfg.countAt === 'turn') {
            // 반환점 도달 즉시 확정. 최소 시간 미달이어도 재무장 전에는 새 반복을 시작하지 않는다.
            this.toRest(s, false);
            return this.finish(t);
          }
          this.inner = 'turned';
        } else if (s > st.abortLine(this.peak)) {
          // 반환점에 못 가고 돌아옴: 세지 않는다.
          this.toRest(s, true);
        }
        return null;
      case 'turned':
        if (s < this.valley) {
          this.valley = s;
          this.valleyT = t;
        }
        if (s <= st.completeLine(this.valley)) return null;
        this.toRest(s, true);
        return this.finish(t);
    }
  }

  /** rest로 돌아가며 peak를 지금 값에서 다시 시작한다. mayArm이면 이 프레임으로 재무장을 검사한다. */
  private toRest(s: number, mayArm: boolean): void {
    this.inner = 'rest';
    this.peak = s;
    this.armed = mayArm && s > this.strategy.rearmLine();
  }

  /** 최소 시간을 넘었으면 1회 확정하고 이벤트를 만든다. */
  private finish(endT: number): RepEvent | null {
    if (endT - this.startT < this.cfg.minRepMs) return null;
    this.n += 1;
    return {
      index: this.n,
      startT: this.startT,
      turnT: this.turnT,
      endT,
      outMs: this.turnT - this.startT,
      backMs: endT - this.turnT,
      // 내부 valley는 부호를 곱한 값이므로 원래 단위로 되돌린다.
      valley: this.valley * this.sign,
      valleyT: this.valleyT,
    };
  }
}
