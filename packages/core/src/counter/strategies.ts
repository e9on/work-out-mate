import { restSign, type JudgeStrategy } from './repEngine';
import type { RepConfig } from './repCounter';
import type { AdaptiveConfig, CalibrationSource } from './adaptiveRepCounter';

/**
 * 고정 임계값 판정. 시작 enter, 반환점 turn, 복귀·미달 복귀·재무장은 모두 exit.
 * 경계값은 넘어야(같으면 아님) 하고, rest로 돌아온 프레임에서 바로 재무장을 검사한다.
 */
export function fixedStrategy(cfg: RepConfig): JudgeStrategy {
  const k = restSign(cfg.restSide);
  const enter = k * cfg.enter;
  const turn = k * cfg.turn;
  const exit = k * cfg.exit;
  return {
    inclusive: false,
    armOnEntry: true,
    ready: () => true,
    calibrate: () => {},
    startLine: () => enter,
    turnLine: () => turn,
    completeLine: () => exit,
    abortLine: () => exit,
    rearmLine: () => exit,
    reset: () => {},
  };
}

export type AdaptiveStrategy = JudgeStrategy & {
  /** 준비 자세 기준값(원래 단위). 보정 전이면 null */
  readonly baseline: number | null;
  readonly calibrated: boolean;
  /** 기준값의 출처. 보정 전이면 null */
  readonly calibrationSource: CalibrationSource | null;
};

/** 보정 확정에 필요한 최소 표본 수(구간 안 유효 프레임) */
const MIN_CALIBRATE_SAMPLES = 10;

/**
 * 준비 자세 기준 판정. 처음에 준비 자세(신호가 잠시 안정된 값)를 baseline으로 잡고,
 * 바닥은 baseline − depth, 시작은 peak − startDrop, 복귀는 valley + rebound,
 * 미달 복귀는 peak − startDrop/2, 재무장선은 baseline − depth/2.
 * 경계값과 같으면 넘은 것으로 보고, rest로 돌아온 프레임에서는 재무장하지 않는다(다음 프레임부터).
 */
export function adaptiveStrategy(cfg: AdaptiveConfig): AdaptiveStrategy {
  return new AdaptiveJudge(cfg);
}

class AdaptiveJudge implements AdaptiveStrategy {
  readonly inclusive = true;
  readonly armOnEntry = false;
  private readonly k: 1 | -1;
  /** 내부 부호 기준 baseline. null이면 아직 보정 전 */
  private base: number | null = null;
  /** 보정 구간: 최근 calibrateMs를 덮는 최소한의 유효 신호들(내부 부호) */
  private win: Array<[number, number]> = [];
  /** 보정 구간이 마지막으로 비워진 뒤 처음 들어온 유효(준비 자세) 신호 시각. 타임아웃 기준점 */
  private calibrateFromT: number | null = null;
  /** 보정 구간이 마지막으로 비워진 뒤 받은 유효 신호의 rest 쪽 최고값(내부 부호). 타임아웃 때 기준으로 쓴다 */
  private obsBest: number | null = null;
  private source: CalibrationSource | null = null;

  constructor(private readonly cfg: AdaptiveConfig) {
    this.k = restSign(cfg.restSide);
  }

  get baseline(): number | null {
    return this.base === null ? null : this.k * this.base;
  }

  get calibrated(): boolean {
    return this.base !== null;
  }

  get calibrationSource(): CalibrationSource | null {
    return this.source;
  }

  ready(): boolean {
    return this.base !== null;
  }

  reset(): void {
    this.base = null;
    this.source = null;
    this.clearCalibration();
  }

  startLine(peak: number): number {
    return peak - this.cfg.startDrop;
  }

  turnLine(): number {
    return this.base! - this.cfg.depth;
  }

  completeLine(valley: number): number {
    return valley + this.cfg.rebound;
  }

  abortLine(peak: number): number {
    return peak - this.cfg.startDrop / 2;
  }

  rearmLine(): number {
    return this.base! - this.cfg.depth / 2;
  }

  /**
   * ready가 true인 유효 프레임만 보정 구간에 쌓는다. 가림(null)이나 ready false·null이면 구간을 비운다
   * (가림 앞뒤를 이어 붙여 확정하지 않음).
   */
  calibrate(t: number, s: number | null, ready: boolean | null): void {
    if (s === null || ready !== true) {
      this.clearCalibration();
      return;
    }
    const { calibrateMs, calibrateTol, calibrateTimeoutMs, defaultBaseline, minBaseline } = this.cfg;
    if (this.calibrateFromT === null) this.calibrateFromT = t;
    this.obsBest = this.obsBest === null ? s : Math.max(this.obsBest, s);
    this.win.push([t, s]);
    // calibrateMs를 덮는 최소 구간만 남긴다(두 번째 표본부터도 calibrateMs 이상이면 맨 앞은 버림).
    while (this.win.length > 1 && t - this.win[1]![0] >= calibrateMs) this.win.shift();

    if (this.win.length >= MIN_CALIBRATE_SAMPLES && t - this.win[0]![0] >= calibrateMs) {
      let min = Infinity, max = -Infinity, sum = 0;
      for (const [, v] of this.win) {
        if (v < min) min = v;
        if (v > max) max = v;
        sum += v;
      }
      const mean = sum / this.win.length;
      if (max - min <= calibrateTol && mean >= this.k * minBaseline) {
        this.finish(mean, 'measured');
        return;
      }
    }
    if (t - this.calibrateFromT >= calibrateTimeoutMs) {
      // 계속 움직여 못 잡았으면 본 것 중 rest 쪽 최고점을 쓴다(기본값보다 실제 자세에 가깝다).
      // 단, 정상 보정처럼 minBaseline 이상이어야 한다(바닥 근처만 본 경우는 기본값).
      // 주의: 최댓값이라 노이즈 한 프레임이 기준이 될 수 있다.
      if (this.obsBest !== null && this.obsBest >= this.k * minBaseline) {
        this.finish(this.obsBest, 'observed');
      } else {
        this.finish(this.k * defaultBaseline, 'default');
      }
    }
  }

  private finish(base: number, source: CalibrationSource): void {
    this.base = base;
    this.source = source;
    this.clearCalibration();
  }

  /** 보정 구간을 비우고 타임아웃 기준점도 다음 유효 신호로 옮긴다. */
  private clearCalibration(): void {
    this.win = [];
    this.calibrateFromT = null;
    this.obsBest = null;
  }
}
