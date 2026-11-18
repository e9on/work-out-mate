import { describe, expect, it } from 'vitest';
import { HoldTimer, type HoldConfig } from '../src/counter/holdTimer';

const CFG: HoldConfig = { startAfterMs: 300, graceMs: 500 };
const DT = 33;

type Frame = [number, boolean | null];

/** t부터 ms 동안 같은 값을 dt 간격으로 채운다. 시작 포함, 끝 제외. */
function seg(t0: number, ms: number, v: boolean | null, dt = DT): Frame[] {
  const out: Frame[] = [];
  for (let t = t0; t < t0 + ms; t += dt) out.push([t, v]);
  return out;
}

function lastT(frames: Frame[]): number {
  return frames[frames.length - 1]![0];
}

function run(frames: Frame[]): HoldTimer {
  const h = new HoldTimer(CFG);
  for (const [t, v] of frames) h.update(t, v);
  return h;
}

describe('HoldTimer', () => {
  it('10초 매달림: 놓은 뒤 ended, 약 10000ms', () => {
    const a = seg(0, 10000, true);
    const b = seg(lastT(a) + DT, 1000, false);
    const h = run([...a, ...b]);
    expect(h.state).toBe('ended');
    // t0=0, breakT=b[0] 시각
    expect(Math.abs(h.heldMs - b[0]![0])).toBeLessThanOrEqual(50);
    expect(Math.abs(h.heldMs - 10000)).toBeLessThanOrEqual(50);
  });

  it('잠깐 놓침: grace 안에 돌아오면 이어 센다', () => {
    const a = seg(0, 3000, true);
    const gap = seg(lastT(a) + DT, 2 * DT, null);
    const c = seg(lastT(gap) + DT, 3000, true);
    const d = seg(lastT(c) + DT, 100, false);
    const h = run([...a, ...gap, ...c, ...d]);
    // 놓은 첫 프레임 breakT까지 = 구성한 타임라인에서 계산
    const breakT = d[0]![0];
    expect(h.heldMs).toBe(breakT);
    expect(Math.abs(h.heldMs - 6000)).toBeLessThanOrEqual(150);
    // 잠깐 놓친 구간이 포함됐는지 (끊고 다시 센 값 3000대가 아님)
    expect(h.heldMs).toBeGreaterThan(5900);
  });

  it('진짜 놓음: graceMs 지나면 ended, 놓은 뒤 시간은 제외', () => {
    const a = seg(0, 3000, true);
    const b = seg(lastT(a) + DT, 600, false);
    const h = run([...a, ...b]);
    expect(h.state).toBe('ended');
    expect(h.heldMs).toBe(b[0]![0]);
    expect(Math.abs(h.heldMs - 3000)).toBeLessThanOrEqual(50);
  });

  it('불규칙 간격(33/250ms 섞임) 5초', () => {
    const frames: Frame[] = [];
    let t = 0;
    let i = 0;
    while (t < 5000) {
      frames.push([t, true]);
      t += t < 4700 && i % 5 === 4 ? 250 : DT;
      i++;
    }
    frames.push([t, false]); // 손을 놓은 첫 프레임 breakT
    const h = run(frames);
    expect(h.heldMs).toBe(t);
    expect(Math.abs(h.heldMs - 5000)).toBeLessThanOrEqual(50);
  });

  it('시작 전 깜빡임: startAfterMs 전에 끊기면 idle, 0', () => {
    const a = seg(0, 200, true);
    const b = seg(lastT(a) + DT, 100, false);
    const h = run([...a, ...b]);
    expect(h.state).toBe('idle');
    expect(h.heldMs).toBe(0);
  });

  it('실시간: holding 중 heldMs가 프레임마다 늘고, 시작 시각은 첫 true 프레임', () => {
    const h = new HoldTimer(CFG);
    h.update(1000, true);
    expect(h.state).toBe('idle');
    h.update(1200, true);
    expect(h.state).toBe('idle');
    h.update(1300, true);
    expect(h.state).toBe('holding');
    expect(h.heldMs).toBe(300);
    h.update(2000, true);
    expect(h.heldMs).toBe(1000);
  });

  it('grace 동안 heldMs는 놓은 시점 값에서 멈춘다', () => {
    const h = new HoldTimer(CFG);
    h.update(0, true);
    h.update(400, true);
    h.update(433, false);
    expect(h.heldMs).toBe(433);
    h.update(700, null);
    expect(h.heldMs).toBe(433);
    expect(h.state).toBe('holding');
    h.update(933, false); // 933-433 >= 500
    expect(h.state).toBe('ended');
    expect(h.heldMs).toBe(433);
  });

  it('ended 이후 update는 무시, reset은 idle로', () => {
    const h = run([...seg(0, 1000, true), ...seg(1000, 600, false)]);
    expect(h.state).toBe('ended');
    const v = h.heldMs;
    h.update(5000, true);
    h.update(6000, true);
    expect(h.state).toBe('ended');
    expect(h.heldMs).toBe(v);
    h.reset();
    expect(h.state).toBe('idle');
    expect(h.heldMs).toBe(0);
  });
});
