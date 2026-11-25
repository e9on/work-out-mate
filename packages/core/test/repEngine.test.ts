import { describe, expect, it } from 'vitest';
import { RepCounter, type RepConfig, type RepEvent } from '../src/counter/repCounter';
import { AdaptiveRepCounter, type AdaptiveConfig } from '../src/counter/adaptiveRepCounter';
import { RepEngine, type JudgeStrategy } from '../src/counter/repEngine';
import { adaptiveStrategy, fixedStrategy } from '../src/counter/strategies';

// 두 카운터는 기존 테스트와 같은 설정을 쓴다.
const FIXED: RepConfig = { restSide: 'high', enter: 150, turn: 95, exit: 160, minRepMs: 500, pauseAfterMs: 1500 };
const ADAPTIVE: AdaptiveConfig = {
  restSide: 'high',
  depth: 40,
  rebound: 30,
  startDrop: 10,
  calibrateMs: 700,
  calibrateTol: 8,
  calibrateTimeoutMs: 3000,
  defaultBaseline: 165,
  minBaseline: 140,
  minRepMs: 500,
  pauseAfterMs: 1500,
};
const DT = 33;

type Frame = [number, number | null];
type Counter = { update(t: number, signal: number | null): RepEvent | null };

function run(c: Counter, frames: Frame[]): RepEvent[] {
  const ev: RepEvent[] = [];
  for (const [t, v] of frames) {
    const e = c.update(t, v);
    if (e) ev.push(e);
  }
  return ev;
}

/** t0부터 t1 전까지 step 간격으로 같은 값 */
function hold(v: number | null, t0: number, t1: number, step = DT): Frame[] {
  const out: Frame[] = [];
  for (let t = t0; t < t1; t += step) out.push([t, v]);
  return out;
}

/** 준비 자세 168로 1초 정지 → 기준 168(정확히), 재무장선 148, 바닥선 128, 시작은 peak−10, 미달 복귀는 peak−5 */
function calibrated168(): AdaptiveRepCounter {
  const c = new AdaptiveRepCounter(ADAPTIVE);
  run(c, hold(168, 0, 1000));
  expect(c.calibrated).toBe(true);
  expect(c.baseline).toBe(168);
  return c;
}

/*
 * 특성 테스트: 두 카운터가 지금 다르게 동작하는 지점을 그대로 고정한다.
 * 공통 껍데기로 옮긴 뒤에도 이 결과가 같아야 한다.
 */
describe('특성: 오래 가림 뒤 복귀 프레임', () => {
  it('Fixed: 복귀 프레임에서 진행 중 반복을 버리고, 그 프레임으로 바로 재무장한다', () => {
    const c = new RepCounter(FIXED);
    const ev = run(c, [
      [0, 170], [100, 140], [300, 90], // out → turned
      ...hold(null, 333, 2400, 100), // 2초 가림
      [2400, 170], // 복귀: 버림 + 이 프레임(>160)으로 재무장
      [2500, 140], [2800, 90], [3100, 170],
    ]);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.startT).toBe(2500);
    expect(c.count).toBe(1);
  });

  it('Adaptive: 복귀 프레임에서 진행 중 반복을 버리고, 그 프레임(재무장선 위)으로 바로 재무장한다', () => {
    // 통합 전에는 복귀 프레임에서 무장하지 않아 0이었다(Fixed와 맞춤).
    const c = calibrated168();
    const ev = run(c, [
      [1100, 150], [1300, 110], // out → turned
      ...hold(null, 1400, 3500, 100), // 2초 가림
      [3500, 168], // 복귀: 버림, peak 168, 168 > 148이라 무장
      [3533, 140], [3800, 110], [4200, 168],
    ]);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.startT).toBe(3533);
  });

  it('Adaptive: 보정 중에는 오래 가림을 따지지 않고, 복귀 프레임을 보정(타임아웃 기준점)에 쓴다', () => {
    const c = new AdaptiveRepCounter(ADAPTIVE);
    run(c, hold(null, 0, 2100, 100));
    c.update(2100, 150);
    c.update(5099, 150);
    expect(c.calibrated).toBe(false);
    c.update(5100, 150);
    expect(c.calibrated).toBe(true);
    expect(c.calibrationSource).toBe('observed');
  });

  it('Fixed: 보정 단계가 없어 처음부터 rest', () => {
    const c = new RepCounter(FIXED);
    expect(c.phase).toBe('rest');
    c.update(0, null);
    expect(c.phase).toBe('paused');
  });
});

describe('특성: rest로 돌아온 프레임의 재무장', () => {
  it('Fixed: 확정 프레임(>exit)에서 바로 재무장해, 다음 프레임에 새 반복을 시작할 수 있다', () => {
    const c = new RepCounter(FIXED);
    const ev = run(c, [
      [0, 170], [100, 140], [300, 90], [700, 165], // 1회 확정
      [733, 140], [1000, 90], [1300, 170], // 바로 다음 프레임에 시작
    ]);
    expect(ev).toHaveLength(2);
    expect(ev[1]!.startT).toBe(733);
  });

  it('Adaptive: 확정 프레임이 재무장선 위면 그 프레임에서 무장한다', () => {
    // 통합 전에는 확정 프레임에서 무장하지 않아 1이었다(Fixed와 맞춤).
    const c = calibrated168();
    const ev = run(c, [
      [1100, 150], [1300, 120], [1700, 151], // 1회 확정(>120+30), 151 > 148이라 무장
      [1733, 135], [2000, 100], [2400, 168], // 135 < 151−10이라 바로 시작
    ]);
    expect(ev).toHaveLength(2);
    expect(ev[1]!.startT).toBe(1733);
  });

  it('Adaptive: 확정 프레임이 재무장선 아래면 무장하지 않는다(바닥 근처 흔들림으로 두 번 세지 않음)', () => {
    const c = calibrated168();
    run(c, [
      [1100, 150], [1300, 100], [1700, 140], // 1회 확정(>100+30), 140 < 148
      [1733, 120], [2000, 100], [2400, 145], // 재무장선 아래에서만 움직임
    ]);
    expect(c.count).toBe(1);
  });

  it('Fixed: 미달 복귀 프레임(>exit)에서 바로 재무장한다', () => {
    const c = new RepCounter(FIXED);
    const ev = run(c, [
      [0, 170], [100, 140], [300, 165], // 시작 → 미달 복귀
      [333, 140], [600, 90], [900, 170],
    ]);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.startT).toBe(333);
  });

  it('Adaptive: 미달 복귀 프레임이 재무장선 위면 그 프레임에서 무장한다', () => {
    // 통합 전에는 미달 복귀 프레임에서 무장하지 않아 0이었다(Fixed와 맞춤).
    const c = calibrated168();
    const ev = run(c, [
      [1100, 155], [1200, 164], // 시작(<158) → 미달 복귀(>163), peak 164, 무장
      [1233, 140], [1500, 100], [1900, 168],
    ]);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.startT).toBe(1233);
  });
});

describe('특성: 경계값 비교', () => {
  it('Fixed: 재무장·시작·복귀는 경계값을 넘어야(같으면 아님), 반환점은 같아도 도달', () => {
    const c = new RepCounter(FIXED);
    const ev = run(c, [
      [0, 160], // == exit: 무장 안 함
      [100, 140], [200, 90], // 무장 전이라 시작 안 함
      [300, 170], // 무장
      [400, 150], // == enter: 시작 안 함
      [500, 120], // 시작
      [700, 95], // == turn: 반환점 도달
      [900, 160], // == exit: 확정 안 함
      [1100, 170], // 확정
    ]);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ startT: 500, turnT: 700, endT: 1100 });
  });

  it('Fixed: 미달 복귀도 exit와 같으면 아님', () => {
    const c = new RepCounter(FIXED);
    const ev = run(c, [[0, 170], [100, 140], [200, 160], [300, 90], [700, 170]]);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.startT).toBe(100);
  });

  it('Adaptive: Fixed와 같이 재무장·시작·복귀·미달 복귀는 넘어야, 바닥은 같아도 도달', () => {
    // 통합 전에는 Adaptive만 경계값과 같아도 넘은 것으로 봤다.
    const c = calibrated168();
    const ev = run(c, [
      [1100, 158], // == peak−10: 시작 안 함
      [1133, 157], // 시작
      [1300, 128], // == base−depth: 바닥
      [1500, 120],
      [1700, 150], // == valley+rebound: 확정 안 함
      [1733, 151], // 확정, peak 151, 무장
      [1766, 141], // == peak−10: 시작 안 함
      [1800, 140], // 시작
      [1900, 146], // == peak−startDrop/2: 미달 복귀 아님
    ]);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ startT: 1133, turnT: 1300, endT: 1733 });
    expect(c.phase).toBe('out');
    run(c, [
      [2000, 147], // 미달 복귀, 147 < 148이라 무장 안 함
      [2033, 148], // == 재무장선: 무장 안 함
      [2066, 130], // 무장 전이라 시작 안 함
    ]);
    expect(c.phase).toBe('rest');
    run(c, [[2100, 149], [2133, 138]]); // 무장 → 시작(< 149−10)
    expect(c.phase).toBe('out');
    expect(c.count).toBe(1);
  });
});

describe('RepEngine + fixedStrategy', () => {
  const engineOf = (cfg: RepConfig) => new RepEngine(fixedStrategy(cfg), cfg);

  it('완전한 1회: 이벤트 시각과 구간 길이', () => {
    const e = engineOf(FIXED);
    const ev = run(e, [[0, 170], [100, 140], [533, 90], [566, 92], [1000, 165], [1033, 170]]);
    expect(ev).toEqual([{ index: 1, startT: 100, turnT: 533, endT: 1000, outMs: 433, backMs: 467, valley: 90, valleyT: 533 }]);
    expect(e.count).toBe(1);
    expect(e.phase).toBe('rest');
  });

  it('RepEvent.valley는 반복 중 신호 최저점', () => {
    const e = engineOf(FIXED);
    const ev = run(e, [[0, 170], [300, 100], [600, 95], [900, 120], [1200, 170]]);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.valley).toBe(95);
  });

  it('RepEvent.valleyT는 최저점에 닿은 시각(반환선을 지난 turnT가 아님)', () => {
    const e = engineOf(FIXED);
    // FIXED 반환선은 95: 300ms에 반환선, 600ms에 최저점 80
    const ev = run(e, [[0, 170], [100, 140], [300, 95], [600, 80], [900, 120], [1200, 170]]);
    expect(ev[0]!.turnT).toBe(300);
    expect(ev[0]!.valleyT).toBe(600);
  });

  it('최저값이 여러 번 같으면 처음 닿은 시각을 valleyT로 둔다', () => {
    const e = engineOf(FIXED);
    const ev = run(e, [[0, 170], [100, 140], [300, 95], [600, 80], [700, 80], [900, 120], [1200, 170]]);
    expect(ev[0]!.valleyT).toBe(600);
  });

  it('오래 가림이면 진행 중 반복을 버린다', () => {
    const e = engineOf(FIXED);
    run(e, [[0, 170], [100, 140], [300, 90]]);
    run(e, hold(null, 333, 2400, 100));
    expect(e.phase).toBe('paused');
    expect(e.paused).toBe(true);
    expect(run(e, [[2400, 90], [2700, 130], [3000, 170]])).toHaveLength(0);
    expect(e.count).toBe(0);
  });

  it("restSide low + countAt 'turn': 반환점 프레임에서 확정, backMs 0", () => {
    const cfg: RepConfig = { restSide: 'low', enter: 100, turn: 140, exit: 95, minRepMs: 500, pauseAfterMs: 1500, countAt: 'turn' };
    const e = engineOf(cfg);
    const ev = run(e, [[0, 50], [100, 110], [900, 145], [1000, 150]]);
    expect(ev).toEqual([{ index: 1, startT: 100, turnT: 900, endT: 900, outMs: 800, backMs: 0, valley: 145, valleyT: 900 }]);
    // 재무장(exit 너머) 전에는 바닥에서 흔들려도 다시 세지 않는다
    run(e, [[1100, 120], [1400, 150]]);
    expect(e.count).toBe(1);
  });

  it('reset은 count와 상태를 처음으로', () => {
    const e = engineOf(FIXED);
    run(e, [[0, 170], [100, 140], [300, 90], [700, 170]]);
    expect(e.count).toBe(1);
    e.reset();
    expect(e.count).toBe(0);
    expect(e.phase).toBe('rest');
  });
});

describe('RepEngine + adaptiveStrategy', () => {
  it('보정 → 1회, 전략이 기준값과 출처를 알려 준다', () => {
    const judge = adaptiveStrategy(ADAPTIVE);
    const e = new RepEngine(judge, ADAPTIVE);
    expect(e.phase).toBe('calibrating');
    expect(judge.calibrated).toBe(false);
    run(e, hold(168, 0, 1000));
    expect(judge.baseline).toBe(168);
    expect(judge.calibrationSource).toBe('measured');
    expect(e.phase).toBe('rest');
    const ev = run(e, [[1100, 150], [1300, 120], [1700, 151]]);
    expect(ev).toEqual([{ index: 1, startT: 1100, turnT: 1300, endT: 1700, outMs: 200, backMs: 400, valley: 120, valleyT: 1300 }]);
  });

  it('ready가 true가 아닌 프레임은 보정에 쓰지 않는다', () => {
    const judge = adaptiveStrategy(ADAPTIVE);
    const e = new RepEngine(judge, ADAPTIVE);
    for (let t = 0; t < 2000; t += DT) e.update(t, 168, false);
    expect(judge.calibrated).toBe(false);
    for (let t = 2000; t < 3000; t += DT) e.update(t, 168, true);
    expect(judge.calibrated).toBe(true);
  });

  it('reset은 전략의 보정도 처음으로', () => {
    const judge = adaptiveStrategy(ADAPTIVE);
    const e = new RepEngine(judge, ADAPTIVE);
    run(e, hold(168, 0, 1000));
    e.reset();
    expect(e.phase).toBe('calibrating');
    expect(judge.baseline).toBeNull();
    expect(judge.calibrationSource).toBeNull();
  });
});

describe('RepEngine: 껍데기는 전략이 정한 선만으로 판정한다', () => {
  /** 선이 고정이고 N프레임 뒤에 준비되는 가짜 전략. 시작 50, 반환점 20, 복귀·미달 70, 재무장 80 */
  function fake(readyAfter: number): JudgeStrategy & { calls: number } {
    return {
      calls: 0,
      ready() { return this.calls >= readyAfter; },
      calibrate() { this.calls += 1; },
      startLine: () => 50,
      turnLine: () => 20,
      completeLine: () => 70,
      abortLine: () => 70,
      rearmLine: () => 80,
      reset() { this.calls = 0; },
    };
  }

  it('준비 전에는 calibrating, 준비되면 rest로 가서 센다', () => {
    const e = new RepEngine(fake(3), { restSide: 'high', minRepMs: 0, pauseAfterMs: 1000 });
    expect(e.phase).toBe('calibrating');
    run(e, [[0, 90], [10, 90]]);
    expect(e.phase).toBe('calibrating');
    run(e, [[20, 90]]);
    expect(e.phase).toBe('rest');
    const ev = run(e, [[30, 90], [40, 40], [50, 10], [60, 75]]);
    expect(ev).toEqual([{ index: 1, startT: 40, turnT: 50, endT: 60, outMs: 10, backMs: 10, valley: 10, valleyT: 50 }]);
  });

  it('restSide low면 신호 부호를 뒤집어 같은 선과 비교한다', () => {
    const e = new RepEngine(fake(0), { restSide: 'low', minRepMs: 0, pauseAfterMs: 1000 });
    const ev = run(e, [[0, -90], [10, -40], [20, -10], [30, -75]]);
    expect(ev).toHaveLength(1);
  });

  it("restSide 'low'면 valley는 원래 단위의 최대점", () => {
    const e = new RepEngine(fake(0), { restSide: 'low', minRepMs: 0, pauseAfterMs: 1000 });
    const ev = run(e, [[0, -90], [10, -40], [20, -10], [30, -75]]);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.valley).toBe(-10);
  });

  it('최소 시간 미달이면 이벤트 없이 rest로', () => {
    const e = new RepEngine(fake(0), { restSide: 'high', minRepMs: 500, pauseAfterMs: 1000 });
    expect(run(e, [[0, 90], [10, 40], [20, 10], [30, 75]])).toHaveLength(0);
    expect(e.phase).toBe('rest');
    expect(e.count).toBe(0);
  });
});
