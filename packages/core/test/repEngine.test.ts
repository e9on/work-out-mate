import { describe, expect, it } from 'vitest';
import { RepCounter, type RepConfig, type RepEvent } from '../src/counter/repCounter';
import { AdaptiveRepCounter, type AdaptiveConfig } from '../src/counter/adaptiveRepCounter';

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

  it('Adaptive: 복귀 프레임은 peak만 다시 잡고 판정에 쓰지 않는다(재무장선 위여도 무장하지 않음)', () => {
    const c = calibrated168();
    run(c, [
      [1100, 150], [1300, 110], // out → turned
      ...hold(null, 1400, 3500, 100), // 2초 가림
      [3500, 168], // 복귀: rest, peak 168, 무장 안 함
      [3533, 140], [3800, 110], [4200, 168], // 140 < 148이라 무장 전 → 시작 안 함
    ]);
    expect(c.count).toBe(0);
    expect(c.phase).toBe('rest');
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

  it('Adaptive: 확정 프레임이 재무장선 위여도 그 프레임에서는 무장하지 않는다', () => {
    const c = calibrated168();
    run(c, [
      [1100, 150], [1300, 120], [1700, 150], // 1회 확정(120+30), 150 ≥ 148이지만 무장 안 함
      [1733, 135], [2000, 100], [2400, 168], // 135 < 148이라 시작 안 함
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

  it('Adaptive: 미달 복귀 프레임이 재무장선 위여도 그 프레임에서는 무장하지 않는다', () => {
    const c = calibrated168();
    run(c, [
      [1100, 155], [1200, 164], // 시작(≤158) → 미달 복귀(≥163), peak 164
      [1233, 140], [1500, 100], [1900, 168],
    ]);
    expect(c.count).toBe(0);
  });

  it('Adaptive: 무장하는 프레임에서 시작선도 바로 본다', () => {
    const c = calibrated168();
    const ev = run(c, [
      [1100, 150], [1300, 125], [1700, 165], // 1회 확정, peak 165, 무장 안 함
      [1733, 150], // 150 ≥ 148 무장 + 150 ≤ 155 시작
      [2000, 110], [2400, 168],
    ]);
    expect(ev).toHaveLength(2);
    expect(ev[1]!.startT).toBe(1733);
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

  it('Adaptive: 재무장·시작·바닥·복귀·미달 복귀 모두 경계값과 같으면 넘은 것으로 본다', () => {
    const c = calibrated168();
    const ev = run(c, [
      [1100, 158], // == peak−10: 시작
      [1300, 128], // == base−depth: 바닥
      [1500, 120],
      [1700, 150], // == valley+rebound: 확정, peak 150
      [1733, 148], // == 재무장선: 무장
      [1766, 140], // == peak−10: 시작
      [1900, 145], // == peak−startDrop/2: 미달 복귀
    ]);
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ startT: 1100, turnT: 1300, endT: 1700 });
    expect(c.count).toBe(1);
    expect(c.phase).toBe('rest');
  });
});
