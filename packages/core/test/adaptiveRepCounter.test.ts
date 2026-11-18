import { describe, expect, it } from 'vitest';
import { AdaptiveRepCounter, type AdaptiveConfig } from '../src/counter/adaptiveRepCounter';
import type { RepEvent } from '../src/counter/repCounter';

// pushup 초기값(지시서)과 같다.
const CFG: AdaptiveConfig = {
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

/** 시점 t0부터 33ms 간격 프레임을 이어 붙이는 작은 빌더. */
class Seq {
  frames: Frame[] = [];
  constructor(public t = 0) {}
  /** v에서 ms 동안 정지 */
  hold(v: number | null, ms: number): this {
    const n = Math.max(1, Math.round(ms / DT));
    for (let i = 0; i < n; i++) this.push(v);
    return this;
  }
  /** a→b로 ms 동안 선형 변화(시작점 포함, 끝점 제외) */
  ramp(a: number, b: number, ms: number): this {
    const n = Math.max(1, Math.round(ms / DT));
    for (let i = 0; i < n; i++) this.push(a + ((b - a) * i) / n);
    return this;
  }
  /** top → bottom → top 한 번(각 600ms) */
  rep(top: number, bottom: number, ms = 600): this {
    return this.ramp(top, bottom, ms).hold(bottom, 100).ramp(bottom, top, ms).hold(top, 200);
  }
  push(v: number | null, dt = DT): this {
    this.frames.push([this.t, v]);
    this.t += dt;
    return this;
  }
}

function run(c: AdaptiveRepCounter, frames: Frame[]): RepEvent[] {
  const ev: RepEvent[] = [];
  for (const [t, v] of frames) {
    const e = c.update(t, v);
    if (e) ev.push(e);
  }
  return ev;
}

describe('AdaptiveRepCounter: 준비 자세 기준 + 상대 판정', () => {
  it('1. 준비 자세 168에서 1초 정지 → 반복 3회(맨 위 155, 바닥 115) → 3', () => {
    const c = new AdaptiveRepCounter(CFG);
    const s = new Seq().hold(168, 1000);
    run(c, s.frames);
    expect(c.calibrated).toBe(true);
    expect(c.baseline).toBeCloseTo(168, 5);
    expect(c.phase).toBe('rest');
    const s2 = new Seq(s.t).ramp(168, 155, 300).rep(155, 115).rep(155, 115).rep(155, 115);
    const ev = run(c, s2.frames);
    expect(c.count).toBe(3);
    expect(ev.map((e) => e.index)).toEqual([1, 2, 3]);
    for (const e of ev) {
      expect(e.outMs).toBe(e.turnT - e.startT);
      expect(e.backMs).toBe(e.endT - e.turnT);
    }
  });

  it('2. 카메라 각도로 전체가 −15° 밀림: 준비 153, 맨 위 140, 바닥 100 → 3', () => {
    const c = new AdaptiveRepCounter(CFG);
    const s = new Seq().hold(153, 1000).ramp(153, 140, 300).rep(140, 100).rep(140, 100).rep(140, 100);
    run(c, s.frames);
    expect(c.baseline).toBeCloseTo(153, 5);
    expect(c.count).toBe(3);
  });

  it('3. 준비 자세를 못 잡음(처음부터 계속 움직임): 3초 뒤 defaultBaseline으로 시작해 이후 반복을 센다', () => {
    const c = new AdaptiveRepCounter(CFG);
    // 한 주기 1200ms(165→110 600ms, 110→165 600ms), 쉬지 않고 6회. t=3000은 3번째 반복의 바닥.
    const s = new Seq();
    for (let i = 0; i < 6; i++) s.ramp(165, 110, 600).ramp(110, 165, 600);
    s.hold(165, 300);
    let calibratingUntil = -1;
    let countBefore3s = 0;
    for (const [t, v] of s.frames) {
      c.update(t, v);
      if (c.phase === 'calibrating') calibratingUntil = t;
      if (t < 3000) countBefore3s = c.count;
    }
    expect(countBefore3s).toBe(0);
    expect(calibratingUntil).toBeGreaterThanOrEqual(2950);
    expect(calibratingUntil).toBeLessThan(3000);
    expect(c.calibrated).toBe(true);
    expect(c.baseline).toBe(165);
    // 3초 시점에 바닥이던 3번째 반복은 세지 않고, 4~6번째만 센다.
    expect(c.count).toBe(3);
  });

  it('4. 바닥 미도달(준비 168, 바닥 135) → 0', () => {
    const c = new AdaptiveRepCounter(CFG);
    const s = new Seq().hold(168, 1000).rep(168, 135).rep(168, 135).rep(168, 135);
    run(c, s.frames);
    expect(c.count).toBe(0);
    expect(c.phase).toBe('rest');
  });

  it('5. 맨 위 떨림 ±4° 300프레임 → 0', () => {
    const c = new AdaptiveRepCounter(CFG);
    const frames: Frame[] = [];
    for (let i = 0; i < 300; i++) frames.push([i * DT, 168 + 4 * Math.sin(i * 1.7)]);
    run(c, frames);
    expect(c.calibrated).toBe(true);
    expect(c.count).toBe(0);
    expect(c.phase).toBe('rest');
  });

  it('6. 바닥 자세에서 가만히 0.7초 이상(평균 < minBaseline) → 준비 자세로 인정하지 않는다', () => {
    const c = new AdaptiveRepCounter(CFG);
    run(c, new Seq().hold(100, 1000).frames);
    expect(c.calibrated).toBe(false);
    expect(c.baseline).toBeNull();
    expect(c.phase).toBe('calibrating');
    expect(c.count).toBe(0);
  });

  it('7a. 오래 가림 뒤 바닥에서 재개 → 올라옴 → 0', () => {
    const c = new AdaptiveRepCounter(CFG);
    const s = new Seq().hold(168, 1000).ramp(168, 110, 600).hold(null, 2000).ramp(110, 168, 600).hold(168, 300);
    let sawPaused = false;
    for (const [t, v] of s.frames) {
      c.update(t, v);
      if (v === null && c.phase === 'paused') sawPaused = true;
    }
    expect(sawPaused).toBe(true);
    expect(c.count).toBe(0);
    expect(c.phase).toBe('rest');
  });

  it('7b. 짧은 가림(<1500ms)이 반복 중간에 끼어도 그 반복은 1', () => {
    const c = new AdaptiveRepCounter(CFG);
    const s = new Seq().hold(168, 1000).ramp(168, 110, 600).hold(null, 330).ramp(110, 168, 600).hold(168, 300);
    run(c, s.frames);
    expect(c.count).toBe(1);
  });

  it('8. 불규칙 프레임 간격(33/200ms 섞임)에서도 1회 정확', () => {
    const c = new AdaptiveRepCounter(CFG);
    const s = new Seq().hold(168, 1000);
    const t0 = s.t;
    s.push(168, 33).push(165, 200) // t0, t0+33
      .push(150, 33) // t0+233: 168-10=158 이하 → startT
      .push(130, 200) // t0+266
      .push(110, 33) // t0+466: 168-40=128 이하 → turnT, valley 110
      .push(108, 200) // t0+499: valley 108
      .push(125, 33) // t0+699
      .push(132, 200) // t0+732
      .push(140, 33) // t0+932: 108+30=138 이상 → endT
      .push(160, 200);
    const ev = run(c, s.frames);
    expect(ev).toHaveLength(1);
    expect(ev[0]!.startT).toBe(t0 + 233);
    expect(ev[0]!.turnT).toBe(t0 + 466);
    expect(ev[0]!.endT).toBe(t0 + 932);
    expect(ev[0]!.outMs).toBe(233);
    expect(ev[0]!.backMs).toBe(466);
  });

  it('9. 너무 빠른 반복(전체 < 500ms) → 0', () => {
    const c = new AdaptiveRepCounter(CFG);
    const s = new Seq().hold(168, 1000).ramp(168, 100, 150).ramp(100, 168, 150).hold(168, 300);
    run(c, s.frames);
    expect(c.count).toBe(0);
    expect(c.phase).toBe('rest');
  });
});

describe('AdaptiveRepCounter: 그 밖의 동작', () => {
  it('보정 중에는 phase calibrating, baseline null, 세지 않는다', () => {
    const c = new AdaptiveRepCounter(CFG);
    expect(c.phase).toBe('calibrating');
    expect(c.calibrated).toBe(false);
    expect(c.baseline).toBeNull();
    c.update(0, 168);
    expect(c.phase).toBe('calibrating');
  });

  it('보정 중 null은 보정 구간을 비운다(가림 앞뒤를 이어 붙여 확정하지 않음)', () => {
    const c = new AdaptiveRepCounter(CFG);
    run(c, new Seq().hold(168, 400).hold(null, 100).hold(168, 400).frames);
    expect(c.calibrated).toBe(false);
  });

  it('restSide low: 부호를 뒤집어 같은 로직(준비 40 → 100까지 굽혔다 돌아옴 → 1)', () => {
    const c = new AdaptiveRepCounter({ ...CFG, restSide: 'low', depth: 50, defaultBaseline: 40, minBaseline: 60 });
    const s = new Seq().hold(40, 1000).ramp(40, 100, 600).hold(100, 100).ramp(100, 40, 600).hold(40, 200);
    run(c, s.frames);
    expect(c.baseline).toBeCloseTo(40, 5);
    expect(c.count).toBe(1);
  });

  it('reset은 보정까지 처음으로 돌린다', () => {
    const c = new AdaptiveRepCounter(CFG);
    run(c, new Seq().hold(168, 1000).rep(168, 110).frames);
    expect(c.count).toBe(1);
    c.reset();
    expect(c.count).toBe(0);
    expect(c.phase).toBe('calibrating');
    expect(c.baseline).toBeNull();
  });
});

describe('수정 1회차: 재무장선·보정 타임아웃 기준점·준비 자세 확인·표본 수', () => {
  it('재무장: 확정 직후 재무장선(base − depth/2)에 닿기 전 10~15° 다시 내려갔다 올라가도 추가 카운트 0', () => {
    const c = new AdaptiveRepCounter(CFG);
    // 기준 168, 바닥선 128, 재무장선 148. 최저 95 → 125에서 확정(95+30).
    const s = new Seq().hold(168, 1000).ramp(168, 95, 600).hold(95, 100).ramp(95, 128, 400); // 마지막 값 약 125.3
    run(c, s.frames);
    expect(c.count).toBe(1);
    // 재무장 전에 125 → 112(−13°)로 내려갔다가 150까지 올라옴: 재무장 없으면 2회째로 셈
    const s2 = new Seq(s.t).ramp(125, 112, 400).hold(112, 100).ramp(112, 150, 600).ramp(150, 168, 300).hold(168, 300);
    run(c, s2.frames);
    expect(c.count).toBe(1);
  });

  it('재무장: 재무장선을 지난 뒤의 정상 반복은 센다', () => {
    const c = new AdaptiveRepCounter(CFG);
    const s = new Seq().hold(168, 1000).rep(168, 95).rep(168, 95);
    run(c, s.frames);
    expect(c.count).toBe(2);
  });

  it('재무장: 미달 복귀 뒤에도 재무장선을 지나야 다음 반복을 시작한다', () => {
    const c = new AdaptiveRepCounter(CFG);
    // 기준 168, 바닥선 128, 재무장선 148. 1회(최저 95) 확정 뒤 150까지 올라와 무장(peak 150).
    // 139로 내려가 시작(≤140) → 바닥 미달로 146까지 복귀(≥145): rest로 가며 재무장 필요(146 < 148).
    // 그 상태에서 125까지 내려갔다 160으로 올라와도, 재무장 없으면 2회째로 센다.
    const s = new Seq().hold(168, 1000).ramp(168, 95, 600).hold(95, 100).ramp(95, 150, 600)
      .ramp(150, 139, 300).ramp(139, 146, 300).hold(146, 100)
      .ramp(146, 125, 400).hold(125, 100).ramp(125, 160, 600).hold(160, 300);
    run(c, s.frames);
    expect(c.count).toBe(1);
  });

  it('보정 직후에도 재무장선 아래면 시작하지 않는다(타임아웃으로 바닥 근처에서 기본값 확정)', () => {
    const c = new AdaptiveRepCounter(CFG);
    // 3초 동안 계속 움직이다 t≈3000에서 115 근처: 기본값 165, 재무장선 145.
    // 그 뒤 115~135 사이에서만 흔들리면(재무장선 미만) 세지 않는다.
    const s = new Seq();
    for (let i = 0; i < 5; i++) s.ramp(115, 135, 300).ramp(135, 115, 300);
    s.hold(115, 100);
    for (let i = 0; i < 5; i++) s.ramp(115, 100, 300).ramp(100, 135, 400);
    run(c, s.frames);
    expect(c.calibrated).toBe(true);
    expect(c.count).toBe(0);
  });

  it('타임아웃 기준점: 1초 보임 → 2초 가림 → 다시 보임 → 그 시점부터 3초 안에는 기본값으로 넘어가지 않는다', () => {
    const c = new AdaptiveRepCounter(CFG);
    const moving = (seq: Seq, ms: number) => {
      const end = seq.t + ms;
      while (seq.t < end) seq.ramp(168, 120, 300).ramp(120, 168, 300);
      return seq;
    };
    const s = moving(new Seq(), 1000).hold(null, 2000);
    run(c, s.frames);
    const back = s.t;
    const s2 = moving(new Seq(back), 2900);
    for (const [t, v] of s2.frames) {
      c.update(t, v);
      if (t < back + 3000) expect(c.calibrated, `t=${t - back}ms`).toBe(false);
    }
    expect(c.phase).toBe('calibrating');
    // 다시 보인 뒤 3초가 지나면 기본값
    run(c, moving(new Seq(s2.t), 600).frames);
    expect(c.calibrated).toBe(true);
    expect(c.baseline).toBe(165);
  });

  it('준비 자세 확인: ready false인 프레임은 보정에 쓰지 않고, 타임아웃도 흐르지 않는다', () => {
    const c = new AdaptiveRepCounter(CFG);
    // 서 있는 자세(ready false)로 5초 가만히
    for (let t = 0; t < 5000; t += DT) c.update(t, 170, false);
    expect(c.calibrated).toBe(false);
    expect(c.phase).toBe('calibrating');
    // ready null(몸통이 안 보임)도 마찬가지
    for (let t = 5000; t < 6000; t += DT) c.update(t, 170, null);
    expect(c.calibrated).toBe(false);
    // 준비 자세(ready true) 1초 → 보정
    for (let t = 6000; t < 7000; t += DT) c.update(t, 166, true);
    expect(c.calibrated).toBe(true);
    expect(c.baseline).toBeCloseTo(166, 5);
  });

  it('준비 자세 확인: 보정 구간 중간에 ready false가 끼면 구간을 비운다', () => {
    const c = new AdaptiveRepCounter(CFG);
    let t = 0;
    for (; t < 400; t += DT) c.update(t, 168, true);
    c.update(t, 168, false);
    t += DT;
    for (const end = t + 400; t < end; t += DT) c.update(t, 168, true);
    expect(c.calibrated).toBe(false);
  });

  it('보정이 끝난 뒤에는 ready를 보지 않는다', () => {
    const c = new AdaptiveRepCounter(CFG);
    run(c, new Seq().hold(168, 1000).frames);
    let t = 1000;
    for (const [, v] of new Seq().rep(168, 100).frames) c.update((t += DT), v, false);
    expect(c.count).toBe(1);
  });

  it('보정 확정에는 표본 10개 이상이 필요하다(200ms 간격 5개로는 확정하지 않음)', () => {
    const c = new AdaptiveRepCounter(CFG);
    for (let t = 0; t <= 800; t += 200) c.update(t, 168);
    expect(c.calibrated).toBe(false);
    // 이어서 33ms 간격으로 들어오면 확정
    for (let t = 833; t < 1600; t += DT) c.update(t, 168);
    expect(c.calibrated).toBe(true);
  });

  it('보정 중 null이어도 phase는 calibrating(HUD 안내 유지)', () => {
    const c = new AdaptiveRepCounter(CFG);
    c.update(0, 168);
    c.update(33, null);
    expect(c.phase).toBe('calibrating');
    for (let t = 66; t < 3000; t += DT) c.update(t, null);
    expect(c.phase).toBe('calibrating');
  });
});
